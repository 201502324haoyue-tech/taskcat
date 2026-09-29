import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { isTauri } from '@/utils/tauri'
import { invoke } from '@/services/ipc'
import { useSettingsStore } from '@/stores/settings'
import { useToastsStore } from '@/stores/toasts'

/**
 * 用户画像（user.md）自主优化：
 * - 首次使用：问卷回答 → AI 生成初始画像
 * - 日常使用：每次拖拽调整任务象限 → 防抖后台 AI 分析 → 增量更新画像
 * - 画像在智能录入时注入 prompt（见 smart.ts），让分类贴合用户习惯
 * 存储：Tauri = appdata/user.md；浏览器 = localStorage。
 */
const PROFILE_KEY = 'eisenhower-pet.user-md'
/** 拖拽防抖窗口（毫秒）：连续拖拽只分析最后一次 */
const DEBOUNCE_MS = 2000
/** 两次分析的最小间隔（毫秒），控制 API 成本 */
const MIN_INTERVAL_MS = 10_000
/** 内存拖拽日志上限（随分析一起发给 AI） */
const DRAG_LOG_MAX = 20

export interface DragEvent {
  ts: number
  title: string
  from: string
  to: string
}

export const useProfileStore = defineStore('profile', () => {
  /** 用户画像 Markdown 全文（空 = 尚未生成） */
  const md = ref('')
  /** 最近拖拽调整（内存态） */
  const dragLog = ref<DragEvent[]>([])
  /** 最近一次分析完成时间戳（最小间隔控制） */
  const lastAnalyzedAt = ref(0)
  /** 是否有生成/分析进行中 */
  const busy = ref(false)
  let debounceTimer: ReturnType<typeof setTimeout> | null = null

  const hasProfile = computed(() => md.value.trim().length > 0)

  /** 读取画像（Tauri=appdata/user.md；浏览器=localStorage） */
  async function init(): Promise<void> {
    try {
      if (isTauri()) {
        md.value = await invoke('read_user_md')
      } else {
        md.value = localStorage.getItem(PROFILE_KEY) ?? ''
      }
    } catch {
      md.value = ''
    }
  }

  /** 保存画像到本地存储 */
  async function saveMd(): Promise<void> {
    try {
      if (isTauri()) {
        await invoke('write_user_md', { content: md.value })
      } else {
        localStorage.setItem(PROFILE_KEY, md.value)
      }
    } catch {
      // 保存失败不阻断（内存态仍生效）
    }
  }

  /** 问卷提交 → AI 生成初始画像 */
  async function generateFromAnswers(answers: {
    role: string
    domain: string
    priority: string
  }): Promise<boolean> {
    const settings = useSettingsStore()
    if (busy.value) return false
    busy.value = true
    try {
      const text = `工作角色：${answers.role}\n核心工作领域：${answers.domain}\n最重要/最紧急的事：${answers.priority}`
      const raw = await invoke('llm_profile_analyze', {
        apiBase: settings.cfg.llmBaseUrl,
        apiKey: settings.cfg.llmApiKey,
        model: settings.cfg.llmModel,
        args: { kind: 'generate', answers: text },
      })
      const out = String(raw ?? '').trim()
      if (!out || out === 'NO_CHANGE') return false
      md.value = out
      await saveMd()
      useToastsStore().add('success', '画像已生成，任务分类会越来越懂你')
      return true
    } catch (e) {
      useToastsStore().add('error', `画像生成失败：${e}`)
      return false
    } finally {
      busy.value = false
    }
  }

  /** 记录一次拖拽调整（在 tasks.moveTask 中调用），防抖后自动分析 */
  function recordDrag(ev: DragEvent): void {
    dragLog.value = [...dragLog.value.slice(-(DRAG_LOG_MAX - 1)), ev]
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      void analyzeOnce()
    }, DEBOUNCE_MS)
  }

  /** 单次后台分析：当前画像 + 最近拖拽日志 → AI 增量更新画像（全程静默，不打扰用户） */
  async function analyzeOnce(): Promise<void> {
    if (busy.value) return
    const settings = useSettingsStore()
    const now = Date.now()
    if (now - lastAnalyzedAt.value < MIN_INTERVAL_MS) return
    if (!settings.cfg.llmBaseUrl.trim() || !settings.cfg.llmModel.trim()) return // 未配置大模型，静默跳过
    busy.value = true
    try {
      const eventsText = dragLog.value
        .map((d) => `- ${new Date(d.ts).toLocaleString()} 将「${d.title}」从 ${d.from} 拖到 ${d.to}`)
        .join('\n')
      const raw = await invoke('llm_profile_analyze', {
        apiBase: settings.cfg.llmBaseUrl,
        apiKey: settings.cfg.llmApiKey,
        model: settings.cfg.llmModel,
        args: {
          kind: 'analyze',
          currentMd: md.value.trim() || null,
          dragEvents: eventsText || null,
        },
      })
      lastAnalyzedAt.value = Date.now()
      const out = String(raw ?? '').trim()
      if (out && out !== 'NO_CHANGE') {
        md.value = out
        await saveMd() // 后台静默更新，无需提醒
      }
    } catch (e) {
      lastAnalyzedAt.value = Date.now() // 失败也记间隔，避免高频重试
      console.warn('[task-cat] 画像分析失败（静默）', e)
    } finally {
      busy.value = false
    }
  }

  /** 手动编辑画像（UserProfileModal 保存） */
  async function updateMd(content: string): Promise<void> {
    md.value = content
    await saveMd()
    useToastsStore().add('success', '用户画像已保存')
  }

  return {
    md,
    dragLog,
    busy,
    hasProfile,
    init,
    saveMd,
    updateMd,
    generateFromAnswers,
    recordDrag,
  }
})
