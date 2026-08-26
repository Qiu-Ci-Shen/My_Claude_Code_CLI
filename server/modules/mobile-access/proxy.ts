// Compressing reverse proxy for the public tunnel path, ported from dsh-pocket
// (GPL-2.0) lib/proxy.mjs — trimmed to what CCUI needs.
//
// CCUI has no loopback trust barrier, so this proxy exists purely for speed and
// link robustness on the tunnel path:
//   1. brotli/gzip compression of text/JSON responses (Vite dev serves every
//      module uncompressed; on a high-latency tunnel that dominates load time)
//   2. WebSocket heartbeat injection — NAT idle timeouts and phone power saving
//      silently kill idle WS connections without a close event, so the client
//      never reconnects (dsh-pocket issue #29 / PR #41).
// The LAN path bypasses this proxy entirely (local bandwidth needs neither).

import { createServer, request as httpRequest, type Server, type OutgoingHttpHeaders } from 'node:http';
import { createGzip, createBrotliCompress, constants as zlibConstants } from 'node:zlib';
import type { Socket } from 'node:net';
import type { Duplex } from 'node:stream';

type Upstream = { host: string; port: number };

function isCompressed(headers: Record<string, unknown>): boolean {
  return /(^|,\s*)(gzip|br|deflate)(\s*,|$)/i.test(String(headers['content-encoding'] ?? ''));
}

/** Protocol-level WS Ping frame: FIN + opcode 9, zero length, server→client unmasked. */
const WS_PING_FRAME = Buffer.from([0x89, 0x00]);

/**
 * Ping the browser side every intervalMs; any inbound bytes reset the silence
 * counter. After missLimit silent periods the link is presumed dead and the
 * socket is destroyed so the client sees a close event and reconnects.
 * Only the browser side needs pinging — the upstream is loopback.
 */
function attachWebSocketHeartbeat(socket: Socket, { intervalMs = 30_000, missLimit = 2 } = {}): void {
  let misses = 0;
  let stopped = false;
  const onInbound = () => { misses = 0; };
  const timer = setInterval(() => {
    if (stopped) return;
    misses += 1;
    if (misses >= missLimit) {
      socket.destroy();
      return;
    }
    if (!socket.destroyed) {
      try { socket.write(WS_PING_FRAME); } catch { /* ignore */ }
    }
  }, intervalMs);
  timer.unref?.();
  socket.on('data', onInbound);
  const cleanup = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    socket.off('data', onInbound);
    socket.off('close', cleanup);
    socket.off('error', cleanup);
  };
  socket.on('close', cleanup);
  socket.on('error', cleanup);
}

/** Rewrite Host/Origin to the upstream authority so Vite/backend always see a known host. */
function upstreamAuthority(headers: OutgoingHttpHeaders, upstream: Upstream): OutgoingHttpHeaders {
  const authority = `${upstream.host}:${upstream.port}`;
  headers.host = authority;
  if (headers.origin) headers.origin = `http://${authority}`;
  return headers;
}

