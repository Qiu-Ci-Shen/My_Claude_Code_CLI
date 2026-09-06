# 内置 Rewind 与 Push-to-Talk 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `plugins/claude-rewind` 与 `plugins/push-to-talk` 移植为原生功能，新鲜克隆零配置可用。

**Architecture:** rewind = 服务端新模块 `server/modules/rewind/`（纯函数 + IO + JWT 路由，复用 sessionsDb）+ 前端 `MessageComponent` 原生按钮（store 槽位重置替代整页刷新）；push-to-talk = ChatComposer 现有 voice 管线加 hold 键位层（useVoiceInput 复用，useVoiceConfig 加设置）。

**Tech Stack:** Node/Express、React、vitest-free（node:test + tsx，随 `npm test`）、现有 JWT `authenticateToken`。

## Global Constraints

- 仓库行尾 LF：新文件一律 LF；提交前 `git ls-files --eol` 抽查。
- 提交信息：`type(scope): 中文描述`，小写/中文开头（commitlint 拒大写开头）。
- 测试命令：`npx tsx --tsconfig server/tsconfig.json --test <files>`；全量 `npm test` / `npm run test:client`；校验 `npm run typecheck`、`npx eslint <paths>`。
- RPC 请求/响应 JSON 形状与插件版完全一致（`rewindRpc.ts` 消费方零改动）。
- 纯函数从 `plugins/claude-rewind/server.js` 移植时逻辑逐行保持，只做 TS 化与 IO 替换；不要"顺手优化"匹配算法。

---

### Task 1: rewind 服务端纯函数 + IO 层

**Files:**
- Create: `server/modules/rewind/rewind.service.ts`
- Test: `server/modules/rewind/tests/rewind.service.test.ts`
- Source: `plugins/claude-rewind/server.js:61-345`（移植母本）

**Interfaces (Produces):**
```ts
export function normalizeForMatch(text: unknown): string;          // server.js:90
export function toEpochMs(value: unknown): number | null;          // server.js:103
export function locateTargetMessage(entries: TranscriptEntry[], opts: { timestamp: unknown; textPrefix: unknown }): TranscriptEntry | null;  // server.js:145
export async function readTranscript(jsonlPath: string): Promise<TranscriptEntry[]>;  // server.js:61
export async function truncateTranscript(jsonlPath: string, entries: TranscriptEntry[], targetUuid: string): Promise<{ backupPath: string; dropped: number; kept: number }>;  // server.js:218
export function buildRestorePlan(entries: TranscriptEntry[], targetUuid: string, checkpointDir: string, body: { cwd?: string }): { restore: { filePath: string; backupPath: string }[]; remove: { filePath: string }[] };  // server.js:252
export async function applyRestorePlan(plan): Promise<{ restored: string[]; removed: string[]; errors: string[] }>;  // server.js:326
export type TranscriptEntry = Record<string, unknown> & { uuid?: string; parentUuid?: string | null; type?: string; timestamp?: unknown; isSidechain?: boolean; cwd?: string; sessionId?: string };
```

- [ ] **Step 1**: 写失败测试（用例从 `plugins/claude-rewind/tests/` 语义迁入；构造 entries 直接测 locate 三级放宽、active-branch 挑选、restore plan 快照/delta/laterPaths 规则、normalize 的 markdown 剥离）
- [ ] **Step 2**: `npx tsx --tsconfig server/tsconfig.json --test server/modules/rewind/tests/rewind.service.test.ts` → FAIL（模块不存在）
- [ ] **Step 3**: 移植实现（逻辑照抄 server.js，`fs` 改 `node:fs/promises` import 风格随宿主；不加任何新行为）
- [ ] **Step 4**: 测试 PASS
- [ ] **Step 5**: Commit `feat(rewind): 移植插件定位/截断/恢复纯函数为服务端模块`

### Task 2: rewind 路由 + 守卫 + 挂载

**Files:**
- Create: `server/modules/rewind/rewind.routes.ts`
- Create: `server/modules/rewind/index.ts`（barrel，eslint boundaries 要求）
- Modify: `server/index.ts`（挂载行，跟随 voice 路由风格：`app.use('/api/rewind', authenticateToken, rewindRoutes)`）
- Modify: `server/modules/plugins/plugins.routes.ts`（删除 claude-rewind 专用守卫块与 chatRunRegistry/providerRuntimeService 若无他用）

**Interfaces (Produces):**
- `POST /api/rewind/locate` `{ sessionId, timestamp, textPrefix }` → `{ found, uuid?, timestamp?, checkpointDir?, error? }`
- `POST /api/rewind/execute` `{ sessionId, targetUuid, restoreFiles, cwd? }` → `{ ok, targetUuid?, truncated?, files?, error? }`
- 守卫：execute 时 `chatRunRegistry.isProcessing(sessionId) || providerRuntimeService.hasActiveProcess('claude', sessionId)` → 409 `{ ok:false, error:'会话仍在生成中，请先打断再回退' }`
- 会话行：`sessionsDb.getSessionById(sessionId)` 取 `jsonl_path`/`provider_session_id`（替代插件裸读 auth.db）；checkpointDir = `~/.claude/file-history/<provider_session_id>`

- [ ] **Step 1**: 路由 + 守卫 + 挂载（handlers 组合 Task1 函数，错误统一 500 `{error}`；locate 缺会话/文件返回 `{found:false}`）
- [ ] **Step 2**: typecheck + 全量 `npm test` 不回归
- [ ] **Step 3**: Commit `feat(rewind): /api/rewind 原生路由与活跃运行守卫`

### Task 3: rewindRpc 切换端点

