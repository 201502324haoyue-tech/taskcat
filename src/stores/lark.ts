import { defineStore } from 'pinia'
import { ref } from 'vue'
import { isTauri, tauriGlobal } from '@/utils/tauri'
import { invoke, type LarkEventSpec } from '@/services/ipc'
import { extractFromText } from '@/services/smart'
import { useSettingsStore } from '@/stores/settings'
import { useTasksStore } from '@/stores/tasks'
import { useToastsStore } from '@/stores/toasts'

/** 事件订阅会话状态（每 key 一个） */
export interface LarkSessionState {
  key: string
  phase: 'starting' | 'ready' | 'reconnecting' | 'error' | 'exited'
  message?: string
}

/** 认证状态（解析 lark-cli auth status --json） */
export interface LarkAuthState {
  configured: boolean
  loggedIn: boolean
  identity?: string
  userName?: string
  openId?: string
  scopes?: string[]
  message?: string
  hint?: string
}

/** 最近处理记录（设置页日志） */
export interface LarkRecentItem {
  ts: number
  kind: 'msg' | 'minute' | 'info' | 'error'
  text: string
}

const AUTO_KEY = 'eisenhower-pet.lark-auto'
const SEEN_KEY = 'eisenhower-pet.lark-seen'
/** 去重缓存上限（超出淘汰最旧） */
const SEEN_MAX = 500

function loadSeen(): Set<string> {
  try {
    const arr = JSON.parse(localStorage.getItem(SEEN_KEY) ?? '[]') as string[]
    return new Set(arr.slice(-SEEN_MAX))
  } catch {
    return new Set()
  }
}

function persistSeen(seen: Set<string>): void {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify([...seen].slice(-SEEN_MAX)))
  } catch {
    // 忽略
  }
}

