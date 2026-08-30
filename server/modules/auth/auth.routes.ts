import express from 'express';
import type { RequestHandler } from 'express';

import type { createAuthService } from './auth.service.js';

type AuthenticatedRequest = express.Request & { user?: unknown };

/**
 * Creates the Auth transport adapter. Handlers only parse request data and
 * delegate authentication behavior to the injected application service.
 */
export function createAuthRouter(
  service: ReturnType<typeof createAuthService>,
  authenticateToken: RequestHandler,
): express.Router {
  const router = express.Router();

  router.get('/status', (_req, res, next) => {
    try {
      res.json(service.getStatus());
    } catch (error) {
      next(error);
    }
  });

  router.post('/register', async (req, res, next) => {
    try {
      const body = req.body as { username?: unknown; password?: unknown };
      res.json(await service.register(body.username, body.password));
    } catch (error) {
      next(error);
    }
  });

  // ── 登录防爆破（服务绑定 0.0.0.0 时局域网可达，必须限速）──
  // 滑动窗口：同一 IP 5 分钟内失败 10 次 → 封禁 10 分钟；登录成功即清零。
  // 内存态即可：进程重启清零不影响安全（密码本身有 bcrypt cost 12 拖速度）。
  const LOGIN_WINDOW_MS = 5 * 60_000;
  const LOGIN_MAX_FAILURES = 10;
  const LOGIN_BLOCK_MS = 10 * 60_000;
  const loginFailures = new Map<string, { count: number; firstAt: number; blockedUntil?: number }>();

  const pruneLoginFailures = (now: number) => {
    if (loginFailures.size < 500) return;
    for (const [ip, rec] of loginFailures) {
      const expired = now - rec.firstAt > LOGIN_WINDOW_MS && (!rec.blockedUntil || rec.blockedUntil < now);
      if (expired) loginFailures.delete(ip);
    }
  };

  router.post('/login', async (req, res, next) => {
    try {
      const ip = req.socket.remoteAddress || 'unknown';
      const now = Date.now();
      pruneLoginFailures(now);

      const record = loginFailures.get(ip);
      if (record?.blockedUntil && record.blockedUntil > now) {
        return res.status(429).json({
          error: `登录尝试次数过多，请约 ${Math.ceil((record.blockedUntil - now) / 60_000)} 分钟后再试`,
          code: 'AUTH_RATE_LIMITED',
        });
      }

      const body = req.body as { username?: unknown; password?: unknown };
      try {
        const result = await service.login(body.username, body.password);
        loginFailures.delete(ip);
        res.json(result);
      } catch (loginError) {
        // 仅计失败（含用户不存在），成功路径不走这里
        const rec = loginFailures.get(ip) ?? { count: 0, firstAt: now };
        if (now - rec.firstAt > LOGIN_WINDOW_MS) {
          rec.count = 0;
          rec.firstAt = now;
          rec.blockedUntil = undefined;
        }
        rec.count += 1;
        if (rec.count >= LOGIN_MAX_FAILURES) {
          rec.blockedUntil = now + LOGIN_BLOCK_MS;
        }
        loginFailures.set(ip, rec);
        throw loginError;
      }
    } catch (error) {
      next(error);
    }
  });

  router.get('/user', authenticateToken, (req, res) => {
    res.json(service.getCurrentUser((req as AuthenticatedRequest).user));
  });

  router.post('/refresh', authenticateToken, (req, res) => {
    res.json(service.refreshSession((req as AuthenticatedRequest).user));
  });

  router.post('/logout', authenticateToken, (_req, res) => {
    res.json(service.logout());
  });

  return router;
}
