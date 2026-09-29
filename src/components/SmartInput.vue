<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useUiStore } from '@/stores/ui'
import { useSettingsStore } from '@/stores/settings'
import { useToastsStore } from '@/stores/toasts'
import { useLarkStore } from '@/stores/lark'
import { useTasksStore } from '@/stores/tasks'
import { invoke } from '@/services/ipc'
import { isCapacitor, isTauri } from '@/utils/tauri'
import { getSyncBase, pullTasks, setSyncBase, testConnection, mergeTasks, mergedDiffers } from '@/services/sync'
import { getAuth, isLoggedIn, login as authLogin, register as authRegister, logout as authLogout } from '@/services/auth'
import LoginPanel from './LoginPanel.vue'
import {
  captureScreen,
  cropShotB64,
  extractFromImage,
  extractFromText,
  feishuFetch,
  startVoiceServer,
  fetchCaptureB64,
  type ExtractedTask,
} from '@/services/smart'
import ExtractedTaskList from './ExtractedTaskList.vue'

type TabId = 'shot' | 'feishu' | 'voice' | 'manual' | 'sync'

/**
 * 智能录入中心：四种任务录入方式
 * 1. 📷 截图识别：截屏 → 大模型提取任务（自动分象限）
 * 2. 💬 飞书同步：拉取群聊消息 → 大模型提取
 * 3. 🎤 语音输入：手机浏览器语音转文字 → 发到电脑
 * 4. ✍️ 手动输入：打开原手动录入弹窗
 */
const ui = useUiStore()
const settings = useSettingsStore()
const toasts = useToastsStore()
const { smartInputOpen } = storeToRefs(ui)

const tab = ref<TabId>(isCapacitor() ? 'sync' : 'shot')
const extracted = ref<ExtractedTask[]>([])

// 截图识别
const takingShot = ref(false)
const analyzing = ref(false)
const shotB64 = ref('')
/** 截图弹层状态：idle=未截屏 / loading=已进入截图模式等待画面（窗口已铺满，编码中） / ready=画面就绪 */
const shotState = ref<'idle' | 'loading' | 'ready'>('idle')
const shotImgRef = ref<HTMLImageElement | null>(null)
const imgDisplayScale = ref({ sx: 1, sy: 1 })
/** 选区（图像原始像素坐标）：左上 + 宽高 */
const selection = ref<{ x: number; y: number; w: number; h: number } | null>(null)
const isDragging = ref(false)

function updateImgDisplayScale(): void {
  const img = shotImgRef.value
  if (!img || !img.naturalWidth || !img.naturalHeight) return
  const r = img.getBoundingClientRect()
  imgDisplayScale.value = { sx: r.width / img.naturalWidth, sy: r.height / img.naturalHeight }
}

watch(shotState, (v) => {
  if (v !== 'idle') {
    // 进入截图模式即监听 Esc；画面就绪后等待图片加载更新显示比例
    window.addEventListener('keydown', onShotKeydown)
    if (v === 'ready') {
      nextTick(() => updateImgDisplayScale())
      window.addEventListener('resize', updateImgDisplayScale)
    }
  } else {
    window.removeEventListener('resize', updateImgDisplayScale)
    window.removeEventListener('keydown', onShotKeydown)
  }
})

function resetSelection(): void {
  selection.value = null
  isDragging.value = false
}

/** 截图弹层期间按 Esc 取消（微信截图习惯） */
function onShotKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') cancelShot()
}

// 飞书
const feishuBusy = ref(false)
const lark = useLarkStore()
/** 应用创建向导输出的授权链接 */
const configUrl = ref('')
const configStarting = ref(false)
/** 设备码登录的授权链接与轮询状态 */
const loginUrl = ref('')
const loginPolling = ref(false)

