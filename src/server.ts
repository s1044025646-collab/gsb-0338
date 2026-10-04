import * as http from 'node:http';
import * as path from 'node:path';
import { compareModes } from './compare';
import { renderReport } from './report';
import { Store } from './store';
import { ProgramSpec, SimError } from './types';
import { validateProgram } from './validate';

const DATA_DIR = process.env.DATA_DIR ?? path.join(process.cwd(), 'data');
const DB_PATH = process.env.DB_PATH ?? path.join(DATA_DIR, 'pipeline.db');

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const text = typeof body === 'string' ? body : JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'Content-Type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
  });
  res.end(text);
}

function sendError(res: http.ServerResponse, e: unknown): void {
  if (e instanceof SimError) {
    const status = e.code === 'NOT_FOUND' ? 404
      : e.code === 'RUN_COMPLETED' || e.code === 'RUN_FAILED' || e.code === 'BUDGET_EXHAUSTED' ? 409
      : 400;
    send(res, status, { error: { code: e.code, message: e.message, instrId: e.instrId } });
  } else {
    send(res, 500, { error: { code: 'INTERNAL', message: e instanceof Error ? e.message : String(e) } });
  }
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new SimError('INVALID_JSON', '请求体不是合法 JSON');
  }
}

export function createServer(store: Store): http.Server {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const parts = url.pathname.split('/').filter(Boolean);
      const method = req.method ?? 'GET';
      const body = method === 'POST' ? await readBody(req) : {};

      if (method === 'POST' && parts.length === 1 && parts[0] === 'programs') {
        const id = store.createProgram(body as ProgramSpec);
        return send(res, 201, { programId: id });
      }
      if (method === 'POST' && parts.length === 1 && parts[0] === 'validate') {
        validateProgram(body as ProgramSpec, store.limits);
        return send(res, 200, { ok: true });
      }
      if (parts[0] === 'programs' && parts.length >= 2) {
        const programId = Number(parts[1]);
        if (method === 'POST' && parts[2] === 'runs' && parts.length === 3) {
          const b = body as { forwarding?: boolean; maxCycles?: number };
          if (typeof b.forwarding !== 'boolean') {
            throw new SimError('INVALID_ARGUMENT', 'forwarding 必须是布尔值，且创建后不可更改');
          }
          const runId = store.createRun(programId, b.forwarding, b.maxCycles);
          return send(res, 201, { runId });
        }
        if (method === 'POST' && parts[2] === 'compare' && parts.length === 3) {
          const b = body as { maxCycles?: number };
          return send(res, 200, compareModes(store, programId, b.maxCycles));
        }
      }
      if (parts[0] === 'runs' && parts.length >= 2) {
        const runId = Number(parts[1]);
        if (!Number.isInteger(runId)) throw new SimError('INVALID_ARGUMENT', 'runId 非法');
        if (method === 'POST' && parts[2] === 'step' && parts.length === 3) {
          return send(res, 200, store.stepRun(runId));
        }
        if (method === 'POST' && parts[2] === 'run' && parts.length === 3) {
          const b = body as { cycles?: number };
          return send(res, 200, store.runCycles(runId, b.cycles ?? 1));
        }
        if (method === 'GET' && parts.length === 2) {
          const r = store.getRun(runId);
          return send(res, 200, {
            runId: r.id, programId: r.program_id, forwarding: r.forwarding === 1,
            status: r.status, cycle: r.cycle, maxCycles: r.max_cycles, error: r.error,
          });
        }
        if (method === 'GET' && parts[2] === 'registers' && parts.length === 3) {
          return send(res, 200, { registers: store.getRegisters(runId) });
        }
        if (method === 'GET' && parts[2] === 'cycles' && parts.length === 3) {
          const from = url.searchParams.has('from') ? Number(url.searchParams.get('from')) : 0;
          const to = url.searchParams.has('to') ? Number(url.searchParams.get('to')) : undefined;
          return send(res, 200, { cycles: store.getCycles(runId, from, to) });
        }
        if (method === 'GET' && parts[2] === 'report' && parts.length === 3) {
          const r = store.getRun(runId);
          const text = renderReport(store.getCycles(runId), {
            forwarding: r.forwarding === 1, status: r.status, finalRegs: store.getRegisters(runId),
          });
          return send(res, 200, text);
        }
      }
      if (method === 'GET' && parts.length === 1 && parts[0] === 'runs') {
        return send(res, 200, { runs: store.listRuns() });
      }
      if (method === 'GET' && parts.length === 1 && parts[0] === 'limits') {
        return send(res, 200, store.limits);
      }
      send(res, 404, { error: { code: 'NOT_FOUND', message: `未知路由: ${method} ${url.pathname}` } });
    } catch (e) {
      sendError(res, e);
    }
  });
}

if (require.main === module) {
  const store = new Store(DB_PATH);
  const server = createServer(store);
  const port = process.env.PORT ? Number(process.env.PORT) : 0; // 默认选择空闲端口
  server.listen(port, () => {
    const addr = server.address();
    const p = typeof addr === 'object' && addr ? addr.port : port;
    console.log(`流水线模拟服务已启动: http://127.0.0.1:${p}  (数据库: ${DB_PATH})`);
  });
}
