# Agents 面板（子 agent 对话面板墙）设计规格

- 日期：2026-09-12
- 项目：Qiu_Ai_LZ（D:\Claude_Tools\claudecodeui）
- 状态：需求与方案已与少爷确认（形态=右侧竖列；能力=观察+停止+转达式消息；路线=双源分工）

## 1. 背景与目标

少爷使用 Claude Code 的 agent team / 子 agent 功能时，希望在 Qiu_Ai_LZ 里**看到所有子 agent 的对话面板**：实时看每个子 agent 在聊什么、干什么，能停止跑歪的 agent，能通过转达式消息指挥 teammate。

**已验证的现状（2026-09-12 实测）**：

1. **实时流已携带子代理内容**：SDK 流中，子代理的消息带 `parent_tool_use_id` 标签（值 = 主对话中 Agent 调用块的 tool_use id），内容涵盖提示词、助手文本、思考、工具调用、工具结果。服务端 `transformMessage` 已把该标签映射为 `parentToolUseId` 并随消息转发给前端；前端目前**完全没有消费**这些消息（主聊天会把它们当普通消息渲染/泄漏）。
2. **task 生命周期事件**：`task_started`（task_id/tool_use_id/subagent_type/description/is_backgrounded/spawn_depth/task_type/prompt）、`task_progress`（usage{total_tokens,tool_uses,duration_ms}/last_tool_name/summary）、`task_updated`（patch{status,end_time}）、`task_notification`（status: completed|failed|stopped/usage/summary）。服务端目前收到后基本丢弃。
3. **历史数据在磁盘**：主转录里有 Agent 调用块（tool_use id + input{prompt,description,subagent_type,name?,run_in_background}）与 tool_result（`toolUseResult.agentId` = 子代理文件名的关联键）；子代理完整对话在 `~/.claude/projects/<slug>/<providerSessionId>/subagents/agent-<taskId>.jsonl`（新布局），旁边有 `agent-<taskId>.meta.json`（agentType/description/toolUseId/spawnDepth/stoppedByUser/requestShape）。
4. **关联键（实测对齐）**：`task_started.task_id` == agent 文件名后缀 == `task_notification.task_id`；`task_started.tool_use_id` == 主对话 Agent 调用块 id == `meta.toolUseId`。
5. **停止通道存在**：SDK Query 实例有 `stopTask(taskId): Promise<void>`（官方接口，停止后发出 status='stopped' 的 task_notification）——但注意项目已知坑：控制请求无超时，必须 Promise.race 超时兜底。
6. **直发消息不可行**：SDK 0.3.268/0.3.269 没有向运行中子代理注入消息的公开通道；采用已确认的**转达式**降级（走主链路把消息交给 lead，由 SendMessage 转达）。
7. **两条旧链路已瘫（顺修）**：
   - 前端子代理容器识别条件 `toolName === 'Task'`，而 CLI 2.x 工具名已改为 `Agent` → 容器不出现；
   - 服务端历史解析在项目根目录找 `agent-*.jsonl`，新布局在 `<session>/subagents/` → `subagentTools` 永远拿不到。

## 2. 数据架构（双源分工）

| 维度 | 实时 | 历史 |
|---|---|---|
| 对话内容 | SDK 流中 parent_toolUseId 标签消息（已有） | `agent-<taskId>.jsonl` 解析（扩展） |
| 状态/用量 | task_started/progress/updated/notification（新增转发） | 主转录 tool_use/tool_result + meta.json 推导 |
| 停止 | `query.stopTask(taskId)`（新增 WS 命令） | 不适用（已完成） |
| 转达 | 主链路合成消息（前端拼装） | 同左 |

## 3. 服务端改动

### 3.1 WS 下行事件：`kind: 'subagent_event'`

在 `claude-runtime.provider.js` 的消息循环中，对 `type === 'system'` 且 `subtype ∈ {task_started, task_progress, task_updated, task_notification}` 的消息，除现有处理外新增转发：

```js
ws.send(createNormalizedMessage({
  kind: 'subagent_event', provider: 'claude', sessionId: sid,
  subagentEvent: {
    event: 'started'|'progress'|'updated'|'finished',
    taskId, toolUseId, description, subagentType, isBackgrounded, spawnDepth, taskType,
    prompt,              // started
    status,              // updated: patch.status; finished: status
    usage: { totalTokens, toolUses, durationMs },  // progress/finished
    lastToolName,        // progress
    summary,             // progress/finished
    endTime,             // updated
    ambient, skipTranscript,
  }
}));
```

