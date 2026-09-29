import type { Task } from '@/types/task'
import type { StorageAdapter } from './storage'
import { isQuadrant } from '@/types/task'
import { tauriGlobal } from '@/utils/tauri'
import { invoke } from './ipc'

/**
 * Tauri 版存储：tauri-plugin-sql（SQLite，%APPDATA%/eisenhower-pet/tasks.db）。
 * 通过 withGlobalTauri 暴露的 window.__TAURI__.core.invoke 直接调用插件命令，
 * 不依赖 @tauri-apps/* npm 包。
 *
 * 表结构与 Spec §4 一致：tasks + subtasks（1:N，外键级联删除）。
 */

interface TaskRow {
  id: string
  title: string
  quadrant: string
  due_at: number | null
  created_at: number
  updated_at: number
  completed_at: number | null
}

interface SubtaskRow {
  id: string
  task_id: string
  title: string
  done: number
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    quadrant TEXT NOT NULL CHECK (quadrant IN ('q1','q2','q3','q4')),
    due_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    completed_at INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS subtasks (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    done INTEGER NOT NULL DEFAULT 0
  )`,
]

export class TauriSqliteAdapter implements StorageAdapter {
  readonly name = 'tauri-sqlite'
  private db: string | null = null

  private async ensureDb(): Promise<string> {
    if (this.db) return this.db
    const g = tauriGlobal()
    if (!g?.path) throw new Error('不在 Tauri 运行时中')
    const dir = await g.path.appDataDir()
    // appDataDir() 不带结尾分隔符，需按平台补上
    const sep = dir.endsWith('/') || dir.endsWith('\\') ? '' : dir.includes('\\') ? '\\' : '/'
    const dbPath = `${dir}${sep}tasks.db`
    await invoke('plugin:sql|load', { db: `sqlite:${dbPath}` })
    for (const stmt of SCHEMA) {
      await invoke('plugin:sql|execute', { db: `sqlite:${dbPath}`, query: stmt, values: [] })
    }
    this.db = `sqlite:${dbPath}`
    return this.db
  }

  private async select<T>(query: string, values: unknown[] = []): Promise<T[]> {
    const db = await this.ensureDb()
    return (await invoke('plugin:sql|select', { db, query, values })) as T[]
  }

  private async execute(query: string, values: unknown[] = []): Promise<void> {
    const db = await this.ensureDb()
    await invoke('plugin:sql|execute', { db, query, values })
  }

  async loadTasks(): Promise<Task[]> {
    const rows = await this.select<TaskRow>(
      'SELECT id, title, quadrant, due_at, created_at, updated_at, completed_at FROM tasks',
    )
    const subs = await this.select<SubtaskRow>(
      'SELECT id, task_id, title, done FROM subtasks',
    )
    const byTask = new Map<string, Task['subtasks']>()
    for (const s of subs) {
      const list = byTask.get(s.task_id) ?? []
      list.push({ id: s.id, title: s.title, done: s.done === 1 })
      byTask.set(s.task_id, list)
    }
    return rows
      .filter((r) => isQuadrant(r.quadrant))
      .map((r) => ({
        id: r.id,
        title: r.title,
        quadrant: r.quadrant as Task['quadrant'],
        dueAt: r.due_at,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        completedAt: r.completed_at,
        subtasks: byTask.get(r.id) ?? [],
      }))
  }

  async insertTask(task: Task): Promise<void> {
    await this.execute(
      'INSERT INTO tasks (id, title, quadrant, due_at, created_at, updated_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [task.id, task.title, task.quadrant, task.dueAt, task.createdAt, task.updatedAt, task.completedAt],
    )
    await this.insertSubtasks(task)
  }

  async updateTask(task: Task): Promise<void> {
    await this.execute(
      'UPDATE tasks SET title = ?, quadrant = ?, due_at = ?, updated_at = ?, completed_at = ? WHERE id = ?',
      [task.title, task.quadrant, task.dueAt, task.updatedAt, task.completedAt, task.id],
    )
    // 子任务整组替换（级联 updatedAt 由前端维护，Spec §9.1）
    await this.execute('DELETE FROM subtasks WHERE task_id = ?', [task.id])
    await this.insertSubtasks(task)
  }

  async removeTask(id: string): Promise<void> {
    await this.execute('DELETE FROM tasks WHERE id = ?', [id]) // subtasks 级联删除
  }

  async replaceAll(tasks: Task[]): Promise<void> {
    const db = await this.ensureDb()
    await invoke('plugin:sql|execute', { db, query: 'BEGIN', values: [] })
    try {
      await invoke('plugin:sql|execute', { db, query: 'DELETE FROM subtasks', values: [] })
      await invoke('plugin:sql|execute', { db, query: 'DELETE FROM tasks', values: [] })
      for (const task of tasks) {
        await invoke('plugin:sql|execute', {
          db,
          query:
            'INSERT INTO tasks (id, title, quadrant, due_at, created_at, updated_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          values: [task.id, task.title, task.quadrant, task.dueAt, task.createdAt, task.updatedAt, task.completedAt],
        })
        for (const s of task.subtasks) {
          await invoke('plugin:sql|execute', {
            db,
            query: 'INSERT INTO subtasks (id, task_id, title, done) VALUES (?, ?, ?, ?)',
            values: [s.id, task.id, s.title, s.done ? 1 : 0],
          })
        }
      }
      await invoke('plugin:sql|execute', { db, query: 'COMMIT', values: [] })
    } catch (e) {
      await invoke('plugin:sql|execute', { db, query: 'ROLLBACK', values: [] })
      throw e
    }
  }

  private async insertSubtasks(task: Task): Promise<void> {
    for (const s of task.subtasks) {
      await this.execute('INSERT INTO subtasks (id, task_id, title, done) VALUES (?, ?, ?, ?)', [
        s.id,
        task.id,
        s.title,
        s.done ? 1 : 0,
      ])
    }
  }
}
