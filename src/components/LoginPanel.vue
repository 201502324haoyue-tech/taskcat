<script setup lang="ts">
import { ref } from 'vue'
import { useToastsStore } from '@/stores/toasts'
import { useTasksStore } from '@/stores/tasks'
import { getAuth, isLoggedIn, login as authLogin, register as authRegister, logout as authLogout } from '@/services/auth'

const emit = defineEmits<{
  login: []
  logout: []
  close: []
}>()
const toasts = useToastsStore()

const mode = ref<'login' | 'register'>('login')
const phone = ref('')
const password = ref('')
const busy = ref(false)
const showPwd = ref(false)
const auth = getAuth()

// 已登录子页面
const subPage = ref<'changePwd' | 'deactivate' | null>(null)
const oldPassword = ref('')
const newPassword = ref('')
const changePwdBusy = ref(false)

function reset(): void {
  phone.value = ''
  password.value = ''
  busy.value = false
  showPwd.value = false
}

/** 登录成功后自动双向同步（拉云端→合并→推回云端，失败不打断） */
async function autoSync(): Promise<void> {
  const r = await useTasksStore().syncNow()
  if (r.ok) {
    if (r.message.includes('0 条任务')) return
    toasts.add('success', r.message)
  } else {
    toasts.add('warn', `${r.message}，可稍后在设置中手动同步`)
  }
}

async function submit(): Promise<void> {
  const p = phone.value.trim()
  const pw = password.value.trim()
  if (!p || p.length < 8) {
    toasts.add('warn', '请输入正确的手机号')
    return
  }
  if (!pw || pw.length < 4) {
    toasts.add('warn', '密码至少 4 位')
    return
  }
  busy.value = true
  try {
    if (mode.value === 'login') {
      await authLogin(p, pw)
      toasts.add('success', `登录成功（${p}）`)
    } else {
      await authRegister(p, pw)
      toasts.add('success', `注册成功（${p}）`)
    }
    emit('login')
    void autoSync()
  } catch (e) {
    toasts.add('error', e instanceof Error ? e.message : String(e))
  } finally {
    busy.value = false
  }
}

async function doLogout(): Promise<void> {
  authLogout()
  toasts.add('info', '已退出登录')
  emit('logout')
}

/** 修改密码 */
async function doChangePassword(): Promise<void> {
  const oldPw = oldPassword.value.trim()
  const newPw = newPassword.value.trim()
  if (!oldPw) {
    toasts.add('warn', '请输入当前密码')
    return
  }
  if (!newPw || newPw.length < 4) {
    toasts.add('warn', '新密码至少 4 位')
    return
  }
  if (newPw === oldPw) {
    toasts.add('warn', '新密码与旧密码相同')
    return
  }
  changePwdBusy.value = true
  try {
    const { changePassword } = await import('@/services/auth')
    await changePassword(oldPw, newPw)
    toasts.add('success', '密码修改成功')
    oldPassword.value = ''
    newPassword.value = ''
    subPage.value = null
  } catch (e) {
    toasts.add('error', e instanceof Error ? e.message : String(e))
  } finally {
    changePwdBusy.value = false
  }
}

/** 注销账号 */
async function doDeactivate(): Promise<void> {
  changePwdBusy.value = true
  try {
    const { deactivateAccount } = await import('@/services/auth')
    await deactivateAccount()
    authLogout()
    toasts.add('info', '账号已注销')
    emit('logout')
  } catch (e) {
    toasts.add('error', e instanceof Error ? e.message : String(e))
  } finally {
    changePwdBusy.value = false
  }
}

function switchMode(): void {
  mode.value = mode.value === 'login' ? 'register' : 'login'
  reset()
}

const inputCls =
  'h-9 w-full rounded-xl border border-white/15 bg-white/8 px-3 text-[13px] text-slate-100 outline-none transition placeholder:text-slate-400 focus:border-sky-400/60'
</script>