- 由现有 ws writer 统一加 `seq`（支持断线重放）。
- `ambient === true` 的任务前端直接忽略。
- 同步在 `server/shared/types.ts` 的 `MessageKind` 联合中加入 `'subagent_event'`。

### 3.2 WS 上行命令：`chat.stop-subagent`

- `chat-websocket.service.ts` 消息分发 switch 增加 case：`{ type: 'chat.stop-subagent', sessionId, taskId }`。
- 经 provider runtime 服务调用 `stopClaudeSubagentTask(sessionId, taskId)`：从 activeSessions 取 Query 实例 → `Promise.race([query.stopTask(taskId), 8s 超时])`。
- 成功无显式应答（随后到达 task_notification(stopped) 由前端更新）；失败 `sendProtocolError(ws, 'STOP_SUBAGENT_FAILED', msg)`。
- taskId 白名单校验：`/^[A-Za-z0-9_-]{4,64}$/`。

### 3.3 历史接口（provider.routes.ts + sessions.service.ts + claude provider）

**`GET /api/providers/sessions/:sessionId/subagents`**

返回 `data: { subagents: [...] }`，每项：

```ts
{
  taskId: string; toolUseId: string | null;
  agentType: string | null; description: string | null; name: string | null; prompt: string | null;
  status: 'running'|'completed'|'failed'|'stopped'|'interrupted';
  isBackgrounded: boolean; spawnDepth: number | null;
  startedAt: string | null; endedAt: string | null;
  usage: { totalTokens: number; toolUses: number; durationMs: number } | null;
  hasConversation: boolean;
}
```

- 枚举来源合并：`<projectDir>/<providerSessionId>/subagents/agent-*.jsonl` + `*.meta.json`（新布局）、`<projectDir>/agent-*.jsonl`（旧布局）、主转录里 name ∈ {Agent, Task} 的 tool_use（补 prompt/description/name）+ 对应 tool_result（补状态与 agentId）。
- 关联：meta.toolUseId ↔ tool_use.id；taskId = meta 文件名后缀 或 toolUseResult.agentId。
- 状态推导：stoppedByUser → 'stopped'；有 tool_result：isError → 'failed' 否则 'completed'；无 tool_result → 'running'（前端在非运行会话中显示为「中断」，见 4.3）。
- 排序：主转录 tool_use 出现顺序；无对应 tool_use 的文件按 mtime 附加末尾。
- 非 claude provider 或数据缺失 → 空数组（不报错）。

**`GET /api/providers/sessions/:sessionId/subagents/:taskId/messages`**

返回 `data: { taskId, agentType, description, messages: NormalizedMessage[] }`。

- 解析 `agent-<taskId>.jsonl`：user 文本（提示词/消息）→ kind 'text' role 'user'；assistant: text → 'text'（role assistant）；thinking → 'thinking'；tool_use → 'tool_use'（含 toolId/toolInput/toolName）；user 内 tool_result 段 → 'tool_result'（含 toolId/content/isError）。忽略 attachment/queue-operation/isMeta 条目。消息 id 用条目 `uuid`（缺省回退 `agent_<taskId>_<idx>`）。
- tool_result 与 tool_use 的配对通过 `tool_use_id`，前端渲染器已有配对逻辑可直接复用。
- 解析缓存：把现有 `agentToolsParseCache` 升级为一次解析产出 `{tools, conversation}`（mtime+size 校验）。
- 全量返回（不做分页）；单文件超 64MB 不缓存（与主转录缓存策略一致精神）。
- taskId 路径白名单同上；文件不存在 → 404。

### 3.4 旧链路顺修

- `getSessionMessages` 里 agent 文件路径改为先查新布局 `<projectDir>/<providerSessionId>/subagents/agent-<id>.jsonl`，回退旧布局 `<projectDir>/agent-<id>.jsonl`。

## 4. 前端改动

### 4.1 消息路由（useChatRealtimeHandlers）

- 新增拦截：**所有带 `parentToolUseId` 的消息**（提示词/文本/思考/工具/工具结果/流式 delta）不再进入主聊天 store 管线，改路由到 agents store（按 toolUseId 归组），随后 `return`。
- 新增 case：`kind === 'subagent_event'` → agents store.applySubagentEvent → `return`。
- 效果：主聊天不再出现子代理的散落工具调用与文本泄漏（顺修）；子代理内容全部进面板。

### 4.2 agents store（新，ChatInterface 内实例化，沿用 sessionStore 模式）

纯逻辑抽到 `agentsReducer.ts`（可单测），hook 壳 `useAgentsStore.ts` 管订阅与节流：

