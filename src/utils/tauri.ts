/** Tauri 运行时检测：浏览器原型 ↔ 桌面 exe 共用同一套前端代码 */

export interface TauriGlobals {
  core: {
    invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>
  }
  event: {
    listen: (event: string, handler: (e: { payload: unknown }) => void) => Promise<() => void>
    emit: (event: string, payload?: unknown) => Promise<void>
  }
  window: {
    getCurrentWindow: () => {
      setSize: (size: unknown) => Promise<void>
      setPosition: (position: unknown) => Promise<void>
      hide: () => Promise<void>
      show: () => Promise<void>
      setFocus: () => Promise<void>
      startDragging: () => Promise<void>
      setResizable: (resizable: boolean) => Promise<void>
    }
  }
  dpi: {
    LogicalSize: new (width: number, height: number) => unknown
    LogicalPosition: new (x: number, y: number) => unknown
  }
  path?: {
    appDataDir: () => Promise<string>
  }
  notification?: {
    isPermissionGranted: () => Promise<boolean>
    requestPermission: () => Promise<string>
    sendNotification: (options: { title: string; body?: string }) => void
  }
}

export function tauriGlobal(): TauriGlobals | null {
  if (typeof window === 'undefined') return null
  const g = (window as unknown as { __TAURI__?: TauriGlobals }).__TAURI__
  return g ?? null
}

export function isTauri(): boolean {
  return tauriGlobal() !== null
}

/** Capacitor（手机 APK）运行时检测：window.Capacitor 由原生壳注入 */
export function isCapacitor(): boolean {
  if (typeof window === 'undefined') return false
  const g = (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor
  return !!g && !!g.isNativePlatform && g.isNativePlatform()
}
