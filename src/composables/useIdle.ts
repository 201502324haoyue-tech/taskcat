import { onMounted, onUnmounted } from 'vue'
import type { Ref } from 'vue'
import { usePetStore } from '@/stores/pet'

/**
 * 空闲检测（Spec §6.1）：
 * 仅统计本应用内的活动——鼠标移动限定在面板与 Teleport 弹窗（data-app-ui）内，
 * 窗口外/页面外的系统鼠标移动不重置空闲（否则浏览器原型下猫永远不睡觉）。
 * 空闲秒数由 pet store 每秒累加，这里负责在交互时清零。
 * 页面不可见（切走标签页）时暂停累计，避免原型被误判为睡眠。
 */
function isInApp(target: EventTarget | null): boolean {
  if (!(target instanceof Node)) return false
  return (
    !!document.getElementById('app')?.contains(target) ||
    (target instanceof Element && !!target.closest('[data-app-ui]'))
  )
}

export function useIdle(panelEl?: Ref<HTMLElement | null>): void {
  const pet = usePetStore()
  let ticking = false

  /** 鼠标移动仅在应用 UI 内（面板或弹窗）才算活动 */
  function onPointerMove(e: MouseEvent): void {
    if (panelEl?.value?.contains(e.target as Node)) {
      pet.onUserActivity()
      return
    }
    if (isInApp(e.target)) pet.onUserActivity()
  }

  function onPointerDown(e: PointerEvent): void {
    if (isInApp(e.target)) pet.onUserActivity()
  }

  function onActivity(): void {
    pet.onUserActivity()
  }

  function tick(): void {
    if (document.visibilityState === 'visible') {
      pet.idleSeconds += 1
    }
  }

  function startTick(): void {
    if (ticking) return
    ticking = true
    window.setInterval(tick, 1000)
  }

  onMounted(() => {
    startTick()
    window.addEventListener('pointermove', onPointerMove, { passive: true })
    window.addEventListener('pointerdown', onPointerDown, { passive: true })
    window.addEventListener('keydown', onActivity)
    window.addEventListener('wheel', onActivity, { passive: true })
  })
  onUnmounted(() => {
    window.removeEventListener('pointermove', onPointerMove)
    window.removeEventListener('pointerdown', onPointerDown)
    window.removeEventListener('keydown', onActivity)
    window.removeEventListener('wheel', onActivity)
  })
}
