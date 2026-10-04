import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RunStore } from '../src/store.js';
import { interpret } from '../src/interpreter.js';
import { validateProgram } from '../src/validate.js';
import { ApiError, DEFAULT_CONFIG } from '../src/types.js';

function tmpStore(): { store: RunStore; dir: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'pipesim-'));
  return { store: new RunStore(dir), dir };
}

const ARITH_CHAIN = [
  { op: 'ADDI', rd: 1, rs: 0, imm: 5 },
  { op: 'ADDI', rd: 2, rs: 1, imm: 3 },
  { op: 'ADD', rd: 3, rs: 1, rt: 2 },
];

function runToEnd(store: RunStore, id: string): void {
  store.runSteps(id, 1000);
}

test('空程序直接完成，0 周期', () => {
  const { store } = tmpStore();
  const info = store.createRun({ program: [], forwarding: true });
  assert.equal(info.status, 'done');
  assert.equal(info.cycle, 0);
  store.close();
});

test('单指令 5 周期完成，恰好写回一次', () => {
  const { store } = tmpStore();
  const info = store.createRun({ program: [{ op: 'ADDI', rd: 1, rs: 0, imm: 42 }], forwarding: true });
  runToEnd(store, info.id);
  const done = store.getRun(info.id);
  assert.equal(done.status, 'done');
  assert.equal(done.cycle, 5);
  assert.deepEqual(store.getRegisters(info.id)[1], 42);
  const wbs = store.getCycles(info.id).filter((c) => c.writeback);
  assert.equal(wbs.length, 1);
  assert.equal(wbs[0].writeback!.instrId, 0);
  store.close();
});

test('x0 恒零：写 x0 被丢弃，读 x0 不产生依赖与停顿', () => {
  const { store } = tmpStore();
  const info = store.createRun({
    program: [
      { op: 'ADDI', rd: 0, rs: 0, imm: 99 },
      { op: 'ADDI', rd: 1, rs: 0, imm: 1 },
    ],
    forwarding: false,
  });
  runToEnd(store, info.id);
  const regs = store.getRegisters(info.id);
  assert.equal(regs[0], 0);
  assert.equal(regs[1], 1);
  const cycles = store.getCycles(info.id);
  assert.equal(cycles.filter((c) => c.stall).length, 0);
  const wb0 = cycles.map((c) => c.writeback).find((w) => w && w.instrId === 0);
  assert.equal(wb0!.discarded, true);
  assert.equal(store.getRun(info.id).cycle, 6);
  store.close();
});

test('连续算术依赖：转发开 7 周期 0 停顿，关 11 周期 4 停顿，结果一致', () => {
  const { store } = tmpStore();
  const on = store.createRun({ program: ARITH_CHAIN, forwarding: true });
  const off = store.createRun({ program: ARITH_CHAIN, forwarding: false });
  runToEnd(store, on.id);
  runToEnd(store, off.id);
  assert.equal(store.getRun(on.id).cycle, 7);
  assert.equal(store.getCycles(on.id).filter((c) => c.stall).length, 0);
  assert.equal(store.getRun(off.id).cycle, 11);
  assert.equal(store.getCycles(off.id).filter((c) => c.stall).length, 4);
  const expected = [0, 5, 8, 13, 0, 0, 0, 0];
  assert.deepEqual(store.getRegisters(on.id), expected);
  assert.deepEqual(store.getRegisters(off.id), expected);
  const program = validateProgram(ARITH_CHAIN, DEFAULT_CONFIG);
  assert.deepEqual(interpret(program, new Array(8).fill(0), {}, DEFAULT_CONFIG).regs, expected);
  store.close();
});

test('两个前序指令写同一寄存器：转发取最近写入者', () => {
  const { store } = tmpStore();
  const program = [
    { op: 'ADDI', rd: 1, rs: 0, imm: 5 },
    { op: 'ADDI', rd: 1, rs: 1, imm: 7 },
    { op: 'ADD', rd: 2, rs: 1, rt: 1 },
  ];
  const on = store.createRun({ program, forwarding: true });
  runToEnd(store, on.id);
  assert.equal(store.getRegisters(on.id)[2], 24);
  const cycles = store.getCycles(on.id);
  const exCycle = cycles.find((c) => c.stages.EX?.id === 2)!;
  assert.ok(exCycle.operands.every((o) => o.source === 'forward:EX/MEM'));
  store.close();
});

