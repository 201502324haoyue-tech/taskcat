<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useUiStore } from '@/stores/ui'
import { useProfileStore } from '@/stores/profile'

/**
 * 用户画像查看/编辑弹窗：手动编辑 user.md（Markdown）。
 * 画像也会被 AI 根据拖拽调整自动更新（见 profile store）。
 */
const ui = useUiStore()
const profile = useProfileStore()
const { profileModalOpen } = storeToRefs(ui)

const draft = ref('')
const textRef = ref<HTMLTextAreaElement | null>(null)

watch(profileModalOpen, async (open) => {
  if (open) {
    draft.value = profile.md
    await nextTick()
    textRef.value?.focus()
  }
})

function close(): void {
  if (profile.busy) return
  ui.profileModalOpen = false
}

async function save(): Promise<void> {
  await profile.updateMd(draft.value)
  ui.profileModalOpen = false
}
</script>

<template>
  <Teleport to="body">
    <div v-if="profileModalOpen" class="fixed inset-0 z-[95] flex items-center justify-center" data-app-ui>
      <div class="absolute inset-0 bg-black/30 backdrop-blur-[2px]" @click="close" />
      <div
        class="animate-pop-in glass-panel relative w-[440px] max-w-[92vw] p-4"
        @keydown.esc.prevent="close"
      >
        <div class="mb-1 text-[14px] font-semibold text-slate-100">🧠 用户画像（user.md）</div>
        <p class="mb-3 text-[11px] leading-relaxed text-slate-400">
          AI 会参考这份画像为你的新任务归类，并根据你的拖拽调整自动完善。也可手动修改后保存。
        </p>

        <textarea
          ref="textRef"
          v-model="draft"
          class="thin-scroll h-[240px] w-full resize-none rounded-lg border border-white/10 bg-white/5 p-2.5 text-[11px] leading-relaxed text-slate-100 outline-none transition focus:border-sky-400/50"
          placeholder="# 用户画像&#10;&#10;（尚未生成，可在设置中填写问卷生成）"
          spellcheck="false"
        />

        <div class="mt-3.5 flex items-center justify-between">
          <span class="text-[10px] text-slate-500">
            {{ profile.busy ? 'AI 正在分析你的拖拽习惯…' : `已学习 ${profile.dragLog.length} 次拖拽调整` }}
          </span>
          <div class="flex gap-2">
            <button
              class="rounded-lg border border-white/10 px-3.5 py-1.5 text-[12px] text-slate-300 transition hover:bg-white/5"
              @click="close"
            >
              取消
            </button>
            <button
              class="rounded-lg bg-sky-400/90 px-3.5 py-1.5 text-[12px] font-medium text-slate-900 transition hover:bg-sky-300 disabled:opacity-40"
              :disabled="profile.busy"
              @click="save"
            >
              保存
            </button>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>
