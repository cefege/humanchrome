import { createApp } from 'vue';
import { NativeMessageType } from 'humanchrome-shared';
import './style.css';
import '../sidepanel/styles/agent-chat.css';
import { preloadAgentTheme } from '../sidepanel/composables/useAgentTheme';
import App from './App.vue';
import { ensureRustKernel } from '@/shared/rust-kernel';

// Preload the theme before Vue mounts to avoid a flash on first paint.
Promise.all([preloadAgentTheme(), ensureRustKernel()]).then(() => {
  // Trigger ensure native connection (fire-and-forget, don't block UI mounting)
  void chrome.runtime.sendMessage({ type: NativeMessageType.ENSURE_NATIVE }).catch(() => {
    // Silent failure - background will handle reconnection
  });
  createApp(App).mount('#app');
});
