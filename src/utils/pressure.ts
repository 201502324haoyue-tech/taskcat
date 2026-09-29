import { hoursUntil } from './datetime'
import type { Quadrant, Task } from '@/types/task'

/**
 * 压力分数 P（Spec §6.1），每 30 秒重算一次（任务变更时立即重算）：
 *
 *   P = 5 × q1 任务数
 *     + 3 × 已超期任务数
 *     + min(5, 8 - 最近截止相差小时数)   // 如果有任务在 8 小时内到期
 *     + 1 × q3 任务数
 */

export const Q1_WEIGHT = 5
export const OVERDUE_WEIGHT = 3
export const Q3_WEIGHT = 1
/** 截止紧迫加分窗口（小时） */
export const DUE_SOON_WINDOW_H = 8
/** 紧迫加分上限 */
export const DUE_SOON_CAP = 5

export interface PressureInput {
  q1Count: number
  q3Count: number
  overdueCount: number
  /** 最近一个未完成任务距离截止的小时数（8 小时窗口内才有此项）；无任务/无截止为 null */
  nearestDueHours: number | null
}

/** 纯函数：从象限计数与截止信息计算压力分 */
export function computePressure(input: PressureInput): number {
  const { q1Count, q3Count, overdueCount, nearestDueHours } = input

  let p = 0
  p += Q1_WEIGHT * q1Count
  p += OVERDUE_WEIGHT * overdueCount
  p += Q3_WEIGHT * q3Count
  if (nearestDueHours !== null && nearestDueHours <= DUE_SOON_WINDOW_H) {
    p += Math.min(DUE_SOON_CAP, DUE_SOON_WINDOW_H - nearestDueHours)
  }
  return p
}

export interface TaskPressureStats {
  q1Count: number
  q2Count: number
  q3Count: number
  q4Count: number
  overdueCount: number
  /** 距离最近一个未完成任务的截止小时数；无任务或全部无截止时为 null */
  nearestDueHours: number | null
  /** 是否有任务在 1 小时内到期（触发提醒 + 强制活跃，Spec §6.3） */
  dueWithin1h: boolean
}

/** 从未完成任务集合推导压力统计（只统计未完成） */
export function analyzeTasks(tasks: readonly Task[], now: number = Date.now()): TaskPressureStats {
  const counts: Record<Quadrant, number> = { q1: 0, q2: 0, q3: 0, q4: 0 }
  let overdueCount = 0
  let nearestDueHours: number | null = null
  let dueWithin1h = false

  for (const t of tasks) {
    if (t.completedAt !== null) continue
    counts[t.quadrant] += 1

    if (t.dueAt !== null) {
      const hours = hoursUntil(t.dueAt, now)
      if (hours <= 0) overdueCount += 1
      if (nearestDueHours === null || hours < nearestDueHours) nearestDueHours = hours
      if (hours <= 1) dueWithin1h = true
    }
  }

  return {
    q1Count: counts.q1,
    q2Count: counts.q2,
    q3Count: counts.q3,
    q4Count: counts.q4,
    overdueCount,
    nearestDueHours,
    dueWithin1h,
  }
}

/** 由任务列表直接得到压力分 */
export function pressureOf(tasks: readonly Task[], now: number = Date.now()): number {
  const s = analyzeTasks(tasks, now)
  return computePressure({
    q1Count: s.q1Count,
    q3Count: s.q3Count,
    overdueCount: s.overdueCount,
    nearestDueHours: s.nearestDueHours,
  })
}
