import type { PetMood } from '@/utils/petState'

/**
 * 桌宠渲染器接口。
 *
 * V1 原型由 Cat2DRenderer（程序化 2D Canvas 猫）实现；
 * 拿到正式 Spine 骨骼资源后，新增一个基于 pixi-spine 的实现替换即可，
 * 上层 PetCanvas.vue 与 pet store 无需改动。接入细节见 docs/TAURI_INTEGRATION.md。
 */
export interface PetRenderer {
  /** 绑定到画布并启动渲染循环 */
  attach(canvas: HTMLCanvasElement): void
  /** 切换情绪状态（压力状态机输出） */
  setMood(mood: PetMood): void
  /** 点击惊吓动画（Spec §6.2，V1 纯好玩无功能） */
  startle(): void
  /** 鼠标位置（画布 CSS 像素坐标），驱动眼神/头部跟随 */
  setPointer(x: number, y: number): void
  /** 鼠标离开 */
  clearPointer(): void
  /** 停止渲染循环并释放资源 */
  destroy(): void
}
