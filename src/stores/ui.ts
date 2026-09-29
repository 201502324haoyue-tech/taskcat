import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { Quadrant } from '@/types/task'
import { isTauri, tauriGlobal } from '@/utils/tauri'

const PANEL_POS_KEY = 'eisenhower-pet.panel-pos.v1'
const EXPANDED_SIZE_KEY = 'eisenhower-pet.expanded-size'
const OPACITY_KEY = 'eisenhower-pet.opacity'
const DUE_PRECISION_KEY = 'eisenhower-pet.due-precision'
const TASK_FONT_KEY = 'eisenhower-pet.task-font'

/** 任务字体大小（px）：可调范围 1-12，默认 11 */
export const TASK_FONT_MIN = 1
export const TASK_FONT_MAX = 12
export const TASK_FONT_DEFAULT = 11

function clampFontSize(v: number): number {
  if (!Number.isFinite(v)) return TASK_FONT_DEFAULT
  return Math.min(TASK_FONT_MAX, Math.max(TASK_FONT_MIN, Math.round(v)))
}

function loadTaskFontSize(): number {
  try {
    const raw = localStorage.getItem(TASK_FONT_KEY)
    if (raw === null) return TASK_FONT_DEFAULT
    return clampFontSize(Number(raw))
  } catch {
    return TASK_FONT_DEFAULT
  }
}

/** 截止时间精确度：false = 只到日（默认）；true = 精确到分 */
function loadDuePrecision(): boolean {
  try {
    return localStorage.getItem(DUE_PRECISION_KEY) === '1'
  } catch {
    return false
  }
}

/** 面板透明度默认值（作用于除桌宠外的整个 UI 层）与可调范围 */
export const DEFAULT_OPACITY = 0.85
export const OPACITY_MIN = 0.15
export const OPACITY_MAX = 0.95

function clampOpacity(v: number): number {
  return Math.min(OPACITY_MAX, Math.max(OPACITY_MIN, v))
}

function loadOpacity(): number {
  try {
    const v = parseFloat(localStorage.getItem(OPACITY_KEY) ?? '')
    if (Number.isFinite(v)) return clampOpacity(v)
  } catch {
    // 忽略
  }
  return DEFAULT_OPACITY
}

/** 浏览器原型中模拟「窗口位置」；Tauri 版由 Rust 管理真实窗口坐标 + window-state.json（Spec §7） */
function loadPanelPos(): { x: number; y: number } | null {
  try {
    const raw = localStorage.getItem(PANEL_POS_KEY)
    if (!raw) return null
    const p = JSON.parse(raw) as { x: number; y: number }
    if (typeof p.x === 'number' && typeof p.y === 'number') return p
    return null
  } catch {
    return null
  }
}

/**
 * 面板默认尺寸（只保留展开态——用户要求删除收起/展开功能）。
 * 展开态高度 = 500 × 3/4 = 375（用户要求整体降 1/4），可拖边缩放。
 */
export const PANEL_SIZES = {
  expanded: { w: 540, h: 375 },
} as const

/** 用户手动拖拽调整过的窗口尺寸（Tauri） */
function loadExpandedSize(): { w: number; h: number } | null {
  try {
    const raw = localStorage.getItem(EXPANDED_SIZE_KEY)
    if (!raw) return null
    const p = JSON.parse(raw) as { w: number; h: number }
    if (typeof p.w === 'number' && typeof p.h === 'number' && p.w > 300 && p.h > 240) return p
    return null
  } catch {
    return null
  }
}

function saveExpandedSize(w: number, h: number): void {
  try {
    localStorage.setItem(EXPANDED_SIZE_KEY, JSON.stringify({ w, h }))
  } catch {
    // 忽略
  }
}

