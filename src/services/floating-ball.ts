/**
 * 系统级悬浮球前端封装（Android Capacitor 插件桥接）。
 * 非手机端 / 无插件时静默降级。
 */

const plugin =
  typeof window !== 'undefined'
    ? (window as unknown as { Capacitor?: { Plugins?: Record<string, { show?: () => Promise<unknown>; hide?: () => Promise<unknown>; addListener?: (event: string, cb: (data: unknown) => void) => Promise<{ remove: () => void }> }> } })?.Capacitor?.Plugins?.FloatingBall
    : undefined

export interface FloatingBallPlugin {
  show(): Promise<void>
  hide(): Promise<void>
  isShowing(): Promise<{ showing: boolean }>
  addListener(event: 'click', cb: () => void): Promise<{ remove: () => void }>
}

function getPlugin(): FloatingBallPlugin | null {
  if (!plugin) return null
  // Capacitor 插件方法返回 Promise，直接 cast
  return plugin as unknown as FloatingBallPlugin
}

/** 显示悬浮球（需 Android SYSTEM_ALERT_WINDOW 权限） */
export async function showFloatingBall(): Promise<void> {
  const p = getPlugin()
  if (!p) return
  try {
    await p.show()
  } catch {
    // 权限未授予，静默（用户可后续手动授权）
  }
}

/** 隐藏悬浮球 */
export async function hideFloatingBall(): Promise<void> {
  const p = getPlugin()
  if (!p) return
  try {
    await p.hide()
  } catch {
    // 忽略
  }
}

/** 监听悬浮球点击事件 */
export function onFloatingBallClick(cb: () => void): () => void {
  const p = getPlugin()
  if (!p) return () => {}
  let removed = false
  p.addListener('click', cb).then((listener) => {
    if (removed) listener.remove()
  })
  return () => {
    removed = true
  }
}

/** 检查悬浮球当前是否显示 */
export async function isFloatingBallShowing(): Promise<boolean> {
  const p = getPlugin()
  if (!p) return false
  try {
    const r = await p.isShowing()
    return r.showing
  } catch {
    return false
  }
}

/** 悬浮球功能是否可用（仅在 Capacitor Android 下） */
export const floatingBallAvailable = !!plugin