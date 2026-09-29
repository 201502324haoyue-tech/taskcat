import type { Task } from '@/types/task'
import { isCapacitor, isTauri } from '@/utils/tauri'
import { getAuthHeaders, isLoggedIn } from './auth'

/**
 * 手机端 ↔ 云端双向同步（账号认证版）
 *
 * 两端共用同一套 API（/api/tasks），通过 JWT 认证隔离用户数据。
 * 地址由用户设置或构建环境提供；未配置时不连接任何默认云服务。
 */

const SYNC_URL_KEY = 'taskcat.sync-server-url'
/** 构建时的可选默认地址；VITE_* 会进入前端产物，不可存放密钥。 */
export const DEFAULT_SERVER_BASE = (import.meta.env.VITE_SYNC_SERVER_URL || '').trim().replace(/\/+$/, '')

/** 当前服务器地址：两端统一走云端 */
export function getSyncBase(): string {
  try {
    const v = localStorage.getItem(SYNC_URL_KEY)
    if (v !== null) return v.trim().replace(/\/+$/, '')
  } catch {
    // 忽略
  }
  return DEFAULT_SERVER_BASE
}

export function setSyncBase(url: string): void {
  try {
    localStorage.setItem(SYNC_URL_KEY, url.trim().replace(/\/+$/, ''))
  } catch {
    // 忽略
  }
}

export function isSyncConfigured(): boolean {
  return getSyncBase() !== ''
}

/** fetch 带超时（默认 8s） */
async function fetchTimeout(url: string, init: RequestInit = {}, ms = 8000): Promise<Response> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), ms)
  try {
    return await fetch(url, { ...init, signal: ctrl.signal })
  } finally {
    clearTimeout(timer)
  }
}

/** 从云端拉取全量任务（需认证；兼容旧服务器纯数组返回格式） */
export async function pullTasks(): Promise<{ tasks: Task[]; count: number }> {
  const base = getSyncBase()
  if (!base) throw new Error('未配置服务器地址')
  const r = await fetchTimeout(`${base}/api/tasks`, {
    method: 'GET',
    headers: { ...getAuthHeaders() },
  })
  if (!r.ok) throw new Error(`拉取失败（HTTP ${r.status}）`)
  const data = await r.json()
  // 旧服务器返回纯数组 []（v1），新服务器返回 { ok, tasks, count }（v2）
  if (Array.isArray(data)) return { tasks: data, count: data.length }
  return data as { tasks: Task[]; count: number }
}

/** 推送全量任务到云端（需认证） */
export async function pushTasks(tasks: Task[]): Promise<{ ok: boolean; count: number }> {
  const base = getSyncBase()
  if (!base) throw new Error('未配置服务器地址')
  const r = await fetchTimeout(`${base}/api/tasks`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify(tasks),
  })
  if (!r.ok) throw new Error(`推送失败（HTTP ${r.status}）`)
  return r.json()
}

/** 推送到云端（自动判断登录状态，未登录时静默） */
export async function pushAll(tasks: Task[]): Promise<void> {
  if (!isLoggedIn()) return
  await pushTasks(tasks).catch((e) => console.warn('[sync] 推送失败', e))
}

/** 从云端拉取（自动判断登录状态，未登录时返回空数组） */
export async function pullIfLoggedIn(): Promise<Task[]> {
  if (!isLoggedIn()) return []
  try {
    const r = await pullTasks()
    return r.tasks
  } catch {
    return []
  }
}

/** 按 id 合并本地与远端任务，updatedAt 新者胜 */
export function mergeTasks(local: Task[], remote: Task[]): Task[] {
  const map = new Map<string, Task>()
  for (const t of local) map.set(t.id, t)
  for (const t of remote) {
    const cur = map.get(t.id)
    if (!cur || (t.updatedAt ?? 0) >= (cur.updatedAt ?? 0)) map.set(t.id, t)
  }
  return [...map.values()].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
}

/**
 * 合并结果与本地是否有实质差异：id 集合不同，或任一任务的 updatedAt 不同。
 */
export function mergedDiffers(local: Task[], merged: Task[]): boolean {
  if (local.length !== merged.length) return true
  const lm = new Map(local.map((t) => [t.id, t.updatedAt ?? 0]))
  for (const t of merged) {
    if ((lm.get(t.id) ?? -1) !== (t.updatedAt ?? 0)) return true
  }
  return false
}

/** 测试服务器连接（带认证；无 token 时仅测连通性） */
export async function testConnection(): Promise<{ ok: boolean; message: string }> {
  try {
    const base = getSyncBase()
    if (!base) return { ok: false, message: '未配置服务器地址' }
    const r = await fetchTimeout(`${base}/api/tasks`, {
      method: 'GET',
      headers: { ...getAuthHeaders() },
    })
    if (!r.ok) return { ok: false, message: `连接失败（HTTP ${r.status}）` }
    const data = await r.json()
    const count = data.count ?? (Array.isArray(data) ? data.length : data.tasks?.length ?? 0)
    return { ok: true, message: `连接成功，云端 ${count} 条任务` }
  } catch (e) {
    return { ok: false, message: `连接失败：${e instanceof Error ? e.message : e}` }
  }
}

/** 旧名别名：testCloudConnection 等同 testConnection */
export const testCloudConnection = testConnection