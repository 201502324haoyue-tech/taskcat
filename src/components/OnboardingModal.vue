<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useUiStore } from '@/stores/ui'
import { useSettingsStore } from '@/stores/settings'
import { useProfileStore } from '@/stores/profile'

/**
 * 首次使用问卷：回答 3 个问题 → AI 生成用户画像（user.md），
 * 让后续截图/语音录入的任务分类贴合用户真实偏好。
 */
const ui = useUiStore()
const settings = useSettingsStore()
const profile = useProfileStore()
const { onboardingOpen } = storeToRefs(ui)

const role = ref('')
const domain = ref('')
const priority = ref('')
const formRef = ref<HTMLElement | null>(null)

const llmReady = computed(() => settings.cfg.llmBaseUrl.trim() !== '' && settings.cfg.llmModel.trim() !== '')
const canSubmit = computed(
  () => llmReady.value && !profile.busy && (role.value.trim() || domain.value.trim() || priority.value.trim()),
)

watch(onboardingOpen, async (open) => {
  if (open) {
    await nextTick()
    formRef.value?.querySelector<HTMLInputElement>('input')?.focus()
  }
})

function close(): void {
  if (profile.busy) return
  ui.onboardingOpen = false
}

async function submit(): Promise<void> {
  if (!canSubmit.value) return
  const ok = await profile.generateFromAnswers({
    role: role.value.trim(),
    domain: domain.value.trim(),
    priority: priority.value.trim(),
  })
  if (ok) ui.onboardingOpen = false
}

/** 跳去设置里配置大模型（当前弹窗保持打开） */
function goSettings(): void {
  ui.settingsOpen = true
}
</script>

<template>
  <Teleport to="body">
    <div v-if="onboardingOpen" class="fixed inset-0 z-[95] flex items-center justify-center" data-app-ui>
      <div class="absolute inset-0 bg-black/30 backdrop-blur-[2px]" @click="close" />
      <div
        ref="formRef"
        class="animate-pop-in glass-panel relative w-[380px] p-4"
        @keydown.esc.prevent="close"
      >
        <div class="mb-1 text-[14px] font-semibold text-slate-100">👋 认识一下，让任务分类更懂你</div>
        <p class="mb-3 text-[11px] leading-relaxed text-slate-400">
          回答几个小问题，AI 将为你生成用户画像，之后截图/语音识别的新任务会按照你的习惯自动归类到合适的象限，并在使用中不断学习调整。
        </p>

        <div class="space-y-2.5">
          <label class="block">
            <span class="mb-1 block text-[11px] font-medium text-slate-400">你的工作角色</span>
            <input
              v-model="role"
              class="h-8 w-full rounded-lg border border-white/10 bg-white/5 px-2.5 text-[12px] text-slate-100 outline-none transition placeholder:text-slate-500 focus:border-sky-400/50"
              placeholder="如：销售、产品、研发、管理者…"
              maxlength="40"
            />
          </label>
          <label class="block">
            <span class="mb-1 block text-[11px] font-medium text-slate-400">核心工作领域</span>
            <input
              v-model="domain"
              class="h-8 w-full rounded-lg border border-white/10 bg-white/5 px-2.5 text-[12px] text-slate-100 outline-none transition placeholder:text-slate-500 focus:border-sky-400/50"
              placeholder="如：客户跟进、项目周报、提奖申请…"
              maxlength="80"
            />
          </label>
          <label class="block">
            <span class="mb-1 block text-[11px] font-medium text-slate-400">哪类事对你最重要 / 最紧急</span>
            <input
              v-model="priority"
              class="h-8 w-full rounded-lg border border-white/10 bg-white/5 px-2.5 text-[12px] text-slate-100 outline-none transition placeholder:text-slate-500 focus:border-sky-400/50"
              placeholder="如：客户付款、领导交办、业绩目标…"
              maxlength="80"
            />
          </label>
        </div>

        <div v-if="!llmReady" class="mt-3 rounded-lg border border-amber-400/30 bg-amber-400/10 px-2.5 py-2 text-[11px] leading-relaxed text-amber-200">
          尚未配置大模型，无法生成画像。
          <button class="ml-1 font-medium underline underline-offset-2 hover:text-amber-100" @click="goSettings">
            去设置
          </button>
        </div>

        <div class="mt-3.5 flex justify-end gap-2">
          <button
            class="rounded-lg border border-white/10 px-3.5 py-1.5 text-[12px] text-slate-300 transition hover:bg-white/5"
            @click="close"
          >
            跳过
          </button>
          <button
            class="rounded-lg bg-sky-400/90 px-3.5 py-1.5 text-[12px] font-medium text-slate-900 transition hover:bg-sky-300 disabled:opacity-40"
            :disabled="!canSubmit"
            @click="submit"
          >
            {{ profile.busy ? 'AI 生成中…' : '生成画像' }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
