import { describe, expect, it } from 'vitest'
import { computePressure, analyzeTasks, pressureOf } from '@/utils/pressure'
import type { Task } from '@/types/task'

const HOUR = 3_600_000
const now = Date.now()

function task(partial: Partial<Task> & Pick<Task, 'id' | 'title' | 'quadrant'>): Task {
  return {
    dueAt: null,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    subtasks: [],
    ...partial,
  }
}

describe('computePressure — Spec §6.1 公式', () => {
  it('空输入压力为 0', () => {
    expect(
      computePressure({ q1Count: 0, q3Count: 0, overdueCount: 0, nearestDueHours: null }),
    ).toBe(0)
  })

  it('q1 任务每项 +5', () => {
    const p = computePressure({ q1Count: 3, q3Count: 0, overdueCount: 0, nearestDueHours: null })
    expect(p).toBe(15)
  })

  it('已超期任务每项 +3（即使它也是 q1，两项叠加）', () => {
    const p = computePressure({ q1Count: 1, q3Count: 0, overdueCount: 1, nearestDueHours: 0 })
    expect(p).toBe(5 + 3 + Math.min(5, 8 - 0)) // 5 + 3 + 5 = 13
  })

  it('8 小时窗口内的截止：min(5, 8 - 小时数)', () => {
    expect(computePressure({ q1Count: 0, q3Count: 0, overdueCount: 0, nearestDueHours: 3 })).toBe(5)
    expect(computePressure({ q1Count: 0, q3Count: 0, overdueCount: 0, nearestDueHours: 6 })).toBe(2)
    expect(computePressure({ q1Count: 0, q3Count: 0, overdueCount: 0, nearestDueHours: 8 })).toBe(0)
  })

  it('窗口外的截止（>8h）不贡献压力', () => {
    expect(computePressure({ q1Count: 0, q3Count: 0, overdueCount: 0, nearestDueHours: 10 })).toBe(0)
    expect(computePressure({ q1Count: 0, q3Count: 0, overdueCount: 0, nearestDueHours: null })).toBe(0)
  })

  it('q3 任务每项 +1', () => {
    expect(computePressure({ q1Count: 0, q3Count: 4, overdueCount: 0, nearestDueHours: null })).toBe(4)
  })
})

describe('analyzeTasks / pressureOf', () => {
  it('只统计未完成任务（q2/q4 不参与压力）', () => {
    const tasks: Task[] = [
      task({ id: 'a', title: 'a', quadrant: 'q2' }),
      task({ id: 'b', title: 'b', quadrant: 'q4' }),
    ]
    expect(pressureOf(tasks, now)).toBe(0)
  })

  it('已完成的 q1 任务不计压力', () => {
    const tasks: Task[] = [
      task({ id: 'a', title: 'a', quadrant: 'q1', completedAt: now }),
    ]
    expect(pressureOf(tasks, now)).toBe(0)
  })

  it('组合场景：3 个 q1 + 1 超期 + 3h 后到期 + 2 个 q3', () => {
    const tasks: Task[] = [
      task({ id: 'a', title: 'a', quadrant: 'q1' }),
      task({ id: 'b', title: 'b', quadrant: 'q1' }),
      task({ id: 'c', title: 'c', quadrant: 'q1' }),
      task({ id: 'd', title: 'd', quadrant: 'q1', dueAt: now - 2 * HOUR }), // 超期
      task({ id: 'e', title: 'e', quadrant: 'q2', dueAt: now + 3 * HOUR }),
      task({ id: 'f', title: 'f', quadrant: 'q3' }),
      task({ id: 'g', title: 'g', quadrant: 'q3' }),
    ]
    expect(pressureOf(tasks, now)).toBe(5 * 4 + 3 * 1 + 5 + 1 * 2)
  })

  it('nearestDueHours 取最近未完成任务的截止', () => {
    const tasks: Task[] = [
      task({ id: 'a', title: 'a', quadrant: 'q2', dueAt: now + 20 * HOUR }),
      task({ id: 'b', title: 'b', quadrant: 'q2', dueAt: now + 5 * HOUR }),
      task({ id: 'c', title: 'c', quadrant: 'q2', dueAt: now + 1 * HOUR }),
    ]
    const s = analyzeTasks(tasks, now)
    expect(s.nearestDueHours).toBe(1)
    expect(s.dueWithin1h).toBe(true)
  })

  it('无截止任务不影响 nearestDueHours', () => {
    const tasks: Task[] = [task({ id: 'a', title: 'a', quadrant: 'q2' })]
    const s = analyzeTasks(tasks, now)
    expect(s.nearestDueHours).toBeNull()
  })
})
