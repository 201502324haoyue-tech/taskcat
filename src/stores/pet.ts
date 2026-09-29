import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { Task } from '@/types/task'
import { analyzeTasks, computePressure } from '@/utils/pressure'
import { DEFAULT_MOOD, nextPetState, type PetMood } from '@/utils/petState'
import { tauriGlobal } from '@/utils/tauri'
import { useTasksStore } from './tasks'
import { useToastsStore } from './toasts'

const PET_STATE_KEY = 'eisenhower-pet.pet.v1'
const NOTIFIED_DUE_KEY = 'eisenhower-pet.notified-due'
const RECOMPUTE_MS = 30_000
const REMINDER_WINDOW_MS = 3_600_000 // 距截止 ≤ 1h

interface SavedPetState {
  mood: PetMood
  pressure: number
  savedAt: number
}

/** 已提醒任务 id 集合：持久化，避免重启后对超期/临期任务重复轰炸 */
function loadNotifiedDue(): string[] {
  try {
    const raw = localStorage.getItem(NOTIFIED_DUE_KEY)
    if (!raw) return []
    const arr: unknown = JSON.parse(raw)
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

function persistNotifiedDue(list: string[]): void {
  try {
    localStorage.setItem(NOTIFIED_DUE_KEY, JSON.stringify(list))
  } catch {
    // 持久化失败不影响运行
  }
}

function loadSavedMood(): PetMood {
  try {
    const raw = localStorage.getItem(PET_STATE_KEY)
    if (!raw) return DEFAULT_MOOD
    const s = JSON.parse(raw) as SavedPetState
    return s.mood === 'active' || s.mood === 'wander' || s.mood === 'relaxed' || s.mood === 'sleep'
      ? s.mood
      : DEFAULT_MOOD
  } catch {
    return DEFAULT_MOOD
  }
}

/**
 * 通知（Spec §6.3）：
 * - Tauri 版 → tauri-plugin-notification（Windows Toast）
 * - 浏览器原型 → Web Notification API
 */
function notifyBrowser(title: string, body: string): void {
  const g = tauriGlobal()
  if (g?.notification) {
    void (async () => {
      try {
        const granted = await g.notification!.isPermissionGranted()
        if (!granted) await g.notification!.requestPermission()
        g.notification!.sendNotification({ title, body })
      } catch {
        // Toast 兜底
      }
    })()
    return
  }
  try {
    if (typeof Notification === 'undefined') return
    if (Notification.permission === 'granted') {
      new Notification(title, { body })
    } else if (Notification.permission !== 'denied') {
      void Notification.requestPermission().then((p) => {
        if (p === 'granted') new Notification(title, { body })
      })
    }
  } catch {
    // 忽略浏览器通知失败，Toast 兜底
  }
}

export const usePetStore = defineStore('pet', () => {
  const pressure = ref(0)
  const mood = ref<PetMood>(loadSavedMood())
  const idleSeconds = ref(0)
  const forcedActive = ref(false)
  const notifiedDueIds = ref<string[]>(loadNotifiedDue())
  const started = ref(false)
  let lastPersistedJson = ''

  /** 重算压力分 + 状态机转移 + 提醒（任务变更时调用一次即可立即生效；另有 30s 周期） */
  function recompute(now: number = Date.now()): void {
    const tasksStore = useTasksStore()
    const stats = analyzeTasks(tasksStore.tasks, now)
    const p = computePressure({
      q1Count: stats.q1Count,
      q3Count: stats.q3Count,
      overdueCount: stats.overdueCount,
      nearestDueHours: stats.nearestDueHours,
    })
    pressure.value = p
    forcedActive.value = stats.dueWithin1h
    mood.value = nextPetState(mood.value, {
      pressure: p,
      idleSeconds: idleSeconds.value,
      forcedActive: forcedActive.value,
    })
    checkReminders(tasksStore.tasks, now)
    persistState()
  }

  function checkReminders(tasks: readonly Task[], now: number): void {
    const dueSoon = tasks.filter(
      (t) => t.completedAt === null && t.dueAt !== null && t.dueAt - now <= REMINDER_WINDOW_MS,
    )
    const toasts = useToastsStore()
    for (const t of dueSoon) {
      if (!notifiedDueIds.value.includes(t.id)) {
        notifiedDueIds.value.push(t.id)
        toasts.add('warn', `⏰ 距截止 ≤ 1 小时：「${t.title}」`)
        notifyBrowser('任务喵', `距截止 ≤ 1 小时：「${t.title}」`)
      }
    }
    // 清理：任务已完成/删除/不再处于 1h 窗口后移除，允许未来再次提醒
    const still = new Set(dueSoon.map((t) => t.id))
    notifiedDueIds.value = notifiedDueIds.value.filter((id) => still.has(id))
    persistNotifiedDue(notifiedDueIds.value)
  }

  function persistState(): void {
    const json = JSON.stringify({ mood: mood.value, pressure: pressure.value, savedAt: Date.now() } satisfies SavedPetState)
    if (json === lastPersistedJson) return
    lastPersistedJson = json
    try {
      localStorage.setItem(PET_STATE_KEY, json)
    } catch {
      // 持久化失败不影响运行
    }
  }

  /** 应用内任何交互都重置空闲计时（Spec §6.1：仅统计本应用活动） */
  function onUserActivity(): void {
    idleSeconds.value = 0
  }

  function start(): void {
    if (started.value) return
    started.value = true
    recompute()
    window.setInterval(() => recompute(), RECOMPUTE_MS)
  }

  return {
    pressure,
    mood,
    idleSeconds,
    forcedActive,
    started,
    recompute,
    onUserActivity,
    start,
  }
})
