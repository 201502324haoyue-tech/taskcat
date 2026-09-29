<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { useToastsStore, type ToastKind } from '@/stores/toasts'

/** Toast 通知栈（Spec §8：保存失败提示 / Spec §6.3：提醒） */
const toasts = useToastsStore()
const { toasts: list } = storeToRefs(toasts)

const KIND_STYLE: Record<ToastKind, { icon: string; cls: string }> = {
  info: { icon: 'ℹ️', cls: 'border-sky-400/40 bg-sky-500/15 text-sky-100' },
  success: { icon: '✅', cls: 'border-emerald-400/40 bg-emerald-500/15 text-emerald-100' },
  warn: { icon: '⚠️', cls: 'border-amber-400/40 bg-amber-500/15 text-amber-100' },
  error: { icon: '⛔', cls: 'border-rose-400/40 bg-rose-500/15 text-rose-100' },
}
</script>

<template>
  <Teleport to="body">
    <div class="pointer-events-none fixed left-1/2 top-4 z-[120] flex w-[min(92vw,420px)] -translate-x-1/2 flex-col items-center gap-2" data-app-ui>
      <div
        v-for="t in list"
        :key="t.id"
        class="animate-toast-in pointer-events-auto flex w-full items-center gap-2 rounded-xl border px-3 py-2 text-[12px] shadow-xl backdrop-blur"
        :class="KIND_STYLE[t.kind].cls"
      >
        <span>{{ KIND_STYLE[t.kind].icon }}</span>
        <span class="min-w-0 flex-1">{{ t.message }}</span>
        <button class="shrink-0 opacity-60 transition hover:opacity-100" @click="toasts.dismiss(t.id)">✕</button>
      </div>
    </div>
  </Teleport>
</template>
