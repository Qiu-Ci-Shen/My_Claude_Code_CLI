// cloudflared quick tunnel, ported from dsh-pocket (GPL-2.0) lib/tunnel.mjs.
// Exposes a local port as a public https://<random>.trycloudflare.com URL.

import { spawn, execSync } from 'node:child_process';
import { mkdir, access, chmod, rm, stat, rename, cp, open } from 'node:fs/promises';
import os from 'node:os';
import { join, dirname } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { createWriteStream, createReadStream } from 'node:fs';

// (?!api\.) excludes the reserved api subdomain some cloudflared versions print
// before the real tunnel URL (dsh-pocket issue #32).
export const QUICK_TUNNEL_URL_RE = /https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/i;

function platformBinary() {
  const archMap: Record<string, string> = { x64: 'amd64', arm64: 'arm64' };
  const a = archMap[process.arch] ?? process.arch;
  const osName = process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'windows' : 'linux';
  return { os: osName, a, ext: osName === 'windows' ? '.exe' : '' };
}

const CLOUDFLARED_MIRRORS = [
  (asset: string) => `https://github.com/cloudflare/cloudflared/releases/latest/download/${asset}`,
  (asset: string) => `https://ghproxy.net/https://github.com/cloudflare/cloudflared/releases/latest/download/${asset}`,
  (asset: string) => `https://gh.ddlc.top/https://github.com/cloudflare/cloudflared/releases/latest/download/${asset}`,
  (asset: string) => `https://gh-proxy.com/https://github.com/cloudflare/cloudflared/releases/latest/download/${asset}`,
];

const PARALLEL_SEGMENTS = 8;
const MIN_PARALLEL_SIZE = 8 * 1024 * 1024;
const PROBE_SIZE = 2 * 1024 * 1024;
const SLOW_SPEED_THRESHOLD = 0.3;

function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return url; }
}

async function mergeParts(partFiles: string[], dest: string): Promise<void> {
  const out = createWriteStream(dest);
  try {
    for (const f of partFiles) {
      await new Promise<void>((resolve, reject) => {
        const rs = createReadStream(f);
        rs.on('error', reject);
        rs.pipe(out, { end: false });
        rs.on('end', () => resolve());
      });
    }
  } finally {
    await new Promise<void>((r) => out.end(() => r()));
  }
}

/** Adaptive download: single-threaded when fast enough, parallel range chunks otherwise. */
async function downloadFile(url: string, dest: string, { signal }: { signal?: AbortSignal } = {}): Promise<number> {
  let head: Response | null = null;
  try { head = await fetch(url, { method: 'HEAD', signal }); } catch { head = null; }
  const len = head ? Number(head.headers.get('content-length') || 0) : 0;
  const acceptsRanges = head ? String(head.headers.get('accept-ranges') || '').toLowerCase() === 'bytes' : false;

  if (!head || !acceptsRanges || len < MIN_PARALLEL_SIZE) {
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (!res.body) throw new Error('empty response body');
    await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), createWriteStream(dest));
    return len || 0;
  }

  const probeBytes = Math.min(PROBE_SIZE, len);
  const probeStart = Date.now();
  try {
    const probeRes = await fetch(url, { signal, headers: { Range: `bytes=0-${probeBytes - 1}` } });
    if (!probeRes.ok) throw new Error(`HTTP ${probeRes.status} (probe)`);
    const probeBody = await probeRes.arrayBuffer();
    const probeMs = Date.now() - probeStart;
    const probeSpeed = probeMs > 0 ? probeBytes / probeMs : Infinity;
    if (probeMs < 500 || probeSpeed >= SLOW_SPEED_THRESHOLD) {
      const w = createWriteStream(dest);
      await new Promise<void>((resolve, reject) => {
        w.on('error', reject);
        w.write(Buffer.from(probeBody));
        w.end(() => resolve());
      });
      const restRes = await fetch(url, { signal, headers: { Range: `bytes=${probeBytes}-${len - 1}` } });
      if (!restRes.ok) throw new Error(`HTTP ${restRes.status} (rest)`);
      if (!restRes.body) throw new Error('empty response body');
      await pipeline(Readable.fromWeb(restRes.body as import('node:stream/web').ReadableStream), createWriteStream(dest, { flags: 'a' }));
      return len;
    }
    await rm(dest, { force: true }).catch(() => {});
  } catch (err) {
    await rm(dest, { force: true }).catch(() => {});
    if (!/HTTP|fetch/i.test(String((err as Error)?.message ?? ''))) throw err;
  }

  const parts: { start: number; end: number; file: string }[] = [];
  const chunk = Math.ceil(len / PARALLEL_SEGMENTS);
  for (let i = 0; i < PARALLEL_SEGMENTS; i++) {
    const start = i * chunk;
    const end = i === PARALLEL_SEGMENTS - 1 ? len - 1 : Math.min(start + chunk - 1, len - 1);
    if (start > end) break;
    parts.push({ start, end, file: `${dest}.part${i}` });
  }
  try {
    await Promise.all(parts.map(async (p) => {
      const res = await fetch(url, { signal, headers: { Range: `bytes=${p.start}-${p.end}` } });
      if (!res.ok) throw new Error(`HTTP ${res.status} (range ${p.start}-${p.end})`);
      if (!res.body) throw new Error('empty response body');
      await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), createWriteStream(p.file));
    }));
    await mergeParts(parts.map((p) => p.file), dest);
  } finally {
    await Promise.all(parts.map((p) => rm(p.file, { force: true }).catch(() => {})));
  }
  return len;
}

