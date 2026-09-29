import type { Ref } from 'vue'
import { useUiStore } from '@/stores/ui'
import { isTauri, tauriGlobal } from '@/utils/tauri'

/** 交互控件不触发窗口拖动 */
const INTERACTIVE_SELECTOR =
  'button, input, select, textarea, a, [draggable="true"], canvas, [data-no-drag], .task-card'

/**
 * 面板拖动：
 * - Tauri：整个面板（除交互控件外）按住拖动真实窗口（官方 startDragging API）。
 * - 浏览器原型：按住移动浮动面板（模拟窗口拖动）。
 */
export function useDraggablePanel(panelEl: Ref<HTMLElement | null>): (e: MouseEvent) => void {
  const ui = useUiStore()

  return function onPanelMouseDown(e: MouseEvent): void {
    if (e.button !== 0) return
    const target = e.target as HTMLElement
    if (target.closest(INTERACTIVE_SELECTOR)) return

    // Tauri：真实窗口拖动
    if (isTauri()) {
      e.preventDefault()
      void tauriGlobal()
        ?.window.getCurrentWindow()
        .startDragging()
        .catch(() => {})
      return
    }

    // 浏览器原型：移动浮动面板
    const startX = e.clientX
    const startY = e.clientY
    const origX = ui.panelPos.x
    const origY = ui.panelPos.y

    function onMove(ev: MouseEvent): void {
      const panel = panelEl.value
      const w = panel?.offsetWidth ?? 212
      const h = panel?.offsetHeight ?? 148
      const x = Math.min(Math.max(origX + ev.clientX - startX, 8 - w + 40), window.innerWidth - 40)
      const y = Math.min(Math.max(origY + ev.clientY - startY, 8), window.innerHeight - 24)
      ui.setPanelPos(x, y)
    }

    function onUp(): void {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }
}
