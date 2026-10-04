import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CycleRecord, PipeState, step } from './simulator';
import { Instr, Limits, ProgramSpec, RunStatus, SimError, DEFAULT_LIMITS } from './types';
import { buildInitRegs, buildMemory, validateProgram } from './validate';

export interface RunRow {
  id: number;
  program_id: number;
  forwarding: number;
  status: RunStatus;
  cycle: number;
  state: string;
  error: string | null;
}

export class Store {
  private db: DatabaseSync;
  readonly limits: Limits;

  constructor(dbPath: string, limits: Limits = DEFAULT_LIMITS) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.limits = limits;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS programs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        instructions TEXT NOT NULL,
        init_regs TEXT NOT NULL,
        memory TEXT NOT NULL,
        config TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        program_id INTEGER NOT NULL REFERENCES programs(id),
        forwarding INTEGER NOT NULL,
        status TEXT NOT NULL,
        cycle INTEGER NOT NULL,
        max_cycles INTEGER NOT NULL,
        state TEXT NOT NULL,
        error TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS cycles (
        run_id INTEGER NOT NULL REFERENCES runs(id),
        cycle INTEGER NOT NULL,
        record TEXT NOT NULL,
        PRIMARY KEY (run_id, cycle)
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  createProgram(spec: ProgramSpec): number {
    validateProgram(spec, this.limits);
    const stmt = this.db.prepare(
      'INSERT INTO programs (created_at, instructions, init_regs, memory, config) VALUES (?,?,?,?,?)');
    const r = stmt.run(
      new Date().toISOString(),
      JSON.stringify(spec.instructions),
      JSON.stringify(spec.initRegs ?? {}),
      JSON.stringify(spec.memory ?? {}),
      JSON.stringify(this.limits),
    );
    return Number(r.lastInsertRowid);
  }

  getProgram(id: number): { instructions: Instr[]; initRegs: number[]; memory: Map<number, number> } {
    const row = this.db.prepare('SELECT * FROM programs WHERE id = ?').get(id) as
      | { instructions: string; init_regs: string; memory: string }
      | undefined;
    if (!row) throw new SimError('NOT_FOUND', `程序 ${id} 不存在`);
    const spec: ProgramSpec = {
      instructions: JSON.parse(row.instructions),
      initRegs: JSON.parse(row.init_regs),
      memory: JSON.parse(row.memory),
    };
    return {
      instructions: spec.instructions,
      initRegs: buildInitRegs(spec, this.limits),
      memory: buildMemory(spec),
    };
  }

  /** 创建一次运行；forwarding 模式创建后不可更改。 */
  createRun(programId: number, forwarding: boolean, maxCycles?: number): number {
    const prog = this.getProgram(programId); // 确认存在
    const budget = maxCycles ?? this.limits.maxCycles;
    if (!Number.isInteger(budget) || budget <= 0 || budget > this.limits.maxCycles) {
      throw new SimError('INVALID_BUDGET', `周期预算必须是 1..${this.limits.maxCycles} 的整数`);
    }
    // 初始状态即完成首次取指：周期 0 的记录中首条指令位于 IF
    const state = JSON.stringify({
      pc: prog.instructions.length > 0 ? 1 : 0,
      IF: prog.instructions.length > 0 ? { id: 0 } : null,
      ID: null, EX: null, MEM: null, WB: null, regs: prog.initRegs,
    } satisfies PipeState);
    const initialStatus: RunStatus = prog.instructions.length === 0 ? 'completed' : 'running';
    const r = this.db.prepare(
      'INSERT INTO runs (program_id, forwarding, status, cycle, max_cycles, state, error, created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(programId, forwarding ? 1 : 0, initialStatus, 0, budget, state, null, new Date().toISOString());
    return Number(r.lastInsertRowid);
  }

  getRun(runId: number): RunRow & { max_cycles: number } {
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(runId) as
      (RunRow & { max_cycles: number }) | undefined;
    if (!row) throw new SimError('NOT_FOUND', `运行 ${runId} 不存在`);
    return row;
  }

  /** 单周期推进，原子提交：周期记录与运行状态同事务写入。 */
  stepRun(runId: number): CycleRecord {
    const run = this.getRun(runId);
    if (run.status === 'completed') throw new SimError('RUN_COMPLETED', `运行 ${runId} 已完成`);
    if (run.status === 'failed') throw new SimError('RUN_FAILED', `运行 ${runId} 已失败: ${run.error}`);
    if (run.status === 'budget_exhausted') {
      throw new SimError('BUDGET_EXHAUSTED', `运行 ${runId} 周期预算已耗尽且未排空`);
    }
    const prog = this.getProgram(run.program_id);
    const state = JSON.parse(run.state) as PipeState;
    const forwarding = run.forwarding === 1;

    let next: PipeState;
    let record: CycleRecord;
    let status: RunStatus = 'running';
    let errorText: string | null = null;
    try {
      const r = step(prog.instructions, prog.memory, state, forwarding, run.cycle, this.limits);
      next = r.next;
      record = r.record;
      const drained = next.pc >= prog.instructions.length &&
        !next.IF && !next.ID && !next.EX && !next.MEM && !next.WB;
      if (drained) status = 'completed';
      else if (run.cycle + 1 >= run.max_cycles) status = 'budget_exhausted';
    } catch (e) {
      if (!(e instanceof SimError)) throw e;
      // 运行时失败：记录失败周期并标记 failed，绝不悄悄成功
      next = state;
      record = {
        cycle: run.cycle,
        stages: {
          IF: { instr: state.IF ? state.IF.id : 'empty' },
          ID: { instr: state.ID ? state.ID.id : 'empty' },
          EX: { instr: state.EX ? state.EX.id : 'empty' },
          MEM: { instr: state.MEM ? state.MEM.id : 'empty' },
          WB: { instr: state.WB ? state.WB.id : 'empty' },
        },
        stall: null,
        writeback: null,
        error: { code: e.code, message: e.message, instrId: e.instrId },
      };
      status = 'failed';
      errorText = `${e.code}: ${e.message}`;
    }

    this.db.exec('BEGIN');
    try {
      this.db.prepare('INSERT INTO cycles (run_id, cycle, record) VALUES (?,?,?)')
        .run(runId, run.cycle, JSON.stringify(record));
      this.db.prepare('UPDATE runs SET status = ?, cycle = ?, state = ?, error = ? WHERE id = ?')
        .run(status, run.cycle + 1, JSON.stringify(next), errorText, runId);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return record;
  }

  /** 有限步运行：最多 n 周期，或直到完成/失败/预算耗尽。 */
  runCycles(runId: number, n: number): { cycles: number; status: RunStatus } {
    if (!Number.isInteger(n) || n <= 0) {
      throw new SimError('INVALID_ARGUMENT', '运行周期数必须是正整数');
    }
    let done = 0;
    for (let i = 0; i < n; i++) {
      const run = this.getRun(runId);
      if (run.status !== 'running') break;
      this.stepRun(runId);
      done++;
    }
    return { cycles: done, status: this.getRun(runId).status };
  }

  getCycles(runId: number, from = 0, to?: number): CycleRecord[] {
    this.getRun(runId);
    const limit = to === undefined ? this.limits.maxReportCycles : Math.min(to - from + 1, this.limits.maxReportCycles);
    const rows = this.db.prepare(
      'SELECT record FROM cycles WHERE run_id = ? AND cycle >= ? ORDER BY cycle LIMIT ?')
      .all(runId, from, limit) as { record: string }[];
    return rows.map((r) => JSON.parse(r.record) as CycleRecord);
  }

  getRegisters(runId: number): number[] {
    const run = this.getRun(runId);
    return (JSON.parse(run.state) as PipeState).regs;
  }

  listRuns(programId?: number): unknown[] {
    return programId === undefined
      ? this.db.prepare('SELECT id, program_id, forwarding, status, cycle, max_cycles, error FROM runs ORDER BY id').all()
      : this.db.prepare('SELECT id, program_id, forwarding, status, cycle, max_cycles, error FROM runs WHERE program_id = ? ORDER BY id').all(programId);
  }
}
