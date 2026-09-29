/** 截止时间展示与 datetime-local 转换 */

const HOUR = 3_600_000
const DAY = 24 * HOUR

export interface DueView {
  /** 是否已超期 */
  overdue: boolean
  /** 展示文本，如「今天 18:00」「已超期 2 小时」 */
  text: string
  /** 距今剩余毫秒 */
  diffMs: number
}

export function fmtTime(ts: number): string {
  const d = new Date(ts)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${hh}:${mm}`
}

/** epoch 毫秒 → 「2026-09-15 08:00」绝对时间（本地时区，到分） */
export function fmtDateTime(ts: number): string {
  const d = new Date(ts)
  const yyyy = d.getFullYear()
  const MM = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${yyyy}-${MM}-${dd} ${fmtTime(ts)}`
}

function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

function tomorrow(d: Date): Date {
  const t = new Date(d)
  t.setDate(t.getDate() + 1)
  return t
}

/** 把 epoch 毫秒格式化为用户友好的截止文案。
 * 「到日」任务（当天 23:59:59）只显示日期，不显示时间 */
export function formatDue(ts: number, now: number = Date.now()): DueView {
  const diffMs = ts - now
  const overdue = diffMs < 0
  const due = new Date(ts)
  const base = new Date(now)
  const endOfDay = due.getHours() === 23 && due.getMinutes() === 59 && due.getSeconds() >= 59

  if (overdue) {
    const abs = Math.abs(diffMs)
    if (abs < DAY) {
      const h = Math.max(1, Math.round(abs / HOUR))
      return { overdue, text: `已超期 ${h} 小时`, diffMs }
    }
    const d = Math.max(1, Math.round(abs / DAY))
    return { overdue, text: `已超期 ${d} 天`, diffMs }
  }

  if (isSameDay(due, base)) {
    return { overdue, text: endOfDay ? `今天` : `今天 ${fmtTime(ts)}`, diffMs }
  }
  if (isSameDay(due, tomorrow(base))) {
    return { overdue, text: endOfDay ? `明天` : `明天 ${fmtTime(ts)}`, diffMs }
  }
  const dateText = `${due.getMonth() + 1}月${due.getDate()}日`
  return { overdue, text: endOfDay ? dateText : `${dateText} ${fmtTime(ts)}`, diffMs }
}

/** epoch 毫秒 → datetime-local 输入框值（本地时区，到分） */
export function toLocalInput(ts: number): string {
  const d = new Date(ts)
  const yyyy = d.getFullYear()
  const MM = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  const HH = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${yyyy}-${MM}-${dd}T${HH}:${mm}`
}

/** epoch 毫秒 → date 输入框值（本地时区，只到日） */
export function toLocalDate(ts: number): string {
  const d = new Date(ts)
  const yyyy = d.getFullYear()
  const MM = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${yyyy}-${MM}-${dd}`
}

/**
 * 输入框值 → epoch 毫秒；空串返回 null。
 * - "YYYY-MM-DDTHH:mm"（到分）→ 按本地时间解析
 * - "YYYY-MM-DD"（到日）→ 本地当天 23:59:59（当天截止）
 */
export function fromLocalInput(value: string): number | null {
  if (!value) return null
  if (!value.includes('T')) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
    if (m) {
      const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 59).getTime()
      return Number.isFinite(t) ? t : null
    }
    return null
  }
  const t = new Date(value).getTime()
  return Number.isFinite(t) ? t : null
}

/** 距离截止的小时数（已超期为 0） */
export function hoursUntil(ts: number, now: number = Date.now()): number {
  return Math.max(0, (ts - now) / HOUR)
}
