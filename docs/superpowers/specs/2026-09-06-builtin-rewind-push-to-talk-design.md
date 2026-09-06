# 内置 Rewind 与 Push-to-Talk 设计文档

日期：2026-09-06
状态：已批准（少爷确认方案A与左Alt全局按键）

## 背景与目标

仓库内的 `plugins/claude-rewind` 与 `plugins/push-to-talk` 以插件形态分发，新鲜克隆无法直接使用：

1. `.env`（指向仓库 `plugins/` 目录的 `QIU_PLUGINS_DIR`）被 gitignore，非桌面壳启动时插件目录回退到 `~/.claude-code-ui/plugins`（新机器为空）；
2. 插件需要激活步骤（进入标签页/安装依赖）；
3. `src/lib/rewindRpc.ts` 的消费方（用户消息回退按钮、**编辑重发**）都依赖插件 RPC 在线——插件不可用时编辑重发同样是坏的。

目标：两个功能内置为原生模块，克隆 → `npm install` → 启动即用；插件系统基建保留给未来第三方插件。

## 方案A（已采纳）：全原生移植

### 1. rewind 服务端（新建 `server/modules/rewind/`）

- `rewind.service.ts`：移植 `plugins/claude-rewind/server.js` 全部纯函数（TS 化）：
  `normalizeForMatch` / `toEpochMs` / `locateTargetMessage` / `buildRestorePlan` / 转录读取 / 截断（`.bak-rewind-<ts>` 备份）/ 恢复执行。
- 原生化改造两点：
  - 会话查询改用宿主 `sessionsDb`（不再用 better-sqlite3 直读 `~/.cloudcli/auth.db`）；
  - 截断守卫随迁：`chatRunRegistry.isProcessing(sessionId) || providerRuntimeService.hasActiveProcess('claude', sessionId)` 时拒绝 rewind（409，含后台 hold 窗口）。
- `rewind.routes.ts`：`POST /api/rewind/locate`、`POST /api/rewind/execute`，复用现有 JWT 认证中间件；请求/响应 JSON 形状与插件 RPC 完全一致。
- 挂载进 `server/index.ts` 路由表。

### 2. rewind 前端

- `src/lib/rewindRpc.ts`：`RPC_BASE` 改为 `/api/rewind`，函数签名不变（`rewindLocate`/`rewindExecute` 消费方零改动）。
- `MessageComponent.tsx`：用户消息行渲染原生 ⟲ 按钮（SVG 图标沿用插件版），确认对话框用项目现有对话框组件；定位参数沿用 `data-message-timestamp` + 气泡文本前缀。
- 回退完成后不再 `location.reload()`：会话 store 新增 `resetSlot(sessionId)`，回退成功后清 realtime + 槽位重置 + 强制重取历史。

### 3. push-to-talk 前端

- `useVoiceInput` 扩展 hold 模式：按住 ≥250ms 进入录音，未到阈值轻点不触发；`start/stop` 复用现有实现。
- 左 Alt 全局监听挂在 ChatComposer 层：
  - 输入框未聚焦时先聚焦输入框（textareaRef）；
  - Esc 取消本次录音；IME（isComposing/229）保护；仅认左 Alt（AltLeft）；按住期间混入其他键（Alt+Tab 等）放弃本次；
  - 录音/识别状态用 React 渲染角落悬浮条。
- `VoiceSettingsTab` 新增「按住说话」设置块：开关（默认开）+ 键位选择（左 Alt / 空格长按 / Ctrl+M），存入现有 `voiceConfig` localStorage 结构。

### 4. 插件清理

- 删除 `plugins/claude-rewind/`、`plugins/push-to-talk/`；插件系统基建（registry/安装 UI/RPC 代理）保留。
- `plugins.routes.ts` 中 rewind 专用守卫迁出，通用 RPC 代理不变。
- README 与相关文档中插件激活说明同步更新。

### 5. 兼容性说明

- `~/.claude-code-ui/plugins.json` 中的旧启用记录无需迁移（插件删除后自然失效）。
- 已装插件目录（用户机器上若有）不受影响，但宿主不再内置这两款。

## 验收标准

1. 纯函数单测全过（含从插件迁入的 locate/restore 用例）；现有全量 server/client 测试不回归；typecheck/lint 干净。
2. 新鲜克隆验收：`git clone → npm install → npm run dev`（不建 .env）→ 回退按钮可用、编辑重发可用、左 Alt 按住说话可用。
3. 行为与插件版一致：截断计数、文件恢复/删除统计、`.bak-rewind-*` 备份、±2s 时间戳容差、活跃分支挑选。
