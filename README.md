# tPlanner Desktop + Web

`master` 只承载桌面端、Web 前端与共享 Sync V5 协议核心。Android/Wear 在
`mobile_andorid`，中央服务在 `sync_server`；三个分支共用
`sync-v5/`（`jcal.mjs`、`ics.mjs`、`protocol/v5/*.schema.json`），CI 要求其内容逐字节一致。

## 同步架构（Sync V5）

**本机持久化的事实单元就是 RFC 7265 jCal 文档本身**（`sync-v5/jcal.mjs`）。
没有第二套 Task/Event 模型：UI 读的是「服务器镜像 + 仍未确认的本地文档」这一个投影
（`src/syncV5/store.js` 的 `project()`），编辑走 `JcalDocument.with*()` 写回同一个数组。

客户端只做三件事：

1. `save`：把未改动的 jCal 文档与出站操作一起落盘（IndexedDB `tplanner-v5`），
   落盘完成后才向 UI 报告保存成功。
2. `flush`：任何时候只有一个不可变的 in-flight 命令；传输结果不确定时用相同的
   `commandId` 与 `sequence` 重试同一份字节。未发送的同一 UID 编辑会合并为一条命令。
3. `pull`：前台/手动刷新与有界周期刷新都拉取完整快照，并在单个事务内原子安装。

冲突与拒绝（`conflict` / `rejected`）会连同本地文档一起保留，提供明确的
**放弃 / 重新提交** 两个动作；`serverId` 变化或修订号回退只会给出显式的
「重置连接」选择，绝不静默覆盖本机状态。没有 delta 编解码、没有长轮询、
没有通知通道、没有 V3/V4 端点或兼容读取器。

生产地址：

- Sync V5：`https://sync.hamhuo.top/tplanner/v5`
- 客户端：Android / Wear APK 与 Electron 桌面端。**不再有 Web 版**：
  桌面端与曾经的网页版共用同一份渲染层，但只有 Electron 会被分发。

## 目录

- `sync-v5/` — 冻结的三端共享契约（jCal 文档核心、ICS 导出、协议 JSON Schema）。
- `src/syncV5/` — 客户端同步：`store.js`（持久化与投影）、`transport.js`（两个 HTTP 调用）、
  `sync.js`（引擎）、`session.js`（地址与令牌）、`document.js`（只读 jCal 解释 + 视图分组）、
  `ics.js`（走 `sync-v5/ics.mjs` 的导出）、`platform.js`（Electron 外壳边界）。
- `electron/` — 纯外壳：窗口、托盘、便签窗口。主进程不保存任务模型，只接收渲染进程推送的
  只读投影，并把便签交互作为 intent 回传。

## 本地开发

```bash
npm ci
npm run dev
npm run build
```

Vite 开发服务器把 `/tplanner` 代理到 `TPLANNER_SYNC_PROXY_TARGET`（默认
令牌只以 `Authorization` 头发出。

## 分支边界

- 本分支不包含或部署 `sync-server/`，也不再包含 `src/syncV3/` 或 `sync-v3/`。
- 禁止重新引入 `/tplanner/v3`、`/tplanner/events`、`/journals`、`/changes` 等路由。
- 任务事实只能存在于规范 jCal 文档里：不得在传输元数据、SQL 列、适配器或第二个可变
  Task 模型中重复；未知的标准/扩展属性必须原样保留。
