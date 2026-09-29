import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LocalStorageAdapter, LOCAL_STORAGE_KEY } from '@/services/storage-local'
import type { Task } from '@/types/task'

/** 最小 localStorage 桩（node 测试环境无 localStorage） */
function makeLocalStorage(): Storage {
  let m = new Map<string, string>()
  return {
    get length() {
      return m.size
    },
    clear: () => {
      m.clear()
    },
    getItem: (k) => m.get(String(k)) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(String(k)),
    setItem: (k, v) => void m.set(String(k), String(v)),
  } as Storage
}

function task(id: string, partial: Partial<Task> = {}): Task {
  const now = Date.now()
  return {
    id,
    title: `任务 ${id}`,
    quadrant: 'q1',
    dueAt: null,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    subtasks: [],
    ...partial,
  }
}

describe('LocalStorageAdapter — 浏览器原型存储', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', makeLocalStorage())
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('空存储 loadTasks 返回 []', async () => {
    const a = new LocalStorageAdapter()
    expect(await a.loadTasks()).toEqual([])
  })

  it('insertTask 后 loadTasks 可读回', async () => {
    const a = new LocalStorageAdapter()
    const t = task('t1', { title: '写报告', quadrant: 'q2', subtasks: [{ id: 's1', title: '列大纲', done: true }] })
    await a.insertTask(t)
    const list = await a.loadTasks()
    expect(list).toHaveLength(1)
    expect(list[0]).toEqual(t)
  })

  it('updateTask 覆盖同 id 任务，其他任务不受影响', async () => {
    const a = new LocalStorageAdapter()
    await a.insertTask(task('t1'))
    await a.insertTask(task('t2', { quadrant: 'q4' }))
    await a.updateTask(task('t1', { title: '已改名', completedAt: 12345 }))
    const list = await a.loadTasks()
    expect(list).toHaveLength(2)
    expect(list.find((t) => t.id === 't1')).toMatchObject({ title: '已改名', completedAt: 12345 })
    expect(list.find((t) => t.id === 't2')?.quadrant).toBe('q4')
  })

  it('removeTask 只删除指定 id', async () => {
    const a = new LocalStorageAdapter()
    await a.insertTask(task('t1'))
    await a.insertTask(task('t2'))
    await a.removeTask('t1')
    const list = await a.loadTasks()
    expect(list.map((t) => t.id)).toEqual(['t2'])
  })

  it('replaceAll 整表覆盖', async () => {
    const a = new LocalStorageAdapter()
    await a.insertTask(task('t1'))
    await a.replaceAll([task('t2'), task('t3')])
    const list = await a.loadTasks()
    expect(list.map((t) => t.id)).toEqual(['t2', 't3'])
  })

  it('loadTasks 过滤结构非法的脏数据', async () => {
    const a = new LocalStorageAdapter()
    localStorage.setItem(
      LOCAL_STORAGE_KEY,
      JSON.stringify([
        task('ok'),
        { id: 42, title: '坏数据：id 非字符串' },
        { id: 'bad2', title: '坏数据：象限非法', quadrant: 'q9', createdAt: 1, updatedAt: 1, completedAt: null, subtasks: [] },
        { id: 'bad3', title: '坏数据：subtasks 缺失', quadrant: 'q1', createdAt: 1, updatedAt: 1, completedAt: null },
      ]),
    )
    const list = await a.loadTasks()
    expect(list.map((t) => t.id)).toEqual(['ok'])
  })

  it('损坏的 JSON 视为空存储（返回 [] 不抛错）', async () => {
    localStorage.setItem(LOCAL_STORAGE_KEY, '{oops not json')
    const a = new LocalStorageAdapter()
    expect(await a.loadTasks()).toEqual([])
  })

  it('非数组顶层值视为空存储', async () => {
    localStorage.setItem(LOCAL_STORAGE_KEY, '{"tasks":[]}')
    const a = new LocalStorageAdapter()
    expect(await a.loadTasks()).toEqual([])
  })
})
