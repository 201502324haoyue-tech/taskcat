import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SERVER_BASE, getSyncBase, isSyncConfigured, setSyncBase, mergeTasks, mergedDiffers } from '@/services/sync'
import type { Task } from '@/types/task'

afterEach(() => vi.unstubAllGlobals())

describe('同步地址配置', () => {
  it('没有用户配置时使用可选构建默认值', () => {
    vi.stubGlobal('localStorage', { getItem: () => null })
    expect(getSyncBase()).toBe(DEFAULT_SERVER_BASE)
  })

  it('用户地址覆盖默认值且清空后保持停用', () => {
    const data = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => data.set(key, value),
    })
    setSyncBase(' https://sync.example.com/// ')
    expect(getSyncBase()).toBe('https://sync.example.com')
    setSyncBase('')
    expect(getSyncBase()).toBe('')
    expect(isSyncConfigured()).toBe(false)
  })
})

function makeTask(id: string, updatedAt: number, title = `任务${id}`): Task {
  return { id, title, quadrant: 'q1', createdAt: 1, updatedAt, dueAt: null, completedAt: null, subtasks: [] }
}

describe('mergeTasks / mergedDiffers（云端合并同步）', () => {
  it('mergeTasks：同 id 取 updatedAt 新者胜', () => {
    const local = [makeTask('a', 100), makeTask('b', 200)]
    const remote = [makeTask('a', 300), makeTask('c', 150)]
    const merged = mergeTasks(local, remote)
    const a = merged.find((t) => t.id === 'a')
    expect(a?.updatedAt).toBe(300)
    expect(merged.map((t) => t.id).sort()).toEqual(['a', 'b', 'c'])
  })

  it('mergedDiffers：同 id 更新（长度不变）应判为有差异', () => {
    const local = [makeTask('a', 100, '旧标题')]
    const merged = [makeTask('a', 200, '新标题')]
    expect(mergedDiffers(local, merged)).toBe(true)
  })

  it('mergedDiffers：完全相同（长度与 updatedAt 一致）应判为无差异', () => {
    const local = [makeTask('a', 100), makeTask('b', 200)]
    const merged = mergeTasks(local, [makeTask('a', 50)]) // 远端更旧 → 本地胜出，结果不变
    expect(mergedDiffers(local, merged)).toBe(false)
  })

  it('mergedDiffers：新增/删除任务（长度变化）应判为有差异', () => {
    const local = [makeTask('a', 100)]
    expect(mergedDiffers(local, [])).toBe(true)
    expect(mergedDiffers(local, [makeTask('a', 100), makeTask('b', 300)])).toBe(true)
  })
})