<template>
  <Teleport to="body">
    <div class="fixed inset-0 z-[98]" data-app-ui @pointerdown="emit('close')" />
    <div
      class="animate-pop-in fixed z-[99] flex max-h-[85vh] w-72 flex-col rounded-2xl border border-white/15 bg-slate-900/85 p-4 text-slate-100 shadow-2xl backdrop-blur-xl"
      style="left: 50%; top: 50%; transform: translate(-50%, -50%)"
      @pointerdown.stop
    >
      <!-- 标题 -->
      <div class="mb-3 flex items-center justify-between">
        <span class="text-[13px] font-semibold">
          {{ auth.token ? '账号设置' : mode === 'login' ? '登录' : '注册' }}
        </span>
        <button
          class="flex h-6 w-6 items-center justify-center rounded-full text-slate-400 transition hover:bg-white/10 hover:text-white"
          title="关闭"
          @click="emit('close')"
        >
          ✕
        </button>
      </div>

      <!-- 已登录：账号设置-->
      <div v-if="auth.token" class="space-y-3">
        <!-- 主视图 -->
        <template v-if="!subPage">
          <div class="rounded-xl border border-emerald-400/30 bg-emerald-500/10 p-3">
            <div class="text-[11px] font-medium text-emerald-200">已登录</div>
            <div class="mt-1 text-[13px] font-semibold text-emerald-100">{{ auth.phone }}</div>
          </div>
          <p class="text-[10px] leading-relaxed text-slate-400">
            登录后手机端和电脑端将共用同一账号的数据，自动双向同步。
          </p>
          <div class="flex gap-2">
            <button
              class="flex-1 rounded-full border border-sky-400/40 py-1.5 text-[12px] text-sky-300 transition hover:bg-sky-500/10"
              @click="subPage = 'changePwd'"
            >
              修改密码
            </button>
            <button
              class="flex-1 rounded-full bg-sky-400/80 py-1.5 text-[12px] font-medium text-slate-900 transition hover:bg-sky-300"
              @click="emit('close')"
            >
              完成
            </button>
          </div>
          <div class="flex gap-2">
            <button
              class="flex-1 rounded-full border border-slate-500/40 py-1.5 text-[12px] text-slate-400 transition hover:bg-slate-500/10"
              @click="doLogout"
            >
              退出登录
            </button>
            <button
              class="flex-1 rounded-full border border-rose-400/40 py-1.5 text-[12px] text-rose-300 transition hover:bg-rose-500/10"
              @click="subPage = 'deactivate'"
            >
              注销账号
            </button>
          </div>
        </template>

        <!-- 修改密码子页 -->
        <template v-else-if="subPage === 'changePwd'">
          <div class="mb-1 flex items-center justify-between">
            <span class="text-[12px] font-semibold">修改密码</span>
            <button class="text-[11px] text-sky-300 underline transition hover:text-sky-200" @click="subPage = null; oldPassword = ''; newPassword = ''">
              ← 返回
            </button>
          </div>
          <div>
            <label class="mb-1 block text-[10px] font-medium text-slate-400">当前密码</label>
            <input v-model="oldPassword" type="password" class="w-full" :class="inputCls" placeholder="输入当前密码" maxlength="64" @keyup.enter="doChangePassword" />
          </div>
          <div>
            <label class="mb-1 block text-[10px] font-medium text-slate-400">新密码</label>
            <input v-model="newPassword" type="password" class="w-full" :class="inputCls" placeholder="至少 4 位" maxlength="64" @keyup.enter="doChangePassword" />
          </div>
          <button
            class="w-full rounded-full bg-sky-400/80 py-2 text-[12px] font-medium text-slate-900 transition hover:bg-sky-300 disabled:opacity-50"
            :disabled="changePwdBusy"
            @click="doChangePassword"
          >
            {{ changePwdBusy ? '修改中…' : '确认修改' }}
          </button>
        </template>

        <!-- 注销账号确认子页 -->
        <template v-else-if="subPage === 'deactivate'">
          <div class="mb-1 flex items-center justify-between">
            <span class="text-[12px] font-semibold text-rose-300">注销账号</span>
            <button class="text-[11px] text-sky-300 underline transition hover:text-sky-200" @click="subPage = null">
              ← 返回
            </button>
          </div>
          <div class="rounded-xl border border-rose-400/30 bg-rose-500/10 p-3 text-[11px] leading-relaxed text-rose-200">
            注销后该账号及云端所有任务数据将被永久删除，此操作不可恢复。如需继续使用需重新注册。
          </div>
          <div class="flex gap-2">
            <button
              class="flex-1 rounded-full border border-slate-500/40 py-1.5 text-[12px] text-slate-400 transition hover:bg-slate-500/10"
              @click="subPage = null"
            >
              取消
            </button>
            <button
              class="flex-1 rounded-full border border-rose-400/40 py-1.5 text-[12px] text-rose-300 transition hover:bg-rose-500/10 disabled:opacity-50"
              :disabled="changePwdBusy"
              @click="doDeactivate"
            >
              {{ changePwdBusy ? '注销中…' : '确认注销' }}
            </button>
          </div>
        </template>
      </div>

      <!-- 未登录：输入表单 -->
      <div v-else class="space-y-3">
        <div>
          <label class="mb-1 block text-[10px] font-medium text-slate-400">手机号</label>
          <input
            v-model="phone"
            type="tel"
            class="w-full"
            :class="inputCls"
            placeholder="11 位手机号"
            maxlength="20"
            autocomplete="tel"
            @keyup.enter="submit"
          />
        </div>
        <div>
          <label class="mb-1 block text-[10px] font-medium text-slate-400">密码</label>
          <div class="relative">
            <input
              v-model="password"
              :type="showPwd ? 'text' : 'password'"
              class="w-full pr-8"
              :class="inputCls"
              placeholder="至少 4 位"
              autocomplete="current-password"
              @keyup.enter="submit"
            />
            <button
              class="absolute right-2 top-1/2 -translate-y-1/2 text-[11px] text-slate-400 hover:text-slate-200"
              @click="showPwd = !showPwd"
            >
              {{ showPwd ? '🙈' : '👁' }}
            </button>
          </div>
        </div>

        <button
          class="w-full rounded-full bg-sky-400/80 py-2 text-[12px] font-medium text-slate-900 transition hover:bg-sky-300 disabled:opacity-50"
          :disabled="busy"
          @click="submit"
        >
          {{ busy ? '处理中…' : mode === 'login' ? '登录' : '注册' }}
        </button>

        <p class="text-center text-[10px] text-slate-400">
          <button class="text-sky-300 underline transition hover:text-sky-200" @click="switchMode">
            {{ mode === 'login' ? '没有账号？去注册' : '已有账号？去登录' }}
          </button>
        </p>

        <p class="text-[9px] leading-relaxed text-slate-500">
          注册即表示同意使用条款。手机号仅用于账号标识，不会泄露给第三方。
        </p>
      </div>
    </div>
  </Teleport>
</template>