import { describe, expect, it } from 'vitest'
import { nextPetState, IDLE_SLEEP_SECONDS, type PetMood } from '@/utils/petState'

const idle = (s: number) => s
const idle5min = IDLE_SLEEP_SECONDS

describe('nextPetState — Spec §6.1 状态映射（带滞回）', () => {
  it('P ≥ 8 → active（无论之前状态）', () => {
    expect(nextPetState('relaxed', { pressure: 8, idleSeconds: 0, forcedActive: false })).toBe('active')
    expect(nextPetState('wander', { pressure: 9, idleSeconds: 0, forcedActive: false })).toBe('active')
    expect(nextPetState('sleep', { pressure: 10, idleSeconds: idle5min, forcedActive: false })).toBe('active')
  })

  it('滞回：从 active 跌落，P ∈ [6,8) 仍保持 active', () => {
    expect(nextPetState('active', { pressure: 7, idleSeconds: 0, forcedActive: false })).toBe('active')
    expect(nextPetState('active', { pressure: 6, idleSeconds: 0, forcedActive: false })).toBe('active')
  })

  it('P < 6 离开 active → wander', () => {
    expect(nextPetState('active', { pressure: 5.9, idleSeconds: 0, forcedActive: false })).toBe('wander')
  })

  it('3 ≤ P < 8 → wander（自 relaxed 进入需 P ≥ 4，滞回带 [3,4)）', () => {
    expect(nextPetState('relaxed', { pressure: 4, idleSeconds: 0, forcedActive: false })).toBe('wander')
    expect(nextPetState('relaxed', { pressure: 7.5, idleSeconds: 0, forcedActive: false })).toBe('wander')
    expect(nextPetState('relaxed', { pressure: 3, idleSeconds: 0, forcedActive: false })).toBe('relaxed')
  })

  it('滞回：已在 wander，P ≥ 2 保持（未空闲时）', () => {
    expect(nextPetState('wander', { pressure: 2.5, idleSeconds: 0, forcedActive: false })).toBe('wander')
    expect(nextPetState('wander', { pressure: 2, idleSeconds: 0, forcedActive: false })).toBe('wander')
  })

  it('P < 3 且空闲 > 5 分钟 → sleep（无条件规则，高于滞回保持，Spec §6.1）', () => {
    expect(nextPetState('relaxed', { pressure: 1, idleSeconds: idle5min + 1, forcedActive: false })).toBe('sleep')
    expect(nextPetState('wander', { pressure: 2, idleSeconds: idle5min, forcedActive: false })).toBe('sleep')
    expect(nextPetState('active', { pressure: 2.5, idleSeconds: idle5min, forcedActive: false })).toBe('sleep')
  })

  it('压力优先：P ≥ 3 时空闲再久也不睡觉', () => {
    expect(nextPetState('relaxed', { pressure: 5, idleSeconds: idle5min * 10, forcedActive: false })).toBe('wander')
    expect(nextPetState('wander', { pressure: 9, idleSeconds: idle5min * 10, forcedActive: false })).toBe('active')
  })

  it('P < 3 且未空闲 → relaxed', () => {
    expect(nextPetState('wander', { pressure: 1, idleSeconds: 0, forcedActive: false })).toBe('relaxed')
    expect(nextPetState('sleep', { pressure: 1, idleSeconds: 0, forcedActive: false })).toBe('relaxed')
  })

  it('空闲后互动：idle 重置 → 从 sleep 醒来为 relaxed', () => {
    expect(nextPetState('sleep', { pressure: 1, idleSeconds: 0, forcedActive: false })).toBe('relaxed')
  })

  it('强制活跃覆盖：距截止 ≤ 1h 时无论 P 多低都 active（Spec §6.3）', () => {
    expect(nextPetState('sleep', { pressure: 0, idleSeconds: idle5min, forcedActive: true })).toBe('active')
    expect(nextPetState('relaxed', { pressure: 0.5, idleSeconds: 0, forcedActive: true })).toBe('active')
  })
})

describe('状态机滞回防抖：边界来回不抖动', () => {
  it('P 在 6.5 附近抖动不触发状态切换', () => {
    let mood: PetMood = 'active'
    for (const p of [7.2, 6.8, 7.0, 6.4, 6.9, 6.6]) {
      mood = nextPetState(mood, { pressure: p, idleSeconds: 0, forcedActive: false })
    }
    expect(mood).toBe('active')
  })

  it('P 在 2.5 附近抖动不触发 relaxed/wander 切换', () => {
    let mood: PetMood = 'wander'
    for (const p of [3.2, 2.6, 3.0, 2.4, 2.9, 2.6]) {
      mood = nextPetState(mood, { pressure: p, idleSeconds: 0, forcedActive: false })
    }
    expect(mood).toBe('wander')
  })
})