test('LOAD 后立即使用：转发开恰好 1 次 load-use 停顿，关 2 次停顿', () => {
  const { store } = tmpStore();
  const program = [
    { op: 'LOAD', rd: 1, rs: 0, imm: 4 },
    { op: 'ADDI', rd: 2, rs: 1, imm: 1 },
  ];
  const memory = { 4: 100 };
  const on = store.createRun({ program, memory, forwarding: true });
  const off = store.createRun({ program, memory, forwarding: false });
  runToEnd(store, on.id);
  runToEnd(store, off.id);
  const onStalls = store.getCycles(on.id).filter((c) => c.stall);
  assert.equal(onStalls.length, 1);
  assert.equal(onStalls[0].stall!.reason, 'load-use');
  assert.equal(store.getRun(on.id).cycle, 7);
  assert.equal(store.getCycles(off.id).filter((c) => c.stall).length, 2);
  assert.equal(store.getRegisters(on.id)[2], 101);
  assert.deepEqual(store.getRegisters(on.id), store.getRegisters(off.id));
  store.close();
});

test('无关指令填补等待槽位：转发开无停顿', () => {
  const { store } = tmpStore();
  const program = [
    { op: 'LOAD', rd: 1, rs: 0, imm: 4 },
    { op: 'ADDI', rd: 3, rs: 0, imm: 9 },
    { op: 'ADDI', rd: 2, rs: 1, imm: 1 },
    { op: 'NOP' },
  ];
  const on = store.createRun({ program, memory: { 4: 100 }, forwarding: true });
  runToEnd(store, on.id);
  assert.equal(store.getCycles(on.id).filter((c) => c.stall).length, 0);
  assert.equal(store.getRun(on.id).cycle, 8);
  assert.deepEqual(store.getRegisters(on.id).slice(0, 4), [0, 100, 101, 9]);
  store.close();
});

test('跨重启推进：中断后继续与不中断结果一致', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pipesim-'));
  const s1 = new RunStore(dir);
  const ref = s1.createRun({ program: ARITH_CHAIN, forwarding: true });
  runToEnd(s1, ref.id);
  const refCycles = s1.getCycles(ref.id);
  const refRegs = s1.getRegisters(ref.id);
  const paused = s1.createRun({ program: ARITH_CHAIN, forwarding: true });
  s1.runSteps(paused.id, 3);
  s1.close();
  const s2 = new RunStore(dir);
  runToEnd(s2, paused.id);
  assert.deepEqual(s2.getCycles(paused.id), refCycles);
  assert.deepEqual(s2.getRegisters(paused.id), refRegs);
  assert.equal(s2.getRun(paused.id).status, 'done');
  s2.close();
  rmSync(dir, { recursive: true, force: true });
});

test('预算耗尽标记未完成，且不能继续推进', () => {
  const { store } = tmpStore();
  const info = store.createRun({ program: ARITH_CHAIN, forwarding: true, maxCycles: 3 });
  store.runSteps(info.id, 100);
  assert.equal(store.getRun(info.id).status, 'budget_exhausted');
  assert.throws(() => store.step(info.id), (e: ApiError) => e.code === 'RUN_NOT_RUNNING');
  store.close();
});

test('每条有写回的指令恰好提交一次', () => {
  const { store } = tmpStore();
  const program = [
    { op: 'LOAD', rd: 1, rs: 0, imm: 0 },
    { op: 'ADDI', rd: 2, rs: 1, imm: 1 },
    { op: 'ADD', rd: 3, rs: 2, rt: 1 },
    { op: 'NOP' },
    { op: 'ADDI', rd: 0, rs: 0, imm: 5 },
  ];
  for (const forwarding of [true, false]) {
    const info = store.createRun({ program, memory: { 0: 7 }, forwarding });
    runToEnd(store, info.id);
    const wbs = store.getCycles(info.id).flatMap((c) => (c.writeback ? [c.writeback] : []));
    const real = wbs.filter((w) => !w.discarded);
    assert.deepEqual(real.map((w) => w.instrId).sort(), [0, 1, 2], `forwarding=${forwarding}`);
    assert.equal(new Set(real.map((w) => w.instrId)).size, 3);
  }
  store.close();
});