export function createCompressingProxy({
  port = 3082,
  host = '0.0.0.0',
  upstream,
  log = null,
  heartbeat = {},
}: {
  port?: number;
  host?: string;
  upstream: Upstream;
  log?: ((msg: string) => void) | null;
  heartbeat?: { intervalMs?: number; missLimit?: number } | false;
}): Promise<{ server: Server; port: number; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    const headers = upstreamAuthority({ ...req.headers }, upstream);
    const proxyReq = httpRequest(
      { host: upstream.host, port: upstream.port, method: req.method, path: req.url, headers, agent: false },
      (proxyRes) => {
        log?.(`${req.method} ${req.url} -> ${proxyRes.statusCode}`);
        const contentType = String(proxyRes.headers['content-type'] ?? '');
        const acceptEncoding = String(req.headers['accept-encoding'] ?? '');
        const canGzip = /\bgzip\b/.test(acceptEncoding);
        const canBr = /\bbr\b/.test(acceptEncoding);
        const isEventStream = contentType.includes('text/event-stream');
        const knownLen = Number(proxyRes.headers['content-length'] || 0);
        // Compress JSON/text at least 1KB; skip already-compressed, SSE streams.
        // Brotli quality 6: zlib default q11 takes 40s+ on large payloads, q6 is
        // ~128ms and smaller than gzip output (dsh-pocket issue #25).
        const shouldCompress = (canGzip || canBr)
          && !isCompressed(proxyRes.headers)
          && !isEventStream
          && (contentType.includes('application/json') || contentType.startsWith('text/'))
          && (knownLen === 0 || knownLen >= 1024);
        if (shouldCompress) {
          const enc = canBr ? 'br' : 'gzip';
          const outHeaders = { ...proxyRes.headers };
          delete outHeaders['content-length'];
          delete outHeaders['transfer-encoding'];
          outHeaders['content-encoding'] = enc;
          res.writeHead(proxyRes.statusCode ?? 200, outHeaders);
          const z = enc === 'br'
            ? createBrotliCompress({ params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 6 } })
            : createGzip();
          proxyRes.pipe(z).pipe(res);
          // Tear down all three streams on any abnormal close. Do NOT use
          // proxyRes 'close' to end res — it also fires after normal completion
          // and would truncate the compressor's final bytes; 'aborted' is the
          // mid-flight signal.
          res.on('close', () => { proxyRes.destroy(); z.destroy(); });
          proxyRes.on('error', () => { z.destroy(); res.destroy(); });
          proxyRes.on('aborted', () => { z.destroy(); res.destroy(); });
          z.on('error', () => res.destroy());
          return;
        }
        res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
        proxyRes.pipe(res);
        res.on('close', () => proxyRes.destroy());
        proxyRes.on('error', () => res.destroy());
        proxyRes.on('close', () => { if (!res.writableEnded) res.destroy(); });
      },
    );
    proxyReq.on('error', (err) => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`mobile-access proxy: cannot reach upstream (${upstream.host}:${upstream.port}) — is CCUI running? | ${err.message}`);
    });
    req.pipe(proxyReq);
  });

  // WebSocket upgrade passthrough (Vite HMR + CCUI /ws, /shell, /plugin-ws).
  server.on('upgrade', (req, socket, head) => {
    const headers = upstreamAuthority({ ...req.headers }, upstream);
    const proxyReq = httpRequest({
      host: upstream.host, port: upstream.port, method: req.method, path: req.url, headers, agent: false,
    });
    proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
      socket.write('HTTP/1.1 101 Switching Protocols\r\n');
      const raw: string[] = [];
      for (const [k, v] of Object.entries(proxyRes.headers)) {
        raw.push(`${k}: ${Array.isArray(v) ? v.join(', ') : v}`);
      }
      socket.write(`${raw.join('\r\n')}\r\n\r\n`);
      if (proxyHead?.length) socket.write(proxyHead);
      proxySocket.pipe(socket);
      socket.pipe(proxySocket);
      if (heartbeat !== false) attachWebSocketHeartbeat(socket as Socket, heartbeat ?? {});
      const teardown = () => { try { proxySocket.destroy(); } catch {} try { socket.destroy(); } catch {} };
      // An unhandled 'error' on the upstream socket would crash the whole
      // server process — swallow and tear down both sides instead.
      proxySocket.on('error', () => { try { socket.destroy(); } catch {} });
      proxySocket.on('close', teardown);
      socket.on('close', teardown);
    });
    // Upstream answered with a plain HTTP response instead of 101: relay status
    // and headers, then close — never leave the client hanging.
    proxyReq.on('response', (proxyRes) => {
      if (proxyRes.statusCode === 101) return;
      try {
        const raw = [`HTTP/1.1 ${proxyRes.statusCode} ${proxyRes.statusMessage ?? ''}`.trim()];
        for (const [k, v] of Object.entries(proxyRes.headers)) {
          raw.push(`${k}: ${Array.isArray(v) ? v.join(', ') : v}`);
        }
        socket.end(raw.join('\r\n') + '\r\n\r\n');
        proxyRes.resume();
      } catch { socket.destroy(); }
    });
    proxyReq.on('error', () => socket.destroy());
    // Browsers may send the first WS frame immediately after the handshake
    // request; Node surfaces it as `head`. It must reach the upstream inside
    // the upgrade handshake, not as late socket data after 101.
    if (head?.length) proxyReq.write(head);
    proxyReq.end();
    socket.on('error', () => socket.destroy());
  });

  // Track all TCP connections including upgraded WS sockets — Node's
  // closeAllConnections skips those, and close() would wait forever.
  const clientSockets = new Set<Socket>();
  server.on('connection', (sock) => {
    clientSockets.add(sock);
    sock.on('close', () => clientSockets.delete(sock));
    sock.on('error', () => {}); // never let an unhandled error crash the process
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const address = server.address();
      const actualPort = typeof address === 'object' && address ? address.port : port;
      resolve({
        server,
        port: actualPort,
        close: () => new Promise<void>((r) => {
          for (const s of clientSockets) { try { s.destroy(); } catch { /* ignore */ } }
          server.close(() => r());
        }),
      });
    });
  });
}
