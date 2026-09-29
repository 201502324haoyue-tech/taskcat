<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useTasksStore } from '@/stores/tasks'
import { useUiStore } from '@/stores/ui'
import { fmtDateTime, fmtTime, formatDue } from '@/utils/datetime'
import { QUADRANT_META } from '@/types/task'
import type { Quadrant, Task } from '@/types/task'
import TaskEditor from './TaskEditor.vue'

/** 任务行：勾选完成 / 拖拽改象限 / 点击展开内联编辑器（Spec §5.2）/ 悬停显示全部信息 */
const props = defineProps<{ task: Task }>()

const tasks = useTasksStore()
const ui = useUiStore()
const { editingTaskId } = storeToRefs(ui)

const isEditing = computed(() => editingTaskId.value === props.task.id)
const due = computed(() => (props.task.dueAt !== null ? formatDue(props.task.dueAt) : null))
const doneSubtasks = computed(() => props.task.subtasks.filter((s) => s.done).length)
const confirmDel = ref(false)
const rootEl = ref<HTMLElement | null>(null)

/** 悬停全部信息 tooltip */
const TIP_DELAY = 320 // 悬停多久后显示（ms）
const TIP_GAP = 6 // 与卡片间距
const TIP_MARGIN = 8 // 与窗口边缘留白
const TIP_MAX_SUBTASKS = 8 // 子任务最多逐条展示数量
const tipVisible = ref(false)
const tipEl = ref<HTMLElement | null>(null)
const tipPos = ref({ left: 0, top: 0 })
let tipTimer: number | null = null

const qMeta = computed(() => QUADRANT_META[props.task.quadrant])

/** 完整截止时间文案：绝对时间（到日任务标注当天截止）+ 超期提示 */
const dueFull = computed(() => {
  const ts = props.task.dueAt
  if (ts === null) return '无'
  const d = new Date(ts)
  const endOfDay = d.getHours() === 23 && d.getMinutes() === 59 && d.getSeconds() >= 59
  const datePart = `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`
  const abs = endOfDay ? `${datePart}（当天截止）` : `${datePart} ${fmtTime(ts)}`
  return due.value?.overdue ? `${abs} · ${due.value.text}` : abs
})

const tipSubtasks = computed(() => props.task.subtasks.slice(0, TIP_MAX_SUBTASKS))
const tipHiddenCount = computed(() => Math.max(0, props.task.subtasks.length - TIP_MAX_SUBTASKS))

function onEnter(): void {
  if (ui.drag.active || isEditing.value) return
  if (tipTimer !== null) window.clearTimeout(tipTimer)
  tipTimer = window.setTimeout(() => void showTip(), TIP_DELAY)
}

function onLeave(): void {
  hideTip()
}

/** 显示 tooltip：贴卡片定位，自动避让窗口边缘（下方放不下则翻到上方） */
async function showTip(): Promise<void> {
  tipTimer = null
  if (ui.drag.active || isEditing.value) return
  const rect = rootEl.value?.getBoundingClientRect()
  if (!rect) return
  tipVisible.value = true
  await nextTick()
  const w = tipEl.value?.offsetWidth ?? 280
  const h = tipEl.value?.offsetHeight ?? 200
  const vw = window.innerWidth
  const vh = window.innerHeight
  let left = Math.max(TIP_MARGIN, Math.min(rect.left, vw - w - TIP_MARGIN))
  let top = rect.bottom + TIP_GAP
  if (top + h > vh - TIP_MARGIN) {
    const above = rect.top - h - TIP_GAP
    top = above >= TIP_MARGIN ? above : Math.max(TIP_MARGIN, vh - h - TIP_MARGIN)
  }
  tipPos.value = { left, top }
  // 滚动 / 窗口尺寸变化时立即隐藏，避免 tooltip 与卡片脱节
  window.addEventListener('scroll', hideTip, true)
  window.addEventListener('resize', hideTip)
}

function hideTip(): void {
  if (tipTimer !== null) {
    window.clearTimeout(tipTimer)
    tipTimer = null
  }
  if (!tipVisible.value) return
  tipVisible.value = false
  window.removeEventListener('scroll', hideTip, true)
  window.removeEventListener('resize', hideTip)
}

