import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { RunStore } from './store.js';
import { ApiError } from './types.js';
import { formatReport } from './report.js';

const DATA_DIR = process.env.DATA_DIR ?? path.join(process.cwd(), 'data');

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ApiError('INVALID_JSON', '请求体不是合法 JSON');
  }
}

function send(res: ServerResponse, status: number, body: unknown, text = false): void {
  res.writeHead(status, { 'content-type': text ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8' });
  res.end(text ? String(body) : JSON.stringify(body));
}

export function startServer(port = 0, dataDir = DATA_DIR): Promise<number> {
  const store = new RunStore(dataDir);
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean);
    try {
      if (req.method === 'GET' && url.pathname === '/health') {
        return send(res, 200, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/runs') {
        return send(res, 201, store.createRun((await readBody(req)) as never));
      }
      if (req.method === 'GET' && url.pathname === '/runs') {
        return send(res, 200, store.listRuns());
      }
      if (req.method === 'POST' && url.pathname === '/compare') {
        return send(res, 200, store.compare((await readBody(req)) as never));
      }
      if (parts[0] === 'runs' && parts.length >= 2) {
        const id = parts[1];
        const sub = parts[2];
        if (req.method === 'GET' && !sub) return send(res, 200, store.getRun(id));
        if (req.method === 'POST' && sub === 'step') return send(res, 200, store.step(id));
        if (req.method === 'POST' && sub === 'run') {
          const body = (await readBody(req)) as { maxSteps?: number };
          return send(res, 200, store.runSteps(id, body.maxSteps ?? 1000));
        }
        if (req.method === 'GET' && sub === 'registers') return send(res, 200, { registers: store.getRegisters(id) });
        if (req.method === 'GET' && sub === 'cycles') {
          const from = Number(url.searchParams.get('from') ?? '1');
          const limit = url.searchParams.get('limit') ? Number(url.searchParams.get('limit')) : undefined;
          return send(res, 200, store.getCycles(id, from, limit));
        }
        if (req.method === 'GET' && sub === 'report') {
          const info = store.getRun(id);
          return send(res, 200, formatReport(info, store.getCycles(id), store.getRegisters(id)), true);
        }
      }
      throw new ApiError('NOT_FOUND', `未知路由: ${req.method} ${url.pathname}`, 404);
    } catch (e) {
      if (e instanceof ApiError) {
        return send(res, e.httpStatus, { error: { code: e.code, message: e.message } });
      }
      return send(res, 500, { error: { code: 'INTERNAL', message: String(e) } });
    }
  });
  return new Promise((resolve) => {
    server.listen(port, () => {
      const addr = server.address();
      const p = typeof addr === 'object' && addr ? addr.port : port;
      console.log(`pipeline-sim API 已启动: http://localhost:${p}  数据目录: ${dataDir}`);
      resolve(p);
    });
  });
}

if (process.argv[1] && process.argv[1].endsWith('server.js')) {
  const portArg = process.argv.find((a) => a.startsWith('--port='));
  const port = portArg ? Number(portArg.split('=')[1]) : Number(process.env.PORT ?? 0);
  void startServer(port);
}
