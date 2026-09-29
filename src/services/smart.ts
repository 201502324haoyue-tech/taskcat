import { isQuadrant, type Quadrant } from '@/types/task'
import { invoke, type CaptureMeta } from '@/services/ipc'
import { useProfileStore } from '@/stores/profile'
import type { SmartConfig } from '@/stores/settings'
import { isTauri } from '@/utils/tauri'

/**
 * 智能录入服务：截图 / 飞书 / 大模型提取，后端为 Rust 命令（避免 CORS，密钥不出本机）。
 */

export interface ExtractedTask {
  title: string
  quadrant: Quadrant
  dueAt: number | null
}

/** 截取鼠标所在屏幕完整画面（回退主屏）：秒回屏幕布局信息，窗口已铺满该屏幕；
 * 画面 base64 由后台线程编码，需再调 fetchCaptureB64() 获取 */
export function captureScreen(): Promise<CaptureMeta> {
  if (!isTauri()) return Promise.reject(new Error('截图识别仅桌面版可用'))
  return invoke('capture_screen')
}

/** 获取后台线程编码完成的截图 base64（JPEG），编码未完成时会等待 */
export function fetchCaptureB64(): Promise<string> {
  if (!isTauri()) return Promise.reject(new Error('截图识别仅桌面版可用'))
  return invoke('get_capture_b64')
}

/** 从内存截图裁剪选区（canvas），返回 base64 PNG —— 不二次截屏，保证所见即所得 */
export function cropShotB64(
  srcB64: string,
  x: number,
  y: number,
  w: number,
  h: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas')
        canvas.width = Math.max(1, Math.round(w))
        canvas.height = Math.max(1, Math.round(h))
        const ctx = canvas.getContext('2d')
        if (!ctx) {
          reject(new Error('Canvas 2D 上下文不可用'))
          return
        }
        ctx.drawImage(img, x, y, w, h, 0, 0, canvas.width, canvas.height)
        const b64 = canvas.toDataURL('image/png').split(',')[1]
        if (!b64) {
          reject(new Error('裁剪结果为空'))
          return
        }
        resolve(b64)
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)))
      }
    }
    img.onerror = () => reject(new Error('截图图像加载失败'))
    img.src = 'data:image/jpeg;base64,' + srcB64
  })
}

/** 从文本提取任务（自动注入用户画像，分类贴合用户习惯） */
export async function extractFromText(text: string, cfg: SmartConfig): Promise<ExtractedTask[]> {
  if (!isTauri()) throw new Error('大模型提取仅桌面版可用')
  const raw = await invoke('llm_extract', {
    apiBase: cfg.llmBaseUrl,
    apiKey: cfg.llmApiKey,
    model: cfg.llmModel,
    extractMode: cfg.extractMode,
    userProfile: useProfileStore().md.trim() || null,
    text,
    imageB64: null,
  })
  return parseTasks(raw)
}

/** 从截图（base64 PNG）提取任务（自动注入用户画像，分类贴合用户习惯） */
export async function extractFromImage(b64: string, cfg: SmartConfig): Promise<ExtractedTask[]> {
  if (!isTauri()) throw new Error('大模型提取仅桌面版可用')
  const raw = await invoke('llm_extract', {
    apiBase: cfg.llmBaseUrl,
    apiKey: cfg.llmApiKey,
    model: cfg.llmModel,
    extractMode: cfg.extractMode,
    userProfile: useProfileStore().md.trim() || null,
    text: null,
    imageB64: b64,
  })
  return parseTasks(raw)
}

/** 拉取飞书群聊文本消息（返回原始 JSON：{"texts":[...]}） */
export function feishuFetch(cfg: SmartConfig): Promise<string> {
  if (!isTauri()) return Promise.reject(new Error('飞书同步仅桌面版可用'))
  return invoke('feishu_fetch', {
    appId: cfg.feishuAppId,
    appSecret: cfg.feishuAppSecret,
    chatId: cfg.feishuChatId,
  })
}

/** 启动语音服务，返回手机访问地址 */
export function startVoiceServer(): Promise<string> {
  if (!isTauri()) return Promise.reject(new Error('语音服务仅桌面版可用'))
  return invoke('start_voice_server')
}

export function getLanIp(): Promise<string> {
  if (!isTauri()) return Promise.reject(new Error('此功能仅桌面版可用'))
  return invoke('get_lan_ip')
}

function parseDue(v: unknown): number | null {
  if (typeof v === 'string' && v.trim()) {
    const t = new Date(v).getTime()
    if (Number.isFinite(t)) return t
  }
  return null
}

/** 截断容错解析：整段失败时逐个提取完整对象（LLM 输出被 max_tokens 截断时挽回已完整的条目） */
function parseFragments(frag: string): unknown[] | null {
  const items: unknown[] = []
  const re = /\{[^{}]*\}/g
  let m: RegExpExecArray | null
  while ((m = re.exec(frag))) {
    try {
      items.push(JSON.parse(m[0]))
    } catch {
      // 跳过损坏片段
    }
  }
  return items.length ? items : null
}

/** 解析 LLM 输出的 JSON（容忍 markdown 代码块包裹、前后杂散文本、顶层数组、推理模型的 <think> 思考块） */
export function parseTasks(raw: unknown): ExtractedTask[] {
  const s = String(raw ?? '')
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .trim()
  let obj: unknown = null
  if (s.startsWith('[')) {
    // 顶层数组：直接整体解析
    obj = JSON.parse(s)
  } else {
    // 对象包装（可能被杂散文本包裹）：取首个 { 到末个 }
    const start = s.indexOf('{')
    const end = s.lastIndexOf('}')
    if (start < 0 || end <= start) throw new Error('大模型输出不是有效 JSON')
    const frag = s.slice(start, end + 1)
    try {
      obj = JSON.parse(frag)
    } catch {
      // 输出截断修复：提取已完整的条目，避免整段丢弃
      obj = parseFragments(frag)
      if (!obj) throw new Error('大模型输出不是有效 JSON')
    }
  }
  const arr = Array.isArray(obj) ? obj : (obj as { tasks?: unknown }).tasks
  if (!Array.isArray(arr)) throw new Error('大模型输出缺少 tasks 数组')
  return arr
    .map((t): ExtractedTask | null => {
      const item = t as { title?: unknown; quadrant?: unknown; dueAt?: unknown }
      const title = String(item.title ?? '').trim().slice(0, 120)
      if (!title) return null
      return {
        title,
        quadrant: isQuadrant(item.quadrant) ? item.quadrant : 'q2',
        dueAt: parseDue(item.dueAt),
      }
    })
    .filter((t): t is ExtractedTask => t !== null)
}