// 打开编辑器时收起 tooltip（编辑器本身就是完整信息）
watch(isEditing, (v) => {
  if (v) hideTip()
})

/** 拖拽起始点（未超过阈值前为 null）：区分「点击编辑」与「拖拽换象限」 */
const startPt = ref<{ x: number; y: number } | null>(null)
/** 拖拽结束后抑制本次 click，避免误开编辑器 */
const suppressClick = ref(false)

/** 拖拽阈值（px）：超过才进入拖拽模式 */
const DRAG_THRESHOLD = 6

/** 手动拖拽（Pointer Events）：透明窗口下 HTML5 DnD 不可用（dragstart 后立即终止），Spec §5.2 拖拽改象限 */
function onPointerDown(e: PointerEvent): void {
  if (e.button !== 0) return
  hideTip() // 按下即收起 tooltip（点击/拖拽优先）
  if ((e.target as HTMLElement).closest('button')) return // 勾选/删除按钮不参与拖拽
  startPt.value = { x: e.clientX, y: e.clientY }
  window.addEventListener('pointermove', onPointerMove)
  window.addEventListener('pointerup', onPointerUp)
  window.addEventListener('pointercancel', onPointerUp)
}

function onPointerMove(e: PointerEvent): void {
  if (!startPt.value) return
  const dx = e.clientX - startPt.value.x
  const dy = e.clientY - startPt.value.y
  if (!ui.drag.active && Math.hypot(dx, dy) < DRAG_THRESHOLD) return
  if (!ui.drag.active) {
    // 进入拖拽：记录源任务 + 视觉反馈
    hideTip()
    ui.drag.active = true
    ui.drag.taskId = props.task.id
    ui.drag.from = props.task.quadrant
    document.body.classList.add('no-select')
    rootEl.value?.classList.add('dragging')
  }
  ui.drag.over = quadrantAt(e.clientX, e.clientY)
}

function onPointerUp(e: PointerEvent): void {
  window.removeEventListener('pointermove', onPointerMove)
  window.removeEventListener('pointerup', onPointerUp)
  window.removeEventListener('pointercancel', onPointerUp)
  const wasDrag = ui.drag.active
  if (wasDrag) {
    const to = quadrantAt(e.clientX, e.clientY)
    if (to && to !== ui.drag.from) tasks.moveTask(props.task.id, to)
    ui.drag.active = false
    ui.drag.taskId = null
    ui.drag.from = null
    ui.drag.over = null
    document.body.classList.remove('no-select')
    rootEl.value?.classList.remove('dragging')
    suppressClick.value = true // 拖拽后抑制 click（防止误开编辑器）
    window.setTimeout(() => (suppressClick.value = false), 0)
  }
  startPt.value = null
}

/** 指针位置所在的象限卡片（落点/悬停检测） */
function quadrantAt(x: number, y: number): Quadrant | null {
  const q = document.elementFromPoint(x, y)?.closest('[data-quadrant]')?.getAttribute('data-quadrant')
  return q === 'q1' || q === 'q2' || q === 'q3' || q === 'q4' ? q : null
}

function onClick(e: MouseEvent): void {
  if (suppressClick.value) {
    suppressClick.value = false
    e.preventDefault()
    e.stopPropagation()
    return
  }
  toggleEdit()
}

/** 卡片上的删除按钮：首次点击进入确认态（2.5s 内再点才删除），与编辑器删除任务一致，防误触 */
function removeTask(): void {
  if (!confirmDel.value) {
    confirmDel.value = true
    window.setTimeout(() => (confirmDel.value = false), 2500)
    return
  }
  ui.editingTaskId = null
  tasks.removeTask(props.task.id)
}

function toggleEdit(): void {
  ui.editingTaskId = isEditing.value ? null : props.task.id
}
</script>

