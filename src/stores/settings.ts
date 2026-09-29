import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { isTauri, tauriGlobal } from '@/utils/tauri'
import { invoke, type AppConfig } from '@/services/ipc'

/** 智能录入相关配置：大模型（URL/Key/模型）+ 飞书 */
export interface SmartConfig {
  llmBaseUrl: string
  llmApiKey: string
  llmModel: string
  extractMode: 'single' | 'multiple'
  feishuAppId: string
  feishuAppSecret: string
  feishuChatId: string
}

export const SMART_DEFAULTS: SmartConfig = {
  llmBaseUrl: 'https://api.deepseek.com/v1',
  llmApiKey: '',
  llmModel: 'deepseek-chat',
  extractMode: 'multiple',
  feishuAppId: '',
  feishuAppSecret: '',
  feishuChatId: '',
}

type LlmField = 'llmBaseUrl' | 'llmApiKey' | 'llmModel'
type FeishuField = 'feishuAppId' | 'feishuAppSecret' | 'feishuChatId'
type ExtractMode = 'single' | 'multiple'

const EXTRACT_MODE_KEY = 'eisenhower-pet.extract-mode'

/** Tauri：config.json（appdata）；浏览器原型：localStorage（含旧键迁移） */
const CONFIG_KEY = 'eisenhower-pet.app-config'
const LEGACY_OVERRIDES_KEY = 'eisenhower-pet.llm-overrides'
const LEGACY_FEISHU_KEY = 'eisenhower-pet.feishu-config'

function loadJson<T>(key: string): T {
  try {
    const raw = localStorage.getItem(key)
    if (raw) return JSON.parse(raw) as T
  } catch {
    // 忽略
  }
  return {} as T
}

function nonEmpty(p: Partial<SmartConfig>): Partial<SmartConfig> {
  const out: Partial<SmartConfig> = {}
  for (const [k, v] of Object.entries(p)) {
    if (k === 'extractMode') {
      if (v === 'single' || v === 'multiple') (out as any)[k] = v
    } else if (typeof v === 'string' && v.trim()) {
      ;(out as any)[k] = v
    }
  }
  return out
}

/** 浏览器后备：localStorage 读取（迁移旧版两个独立键） */
function loadLocalConfig(): AppConfig {
  const c = loadJson<AppConfig>(CONFIG_KEY)
  if (!c.llmOverrides && !c.feishu) {
    const legacyOverrides = loadJson<Record<string, string>>(LEGACY_OVERRIDES_KEY)
    const legacyFeishu = loadJson<Record<string, string>>(LEGACY_FEISHU_KEY)
    if (Object.keys(legacyOverrides).length > 0 || Object.keys(legacyFeishu).length > 0) {
      c.llmOverrides = legacyOverrides
      c.feishu = legacyFeishu
      try {
        localStorage.setItem(CONFIG_KEY, JSON.stringify(c))
      } catch {
        // 忽略
      }
    }
  }
  return c
}

function saveLocalConfig(c: AppConfig): void {
  try {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(c))
  } catch {
    // 忽略
  }
}

