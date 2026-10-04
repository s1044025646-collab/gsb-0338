import { Instr, Limits, SimError } from './types';

/**
 * 五级流水线周期级模拟。
 *
 * 时序约定：
 * - 每周期由“本周期开始状态”统一计算下一状态，指令不会在一周期内穿过多个阶段。
 * - 写回（WB）在周期前半完成，译码（ID）在周期后半读寄存器：
 *   同周期 WB 写入的值对同周期 ID 可见（写先读后）。
 * - 转发开启时，EX 级可从当前 MEM 级（仅 ALU 结果）与 WB 级（任意结果）取数，
 *   程序顺序上更近的写入者优先（MEM 优先于 WB）。
 * - LOAD 的值在 MEM 级末尾才产生，紧邻的使用者必须停顿一拍。
 * - x0 恒为 0：不作为依赖源，也不作为转发/冒险目标。
 */

export type StageName = 'IF' | 'ID' | 'EX' | 'MEM' | 'WB';

export interface Slot {
  /** 指令编号（程序下标） */
  id: number;
  /** ID 末锁存的操作数（EX 使用，转发可覆盖） */
  a?: number;
  b?: number;
  /** EX 计算结果 / LOAD 地址 */
  alu?: number;
  addr?: number;
  /** MEM 产出的最终结果（LOAD 读出值或 ALU 结果） */
  result?: number;
}

export interface PipeState {
  pc: number;
  IF: Slot | null;
  ID: Slot | null;
  EX: Slot | null;
  MEM: Slot | null;
  WB: Slot | null;
  regs: number[];
}

export type OperandSrc = 'REG' | 'FWD_MEM' | 'FWD_WB';

export interface StageRecord {
  /** 指令编号；bubble=停顿气泡；empty=该级为空 */
  instr: number | 'bubble' | 'empty';
  op?: string;
  note?: string;
}

export interface CycleRecord {
  cycle: number;
  stages: Record<StageName, StageRecord>;
  operands?: { a?: { src: OperandSrc; reg: number; value: number }; b?: { src: OperandSrc; reg: number; value: number } };
  stall: null | { reason: string; reg: number };
  writeback: null | { instrId: number; reg: number; value: number };
  error: null | { code: string; message: string; instrId?: number };
}

function writesReg(ins: Instr, r: number): boolean {
  return ins.op !== 'NOP' && ins.rd === r && r !== 0;
}

function hasWriteback(ins: Instr): boolean {
  return ins.op !== 'NOP' && ins.rd !== undefined && ins.rd !== 0;
}

function readRegs(ins: Instr): number[] {
  switch (ins.op) {
    case 'ADD': return [ins.rs!, ins.rt!];
    case 'ADDI': return [ins.rs!];
    case 'LOAD': return [ins.base!];
    default: return [];
  }
}

export function initialState(regs: number[]): PipeState {
  return { pc: 0, IF: null, ID: null, EX: null, MEM: null, WB: null, regs: regs.slice() };
}

export function isDrained(s: PipeState, progLen: number): boolean {
  return s.pc >= progLen && !s.IF && !s.ID && !s.EX && !s.MEM && !s.WB;
}

export interface StepResult {
  next: PipeState;
  record: CycleRecord;
}

