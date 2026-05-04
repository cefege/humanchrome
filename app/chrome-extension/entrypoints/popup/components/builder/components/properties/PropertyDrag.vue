<template>
  <div>
    <SelectorEditor :node="node" :allowPick="true" title="Start selector" targetKey="start" />
    <SelectorEditor :node="node" :allowPick="true" title="End selector" targetKey="end" />
    <div class="hint">
      <small
        >Tip: the path is auto-generated during recording; leave it blank when creating
        manually.</small
      >
    </div>
  </div>
</template>

<script lang="ts" setup>
/* eslint-disable vue/no-mutating-props */
import type { NodeBase } from '@/entrypoints/background/record-replay/types';
import SelectorEditor from './SelectorEditor.vue';

defineProps<{ node: NodeBase }>();
</script>

<style scoped>
.hint {
  color: #64748b;
  margin-top: 8px;
}
</style>
