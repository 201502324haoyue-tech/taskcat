import { defineStore } from 'pinia'
import { ref } from 'vue'

export type ToastKind = 'info' | 'success' | 'warn' | 'error'

export interface Toast {
  id: number
  kind: ToastKind
  message: string
}

export const useToastsStore = defineStore('toasts', () => {
  const toasts = ref<Toast[]>([])
  let seq = 0

  function add(kind: ToastKind, message: string, durationMs: number = 3600): number {
    const id = ++seq
    toasts.value.push({ id, kind, message })
    window.setTimeout(() => dismiss(id), durationMs)
    return id
  }

  function dismiss(id: number): void {
    toasts.value = toasts.value.filter((t) => t.id !== id)
  }

  return { toasts, add, dismiss }
})
