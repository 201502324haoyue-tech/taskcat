import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { Quadrant, Task } from '@/types/task'
import { uuid } from '@/utils/id'
import { getStorageAdapter, type StorageAdapter } from '@/services/storage'
import { isCapacitor, isTauri, tauriGlobal } from '@/utils/tauri'
import { mergeTasks, mergedDiffers, pushAll, pullIfLoggedIn } from '@/services/sync'
import { isLoggedIn } from '@/services/auth'
import { useToastsStore } from './toasts'
import { useProfileStore } from './profile'

export interface NewTaskInput {
  title: string
  quadrant: Quadrant
  dueAt: number | null
}

export interface SaveError {
  id: number
  message: string
}

/** 深拷贝任务：写队列延迟执行时，快照不被后续 mutation 修改（增量写参数稳定） */
function cloneTask(t: Task): Task {
  return { ...t, subtasks: t.subtasks.map((s) => ({ ...s })) }
}

export const useTasksStore = defineStore('tasks', () => {
  const tasks = ref<Task[]>([])
  const loaded = ref(false)
  const saveErrors = ref<SaveError[]>([])
  let storage: StorageAdapter | null = null
  let errorSeq = 0
  /** 写队列：所有持久化串行执行，避免并发整表写互相覆盖（快速连续操作丢数据） */
  let writeQueue: Promise<void> = Promise.resolve()
  /** 同步推送防抖定时器：变更后 800ms 合并推送一次，避免每次操作都发请求 */
  let syncTimer: ReturnType<typeof setTimeout> | null = null

  /** 防抖推送全量任务：电脑=本地 HTTP + 云端（若配置），手机=公网隧道 */
  function scheduleSyncPush(): void {
    if (syncTimer) clearTimeout(syncTimer)
    syncTimer = setTimeout(() => {
      void pushAll(tasks.value).catch((e) => console.warn('[task-cat] 同步推送失败', e))
    }, 800)
  }

  /** 惰性获取存储适配器（浏览器=localStorage，Tauri=SQLite） */
  async function adapter(): Promise<StorageAdapter> {
    if (!storage) storage = await getStorageAdapter()
    return storage
  }

  /** 各象限未完成任务计数（收起态徽标数据源） */
  const counts = computed<Record<Quadrant, number>>(() => {
    const c: Record<Quadrant, number> = { q1: 0, q2: 0, q3: 0, q4: 0 }
    for (const t of tasks.value) {
      if (t.completedAt === null) c[t.quadrant] += 1
    }
    return c
  })

  const totalCount = computed(() => tasks.value.filter((t) => t.completedAt === null).length)

  function pushSaveError(message: string): void {
    const id = ++errorSeq
    saveErrors.value.push({ id, message })
    setTimeout(() => {
      saveErrors.value = saveErrors.value.filter((e) => e.id !== id)
    }, 6000)
  }

  /**
   * 串行入队一个持久化操作（Spec §8）：
   * - 失败 → Toast + 自动重试一次；二次失败 → 记日志 + 非阻塞错误条
   * - 前一个操作失败不阻断后续写入（catch 后继续队列）
   */
  function enqueueWrite(op: () => Promise<void>): void {
    writeQueue = writeQueue
      .catch(() => {})
      .then(async () => {
        try {
          await op()
        } catch (first) {
          console.warn('[task-cat] 保存失败，重试一次', first)
          useToastsStore().add('error', '保存失败，正在重试…')
          try {
            await op()
          } catch (second) {
            console.error('[task-cat] 二次保存失败', second)
            pushSaveError('保存失败，本次改动可能未持久化')
            useToastsStore().add('error', '保存失败，请检查本地存储')
          }
        }
      })
  }

  async function init(): Promise<void> {
    try {
      tasks.value = await (await adapter()).loadTasks()
    } catch (e) {
      console.error('[task-cat] 读取本地数据失败', e)
      tasks.value = []
      pushSaveError('读取本地数据失败，已从空白开始')
    }
    loaded.value = true

    // ── 双向同步初始化 ──
    if (isTauri()) {
      // 电脑端：监听手机推送 → 整表替换 + 写本地
      tauriGlobal()
        ?.event.listen('sync:tasks', (e) => {
          const list = e.payload as Task[]
          if (Array.isArray(list)) replaceAll(list)
        })
        .catch(() => {})
      // 电脑端：已登录 → 启动时拉取云端 → 合并 → 写本地
      ;(async () => {
        const remote = await pullIfLoggedIn()
        if (remote.length > 0) {
          const merged = mergeTasks(tasks.value, remote)
          if (mergedDiffers(tasks.value, merged)) replaceAll(merged)
        }
      })()
      void pushAll(tasks.value).catch((e) => console.warn('[task-cat] 启动同步推送失败', e))
    } else if (isCapacitor()) {
      // 手机端：已登录 → 拉取云端 → 合并 → 写本地
      ;(async () => {
        const remote = await pullIfLoggedIn()
        if (remote.length > 0) {
          const merged = mergeTasks(tasks.value, remote)
          if (mergedDiffers(tasks.value, merged)) replaceAll(merged)
        }
      })()
    }
  }

  function addTask(input: NewTaskInput): Task {
    const now = Date.now()
    const task: Task = {
      id: uuid(),
      title: input.title.trim().slice(0, 120),
      quadrant: input.quadrant,
      dueAt: input.dueAt,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      subtasks: [],
    }
    tasks.value.push(task)
    enqueueWrite(async () => (await adapter()).insertTask(cloneTask(task)))
    scheduleSyncPush()
    return task
  }

  function patchTask(id: string, patch: Partial<Pick<Task, 'title' | 'quadrant' | 'dueAt' | 'completedAt'>>): void {
    const t = tasks.value.find((x) => x.id === id)
    if (!t) return
    Object.assign(t, patch, { updatedAt: Date.now() })
    enqueueWrite(async () => (await adapter()).updateTask(cloneTask(t)))
    scheduleSyncPush()
  }

  function removeTask(id: string): void {
    tasks.value = tasks.value.filter((t) => t.id !== id)
    enqueueWrite(async () => (await adapter()).removeTask(id))
    scheduleSyncPush()
  }

  /** 拖拽跨象限（Spec §5.2）；记录调整供用户画像学习（拖拽偏好分析） */
  function moveTask(id: string, quadrant: Quadrant): void {
    const t = tasks.value.find((x) => x.id === id)
    if (!t || t.quadrant === quadrant) return
    const from = t.quadrant // 先保存旧象限：patchTask 会原地改 t.quadrant，避免记录成“同象限”
    patchTask(id, { quadrant })
    useProfileStore().recordDrag({ ts: Date.now(), title: t.title, from, to: quadrant })
  }

  function toggleCompleted(id: string): void {
    const t = tasks.value.find((x) => x.id === id)
    if (!t) return
    t.completedAt = t.completedAt === null ? Date.now() : null
    t.updatedAt = Date.now()
    enqueueWrite(async () => (await adapter()).updateTask(cloneTask(t)))
    scheduleSyncPush()
  }

  function addSubtask(taskId: string, title: string): void {
    const t = tasks.value.find((x) => x.id === taskId)
    if (!t) return
    t.subtasks.push({ id: uuid(), title: title.trim().slice(0, 120), done: false })
    t.updatedAt = Date.now() // 级联更新 updatedAt（Spec §9.1）
    enqueueWrite(async () => (await adapter()).updateTask(cloneTask(t)))
    scheduleSyncPush()
  }

  function toggleSubtask(taskId: string, subtaskId: string): void {
    const t = tasks.value.find((x) => x.id === taskId)
    const s = t?.subtasks.find((x) => x.id === subtaskId)
    if (!t || !s) return
    s.done = !s.done
    t.updatedAt = Date.now()
    enqueueWrite(async () => (await adapter()).updateTask(cloneTask(t)))
    scheduleSyncPush()
  }

  function removeSubtask(taskId: string, subtaskId: string): void {
    const t = tasks.value.find((x) => x.id === taskId)
    if (!t) return
    t.subtasks = t.subtasks.filter((s) => s.id !== subtaskId)
    t.updatedAt = Date.now()
    enqueueWrite(async () => (await adapter()).updateTask(cloneTask(t)))
    scheduleSyncPush()
  }

  /** 整表替换（载入演示数据 / 清空全部 / 远端同步），其余变更走增量写 */
  function replaceAll(list: Task[]): void {
    tasks.value = list
    enqueueWrite(async () => (await adapter()).replaceAll(list.map(cloneTask)))
    scheduleSyncPush()
  }

  /** 手动立即同步（设置面板/手机同步按钮）：拉取云端 → 合并 → 本地写 + 推送 */
  async function syncNow(): Promise<{ ok: boolean; message: string }> {
    if (!isLoggedIn()) return { ok: false, message: '请先登录' }
    try {
      const remote = await pullIfLoggedIn()
      const merged = mergeTasks(tasks.value, remote)
      replaceAll(merged)
      return { ok: true, message: `同步完成，共 ${merged.length} 条任务` }
    } catch (e) {
      return { ok: false, message: `同步失败：${e instanceof Error ? e.message : e}` }
    }
  }

  return {
    tasks,
    loaded,
    saveErrors,
    counts,
    totalCount,
    init,
    addTask,
    patchTask,
    removeTask,
    moveTask,
    toggleCompleted,
    addSubtask,
    toggleSubtask,
    removeSubtask,
    replaceAll,
    syncNow,
  }
})