test('运行时溢出：明确失败状态与当前指令', () => {
  const { store } = tmpStore();
  const info = store.createRun({
    program: [
      { op: 'ADDI', rd: 1, rs: 0, imm: 2147483647 },
      { op: 'ADDI', rd: 2, rs: 1, imm: 1 },
    ],
    forwarding: true,
  });
  store.runSteps(info.id, 100);
  const run = store.getRun(info.id);
  assert.equal(run.status, 'failed');
  const err = run.error as { code: string; instrId: number };
  assert.equal(err.code, 'OVERFLOW');
  assert.equal(err.instrId, 1);
  store.close();
});

test('读取未定义内存地址：失败而非静默返回零', () => {
  const { store } = tmpStore();
  const info = store.createRun({
    program: [{ op: 'LOAD', rd: 1, rs: 0, imm: 8 }],
    forwarding: true,
  });
  store.runSteps(info.id, 100);
  const run = store.getRun(info.id);
  assert.equal(run.status, 'failed');
  assert.equal((run.error as { code: string }).code, 'UNDEFINED_ADDRESS');
  store.close();
});

test('启动前校验：非法操作码/寄存器/立即数/越界内存', () => {
  const { store } = tmpStore();
  assert.throws(() => store.createRun({ program: [{ op: 'SUB' }] }), (e: ApiError) => e.code === 'INVALID_OPCODE');
  assert.throws(
    () => store.createRun({ program: [{ op: 'ADDI', rd: 9, rs: 0, imm: 1 }] }),
    (e: ApiError) => e.code === 'INVALID_REGISTER',
  );
  assert.throws(
    () => store.createRun({ program: [{ op: 'ADDI', rd: 1, rs: 0, imm: 1.5 }] }),
    (e: ApiError) => e.code === 'INVALID_IMMEDIATE',
  );
  assert.throws(
    () => store.createRun({ program: [], memory: { 99999: 1 } }),
    (e: ApiError) => e.code === 'OUT_OF_RANGE',
  );
  assert.throws(
    () => store.createRun({ program: [{ op: 'ADDI', rd: 1, rs: 0, imm: 2147483648 }] }),
    (e: ApiError) => e.code === 'OUT_OF_RANGE',
  );
  store.close();
});

test('compare 创建两个独立运行且与顺序解释器一致', () => {
  const { store } = tmpStore();
  const result = store.compare({
    program: [
      { op: 'LOAD', rd: 1, rs: 0, imm: 4 },
      { op: 'ADDI', rd: 2, rs: 1, imm: 3 },
      { op: 'ADD', rd: 3, rs: 2, rt: 1 },
    ],
    memory: { 4: 10 },
  } as never);
  assert.ok(result.regsMatch);
  assert.notEqual(result.on.run.id, result.off.run.id);
  assert.ok(result.on.run.cycle < result.off.run.cycle);
  assert.deepEqual(result.on.regs.slice(0, 4), [0, 10, 13, 23]);
  store.close();
});

test('NOP 与气泡在记录中可区分', () => {
  const { store } = tmpStore();
  const info = store.createRun({ program: [{ op: 'NOP' }], forwarding: true });
  runToEnd(store, info.id);
  const cycles = store.getCycles(info.id);
  const withNop = cycles.filter((c) => Object.values(c.stages).some((s) => s?.op === 'NOP'));
  const withBubble = cycles.filter((c) => Object.values(c.stages).some((s) => s === null));
  assert.ok(withNop.length > 0);
  assert.ok(withBubble.length > 0);
  store.close();
});

test('随机有效程序：两种模式最终寄存器均与顺序解释器一致', () => {
  const { store } = tmpStore();
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);
  for (let t = 0; t < 20; t++) {
    const len = 1 + (rnd() % 8);
    const program: unknown[] = [];
    for (let i = 0; i < len; i++) {
      const kind = rnd() % 4;
      if (kind === 0) program.push({ op: 'NOP' });
      else if (kind === 1) program.push({ op: 'ADDI', rd: rnd() % 8, rs: rnd() % 8, imm: (rnd() % 200) - 100 });
      else if (kind === 2) program.push({ op: 'ADD', rd: rnd() % 8, rs: rnd() % 8, rt: rnd() % 8 });
      else program.push({ op: 'LOAD', rd: rnd() % 8, rs: 0, imm: rnd() % 4 });
    }
    const memory = { 0: rnd() % 50, 1: rnd() % 50, 2: rnd() % 50, 3: rnd() % 50 };
    const result = store.compare({ program, memory } as never);
    assert.ok(result.regsMatch, `随机程序 #${t} 不一致: ${JSON.stringify(program)}`);
  }
  store.close();
});
