# Desktop Today 小窗 React 化

日期：2026-09-17。范围：Today 便签的 renderer 从手写 vanilla 迁到与主窗口同一套 React /
令牌 / 构建管线的页面。Sync V5、Electron IPC、preload 契约、`electron/main.js` 均未修改。

## 为什么改

迁移前桌面端有两类 renderer：主窗口是 React，两个便签是手写 DOM，并通过 `vite.config.ts`
里手工维护的 9 文件复制清单进入 `dist-electron/`。Today 只消费只读 projection、只发
intent，是验证「Vite 多入口 + React + 现有 preload」的最小对象，所以先迁它。

## 文件变化

| 之前 | 现在 |
| --- | --- |
| `electron/widget.html` | `widget.html`（仓库根，Vite 入口；产物落到 `dist-electron/widget.html`） |
| `electron/widget.js` | `src/widgets/TodayWidget.jsx` + `WidgetRoot.jsx` + `useWidgetWindow.js` + `today.jsx` |
| `electron/widget.css` | `src/widgets/widget.css` |
| `electron/shared-widget.css` | `src/widgets/shared-widget.css` |
| `widget-shared.mjs` 的 `initializeWindowControls` | `useWidgetWindow()` hook（Notes 仍用旧 MJS） |
| `widget-shared.mjs` 的 `applyCategory` | 行内 `--category-*` 自定义属性 + `data-category-id`，分类读 `src/design-system/tokens.js` 的 `categoryForId` |

`main.js` 依旧 `loadFile('dist-electron/widget.html')`，preload 与 IPC 通道名一字未改。
Vite 侧新增 `widgetRenderer()`：开发时以 watch 模式构建，生产时在应用构建后构建一次，两者
都先清空自己拥有的 `dist-electron/assets` 与 `widget.html`。`copyWidgetAssets()` 收缩为
`copyLegacyNotesAssets()`——它现在只服务尚未迁移的 Notes 小窗，将随 Notes 迁移一起删除。

产物刻意与 `dist/` 不共享 chunk：Today 页面 238 KB JS + 30 KB CSS（含 React 与令牌），
换来 `dist-electron/` 不依赖 `dist/`。

`modulePreload.polyfill` 必须为 `false`：Vite 默认注入的内联 polyfill 会被窗口自己的
`script-src 'self'` 拒绝，页面会白屏。

## 行为 parity 验证

同一份 review fixture（修正契约后，见下）分别驱动 HEAD 的 vanilla 版本与新的 React 版本：

| 检查 | 方法 | 结果 |
| --- | --- | --- |
| 渲染结构 | 无头 Chrome `--dump-dom`，规范化 `#app` 子树后 diff | 除下述两项外完全一致 |
| 数据分组 | 固定时钟 14:00 + 17 条构造数据 | 分组、计数、排序、「任务 1/17 · 14:00」全部一致 |
| 交互 intent | 脚本真实点击并记录桥接调用 | 11 步全部一致：阻塞父项不发 intent、子项发 `toggleSubtask(now,sub-a)`、非阻塞父项发 `toggleTask(...)`、徽标只折叠不发 intent、pin/open/close 一致 |
| 无乐观更新 | 点击后立刻读 `aria-checked` | 一致：状态只随新 projection 变化 |
| 折叠持久化 | 点已完成分组头，读 `localStorage` | 一致：写入 `true` / `false` |
| 加载 / 空 / 无 bridge 三个分支 | 分别用挂起 Promise、空数组、不注入 fixture | 三个状态的 DOM 与文案完全一致 |
| 真实窗口 | Electron `loadFile` + 真 preload + 严格 CSP | `#app` = HEADER/MAIN/FOOTER、bridge 为 object、令牌生效（canvas `#e5e8ed`）、控件 36px、控制台零输出 |

规范化后仍存在的差异只有两类，都是删除死代码：旧版为 vanilla 的 `getElementById` 服务的
`id`（`hdr-date`、`hdr-sub`、`btn-pin`、`btn-open`、`btn-close`、`stats`、`btn-refresh`）不再
输出；React 为按钮补了 `type="button"`。

**唯一有意的行为差异**：子任务折叠状态现在存在组件里，因此能活过一次 re-render。旧实现在
每次 projection 和每 30 秒整表重建，用户折叠掉的清单会被静默重新展开。

## 未做与后续

- Notes 小窗仍是 vanilla；`src/widgets/shared-widget.css`、`widget-shared.mjs`、vendored
  `marked.umd.js` 都要等它迁移后才能删。Markdown 渲染也应在那一步从 `NoteEditor` 与
  `notes-widget.js` 里抽成共享函数。
- Today 的中文文案仍内联在组件里。接 i18n 会改变语言探测行为，属于单独一次改动。
- `scripts/widget-review-server.mjs` 的 Today fixture 之前停留在旧契约（ISO 时间字符串、
  用 `id` 而非 `uid`、缺 `dateKey`），列表恒为空；本批已按真实 projection 契约修正，并让它
  同时服务 `assets/` 下的构建产物。**Notes 那一半仍指向 V5 之前的接口**
  （`getJournals` / `onJournalUpdated` / `saveJournal`），评审页挂的是死 bridge，已在该文件
  留 TODO，应与 Notes 迁移一起修。
