<script setup lang="ts">
/**
 * 语音输入弹窗：录音 → 识别 → 编辑确认 → 同步推送
 * 手机端语音主入口，使用 Web Speech API。
 */
import { onMounted, onUnmounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useUiStore } from '@/stores/ui'
import { useTasksStore } from '@/stores/tasks'
import { useToastsStore } from '@/stores/toasts'
import { useSpeechRecognition } from '@/composables/useSpeechRecognition'
import { QUADRANT_META, type Quadrant } from '@/types/task'
import { pushTasks } from '@/services/sync'

const ui = useUiStore()
const tasks = useTasksStore()
const toasts = useToastsStore()
const { voiceInputOpen } = storeToRefs(ui)

const speech = useSpeechRecognition()

const text = ref('')
const quadrant = ref<Quadrant>('q1')
const pushing = ref(false)

// 自动开始录音
watch(voiceInputOpen, (open) => {
  if (open) {
    text.value = ''
    quadrant.value = 'q1'
    speech.finalText.value = ''
    speech.interimText.value = ''
    speech.start()
  } else {
    speech.stop()
  }
})

onUnmounted(() => {
  speech.stop()
})

// 停止录音时把 final + interim 合并到文本框
watch(speech.listening, (listening) => {
  if (!listening && text.value === '') {
    const result = speech.getResult()
    if (result) text.value = result
  }
})

function stopAndFill(): void {
  speech.stop()
  const result = speech.getResult()
  if (result) text.value = result
}

async function confirm(): Promise<void> {
  const title = text.value.trim()
  if (!title) {
    toasts.add('warn', '请输入或说出任务内容')
    return
  }
  pushing.value = true
  try {
    tasks.addTask({ title, quadrant: quadrant.value, dueAt: null })
    // 同步推送到电脑
    await pushTasks(tasks.tasks).catch(() => {})
    toasts.add('success', `已添加「${title.slice(0, 20)}」到 ${QUADRANT_META[quadrant.value].label}`)
    ui.closeVoiceInput()
  } catch (e) {
    toasts.add('error', `推送失败：${e instanceof Error ? e.message : e}`)
  } finally {
    pushing.value = false
  }
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="voiceInputOpen"
      class="fixed inset-0 z-50 flex flex-col bg-slate-950/92 backdrop-blur-sm"
      data-app-ui
    >
      <!-- 顶部标题栏 -->
      <div class="flex shrink-0 items-center justify-between px-4 py-3">
        <span class="text-[14px] font-semibold text-slate-100">🎤 语音录入</span>
        <button
          class="flex h-7 w-7 items-center justify-center rounded-full text-slate-300 transition hover:bg-white/15 hover:text-white"
          @click="ui.closeVoiceInput()"
        >
          ✕
        </button>
      </div>

      <div class="flex flex-1 flex-col items-center justify-center gap-6 px-6">
        <!-- 录音按钮 -->
        <button
          class="relative flex h-28 w-28 items-center justify-center rounded-full transition-all duration-300"
          :class="{
            'bg-rose-500 shadow-[0_0_40px_rgba(244,63,94,0.5)] scale-110': speech.listening.value,
            'bg-slate-500/60 hover:bg-slate-400/60': !speech.listening.value,
          }"
          @click="speech.listening.value ? speech.stop() : speech.start()"
        >
          <span class="text-5xl">{{ speech.listening.value ? '🔴' : '🎤' }}</span>
          <!-- 录音脉冲动画 -->
          <span
            v-if="speech.listening.value"
            class="absolute inset-0 animate-ping rounded-full bg-rose-400/30"
          />
        </button>

        <!-- 状态提示 -->
        <p class="text-[12px] text-slate-400">
          <template v-if="speech.error.value">{{ speech.error.value }}</template>
          <template v-else-if="speech.listening.value">正在聆听… 点击按钮停止</template>
          <template v-else-if="speech.supported.value">点击🎤按钮开始说话</template>
          <template v-else>本设备不支持语音识别</template>
        </p>

        <!-- 临时识别文字 -->
        <p v-if="speech.interimText.value && speech.listening.value" class="min-h-[20px] text-[13px] text-slate-300/60 italic">
          {{ speech.interimText.value }}
        </p>

        <!-- 识别编辑框 -->
        <div class="w-full max-w-md space-y-3">
          <textarea
            v-model="text"
            class="h-24 w-full resize-none rounded-2xl border border-white/15 bg-white/8 px-3 py-2 text-[13px] text-slate-100 outline-none transition placeholder:text-slate-400 focus:border-sky-400/60"
            placeholder="语音识别结果将显示在这里，可手动编辑修改…"
          />

          <!-- 象限选择 -->
          <div class="flex gap-2">
            <button
              v-for="q in (['q1', 'q2', 'q3', 'q4'] as Quadrant[])"
              :key="q"
              class="flex-1 rounded-xl py-2 text-[11px] font-medium transition"
              :class="quadrant === q
                ? 'bg-sky-400/85 text-slate-900'
                : 'border border-white/10 text-slate-300 hover:bg-white/10'"
              @click="quadrant = q"
            >
              {{ QUADRANT_META[q].icon }} {{ QUADRANT_META[q].label }}
            </button>
          </div>

          <!-- 确认按钮 -->
          <button
            class="w-full rounded-2xl bg-emerald-400/85 py-3 text-[13px] font-semibold text-slate-900 transition hover:bg-emerald-300 disabled:opacity-40"
            :disabled="!text.trim() || pushing"
            @click="confirm"
          >
            {{ pushing ? '⏳ 推送中…' : '✅ 确认并推送' }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>