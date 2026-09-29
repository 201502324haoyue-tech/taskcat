<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useTasksStore } from '@/stores/tasks'
import { useUiStore } from '@/stores/ui'
import { useToastsStore } from '@/stores/toasts'
import { QUADRANT_META, QUADRANTS, type Quadrant } from '@/types/task'
import { fromLocalInput } from '@/utils/datetime'

/**
 * 快速录入弹窗（Spec §5.3）：
 * - Enter 保存 / Esc 取消；数字键 1-4 选象限（全局快捷键处理，焦点不在文本框时）
 * - 截止可选，默认无；保存后 2 秒内完成录入（Spec 验收标准）
 */
const tasks = useTasksStore()
const ui = useUiStore()
const toasts = useToastsStore()
const { quickAddOpen, quickAddQuadrant, quickAddLocked } = storeToRefs(ui)

const title = ref('')
const due = ref('')
const titleRef = ref<HTMLInputElement | null>(null)

watch(quickAddOpen, async (open) => {
  if (open) {
    title.value = ui.quickAddTitle // 支持手机语音等预填标题
    due.value = ''
    await nextTick()
    titleRef.value?.focus()
  }
})

function selectQuadrant(q: Quadrant): void {
  ui.quickAddQuadrant = q
}

function save(): void {
  const t = title.value.trim()
  if (!t) return
  tasks.addTask({ title: t, quadrant: quickAddQuadrant.value, dueAt: fromLocalInput(due.value) })
  toasts.add('success', `已添加「${t.slice(0, 20)}」到 ${QUADRANT_META[quickAddQuadrant.value].label}`)
  ui.closeQuickAdd()
}

function cancel(): void {
  ui.closeQuickAdd()
}
</script>

<template>
  <Teleport to="body">
    <div v-if="quickAddOpen" class="fixed inset-0 z-[90] flex items-center justify-center" data-app-ui>
      <div class="absolute inset-0 bg-black/20 backdrop-blur-[2px]" @click="cancel" />
      <div
        class="animate-pop-in glass-panel relative w-[360px] p-4"
        @keydown.esc.prevent="cancel"
      >
        <div class="mb-2 text-[13px] font-semibold text-slate-100">＋ 新任务</div>

        <input
          ref="titleRef"
          v-model="title"
          class="h-9 w-full rounded-lg border border-white/10 bg-white/5 px-3 text-[13px] text-slate-100 outline-none transition placeholder:text-slate-500 focus:border-sky-400/50 focus:bg-white/10"
          placeholder="输入任务标题…（≤ 120 字）"
          maxlength="120"
          @keydown.enter.prevent="save"
        />

        <!-- 锁定象限（点象限加号打开）：只显示固定标签，不再选择 -->
        <div v-if="quickAddLocked" class="mt-2.5 flex items-center gap-1.5">
          <span class="w-10 text-[11px] text-slate-500">添加到</span>
          <span
            class="flex-1 rounded-lg border px-2 py-1.5 text-[12px] font-medium text-white"
            :style="{ borderColor: QUADRANT_META[quickAddQuadrant].hex, background: QUADRANT_META[quickAddQuadrant].hex + '2e' }"
          >
            {{ QUADRANT_META[quickAddQuadrant].icon }} {{ QUADRANT_META[quickAddQuadrant].label }}
          </span>
        </div>
        <!-- 非锁定：显示象限选择 -->
        <div v-else class="mt-2.5 flex items-center gap-1.5">
          <span class="w-10 text-[11px] text-slate-500">象限</span>
          <button
            v-for="(q, i) in QUADRANTS"
            :key="q"
            class="flex-1 rounded-lg border px-1 py-1.5 text-[12px] transition"
            :class="quickAddQuadrant === q ? 'text-white' : 'border-white/10 text-slate-400 hover:bg-white/5'"
            :style="
              quickAddQuadrant === q
                ? { borderColor: QUADRANT_META[q].hex, background: QUADRANT_META[q].hex + '2e' }
                : undefined
            "
            :title="`${QUADRANT_META[q].label}（按 ${i + 1}）`"
            @click="selectQuadrant(q)"
          >
            {{ QUADRANT_META[q].icon }} {{ QUADRANT_META[q].action }}
          </button>
        </div>

        <div class="mt-2.5 flex items-center gap-1.5">
          <span class="w-10 text-[11px] text-slate-500">截止</span>
          <input
            v-model="due"
            :type="ui.duePrecisionMinute ? 'datetime-local' : 'date'"
            class="h-8 min-w-0 flex-1 rounded-lg border border-white/10 bg-white/5 px-2.5 text-[12px] text-slate-200 outline-none focus:border-sky-400/50"
          />
          <span class="text-[10px] text-slate-500">可选</span>
        </div>

        <div class="mt-3.5 flex justify-end gap-2">
          <button
            class="rounded-lg border border-white/10 px-3.5 py-1.5 text-[12px] text-slate-300 transition hover:bg-white/5"
            @click="cancel"
          >
            取消
          </button>
          <button
            class="rounded-lg px-3.5 py-1.5 text-[12px] font-medium text-white transition disabled:opacity-40"
            :style="{ background: QUADRANT_META[quickAddQuadrant].hex }"
            :disabled="!title.trim()"
            @click="save"
          >
            保存 (Enter)
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
