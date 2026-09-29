<script setup lang="ts">
import { ref, watch } from 'vue'
import { useTasksStore } from '@/stores/tasks'
import { useToastsStore } from '@/stores/toasts'
import { QUADRANT_META, QUADRANTS } from '@/types/task'
import type { ExtractedTask } from '@/services/smart'

/**
 * 大模型识别结果预览：可改标题/象限，逐个或全部添加（共享给截图/飞书两种方式）。
 */
const props = defineProps<{ tasks: ExtractedTask[] }>()
const emit = defineEmits<{ (e: 'done'): void }>()

const tasks = useTasksStore()
const toasts = useToastsStore()

const list = ref<ExtractedTask[]>([])
watch(
  () => props.tasks,
  (v) => {
    list.value = v.map((t) => ({ ...t }))
  },
  { immediate: true },
)

function add(t: ExtractedTask): void {
  tasks.addTask({ title: t.title, quadrant: t.quadrant, dueAt: t.dueAt })
  toasts.add('success', `已添加「${t.title.slice(0, 16)}」到 ${QUADRANT_META[t.quadrant].label}`)
  list.value = list.value.filter((x) => x !== t)
}

function addAll(): void {
  const count = list.value.length
  for (const t of [...list.value]) {
    tasks.addTask({ title: t.title, quadrant: t.quadrant, dueAt: t.dueAt })
  }
  toasts.add('success', `已添加 ${count} 条任务`)
  list.value = []
  emit('done')
}

function remove(t: ExtractedTask): void {
  list.value = list.value.filter((x) => x !== t)
}
</script>

<template>
  <div class="mt-3 rounded-2xl border border-white/10 bg-white/5 p-2.5">
    <div class="mb-1.5 flex items-center justify-between">
      <span class="text-[12px] font-semibold text-slate-200">🤖 识别结果（{{ list.length }} 条）</span>
      <div class="flex gap-1.5">
        <button
          class="rounded-full px-2.5 py-1 text-[11px] text-slate-300 transition hover:bg-white/10"
          @click="emit('done')"
        >
          完成
        </button>
        <button
          class="rounded-full bg-emerald-400/80 px-2.5 py-1 text-[11px] font-medium text-slate-900 transition hover:bg-emerald-300 disabled:opacity-40"
          :disabled="list.length === 0"
          @click="addAll"
        >
          全部添加
        </button>
      </div>
    </div>

    <div v-if="list.length === 0" class="py-1 text-[11px] text-slate-500">暂无任务 · 可点「完成」换其他方式录入</div>

    <div v-for="t in list" :key="t.title + t.quadrant" class="flex items-center gap-1.5 border-t border-white/5 py-1.5 first:border-t-0">
      <input
        v-model="t.title"
        class="min-w-0 flex-1 rounded-md border border-white/10 bg-white/5 px-1.5 py-1 text-[11px] text-slate-100 outline-none focus:border-sky-400/50"
      />
      <div class="flex shrink-0 gap-0.5">
        <button
          v-for="q in QUADRANTS"
          :key="q"
          class="flex h-5 w-5 items-center justify-center rounded-full text-[11px] transition"
          :style="
            t.quadrant === q
              ? { color: '#fff', background: QUADRANT_META[q].hex }
              : { color: QUADRANT_META[q].hex, background: QUADRANT_META[q].hex + '1f' }
          "
          :title="QUADRANT_META[q].label"
          @click="t.quadrant = q"
        >
          {{ QUADRANT_META[q].icon }}
        </button>
      </div>
      <button
        class="shrink-0 px-1 text-[11px] text-slate-500 transition hover:text-rose-300"
        title="移除"
        @click="remove(t)"
      >
        ✕
      </button>
    </div>
  </div>
</template>
