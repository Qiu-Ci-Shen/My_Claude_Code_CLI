import express from 'express';

import type { createMobileAccessService, MobileAccessStatus } from './service.js';
import { regeneratePin, setPin, verifyPinAndIssueToken } from './service.js';

/** Thin transport handlers around the mobile access service. */
export function createMobileAccessRouter(
  service: ReturnType<typeof createMobileAccessService>,
): express.Router {
  const router = express.Router();

  router.get('/status', async (_req, res, next) => {
    try {
      const status: MobileAccessStatus = await service.status();
      res.json({ success: true, status });
    } catch (error) {
      next(error);
    }
  });

  router.post('/tunnel/start', async (_req, res, next) => {
    try {
      await service.startTunnel();
      const status: MobileAccessStatus = await service.status();
      res.json({ success: true, status });
    } catch (error) {
      next(error);
    }
  });

  router.post('/tunnel/stop', async (_req, res, next) => {
    try {
      service.stopTunnel();
      const status: MobileAccessStatus = await service.status();
      res.json({ success: true, status });
    } catch (error) {
      next(error);
    }
  });

  router.put('/lan-ip-override', async (req, res, next) => {
    try {
      const ip = String(req.body?.ip ?? '');
      // Import lazily to keep this file transport-only.
      const { setLanIpOverride } = await import('./service.js');
      res.json({ success: true, ip: setLanIpOverride(ip) });
    } catch (error) {
      next(error);
    }
  });

  router.put('/pin', (req, res, next) => {
    try {
      const pin = setPin(String(req.body?.pin ?? ''));
      res.json({ success: true, pin });
    } catch (error) {
      next(error);
    }
  });

  router.post('/pin/regenerate', (_req, res, next) => {
    try {
      const pin = regeneratePin();
      res.json({ success: true, pin });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

/**
 * Express handler for POST /api/mobile-access/pin-login.
 *
 * This MUST be mounted OUTSIDE authenticateToken — it is the endpoint that
 * issues the token. Rate-limited per source IP inside the service.
 */
export function pinLoginHandler(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): void {
  try {
    const ip = (req.headers['cf-connecting-ip'] as string | undefined)
      ?? (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim()
      ?? req.socket.remoteAddress
      ?? 'unknown';
    const { token, user } = verifyPinAndIssueToken(ip, req.body?.pin);
    res.json({ success: true, token, user });
  } catch (error) {
    next(error);
  }
}