async function downloadCloudflared(binPath: string, signal?: AbortSignal): Promise<string> {
  const { os: osName, a, ext } = platformBinary();
  const dir = dirname(binPath);
  const tmpFile = join(dir, 'cloudflared.download');
  const isWindows = osName === 'windows';
  const asset = isWindows ? `cloudflared-windows-${a}.exe` : `cloudflared-${osName}-${a}.tgz`;
  const fetchSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(120_000)])
    : AbortSignal.timeout(120_000);

  const sources = CLOUDFLARED_MIRRORS.map((m) => ({ url: m(asset), host: hostOf(m(asset)) }));

  let lastErr: unknown = null;
  for (let i = 0; i < sources.length; i++) {
    const { url, host } = sources[i];
    console.log(`[MobileAccess] downloading cloudflared (${i + 1}/${sources.length}: ${host})...`);
    try {
      await downloadFile(url, tmpFile, { signal: fetchSignal });
      const st = await stat(tmpFile);
      if (st.size < 1024 * 1024) throw new Error(`file suspiciously small (${st.size} bytes)`);
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
      await rm(tmpFile, { force: true }).catch(() => {});
      console.warn(`[MobileAccess] mirror ${i + 1} failed: ${(err as Error)?.message}, trying next...`);
    }
  }
  if (lastErr) {
    throw new Error(
      `cloudflared download failed — all mirrors unreachable (last error: ${(lastErr as Error)?.message ?? lastErr}). `
      + (isWindows
        ? `Install manually then retry: winget install cloudflared; or put ${asset} into ${dir}`
        : `Install manually then retry: npm i -g cloudflared`),
    );
  }

  const extracted = join(dir, `cloudflared${ext}`);
  if (isWindows) {
    await rename(tmpFile, extracted).catch(async () => {
      await cp(tmpFile, extracted).catch(() => {});
    });
  } else {
    const extractDir = join(dir, `.extract-${process.pid}-${Date.now()}`);
    await mkdir(extractDir, { recursive: true });
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn('tar', ['-xzf', tmpFile, '-C', extractDir], { stdio: 'ignore' });
        child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`cloudflared extract failed (code=${code})`)));
        child.once('error', reject);
      });
      const { readdir } = await import('node:fs/promises');
      let found: string | null = null;
      const direct = join(extractDir, `cloudflared${ext}`);
      try { if ((await stat(direct)).isFile()) found = direct; } catch { /* not present */ }
      if (!found) {
        const verDir = join(extractDir, 'cloudflared');
        try {
          const vers = await readdir(verDir);
          for (const v of vers) {
            const bin = join(verDir, v, 'bin', `cloudflared${ext}`);
            try { if ((await stat(bin)).isFile()) { found = bin; break; } } catch { /* keep looking */ }
          }
        } catch { /* no version dir */ }
      }
      if (!found) throw new Error('binary not found after extract');
      if (found !== extracted) {
        await rename(found, extracted).catch(async () => { await cp(found, extracted).catch(() => {}); });
      }
    } finally {
      await rm(extractDir, { recursive: true, force: true }).catch(() => {});
    }
  }
  if (!isWindows) await chmod(extracted, 0o755);
  await rm(tmpFile, { force: true }).catch(() => {});
  return extracted;
}

