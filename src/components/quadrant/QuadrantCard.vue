<script setup lang="ts">
import { computed } from 'vue'
import { storeToRefs } from 'pinia'
import { useTasksStore } from '@/stores/tasks'
import { useUiStore } from '@/stores/ui'
import { QUADRANT_META, type Quadrant } from '@/types/task'
import TaskItem from './TaskItem.vue'

/** 单个象限卡片：彩色头部 + 任务列表 + 手动拖拽落点（Spec §4 象限归属：拖拽改象限） */
const props = defineProps<{ quadrant: Quadrant }>()

const tasks = useTasksStore()
const ui = useUiStore()
const { searchQuery } = storeToRefs(ui)

const meta = QUADRANT_META[props.quadrant]
const activeCount = computed(
  () => tasks.tasks.filter((t) => t.quadrant === props.quadrant && t.completedAt === null).length,
)

const list = computed(() => {
  const all = tasks.tasks.filter((t) => t.quadrant === props.quadrant)
  const needle = searchQuery.value.trim().toLowerCase()
  if (!needle) return all
  return all.filter(
    (t) =>
      t.title.toLowerCase().includes(needle) ||
      t.subtasks.some((s) => s.title.toLowerCase().includes(needle)),
  )
})
</script>

<template>
  <div
    :data-quadrant="props.quadrant"
    class="flex min-h-0 flex-col rounded-2xl border border-white/10 bg-white/[0.035] transition"
    :style="{ borderTop: `3px solid ${meta.hex}` }"
    :class="{ 'drop-target': ui.drag.active && ui.drag.over === props.quadrant }"
  >
    <!-- 象限头部 -->
    <div class="flex shrink-0 items-center justify-between px-2.5 py-1.5">
      <span class="flex items-center gap-1.5 text-[12px] font-semibold text-slate-200">
        <span>{{ meta.icon }}</span>
        <span>{{ meta.label }}</span>
        <span class="hidden text-[10px] font-normal text-slate-500">· {{ meta.action }}</span>
      </span>
      <div class="flex items-center gap-1.5">
        <span
          class="rounded-full px-1.5 py-0.5 text-[11px] font-bold tabular-nums"
          :style="{ color: meta.hex, background: meta.hex + '22' }"
        >
          {{ activeCount }}
        </span>
        <!-- 小加号：以当前象限快速添加任务 -->
        <button
          class="flex h-5 w-5 items-center justify-center rounded-full text-[13px] font-bold leading-none transition hover:brightness-125"
          :style="{ color: meta.hex, background: meta.hex + '1a' }"
          :title="`添加到「${meta.label}」`"
          @click.stop="ui.openQuickAdd(props.quadrant, true)"
        >
          ＋
        </button>
      </div>
    </div>

    <!-- 任务列表 -->
    <div class="task-list thin-scroll min-h-0 flex-1 overflow-y-auto px-2 pb-2">
      <TaskItem v-for="t in list" :key="t.id" :task="t" />
      <div
        v-if="list.length === 0"
        class="task-empty flex items-center justify-center rounded-lg border border-dashed border-white/10 text-slate-500"
      >
        {{ meta.emptyHint }}
      </div>
    </div>
  </div>
</template>
