import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useTasksStore } from '@/stores/tasks'
import { LOCAL_STORAGE_KEY } from '@/services/storage-local'
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

/** 等待写队列（promise 链）全部落盘 */
async function flushWrites(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0))
  await new Promise((r) => setTimeout(r, 0))
}

function saved(): Task[] {
  const raw = localStorage.getItem(LOCAL_STORAGE_KEY)
  return raw ? (JSON.parse(raw) as Task[]) : []
}

describe('tasks store — 增量写 + 串行写队列', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.stubGlobal('localStorage', makeLocalStorage())
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('addTask 增量持久化到 localStorage', async () => {
    const store = useTasksStore()
    await store.init()
    store.addTask({ title: '买牛奶', quadrant: 'q1', dueAt: null })
    await flushWrites()
    const list = saved()
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ title: '买牛奶', quadrant: 'q1', completedAt: null, subtasks: [] })
  })

  it('快速连续操作最终一致：增改删交错不丢数据（串行队列防竞态）', async () => {
    const store = useTasksStore()
    await store.init()
    const a = store.addTask({ title: 'A', quadrant: 'q1', dueAt: null })
    const b = store.addTask({ title: 'B', quadrant: 'q2', dueAt: null })
    store.patchTask(a.id, { quadrant: 'q3' })
    store.removeTask(b.id)
    await flushWrites()
    const list = saved()
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ id: a.id, quadrant: 'q3' })
  })

  it('toggleCompleted 与 toggleSubtask 增量写入', async () => {
    const store = useTasksStore()
    await store.init()
    const t = store.addTask({ title: '写方案', quadrant: 'q2', dueAt: null })
    store.addSubtask(t.id, '列大纲')
    await flushWrites()
    const withSub = saved()[0]
    expect(withSub.subtasks).toHaveLength(1)
    store.toggleCompleted(t.id)
    store.toggleSubtask(t.id, withSub.subtasks[0].id)
    await flushWrites()
    const done = saved()[0]
    expect(done.completedAt).not.toBeNull()
    expect(done.subtasks[0].done).toBe(true)
  })

  it('replaceAll 整表替换（演示数据/清空）', async () => {
    const store = useTasksStore()
    await store.init()
    store.addTask({ title: '旧任务', quadrant: 'q1', dueAt: null })
    await flushWrites()
    store.replaceAll([task('x1'), task('x2', { quadrant: 'q4' })])
    await flushWrites()
    const list = saved()
    expect(list.map((t) => t.id)).toEqual(['x1', 'x2'])
  })

  it('init 读取已有数据', async () => {
    const store = useTasksStore()
    store.addTask({ title: '预热', quadrant: 'q1', dueAt: null })
    await flushWrites()
    const fresh = useTasksStore()
    await fresh.init()
    expect(fresh.tasks).toHaveLength(1)
  })
})
