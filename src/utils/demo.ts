import { uuid } from './id'
import type { Task } from '@/types/task'

function hoursFromNow(h: number): number {
  return Date.now() + h * 3_600_000
}

/** 演示数据：覆盖四个象限，含子任务与不同截止，便于验收 Spec §12 */
export function seedTasks(): Task[] {
  const now = Date.now()
  const base = {
    createdAt: now,
    updatedAt: now,
    completedAt: null,
  }
  return [
    {
      ...base,
      id: uuid(),
      title: '提交季度周报',
      quadrant: 'q1',
      dueAt: hoursFromNow(2),
      subtasks: [
        { id: uuid(), title: '汇总数据', done: true },
        { id: uuid(), title: '写结论', done: false },
      ],
    },
    {
      ...base,
      id: uuid(),
      title: '回复客户加急邮件',
      quadrant: 'q1',
      dueAt: hoursFromNow(0.7), // ~42 分钟后到期 → 触发提醒演示
      subtasks: [],
    },
    {
      ...base,
      id: uuid(),
      title: '准备明天晨会材料',
      quadrant: 'q1',
      dueAt: hoursFromNow(18),
      subtasks: [],
    },
    {
      ...base,
      id: uuid(),
      title: '学习 Rust 所有权',
      quadrant: 'q2',
      dueAt: null,
      subtasks: [
        { id: uuid(), title: '装工具链', done: true },
        { id: uuid(), title: '跑通 hello world', done: false },
      ],
    },
    {
      ...base,
      id: uuid(),
      title: '制定健身计划',
      quadrant: 'q2',
      dueAt: hoursFromNow(72),
      subtasks: [],
    },
    {
      ...base,
      id: uuid(),
      title: '回电话给供应商',
      quadrant: 'q3',
      dueAt: hoursFromNow(3),
      subtasks: [],
    },
  ]
}
