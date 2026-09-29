<script setup lang="ts">
import { ref, watch } from 'vue'
import { useTasksStore } from '@/stores/tasks'
import { useUiStore } from '@/stores/ui'
import { QUADRANT_META, QUADRANTS, type Quadrant, type Task } from '@/types/task'
import { fromLocalInput, toLocalDate, toLocalInput } from '@/utils/datetime'

/**
 * 任务内联编辑器（Spec §5.2 / §9.1）：子任务增删勾选、截止时间、象限调整、删除任务。
 */
const props = defineProps<{ task: Task }>()

const tasks = useTasksStore()
const ui = useUiStore()

const newSubtask = ref('')
const dueInput = ref(
  props.task.dueAt !== null
    ? ui.duePrecisionMinute
      ? toLocalInput(props.task.dueAt)
      : toLocalDate(props.task.dueAt)
    : '',
)
const confirmDelete = ref(false)

// 截止精确度切换时，把输入框值换算成对应格式
watch(
  () => ui.duePrecisionMinute,
  () => {
    if (props.task.dueAt !== null) {
      dueInput.value = ui.duePrecisionMinute ? toLocalInput(props.task.dueAt) : toLocalDate(props.task.dueAt)
    }
  },
)

function addSubtask(): void {
  const title = newSubtask.value.trim()
  if (!title) return
  tasks.addSubtask(props.task.id, title)
  newSubtask.value = ''
}

function setDue(): void {
  tasks.patchTask(props.task.id, { dueAt: fromLocalInput(dueInput.value) })
}

function clearDue(): void {
  dueInput.value = ''
  tasks.patchTask(props.task.id, { dueAt: null })
}

function setQuadrant(q: Quadrant): void {
  tasks.patchTask(props.task.id, { quadrant: q })
}

function remove(): void {
  if (!confirmDelete.value) {
    confirmDelete.value = true
    window.setTimeout(() => (confirmDelete.value = false), 2500)
    return
  }
  ui.editingTaskId = null
  tasks.removeTask(props.task.id)
}
</script>

<template>
  <div class="animate-fade-in mt-1 space-y-2 rounded-2xl border border-white/10 bg-slate-950/35 px-2.5 py-2">
    <!-- 子任务 -->
    <div>
      <div class="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">子任务</div>
      <div class="space-y-1">
        <div
          v-for="s in task.subtasks"
          :key="s.id"
          class="flex items-center gap-1.5 text-[11px]"
        >
          <button
            class="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border text-[9px] transition"
            :class="
              s.done
                ? 'border-emerald-400/60 bg-emerald-400/20 text-emerald-300'
                : 'border-white/25 text-transparent hover:border-emerald-400/60'
            "
            @click="tasks.toggleSubtask(task.id, s.id)"
          >
            ✓
          </button>
          <span class="min-w-0 flex-1 truncate" :class="s.done ? 'text-slate-500 line-through' : 'text-slate-200'">
            {{ s.title }}
          </span>
          <button
            class="shrink-0 px-1 text-slate-500 transition hover:text-rose-400"
            title="删除子任务"
            @click="tasks.removeSubtask(task.id, s.id)"
          >
            ✕
          </button>
        </div>
        <div v-if="task.subtasks.length === 0" class="text-[11px] text-slate-600">暂无子任务</div>
      </div>
      <div class="mt-1.5 flex gap-1.5">
        <input
          v-model="newSubtask"
          class="h-6.5 min-w-0 flex-1 rounded-md border border-white/10 bg-white/5 px-2 text-[11px] text-slate-100 outline-none placeholder:text-slate-500 focus:border-sky-400/50"
          placeholder="+ 添加子任务…"
          @keydown.enter.prevent="addSubtask"
        />
        <button
          class="shrink-0 rounded-md border border-white/10 bg-white/5 px-2 text-[11px] text-slate-300 transition hover:bg-white/10"
          @click="addSubtask"
        >
          添加
        </button>
      </div>
    </div>

    <!-- 截止时间 -->
    <div class="flex items-center gap-2">
      <span class="text-[10px] font-semibold uppercase tracking-wide text-slate-500">截止</span>
      <input
        v-model="dueInput"
        :type="ui.duePrecisionMinute ? 'datetime-local' : 'date'"
        class="h-6.5 min-w-0 flex-1 rounded-md border border-white/10 bg-white/5 px-2 text-[11px] text-slate-200 outline-none focus:border-sky-400/50"
        @change="setDue"
      />
      <button
        class="shrink-0 rounded-md border border-white/10 bg-white/5 px-2 text-[11px] text-slate-400 transition hover:bg-white/10"
        @click="clearDue"
      >
        清除
      </button>
    </div>

    <!-- 象限调整 -->
    <div class="flex items-center gap-1.5">
      <span class="text-[10px] font-semibold uppercase tracking-wide text-slate-500">象限</span>
      <button
        v-for="q in QUADRANTS"
        :key="q"
        class="flex-1 rounded-md border px-1 py-1 text-[11px] transition"
        :class="task.quadrant === q ? 'text-white' : 'border-white/10 text-slate-400 hover:bg-white/5'"
        :style="
          task.quadrant === q
            ? { borderColor: QUADRANT_META[q].hex, background: QUADRANT_META[q].hex + '2e' }
            : undefined
        "
        @click="setQuadrant(q)"
      >
        {{ QUADRANT_META[q].icon }} {{ QUADRANT_META[q].action }}
      </button>
    </div>

    <!-- 操作 -->
    <div class="flex items-center justify-between pt-0.5">
      <button
        class="rounded-md px-2 py-1 text-[11px] transition"
        :class="
          confirmDelete
            ? 'bg-rose-500/30 font-semibold text-rose-200'
            : 'text-slate-500 hover:bg-rose-500/15 hover:text-rose-300'
        "
        @click="remove"
      >
        {{ confirmDelete ? '确认删除？' : '删除任务' }}
      </button>
      <button
        class="rounded-md px-2 py-1 text-[11px] text-slate-400 transition hover:bg-white/5 hover:text-slate-200"
        @click="ui.editingTaskId = null"
      >
        完成 ▸
      </button>
    </div>
  </div>
</template>