<template>
  <div>
    <div
      ref="rootEl"
      class="task-card group cursor-pointer"
      :class="[
        task.completedAt !== null ? 'completed' : '',
        isEditing ? 'ring-1 ring-sky-400/40' : '',
      ]"
      @pointerenter="onEnter"
      @pointerleave="onLeave"
      @pointerdown="onPointerDown"
      @click="onClick"
    >
      <div class="task-row flex items-center">
        <button
          class="task-check flex shrink-0 items-center justify-center border transition"
          :class="
            task.completedAt !== null
              ? 'border-emerald-400/60 bg-emerald-400/20 text-emerald-300'
              : 'border-white/25 text-transparent hover:border-emerald-400/60 hover:text-emerald-400/60'
          "
          :title="task.completedAt !== null ? '标记未完成' : '标记完成'"
          @click.stop="tasks.toggleCompleted(task.id)"
        >
          ✓
        </button>
        <span class="task-title min-w-0 flex-1 truncate text-slate-200">
          {{ task.title }}
        </span>
        <span
          v-if="task.subtasks.length > 0"
          class="task-count shrink-0 rounded tabular-nums text-slate-400"
          :class="doneSubtasks === task.subtasks.length ? 'bg-emerald-400/15 text-emerald-300' : 'bg-white/5'"
        >
          {{ doneSubtasks }}/{{ task.subtasks.length }}
        </span>
        <span
          v-if="due"
          class="task-due shrink-0 rounded tabular-nums"
          :class="due.overdue ? 'bg-rose-500/20 font-semibold text-rose-300' : 'bg-white/5 text-slate-400'"
        >
          ⏰ {{ due.text }}
        </span>
        <button
          class="task-del shrink-0 transition"
          :class="confirmDel ? 'font-semibold text-rose-300' : 'text-slate-500 hover:text-rose-400'"
          :title="confirmDel ? '再次点击确认删除' : '删除任务'"
          @click.stop="removeTask"
        >
          {{ confirmDel ? '确认？' : '🗑' }}
        </button>
        <span class="task-grip shrink-0 text-slate-500 opacity-0 transition group-hover:opacity-100">⠿</span>
      </div>
    </div>

    <!-- 内联编辑器 -->
    <TaskEditor v-if="isEditing" :task="task" />

    <!-- 悬停全部信息 tooltip（Teleport 到 body 避免被容器裁剪；穿透鼠标不干扰交互） -->
    <Teleport to="body">
      <div
        v-if="tipVisible"
        ref="tipEl"
        class="pointer-events-none fixed z-[96] w-72 max-w-[92vw] rounded-xl border border-white/15 bg-slate-900/95 p-3 text-slate-100 shadow-2xl backdrop-blur-md"
        :style="{ left: `${tipPos.left}px`, top: `${tipPos.top}px` }"
        data-app-ui
      >
        <div
          class="break-words text-[12px] font-semibold leading-snug"
          :class="task.completedAt !== null ? 'text-slate-400 line-through' : ''"
        >
          {{ task.title }}
        </div>
        <div class="mt-2 space-y-0.5 text-[11px] leading-relaxed text-slate-300">
          <div>象限：{{ qMeta.icon }} {{ qMeta.label }}（{{ qMeta.action }}）</div>
          <div>截止：{{ dueFull }}</div>
          <div>状态：{{ task.completedAt !== null ? `已完成 · ${fmtDateTime(task.completedAt)}` : '进行中' }}</div>
          <div>创建：{{ fmtDateTime(task.createdAt) }}</div>
          <div>更新：{{ fmtDateTime(task.updatedAt) }}</div>
        </div>
        <div v-if="task.subtasks.length > 0" class="mt-2 border-t border-white/10 pt-2">
          <div class="text-[10px] font-medium text-slate-400">子任务（{{ doneSubtasks }}/{{ task.subtasks.length }}）</div>
          <ul class="mt-1 space-y-0.5">
            <li
              v-for="s in tipSubtasks"
              :key="s.id"
              class="flex items-start gap-1 text-[11px] leading-snug"
              :class="s.done ? 'text-slate-500 line-through' : 'text-slate-200'"
            >
              <span class="shrink-0">{{ s.done ? '✓' : '○' }}</span>
              <span class="break-words">{{ s.title }}</span>
            </li>
          </ul>
          <div v-if="tipHiddenCount > 0" class="mt-0.5 text-[10px] text-slate-400">…还有 {{ tipHiddenCount }} 项</div>
        </div>
      </div>
    </Teleport>
  </div>
</template>
