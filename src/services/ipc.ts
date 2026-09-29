/**
 * 强类型 Tauri 命令封装：所有 invoke 都通过命令映射表，
 * 参数/返回值类型由 CommandMap 约束，命令签名变更时编译期即可发现。
 * 插件命令（plugin:sql|*）与自定义命令统一收编。
 */
import { tauriGlobal } from '@/utils/tauri'

export interface LlmExtractArgs {
  apiBase: string
  apiKey: string
  model: string
  extractMode: string
  userProfile: string | null
  text: string | null
  imageB64: string | null
}

/** 用户画像生成/学习参数（kind=generate 问卷生成 / analyze 拖拽学习更新） */
export interface ProfileAnalyzeArgs {
  kind: 'generate' | 'analyze'
  answers?: string | null
  currentMd?: string | null
  dragEvents?: string | null
}

export interface FeishuFetchArgs {
  appId: string
  appSecret: string
  chatId: string
}

/** lark-cli 事件订阅规格（key=事件类型，as=身份：im 消息用 bot，妙记用 user） */
export interface LarkEventSpec {
  key: string
  as?: 'user' | 'bot' | 'auto'
}

/** 应用配置（LLM 覆盖项 + 飞书凭证），持久化在 Rust 侧 config.json，密钥不落 localStorage */
export interface AppConfig {
  llmOverrides?: Record<string, string>
  feishu?: Record<string, string>
}

export interface SqlLoadArgs {
  db: string
}

export interface SqlSelectArgs {
  db: string
  query: string
  values: unknown[]
}

export interface SqlExecuteArgs {
  db: string
  query: string
  values: unknown[]
}

/** 截图结果：目标屏幕坐标/尺寸（画面 base64 需另调 get_capture_b64，截屏命令秒回以快速进入截图模式） */
export interface CaptureMeta {
  screenX: number
  screenY: number
  screenW: number
  screenH: number
}

interface CommandMap {
  'capture_screen': [undefined, CaptureMeta]
  'get_capture_b64': [undefined, string]
  'llm_extract': [LlmExtractArgs, string]
  'llm_profile_analyze': [{ apiBase: string; apiKey: string; model: string; args: ProfileAnalyzeArgs }, string]
  'read_user_md': [undefined, string]
  'write_user_md': [{ content: string }, void]
  'feishu_fetch': [FeishuFetchArgs, string]
  'lark_status': [undefined, string]
  'lark_auth_login': [undefined, string]
  'lark_auth_poll': [undefined, string]
  'lark_poll_messages': [undefined, string]
  'lark_run': [{ args: string[] }, string]
  'lark_events_start': [{ sessions: LarkEventSpec[] }, void]
  'lark_events_stop': [undefined, void]
  'lark_config_init': [undefined, string]
  'lark_config_output': [undefined, string]
  'llm_reply': [{ apiBase: string; apiKey: string; model: string; senderName?: string; text: string }, string]
  'open_browser': [{ url: string }, void]
  'start_voice_server': [undefined, string]
  'get_lan_ip': [undefined, string]
  'get_env_config': [undefined, Partial<{ llmBaseUrl: string; llmApiKey: string; llmModel: string }>]
  'get_env_path': [undefined, string]
  'open_env_file': [undefined, string]
  'get_autostart': [undefined, boolean]
  'set_autostart': [{ enabled: boolean }, boolean]
  'load_app_config': [undefined, AppConfig]
  'save_app_config': [{ config: AppConfig }, void]
  'plugin:sql|load': [SqlLoadArgs, void]
  'plugin:sql|select': [SqlSelectArgs, unknown[]]
  'plugin:sql|execute': [SqlExecuteArgs, void]
}

export async function invoke<K extends keyof CommandMap>(
  cmd: K,
  args?: CommandMap[K][0],
): Promise<CommandMap[K][1]> {
  const g = tauriGlobal()
  if (!g) {
    console.warn('[invoke] 不在 Tauri 运行时中，命令被忽略:', cmd)
    throw new Error('此功能仅桌面版可用')
  }
  return g.core.invoke(cmd, args as unknown as Record<string, unknown>) as Promise<CommandMap[K][1]>
}