- 每会话状态：`agents: Map<taskId, AgentRuntime>`、`order: string[]`、`panelOpen`、`userClosed`（本次运行期用户手动关闭过）、`selectedTaskId`、`liveStarted`（是否收到过 live 事件，用于历史状态修正）。
- `AgentRuntime`：身份字段 + status + usage + lastToolName/summary + startedAt/endedAt + `messages: NormalizedMessage[]`（上限 400 条环形截断）+ `seenMessageIds: Set`（重放去重）+ historyLoaded 标记。
- 事件合并规则：started 建条目（ambient 忽略；同 taskId 幂等更新）；progress 更新 usage/lastToolName/summary；updated 合并 status/endTime；finished 收敛 status+usage。finished/updated(completed|failed|killed) 时把 status 落定并记录 endedAt。
- 历史列表载入：会话切换时调 `loadSessionAgents(sid)`；历史中 status 'running' 且该会话无 live 事件 → 显示为 `'interrupted'`。
- 自动打开：活动会话收到 started（非 ambient）且 `userClosed === false` → `panelOpen = true`；用户关闭置 `userClosed = true`；该会话无运行中 agent 时重置 `userClosed`。
- 单测覆盖：状态机转换、去重、截断、interrupted 修正、userClosed 语义。

### 4.3 面板 UI（`src/components/chat/agents/`）

- `AgentsPanel`：聊天区右侧竖列（flex 行内，宽 ~360px，`border-l`），桌面上把消息区挤窄、不遮挡；移动端（复用项目 isMobile 判定）改为右侧抽屉覆盖层。
- `AgentCard`：状态圆点（运行=紫色脉冲 / 完成=绿 / 失败=红 / 停止=灰 / 中断=灰虚线）、类型徽标（Explore/Plan/general-purpose/claude…）、描述、name（有则显示）；运行时显示最近工具 + 实时 token + 计时；完成显示耗时 + 总 token。点击进入详情。
- `AgentDetail`：头部（返回 + 描述 + 状态 + 停止按钮）→ 对话流（紧凑渲染：文本走 Markdown 组件；工具调用一行摘要 + 可折叠结果；思考折叠灰字）→ 底部转达输入框（拼装「请把以下消息转达给…并回报回应」走主链路发送，发送即清空，提示"经 lead 转达"）。
- 空态：无 agent 时不显示入口；面板内无 agent 时显示说明文案。
- 计时刷新：面板内单个 1s interval 驱动。

### 4.4 入口

- 聊天消息区右上角悬浮胶囊按钮「Agents · n」（n 为运行中数量，紫色）；无任何 agent 时隐藏；面板打开时隐藏。
- 自动打开逻辑见 4.2。

### 4.5 旧链路顺修

- `useChatMessages.ts` 等处的子代理容器判定 `toolName === 'Task'` 改为 `'Task' || 'Agent'`（全局搜所有同型判定）。

## 5. 边界与错误处理

- 所有新接口遵循现有鉴权与 `{success,data}` 响应格式；路径参数白名单防穿越。
- 停止：无活动运行 / taskId 不存在 → 协议错误提示，不改 UI 状态。
- 子代理消息上限（400/agent）防长跑内存膨胀；agents 上限（50/会话）按 finished 时间淘汰。
- 重放去重：按消息 id 幂等。
- 非 claude provider：接口返回空、面板不出现、消息路由不触发。

## 6. 测试与验收

- 服务端单测（新增）：列表合并（新/旧布局）、对话归一化（提示词/文本/工具/工具结果配对）、路径白名单拒绝、缺文件空返回。
- 前端单测（新增）：agentsReducer 状态机/去重/截断/interrupted 修正。
- 回归：`npm run typecheck` / `npm test` / `npm run test:client` / `npm run lint` 全绿；桌面端构建通过。
- 手工验收（少爷）：
  1. 打开会话 → 让 lead 派 2-3 个子代理 → 面板自动从右侧弹出，卡片实时滚动（文本/工具/计时/token）。
  2. 点卡片 → 详情里能看到完整对话（含工具结果展开）；返回列表。
  3. 对运行中的 agent 点「停止」→ 卡片变「已停止」。
  4. 详情里发一条转达 → 主对话出现合成消息、lead 转达。
  5. F5 重开 → 面板入口仍在，历史 agent 可回看完整对话。
  6. 旧会话（9月11日那次的 3 个 Explore agent）→ 可回看。

## 7. 非目标（v1 不做）

- 真直发消息（SDK 无通道，已确认；升级 SDK 时复查）。
- 跨会话全局 agent 视图、teammate 共享任务列表面板、workflow 脚本可视化。
- codex/其他 provider 的子代理面板（接口预留，实现仅 claude）。
- 打包/发布动作（验收后由少爷决定提交）。
