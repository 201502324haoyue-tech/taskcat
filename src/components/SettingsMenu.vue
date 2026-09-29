<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { TASK_FONT_DEFAULT, TASK_FONT_MAX, TASK_FONT_MIN, useUiStore } from '@/stores/ui'
import { useSettingsStore } from '@/stores/settings'
import { useProfileStore } from '@/stores/profile'
import { useToastsStore } from '@/stores/toasts'
import { useTasksStore } from '@/stores/tasks'
import { getSyncBase, setSyncBase, testConnection } from '@/services/sync'
import { isTauri, tauriGlobal } from '@/utils/tauri'
import { isLoggedIn, getAuth } from '@/services/auth'
import LoginPanel from './LoginPanel.vue'

/**
 * 设置齿轮：透明度 / 任务字体 / 大模型配置（含 .env）/ 截止精度 / 自启动。
 * 弹窗 Teleport 到 body，不随面板淡出——低透明度下仍可操作。
 */
const ui = useUiStore()
const settings = useSettingsStore()
const profile = useProfileStore()
const toasts = useToastsStore()
const tasks = useTasksStore()
const { opacity } = storeToRefs(ui)
const pos = ref({ x: 0, y: 0 })
const autostart = ref(false)
const autostartBusy = ref(false)
const envPath = ref('')
const showLogin = ref(false)
const authInfo = getAuth()
watch(showLogin, (v) => { if (v) { authInfo.phone = getAuth().phone; authInfo.token = getAuth().token } })

/** 任务字体输入框草稿：输入实时预览（所见即所得），失焦/回车提交；store 变更（加减按钮）回写规范化值 */
const fontInput = ref(ui.taskFontSize)
watch(
  () => ui.taskFontSize,
  (v) => {
    fontInput.value = v
  }
)
/** 全角数字转半角（中文输入法易输入全角数字） */
function toHalfWidth(s: string): string {
  return s.replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0))
}
/** 输入即生效：实时预览 1-12 内的值，不写 store（避免 watch 回写打断输入） */
function previewFontInput(): void {
  const v = Number(toHalfWidth(String(fontInput.value ?? '').trim()))
  if (Number.isFinite(v) && v >= TASK_FONT_MIN && v <= TASK_FONT_MAX) {
    document.documentElement.style.setProperty('--task-font-size', `${v}px`)
  }
}
/** 失焦/回车提交：clamp + 持久化 */
function applyFontInput(): void {
  const v = Number(toHalfWidth(String(fontInput.value ?? '').trim()))
  ui.setTaskFontSize(Number.isFinite(v) ? v : TASK_FONT_DEFAULT)
}

const sliderPct = computed<number>({
  get: () => Math.round(opacity.value * 100),
  set: (v) => ui.setOpacity(v / 100),
})

const popWidth = 256

/** 大模型配置草稿：编辑后点「确认保存」才写入 */
const llmDraft = ref({ llmBaseUrl: '', llmApiKey: '', llmModel: '' })

function refreshLlmDraft(): void {
  llmDraft.value = {
    llmBaseUrl: settings.cfg.llmBaseUrl,
    llmApiKey: settings.cfg.llmApiKey,
    llmModel: settings.cfg.llmModel,
  }
}

function confirmLlm(): void {
  settings.setLlmField('llmBaseUrl', llmDraft.value.llmBaseUrl)
  settings.setLlmField('llmApiKey', llmDraft.value.llmApiKey)
  settings.setLlmField('llmModel', llmDraft.value.llmModel)
  toasts.add('success', '大模型配置已保存')
}

/** 打开画像弹窗前先关设置，避免 z 层级遮挡 */
function openProfileModal(): void {
  ui.settingsOpen = false
  ui.profileModalOpen = true
}

function openOnboarding(): void {
  ui.settingsOpen = false
  ui.onboardingOpen = true
}

