import type { Task } from '@/types/task'
import { isTauri } from '@/utils/tauri'
import { LocalStorageAdapter } from './storage-local'
import { TauriSqliteAdapter } from './storage-tauri'

/**
 * 存储抽象层。
 *
 * - 浏览器原型：localStorage（storage-local.ts）
 * - Tauri 桌面：SQLite（tauri-plugin-sql，%APPDATA%/eisenhower-pet/tasks.db，Spec §4/§7）
 *
 * 两个实现共用 StorageAdapter 接口，stores 无需感知后端。
 */
export interface StorageAdapter {
  readonly name: string
  loadTasks(): Promise<Task[]>
  insertTask(task: Task): Promise<void>
  updateTask(task: Task): Promise<void>
  removeTask(id: string): Promise<void>
  /** 整表覆盖写入 */
  replaceAll(tasks: Task[]): Promise<void>
}

let cached: StorageAdapter | null = null

export async function getStorageAdapter(): Promise<StorageAdapter> {
  if (cached) return cached
  if (isTauri()) {
    cached = new TauriSqliteAdapter()
  } else {
    cached = new LocalStorageAdapter()
  }
  return cached
}
