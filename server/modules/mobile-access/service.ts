// Mobile Access service, ported from dsh-pocket (GPL-2.0) lib/service.mjs + lib/settings.mjs.
// CCUI already binds 0.0.0.0, so no header-rewriting proxy is needed — the tunnel
// points straight at the CCUI server port and the LAN QR uses the same port.

import { networkInterfaces } from 'node:os';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { randomInt } from 'node:crypto';

import { AppError } from '@/shared/utils.js';
// eslint-disable-next-line boundaries/dependencies -- JWT_SECRET is not re-exported by the auth barrel
import { JWT_SECRET } from '../auth/auth.middleware.js';
import { userDb } from '../database/index.js';

import { selectLanIPv4, listLanCandidates, isValidIpv4 } from './lan.js';
import { startQuickTunnel } from './tunnel.js';
import { createCompressingProxy } from './proxy.js';

const require = createRequire(import.meta.url);

// The qrcode package ships no type declarations; keep the call site typed.
type QrcodeModule = { toDataURL(text: string, opts: Record<string, unknown>): Promise<string> };

// jsonwebtoken has no @types package installed in this project; the existing
// auth middleware uses @ts-nocheck instead. Use createRequire + a narrow local
// type so this file stays type-clean without touching package.json.
type JwtModule = {
  sign(payload: Record<string, unknown>, secret: string, opts: { expiresIn: string }): string;
};
const jwt = require('jsonwebtoken') as JwtModule;

/** URL -> PNG data URL for <img src>, generated locally via the qrcode package. */
async function qrDataUrl(text: string, { width = 220, margin = 1 }: { width?: number; margin?: number } = {}): Promise<string> {
  const QRCode = require('qrcode') as unknown as QrcodeModule;
  return QRCode.toDataURL(text, { errorCorrectionLevel: 'M', margin, width, type: 'image/png' });
}

// ---------- persisted settings (~/.cloudcli/mobile-access/settings.json) ----------

function settingsPath(): string {
  return join(homedir(), '.cloudcli', 'mobile-access', 'settings.json');
}

type MobileAccessSettings = {
  lanIpOverride?: string;
  pin?: string;
};

