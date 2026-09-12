/**
 * Agents 面板服务端测试：子代理列表/对话接口 + task 事件映射。
 *
 * 覆盖：
 *  - 新布局（<sessionId>/subagents/）与旧布局（项目根目录）的转录定位
 *  - 后台任务的 task-notification 完成通知（状态/结束时间来源）
 *  - 对话归一化（提示词/文本/思考/工具/工具结果配对）
 *  - taskId 路径白名单与缺文件空返回
 *  - mapTaskEventToSubagentEvent 四种事件映射 + ambient 透传
 *  - classifySubagentEvent 任务分类（后台命令不进面板，2026-09-12 实案）
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';
import { classifySubagentEvent, mapTaskEventToSubagentEvent } from '@/modules/providers/list/claude/claude-runtime.provider.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'claude-subagents-db-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

const AGENT_ID = 'a1b2c3d4e5f60718';
const CALL_ID = 'call_00_testAgentCall0001';

const agentTranscriptLines = (): string[] => [
  JSON.stringify({
    parentUuid: null, isSidechain: true, agentId: AGENT_ID, uuid: 'u1',
    timestamp: '2026-09-12T01:00:00.000Z', type: 'user',
    message: { role: 'user', content: '请检查 src 目录' },
  }),
  JSON.stringify({
    parentUuid: 'u1', isSidechain: true, agentId: AGENT_ID, uuid: 'u2',
    timestamp: '2026-09-12T01:00:01.000Z', type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: '先看文件' },
        { type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'ls src' } },
      ],
    },
  }),
  JSON.stringify({
    parentUuid: 'u2', isSidechain: true, agentId: AGENT_ID, uuid: 'u3',
    timestamp: '2026-09-12T01:00:02.000Z', type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'App.tsx\nmain.tsx' }] },
  }),
  JSON.stringify({
    parentUuid: 'u3', isSidechain: true, agentId: AGENT_ID, uuid: 'u4',
    timestamp: '2026-09-12T01:00:03.000Z', type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: '目录里有 App.tsx 与 main.tsx。' }] },
  }),
  // 恶意/畸形行：解析应被跳过而不影响其余条目
  '{not json',
];

const mainTranscriptLines = (providerSessionId: string, cwd: string): string[] => [
  JSON.stringify({
    sessionId: providerSessionId, cwd, type: 'user', uuid: 'm1',
    timestamp: '2026-09-12T00:59:59.000Z',
    message: { role: 'user', content: '派个 agent 检查 src' },
  }),
  JSON.stringify({
    sessionId: providerSessionId, cwd, type: 'assistant', uuid: 'm2',
    timestamp: '2026-09-12T01:00:00.000Z',
    message: {
      role: 'assistant',
      content: [{
        type: 'tool_use', id: CALL_ID, name: 'Agent',
        input: { description: '检查 src', subagent_type: 'Explore', prompt: '请检查 src 目录', run_in_background: true },
      }],
    },
  }),
  JSON.stringify({
    sessionId: providerSessionId, cwd, type: 'user', uuid: 'm3',
    timestamp: '2026-09-12T01:00:00.500Z',
    // 后台 Agent 的 tool_result 只是 async_launched 回执
    toolUseResult: { isAsync: true, status: 'async_launched', agentId: AGENT_ID },
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: CALL_ID, content: `agentId: ${AGENT_ID}` }] },
  }),
  // 完成通知：后台任务的权威完成信号
  JSON.stringify({
    sessionId: providerSessionId, cwd, type: 'attachment', uuid: 'm4',
    timestamp: '2026-09-12T01:05:00.000Z',
    attachment: {
      type: 'queued_command',
      commandMode: 'task-notification',
      prompt: `<task-notification>\n<task-id>${AGENT_ID}</task-id>\n<tool-use-id>${CALL_ID}</tool-use-id>\n<status>completed</status>\n<summary>Agent "检查 src" finished</summary>\n</task-notification>`,
    },
  }),
];

/** 建一套夹具：主转录 + 子代理转录 + meta，并入库。layout: 'nested' | 'legacy' */
async function setupSession(options: { layout: 'nested' | 'legacy' }): Promise<{
  providerSessionId: string;
  projectDir: string;
  cleanup: () => Promise<void>;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'claude-subagents-fixture-'));
  const providerSessionId = `sess-${options.layout}-${Date.now()}`;
  const projectDir = path.join(root, 'D--test-project');
  const agentDir = options.layout === 'nested'
    ? path.join(projectDir, providerSessionId, 'subagents')
    : projectDir;
  await mkdir(agentDir, { recursive: true });

  const mainPath = path.join(projectDir, `${providerSessionId}.jsonl`);
  await writeFile(mainPath, mainTranscriptLines(providerSessionId, projectDir).join('\n'));
  await writeFile(path.join(agentDir, `agent-${AGENT_ID}.jsonl`), agentTranscriptLines().join('\n'));
  await writeFile(
    path.join(agentDir, `agent-${AGENT_ID}.meta.json`),
    JSON.stringify({ agentType: 'Explore', description: '检查 src', toolUseId: CALL_ID, spawnDepth: 1, requestShape: 'background' }),
  );

  sessionsDb.createSession(providerSessionId, 'claude', projectDir, 'Test session', undefined, undefined, mainPath);

  return {
    providerSessionId,
    projectDir,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

test('子代理列表：新布局 + 后台通知给出真实完成状态与时间', async () => {
  await withIsolatedDatabase(async () => {
    const { providerSessionId, cleanup } = await setupSession({ layout: 'nested' });
    try {
      const provider = new ClaudeSessionsProvider();
      const list = await provider.listSubagents(providerSessionId);

      assert.equal(list.length, 1);
      const agent = list[0]!;
      assert.equal(agent.taskId, AGENT_ID);
      assert.equal(agent.toolUseId, CALL_ID);
      assert.equal(agent.agentType, 'Explore');
      assert.equal(agent.description, '检查 src');
      assert.equal(agent.status, 'completed');
      assert.equal(agent.isBackgrounded, true);
      assert.equal(agent.spawnDepth, 1);
      assert.equal(agent.startedAt, '2026-09-12T01:00:00.000Z');
      // 结束时间来自 task-notification（async 回执时刻不能算完成）
      assert.equal(agent.endedAt, '2026-09-12T01:05:00.000Z');
      assert.equal(agent.hasConversation, true);
    } finally {
      await cleanup();
    }
  });
});

test('子代理列表：旧布局（项目根目录）同样可读', async () => {
  await withIsolatedDatabase(async () => {
    const { providerSessionId, cleanup } = await setupSession({ layout: 'legacy' });
    try {
      const provider = new ClaudeSessionsProvider();
      const list = await provider.listSubagents(providerSessionId);
      assert.equal(list.length, 1);
      assert.equal(list[0]!.taskId, AGENT_ID);
      assert.equal(list[0]!.status, 'completed');
    } finally {
      await cleanup();
    }
  });
});

test('子代理对话：归一化顺序与工具配对正确', async () => {
  await withIsolatedDatabase(async () => {
    const { providerSessionId, cleanup } = await setupSession({ layout: 'nested' });
    try {
      const provider = new ClaudeSessionsProvider();
      const conversation = await provider.fetchSubagentConversation(providerSessionId, AGENT_ID);

      assert.ok(conversation);
      assert.equal(conversation!.agentType, 'Explore');
      const kinds = conversation!.messages.map((message) => message.kind);
      assert.deepEqual(kinds, ['text', 'thinking', 'tool_use', 'tool_result', 'text']);
      const first = conversation!.messages[0]!;
      assert.equal(first.role, 'user');
      assert.equal(first.content, '请检查 src 目录');
      const toolUse = conversation!.messages[2]!;
      assert.equal(toolUse.toolId, 'tu_1');
      assert.equal(toolUse.toolName, 'Bash');
      const toolResult = conversation!.messages[3]!;
      assert.equal(toolResult.toolId, 'tu_1');
      assert.equal(toolResult.isError, false);
      // 同一条目内多 part 的 id 唯一性
      const ids = conversation!.messages.map((message) => message.id);
      assert.equal(new Set(ids).size, ids.length);
      // sessionId 已回填为应用会话 id
      assert.ok(conversation!.messages.every((message) => message.sessionId === providerSessionId));
    } finally {
      await cleanup();
    }
  });
});

test('子代理接口：路径穿越与不存在的 id 均安全返回', async () => {
  await withIsolatedDatabase(async () => {
    const { providerSessionId, cleanup } = await setupSession({ layout: 'nested' });
    try {
      const provider = new ClaudeSessionsProvider();
      assert.equal(await provider.fetchSubagentConversation(providerSessionId, '../../etc/passwd'), null);
      assert.equal(await provider.fetchSubagentConversation(providerSessionId, 'nonexistent0000'), null);
      // 未知会话：列表空数组、对话 null
      assert.deepEqual(await provider.listSubagents('unknown-session-id'), []);
      assert.equal(await provider.fetchSubagentConversation('unknown-session-id', AGENT_ID), null);
    } finally {
      await cleanup();
    }
  });
});

test('task 事件映射：四种 subtype + ambient/未知', () => {
  const started = mapTaskEventToSubagentEvent({
    type: 'system', subtype: 'task_started', task_id: 't1', tool_use_id: 'call_1',
    description: '扫描', subagent_type: 'Explore', is_backgrounded: true,
    spawn_depth: 1, task_type: 'local_agent', prompt: 'p', ambient: false,
  });
  assert.equal(started?.event, 'started');
  assert.equal(started?.taskId, 't1');
  assert.equal(started?.toolUseId, 'call_1');
  assert.equal(started?.isBackgrounded, true);

  const progress = mapTaskEventToSubagentEvent({
    type: 'system', subtype: 'task_progress', task_id: 't1',
    usage: { total_tokens: 100, tool_uses: 2, duration_ms: 3000 }, last_tool_name: 'Bash',
  });
  assert.equal(progress?.event, 'progress');
  assert.deepEqual(progress?.usage, { totalTokens: 100, toolUses: 2, durationMs: 3000 });
  assert.equal(progress?.lastToolName, 'Bash');

  const updated = mapTaskEventToSubagentEvent({
    type: 'system', subtype: 'task_updated', task_id: 't1', patch: { status: 'completed', end_time: 123 },
  });
  assert.equal(updated?.event, 'updated');
  assert.equal(updated?.status, 'completed');
  assert.equal(updated?.endTime, 123);

  const finished = mapTaskEventToSubagentEvent({
    type: 'system', subtype: 'task_notification', task_id: 't1', tool_use_id: 'call_1',
    status: 'stopped', summary: 's', ambient: true,
  });
  assert.equal(finished?.event, 'finished');
  assert.equal(finished?.status, 'stopped');
  assert.equal(finished?.ambient, true);

  assert.equal(mapTaskEventToSubagentEvent({ type: 'assistant' }), null);
  assert.equal(mapTaskEventToSubagentEvent({ type: 'system', subtype: 'init' }), null);
  assert.equal(mapTaskEventToSubagentEvent(null), null);
});

test('任务分类：只有子代理任务进面板，后台命令被挡下', () => {
  const agent = new Set<string>();
  const nonAgent = new Set<string>();

  // 真子代理：task_started 认领后，后续 progress/updated/notification 全放行
  assert.equal(
    classifySubagentEvent(
      mapTaskEventToSubagentEvent({
        type: 'system', subtype: 'task_started', task_id: 'agent1', tool_use_id: 'call_1',
        description: '服务端改动独立审核', subagent_type: 'general-purpose',
        is_backgrounded: true, spawn_depth: 1, task_type: 'local_agent',
      }),
      agent, nonAgent,
    ),
    true,
  );
  assert.equal(
    classifySubagentEvent(
      mapTaskEventToSubagentEvent({
        type: 'system', subtype: 'task_progress', task_id: 'agent1',
        description: 'Running Read typecheck output', subagent_type: 'general-purpose',
        usage: { total_tokens: 65700, tool_uses: 9, duration_ms: 49000 }, last_tool_name: 'Bash',
      }),
      agent, nonAgent,
    ),
    true,
  );
  assert.equal(
    classifySubagentEvent(
      mapTaskEventToSubagentEvent({ type: 'system', subtype: 'task_updated', task_id: 'agent1', patch: { status: 'completed', end_time: 123 } }),
      agent, nonAgent,
    ),
    true,
  );
  assert.equal(
    classifySubagentEvent(
      mapTaskEventToSubagentEvent({ type: 'system', subtype: 'task_notification', task_id: 'agent1', tool_use_id: 'call_1', status: 'completed', summary: '审核完成' }),
      agent, nonAgent,
    ),
    true,
  );

  // lead 的后台命令：started 即被挡，后续事件凭 taskId 同样被挡
  assert.equal(
    classifySubagentEvent(
      mapTaskEventToSubagentEvent({
        type: 'system', subtype: 'task_started', task_id: 'bash1', tool_use_id: 'call_2',
        description: 'Sleep 30 then echo bg-lead-ok', is_backgrounded: true, task_type: 'local_bash',
      }),
      agent, nonAgent,
    ),
    false,
  );
  assert.equal(
    classifySubagentEvent(
      mapTaskEventToSubagentEvent({
        type: 'system', subtype: 'task_notification', task_id: 'bash1', tool_use_id: 'call_2',
        status: 'completed', summary: 'Background command "Sleep 30 then echo bg-lead-ok" completed (exit code 0)',
      }),
      agent, nonAgent,
    ),
    false,
  );
});

test('任务分类：子代理名下/前台的命令任务同样挡下（2026-09-12 截图实案）', () => {
  const agent = new Set<string>();
  const nonAgent = new Set<string>();

  // 子代理内部的后台命令（owned_by_subagent 不改变"非子代理"归属）
  assert.equal(
    classifySubagentEvent(
      mapTaskEventToSubagentEvent({
        type: 'system', subtype: 'task_started', task_id: 'bash2', tool_use_id: 'call_3',
        description: 'Run server test suite', is_backgrounded: true, task_type: 'local_bash',
        owned_by_subagent: true,
      }),
      agent, nonAgent,
    ),
    false,
  );
  assert.equal(
    classifySubagentEvent(
      mapTaskEventToSubagentEvent({ type: 'system', subtype: 'task_updated', task_id: 'bash2', patch: { status: 'completed', end_time: 9 } }),
      agent, nonAgent,
    ),
    false,
  );
  assert.equal(
    classifySubagentEvent(
      mapTaskEventToSubagentEvent({
        type: 'system', subtype: 'task_notification', task_id: 'bash2', tool_use_id: 'call_3',
        status: 'completed', summary: 'Background command "Run server test suite" completed (exit code 0)',
      }),
      agent, nonAgent,
    ),
    false,
  );

  // 子代理内部的前台命令任务（is_backgrounded:false 的 local_bash）
  assert.equal(
    classifySubagentEvent(
      mapTaskEventToSubagentEvent({
        type: 'system', subtype: 'task_started', task_id: 'bash3', tool_use_id: 'call_4',
        description: 'Wait for background task to finish', is_backgrounded: false, task_type: 'local_bash',
      }),
      agent, nonAgent,
    ),
    false,
  );
});

test('任务分类：未分类任务的兜底——带 subagent_type 即时补认，其余保守丢弃', () => {
  const agent = new Set<string>();
  const nonAgent = new Set<string>();

  // 缺 started 的 progress：带 subagent_type → 补认为子代理并放行
  assert.equal(
    classifySubagentEvent(
      mapTaskEventToSubagentEvent({
        type: 'system', subtype: 'task_progress', task_id: 'agent2',
        description: 'Running something', subagent_type: 'Explore',
      }),
      agent, nonAgent,
    ),
    true,
  );
  assert.equal(
    classifySubagentEvent(
      mapTaskEventToSubagentEvent({ type: 'system', subtype: 'task_updated', task_id: 'agent2', patch: { status: 'completed' } }),
      agent, nonAgent,
    ),
    true,
  );

  // 缺 started 的普通事件（无类型信息）→ 丢弃
  assert.equal(
    classifySubagentEvent(
      mapTaskEventToSubagentEvent({ type: 'system', subtype: 'task_updated', task_id: 'ghost', patch: { status: 'completed' } }),
      agent, nonAgent,
    ),
    false,
  );

  // taskId 缺失 / 空负载 → 丢弃
  assert.equal(classifySubagentEvent({ event: 'started', taskId: null }, agent, nonAgent), false);
  assert.equal(classifySubagentEvent(null, agent, nonAgent), false);
});
