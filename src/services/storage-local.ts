import type { Task } from '@/types/task'
import type { StorageAdapter } from './storage'
import { isQuadrant } from '@/types/task'

/**
 * 浏览器原型用的 localStorage 适配器。
 * 结构上等价于 SQLite 的 tasks + subtasks 两张表（subtasks 以 JSON 内嵌）。
 * 每次写入前做结构校验，避免脏数据进入状态。
 */
export const LOCAL_STORAGE_KEY = 'eisenhower-pet.tasks.v1'

export class LocalStorageAdapter implements StorageAdapter {
  readonly name = 'localStorage'

  private read(): Task[] {
    const raw = localStorage.getItem(LOCAL_STORAGE_KEY)
    if (!raw) return []
    try {
      const parsed: unknown = JSON.parse(raw)
      if (!Array.isArray(parsed)) return []
      return parsed.filter(isValidTask)
    } catch {
      return []
    }
  }

  private write(tasks: Task[]): void {
    localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(tasks))
  }

  async loadTasks(): Promise<Task[]> {
    return this.read()
  }

  async insertTask(task: Task): Promise<void> {
    const list = this.read()
    list.push(task)
    this.write(list)
  }

  async updateTask(task: Task): Promise<void> {
    const list = this.read()
    const i = list.findIndex((t) => t.id === task.id)
    if (i >= 0) list[i] = task
    this.write(list)
  }

  async removeTask(id: string): Promise<void> {
    this.write(this.read().filter((t) => t.id !== id))
  }

  async replaceAll(tasks: Task[]): Promise<void> {
    this.write(tasks)
  }
}

function isValidTask(v: unknown): v is Task {
  if (typeof v !== 'object' || v === null) return false
  const t = v as Record<string, unknown>
  return (
    typeof t.id === 'string' &&
    typeof t.title === 'string' &&
    isQuadrant(t.quadrant) &&
    (t.dueAt === null || typeof t.dueAt === 'number') &&
    typeof t.createdAt === 'number' &&
    typeof t.updatedAt === 'number' &&
    (t.completedAt === null || typeof t.completedAt === 'number') &&
    Array.isArray(t.subtasks)
  )
}