/** 计算弹窗位置并切换开关 */
function toggle(): void {
  const btn = document.querySelector<HTMLElement>('button[title^="设置（"]')
  if (btn) {
    const rect = btn.getBoundingClientRect()
    // 保证弹窗完整落在窗口内
    pos.value = {
      x: Math.max(8, Math.min(rect.right - popWidth, window.innerWidth - popWidth - 8)),
      y: Math.min(rect.bottom + 6, window.innerHeight - 220),
    }
  }
  ui.settingsOpen = !ui.settingsOpen
  if (ui.settingsOpen) {
    void loadAutostart()
    refreshLlmDraft()
    cloudUrl.value = getSyncBase()
    cloudMessage.value = ''
    authInfo.phone = getAuth().phone
    authInfo.token = getAuth().token
  }
}

/** 打开时读取当前自启动状态 + .env 路径（仅 Tauri 下可用） */
async function loadAutostart(): Promise<void> {
  const g = tauriGlobal()
  if (!g) return
  try {
    autostart.value = (await g.core.invoke('get_autostart')) as boolean
    envPath.value = (await g.core.invoke('get_env_path')) as string
  } catch {
    autostart.value = false
  }
}

async function toggleAutostart(): Promise<void> {
  const g = tauriGlobal()
  if (!g || autostartBusy.value) return
  autostartBusy.value = true
  try {
    const next = (await g.core.invoke('set_autostart', { enabled: !autostart.value })) as boolean
    autostart.value = next
  } catch {
    // 保持原状态
  } finally {
    autostartBusy.value = false
  }
}

async function reloadEnv(): Promise<void> {
  await settings.reloadEnv()
  refreshLlmDraft() // 重载后草稿同步为新的生效值
  toasts.add(settings.hasEnv ? 'success' : 'info', settings.hasEnv ? '已从 .env 加载大模型配置' : '.env 未提供大模型配置')
}

const envInputCls =
  'h-7 min-w-0 w-full rounded-lg border border-white/10 bg-white/5 px-2 text-[11px] text-slate-100 outline-none transition placeholder:text-slate-500 focus:border-sky-400/50'

/** 云端同步：地址草稿 / 测试 / 立即同步 */
const cloudUrl = ref(getSyncBase())
const cloudBusy = ref(false)
const cloudMessage = ref('')
const cloudOk = ref(false)

async function cloudTest(): Promise<void> {
  if (cloudBusy.value) return
  cloudBusy.value = true
  cloudMessage.value = ''
  try {
    const r = await testConnection()
    cloudOk.value = r.ok
    cloudMessage.value = r.message
    toasts.add(r.ok ? 'success' : 'warn', r.message)
  } finally {
    cloudBusy.value = false
  }
}

function cloudSave(): void {
  setSyncBase(cloudUrl.value)
  cloudMessage.value = ''
  toasts.add('success', '服务器地址已保存')
}

async function cloudSyncNow(): Promise<void> {
  if (cloudBusy.value) return
  cloudBusy.value = true
  cloudMessage.value = ''
  try {
    const r = await tasks.syncNow()
    cloudOk.value = r.ok
    cloudMessage.value = r.message
    toasts.add(r.ok ? 'success' : 'warn', r.message)
  } finally {
    cloudBusy.value = false
  }
}
</script>