export const useSettingsStore = defineStore('settings', () => {
  /** 用户在设置里手动填写的大模型字段（非空优先于 .env） */
  const llmOverrides = ref<Partial<Pick<SmartConfig, LlmField>>>({})
  /** .env 提供的大模型配置 */
  const env = ref<Partial<Pick<SmartConfig, LlmField>>>({})
  /** 飞书配置（持久化在 Rust 侧 config.json，密钥不落 localStorage） */
  const feishu = ref<Pick<SmartConfig, FeishuField>>(SMART_DEFAULTS)

  /** 生效配置：默认值 ← 飞书（仅飞书字段，防历史脏数据混入 LLM 字段） ← .env ← 用户手动填写（非空优先） */
  const cfg = computed<SmartConfig>(() => ({
    ...SMART_DEFAULTS,
    ...nonEmpty(feishu.value),
    ...env.value,
    ...nonEmpty(llmOverrides.value),
    extractMode: extractMode.value,
  }))

  const hasEnv = computed(() =>
    [env.value.llmBaseUrl, env.value.llmApiKey, env.value.llmModel].some((v) => !!v?.trim()),
  )

  /** 截图识别模式：single（单一） | multiple（多条，默认） */
  const extractMode = ref<ExtractMode>('multiple')

  function setExtractMode(m: ExtractMode): void {
    extractMode.value = m
    try {
      localStorage.setItem(EXTRACT_MODE_KEY, m)
    } catch {
      // 忽略
    }
  }

  /** 读取持久化配置（Tauri=Rust config.json；浏览器=localStorage） */
  async function loadConfig(): Promise<void> {
    let c: AppConfig = {}
    if (isTauri()) {
      try {
        c = await invoke('load_app_config')
      } catch {
        c = {}
      }
      // 迁移：旧版 Tauri 也把配置存在 localStorage，读到后搬入 config.json
      if (!c.llmOverrides && !c.feishu) {
        const legacy = loadLocalConfig()
        if (legacy.llmOverrides || legacy.feishu) {
          c = legacy
          await saveConfig()
        }
      }
    } else {
      c = loadLocalConfig()
    }
    llmOverrides.value = (c.llmOverrides ?? {}) as Partial<Pick<SmartConfig, LlmField>>
    // 只取飞书三个字段：历史 config 可能在 feishu 里混入 LLM 字段（覆盖生效配置），读入时丢弃
    const f = (c.feishu ?? {}) as Partial<Pick<SmartConfig, FeishuField>>
    feishu.value = {
      feishuAppId: f.feishuAppId ?? '',
      feishuAppSecret: f.feishuAppSecret ?? '',
      feishuChatId: f.feishuChatId ?? '',
    }
    // 加载截图识别模式
    try {
      const m = localStorage.getItem(EXTRACT_MODE_KEY)
      if (m === 'single' || m === 'multiple') extractMode.value = m
    } catch {
      // 忽略
    }
  }

  /** 持久化当前配置（含密钥，仅 Rust 侧 config.json / 浏览器 localStorage） */
  async function saveConfig(): Promise<void> {
    const c: AppConfig = {
      llmOverrides: { ...llmOverrides.value },
      feishu: { ...feishu.value },
    }
    if (isTauri()) {
      try {
        await invoke('save_app_config', { config: c })
      } catch {
        // 保存失败不阻断使用（内存态仍生效）
      }
    } else {
      saveLocalConfig(c)
    }
  }

  function setLlmField(key: LlmField, value: string): void {
    llmOverrides.value = { ...llmOverrides.value, [key]: value }
    void saveConfig()
  }

  /** 飞书配置变更后调用（SmartInput 输入框 @change） */
  function saveFeishu(): void {
    void saveConfig()
  }

  /** 启动初始化：加载持久化配置 + .env */
  async function init(): Promise<void> {
    await loadConfig()
    await reloadEnv()
  }

  /** 从 .env 重新加载（启动时自动调用；修改 .env 后可手动触发） */
  async function reloadEnv(): Promise<void> {
    env.value = {}
    const g = tauriGlobal()
    if (!g || !isTauri()) return
    try {
      const raw = (await g.core.invoke('get_env_config')) as Partial<Pick<SmartConfig, LlmField>>
      env.value = raw ?? {}
    } catch {
      env.value = {}
    }
  }

  /** 生成/打开 .env 文件，返回路径 */
  async function openEnvFile(): Promise<string> {
    const g = tauriGlobal()
    if (!g) return ''
    return (await g.core.invoke('open_env_file')) as string
  }

  return {
    cfg,
    env,
    hasEnv,
    feishu,
    extractMode,
    llmOverrides,
    setLlmField,
    setExtractMode,
    saveFeishu,
    init,
    reloadEnv,
    openEnvFile,
  }
})
