import { createApp } from 'vue';
import App from './App.vue';
import { ensureRustKernel } from '@/shared/rust-kernel';

// Tailwind first, then custom tokens
import '../styles/tailwind.css';

void ensureRustKernel().then(() => createApp(App).mount('#app'));
