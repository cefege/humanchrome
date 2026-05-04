<template>
  <div class="flex items-center gap-2">
    <svg
      v-if="isRunning && !hideIcon"
      class="loading-scribble w-4 h-4 flex-shrink-0"
      viewBox="0 0 100 100"
      fill="none"
    >
      <path
        d="M50 50 C50 48, 52 46, 54 46 C58 46, 60 50, 60 54 C60 60, 54 64, 48 64 C40 64, 36 56, 36 48 C36 38, 44 32, 54 32 C66 32, 74 42, 74 54 C74 68, 62 78, 48 78 C32 78, 22 64, 22 48 C22 30, 36 18, 54 18 C74 18, 88 34, 88 54 C88 76, 72 92, 50 92"
        stroke="var(--ac-accent, #D97757)"
        stroke-width="3"
        stroke-linecap="round"
      />
    </svg>

    <span
      class="text-xs italic"
      :class="{ 'text-shimmer': isRunning }"
      :style="{ color: isRunning ? undefined : 'var(--ac-text-muted)' }"
    >
      {{ displayText }}
    </span>
  </div>
</template>

<script lang="ts" setup>
import { ref, computed, onMounted, onUnmounted, watch } from 'vue';
import type { TimelineItem } from '../../../composables/useAgentThreads';
import { getRandomLoadingText } from '../../../utils/loading-texts';

const props = defineProps<{
  item: Extract<TimelineItem, { kind: 'status' }>;
  /** Hide the loading icon (when parent component displays it in timeline node position) */
  hideIcon?: boolean;
}>();

const isRunning = computed(
  () => props.item.status === 'running' || props.item.status === 'starting',
);

const randomText = ref(getRandomLoadingText());

let timeoutId: ReturnType<typeof setTimeout> | null = null;

let wasRunning = false;

function startInterval(): void {
  if (timeoutId) return;
  // Random 5-8s interval between text updates
  const scheduleNext = () => {
    timeoutId = setTimeout(
      () => {
        randomText.value = getRandomLoadingText();
        scheduleNext();
      },
      5000 + Math.random() * 3000,
    );
  };
  scheduleNext();
}

function stopInterval(): void {
  if (timeoutId) {
    clearTimeout(timeoutId);
    timeoutId = null;
  }
}

// Only react when running state actually transitions, to avoid resetting text mid-run
watch(isRunning, (running) => {
  if (running && !wasRunning) {
    randomText.value = getRandomLoadingText();
    startInterval();
  } else if (!running && wasRunning) {
    stopInterval();
  }
  wasRunning = running;
});

onMounted(() => {
  wasRunning = isRunning.value;
  if (isRunning.value) {
    startInterval();
  }
});

onUnmounted(() => {
  stopInterval();
});

const defaultText = computed(() => {
  switch (props.item.status) {
    case 'completed':
      return 'Done';
    case 'error':
      return 'Error';
    case 'cancelled':
      return 'Cancelled';
    default:
      return 'Ready';
  }
});

const displayText = computed(() => {
  if (isRunning.value) {
    return randomText.value;
  }
  return props.item.text || defaultText.value;
});
</script>
