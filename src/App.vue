<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useTasksStore } from '@/stores/tasks'
import { usePetStore } from '@/stores/pet'
import { useUiStore } from '@/stores/ui'
import { useSettingsStore } from '@/stores/settings'
import { useProfileStore } from '@/stores/profile'
import { useLarkStore } from '@/stores/lark'
import { useToastsStore } from '@/stores/toasts'
import { useKeyboard } from '@/composables/useKeyboard'
import { useIdle } from '@/composables/useIdle'
import { useDraggablePanel } from '@/composables/useDraggablePanel'
import { isTauri, isCapacitor, tauriGlobal } from '@/utils/tauri'
import ExpandedPanel from '@/components/ExpandedPanel.vue'
import QuickAddModal from '@/components/QuickAddModal.vue'
import SmartInput from '@/components/SmartInput.vue'
import OnboardingModal from '@/components/OnboardingModal.vue'
import UserProfileModal from '@/components/UserProfileModal.vue'
import ToastHost from '@/components/ToastHost.vue'
import TrayPill from '@/components/TrayPill.vue'
import VoiceInputModal from '@/components/VoiceInputModal.vue'
import { showFloatingBall, onFloatingBallClick } from '@/services/floating-ball'

/**
 * 应用根组件（只显示展开面板——用户要求删除收起/展开功能）。
 * - 浏览器原型：模拟「透明置顶窗口」的浮动面板（可拖动、右上角定位）。
 * - Tauri 桌面：窗口本身就是面板（透明、置顶、无边框、右上角定位由 Rust 负责）。
 */
const tasks = useTasksStore()
const pet = usePetStore()
const ui = useUiStore()
const { panelPos, minimized } = storeToRefs(ui)
const { saveErrors } = storeToRefs(tasks)

const tauri = isTauri()
/** 手机端（Capacitor）：全屏 + 不显示桌宠/托盘，行为与桌面窗口一致 */
const mobile = isCapacitor()
const panelRef = ref<HTMLElement | null>(null)
/** 整个面板可拖动（Tauri=真实窗口；浏览器=浮动面板；手机=禁用） */
const dragPanel = useDraggablePanel(panelRef)

/** 手机/桌面窗口 → 全屏；浏览器原型 → 固定尺寸浮动面板 */
const panelStyle = computed(() =>
  tauri || mobile
    ? { left: '0px', top: '0px' }
    : { left: panelPos.value.x + 'px', top: panelPos.value.y + 'px' },
)

useKeyboard()
useIdle(panelRef)

// 手机语音：收到文本 → 预填快速录入框；Alt+。：打开截图识别
if (isTauri()) {
  tauriGlobal()!
    .event.listen('voice-input', (e) => {
      const text = String(e.payload ?? '').trim()
      if (!text) return
      useUiStore().openQuickAdd('q1', false, text)
      useToastsStore().add('info', `🎤 手机语音已收到：「${text.slice(0, 20)}」`)
    })
    .catch(() => {})
  tauriGlobal()!
    .event.listen('smart-shot', () => {
      useUiStore().smartInputOpen = true
      useUiStore().smartShotPending = true
    })
    .catch(() => {})
}

onMounted(async () => {
  await tasks.init()
  ui.applyOpacity() // 应用记忆的面板透明度
  ui.applyTaskFontSize() // 应用任务字体大小
  await useSettingsStore().init() // 读取持久化配置（Rust config.json / .env）
  const profile = useProfileStore()
  await profile.init() // 读取用户画像（user.md）
  // 首次引导：无画像且已配置大模型 → 延迟 1.5s 弹问卷
  if (!profile.hasProfile && useSettingsStore().cfg.llmBaseUrl.trim() && useSettingsStore().cfg.llmModel.trim()) {
    setTimeout(() => {
      useUiStore().onboardingOpen = true
    }, 1500)
  }
  ui.syncWindowSize() // 应用用户记忆的展开尺寸到真实窗口
  ui.startResizeTracking() // 拖边缩放时记忆窗口尺寸
  ui.snapIntoView()
  pet.start()
  if (isTauri()) void useLarkStore().init() // 飞书仅桌面版支持

  // 手机端：启动悬浮球 + 监听点击 → 打开语音
  if (mobile) {
    void showFloatingBall()
    onFloatingBallClick(() => {
      ui.openVoiceInput()
    })
  }

  // 首次启动欢迎提示，帮用户找到右上角的桌宠
  try {
    if (!localStorage.getItem('eisenhower-pet.welcomed')) {
      localStorage.setItem('eisenhower-pet.welcomed', '1')
      useToastsStore().add(
        'info',
        '👋 桌宠已就位（屏幕右上角）· Ctrl+Shift+Space 快速录入 · 点 🗕 最小化到托盘',
        6000,
      )
    }
  } catch {
    // 忽略
  }
})
</script>

<template>
  <!-- 面板（Tauri：整个窗口可拖动/可拖边缩放；浏览器：浮动 div） -->
  <div
    v-if="!minimized"
    ref="panelRef"
    class="fixed z-40 cursor-grab active:cursor-grabbing"
    :class="tauri || mobile ? 'h-full w-full' : 'h-[375px] w-[540px]'"
    :style="panelStyle"
    @mousedown="!mobile && dragPanel"
  >
    <ExpandedPanel />

    <!-- 非阻塞错误小条（Spec §8：二次写入失败；置于面板内避免被窗口边缘截断） -->
    <div
      v-for="err in saveErrors"
      :key="err.id"
      class="absolute left-3 right-3 top-14 z-30 flex items-center justify-between rounded-lg border border-rose-400/40 bg-rose-950/90 px-3 py-1.5 text-[11px] text-rose-200 shadow-lg backdrop-blur"
    >
      <span>⚠ {{ err.message }}</span>
    </div>
  </div>

  <VoiceInputModal />
  <QuickAddModal />
  <SmartInput />
  <OnboardingModal />
  <UserProfileModal />
  <ToastHost />
  <TrayPill />
</template>
