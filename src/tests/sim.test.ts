import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { compareModes } from '../compare';
import { DEMOS } from '../demo';
import { interpret } from '../interpreter';
import { Store } from '../store';
import { DEFAULT_LIMITS, ProgramSpec, SimError } from '../types';

function tmpDb(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pipe-')), 'test.db');
}

function makeStore(): { store: Store; db: string } {
  const db = tmpDb();
  return { store: new Store(db), db };
}

function runToEnd(store: Store, runId: number): void {
  store.runCycles(runId, store.getRun(runId).max_cycles);
}

test('校验：非法操作码/寄存器/立即数/初始值被拒绝', () => {
  const { store } = makeStore();
  const bad: [ProgramSpec, string][] = [
    [{ instructions: [{ op: 'SUB' as never }] }, 'INVALID_OPCODE'],
    [{ instructions: [{ op: 'ADD', rd: 9, rs: 0, rt: 0 }] }, 'INVALID_REGISTER'],
    [{ instructions: [{ op: 'ADDI', rd: 1, rs: 0, imm: 1.5 }] }, 'INVALID_IMMEDIATE'],
    [{ instructions: [{ op: 'NOP' }], initRegs: { '1': 2147483648 } }, 'INVALID_INIT_VALUE'],
    [{ instructions: [{ op: 'NOP' }], memory: { '99999': 1 } }, 'INVALID_MEMORY'],
  ];
  for (const [spec, code] of bad) {
    assert.throws(() => store.createProgram(spec), (e: unknown) => e instanceof SimError && e.code === code);
  }
  store.close();
});

test('空程序立即完成，寄存器不变', () => {
  const { store } = makeStore();
  const pid = store.createProgram({ instructions: [] });
  const rid = store.createRun(pid, true);
  assert.equal(store.getRun(rid).status, 'completed');
  assert.deepEqual(store.getRegisters(rid), new Array(8).fill(0));
  store.close();
});

test('单指令程序：5 周期排空，写回恰好一次', () => {
  const { store } = makeStore();
  const pid = store.createProgram({ instructions: [{ op: 'ADDI', rd: 1, rs: 0, imm: 7 }] });
  const rid = store.createRun(pid, true);
  runToEnd(store, rid);
  assert.equal(store.getRun(rid).status, 'completed');
  assert.equal(store.getRun(rid).cycle, 5);
  const cycles = store.getCycles(rid);
  const wbs = cycles.filter((c) => c.writeback);
  assert.equal(wbs.length, 1);
  assert.deepEqual(wbs[0].writeback, { instrId: 0, reg: 1, value: 7 });
  assert.equal(store.getRegisters(rid)[1], 7);
  store.close();
});

test('x0 恒为零：写 x0 被忽略，读 x0 不制造停顿', () => {
  const { store } = makeStore();
  const pid = store.createProgram({
    instructions: [
      { op: 'ADDI', rd: 0, rs: 0, imm: 99 }, // 写 x0，无效
      { op: 'ADD', rd: 1, rs: 0, rt: 0 },    // 依赖 x0，不是真依赖
    ],
  });
  const rid = store.createRun(pid, false); // 转发关闭也不应停顿
  runToEnd(store, rid);
  const cycles = store.getCycles(rid);
  assert.equal(cycles.filter((c) => c.stall).length, 0);
  assert.equal(cycles.filter((c) => c.writeback).length, 1); // 只有第二条写回
  const regs = store.getRegisters(rid);
  assert.equal(regs[0], 0);
  assert.equal(regs[1], 0);
  store.close();
});

test('手算核对：LOAD 紧邻使用，转发开=1 次停顿(周期2)，关=2 次停顿(周期2,3)', () => {
  const { store } = makeStore();
  const pid = store.createProgram(DEMOS.load_use.spec);
  const on = store.createRun(pid, true);
  runToEnd(store, on);
  const onCycles = store.getCycles(on);
  const onStalls = onCycles.filter((c) => c.stall).map((c) => c.cycle);
  assert.deepEqual(onStalls, [2]);
  assert.equal(onCycles[2].stages.EX.instr, 'bubble');
  // 周期4：消费者在 EX，LOAD 在 WB，从 MEM/WB 转发
  assert.equal(onCycles[4].operands?.a?.src, 'FWD_WB');
  assert.equal(onCycles[4].operands?.a?.value, 42);

  const off = store.createRun(pid, false);
  runToEnd(store, off);
  const offStalls = store.getCycles(off).filter((c) => c.stall).map((c) => c.cycle);
  assert.deepEqual(offStalls, [2, 3]);
  assert.equal(store.getRegisters(on)[2], 84);
  assert.equal(store.getRegisters(off)[2], 84);
  store.close();
});

test('手算核对：连续算术依赖，转发开无停顿且从 EX/MEM 转发', () => {
  const { store } = makeStore();
  const pid = store.createProgram(DEMOS.arith_chain.spec);
  const rid = store.createRun(pid, true);
  runToEnd(store, rid);
  const cycles = store.getCycles(rid);
  assert.equal(cycles.filter((c) => c.stall).length, 0);
  // 周期3：指令1(EX) 依赖 指令0(MEM) → FWD_MEM
  assert.equal(cycles[3].operands?.a?.src, 'FWD_MEM');
  assert.equal(cycles[3].operands?.a?.value, 5);
  const regs = store.getRegisters(rid);
  assert.deepEqual([regs[1], regs[2], regs[3]], [5, 10, 15]);
  store.close();
});

