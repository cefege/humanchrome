<template>
  <div class="form-section">
    <div class="form-group">
      <label class="form-label">Element selector (optional)</label>
      <input
        class="form-input"
        v-model="(node as any).config.selector"
        placeholder="CSS selector"
      />
    </div>
    <div class="form-group">
      <label class="form-label">Attribute</label>
      <input
        class="form-input"
        v-model="(node as any).config.attr"
        placeholder="text/textContent or attribute name"
      />
    </div>
    <div class="form-group">
      <label class="form-label">Custom JS (returned value)</label>
      <textarea
        class="form-textarea"
        v-model="(node as any).config.js"
        rows="3"
        placeholder="return document.title"
      ></textarea>
    </div>
    <div class="form-group" :class="{ invalid: !(node as any).config?.saveAs }">
      <label class="form-label">Save as variable</label>
      <input class="form-input" v-model="(node as any).config.saveAs" placeholder="Variable name" />
    </div>
  </div>
</template>

<script lang="ts" setup>
import type { NodeBase } from '@/entrypoints/background/record-replay/types';
defineProps<{ node: NodeBase }>();
</script>

<style scoped></style>
