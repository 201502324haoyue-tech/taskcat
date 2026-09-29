/**
 * 账号认证服务：手机号+密码注册/登录/Token 管理
 *
 * - Token 持久化到 localStorage
 * - 所有 API 请求通过 getAuthHeaders() 注入 Authorization header
 * - 服务器地址复用 sync.ts 中的 getSyncBase()
 */
import { getSyncBase } from './sync'

export interface AuthState {
  token: string | null
  phone: string | null
  userId: number | null
}

const AUTH_KEY = 'taskcat.auth'

let _cached: AuthState | null = null

/** 从 localStorage 读取持久化认证信息 */
export function getAuth(): AuthState {
  if (_cached) return _cached
  try {
    const raw = localStorage.getItem(AUTH_KEY)
    if (raw) {
      _cached = JSON.parse(raw) as AuthState
      if (_cached.token) return _cached
    }
  } catch {
    // 忽略
  }
  _cached = { token: null, phone: null, userId: null }
  return _cached
}

/** 持久化认证信息 */
export function setAuth(auth: AuthState): void {
  _cached = auth
  try {
    if (auth.token) {
      localStorage.setItem(AUTH_KEY, JSON.stringify(auth))
    } else {
      localStorage.removeItem(AUTH_KEY)
    }
  } catch {
    // 忽略
  }
}

/** 清除登录状态（退出登录） */
export function clearAuth(): void {
  _cached = null
  try {
    localStorage.removeItem(AUTH_KEY)
  } catch {
    // 忽略
  }
}

/** 是否已登录（token 存在且未过期） */
export function isLoggedIn(): boolean {
  return !!getAuth().token
}

/** 获取 Authorization header（无 token 时返回空对象） */
export function getAuthHeaders(): Record<string, string> {
  const auth = getAuth()
  if (!auth.token) return {}
  return { Authorization: `Bearer ${auth.token}` }
}

function authUrl(path: string): string {
  return `${getSyncBase()}/api/auth/${path}`
}

/** 注册，返回 token */
export async function register(phone: string, password: string): Promise<{ token: string; phone: string; userId: number }> {
  const res = await fetch(authUrl('register'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone, password }),
  })
  const data = await res.json()
  if (!data.ok) throw new Error(data.error || '注册失败')
  setAuth({ token: data.token, phone: data.phone, userId: data.userId })
  return data
}

/** 登录，返回 token */
export async function login(phone: string, password: string): Promise<{ token: string; phone: string; userId: number }> {
  const res = await fetch(authUrl('login'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone, password }),
  })
  const data = await res.json()
  if (!data.ok) throw new Error(data.error || '登录失败')
  setAuth({ token: data.token, phone: data.phone, userId: data.userId })
  return data
}

/** 验证当前 token 是否有效，返回用户信息 */
export async function verifyToken(): Promise<{ phone: string; userId: number } | null> {
  const auth = getAuth()
  if (!auth.token) return null
  try {
    const res = await fetch(authUrl('me'), {
      headers: { ...getAuthHeaders() },
    })
    const data = await res.json()
    if (data.ok) return { phone: data.phone, userId: data.userId }
  } catch {
    // 忽略
  }
  return null
}

/** 退出登录 */
export function logout(): void {
  clearAuth()
}

/** 修改密码（需登录状态）；成功后用服务端返还的新 token 替换旧 token */
export async function changePassword(oldPassword: string, newPassword: string): Promise<void> {
  const res = await fetch(authUrl('change-password'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify({ oldPassword, newPassword }),
  })
  const data = await res.json()
  if (!data.ok) throw new Error(data.error || '修改密码失败')
  if (data.token) {
    const cur = getAuth()
    setAuth({ token: data.token, phone: cur.phone, userId: cur.userId })
  }
}

/** 注销账号（删除账号及所有云端数据，需登录状态） */
export async function deactivateAccount(): Promise<void> {
  const res = await fetch(authUrl('deactivate'), {
    method: 'POST',
    headers: { ...getAuthHeaders() },
  })
  const data = await res.json()
  if (!data.ok) throw new Error(data.error || '注销失败')
}