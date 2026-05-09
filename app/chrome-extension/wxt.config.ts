import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';
import { viteStaticCopy } from 'vite-plugin-static-copy';
import { config } from 'dotenv';
import { resolve } from 'path';
import Icons from 'unplugin-icons/vite';
import Components from 'unplugin-vue-components/vite';
import IconsResolver from 'unplugin-icons/resolver';

config({ path: resolve(process.cwd(), '.env') });
config({ path: resolve(process.cwd(), '.env.local') });

const CHROME_EXTENSION_KEY = process.env.CHROME_EXTENSION_KEY;
// Detect dev mode early for manifest-level switches
const IS_DEV = process.env.NODE_ENV !== 'production' && process.env.MODE !== 'production';

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-vue'],
  runner: {
    // Disable auto-launch (recommended).
    disabled: true,

    // To auto-launch Chrome against your existing profile instead, uncomment below.
    // chromiumArgs: [
    //   '--user-data-dir=' + homedir() + (process.platform === 'darwin'
    //     ? '/Library/Application Support/Google/Chrome'
    //     : process.platform === 'win32'
    //     ? '/AppData/Local/Google/Chrome/User Data'
    //     : '/.config/google-chrome'),
    //   '--remote-debugging-port=9222',
    // ],
  },
  manifest: {
    // Use environment variable for the key, fallback to undefined if not set
    key: CHROME_EXTENSION_KEY,
    default_locale: 'en',
    name: '__MSG_extensionName__',
    description: '__MSG_extensionDescription__',
    permissions: [
      'nativeMessaging',
      'tabs',
      'tabGroups',
      'activeTab',
      'scripting',
      'contextMenus',
      'downloads',
      'webRequest',
      'webNavigation',
      'debugger',
      'history',
      'bookmarks',
      'cookies',
      'offscreen',
      'storage',
      'alarms',
      'pageCapture',
      'notifications',
      'power',
      'sessions',
      'idle',
      'browsingData',
      'proxy',
      'identity',
      'declarativeNetRequestWithHostAccess',
      // Allow programmatic control of Chrome Side Panel
      'sidePanel',
    ],
    host_permissions: ['<all_urls>'],
    // OAuth2 client for chrome.identity.getAuthToken (chrome_identity tool).
    // Set HUMANCHROME_OAUTH_CLIENT_ID at build time to enable Google OAuth
    // flows. Until that env var is set the placeholder is loaded as-is and
    // the tool surfaces an INVALID_ARGS error pointing at this manifest
    // entry — no silent 401s.
    oauth2: {
      client_id: process.env.HUMANCHROME_OAUTH_CLIENT_ID || '__SET_HUMANCHROME_OAUTH_CLIENT_ID__',
      scopes: [],
    },
    options_ui: {
      page: 'options.html',
      open_in_tab: true,
    },
    action: {
      default_popup: 'popup.html',
      default_title: 'HumanChrome',
    },
    // Chrome Side Panel entry for workflow management
    // Ref: https://developer.chrome.com/docs/extensions/reference/api/sidePanel
    side_panel: {
      default_path: 'sidepanel.html',
    },
    // Keyboard shortcuts for quick triggers
    commands: {
      // run_quick_trigger_1: {
      //   suggested_key: { default: 'Ctrl+Shift+1' },
      //   description: 'Run quick trigger 1',
      // },
      // run_quick_trigger_2: {
      //   suggested_key: { default: 'Ctrl+Shift+2' },
      //   description: 'Run quick trigger 2',
      // },
      // run_quick_trigger_3: {
      //   suggested_key: { default: 'Ctrl+Shift+3' },
      //   description: 'Run quick trigger 3',
      // },
      // open_workflow_sidepanel: {
      //   suggested_key: { default: 'Ctrl+Shift+O' },
      //   description: 'Open workflow sidepanel',
      // },
      toggle_web_editor: {
        suggested_key: { default: 'Ctrl+Shift+O', mac: 'Command+Shift+O' },
        description: 'Toggle Web Editor mode',
      },
      toggle_quick_panel: {
        suggested_key: { default: 'Ctrl+Shift+U', mac: 'Command+Shift+U' },
        description: 'Toggle Quick Panel AI Chat',
      },
    },
    web_accessible_resources: [
      {
        resources: [
          '/models/*', // expose everything under public/models/
          '/workers/*', // expose worker scripts
          '/inject-scripts/*', // expose helpers injected by content scripts
        ],
        matches: ['<all_urls>'],
      },
    ],
    // The strict CSP/COOP/COEP policies below would block the dev server's
    // resource loading, so they are applied to production builds only and
    // the dev build keeps WXT's default policy.
    ...(IS_DEV
      ? {}
      : {
          cross_origin_embedder_policy: { value: 'require-corp' as const },
          cross_origin_opener_policy: { value: 'same-origin' as const },
          content_security_policy: {
            // Allow inline styles injected by Vite (compiled CSS) and data images used in UI thumbnails.
            // `connect-src` allows fetching the JSEP/WebGPU ONNX wasm from jsDelivr on demand
            // (the local 22 MB file is intentionally not bundled — see workers/similarity.worker.js).
            extension_pages:
              "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' https://cdn.jsdelivr.net https://huggingface.co;",
          },
        }),
  },
  vite: (env) => ({
    plugins: [
      // TailwindCSS v4 Vite plugin – no PostCSS config required
      tailwindcss(),
      // Auto-register SVG icons as Vue components; all icons are bundled locally
      Components({
        dts: false,
        resolvers: [IconsResolver({ prefix: 'i', enabledCollections: ['lucide', 'mdi', 'ri'] })],
      }) as any,
      Icons({ compiler: 'vue3', autoInstall: false }) as any,
      // Ensure static assets are available as early as possible to avoid race conditions in dev
      // Copy workers/_locales/inject-scripts into the build output before other steps
      viteStaticCopy({
        targets: [
          {
            src: 'inject-scripts/*.js',
            dest: '.',
          },
          {
            src: ['workers/*'],
            dest: '.',
          },
          {
            src: '_locales/*/messages.json',
            dest: '.',
          },
        ],
        // Use writeBundle so outDir exists for dev and prod
        hook: 'writeBundle',
        // Enable watch so changes to these files are reflected during dev
        watch: {
          // Use default patterns inferred from targets; explicit true enables watching
          // Vite plugin will watch src patterns and re-copy on change
        } as any,
      }) as any,
    ],
    build: {
      // Build output must remain ES2015-compatible.
      target: 'es2015',
      // Generate sourcemaps outside of production.
      sourcemap: env.mode !== 'production',
      // Skip gzip-size reporting; compressing large bundles is slow.
      reportCompressedSize: false,
      // Warn when a chunk exceeds 1500 KB.
      chunkSizeWarningLimit: 1500,
      // Minify only for production builds; keep dev unminified for easier debugging.
      minify: env.mode === 'production' ? 'esbuild' : false,
    },
    // `onnxruntime-web` 1.26+ ships a "bundle" entry that materialises its
    // ~24 MB WASM as a `new URL(..., import.meta.url)` reference, which
    // Rolldown then base64-inlines into `background.js` (50 MB+ regression).
    // Opt into the package's `onnxruntime-web-use-extern-wasm` condition so
    // the wasm files stay external and are loaded at runtime via the path
    // configured on `env.backends.onnx.wasm.wasmPaths`.
    resolve: {
      conditions: ['onnxruntime-web-use-extern-wasm'],
    },
    optimizeDeps: {
      // markstream-vue lists several heavy peers (katex, mermaid, monaco-editor,
      // vue-i18n, stream-markdown) as optional. We don't use them, so exclude
      // from Vite's dep optimizer to suppress noisy warnings.
      exclude: ['katex', 'mermaid', 'monaco-editor', 'vue-i18n', 'stream-markdown'],
    },
  }),
});
