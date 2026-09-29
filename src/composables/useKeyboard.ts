import { onMounted, onUnmounted } from 'vue'
import { useUiStore } from '@/stores/ui'
import { QUADRANT_BY_KEY } from '@/types/task'
import { isTauri, tauriGlobal } from '@/utils/tauri'

/**
 * 快捷键：
 * - Tauri 版：系统级快捷键由 Rust 端 tauri-plugin-global-shortcut 注册
 *   （Ctrl+Shift+Space，占用时回退），本组件监听其事件；
 *   窗口聚焦时页面内快捷键仍生效（两者幂等）。
 * - 浏览器原型：页面聚焦时 Ctrl+Shift+Space 生效。
 *   Esc 关闭弹窗 / 收起内联编辑。
 */
export function useKeyboard(): void {
  const unlisteners: Array<() => void> = []

  function onKey(e: KeyboardEvent): void {
    const ui = useUiStore()

    if (e.ctrlKey && e.shiftKey && e.code === 'Space') {
      e.preventDefault()
      ui.openQuickAdd()
      return
    }
    // Alt+。截图识别（浏览器原型；Tauri 下由 Rust 全局快捷键处理，避免重复触发）
    if (!isTauri() && e.altKey && e.code === 'Period') {
      e.preventDefault()
      ui.smartInputOpen = true
      ui.smartShotPending = true
      return
    }
    if (e.key === 'Escape') {
      if (ui.quickAddOpen) {
        ui.closeQuickAdd()
        return
      }
      if (ui.editingTaskId) {
        ui.editingTaskId = null
        return
      }
    }
    // 快速录入弹窗内的数字键 1-4 选择象限（Spec §5.3）
    // 焦点在文本输入框时不拦截，避免干扰标题/截止输入；象限锁定（加号进入）时忽略
    if (
      ui.quickAddOpen &&
      !ui.quickAddLocked &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey &&
      QUADRANT_BY_KEY[e.key]
    ) {
      const el = e.target as HTMLElement | null
      const tag = el?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      ui.quickAddQuadrant = QUADRANT_BY_KEY[e.key]
    }
  }

  onMounted(() => {
    window.addEventListener('keydown', onKey)
    if (isTauri()) {
      const g = tauriGlobal()!
      g.event
        .listen('quick-add-open', () => useUiStore().openQuickAdd())
        .then((un) => unlisteners.push(un))
        .catch(() => {})
    }
  })

  onUnmounted(() => {
    window.removeEventListener('keydown', onKey)
    for (const un of unlisteners) {
      try {
        un()
      } catch {
        // 忽略
      }
    }
  })
}
