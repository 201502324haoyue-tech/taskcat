/**
 * 桌宠状态机（Spec §6.1）：
 *
 *   | P 范围               | 状态     |
 *   |----------------------|----------|
 *   | P ≥ 8                | active   |  跑跳 / zoomies
 *   | 3 ≤ P < 8            | wander   |  沿面板边缘闲逛
 *   | 0 < P < 3 且空闲>5min | sleep    |  蜷睡 + Z 粒子
 *   | 0 < P < 3 且未空闲    | relaxed  |  坐、舔毛、眨眼、打哈欠
 *
 * 带滞回（hysteresis）避免边界抖动：
 *   - 进入 active 需 P ≥ 8；已在 active 时 P ≥ 6 保持（跌落带 [6,8)）
 *   - 进入 wander（自 relaxed）需 P ≥ 4；已在 wander 时 P ≥ 2 保持
 *   - 强制活跃覆盖（Spec §6.3）：任何未完成任务距截止 ≤ 1h 时强制 active
 */

export type PetMood = 'active' | 'wander' | 'relaxed' | 'sleep'

export const PET_MOODS: readonly PetMood[] = ['active', 'wander', 'relaxed', 'sleep']

/** 空闲超过该秒数（且 P < 3）进入睡眠 */
export const IDLE_SLEEP_SECONDS = 5 * 60

export interface PetStateInput {
  pressure: number
  idleSeconds: number
  /** 距截止 ≤ 1h 的未完成任务存在时为 true，强制 active */
  forcedActive: boolean
}

export interface PetMoodMeta {
  label: string
  emoji: string
}

export const PET_MOOD_META: Record<PetMood, PetMoodMeta> = {
  active: { label: '活跃', emoji: '⚡' },
  wander: { label: '闲逛', emoji: '🚶' },
  relaxed: { label: '悠闲', emoji: '😌' },
  sleep: { label: '睡觉', emoji: '💤' },
}

export const DEFAULT_MOOD: PetMood = 'relaxed'

export function nextPetState(prev: PetMood, input: PetStateInput): PetMood {
  const { pressure, idleSeconds, forcedActive } = input

  if (forcedActive) return 'active'
  if (pressure >= 8) return 'active'
  // 滞回：从 active 跌落时 P 需 < 6 才离开
  if (prev === 'active' && pressure >= 6) return 'active'
  // 进入 wander 需 P ≥ 4（自 relaxed 上升的滞回带 [3,4)）
  if (pressure >= 4) return 'wander'
  // P < 3 且空闲 > 5 分钟 → 睡觉（压力优先：P ≥ 3 时不会走到这里）
  if (pressure < 3 && idleSeconds >= IDLE_SLEEP_SECONDS) return 'sleep'
  // 滞回：已在 wander 时 P ≥ 2 保持
  if (prev === 'wander' && pressure >= 2) return 'wander'
  return 'relaxed'
}