export const useUiStore = defineStore('ui', () => {
  /** 浏览器原型模拟「关闭到托盘」；Tauri 下为真实窗口 hide（托盘图标恢复） */
  const minimized = ref(false)
  const quickAddOpen = ref(false)
  const quickAddQuadrant = ref<Quadrant>('q1')
  /** 从象限加号打开时为 true：弹窗不显示象限选择（象限已确定） */
  const quickAddLocked = ref(false)
  /** 语音输入等预填的标题 */
  const quickAddTitle = ref('')
  /** 智能录入中心（截图/飞书/语音/手动） */
  const smartInputOpen = ref(false)
  /** 语音输入弹窗（手机端 Web Speech API 语音→编辑→同步） */
  const voiceInputOpen = ref(false)
  /** Alt+。 截图快捷键触发标记：为 true 时智能录入面板自动开始截图 */
  const smartShotPending = ref(false)
  /** 设置弹窗（⚙️）开关 */
  const settingsOpen = ref(false)
  /** 首次使用问卷弹窗（用户画像生成）开关 */
  const onboardingOpen = ref(false)
  /** 用户画像查看/编辑弹窗开关 */
  const profileModalOpen = ref(false)
  /** 截图全屏识别期间为 true：拖边缩放记忆暂停，避免把全屏尺寸存为用户尺寸 */
  const suppressResizeSave = ref(false)
  const searchQuery = ref('')
  const editingTaskId = ref<string | null>(null)
  /** 手动拖拽状态（Pointer Events 实现：透明窗口下 HTML5 DnD 不可用） */
  const drag = ref<{ active: boolean; taskId: string | null; from: Quadrant | null; over: Quadrant | null }>({
    active: false,
    taskId: null,
    from: null,
    over: null,
  })
  const panelPos = ref<{ x: number; y: number }>(loadPanelPos() ?? { x: 0, y: 0 })
  /** 面板透明度（0.15–0.95），桌宠不透明不受影响 */
  const opacity = ref<number>(loadOpacity())
  /** 截止时间精确度：默认只到日，可切换为到分 */
  const duePrecisionMinute = ref<boolean>(loadDuePrecision())

  function setDuePrecisionMinute(v: boolean): void {
    duePrecisionMinute.value = v
    try {
      localStorage.setItem(DUE_PRECISION_KEY, v ? '1' : '0')
    } catch {
      // 忽略
    }
  }

  /** 任务字体大小（px，1-12） */
  const taskFontSize = ref<number>(loadTaskFontSize())

  function applyTaskFontSize(): void {
    document.documentElement.style.setProperty('--task-font-size', `${taskFontSize.value}px`)
  }

  function setTaskFontSize(v: number): void {
    taskFontSize.value = clampFontSize(v)
    applyTaskFontSize()
    try {
      localStorage.setItem(TASK_FONT_KEY, String(taskFontSize.value))
    } catch {
      // 忽略
    }
  }

  /** 把透明度应用到全局 CSS 变量 */
  function applyOpacity(): void {
    document.documentElement.style.setProperty('--panel-opacity', String(clampOpacity(opacity.value)))
  }

  function setOpacity(v: number): void {
    opacity.value = clampOpacity(v)
    applyOpacity()
    try {
      localStorage.setItem(OPACITY_KEY, String(opacity.value))
    } catch {
      // 忽略
    }
  }

  function resetOpacity(): void {
    setOpacity(DEFAULT_OPACITY)
  }

  /** 启动/应用窗口尺寸（Tauri：展开尺寸 + 可缩放 + 重新吸附右上角；浏览器：吸附视口） */
  function syncWindowSize(): void {
    if (isTauri()) {
      const g = tauriGlobal()
      if (!g) return
      const win = g.window.getCurrentWindow()
      void win.setResizable(true).catch(() => {})
      const s = loadExpandedSize() ?? PANEL_SIZES.expanded
      void win.setSize(new g.dpi.LogicalSize(s.w, s.h)).catch(() => {})
      // 尺寸变化后重新吸附右上角，避免位置对旧尺寸失效
      void g.event.emit('reset-window-pos', null).catch(() => {})
    } else {
      snapIntoView()
    }
  }

  /** 监听窗口 resize（用户拖边缩放），防抖记忆尺寸 */
  function startResizeTracking(): void {
    if (!isTauri()) return
    let timer = 0
    window.addEventListener('resize', () => {
      if (suppressResizeSave.value) return
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        saveExpandedSize(window.innerWidth, window.innerHeight)
      }, 400)
    })
  }

  /** 右上角复位（Spec §3.1：离边缘 16px）；Tauri 下通知 Rust 重新定位窗口 */
  function resetPanelPos(): void {
    if (isTauri()) {
      void tauriGlobal()?.event.emit('reset-window-pos', null).catch(() => {})
      return
    }
    const size = PANEL_SIZES.expanded
    panelPos.value = { x: Math.max(8, window.innerWidth - size.w - 16), y: 16 }
    persistPanelPos()
  }

  function setPanelPos(x: number, y: number): void {
    panelPos.value = { x, y }
    persistPanelPos()
  }

  /** 多屏拔掉回弹：保证面板完整落在视口内（Spec §8）；Tauri 下由 Rust 侧处理 */
  function snapIntoView(): void {
    if (isTauri()) return
    const size = PANEL_SIZES.expanded
    const { x, y } = panelPos.value
    const nx = Math.min(Math.max(x, 8), Math.max(8, window.innerWidth - size.w - 8))
    const ny = Math.min(Math.max(y, 8), Math.max(8, window.innerHeight - size.h - 8))
    if (nx !== x || ny !== y) {
      panelPos.value = { x: nx, y: ny }
      persistPanelPos()
    }
  }

  function persistPanelPos(): void {
    try {
      localStorage.setItem(PANEL_POS_KEY, JSON.stringify(panelPos.value))
    } catch {
      // 忽略
    }
  }

  function openQuickAdd(quadrant: Quadrant = 'q1', locked = false, title = ''): void {
    quickAddQuadrant.value = quadrant
    quickAddLocked.value = locked
    quickAddTitle.value = title
    quickAddOpen.value = true
  }

  function closeQuickAdd(): void {
    quickAddOpen.value = false
    quickAddLocked.value = false
  }

  function openSmartInput(): void {
    smartInputOpen.value = true
  }

  function closeSmartInput(): void {
    smartInputOpen.value = false
  }

  function openVoiceInput(): void {
    voiceInputOpen.value = true
  }

  function closeVoiceInput(): void {
    voiceInputOpen.value = false
  }

  function minimize(): void {
    if (isTauri()) {
      // Tauri：隐藏窗口即最小化到托盘（托盘菜单恢复），
      // 不置前端 minimized 标志——恢复后面板依然渲染
      void tauriGlobal()?.window.getCurrentWindow().hide().catch(() => {})
      return
    }
    minimized.value = true
    editingTaskId.value = null
  }

  function restore(): void {
    minimized.value = false
    if (isTauri()) {
      const g = tauriGlobal()
      if (g) {
        void g.window.getCurrentWindow().show().then(() => g.window.getCurrentWindow().setFocus()).catch(() => {})
      }
      return
    }
    snapIntoView()
  }

  return {
    minimized,
    quickAddOpen,
    quickAddQuadrant,
    quickAddLocked,
    quickAddTitle,
    smartInputOpen,
    voiceInputOpen,
    settingsOpen,
    onboardingOpen,
    profileModalOpen,
    smartShotPending,
    suppressResizeSave,
    searchQuery,
    editingTaskId,
    drag,
    panelPos,
    opacity,
    duePrecisionMinute,
    setDuePrecisionMinute,
    taskFontSize,
    setTaskFontSize,
    applyTaskFontSize,
    applyOpacity,
    setOpacity,
    resetOpacity,
    syncWindowSize,
    startResizeTracking,
    resetPanelPos,
    setPanelPos,
    snapIntoView,
    openQuickAdd,
    closeQuickAdd,
    openSmartInput,
    closeSmartInput,
    openVoiceInput,
    closeVoiceInput,
    minimize,
    restore,
  }
})
