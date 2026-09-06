import express from 'express';

import { sessionsDb } from '@/modules/database/index.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';
import { providerRuntimeService } from '@/modules/providers/index.js';

import { locateInSession, rewindSession, type SessionRow } from './rewind.service.js';

/** 从请求体读取目标会话行；缺会话或缺转录路径时返回 null。 */
function readSessionRow(rawSessionId: unknown): SessionRow | null {
  if (typeof rawSessionId !== 'string' || !rawSessionId.trim()) {
    return null;
  }
  const row = sessionsDb.getSessionById(rawSessionId);
  if (!row) {
    return null;
  }
  return {
    session_id: row.session_id,
    provider_session_id: row.provider_session_id ?? null,
    jsonl_path: row.jsonl_path ?? null,
  };
}

/** 与插件 RPC 语义一致：会话仍在生成（或 CLI 因后台工作被 hold）时拒绝截断。 */
function isSessionBusy(sessionId: string): boolean {
  return (
    chatRunRegistry.isProcessing(sessionId)
    || providerRuntimeService.hasActiveProcess('claude', sessionId)
  );
}

/**
 * 内置 Rewind 路由（原 /api/plugins/claude-rewind/rpc/* 的原生等价物）。
 *
 * 请求/响应 JSON 形状与插件版完全一致，rewindRpc.ts 消费方零改动：
 *   POST /locate   { sessionId, timestamp, textPrefix } → { found, uuid, ... }
 *   POST /rewind   { sessionId, targetUuid, restoreFiles } → 统计结果
 */
export function createRewindRouter(): express.Router {
  const router = express.Router();

  router.post('/locate', async (req, res) => {
    try {
      const row = readSessionRow(req.body?.sessionId);
      if (!row) {
        res.json({ found: false, error: 'session not found' });
        return;
      }
      res.json(await locateInSession(row, req.body ?? {}));
    } catch (error) {
      console.error('[rewind] locate failed:', error);
      res.status(500).json({ found: false, error: (error as Error).message });
    }
  });

  router.post('/execute', async (req, res) => {
    try {
      const sessionId = typeof req.body?.sessionId === 'string' ? req.body.sessionId : '';
      if (!sessionId) {
        res.json({ ok: false, error: 'session not found in DB' });
        return;
      }
      if (isSessionBusy(sessionId)) {
        res.status(409).json({ ok: false, error: '会话仍在生成中，请先打断再回退' });
        return;
      }
      const row = readSessionRow(sessionId);
      if (!row) {
        res.json({ ok: false, error: 'session not found in DB' });
        return;
      }
      res.json(await rewindSession(row, req.body ?? {}));
    } catch (error) {
      console.error('[rewind] execute failed:', error);
      res.status(500).json({ ok: false, error: (error as Error).message });
    }
  });

  return router;
}