function readSettings(): MobileAccessSettings {
  try {
    const raw = JSON.parse(readFileSync(settingsPath(), 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch { /* missing/corrupt -> defaults */ }
  return {};
}

function writeSettings(s: MobileAccessSettings): MobileAccessSettings {
  try {
    mkdirSync(dirname(settingsPath()), { recursive: true });
    writeFileSync(settingsPath(), JSON.stringify(s, null, 2));
  } catch { /* ignore */ }
  return s;
}

export function lanIpOverride(): string {
  return readSettings().lanIpOverride ?? '';
}

export function setLanIpOverride(value: string): string {
  const ip = String(value ?? '').trim();
  if (ip && !isValidIpv4(ip)) {
    throw new Error('LAN address must be an IPv4 address');
  }
  const s = readSettings();
  if (ip) s.lanIpOverride = ip;
  else delete s.lanIpOverride;
  writeSettings(s);
  return ip;
}

// ---------- mobile PIN (6-digit quick login for LAN/tunnel QR scans) ----------

const PIN_REGEX = /^\d{6}$/;

function generateRandomPin(): string {
  // 100000..999999 inclusive — always 6 digits.
  return String(randomInt(100_000, 1_000_000));
}

/** Returns the persisted PIN, generating and saving a random one on first call. */
export function getOrCreatePin(): string {
  const s = readSettings();
  if (s.pin && PIN_REGEX.test(s.pin)) return s.pin;
  const pin = generateRandomPin();
  writeSettings({ ...s, pin });
  return pin;
}

export function setPin(value: string): string {
  const pin = String(value ?? '').trim();
  if (!PIN_REGEX.test(pin)) {
    throw new AppError('PIN must be exactly 6 digits', {
      code: 'PIN_INVALID_FORMAT',
      statusCode: 400,
    });
  }
  const s = readSettings();
  s.pin = pin;
  writeSettings(s);
  return pin;
}

export function regeneratePin(): string {
  const pin = generateRandomPin();
  const s = readSettings();
  s.pin = pin;
  writeSettings(s);
  return pin;
}

// ---------- PIN login rate limiting (in-memory, per source IP) ----------
//
// The public tunnel exposes this endpoint to the open internet, so a 6-digit
// PIN alone is brute-forceable in ~1M tries. Two layers:
//   1. Per-IP rolling window: max 5 attempts / 60s.
//   2. Consecutive-failure lockout: 10 in a row locks that IP for 30 min.
// In-memory is fine — a server restart resetting the counters is acceptable.

const ATTEMPT_WINDOW_MS = 60_000;
const ATTEMPT_MAX_PER_WINDOW = 5;
const LOCK_THRESHOLD = 10;
const LOCK_DURATION_MS = 30 * 60_000;

type AttemptRecord = { count: number; resetAt: number; lockUntil: number };
const attemptByIp = new Map<string, AttemptRecord>();
const consecutiveFailuresByIp = new Map<string, number>();

function checkRateLimit(ip: string): { ok: true } | { ok: false; retryAfterSec: number } {
  const now = Date.now();
  const rec = attemptByIp.get(ip);
  if (rec && rec.lockUntil > now) {
    return { ok: false, retryAfterSec: Math.ceil((rec.lockUntil - now) / 1000) };
  }
  if (!rec || now > rec.resetAt) {
    attemptByIp.set(ip, { count: 1, resetAt: now + ATTEMPT_WINDOW_MS, lockUntil: 0 });
    return { ok: true };
  }
  if (rec.count >= ATTEMPT_MAX_PER_WINDOW) {
    return { ok: false, retryAfterSec: Math.ceil((rec.resetAt - now) / 1000) };
  }
  rec.count += 1;
  return { ok: true };
}

function recordPinFailure(ip: string): void {
  const failures = (consecutiveFailuresByIp.get(ip) ?? 0) + 1;
  consecutiveFailuresByIp.set(ip, failures);
  if (failures >= LOCK_THRESHOLD) {
    const rec = attemptByIp.get(ip) ?? { count: 0, resetAt: 0, lockUntil: 0 };
    rec.lockUntil = Date.now() + LOCK_DURATION_MS;
    attemptByIp.set(ip, rec);
    consecutiveFailuresByIp.set(ip, 0);
  }
}

function recordPinSuccess(ip: string): void {
  consecutiveFailuresByIp.delete(ip);
  attemptByIp.delete(ip);
}

/** Verify the 6-digit PIN and mint a long-lived JWT for the first active user. */
export function verifyPinAndIssueToken(
  ip: string,
  pinInput: unknown,
): { token: string; user: { id: number | bigint; username: string } } {
  const sourceIp = ip || 'unknown';
  const rl = checkRateLimit(sourceIp);
  if (!rl.ok) {
    throw new AppError(`Too many attempts. Retry in ${rl.retryAfterSec}s.`, {
      code: 'PIN_RATE_LIMITED',
      statusCode: 429,
    });
  }

  const expected = getOrCreatePin();
  const candidate = String(pinInput ?? '').trim();
  if (!PIN_REGEX.test(candidate) || candidate !== expected) {
    recordPinFailure(sourceIp);
    throw new AppError('Incorrect PIN', {
      code: 'PIN_INVALID',
      statusCode: 401,
    });
  }

  const user = userDb.getFirstUser();
  if (!user) {
    throw new AppError('No user configured on this server', {
      code: 'PIN_NO_USER',
      statusCode: 500,
    });
  }

  recordPinSuccess(sourceIp);
  userDb.updateLastLogin(Number(user.id));
  // 30d expiry: phones stay logged in for a month. The standard login flow
  // uses 7d, but the QR+PIN flow exists precisely to avoid re-typing on a
  // phone keyboard.
  const token = jwt.sign(
    { userId: user.id, username: user.username },
    JWT_SECRET,
    { expiresIn: '30d' },
  );
  return { token, user: { id: user.id, username: user.username } };
}

// ---------- service ----------

export type TunnelPhase = 'idle' | 'downloading' | 'starting' | 'registering' | 'ready' | 'error';

export type MobileAccessStatus = {
  uiPort: number | null;
  lanUrl: string | null;
  lanQr: string | null;
  lanCandidates: string[];
  lanIpOverride: string;
  tunnelRunning: boolean;
  tunnelUrl: string | null;
  tunnelQr: string | null;
  tunnelState: { phase: TunnelPhase; detail: string; startedAt: number | null };
  pin: string;
};

export function createMobileAccessService({
  uiPort,
}: {
  uiPort: number | null;
}) {
  // Compressing proxy for the tunnel path only. Started lazily on first
  // tunnel request; LAN access goes straight to the Vite/backend port.
  let proxy: { server: unknown; port: number; close: () => Promise<void> } | null = null;
  let tunnel: { url: string; kill: () => void; onExit: (cb: (code: number | null) => void) => () => boolean } | null = null;
  let tunnelAbort: AbortController | null = null;
  let tunnelPromise: Promise<string> | null = null;
  const tunnelState: { phase: TunnelPhase; detail: string; startedAt: number | null } = { phase: 'idle', detail: '', startedAt: null };

  /** QR cache: URL -> data URL promise; status() polls frequently, regenerating is CPU-heavy. */
  const qrCache = new Map<string, Promise<string | null>>();
  async function qrCached(text: string | null): Promise<string | null> {
    if (!text) return null;
    if (!qrCache.has(text)) {
      if (qrCache.size >= 8) {
        const oldest = qrCache.keys().next().value as string | undefined;
        if (oldest !== undefined) qrCache.delete(oldest);
      }
      qrCache.set(text, qrDataUrl(text).catch(() => null));
    }
    return qrCache.get(text) ?? null;
  }

  // Auto-restore marker so a server restart re-launches a previously-open tunnel.
  const autoStatePath = join(homedir(), '.cloudcli', 'mobile-access', 'tunnel-auto.json');
  async function persistAutoTunnel(): Promise<void> {
    try {
      await mkdir(dirname(autoStatePath), { recursive: true });
      await writeFile(autoStatePath, JSON.stringify({ at: Date.now() }), 'utf8');
    } catch { /* ignore */ }
  }
  async function clearAutoTunnel(): Promise<void> {
    try { await rm(autoStatePath, { force: true }); } catch { /* ignore */ }
  }

  const getLanOverride = () => {
    const value = String(lanIpOverride() ?? '').trim();
    return isValidIpv4(value) ? value : '';
  };
  let lanCandidateCache: { at: number; ips: string[] } | null = null;
  const getLanCandidates = async (): Promise<string[]> => {
    const now = Date.now();
    if (!lanCandidateCache || now - lanCandidateCache.at > 15000) {
      lanCandidateCache = { at: now, ips: listLanCandidates(networkInterfaces()) };
    }
    return lanCandidateCache.ips;
  };
  const getLan = async (): Promise<string | null> =>
    getLanOverride() || selectLanIPv4(networkInterfaces());

  return {
    /** Start the compressing proxy on a free port (idempotent). Tunnel path only. */
    async startProxy(): Promise<number> {
      if (proxy) return proxy.port;
      if (!uiPort) throw new Error('UI port unavailable — cannot start proxy');
      let lastErr: unknown = null;
      for (let p = 3082; p < 3092; p++) {
        try {
          proxy = await createCompressingProxy({
            port: p,
            upstream: { host: '127.0.0.1', port: uiPort },
          });
          return proxy.port;
        } catch (err) {
          if ((err as NodeJS.ErrnoException)?.code !== 'EADDRINUSE') throw err;
          lastErr = err;
        }
      }
      throw lastErr ?? new Error('proxy start failed');
    },

    async startTunnel(): Promise<string> {
      if (!uiPort) throw new Error('UI port unavailable — cannot start tunnel');
      const proxyPort = await this.startProxy();
      if (tunnel) return tunnel.url;
      if (tunnelPromise) return tunnelPromise;
      const controller = new AbortController();
      tunnelAbort = controller;
      tunnelState.startedAt = Date.now();
      const onPhase = (phase: string) => {
        tunnelState.phase = phase as TunnelPhase;
        if (phase === 'downloading') tunnelState.detail = 'First run downloads cloudflared (~20MB)';
        else if (phase === 'starting') tunnelState.detail = 'Starting tunnel process...';
        else if (phase === 'registering') tunnelState.detail = 'Connecting to Cloudflare edge (usually 5-30s)';
        else if (phase === 'ready') tunnelState.detail = 'Tunnel ready';
      };
      const p: Promise<string> = new Promise<string>((resolveP, rejectP) => {
        (async (): Promise<void> => {
          try {
            const result = await startQuickTunnel({ port: proxyPort, signal: controller.signal, onPhase });
            tunnel = result;
            tunnelState.phase = 'ready';
            tunnel.onExit((code) => {
              if (controller.signal.aborted) return;
              tunnelState.phase = 'error';
              tunnelState.detail = `Tunnel process exited (code=${code})`;
            });
            void persistAutoTunnel();
            resolveP(tunnel.url);
          } catch (err) {
            if (!controller.signal.aborted) {
              tunnelState.phase = 'error';
              tunnelState.detail = (err as Error)?.message ?? String(err);
            }
            tunnelState.startedAt = null;
            rejectP(err as Error);
          } finally {
            // Only clear our own in-flight reference: a stop+start may already
            // have installed a newer promise.
            if (tunnelPromise === p) {
              tunnelPromise = null;
            }
          }
        })();
      });
      tunnelPromise = p;
      return p;
    },

    stopTunnel(): void {
      tunnelAbort?.abort();
      tunnelAbort = null;
      tunnelPromise = null;
      if (tunnel) tunnel.kill();
      tunnel = null;
      tunnelState.phase = 'idle';
      tunnelState.detail = '';
      tunnelState.startedAt = null;
      void clearAutoTunnel();
    },

    async restoreTunnelIfNeeded(): Promise<void> {
      if (tunnel || tunnelPromise) return;
      let has = false;
      try {
        const raw = await readFile(autoStatePath, 'utf8');
        has = /"at"\s*:/.test(raw);
      } catch { return; }
      if (!has) return;
      try {
        await this.startTunnel();
        console.log('[MobileAccess] public tunnel auto-restored');
      } catch (err) {
        console.warn('[MobileAccess] tunnel auto-restore failed:', (err as Error)?.message);
      }
    },

    async status(): Promise<MobileAccessStatus> {
      const lan = await getLan();
      // QRs point at /mobile-login so a phone scan lands on the PIN pad
      // instead of the desktop login form. Already-authenticated phones are
      // bounced home by ProtectedRoute.
      const lanUrl = lan && uiPort ? `http://${lan}:${uiPort}/mobile-login` : null;
      const tunnelLoginUrl = tunnel?.url ? `${tunnel.url}/mobile-login` : null;
      const override = getLanOverride();
      const candidates = [...new Set(await getLanCandidates())];
      if (override && !candidates.includes(override)) candidates.push(override);
      return {
        uiPort,
        lanUrl,
        lanQr: await qrCached(lanUrl),
        lanCandidates: candidates,
        lanIpOverride: override,
        tunnelRunning: tunnel !== null,
        tunnelUrl: tunnelLoginUrl,
        tunnelQr: await qrCached(tunnelLoginUrl),
        tunnelState: { ...tunnelState },
        pin: getOrCreatePin(),
      };
    },

    async dispose(): Promise<void> {
      this.stopTunnel();
      if (proxy) {
        const p = proxy;
        proxy = null;
        try { await p.close(); } catch { /* already closed */ }
      }
    },
  };
}