**Files:**
- Modify: `src/lib/rewindRpc.ts:10`（`RPC_BASE = '/api/rewind'`；注释同步：不再是插件 RPC）

- [ ] **Step 1**: 改常量与注释
- [ ] **Step 2**: `npm run test:client` 不回归
- [ ] **Step 3**: Commit `feat(rewind): rewindRpc 指向原生 /api/rewind（编辑重发解除插件依赖）`

### Task 4: 原生回退按钮 + resetSlot

**Files:**
- Modify: `src/stores/useSessionStore.ts`（新增 `resetSlot(sessionId)`：删除槽位 + notify；放入返回对象与 deps）
- Modify: `src/components/chat/view/subcomponents/MessageComponent.tsx`（meta 行 ✎ 旁加 ⟲ 按钮，SVG 沿用插件版；点击上抛 `onRewindMessage?.(message)`）
- Modify: `src/components/chat/view/subcomponents/ChatMessagesPane.tsx`（props 透传）
- Modify: `src/components/chat/view/ChatInterface.tsx`（实现 `handleRewindMessage`：确认对话框 → `rewindLocate` → `rewindExecute` → `sessionStore.resetSlot(sessionId)` → `requestLatestMessages`；结果 toast 复用现有提示模式）

**Interfaces:**
- Consumes: Task 2 路由（经 rewindRpc）、`resetSlot`
- Produces: `onRewindMessage?: (message: ChatMessage) => void`（MessageComponent/ChatMessagesPane props）

- [ ] **Step 1**: store.resetSlot + MessageComponent 按钮 + 透传链
- [ ] **Step 2**: ChatInterface 流程（含确认对话框，样式对齐应用主题 token）
- [ ] **Step 3**: typecheck + `npm run test:client`
- [ ] **Step 4**: Commit `feat(rewind): 用户消息原生回退按钮与应用内刷新`

### Task 5: push-to-talk hold 层

**Files:**
- Modify: `src/hooks/useVoiceConfig.ts`（`VoiceConfig` 增加 `pttEnabled: boolean; pttKey: 'alt' | 'space' | 'ctrlm'`；DEFAULTS `{pttEnabled: true, pttKey: 'alt'}`；read 过滤循环按字段类型校验）
- Create: `src/components/chat/hooks/usePushToTalk.ts`
- Modify: `src/components/chat/view/subcomponents/ChatComposer.tsx`（接线 + 悬浮指示条 + 未聚焦唤起）

**Interfaces:**
```ts
export function usePushToTalk(opts: {
  enabled: boolean;
  binding: 'alt' | 'space' | 'ctrlm';
  state: VoiceInputState;                 // 来自 useVoiceInput
  onHoldStart: () => void;                // → voiceInput.start()
  onHoldCancel: () => void;               // → voiceInput.stop()（取消语义）
  onHoldRelease: () => void;              // → voiceInput.stop()
  onActivateComposer: () => void;         // → textareaRef focus
}): void;
```
行为规格（照搬 `plugins/push-to-talk/index.js` 键位逻辑 + `push-to-talk.js` hold 判定）：
- keydown：只认绑定位；`e.repeat`/IME(229) 忽略；录音中吞掉；按住 ≥250ms 触发 start；组合键保护（alt 模式下按住期间出现其他键 → 放弃）
- keyup：未到阈值（space 模式）补发普通空格；录音中 → stop
- Esc：录音中取消；window blur：清理计时并取消

- [ ] **Step 1**: useVoiceConfig 扩展（保持旧 JSON 兼容：缺省即默认开/alt）
- [ ] **Step 2**: usePushToTalk hook（全部键位/计时/IME/blur 保护）
- [ ] **Step 3**: ChatComposer 接线（onVoiceTranscript 管线复用，插入即现有 transcript 路径）+ 角落指示条（React 渲染，红=录音/黄=识别/绿=完成）
- [ ] **Step 4**: typecheck + `npm run test:client`
- [ ] **Step 5**: Commit `feat(voice): push-to-talk 内置——左 Alt 长按说话`

### Task 6: 设置界面

**Files:**
- Modify: `src/components/settings/view/tabs/VoiceSettingsTab.tsx`（新增「按住说话 (Push-to-Talk)」区块：开关 + 键位单选（左 Alt/空格长按/Ctrl+M），读写 useVoiceConfig）

- [ ] **Step 1**: 设置 UI
- [ ] **Step 2**: typecheck + test:client
- [ ] **Step 3**: Commit `feat(voice): 按住说话设置块（开关与键位）`

### Task 7: 插件清理

**Files:**
- Delete: `plugins/claude-rewind/`、`plugins/push-to-talk/`（git rm）
- Modify: `README.md`（若有插件激活段落则更新）
- Modify: `desktop/main.js` 注释如提及两款插件则同步（QIU_PLUGINS_DIR 本身保留）

- [ ] **Step 1**: git rm 两目录；grep README/desktop 中 rewind|push-to-talk 残留并更新
- [ ] **Step 2**: Commit `refactor(plugins): 移除已内置的 rewind 与 push-to-talk 插件`

### Task 8: 全量验收

- [ ] `npm run typecheck` ✓
- [ ] `npm test`（293+新增）0 fail ✓
- [ ] `npm run test:client` 0 fail ✓
- [ ] `npx eslint` 触碰文件 ✓
- [ ] `npm run build` 前端构建过（桌面壳 buildIsStale 依赖它）
- [ ] 新鲜克隆验收清单（少爷侧手测）：clone → npm install → npm run dev（无 .env）→ 回退按钮/编辑重发/左 Alt 说话三项可用
- [ ] Commit（如有遗漏修复）