function cloudflaredOnPath(): boolean {
  try {
    execSync(process.platform === 'win32' ? 'where cloudflared' : 'command -v cloudflared', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

let downloading: Promise<string> | null = null;

/** Resolve a usable cloudflared binary: PATH first, then persistent cache, else download. */
export async function resolveCloudflared({ home, onPhase = () => {}, signal }: {
  home?: string;
  onPhase?: (phase: string) => void;
  signal?: AbortSignal;
} = {}): Promise<string> {
  if (cloudflaredOnPath()) return 'cloudflared';
  const cacheDir = join(home ?? join(os.homedir(), '.cloudcli'), 'mobile-access', 'bin');
  const { os: osName, a, ext } = platformBinary();
  const candidates = [
    join(cacheDir, `cloudflared${ext}`),
    join(cacheDir, `cloudflared-${osName}-${a}${ext}`),
  ];
  for (const bin of candidates) {
    try {
      await access(bin);
      return bin;
    } catch { /* keep looking */ }
  }
  onPhase('downloading');
  await mkdir(cacheDir, { recursive: true });
  if (!downloading) {
    downloading = downloadCloudflared(join(cacheDir, `cloudflared${ext}`), signal).finally(() => { downloading = null; });
  }
  return downloading;
}

/**
 * Start a cloudflared quick tunnel and resolve with its public URL.
 * Forces HTTP/2 (TCP 443) instead of QUIC (UDP 7844): many networks block that UDP port.
 */
export async function startQuickTunnel({ port, home, signal, onPhase = () => {} }: {
  port: number;
  home?: string;
  signal?: AbortSignal;
  onPhase?: (phase: string) => void;
}): Promise<{ url: string; kill: () => void; onExit: (cb: (code: number | null) => void) => () => boolean }> {
  const bin = await resolveCloudflared({ home, onPhase, signal });
  onPhase('starting');
  const child = spawn(bin, ['tunnel', '--url', `http://127.0.0.1:${port}`, '--protocol', 'http2', '--no-autoupdate'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.on('error', (err) => {
    cleanup?.();
    onPhase?.('error');
    rejectErr?.(new Error(`cloudflared failed to start: ${err?.message ?? err} (delete the mobile-access/bin cache and retry)`));
  });
  onPhase('registering');

  let cleanup: (() => void) | null = null;
  let rejectErr: ((err: Error) => void) | null = null;
  const url = await new Promise<string>((resolve, reject) => {
    let buf = '';
    const onData = (chunk: Buffer) => {
      buf += String(chunk);
      const m = buf.match(QUICK_TUNNEL_URL_RE);
      if (m) {
        cleanup?.();
        onPhase('ready');
        resolve(m[0]);
      }
    };
    const onExit = (code: number | null) => {
      cleanup?.();
      reject(new Error(`cloudflared exited (code=${code})`));
    };
    cleanup = () => {
      child.stdout.off('data', onData);
      child.stderr.off('data', onData);
      child.off('exit', onExit);
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      // Keep consuming output after removing listeners so a full pipe buffer
      // cannot stall the cloudflared process.
      child.stdout.resume();
      child.stderr.resume();
    };
    const onAbort = () => {
      cleanup?.();
      child.kill();
      reject(new Error('cancelled'));
    };
    const timer = setTimeout(() => {
      cleanup?.();
      child.kill();
      reject(new Error(
        'cloudflared startup timed out (30s) — if you run a proxy/VPN (Clash etc., TUN mode), it can block the tunnel; quit it and retry',
      ));
    }, 30_000);

    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', onExit);
    signal?.addEventListener('abort', onAbort, { once: true });
    rejectErr = reject;
  });

  const exitListeners = new Set<(code: number | null) => void>();
  child.on('exit', (code) => {
    for (const cb of exitListeners) cb(code);
  });

  return {
    url,
    kill: () => {
      try { child.kill(); } catch { /* ignore */ }
    },
    onExit: (cb) => {
      exitListeners.add(cb);
      return () => exitListeners.delete(cb);
    },
  };
}