test('两个前序写同一寄存器：最近写入者优先', () => {
  const { store } = makeStore();
  const pid = store.createProgram(DEMOS.two_writers.spec);
  const cmp = compareModes(store, pid);
  assert.ok(cmp.regsMatch);
  assert.equal(cmp.forwardingOn.regs[1], 11);
  assert.equal(cmp.forwardingOn.regs[2], 22);
  store.close();
});

test('全部演示：两种模式最终寄存器与顺序解释器一致', () => {
  const { store } = makeStore();
  for (const demo of Object.values(DEMOS)) {
    const pid = store.createProgram(demo.spec);
    const cmp = compareModes(store, pid);
    assert.ok(cmp.regsMatch, demo.title);
    assert.ok(cmp.forwardingOff.cycles >= cmp.forwardingOn.cycles);
  }
  store.close();
});

test('跨重启推进：结果与不中断运行一致', () => {
  const db = tmpDb();
  const spec = DEMOS.gap_fill.spec;
  // 不中断
  let s1 = new Store(db);
  const pid = s1.createProgram(spec);
  const runA = s1.createRun(pid, true);
  s1.runCycles(runA, 100);
  const cyclesA = s1.getCycles(runA);
  const regsA = s1.getRegisters(runA);
  s1.close();
  // 中断：推进 3 周期后关闭重开
  s1 = new Store(db);
  const runB = s1.createRun(pid, true);
  s1.runCycles(runB, 3);
  s1.close();
  s1 = new Store(db);
  s1.runCycles(runB, 100);
  assert.deepEqual(s1.getCycles(runB), cyclesA);
  assert.deepEqual(s1.getRegisters(runB), regsA);
  s1.close();
});

test('预算耗尽：标记 budget_exhausted 且拒绝继续推进', () => {
  const { store } = makeStore();
  const pid = store.createProgram(DEMOS.arith_chain.spec);
  const rid = store.createRun(pid, true, 3);
  store.runCycles(rid, 100);
  assert.equal(store.getRun(rid).status, 'budget_exhausted');
  assert.throws(() => store.stepRun(rid), (e: unknown) => e instanceof SimError && e.code === 'BUDGET_EXHAUSTED');
  store.close();
});

test('每条有写回的指令恰好提交一次', () => {
  const { store } = makeStore();
  const pid = store.createProgram(DEMOS.gap_fill.spec);
  for (const fwd of [true, false]) {
    const rid = store.createRun(pid, fwd);
    runToEnd(store, rid);
    const wbIds = store.getCycles(rid).filter((c) => c.writeback).map((c) => c.writeback!.instrId).sort();
    assert.deepEqual(wbIds, [0, 1, 2, 3]); // 四条指令都写寄存器
  }
  store.close();
});

test('运行时读取未定义地址：明确失败，带指令编号', () => {
  const { store } = makeStore();
  const pid = store.createProgram({
    instructions: [{ op: 'LOAD', rd: 1, base: 0, imm: 5 }],
    memory: { '0': 1 },
  });
  const rid = store.createRun(pid, true);
  runToEnd(store, rid);
  const run = store.getRun(rid);
  assert.equal(run.status, 'failed');
  assert.match(run.error!, /UNDEFINED_MEMORY/);
  assert.match(run.error!, /指令 0/);
  const last = store.getCycles(rid).at(-1)!;
  assert.equal(last.error?.code, 'UNDEFINED_MEMORY');
  assert.equal(last.error?.instrId, 0);
  store.close();
});

test('整数溢出：明确失败而不是悄悄回绕', () => {
  const { store } = makeStore();
  const pid = store.createProgram({
    instructions: [
      { op: 'ADDI', rd: 1, rs: 0, imm: 2147483647 },
      { op: 'ADDI', rd: 1, rs: 1, imm: 1 },
    ],
  });
  const rid = store.createRun(pid, true);
  runToEnd(store, rid);
  assert.equal(store.getRun(rid).status, 'failed');
  assert.match(store.getRun(rid).error!, /ARITHMETIC_OVERFLOW/);
  store.close();
});

test('顺序解释器与流水线在含 NOP 的程序上一致', () => {
  const { store } = makeStore();
  const spec: ProgramSpec = {
    instructions: [
      { op: 'ADDI', rd: 1, rs: 0, imm: 3 },
      { op: 'NOP' },
      { op: 'ADD', rd: 2, rs: 1, rt: 1 },
      { op: 'NOP' },
      { op: 'LOAD', rd: 3, base: 0, imm: 1 },
    ],
    memory: { '1': -9 },
  };
  const pid = store.createProgram(spec);
  const cmp = compareModes(store, pid);
  assert.ok(cmp.regsMatch);
  const prog = store.getProgram(pid);
  assert.deepEqual(cmp.forwardingOn.regs, interpret(prog.instructions, prog.initRegs, prog.memory, DEFAULT_LIMITS));
  store.close();
});
