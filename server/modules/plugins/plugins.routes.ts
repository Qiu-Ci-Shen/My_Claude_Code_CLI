import fs from 'node:fs';
import http from 'node:http';

import express from 'express';

import { chatRunRegistry } from '@/modules/websocket/index.js';

import type { createPluginsService } from './plugins.service.js';

function wildcardPath(req: express.Request): string {
  return ((req.params as Record<string, string>)['0'] ?? '').trim();
}

function routeParameter(value: string | string[]): string {
  return Array.isArray(value) ? value[0] ?? '' : value;
}

/** Creates plugin routes; transport streaming remains here while decisions live in the service. */
export function createPluginsRouter(service: ReturnType<typeof createPluginsService>): express.Router {
  const router = express.Router();
  const respond = (operation: (req: express.Request) => unknown | Promise<unknown>) =>
    async (req: express.Request, res: express.Response, next: express.NextFunction) => {
      try { res.json(await operation(req)); } catch (error) { next(error); }
    };

  router.get('/', respond(() => service.list()));
  router.get('/:name/manifest', respond((req) => service.getManifest(routeParameter(req.params.name))));
  router.get('/:name/assets/*', async (req, res, next) => {
    try {
      const asset = service.resolveAsset(routeParameter(req.params.name), wildcardPath(req));
      res.setHeader('Content-Type', asset.contentType);
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      const stream = fs.createReadStream(asset.path);
      stream.on('error', next);
      stream.pipe(res);
    } catch (error) { next(error); }
  });
  router.put('/:name/enable', respond((req) => service.setEnabled(routeParameter(req.params.name), req.body?.enabled)));
  router.post('/install', respond((req) => service.install(req.body?.url)));
  router.post('/:name/update', respond((req) => service.update(routeParameter(req.params.name))));
  router.all('/:name/rpc/*', async (req, res, next) => {
    try {
      const pluginName = routeParameter(req.params.name);
      const rpcPath = wildcardPath(req);
      // claude-rewind 的截断会重写转录 jsonl；会话仍在生成时 CLI 也在并发
      // 写同一个文件，必须先拒绝，避免截断与写入竞态（打断失败的兜底）。
      if (
        pluginName === 'claude-rewind'
        && rpcPath === '/rewind'
        && req.body?.sessionId
        && chatRunRegistry.isProcessing(String(req.body.sessionId))
      ) {
        res.status(409).json({ ok: false, error: '会话仍在生成中，请先打断再回退' });
        return;
      }
      const { port, secrets } = await service.prepareRpc(pluginName);
      const headers: Record<string, string> = {
        'content-type': String(req.headers['content-type'] ?? 'application/json'),
      };
      for (const [key, value] of Object.entries(secrets)) {
        headers[`x-plugin-secret-${key.toLowerCase()}`] = String(value);
      }
      const query = req.url.includes('?') ? `?${req.url.split('?').slice(1).join('?')}` : '';
      const proxyRequest = http.request({
        hostname: '127.0.0.1', port, path: `/${wildcardPath(req)}${query}`, method: req.method, headers,
      }, (proxyResponse) => {
        res.writeHead(proxyResponse.statusCode ?? 502, proxyResponse.headers);
        proxyResponse.pipe(res);
      });
      proxyRequest.on('error', next);
      if (req.headers['content-length'] && req.body !== undefined) {
        const body = JSON.stringify(req.body);
        proxyRequest.setHeader('content-length', Buffer.byteLength(body));
        proxyRequest.write(body);
      }
      proxyRequest.end();
    } catch (error) { next(error); }
  });
  router.delete('/:name', respond((req) => service.uninstall(routeParameter(req.params.name))));
  return router;
}
