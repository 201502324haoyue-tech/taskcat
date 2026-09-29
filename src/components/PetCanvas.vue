<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { usePetStore } from '@/stores/pet'
import { useUiStore } from '@/stores/ui'
import { useToastsStore } from '@/stores/toasts'
import { PET_MOOD_META } from '@/utils/petState'
import { Cat2DRenderer } from './pet/Cat2DRenderer'
import type { PetRenderer } from './pet/PetRenderer'

/**
 * 桌宠宿主：Canvas 渲染 + 交互（悬停眼神跟随 / 点击惊吓 / 右键菜单）+ 提醒红叹号（Spec §6）。
 * 渲染器走 PetRenderer 接口，后续可替换为 pixi-spine 实现。
 */
const props = withDefaults(defineProps<{ size?: 'sm' | 'md' | 'lg' }>(), { size: 'sm' })

/** 容器尺寸：与渲染器设计比例 140:96 一致，猫充满画布无留白 */
const sizeClass = computed(() =>
  props.size === 'sm'
    ? 'h-[72px] w-[104px]'
    : props.size === 'md'
      ? 'h-[88px] w-[128px]'
      : 'h-[108px] w-[156px]',
)

const canvasRef = ref<HTMLCanvasElement | null>(null)
const menu = ref<{ x: number; y: number } | null>(null)
let renderer: PetRenderer | null = null

const pet = usePetStore()
const ui = useUiStore()
const toasts = useToastsStore()
const { mood, pressure, forcedActive } = storeToRefs(pet)

const moodMeta = PET_MOOD_META

onMounted(() => {
  if (!canvasRef.value) return
  renderer = new Cat2DRenderer()
  renderer.attach(canvasRef.value)
  renderer.setMood(pet.mood)
})

onUnmounted(() => {
  renderer?.destroy()
  renderer = null
})

watch(mood, (m) => renderer?.setMood(m))

function onPointerMove(e: MouseEvent): void {
  const c = canvasRef.value
  if (!c || !renderer) return
  const rect = c.getBoundingClientRect()
  renderer.setPointer(e.clientX - rect.left, e.clientY - rect.top)
}

function onPointerLeave(): void {
  renderer?.clearPointer()
}

function onClick(): void {
  pet.onUserActivity()
  renderer?.startle() // Spec §6.2：点击惊吓，V1 纯好玩
}

function onContextMenu(e: MouseEvent): void {
  e.preventDefault()
  pet.onUserActivity()
  menu.value = { x: e.clientX, y: e.clientY }
}

function closeMenu(): void {
  menu.value = null
}

function menuSettings(): void {
  closeMenu()
  toasts.add('info', '桌宠设置将在 V2 提供（喂食 / 换装 / 配件）')
}

function menuReset(): void {
  closeMenu()
  ui.resetPanelPos()
  toasts.add('success', '已吸附回屏幕右上角')
}
</script>

<template>
  <div
    class="group relative cursor-pointer"
    :class="sizeClass"
    @pointermove="onPointerMove"
    @pointerleave="onPointerLeave"
    @pointerdown="pet.onUserActivity"
    @click="onClick"
    @contextmenu.prevent="onContextMenu"
  >
    <canvas ref="canvasRef" class="absolute inset-0 h-full w-full" />

    <!-- 提醒红叹号：距截止 ≤ 1h 未完成时脉冲显示（Spec §6.3） -->
    <div
      v-if="forcedActive"
      class="pulse-alert absolute -right-1 -top-1 z-10 flex h-[18px] w-[18px] items-center justify-center rounded-full bg-rose-500 text-[11px] font-black text-white shadow-md"
      title="有任务将在 1 小时内到期"
    >
      !
    </div>

    <!-- 悬停时显示情绪与压力 -->
    <div
      class="pointer-events-none absolute -top-2 left-1/2 z-10 -translate-x-1/2 whitespace-nowrap rounded-full border border-white/10 bg-slate-900/85 px-2 py-0.5 text-[10px] text-slate-200 opacity-0 shadow transition-opacity group-hover:opacity-100"
    >
      {{ moodMeta[mood].emoji }} {{ moodMeta[mood].label }} · 压力 {{ pressure.toFixed(1) }}
    </div>

    <!-- 右键菜单 -->
    <Teleport to="body">
      <template v-if="menu">
        <!-- 点击空白处关闭 -->
        <div class="fixed inset-0 z-[99]" data-app-ui @pointerdown="closeMenu" @contextmenu.prevent="closeMenu" />
        <div
          class="animate-pop-in fixed z-[100] w-40 overflow-hidden rounded-xl border border-white/10 bg-slate-900/95 p-1 text-[13px] text-slate-200 shadow-2xl backdrop-blur"
          :style="{ left: menu.x + 'px', top: menu.y + 'px' }"
        >
          <button class="w-full rounded-lg px-3 py-1.5 text-left hover:bg-white/10" @click="menuSettings">
            ⚙️ 桌宠设置（占位）
          </button>
          <button class="w-full rounded-lg px-3 py-1.5 text-left hover:bg-white/10" @click="menuReset">
            📌 重置位置
          </button>
        </div>
      </template>
    </Teleport>
  </div>
</template>
