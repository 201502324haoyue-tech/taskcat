<script setup lang="ts">
import { ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useTasksStore } from '@/stores/tasks'
import { useUiStore } from '@/stores/ui'
import { useToastsStore } from '@/stores/toasts'
import { QUADRANT_META, type Quadrant } from '@/types/task'
import { seedTasks } from '@/utils/demo'
import PetCanvas from './PetCanvas.vue'
import QuadrantBoard from './quadrant/QuadrantBoard.vue'
import SettingsMenu from './SettingsMenu.vue'
import { isCapacitor } from '@/utils/tauri'

/** 展开态面板（Spec §5.2）：头部 + 快速录入框 + 搜索 + 四象限矩阵 + 桌宠 */
const tasks = useTasksStore()
const ui = useUiStore()
const toasts = useToastsStore()
const mobile = isCapacitor()
const { totalCount } = storeToRefs(tasks)
const { searchQuery } = storeToRefs(ui)

const quickTitle = ref('')
const quickQuadrant = ref<Quadrant>('q1')
const menuOpen = ref(false)

function quickAdd(): void {
  const title = quickTitle.value.trim()
  if (!title) return
  tasks.addTask({ title, quadrant: quickQuadrant.value, dueAt: null })
  toasts.add('success', `已添加「${title.slice(0, 20)}」到 ${QUADRANT_META[quickQuadrant.value].label}`)
  quickTitle.value = ''
}

function loadDemo(): void {
  menuOpen.value = false
  if (tasks.totalCount > 0 && !window.confirm('将覆盖当前任务，确定载入演示数据？')) return
  tasks.replaceAll(seedTasks())
  toasts.add('success', '已载入演示数据，看看小猫的反应 👀')
}

function clearAll(): void {
  menuOpen.value = false
  if (tasks.totalCount === 0) return
  if (!window.confirm(`确定清空全部 ${tasks.totalCount} 项任务？`)) return
  tasks.replaceAll([])
  toasts.add('info', '已清空全部任务')
}
</script>

<template>
  <div class="relative h-full w-full">
    <!-- 除桌宠外的全部 UI：透明度随设置整体调节 -->
    <div
      class="glass-panel relative flex h-full w-full flex-col overflow-hidden"
      :style="{ opacity: ui.opacity }"
    >
    <!-- 头部 -->
    <div class="glass-header flex shrink-0 items-center justify-between rounded-t-[16px] px-3 py-2">
      <div class="flex items-baseline gap-1.5">
        <span class="text-[13px] font-semibold text-slate-100">📋 任务矩阵</span>
        <span class="text-[10px] text-slate-400">{{ totalCount }} 项未完成</span>
      </div>
      <div class="flex items-center gap-0.5" data-no-drag>
        <SettingsMenu />
        <div class="relative">
          <button
            class="flex h-6 w-6 items-center justify-center rounded-full text-slate-200 transition hover:bg-white/15 hover:text-white"
            title="更多"
            @click="menuOpen = !menuOpen"
          >
            ⋯
          </button>
          <div
            v-if="menuOpen"
            class="animate-pop-in absolute right-0 top-7 z-30 w-44 overflow-hidden rounded-xl border border-white/10 bg-slate-900/95 p-1 text-[12px] text-slate-200 shadow-2xl backdrop-blur"
            @pointerdown.stop
          >
            <button class="w-full rounded-lg px-3 py-1.5 text-left hover:bg-white/10" @click="loadDemo">
              🧪 载入演示数据
            </button>
            <button class="w-full rounded-lg px-3 py-1.5 text-left hover:bg-white/10" @click="clearAll">
              🗑 清空全部任务
            </button>
            <button class="w-full rounded-lg px-3 py-1.5 text-left hover:bg-white/10" @click="menuOpen = false">
              ✖ 关闭菜单
            </button>
          </div>
        </div>
        <button
          class="flex h-6 w-6 items-center justify-center rounded-full text-slate-200 transition hover:bg-white/15 hover:text-white"
          title="智能录入（截图 / 飞书 / 语音 / 手动）"
          @click="ui.openSmartInput()"
        >
          ✨
        </button>
        <button
          class="flex h-6 w-6 items-center justify-center rounded-full text-slate-200 transition hover:bg-white/15 hover:text-white"
          title="快速录入 (Ctrl+Shift+Space)"
          @click="ui.openQuickAdd()"
        >
          ＋
        </button>
        <button
          v-if="!mobile"
          class="flex h-6 w-6 items-center justify-center rounded-full text-slate-200 transition hover:bg-rose-500/25 hover:text-rose-200"
          title="最小化到托盘"
          @click="ui.minimize()"
        >
          🗕
        </button>
      </div>
    </div>

    <!-- 快速录入框 + 搜索（Spec §5.2） -->
    <div class="flex shrink-0 items-center gap-2 px-3 py-2">
      <input
        v-model="quickTitle"
        class="h-8 min-w-0 flex-1 rounded-xl border border-white/15 bg-white/8 px-2.5 text-[12px] text-slate-100 outline-none transition placeholder:text-slate-400 focus:border-sky-400/60 focus:bg-white/15"
        placeholder="+ 快速添加任务…"
        @keydown.enter.prevent="quickAdd"
      />
      <select
        v-model="quickQuadrant"
        class="h-8 shrink-0 rounded-xl border border-white/15 bg-slate-800/70 px-1.5 text-[12px] text-slate-100 outline-none focus:border-sky-400/60"
        title="任务象限"
      >
        <option v-for="q in (['q1', 'q2', 'q3', 'q4'] as Quadrant[])" :key="q" :value="q">
          {{ QUADRANT_META[q].icon }} {{ QUADRANT_META[q].label }}
        </option>
      </select>
      <input
        v-model="ui.searchQuery"
        class="h-8 w-28 shrink-0 rounded-xl border border-white/15 bg-white/8 px-2.5 text-[12px] text-slate-100 outline-none transition placeholder:text-slate-400 focus:border-sky-400/60 focus:bg-white/15"
        placeholder="🔍 搜索"
      />
    </div>

    <!-- 四象限矩阵（占满面板；猫坐在右下角，只盖住角落一点） -->
    <div class="min-h-0 flex-1 px-3 pb-3">
      <QuadrantBoard />
    </div>

    </div>

    <!-- 猫猫：独立层，不受透明度设置影响，坐在四象限右下角 -->
    <!-- 手机端：点击猫触发语音输入，旁边加语音快捷按钮 -->
    <div class="pointer-events-auto absolute bottom-1 right-1 z-20 flex items-end gap-1">
      <template v-if="mobile">
        <button
          class="relative flex h-[52px] w-[52px] items-center justify-center rounded-full bg-rose-500/70 text-xl shadow-lg transition hover:bg-rose-400 active:scale-95"
          title="语音录入"
          @click="ui.openVoiceInput()"
        >
          🎤
          <span class="absolute -top-0.5 -right-0.5 flex h-[14px] w-[14px] items-center justify-center rounded-full bg-emerald-400 text-[8px] font-bold text-slate-900">
            喵
          </span>
        </button>
      </template>
      <PetCanvas :size="mobile ? 'md' : 'md'" @click="mobile && ui.openVoiceInput()" />
    </div>
  </div>
</template>