export const useLarkStore = defineStore('lark', () => {
  const autoEnabled = ref(false)
  const sessions = ref<LarkSessionState[]>([])
  const recent = ref<LarkRecentItem[]>([])
  const busy = ref(false)
  const auth = ref<LarkAuthState>({ configured: false, loggedIn: false })
  const started = ref(false)
  let seen: Set<string> = loadSeen()
  let unlistenFns: Array<() => void> = []
  let initDone = false
  /** 轮询定时器与首次建游标标记（首次不处理历史消息，只登记去重） */
  let pollTimer: ReturnType<typeof setInterval> | null = null
  let firstPoll = true
  /** 轮询间隔：每 30 秒一轮检测新消息 */
  const POLL_INTERVAL = 30_000

  /** 解析 lark-cli auth status --json 输出（成功形态为 identities 结构，失败形态为 error 信封） */
  function parseAuth(raw: string): LarkAuthState {
    try {
      const v = JSON.parse(raw) as {
        ok?: boolean
        identity?: string
        identities?: {
          bot?: { status?: string }
          user?: { status?: string; userName?: string; openId?: string }
        }
        user?: { name?: string }
        scopes?: string[]
        error?: { type?: string; subtype?: string; message?: string; hint?: string }
      }
      const userReady = v.identities?.user?.status === 'ready' || v.identities?.user?.status === 'needs_refresh'
      const botReady = v.identities?.bot?.status === 'ready' || v.identities?.bot?.status === 'needs_refresh'
      // 成功形态：部分命令带 ok=true；auth status 成功输出为 identities 结构（无 ok 字段）；needs_refresh 属已授权待自动刷新
      if (v.ok || userReady || botReady) {
        return {
          configured: true,
          loggedIn: userReady,
          identity: v.identity ?? (userReady ? 'user' : botReady ? 'bot' : ''),
          userName: v.identities?.user?.userName ?? v.user?.name,
          openId: v.identities?.user?.openId,
          scopes: v.scopes,
        }
      }
      const subtype = v.error?.subtype ?? ''
      const configured = subtype !== 'not_configured'
      return {
        configured,
        loggedIn: false,
        message: v.error?.message ?? '未知状态',
        hint: v.error?.hint,
      }
    } catch {
      return { configured: false, loggedIn: false, message: '状态解析失败' }
    }
  }

  function pushRecent(item: Omit<LarkRecentItem, 'ts'>): void {
    recent.value = [{ ts: Date.now(), ...item }, ...recent.value].slice(0, 30)
  }

  /** 去重检查并登记（消息 ID / 妙记 token / 事件 ID） */
  function checkSeen(id: string): boolean {
    if (seen.has(id)) return false
    seen.add(id)
    persistSeen(seen)
    return true
  }

  function setSessionPhase(key: string, phase: LarkSessionState['phase'], message?: string): void {
    const list = [...sessions.value]
    const i = list.findIndex((s) => s.key === key)
    if (i >= 0) {
      list[i] = { key, phase, message }
    } else {
      list.push({ key, phase, message })
    }
    sessions.value = list
  }

  /** 刷新认证状态（设置页手动点「重新检测」或流程推进时调用） */
  async function refreshAuth(): Promise<LarkAuthState> {
    if (!isTauri()) {
      auth.value = { configured: false, loggedIn: false, message: '' }
      return auth.value
    }
    try {
      const raw = await invoke('lark_status')
      auth.value = parseAuth(raw)
    } catch (e) {
      auth.value = { configured: false, loggedIn: false, message: String(e) }
    }
    return auth.value
  }

  /** 创建/绑定飞书应用（后台 config init，URL 由 lark_config_output 轮询获取） */
  async function configInit(): Promise<void> {
    try {
      await invoke('lark_config_init')
      pushRecent({ kind: 'info', text: '已发起应用创建，请扫码或打开链接完成配置' })
    } catch (e) {
      pushRecent({ kind: 'error', text: `创建应用失败：${e}` })
      useToastsStore().add('error', `创建飞书应用失败：${e}`)
    }
  }

  /** 读取 config init 后台进程输出（含授权 URL） */
  async function configOutputRpc(): Promise<string> {
    try {
      return await invoke('lark_config_output')
    } catch {
      return ''
    }
  }

  /** 发起登录授权（--no-wait 设备码模式），返回 {deviceCode, verificationUri} */
  async function authLogin(): Promise<{ deviceCode: string; verificationUri: string } | null> {
    try {
      const raw = await invoke('lark_auth_login')
      const v = JSON.parse(raw) as {
        device_code?: string
        verification_url?: string
        verification_uri?: string
        verification_uri_complete?: string
      }
      return {
        deviceCode: v.device_code ?? '',
        verificationUri: v.verification_url ?? v.verification_uri_complete ?? v.verification_uri ?? '',
      }
    } catch (e) {
      pushRecent({ kind: 'error', text: `发起登录失败：${e}` })
      return null
    }
  }

  /** 轮询一次授权状态（auth status 直接检测，无阻塞进程） */
  async function authPoll(): Promise<boolean> {
    try {
      const raw = await invoke('lark_auth_poll')
      const v = JSON.parse(raw) as { identities?: { user?: { status?: string } } }
      if (v.identities?.user?.status === 'ready' || v.identities?.user?.status === 'needs_refresh') {
        await refreshAuth()
        return auth.value.loggedIn
      }
      return false
    } catch (e) {
      pushRecent({ kind: 'error', text: `登录轮询失败：${e}` })
      return false
    }
  }

  /** 启动事件订阅（im 新消息 + 妙记生成） */
  async function start(): Promise<void> {
    if (!isTauri()) return
    if (started.value) return
    const spec: LarkEventSpec[] = [
      { key: 'im.message.receive_v1', as: 'bot' },
      { key: 'minutes.minute.generated_v1', as: 'user' },
    ]
    try {
      await invoke('lark_events_start', { sessions: spec })
      for (const s of spec) setSessionPhase(s.key, 'starting')
      started.value = true
      pushRecent({ kind: 'info', text: '已启动自动接收（消息 + 妙记）' })
      // 事件订阅（机器人收消息）之外，另起用户消息轮询（任何人发给我的私聊）
      startPoll()
    } catch (e) {
      pushRecent({ kind: 'error', text: `启动自动接收失败：${e}` })
      useToastsStore().add('error', `启动飞书自动接收失败：${e}`)
    }
  }

  /** 停止事件订阅 */
  async function stop(): Promise<void> {
    stopPoll()
    try {
      await invoke('lark_events_stop')
    } catch {
      // 忽略
    }
    started.value = false
    sessions.value = []
    pushRecent({ kind: 'info', text: '已停止自动接收' })
  }

  /** 轮询一次：拉全部人-人单聊最新消息 → 新消息提炼写入；首次只建游标不处理历史 */
  async function pollOnce(): Promise<void> {
    if (busy.value) return
    try {
      const raw = await invoke('lark_poll_messages')
      const msgs = JSON.parse(raw) as Array<{
        message_id?: string
        content?: string
        msg_type?: string
        sender_id?: string
        sender_type?: string
      }>
      const me = auth.value.openId
      for (const m of msgs) {
        if (m.msg_type && m.msg_type !== 'text') continue
        if (m.sender_type && m.sender_type !== 'user') continue
        if (me && m.sender_id === me) continue
        const id = m.message_id ?? ''
        if (!id) continue
        if (firstPoll) {
          // 首次开启：历史消息只登记去重游标，不提炼，避免历史任务洪水
          seen.add(id)
          persistSeen(seen)
          continue
        }
        await handleMessage({ message_id: id, content: m.content, message_type: m.msg_type })
      }
      firstPoll = false
    } catch (e) {
      pushRecent({ kind: 'error', text: `轮询消息失败：${String(e).slice(0, 100)}` })
    }
  }

  /** 启动用户消息轮询（立即一轮 + 定时） */
  function startPoll(): void {
    stopPoll()
    firstPoll = true
    void pollOnce()
    pollTimer = setInterval(() => void pollOnce(), POLL_INTERVAL)
  }

  /** 停止用户消息轮询 */
  function stopPoll(): void {
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
  }

  /** 切换自动接收开关（记忆，重启后自动恢复） */
  function setAutoEnabled(v: boolean): void {
    autoEnabled.value = v
    try {
      localStorage.setItem(AUTO_KEY, v ? '1' : '0')
    } catch {
      // 忽略
    }
    if (v) void start()
    else void stop()
  }

  /** 消息事件 → 提炼 → 自动写入 */
  async function handleMessage(ev: { message_id?: string; content?: string; message_type?: string; sender_id?: string }): Promise<void> {
    if (ev.message_type && ev.message_type !== 'text') return
    const text = String(ev.content ?? '').trim()
    if (!text) return
    if (!checkSeen(ev.message_id ?? text)) return
    await processText(text, 'msg')
  }

  /** 妙记事件 → 拉取纪要文字 → 提炼 → 自动写入 */
  async function handleMinute(ev: { event_id?: string; minute_token?: string; title?: string }): Promise<void> {
    const token = ev.minute_token ?? ''
    if (!token) return
    if (!checkSeen(ev.event_id ?? token)) return
    pushRecent({ kind: 'minute', text: `新妙记：${ev.title ?? token}` })
    try {
      const raw = await invoke('lark_run', {
        args: ['minutes', '+detail', '--minute-token', token, '--format', 'json'],
      })
      const text = extractMinuteText(raw)
      if (!text) {
        pushRecent({ kind: 'info', text: '妙记暂无文字记录，跳过' })
        return
      }
      await processText(`【会议纪要】${ev.title ?? ''}\n${text}`, 'minute')
    } catch (e) {
      pushRecent({ kind: 'error', text: `读取妙记失败：${String(e).slice(0, 120)}` })
    }
  }

  /** 从 minutes +detail 输出里提取文字记录（优先 transcript 字段，兼容多形态输出） */
  function extractMinuteText(raw: string): string {
    try {
      const v = JSON.parse(raw) as Record<string, unknown>
      const pick = (o: unknown): string => {
        if (typeof o === 'string') return o
        if (o && typeof o === 'object') {
          for (const k of ['transcript', 'text', 'content', 'paragraphs', 'sentences']) {
            const sub = (o as Record<string, unknown>)[k]
            if (sub !== undefined) {
              const s = pick(sub)
              if (s) return s
            }
          }
        }
        if (Array.isArray(o)) {
          return o
            .map((x) => (typeof x === 'string' ? x : pick(x)))
            .filter(Boolean)
            .join('\n')
        }
        return ''
      }
      const s = pick(v).trim()
      return s.length > 40000 ? s.slice(0, 40000) : s
    } catch {
      return ''
    }
  }

  /** 统一提炼写入：LLM 提炼 → 自动写入任务 + toast */
  async function processText(text: string, kind: 'msg' | 'minute'): Promise<void> {
    if (busy.value) {
      pushRecent({ kind: 'info', text: '正在处理上一条，本次跳过' })
      return
    }
    const cfg = useSettingsStore().cfg
    if (!cfg.llmApiKey.trim()) {
      pushRecent({ kind: 'error', text: '未配置大模型 Key，无法提炼（请在设置中填写）' })
      return
    }
    busy.value = true
    try {
      const tasks = await extractFromText(text, cfg)
      if (tasks.length === 0) {
        pushRecent({ kind: 'info', text: '未识别到任务' })
        return
      }
      const store = useTasksStore()
      for (const t of tasks) store.addTask(t)
      useToastsStore().add('success', `已从飞书${kind === 'minute' ? '会议纪要' : '消息'}新增 ${tasks.length} 条任务`)
      pushRecent({
        kind,
        text: `识别 ${tasks.length} 条：${tasks.map((t) => t.title).join('、').slice(0, 80)}`,
      })
    } catch (e) {
      pushRecent({ kind: 'error', text: `提炼失败：${String(e).slice(0, 120)}` })
    } finally {
      busy.value = false
    }
  }

  /** 事件分发（Rust lark:event 转发） */
  async function handleIncoming(key: string, event: unknown): Promise<void> {
    if (key === 'im.message.receive_v1') {
      await handleMessage((event ?? {}) as { message_id?: string; content?: string; message_type?: string })
    } else if (key === 'minutes.minute.generated_v1') {
      await handleMinute((event ?? {}) as { event_id?: string; minute_token?: string; title?: string })
    }
  }

  /** 注册 Rust 事件监听（幂等） */
  async function ensureListeners(): Promise<void> {
    if (initDone || !isTauri()) return
    initDone = true
    const g = tauriGlobal()
    if (!g) return
    unlistenFns.push(
      await g.event.listen('lark:event', (e) => {
        const p = e.payload as { key?: string; event?: unknown }
        if (p?.key) void handleIncoming(p.key, p.event)
      }),
    )
    unlistenFns.push(
      await g.event.listen('lark:status', (e) => {
        const p = e.payload as { key?: string; phase?: string; message?: string }
        if (p?.key && p.phase) setSessionPhase(p.key, p.phase as LarkSessionState['phase'], p.message)
      }),
    )
    // 应用创建向导完成（用户浏览器操作结束）→ 自动刷新认证状态，UI 切到下一步
    unlistenFns.push(await g.event.listen('lark:config-done', () => void refreshAuth()))
    // 小爱同学语音任务：用户对小爱 App 说任务内容 → 回调 → emit xiaoai:task → 提炼写入
    unlistenFns.push(
      await g.event.listen('xiaoai:task', (e) => {
        const p = e.payload as { text?: string; session_id?: string }
        if (p?.text) {
          pushRecent({ kind: 'msg', text: `📢 小爱语音：${p.text.slice(0, 50)}` })
          void processText(p.text, 'msg')
        }
      }),
    )
  }

  /** 启动初始化：恢复开关 + 注册监听 + 刷新认证状态 */
  async function init(): Promise<void> {
    await ensureListeners()
    try {
      if (localStorage.getItem(AUTO_KEY) === '1') autoEnabled.value = true
    } catch {
      // 忽略
    }
    await refreshAuth()
    if (autoEnabled.value) {
      await start()
    }
  }

  return {
    autoEnabled,
    sessions,
    recent,
    busy,
    auth,
    started,
    setAutoEnabled,
    refreshAuth,
    configInit,
    configOutputRpc,
    authLogin,
    authPoll,
    start,
    stop,
    pollOnce,
    init,
  }
})
