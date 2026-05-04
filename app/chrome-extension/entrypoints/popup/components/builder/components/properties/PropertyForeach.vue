<template>
  <div class="form-section">
    <div class="form-group">
      <label class="form-label">List variable</label>
      <input
        class="form-input"
        v-model="(node as any).config.listVar"
        placeholder="workflow.list"
      />
    </div>
    <div class="form-group">
      <label class="form-label">Item variable name</label>
      <input
        class="form-input"
        v-model="(node as any).config.itemVar"
        placeholder="Default: item"
      />
    </div>
    <div class="form-group">
      <label class="form-label">Subflow ID</label>
      <input
        class="form-input"
        v-model="(node as any).config.subflowId"
        placeholder="Select or create subflow"
      />
      <button class="btn-sm" style="margin-top: 8px" @click="onCreateSubflow">New subflow</button>
    </div>
  </div>
</template>

<script lang="ts" setup>
import type { NodeBase } from '@/entrypoints/background/record-replay/types';

const props = defineProps<{ node: NodeBase }>();
const emit = defineEmits<{ (e: 'create-subflow', id: string): void }>();

function onCreateSubflow() {
  const id = prompt('Enter new subflow ID');
  if (!id) return;
  emit('create-subflow', id);
  const n = props.node as any;
  if (n && n.config) n.config.subflowId = id;
}
</script>

<style scoped></style>
