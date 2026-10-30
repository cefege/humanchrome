import { createApp } from 'vue';
import App from './App.vue';
import { ensureRustKernel } from '@/shared/rust-kernel';

void ensureRustKernel().then(() => createApp(App).mount('#app'));
