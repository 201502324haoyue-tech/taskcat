<script setup lang="ts">
import { useUiStore } from '@/stores/ui'
import { isCapacitor, isTauri } from '@/utils/tauri'

/**
 * 「托盘」模拟（Spec §3.3 / §8）：
 * - 浏览器原型：右下角药丸模拟（点击恢复面板）。
 * - Tauri 桌面：真实系统托盘由 Rust 提供（tauri tray-icon），此组件不渲染。
 * - 手机端（Capacitor）：无托盘概念，不渲染。
 */
const ui = useUiStore()
</script>

<template>
  <Teleport to="body">
    <div
      v-if="ui.minimized && !isTauri() && !isCapacitor()"
      class="animate-tray-bounce fixed bottom-3 right-3 z-[80] cursor-pointer"
      title="恢复主面板（浏览器原型模拟系统托盘）"
      @click="ui.restore()"
    >
      <div class="glass-panel flex items-center gap-2 px-3 py-2">
        <span class="text-[16px]">🐱</span>
        <span class="text-[11px] text-slate-200">Eisenhower Pet — 恢复</span>
      </div>
    </div>
  </Teleport>
</template>
