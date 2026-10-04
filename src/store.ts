import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import {
  ApiError,
  CycleRecord,
  DEFAULT_CONFIG,
  Instr,
  PipeState,
  RunConfig,
} from './types.js';
import { validateMemory, validateProgram, validateRegisters } from './validate.js';
import { initialState, step } from './simulator.js';
import { interpret } from './interpreter.js';

export interface CreateRunInput {
  program: unknown;
  registers?: unknown;
  memory?: unknown;
  forwarding?: boolean;
  maxCycles?: number;
}

export interface RunInfo {
  id: string;
  forwarding: boolean;
  status: string;
  cycle: number;
  programLength: number;
  config: RunConfig;
  error?: unknown;
  createdAt: string;
}

export class RunStore {
  private db: DatabaseSync;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(path.join(dataDir, 'pipeline.db'));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        program TEXT NOT NULL,
        init_regs TEXT NOT NULL,
        memory TEXT NOT NULL,
        config TEXT NOT NULL,
        state TEXT NOT NULL,
        status TEXT NOT NULL,
        cycle INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS cycles (
        run_id TEXT NOT NULL,
        cycle INTEGER NOT NULL,
        record TEXT NOT NULL,
        PRIMARY KEY (run_id, cycle)
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  createRun(input: CreateRunInput): RunInfo {
    const config: RunConfig = { ...DEFAULT_CONFIG };
    if (input.forwarding !== undefined) {
      if (typeof input.forwarding !== 'boolean') {
        throw new ApiError('INVALID_CONFIG', 'forwarding 必须是布尔值');
      }
      config.forwarding = input.forwarding;
    }
    if (input.maxCycles !== undefined) {
      if (!Number.isInteger(input.maxCycles) || input.maxCycles <= 0) {
        throw new ApiError('INVALID_CONFIG', 'maxCycles 必须是正整数');
      }
      config.maxCycles = input.maxCycles;
    }
    const program = validateProgram(input.program, config);
    const regs = validateRegisters(input.registers);
    const memory = validateMemory(input.memory, config);
    const id = randomUUID();
    const state = initialState(regs);
    if (program.length === 0) {
      state.status = 'done';
    } else {
      // 约定：第 1 周期第一条指令已处于 IF 级。
      state.ifStage = program[0];
      state.pc = 1;
    }
    this.db
      .prepare(
        `INSERT INTO runs (id, program, init_regs, memory, config, state, status, cycle, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        JSON.stringify(program),
        JSON.stringify(regs),
        JSON.stringify(memory),
        JSON.stringify(config),
        JSON.stringify(state),
        state.status,
        state.cycle,
        new Date().toISOString(),
      );
    return this.getRun(id);
  }

  private row(id: string): Record<string, unknown> {
    const r = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    if (!r) throw new ApiError('RUN_NOT_FOUND', `运行 ${id} 不存在`, 404);
    return r;
  }

  getRun(id: string): RunInfo {
    const r = this.row(id);
    const state = JSON.parse(r.state as string) as PipeState;
    return {
      id,
      forwarding: (JSON.parse(r.config as string) as RunConfig).forwarding,
      status: r.status as string,
      cycle: r.cycle as number,
      programLength: (JSON.parse(r.program as string) as Instr[]).length,
      config: JSON.parse(r.config as string) as RunConfig,
      error: state.error,
      createdAt: r.created_at as string,
    };
  }

  listRuns(): RunInfo[] {
    const rows = this.db.prepare('SELECT id FROM runs ORDER BY created_at').all() as { id: string }[];
    return rows.map((r) => this.getRun(r.id));
  }

  getProgram(id: string): Instr[] {
    return JSON.parse(this.row(id).program as string) as Instr[];
  }

  getState(id: string): PipeState {
    return JSON.parse(this.row(id).state as string) as PipeState;
  }

  getRegisters(id: string): number[] {
    return this.getState(id).regs;
  }

  /** 原子推进一个周期：状态更新与周期记录在同一事务提交。 */
  step(id: string): CycleRecord {
    const r = this.row(id);
    const program = JSON.parse(r.program as string) as Instr[];
    const memory = JSON.parse(r.memory as string) as Record<number, number>;
    const config = JSON.parse(r.config as string) as RunConfig;
    const state = JSON.parse(r.state as string) as PipeState;
    const { state: next, record } = step(state, program, memory, config);
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare('INSERT INTO cycles (run_id, cycle, record) VALUES (?, ?, ?)')
        .run(id, record.cycle, JSON.stringify(record));
      this.db
        .prepare('UPDATE runs SET state = ?, status = ?, cycle = ? WHERE id = ?')
        .run(JSON.stringify(next), next.status, next.cycle, id);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return record;
  }

  runSteps(id: string, maxSteps: number): { records: CycleRecord[]; info: RunInfo } {
    if (!Number.isInteger(maxSteps) || maxSteps <= 0 || maxSteps > 100000) {
      throw new ApiError('INVALID_CONFIG', 'maxSteps 必须是 1..100000 的整数');
    }
    const records: CycleRecord[] = [];
    for (let i = 0; i < maxSteps; i++) {
      const info = this.getRun(id);
      if (info.status !== 'running') break;
      records.push(this.step(id));
    }
    return { records, info: this.getRun(id) };
  }

  getCycles(id: string, from = 1, limit?: number): CycleRecord[] {
    const info = this.getRun(id);
    const lim = Math.min(limit ?? info.config.reportLimit, info.config.reportLimit);
    const rows = this.db
      .prepare('SELECT record FROM cycles WHERE run_id = ? AND cycle >= ? ORDER BY cycle LIMIT ?')
      .all(id, from, lim) as { record: string }[];
    return rows.map((r) => JSON.parse(r.record) as CycleRecord);
  }

  /** 比较模式：创建两个独立运行（转发开/关），各自跑到底后对比。 */
  compare(input: Omit<CreateRunInput, 'forwarding'>): {
    on: { run: RunInfo; regs: number[] };
    off: { run: RunInfo; regs: number[] };
    interpreter: { ok: boolean; regs: number[] };
    regsMatch: boolean;
  } {
    const on = this.createRun({ ...input, forwarding: true });
    const off = this.createRun({ ...input, forwarding: false });
    this.runSteps(on.id, DEFAULT_CONFIG.maxCycles);
    this.runSteps(off.id, DEFAULT_CONFIG.maxCycles);
    const program = this.getProgram(on.id);
    const r = this.row(on.id);
    const initRegs = JSON.parse(r.init_regs as string) as number[];
    const memory = JSON.parse(r.memory as string) as Record<number, number>;
    const config = JSON.parse(r.config as string) as RunConfig;
    const interp = interpret(program, initRegs, memory, config);
    const onRegs = this.getRegisters(on.id);
    const offRegs = this.getRegisters(off.id);
    const same = (a: number[], b: number[]) => a.every((v, i) => v === b[i]);
    return {
      on: { run: this.getRun(on.id), regs: onRegs },
      off: { run: this.getRun(off.id), regs: offRegs },
      interpreter: { ok: interp.ok, regs: interp.regs },
      regsMatch:
        interp.ok &&
        this.getRun(on.id).status === 'done' &&
        this.getRun(off.id).status === 'done' &&
        same(onRegs, interp.regs) &&
        same(offRegs, interp.regs),
    };
  }
}
