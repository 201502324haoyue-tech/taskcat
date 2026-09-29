<script setup lang="ts">
import { QUADRANTS } from '@/types/task'
import QuadrantCard from './QuadrantCard.vue'

/** 展开态 2×2 四象限矩阵（Spec §5.2） */
</script>

<template>
  <div class="grid h-full grid-cols-2 grid-rows-2 gap-2">
    <QuadrantCard v-for="q in QUADRANTS" :key="q" :quadrant="q" />
  </div>
</template>
