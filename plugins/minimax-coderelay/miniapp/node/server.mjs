import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Relay } from './relay.mjs';
import { problem, safeCode } from './state.mjs';

const ASSETS = new Map([
  ['/dashboard', ['index.html', 'text/html; charset=utf-8']],
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
]);

async function readJson(request) {
  if (!String(request.headers['content-type'] || '').startsWith('application/json'))
    throw problem('JSON_REQUIRED', 415);
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 128 * 1024) throw problem('BODY_TOO_LARGE', 413);
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error();
    return value;
  } catch {
    throw problem('INVALID_JSON');
  }
}

function json(response, status, value) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(JSON.stringify(value));
}

/** Host-authenticated loopback entry. No Agent calls or network activity in start. */
export async function start(context) {
  const relay = new Relay(context);
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://miniapp.local');
      if (request.method === 'GET' && ASSETS.has(url.pathname)) {
        const [name, type] = ASSETS.get(url.pathname);
        const data = await readFile(join(context.pluginRoot, 'miniapp', 'client', name));
        response.writeHead(200, {
          'content-type': type,
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
          'content-security-policy':
            "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
        });
        response.end(data);
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/status') {
        json(response, 200, await relay.status());
        return;
      }
      if (request.method !== 'POST') throw problem('NOT_FOUND', 404);
      // The MiniMax host validates the real caller and strips its per-run credential.
      // Do not inspect, forward, or replace that credential here.
      const body = await readJson(request);
      let result;
      switch (url.pathname) {
        case '/api/pair':
          result = await relay.pair(body);
          break;
        case '/api/projects/bind':
          result = await relay.bind(body);
          break;
        case '/api/verification':
          result = await relay.setVerification(body);
          break;
        case '/api/connect':
          result = await relay.connect();
          break;
        case '/api/pause':
          result = await relay.disconnect();
          break;
        case '/api/command':
          await relay.init();
          result = await relay.localCommand(body.taskId, body);
          break;
        case '/api/reconcile-status':
          result = await relay.reconcileStatus(body.taskId);
          break;
        default:
          throw problem('NOT_FOUND', 404);
      }
      json(response, 200, result);
    } catch (error) {
      // Host errors can include credential paths or upstream text: return bounded codes only.
      json(response, error.status || 500, { error: { code: safeCode(error) } });
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(context.listen.port, context.listen.host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  let stopped = false;
  const dispose = async () => {
    if (stopped) return;
    stopped = true;
    context.signal.removeEventListener('abort', onAbort);
    await relay.dispose();
    server.closeIdleConnections();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  };
  const onAbort = () => {
    void dispose().catch(() => context.logger.error('coderelay.shutdown_failed'));
  };
  context.signal.addEventListener('abort', onAbort, { once: true });
  if (context.signal.aborted) await dispose();
  context.logger.info('coderelay.ready');
  return { dispose };
}
