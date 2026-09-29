import { describe, expect, it } from 'vitest'
import { parseTasks } from '@/services/smart'

describe('parseTasks — LLM 输出解析容错', () => {
  it('解析纯 JSON 数组', () => {
    const raw = '[{"title":"写周报","quadrant":"q1","dueAt":"2026-08-20T18:00:00"},{"title":"健身","quadrant":"q2","dueAt":""}]'
    const r = parseTasks(raw)
    expect(r).toHaveLength(2)
    expect(r[0]).toEqual({ title: '写周报', quadrant: 'q1', dueAt: new Date('2026-08-20T18:00:00').getTime() })
    expect(r[1].dueAt).toBeNull()
  })

  it('解析 {"tasks": [...]} 包装', () => {
    const raw = '{"tasks":[{"title":"A","quadrant":"q3","dueAt":""}]}'
    expect(parseTasks(raw)).toHaveLength(1)
  })

  it('容忍 markdown 代码块包裹', () => {
    const raw = '```json\n{"tasks":[{"title":"A","quadrant":"q1","dueAt":""}]}\n```'
    expect(parseTasks(raw)).toHaveLength(1)
  })

  it('容忍前后杂散文本（取首个 { 到末个 }）', () => {
    const raw = '好的，提取如下：{"tasks":[{"title":"A","quadrant":"q4","dueAt":""}]} 请查收'
    expect(parseTasks(raw)).toHaveLength(1)
  })

  it('非法象限回退 q2（无法确定时）', () => {
    const raw = '[{"title":"A","quadrant":"unknown","dueAt":""}]'
    expect(parseTasks(raw)[0].quadrant).toBe('q2')
  })

  it('无效 dueAt 解析为 null', () => {
    const raw = '[{"title":"A","quadrant":"q1","dueAt":"不是日期"},{"title":"B","quadrant":"q1","dueAt":null}]'
    const r = parseTasks(raw)
    expect(r[0].dueAt).toBeNull()
    expect(r[1].dueAt).toBeNull()
  })

  it('空 title 被过滤', () => {
    const raw = '[{"title":"  ","quadrant":"q1","dueAt":""},{"title":"有效任务","quadrant":"q2","dueAt":""}]'
    const r = parseTasks(raw)
    expect(r).toHaveLength(1)
    expect(r[0].title).toBe('有效任务')
  })

  it('title 截断到 120 字', () => {
    const raw = `[{"title":"${'长'.repeat(200)}","quadrant":"q1","dueAt":""}]`
    expect(parseTasks(raw)[0].title).toHaveLength(120)
  })

  it('输出非 JSON 时抛错', () => {
    expect(() => parseTasks('抱歉，我无法识别内容')).toThrow()
  })

  it('缺少 tasks 数组时抛错', () => {
    expect(() => parseTasks('{"msg":"no tasks"}')).toThrow()
  })
})