/** 发起应用创建向导，轮询后台输出直到拿到授权链接 */
async function startConfigInit(): Promise<void> {
  if (configStarting.value) return
  configStarting.value = true
  configUrl.value = ''
  try {
    await lark.configInit()
    for (let i = 0; i < 30; i++) {
      const out = await lark.configOutputRpc()
      const m = out.match(/https:\/\/open\.feishu\.cn\/page\/cli\?[^\s"']+/)
      if (m) {
        configUrl.value = m[0]
        // 自动打开系统浏览器，免去手动复制链接
        void invoke('open_browser', { url: m[0] }).catch(() => {})
        return
      }
      await new Promise((r) => setTimeout(r, 1000))
    }
    toasts.add('warn', '未获取到授权链接，请检查网络后重试')
  } finally {
    configStarting.value = false
  }
}

/** 发起设备码登录，授权完成后自动轮询收尾 */
async function startLogin(): Promise<void> {
  if (loginPolling.value) return
  const r = await lark.authLogin()
  if (!r) return
  loginUrl.value = r.verificationUri
  // 自动打开系统浏览器完成授权
  if (r.verificationUri) {
    void invoke('open_browser', { url: r.verificationUri }).catch(() => {})
  }
  if (!r.deviceCode) return
  loginPolling.value = true
  try {
    for (let i = 0; i < 60; i++) {
      const ok = await lark.authPoll()
      if (ok) {
        loginUrl.value = ''
        toasts.add('success', '飞书授权成功，可开启自动接收')
        return
      }
      await new Promise((res) => setTimeout(res, 3000))
    }
    toasts.add('warn', '授权超时，请重新发起登录')
  } finally {
    loginPolling.value = false
  }
}

const voicePublicUrl = (import.meta.env.VITE_VOICE_PUBLIC_URL || '').trim()

/** 切到飞书 tab 时刷新认证状态 */
watch(tab, (t) => {
  if (t === 'feishu') {
    void lark.refreshAuth()
  }
})

// 语音
const voiceUrl = ref('')
const voiceStarting = ref(false)

watch(smartInputOpen, (open) => {
  if (open) {
    tab.value = isCapacitor() ? 'sync' : 'shot'
    extracted.value = []
  }
})

// Alt+。 全局快捷键：打开智能录入并自动开始截图
watch(
  () => ui.smartShotPending,
  (v) => {
    if (v) {
      ui.smartShotPending = false
      tab.value = 'shot'
      void takeShot()
    }
  },
)

const methods: { id: TabId; icon: string; label: string }[] = [
  ...(isCapacitor() ? [] : [{ id: 'shot' as TabId, icon: '📷', label: '截图识别' }]),
  ...(isCapacitor() ? [] : [{ id: 'feishu' as TabId, icon: '💬', label: '飞书同步' }]),
  ...(isCapacitor() ? [] : [{ id: 'voice' as TabId, icon: '🎤', label: '语音输入' }]),
  ...(isCapacitor() ? [{ id: 'sync' as TabId, icon: '🔄', label: '同步' }] : []),
  { id: 'manual', icon: '✍️', label: '手动输入' },
]

// 手机端：同步服务器地址 + 手动输入为主
const syncUrl = ref(getSyncBase())
const syncTesting = ref(false)
const syncMessage = ref('')
const showLogin = ref(false)
const authInfo = getAuth()

async function syncTest(): Promise<void> {
  syncTesting.value = true
  syncMessage.value = ''
  try {
    const r = await testConnection()
    syncMessage.value = r.message
    if (r.ok) toasts.add('success', r.message)
    else toasts.add('warn', r.message)
  } finally {
    syncTesting.value = false
  }
}

function syncSave(): void {
  setSyncBase(syncUrl.value)
  toasts.add('success', '已保存同步地址')
}

async function syncNow(): Promise<void> {
  syncMessage.value = ''
  try {
    const r = await pullTasks()
    const tasks = useTasksStore()
    const merged = mergeTasks(tasks.tasks, r.tasks)
    if (mergedDiffers(tasks.tasks, merged)) {
      tasks.replaceAll(merged)
      toasts.add('success', `已同步 ${merged.length} 条任务（含本地 ${tasks.tasks.length} 条）`)
    } else {
      toasts.add('info', '已是最新，无变化')
    }
    syncMessage.value = `拉取到 ${r.count} 条任务`
  } catch (e) {
    syncMessage.value = `同步失败：${e instanceof Error ? e.message : e}`
    toasts.add('error', syncMessage.value)
  }
}

async function takeShot(): Promise<void> {
  if (!isTauri()) {
    toasts.add('warn', '截图识别仅桌面版可用')
    return
  }
  takingShot.value = true
  // Rust 截屏期间会把窗口铺满目标屏幕（隐藏→截屏→放大→显示），先抑制 resize 记忆，
  // 避免铺满尺寸被写入 expanded-size 导致取消后窗口无法恢复
  ui.suppressResizeSave = true
  try {
    // 立即进入截图模式：先显示遮罩（窗口此刻还是面板大小，Rust 铺满后自然全屏），
    // 画面由后台线程编码，编码完成后填入
    shotState.value = 'loading'
    await captureScreen() // 秒回（隐藏→截屏→铺满→显示），返回时窗口已铺满目标屏幕
    shotB64.value = await fetchCaptureB64() // 等待后台编码完成（debug 编译约 1s）
    shotState.value = 'ready'
  } catch (e) {
    shotState.value = 'idle'
    shotB64.value = ''
    toasts.add('error', `截图失败：${e}`)
    ui.suppressResizeSave = false
    ui.syncWindowSize() // 窗口可能已被移动/放大，恢复原状
  } finally {
    takingShot.value = false
  }
}

async function analyzeB64(b64: string): Promise<void> {
  cancelShot() // 立即关闭截图界面，识别在后台进行，不再停留在截图视图
  analyzing.value = true
  try {
    extracted.value = await extractFromImage(b64, settings.cfg)
    toasts.add('success', `识别出 ${extracted.value.length} 条任务`)
  } catch (e) {
    toasts.add('error', `识别失败：${e}`)
  } finally {
    analyzing.value = false
  }
}

/** 从内存截图裁剪用户选中的区域（所见即所得，不再二次截屏），裁剪后立即关闭截图界面 */
async function analyzeSelection(): Promise<void> {
  const sel = selection.value
  if (!sel || sel.w < 5 || sel.h < 5) return
  let b64: string
  try {
    b64 = await cropShotB64(shotB64.value, sel.x, sel.y, sel.w, sel.h)
  } catch (e) {
    toasts.add('error', `裁剪失败：${e}`)
    return
  }
  cancelShot() // 截图完毕：关闭截图界面，识别在后台进行
  analyzing.value = true
  try {
    extracted.value = await extractFromImage(b64, settings.cfg)
    toasts.add('success', `识别出 ${extracted.value.length} 条任务`)
  } catch (e) {
    toasts.add('error', `识别失败：${e}`)
  } finally {
    analyzing.value = false
  }
}

/** 选区拖拽：把屏幕坐标换算成图像原始像素坐标，并裁剪到图像范围内 */
function onShotMouseDown(e: MouseEvent): void {
  const img = shotImgRef.value
  if (!img) return
  const r = img.getBoundingClientRect()
  const scaleX = (img.naturalWidth || r.width) / r.width
  const scaleY = (img.naturalHeight || r.height) / r.height
  const x = Math.max(0, Math.min(img.naturalWidth, Math.round((e.clientX - r.left) * scaleX)))
  const y = Math.max(0, Math.min(img.naturalHeight, Math.round((e.clientY - r.top) * scaleY)))
  selection.value = { x, y, w: 0, h: 0 }
  isDragging.value = true
  e.preventDefault()
}

function onShotMouseMove(e: MouseEvent): void {
  if (!isDragging.value) return
  const img = shotImgRef.value
  if (!img) return
  const r = img.getBoundingClientRect()
  const scaleX = (img.naturalWidth || r.width) / r.width
  const scaleY = (img.naturalHeight || r.height) / r.height
  const x0 = selection.value?.x ?? 0
  const y0 = selection.value?.y ?? 0
  const x = Math.max(0, Math.min(img.naturalWidth, Math.round((e.clientX - r.left) * scaleX)))
  const y = Math.max(0, Math.min(img.naturalHeight, Math.round((e.clientY - r.top) * scaleY)))
  const xa = Math.min(x0, x)
  const ya = Math.min(y0, y)
  const xb = Math.max(x0, x)
  const yb = Math.max(y0, y)
  selection.value = { x: xa, y: ya, w: xb - xa, h: yb - ya }
}

function onShotMouseUp(): void {
  isDragging.value = false
  // 太小视为未选择
  const sel = selection.value
  if (sel && (sel.w < 5 || sel.h < 5)) {
    selection.value = null
    return
  }
  if (sel) {
    // 截图完毕：默认只识别框选区域，松手即关闭截图界面并自动识别
    void analyzeSelection()
  }
}

function cancelShot(): void {
  shotState.value = 'idle'
  shotB64.value = ''
  resetSelection()
  ui.suppressResizeSave = false
  ui.syncWindowSize() // 恢复窗口尺寸
}

async function feishuSync(): Promise<void> {
  const cfg = settings.cfg
  if (!cfg.feishuAppId || !cfg.feishuAppSecret || !cfg.feishuChatId) {
    toasts.add('warn', '请先填写飞书应用凭证与群聊 ID')
    return
  }
  feishuBusy.value = true
  try {
    const raw = await feishuFetch(cfg)
    const texts = (JSON.parse(raw) as { texts: string[] }).texts
    extracted.value = await extractFromText(texts.join('\n'), cfg)
    toasts.add('success', `已从 ${texts.length} 条消息识别出 ${extracted.value.length} 条任务`)
  } catch (e) {
    toasts.add('error', `飞书同步失败：${e}`)
  } finally {
    feishuBusy.value = false
  }
}

async function startVoice(): Promise<void> {
  if (!isTauri()) {
    toasts.add('warn', '语音输入仅桌面版可用')
    return
  }
  if (voiceUrl.value) return
  voiceStarting.value = true
  try {
    voiceUrl.value = await startVoiceServer()
  } catch (e) {
    toasts.add('error', `启动语音服务失败：${e}`)
  } finally {
    voiceStarting.value = false
  }
}

function goManual(): void {
  ui.closeSmartInput()
  ui.openQuickAdd()
}

/** 关闭智能录入并打开 ⚙️ 设置（大模型配置已移至底层设置） */
function toggleSettings(): void {
  ui.closeSmartInput()
  ui.settingsOpen = true
}

const inputCls =
  'h-7 min-w-0 rounded-lg border border-white/10 bg-white/5 px-2 text-[11px] text-slate-100 outline-none transition placeholder:text-slate-500 focus:border-sky-400/50'
</script>

<template>
  <Teleport to="body">
    <!-- 智能录入中心 -->
    <div v-if="smartInputOpen" class="fixed inset-0 z-[92] flex items-center justify-center" data-app-ui>
      <div class="absolute inset-0 bg-black/25 backdrop-blur-[2px]" @click="ui.closeSmartInput()" />
      <div class="glass-panel relative flex max-h-[92vh] w-[92vw] max-w-[480px] flex-col p-3" @keydown.esc.prevent="ui.closeSmartInput()">
        <div class="mb-2 flex items-center justify-between">
          <span class="text-[13px] font-semibold text-slate-100">✨ 智能录入</span>
          <button
            class="flex h-6 w-6 items-center justify-center rounded-full text-slate-300 transition hover:bg-white/10 hover:text-white"
            title="关闭"
            @click="ui.closeSmartInput()"
          >
            ✕
          </button>
        </div>

        <!-- 方式切换 -->
        <div class="mb-3 flex rounded-full bg-white/5 p-0.5">
          <button
            v-for="m in methods"
            :key="m.id"
            class="flex-1 rounded-full py-1.5 text-[11px] transition"
            :class="tab === m.id ? 'bg-sky-400/80 font-medium text-slate-900' : 'text-slate-300 hover:text-white'"
            @click="tab = m.id"
          >
            {{ m.icon }} {{ m.label }}
          </button>
        </div>

        <div class="thin-scroll min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
          <!-- 📷 截图识别 -->
          <div v-if="tab === 'shot'" class="space-y-2">
            <div class="rounded-2xl border border-white/10 bg-white/5 p-2.5">
              <div class="mb-1 flex items-center justify-between text-[11px] font-semibold text-slate-200">
                <span>大模型</span>
                <button class="rounded-full bg-white/10 px-2 py-0.5 text-[10px] text-slate-300 transition hover:bg-white/20" @click="ui.closeSmartInput(); toggleSettings()">
                  去 ⚙️ 设置配置
                </button>
              </div>
              <p class="text-[10px] leading-relaxed text-slate-400">
                当前模型：{{ settings.cfg.llmModel || '未配置' }} · 接口：{{ settings.cfg.llmBaseUrl || '未配置' }}
                <template v-if="settings.hasEnv"> · <span class="text-emerald-300">来自 .env</span></template>
              </p>
            </div>
            <div v-if="analyzing" class="rounded-2xl border border-sky-400/30 bg-sky-500/10 p-2.5">
              <div class="flex items-center gap-2 text-[11px] text-sky-200">
                <span class="inline-block h-3 w-3 animate-spin rounded-full border-2 border-sky-400 border-t-transparent" />
                大模型正在识别截图内容，请稍候…
              </div>
            </div>
            <button
              class="w-full rounded-full bg-violet-400/85 py-2 text-[12px] font-medium text-slate-900 transition hover:bg-violet-300 disabled:opacity-50"
              :disabled="takingShot || analyzing"
              @click="takeShot"
            >
              {{ takingShot ? '⏳ 截屏中…' : '📷 截取屏幕并识别' }}
            </button>
            <p class="text-[10px] leading-relaxed text-slate-400">
              按下截图后框选要识别的区域，松开鼠标即自动识别；也可识别整屏。支持 OpenAI 兼容与 Anthropic（Claude）。快捷键：<span class="rounded bg-white/10 px-1 text-slate-200">Alt+。</span>
            </p>
          </div>

          <!-- 💬 飞书同步 -->
          <div v-else-if="tab === 'feishu'" class="space-y-2">
            <!-- 🤖 自动接收（实时推送） -->
            <div class="rounded-2xl border border-white/10 bg-white/5 p-2.5">
              <div class="mb-1 flex items-center justify-between">
                <div class="text-[11px] font-semibold text-slate-200">🤖 自动接收（实时推送）</div>
                <button
                  v-if="lark.auth.loggedIn"
                  class="rounded-full px-2.5 py-0.5 text-[10px] font-medium transition disabled:opacity-40"
                  :class="lark.autoEnabled ? 'bg-emerald-400/85 text-slate-900 hover:bg-emerald-300' : 'bg-white/10 text-slate-300 hover:bg-white/20'"
                  :disabled="lark.busy"
                  @click="lark.setAutoEnabled(!lark.autoEnabled)"
                >
                  {{ lark.autoEnabled ? '● 已开启' : '○ 已关闭' }}
                </button>
              </div>

              <!-- 未创建应用 -->
              <div v-if="!lark.auth.configured" class="space-y-1.5">
                <p class="text-[10px] leading-relaxed text-slate-400">
                  首次使用需创建飞书应用并授权（浏览器扫码或打开链接完成，仅需一次）。授权后新消息与新妙记将自动推送、提炼并写入任务喵。
                </p>
                <button
                  class="w-full rounded-full bg-sky-400/85 py-1.5 text-[11px] font-medium text-slate-900 transition hover:bg-sky-300 disabled:opacity-50"
                  :disabled="configStarting"
                  @click="startConfigInit"
                >
                  {{ configStarting ? '⏳ 正在创建…' : '🛠 创建/绑定飞书应用' }}
                </button>
                <div v-if="configUrl" class="rounded-xl bg-black/30 p-2">
                  <div class="text-[10px] text-slate-400">🔗 请用浏览器打开：</div>
                  <div class="mt-0.5 select-all break-all text-[10px] leading-relaxed text-sky-300">{{ configUrl }}</div>
                </div>
                <button
                  class="w-full rounded-full bg-white/10 py-1.5 text-[11px] text-slate-200 transition hover:bg-white/20"
                  @click="() => { void lark.refreshAuth(); configUrl = '' }"
                >
                  ✓ 我已完成，重新检测
                </button>
              </div>

              <!-- 已建应用未登录 -->
              <div v-else-if="!lark.auth.loggedIn" class="space-y-1.5">
                <p class="text-[10px] leading-relaxed text-slate-400">应用已创建，还需登录授权（消息 / 妙记 / 事件域）。</p>
                <button
                  class="w-full rounded-full bg-sky-400/85 py-1.5 text-[11px] font-medium text-slate-900 transition hover:bg-sky-300 disabled:opacity-50"
                  :disabled="loginPolling"
                  @click="startLogin"
                >
                  {{ loginPolling ? '⏳ 等待授权中…' : '🔐 登录授权' }}
                </button>
                <div v-if="loginUrl" class="rounded-xl bg-black/30 p-2">
                  <div class="text-[10px] text-slate-400">🔗 请在浏览器完成授权（完成后自动收尾）：</div>
                  <div class="mt-0.5 select-all break-all text-[10px] leading-relaxed text-sky-300">{{ loginUrl }}</div>
                </div>
              </div>

              <!-- 已授权 -->
              <div v-else class="space-y-1">
                <p class="text-[10px] text-emerald-200/90">
                  ✅ 已授权{{ lark.auth.userName ? '：' + lark.auth.userName : '' }}
                  <span v-if="lark.auth.scopes?.length" class="text-slate-500">（{{ lark.auth.scopes.length }} 个权限）</span>
                </p>
                <p class="text-[10px] leading-relaxed text-slate-400">
                  开启后：新群消息与新的会议妙记 → 自动提炼任务 → 写入任务喵（可关，重启后保持记忆）。
                </p>
                <button
                  class="w-full rounded-full border border-sky-400/40 py-1 text-[10px] text-sky-300 transition hover:bg-sky-400/10 disabled:opacity-50"
                  :disabled="loginPolling"
                  @click="startLogin"
                >
                  {{ loginPolling ? '⏳ 等待授权中…' : '🔄 补充授权（新增权限时）' }}
                </button>
                <div v-if="loginUrl" class="rounded-xl bg-black/30 p-2">
                  <div class="text-[10px] text-slate-400">🔗 请在浏览器完成授权（完成后自动收尾）：</div>
                  <div class="mt-0.5 select-all break-all text-[10px] leading-relaxed text-sky-300">{{ loginUrl }}</div>
                </div>
              </div>

              <!-- 订阅会话状态 -->
              <div v-if="lark.sessions.length" class="mt-1.5 space-y-0.5">
                <div v-for="s in lark.sessions" :key="s.key" class="flex items-center gap-1.5 text-[10px]">
                  <span
                    class="inline-block h-1.5 w-1.5 rounded-full"
                    :class="{
                      'bg-emerald-400': s.phase === 'ready',
                      'bg-amber-400': s.phase === 'starting' || s.phase === 'reconnecting',
                      'bg-rose-400': s.phase === 'error' || s.phase === 'exited',
                    }"
                  />
                  <span class="text-slate-300">{{ s.key }}</span>
                  <span class="text-slate-500">
                    {{ s.phase === 'ready' ? '已连接' : s.phase === 'starting' ? '连接中…' : s.phase === 'reconnecting' ? '重连中…' : s.message ?? s.phase }}
                  </span>
                </div>
              </div>

              <!-- 最近处理日志 -->
              <div v-if="lark.recent.length" class="mt-1.5 space-y-0.5">
                <div v-for="(r, i) in lark.recent.slice(0, 5)" :key="r.ts + '-' + i" class="truncate text-[10px]" :class="{ 'text-slate-500': r.kind === 'info', 'text-emerald-300/80': r.kind === 'msg' || r.kind === 'minute', 'text-rose-300/80': r.kind === 'error' }">
                  {{ new Date(r.ts).toLocaleTimeString('zh-CN', { hour12: false }) }} {{ r.text }}
                </div>
              </div>
            </div>

            <!-- 手动同步（一次性拉取） -->
            <div class="rounded-2xl border border-white/10 bg-white/5 p-2.5">
              <div class="mb-1 text-[11px] font-semibold text-slate-200">飞书开放平台配置（手动同步用）</div>
              <div class="space-y-1.5">
                <input v-model="settings.feishu.feishuAppId" class="w-full" :class="inputCls" placeholder="App ID（开放平台创建应用）" @change="settings.saveFeishu()" />
                <input v-model="settings.feishu.feishuAppSecret" type="password" class="w-full" :class="inputCls" placeholder="App Secret" @change="settings.saveFeishu()" />
                <input v-model="settings.feishu.feishuChatId" class="w-full" :class="inputCls" placeholder="群聊 ID（oc_…，群设置里获取）" @change="settings.saveFeishu()" />
              </div>
            </div>
            <button
              class="w-full rounded-full bg-sky-400/85 py-2 text-[12px] font-medium text-slate-900 transition hover:bg-sky-300 disabled:opacity-50"
              :disabled="feishuBusy"
              @click="feishuSync"
            >
              {{ feishuBusy ? '⏳ 拉取并识别中…' : '🔄 拉取群消息并识别（一次性）' }}
            </button>
            <p class="text-[10px] leading-relaxed text-slate-400">
              读取最近 30 条文本消息 → 大模型提取任务（旧方式，需手动填写凭证）。
            </p>

            <!-- 📱 手机语音录入（替代小爱开放平台） -->
            <div class="rounded-2xl border border-white/10 bg-white/5 p-2.5">
              <div class="mb-1 text-[11px] font-semibold text-slate-200">
                📱 手机语音录入
                <span class="text-[10px] font-normal text-slate-500">本地端口 18765</span>
              </div>
              <p class="text-[10px] leading-relaxed text-slate-400">
                小爱开放平台暂停新开发者注册，已改用手机语音页：手机 Chrome/Edge 打开下方地址 →
                点🎤说话 → 识别后点「发送」→ 自动写入任务喵矩阵。
              </p>
              <div class="mt-1.5 select-all rounded-lg bg-slate-800/80 px-2 py-1 text-[11px] font-bold text-emerald-300">
                {{ voicePublicUrl || '未配置公网地址，请使用「语音」页的局域网地址' }}
              </div>
              <div class="mt-1 text-[9px] text-slate-500">
                公网地址需自行配置安全访问与隧道；显示地址不代表服务在线。
              </div>
            </div>
          </div>

          <!-- 🎤 语音输入 -->
          <div v-else-if="tab === 'voice'" class="space-y-2">
            <button
              class="w-full rounded-full bg-emerald-400/85 py-2 text-[12px] font-medium text-slate-900 transition hover:bg-emerald-300 disabled:opacity-50"
              :disabled="voiceStarting"
              @click="startVoice"
            >
              {{ voiceStarting ? '⏳ 启动中…' : voiceUrl ? '✅ 语音服务已启动' : '🚀 启动语音服务' }}
            </button>
            <div v-if="voiceUrl" class="rounded-2xl border border-emerald-400/30 bg-emerald-500/10 p-2.5">
              <div class="text-[11px] font-semibold text-emerald-200">手机访问地址</div>
              <div class="mt-1 select-all break-all text-[13px] font-bold text-emerald-100">{{ voiceUrl }}</div>
              <div class="mt-1 text-[10px] leading-relaxed text-emerald-200/80">
                手机连接同一 WiFi → 用 Chrome/Edge 打开上方地址 → 按住「🎤 说话」→ 点「发送到电脑」，任务自动弹出录入框。
              </div>
            </div>
            <p class="text-[10px] leading-relaxed text-slate-400">
              在电脑所在局域网内运行一个微型网页服务，手机语音转文字后一键发回电脑。
            </p>
          </div>

          <!-- ✍️ 手动输入 -->
          <div v-else-if="tab === 'manual'" class="space-y-2">
            <button
              class="w-full rounded-full bg-slate-400/85 py-2 text-[12px] font-medium text-slate-900 transition hover:bg-slate-300"
              @click="goManual"
            >
              ✍️ 打开手动录入弹窗
            </button>
            <p class="text-[10px] leading-relaxed text-slate-400">
              输入标题、选择象限与截止时间（支持 Ctrl+Shift+Space 快捷键）。
            </p>
          </div>

          <!-- 🔄 同步（手机端：配置服务器地址） -->
          <div v-else-if="tab === 'sync'" class="space-y-2">
            <!-- 登录状态 -->
            <div
              v-if="authInfo.token"
              class="rounded-xl border border-emerald-400/30 bg-emerald-500/10 p-2.5"
            >
              <div class="flex items-center justify-between">
                <div>
                  <span class="text-[10px] font-medium text-emerald-200">已登录</span>
                  <span class="ml-1.5 text-[11px] font-semibold text-emerald-100">{{ authInfo.phone }}</span>
                </div>
                <button
                  class="rounded-full border border-rose-400/40 px-2 py-0.5 text-[10px] text-rose-300 transition hover:bg-rose-500/10"
                  @click="
                    authLogout();
                    authInfo.token = null;
                    authInfo.phone = null;
                    toasts.add('info', '已退出登录');
                  "
                >
                  退出
                </button>
              </div>
            </div>
            <div v-else>
              <button
                class="w-full rounded-full bg-sky-400/85 py-1.5 text-[12px] font-medium text-slate-900 transition hover:bg-sky-300"
                @click="showLogin = true"
              >
                登录/注册账号（同步需要）
              </button>
            </div>

            <div class="rounded-2xl border border-white/10 bg-white/5 p-2.5">
              <div class="mb-1 text-[11px] font-semibold text-slate-200">
                🔄 同步服务器
                <span class="text-[10px] font-normal text-slate-500">登录后点「立即同步」拉取云端数据</span>
              </div>
              <input
                v-model="syncUrl"
                class="h-8 w-full rounded-xl border border-white/15 bg-white/8 px-2.5 text-[12px] text-slate-100 outline-none transition placeholder:text-slate-400 focus:border-sky-400/60"
                placeholder="https://sync.example.com"
                @change="syncSave"
              />
              <div class="mt-2 flex gap-2">
                <button
                  class="flex-1 rounded-full bg-sky-400/85 py-1.5 text-[12px] font-medium text-slate-900 transition hover:bg-sky-300 disabled:opacity-50"
                  :disabled="syncTesting"
                  @click="syncTest"
                >
                  {{ syncTesting ? '⏳ 测试中…' : '🧪 测试连接' }}
                </button>
                <button
                  class="flex-1 rounded-full bg-emerald-400/85 py-1.5 text-[12px] font-medium text-slate-900 transition hover:bg-emerald-300"
                  @click="syncNow"
                >
                  📥 立即同步
                </button>
              </div>
              <p v-if="syncMessage" class="mt-1.5 text-[10px] leading-relaxed text-slate-300">{{ syncMessage }}</p>
              <p class="mt-1.5 text-[9px] leading-relaxed text-slate-500">
                双向同步：登录账号后在任一端操作，另一端也会自动更新
              </p>
            </div>

            <LoginPanel
              v-if="showLogin"
              @login="showLogin = false; authInfo.token = getAuth().token; authInfo.phone = getAuth().phone"
              @close="showLogin = false"
            />
          </div>

          <!-- 识别结果（截图/飞书共用） -->
          <ExtractedTaskList v-if="extracted.length > 0" :tasks="extracted" @done="extracted = []" />
        </div>
      </div>
    </div>

    <!-- 截图全屏弹层（微信式：画面冻结在原位置 1:1，遮罩变暗 + 选区挖洞 + 尺寸标注 + 底部工具条） -->
    <div
      v-if="shotState !== 'idle'"
      class="fixed inset-0 z-[96] cursor-crosshair select-none overflow-hidden"
      data-app-ui
      @mousedown="onShotMouseDown"
      @mousemove="onShotMouseMove"
      @mouseup="onShotMouseUp"
    >
      <!-- 底图：窗口已由 Rust 铺满目标屏幕（物理尺寸=截图尺寸），1:1 全屏铺满即与原屏幕逐像素对齐 -->
      <img
        v-if="shotState === 'ready'"
        ref="shotImgRef"
        :src="'data:image/jpeg;base64,' + shotB64"
        class="pointer-events-none absolute inset-0 h-full w-full"
        draggable="false"
        @load="updateImgDisplayScale"
      />
      <!-- 画面未就绪：全屏暗色 + 加载提示（快捷键按下后立即进入截图模式的过渡态） -->
      <div v-else class="pointer-events-none absolute inset-0 flex items-center justify-center bg-slate-950/85">
        <div class="flex items-center gap-2 rounded-full bg-black/50 px-4 py-2 text-[12px] text-slate-200 backdrop-blur-md">
          <span class="inline-block h-3 w-3 animate-spin rounded-full border-2 border-sky-400 border-t-transparent" />
          正在截取画面…
        </div>
      </div>
      <!-- 选区：选区外变暗（box-shadow 挖洞）、选区内保持清晰，顶部实时尺寸标注 -->
      <div
        v-if="selection"
        class="pointer-events-none absolute border-2 border-sky-400"
        :style="{
          left: selection.x * imgDisplayScale.sx + 'px',
          top: selection.y * imgDisplayScale.sy + 'px',
          width: selection.w * imgDisplayScale.sx + 'px',
          height: selection.h * imgDisplayScale.sy + 'px',
          boxShadow: '0 0 0 99999px rgba(0, 0, 0, 0.55)',
        }"
      >
        <span
          class="absolute -top-7 left-0 rounded-md bg-sky-400 px-1.5 py-0.5 text-[11px] font-semibold tabular-nums text-slate-900"
        >
          {{ Math.round(selection.w * imgDisplayScale.sx) }} × {{ Math.round(selection.h * imgDisplayScale.sy) }}
        </span>
      </div>
      <!-- 未框选时：全屏变暗，画面保持可见 -->
      <div v-else class="pointer-events-none absolute inset-0 bg-black/55" />
      <!-- 顶部提示 -->
      <p v-if="!selection" class="pointer-events-none absolute top-6 left-1/2 -translate-x-1/2 rounded-full bg-black/40 px-3 py-1 text-[11px] text-slate-200">
        💡 拖动鼠标框选要识别的区域（Esc 取消）
      </p>
      <div v-if="analyzing" class="absolute top-6 left-1/2 -translate-x-1/2 text-[12px] text-sky-300">大模型正在提取任务，请稍候…</div>
      <!-- 底部工具条（stop 防止按钮 mousedown 冒泡触发容器拖拽重置选区；选区松开鼠标即自动识别） -->
      <div v-if="shotState === 'ready'" class="absolute bottom-6 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full bg-black/55 p-1.5 backdrop-blur-md" @mousedown.stop>
        <button
          class="rounded-full bg-sky-400/85 px-4 py-1.5 text-[12px] font-medium text-slate-900 transition hover:bg-sky-300 disabled:opacity-40"
          :disabled="analyzing"
          title="识别整屏"
          @click="analyzeB64(shotB64)"
        >
          识别整屏
        </button>
        <button
          class="rounded-full bg-white/10 px-5 py-1.5 text-[12px] text-slate-200 transition hover:bg-white/20"
          @click="cancelShot"
        >
          取消
        </button>
      </div>
    </div>
  </Teleport>
</template>
