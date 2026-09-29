/** 任务领域类型（与 Spec §4 一致） */

export type Quadrant = 'q1' | 'q2' | 'q3' | 'q4'

export interface Subtask {
  id: string
  title: string
  done: boolean
}

export interface Task {
  id: string // UUID v4
  title: string // ≤ 120 字
  quadrant: Quadrant
  dueAt: number | null // epoch 毫秒；null 表示无截止
  createdAt: number
  updatedAt: number
  completedAt: number | null
  subtasks: Subtask[]
}

export const QUADRANTS: readonly Quadrant[] = ['q1', 'q2', 'q3', 'q4']

export interface QuadrantMeta {
  /** 完整标签，如「紧急·重要」 */
  label: string
  /** 行动提示，如「马上做」 */
  action: string
  /** 空态提示 */
  emptyHint: string
  icon: string
  hex: string
}

export const QUADRANT_META: Record<Quadrant, QuadrantMeta> = {
  q1: {
    label: '紧急·重要',
    action: '马上做',
    emptyHint: '空 · 一身轻松',
    icon: '🔥',
    hex: '#f43f5e',
  },
  q2: {
    label: '重要·不急',
    action: '排期做',
    emptyHint: '空 · 记得规划',
    icon: '📅',
    hex: '#f59e0b',
  },
  q3: {
    label: '紧急·不重要',
    action: '委托他人',
    emptyHint: '空 · 没有杂事',
    icon: '⏰',
    hex: '#3b82f6',
  },
  q4: {
    label: '都不',
    action: '删掉它',
    emptyHint: '✨ 应该空空的',
    icon: '🗑',
    hex: '#94a3b8',
  },
}

export function isQuadrant(v: unknown): v is Quadrant {
  return v === 'q1' || v === 'q2' || v === 'q3' || v === 'q4'
}

/** 象限数字键 1-4 */
export const QUADRANT_BY_KEY: Record<string, Quadrant> = {
  '1': 'q1',
  '2': 'q2',
  '3': 'q3',
  '4': 'q4',
}