<template>
  <div class="relative" data-no-drag>
    <button
      class="flex h-6 w-6 items-center justify-center rounded-full text-[13px] text-slate-200 transition hover:bg-white/15 hover:text-white"
      title="设置（面板透明度）"
      @click="toggle"
    >
      ⚙️
    </button>

    <Teleport to="body">
      <template v-if="ui.settingsOpen">
        <!-- 点击空白关闭 -->
        <div class="fixed inset-0 z-[98]" data-app-ui @pointerdown="ui.settingsOpen = false" />
        <div
          class="animate-pop-in fixed z-[99] max-h-[85vh] w-64 overflow-y-auto rounded-2xl border border-white/15 bg-slate-900/85 p-3 text-slate-100 shadow-2xl backdrop-blur-xl thin-scroll"
          :style="{ left: pos.x + 'px', top: pos.y + 'px' }"
          @pointerdown.stop
        >
          <div class="mb-2 flex items-center justify-between text-[12px] font-semibold">
            <span>面板透明度</span>
            <span class="rounded-full bg-white/10 px-2 py-0.5 text-[11px] tabular-nums">{{ sliderPct }}%</span>
          </div>
          <input
            v-model.number="sliderPct"
            type="range"
            min="15"
            max="95"
            step="5"
            class="w-full accent-sky-400"
          />
          <div class="mt-0.5 flex justify-between text-[10px] text-slate-400">
            <span>透</span>
            <span>实</span>
          </div>

          <!-- 大模型配置（URL / Key / 模型 + .env） -->
          <div class="mt-3 border-t border-white/10 pt-2.5">
            <div class="mb-1.5 flex items-center justify-between">
              <span class="text-[12px] font-semibold">大模型配置</span>
              <span
                v-if="settings.hasEnv"
                class="rounded-full bg-emerald-400/15 px-1.5 py-0.5 text-[9px] text-emerald-300"
                title="字段留空时使用 .env 的值"
              >
                .env 生效
              </span>
            </div>
            <div class="space-y-2">
              <label class="block">
                <span class="mb-1 block text-[10px] font-medium text-slate-400">接口地址</span>
                <input
                  v-model="llmDraft.llmBaseUrl"
                  class="w-full"
                  :class="envInputCls"
                  placeholder="https://api.deepseek.com/v1 或 https://api.anthropic.com"
                />
              </label>
              <label class="block">
                <span class="mb-1 block text-[10px] font-medium text-slate-400">API Key</span>
                <input
                  v-model="llmDraft.llmApiKey"
                  type="password"
                  class="w-full"
                  :class="envInputCls"
                  placeholder="sk-…"
                />
              </label>
              <label class="block">
                <span class="mb-1 block text-[10px] font-medium text-slate-400">模型名称</span>
                <input
                  v-model="llmDraft.llmModel"
                  class="w-full"
                  :class="envInputCls"
                  placeholder="deepseek-chat / claude-sonnet-4-5"
                />
              </label>
              <p class="text-[10px] leading-relaxed text-slate-400">
                支持 OpenAI 兼容与 Anthropic（Claude），URL 自动识别格式。字段留空则回退 .env 值。
              </p>
              <div v-if="isTauri()" class="flex items-center gap-1.5">
                <span class="min-w-0 flex-1 truncate rounded-lg bg-white/5 px-1.5 py-1 text-[9px] text-slate-400" :title="envPath">
                  📄 {{ envPath }}
                </span>
                <button
                  class="shrink-0 rounded-full border border-white/10 px-2 py-1 text-[10px] text-slate-300 transition hover:bg-white/10"
                  title="打开 .env（不存在则生成模板）"
                  @click="settings.openEnvFile()"
                >
                  编辑
                </button>
                <button
                  class="shrink-0 rounded-full border border-white/10 px-2 py-1 text-[10px] text-slate-300 transition hover:bg-white/10"
                  title="重新加载 .env"
                  @click="reloadEnv"
                >
                  重载
                </button>
              </div>
              <!-- 确认保存：把草稿写入配置 -->
              <button
                class="w-full rounded-full bg-emerald-400/80 py-1.5 text-[11px] font-medium text-slate-900 transition hover:bg-emerald-300"
                @click="confirmLlm"
              >
                ✓ 确认保存
              </button>
            </div>
          </div>

          <!-- 开机自启动 -->
          <div v-if="isTauri()" class="mt-3 flex items-center justify-between border-t border-white/10 pt-2.5">
            <div>
              <div class="text-[12px] font-semibold">开机自启动</div>
              <div class="text-[10px] text-slate-400">登录 Windows 后自动启动</div>
            </div>
            <button
              class="relative h-5 w-9 rounded-full transition"
              :class="autostart ? 'bg-emerald-400/80' : 'bg-white/15'"
              :disabled="autostartBusy"
              title="开机自启动"
              @click="toggleAutostart"
            >
              <span
                class="absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all"
                :class="autostart ? 'left-[18px]' : 'left-0.5'"
              />
            </button>
          </div>

          <!-- 任务字体大小 -->
          <div class="mt-3 border-t border-white/10 pt-2.5">
            <div class="mb-1.5 flex items-center justify-between">
              <div class="text-[12px] font-semibold">任务字体大小</div>
              <div class="text-[10px] text-slate-400">1-12 px</div>
            </div>
            <div class="flex items-center gap-1 rounded-full border border-white/10 bg-white/5 px-1 py-1">
              <button
                class="flex h-5 w-5 items-center justify-center rounded-full text-[13px] text-slate-300 transition hover:bg-white/10 hover:text-white"
                @click="ui.setTaskFontSize(ui.taskFontSize - 1)"
              >
                −
              </button>
              <input
                v-model.number="fontInput"
                type="number"
                min="1"
                max="12"
                class="w-9 bg-transparent text-center text-[12px] text-white outline-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                @focus="($event.target as HTMLInputElement).select()"
                @input="previewFontInput"
                @change="applyFontInput"
                @blur="applyFontInput"
                @keyup.enter="applyFontInput"
              />
              <button
                class="flex h-5 w-5 items-center justify-center rounded-full text-[13px] text-slate-300 transition hover:bg-white/10 hover:text-white"
                @click="ui.setTaskFontSize(ui.taskFontSize + 1)"
              >
                ＋
              </button>
            </div>
          </div>

          <!-- 截止时间精确度 -->
          <div class="mt-3 flex items-center justify-between border-t border-white/10 pt-2.5">
            <div>
              <div class="text-[12px] font-semibold">截止时间精确到分</div>
              <div class="text-[10px] text-slate-400">关闭时只选日期（当天截止）</div>
            </div>
            <button
              class="relative h-5 w-9 rounded-full transition"
              :class="ui.duePrecisionMinute ? 'bg-sky-400/80' : 'bg-white/15'"
              title="截止时间精确到分"
              @click="ui.setDuePrecisionMinute(!ui.duePrecisionMinute)"
            >
              <span
                class="absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all"
                :class="ui.duePrecisionMinute ? 'left-[18px]' : 'left-0.5'"
              />
            </button>
          </div>

          <!-- 截图识别模式 -->
          <div class="mt-3 border-t border-white/10 pt-2.5">
            <div class="mb-1.5 text-[12px] font-semibold">截图识别模式</div>
            <div class="flex rounded-full border border-white/10 bg-white/5 p-0.5">
              <button
                v-for="opt in [
                  { v: 'single', label: '单一事件' },
                  { v: 'multiple', label: '多条事件' },
                ]"
                :key="opt.v"
                class="flex-1 rounded-full py-1 text-[11px] transition"
                :class="
                  settings.extractMode === opt.v
                    ? 'bg-sky-400/80 font-medium text-slate-900'
                    : 'text-slate-300 hover:text-white'
                "
                @click="settings.setExtractMode(opt.v)"
              >
                {{ opt.label }}
              </button>
            </div>
          </div>

          <!-- 用户画像 -->
          <div class="mt-3 border-t border-white/10 pt-2.5">
            <div class="mb-1.5 flex items-center justify-between">
              <div class="text-[12px] font-semibold">用户画像</div>
              <span
                class="rounded-full px-1.5 py-0.5 text-[9px]"
                :class="profile.hasProfile ? 'bg-emerald-400/15 text-emerald-300' : 'bg-amber-400/15 text-amber-300'"
              >
                {{ profile.hasProfile ? '已生成' : '未生成' }}
              </span>
            </div>
            <p class="mb-1.5 text-[10px] leading-relaxed text-slate-400">
              AI 根据问卷与拖拽习惯自动维护，用于新任务智能归类。
            </p>
            <div class="flex gap-1.5">
              <button
                class="flex-1 rounded-full border border-white/10 py-1 text-[11px] text-slate-300 transition hover:bg-white/10"
                @click="openProfileModal"
              >
                查看编辑
              </button>
              <button
                v-if="!profile.hasProfile"
                class="flex-1 rounded-full bg-sky-400/80 py-1 text-[11px] font-medium text-slate-900 transition hover:bg-sky-300"
                @click="openOnboarding"
              >
                去生成
              </button>
            </div>
          </div>

          <!-- 账号与同步（电脑端配置；手机端在 App 同步页填同一地址） -->
          <div v-if="isTauri()" class="mt-3 border-t border-white/10 pt-2.5">
            <div class="mb-1.5 flex items-center justify-between">
              <span class="text-[12px] font-semibold">账号与同步</span>
              <span
                v-if="authInfo.token"
                class="rounded-full bg-emerald-400/15 px-1.5 py-0.5 text-[9px] text-emerald-300"
              >
                {{ authInfo.phone }}
              </span>
            </div>

            <!-- 登录/退出 -->
            <div v-if="!authInfo.token" class="mb-2">
              <button
                class="w-full rounded-full bg-sky-400/80 py-1.5 text-[11px] font-medium text-slate-900 transition hover:bg-sky-300"
                @click="showLogin = true"
              >
                登录/注册账号
              </button>
            </div>

            <!-- 服务器地址 -->
            <p class="mb-1.5 text-[10px] leading-relaxed text-slate-400">
              登录后手机端和电脑端自动使用同一账号的数据双向同步。也可自建服务器修改下方地址。
            </p>
            <input
              v-model="cloudUrl"
              class="w-full"
              :class="envInputCls"
              placeholder="https://sync.example.com"
              @keyup.enter="cloudSave"
            />
            <div class="mt-2 flex gap-1.5">
              <button
                class="flex-1 rounded-full border border-white/10 py-1 text-[11px] text-slate-300 transition hover:bg-white/10 disabled:opacity-40"
                :disabled="cloudBusy"
                @click="cloudTest"
              >
                🧪 测试
              </button>
              <button
                class="flex-1 rounded-full border border-white/10 py-1 text-[11px] text-slate-300 transition hover:bg-white/10 disabled:opacity-40"
                :disabled="cloudBusy"
                @click="cloudSave"
              >
                💾 保存
              </button>
              <button
                class="flex-1 rounded-full bg-sky-400/80 py-1 text-[11px] font-medium text-slate-900 transition hover:bg-sky-300 disabled:opacity-40"
                :disabled="cloudBusy"
                @click="cloudSyncNow"
              >
                {{ cloudBusy ? '…' : '🔄 立即同步' }}
              </button>
            </div>
            <p
              v-if="cloudMessage"
              class="mt-1 text-[10px]"
              :class="cloudOk ? 'text-emerald-300' : 'text-amber-300'"
            >
              {{ cloudMessage }}
            </p>
          </div>

          <LoginPanel
            v-if="showLogin"
            @login="showLogin = false; authInfo.phone = getAuth().phone; authInfo.token = getAuth().token"
            @close="showLogin = false"
          />

          <div class="mt-2 flex justify-end gap-2">
            <button
              class="rounded-full border border-white/10 px-3 py-1 text-[11px] text-slate-300 transition hover:bg-white/10"
              @click="ui.resetOpacity()"
            >
              恢复默认
            </button>
            <button
              class="rounded-full bg-sky-400/90 px-3 py-1 text-[11px] font-medium text-slate-900 transition hover:bg-sky-300"
              @click="ui.settingsOpen = false"
            >
              完成
            </button>
          </div>
        </div>
      </template>
    </Teleport>
  </div>
</template>
