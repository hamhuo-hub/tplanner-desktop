import { defineConfig, build as viteBuild, type InlineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import electron from 'vite-plugin-electron'
import { copyFileSync, mkdirSync, existsSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'

const syncProxy = {
  '/tplanner': {
    target: process.env.TPLANNER_SYNC_PROXY_TARGET || 'https://sync.hamhuo.top',
    changeOrigin: true,
  },
}

// import.meta.dirname, not __dirname: Vite's coming native config loader rejects the shim.
const rootDir = import.meta.dirname
const ELECTRON_OUT_DIR = 'dist-electron'

/**
 * The Today widget is a built React page, but `main.js` still loads it with
 * loadFile('dist-electron/widget.html'). Building it as its own bundle keeps that path
 * untouched AND keeps it self-contained: no chunk is shared with the main window, so nothing
 * in dist-electron depends on dist/.
 *
 * `modulePreload.polyfill: false` is required, not cosmetic — widget.html declares
 * `script-src 'self'`, and that polyfill is an inline <script> the CSP refuses to run.
 */
const widgetBuild: InlineConfig = {
  configFile: false,
  root: rootDir,
  base: './',
  publicDir: false,
  plugins: [react()],
  build: {
    outDir: ELECTRON_OUT_DIR,
    emptyOutDir: false, // main.cjs and the preload bundles live here too
    modulePreload: { polyfill: false },
    rollupOptions: { input: { widget: resolve(rootDir, 'widget.html') } },
  },
}

type Watcher = { close(): Promise<void> }

/**
 * The widget build owns dist-electron/assets and widget.html outright. Clearing them first
 * matters because emptyOutDir stays false (main.cjs and the preloads share the directory), so
 * a rebuild would otherwise leave the previous hashed bundles behind for electron-builder to
 * package.
 */
function cleanWidgetOutput() {
  rmSync(resolve(rootDir, ELECTRON_OUT_DIR, 'assets'), { recursive: true, force: true })
  rmSync(resolve(rootDir, ELECTRON_OUT_DIR, 'widget.html'), { force: true })
}

/**
 * Builds the today widget. `vite dev` keeps a watcher so editing widget source rebuilds
 * dist-electron/widget.html; the assets used to be copied once at buildStart, so a change
 * needed a dev-server restart.
 */
function widgetRenderer(): Plugin {
  let command: 'build' | 'serve' = 'build'
  let watcher: Watcher | undefined
  return {
    name: 'tplanner:widget-renderer',
    configResolved(config) { command = config.command },
    async buildStart() {
      if (command !== 'serve' || watcher) return
      cleanWidgetOutput()
      watcher = await viteBuild({
        ...widgetBuild,
        build: { ...widgetBuild.build, watch: {} },
      }) as unknown as Watcher
    },
    async closeBundle() {
      if (command !== 'build') return
      cleanWidgetOutput()
      await viteBuild(widgetBuild)
    },
  }
}

/**
 * The Notes widget is still a plain renderer built from electron/, so its files — and the
 * token exports and shared window CSS it loads — are copied verbatim next to the bundles.
 * This plugin disappears when the Notes widget moves to React.
 */
function copyLegacyNotesAssets(): Plugin {
  const files: Array<[string, string]> = [
    ['electron/notes-widget.html', 'notes-widget.html'],
    ['electron/notes-widget.js', 'notes-widget.js'],
    ['electron/notes-widget.css', 'notes-widget.css'],
    ['electron/marked.umd.js', 'marked.umd.js'],
    ['electron/widget-shared.mjs', 'widget-shared.mjs'],
    ['src/widgets/shared-widget.css', 'shared-widget.css'],
    ['design-assets/tokens/generated/tplanner-light.css', 'tplanner-light.css'],
    ['design-assets/tokens/generated/tplanner-light.mjs', 'tplanner-light.mjs'],
  ]
  const copy = () => {
    const outDir = resolve(rootDir, ELECTRON_OUT_DIR)
    if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true })
    for (const [from, to] of files) {
      copyFileSync(resolve(rootDir, from), resolve(outDir, to))
    }
  }
  return {
    name: 'tplanner:copy-legacy-notes-assets',
    buildStart() { copy() }, // dev mode
    closeBundle() { copy() }, // production build
  }
}

export default defineConfig({
  base: './',

  // Keep API requests same-origin in the browser while developing locally.
  server: { proxy: syncProxy },
  preview: { proxy: syncProxy },

  // Force a single copy of these packages — prevents "multiple React instances"
  // and "@emotion/react already loaded" warnings when some deps bundle their own.
  resolve: {
    dedupe: [
      'react',
      'react-dom',
      '@emotion/react',
      '@emotion/styled',
      '@emotion/cache',
      '@emotion/serialize',
    ],
  },

  optimizeDeps: {
    include: [
      'react',
      'react-dom',
      '@emotion/react',
      '@emotion/styled',
    ],
  },

  plugins: [
    react(),
    copyLegacyNotesAssets(),
    widgetRenderer(),
    electron([
      {
        // Main process
        entry: 'electron/main.js',
        onstart(options) {
          try { options.startup(); } catch { /* Electron process may have exited */ }
        },
        vite: {
          build: {
            sourcemap: true,
            outDir: 'dist-electron',
            lib: { entry: 'electron/main.js', formats: ['cjs'] },
            rollupOptions: {
              external: ['electron'],
              output: { format: 'cjs', entryFileNames: '[name].cjs' },
            },
          },
        },
      },
      {
        // Main-window preload
        entry: 'electron/preload.js',
        onstart(options) {
          try { options.reload(); } catch { /* Electron process may have exited */ }
        },
        vite: {
          build: {
            sourcemap: true,
            outDir: 'dist-electron',
            lib: { entry: 'electron/preload.js', formats: ['cjs'] },
            rollupOptions: {
              external: ['electron'],
              output: { format: 'cjs', entryFileNames: '[name].cjs' },
            },
          },
        },
      },
      {
        // Today-widget preload
        entry: 'electron/widget-preload.js',
        onstart(options) {
          try { options.reload(); } catch { /* Electron process may have exited */ }
        },
        vite: {
          build: {
            sourcemap: true,
            outDir: 'dist-electron',
            lib: { entry: 'electron/widget-preload.js', formats: ['cjs'] },
            rollupOptions: {
              external: ['electron'],
              output: { format: 'cjs', entryFileNames: '[name].cjs' },
            },
          },
        },
      },
      {
        // Notes-widget preload
        entry: 'electron/notes-widget-preload.js',
        onstart(options) {
          try { options.reload(); } catch { /* Electron process may have exited */ }
        },
        vite: {
          build: {
            sourcemap: true,
            outDir: 'dist-electron',
            lib: { entry: 'electron/notes-widget-preload.js', formats: ['cjs'] },
            rollupOptions: {
              external: ['electron'],
              output: { format: 'cjs', entryFileNames: '[name].cjs' },
            },
          },
        },
      },
    ]),
  ],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