/** 由本周期开始状态计算下一状态；失败时抛 SimError（调用方据此标记 failed）。 */
export function step(
  prog: Instr[],
  memory: Map<number, number>,
  s: PipeState,
  forwarding: boolean,
  cycle: number,
  limits: Limits,
): StepResult {
  const record: CycleRecord = {
    cycle,
    stages: {
      IF: stageDesc(s.IF, prog),
      ID: stageDesc(s.ID, prog),
      EX: stageDesc(s.EX, prog),
      MEM: stageDesc(s.MEM, prog),
      WB: stageDesc(s.WB, prog),
    },
    stall: null,
    writeback: null,
    error: null,
  };

  // 1) WB：周期前半提交写回
  const regsAfterWb = s.regs.slice();
  if (s.WB) {
    const ins = prog[s.WB.id];
    if (hasWriteback(ins)) {
      regsAfterWb[ins.rd!] = s.WB.result!;
      record.writeback = { instrId: s.WB.id, reg: ins.rd!, value: s.WB.result! };
    }
  }

  // 2) EX：计算当前 EX 级指令的结果（转发取自当前 MEM/WB 级）
  let exOut: Slot | null = null;
  if (s.EX) {
    const ins = prog[s.EX.id];
    const slot: Slot = { id: s.EX.id };
    if (ins.op !== 'NOP') {
      const ops: NonNullable<CycleRecord['operands']> = {};
      const resolve = (reg: number, latched: number): { src: OperandSrc; reg: number; value: number } => {
        if (forwarding && reg !== 0) {
          if (s.MEM && writesReg(prog[s.MEM.id], reg) && prog[s.MEM.id].op !== 'LOAD') {
            return { src: 'FWD_MEM', reg, value: s.MEM.alu! };
          }
          if (s.WB && writesReg(prog[s.WB.id], reg)) {
            return { src: 'FWD_WB', reg, value: s.WB.result! };
          }
        }
        return { src: 'REG', reg, value: latched };
      };
      let aVal = 0;
      let bVal = 0;
      if (ins.op === 'ADD') {
        ops.a = resolve(ins.rs!, s.EX.a!);
        ops.b = resolve(ins.rt!, s.EX.b!);
        aVal = ops.a.value; bVal = ops.b.value;
        slot.alu = checkedAdd(aVal, bVal, limits, s.EX.id, cycle);
      } else if (ins.op === 'ADDI') {
        ops.a = resolve(ins.rs!, s.EX.a!);
        aVal = ops.a.value;
        slot.alu = checkedAdd(aVal, ins.imm!, limits, s.EX.id, cycle);
      } else if (ins.op === 'LOAD') {
        ops.a = resolve(ins.base!, s.EX.a!);
        slot.addr = checkedAdd(ops.a.value, ins.imm!, limits, s.EX.id, cycle);
        if (slot.addr < 0 || slot.addr > limits.memAddrMax) {
          throw new SimError('ADDRESS_OUT_OF_RANGE',
            `指令 ${s.EX.id}（LOAD）地址 ${slot.addr} 越界（0..${limits.memAddrMax}）`, s.EX.id, cycle);
        }
      }
      if (ops.a || ops.b) record.operands = ops;
    }
    exOut = slot;
  }

  // 3) MEM：LOAD 在此读出只读内存；地址未定义即失败，绝不悄悄给 0
  let memOut: Slot | null = null;
  if (s.MEM) {
    const ins = prog[s.MEM.id];
    const slot: Slot = { ...s.MEM };
    if (ins.op === 'LOAD') {
      const v = memory.get(s.MEM.addr!);
      if (v === undefined) {
        throw new SimError('UNDEFINED_MEMORY',
          `指令 ${s.MEM.id}（LOAD）读取未定义地址 ${s.MEM.addr}`, s.MEM.id, cycle);
      }
      slot.result = v;
    } else if (ins.op !== 'NOP') {
      slot.result = s.MEM.alu!;
    }
    memOut = slot;
  }

  // 4) 冒险检测：ID 级指令的源寄存器 对 EX/MEM 级未完成的写入者
  let stall: CycleRecord['stall'] = null;
  if (s.ID) {
    const ins = prog[s.ID.id];
    for (const r of readRegs(ins)) {
      if (r === 0) continue; // x0 不制造假依赖
      if (s.EX && writesReg(prog[s.EX.id], r)) {
        if (!forwarding) {
          stall = { reason: `x${r} 等待 EX 级指令 ${s.EX.id} 写回（转发关闭）`, reg: r };
        } else if (prog[s.EX.id].op === 'LOAD') {
          stall = { reason: `x${r} 等待 LOAD（指令 ${s.EX.id}）数据在 MEM 末才可用`, reg: r };
        }
      } else if (!forwarding && s.MEM && writesReg(prog[s.MEM.id], r)) {
        stall = { reason: `x${r} 等待 MEM 级指令 ${s.MEM.id} 写回（转发关闭）`, reg: r };
      }
      // WB 级：写先读后约定，两种模式都无需停顿
      if (stall) break;
    }
  }
  record.stall = stall;

  // 5) 统一生成下一状态
  const next: PipeState = {
    pc: s.pc,
    IF: s.IF,
    ID: s.ID,
    EX: exOut,
    MEM: memOut,
    WB: null,
    regs: regsAfterWb,
  };
  next.WB = memOut;
  next.MEM = exOut;
  if (stall) {
    // 前端保持，EX 注入气泡；不复制、不丢失指令
    next.EX = null;
    next.ID = s.ID;
    next.IF = s.IF;
    record.stages.EX = { instr: 'bubble', note: stall.reason };
  } else {
    if (s.ID) {
      const ins = prog[s.ID.id];
      const slot: Slot = { id: s.ID.id };
      if (ins.op === 'ADD') { slot.a = regsAfterWb[ins.rs!]; slot.b = regsAfterWb[ins.rt!]; }
      else if (ins.op === 'ADDI') { slot.a = regsAfterWb[ins.rs!]; }
      else if (ins.op === 'LOAD') { slot.a = regsAfterWb[ins.base!]; }
      next.EX = slot;
    } else {
      next.EX = null;
    }
    next.ID = s.IF;
    if (s.pc < prog.length) {
      next.IF = { id: s.pc };
      next.pc = s.pc + 1;
    } else {
      next.IF = null;
    }
  }
  return { next, record };
}

function stageDesc(slot: Slot | null, prog: Instr[]): StageRecord {
  if (!slot) return { instr: 'empty' };
  return { instr: slot.id, op: prog[slot.id].op };
}

function checkedAdd(a: number, b: number, limits: Limits, instrId: number, cycle: number): number {
  const v = a + b;
  if (v < limits.intMin || v > limits.intMax) {
    throw new SimError('ARITHMETIC_OVERFLOW',
      `指令 ${instrId} 整数溢出：${a} + ${b} = ${v} 超出 [${limits.intMin}, ${limits.intMax}]`, instrId, cycle);
  }
  return v;
}
