# Agents 面板实施计划

- 日期：2026-09-12
- 规格：`docs/superpowers/specs/2026-09-12-agents-panel-design.md`
- 执行模式：少爷授权全自主（"一直做，回来验收"）

## 阶段清单（每步含验证）

### 阶段 1 · 服务端基础
1. `server/shared/types.ts`：MessageKind 增加 `'subagent_event'`
   → 验证：typecheck 过。
2. `claude-runtime.provider.js`：消息循环里转发 4 种 task_* 为 subagent_event
   → 验证：typecheck；后续 E2E。
3. `claude-runtime.provider.js`：新增 `stopClaudeSubagentTask(sessionId, taskId)`（Promise.race 8s 超时）+ 导出
   → 验证：单测/手工。
4. `chat-websocket.service.ts`：`chat.stop-subagent` case + taskId 白名单 + 失败 protocol_error
   → 验证：协议错误路径可用。

### 阶段 2 · 历史接口
5. `claude-sessions.provider.ts`：
   a. agent 文件路径解析（新 `<sid>/subagents/` + 旧根目录回退）
   b. `agentToolsParseCache` 升级为 `{tools, conversation}` 一次解析
   c. `listSubagentsForSession(sessionId)`（合并 meta/tool_use/tool_result）
   d. `getSubagentConversation(sessionId, taskId)`（归一化对话）
   e. `getSessionMessages` 改用新路径解析
   → 验证：新增单测 `server/modules/providers/tests/claude-subagents.test.ts`。
6. `sessions.service.ts` + `provider.routes.ts`：两个 GET 接口
   → 验证：`provider.routes.test.ts` 风格的新增测例（或手工 curl）。

### 阶段 3 · 前端状态
7. `useSessionStore.ts`：MessageKind 增加 `'subagent_event'`；NormalizedMessage 增 `subagentEvent` 字段
8. 新建 `src/components/chat/agents/types.ts` + `agentsReducer.ts`（纯函数状态机）
   → 验证：新增 `agentsReducer.test.ts`。
9. 新建 `src/components/chat/agents/useAgentsStore.ts`（hook 壳：订阅版本号 + 节流 + fetch 接口）
10. `useChatRealtimeHandlers.ts`：parentToolUseId 拦截路由 + subagent_event case
    → 验证：typecheck + 手工 E2E。

### 阶段 4 · 面板 UI
11. `AgentsPanel.tsx` / `AgentCard.tsx` / `AgentDetail.tsx`（紧凑渲染：Markdown + 工具折叠行）
12. `ChatInterface.tsx`：布局插入右侧竖列（flex row 包裹现有列）+ 悬浮入口按钮 + isMobile 抽屉
13. `useChatMessages.ts` 等：`'Task' || 'Agent'` 判定修复；`normalizedToChatMessages` 加 parentToolUseId 防御性过滤
    → 验证：typecheck + 手工。

### 阶段 5 · 回归与验收
14. `npm run typecheck && npm test && npm run test:client && npm run lint` 全绿
15. `npm run build`（vite + dist-server）成功；如桌面壳构建正常
16. 端到端手工（无法完全替代少爷）：用本机会话数据验证历史接口返回真实 agent；起一个真实子代理流验证实时链路（可借本次实现会话自身做样本）
17. 验收报告：改动清单、验证证据、少爷验收步骤、遗留项
