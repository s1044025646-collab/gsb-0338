import { ApiError, Instr, INT_MAX, INT_MIN, NUM_REGS, Op, RunConfig } from './types.js';

const OPS: Op[] = ['ADD', 'ADDI', 'LOAD', 'NOP'];

function isInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v);
}

function checkReg(v: unknown, field: string): number {
  if (!isInt(v) || v < 0 || v >= NUM_REGS) {
    throw new ApiError('INVALID_REGISTER', `字段 ${field} 必须是 0..${NUM_REGS - 1} 的整数，收到 ${JSON.stringify(v)}`);
  }
  return v;
}

function checkImm(v: unknown, field: string): number {
  if (!isInt(v)) {
    throw new ApiError('INVALID_IMMEDIATE', `字段 ${field} 必须是整数，收到 ${JSON.stringify(v)}`);
  }
  if (v < INT_MIN || v > INT_MAX) {
    throw new ApiError('OUT_OF_RANGE', `字段 ${field} 超出 32 位有符号整数范围: ${v}`);
  }
  return v;
}

export function validateProgram(raw: unknown, cfg: RunConfig): Instr[] {
  if (!Array.isArray(raw)) {
    throw new ApiError('INVALID_PROGRAM', 'program 必须是指令数组');
  }
  if (raw.length > cfg.maxProgram) {
    throw new ApiError('LIMIT_EXCEEDED', `程序长度 ${raw.length} 超过上限 ${cfg.maxProgram}`);
  }
  return raw.map((item, id) => {
    if (typeof item !== 'object' || item === null) {
      throw new ApiError('INVALID_PROGRAM', `指令 #${id} 必须是对象`);
    }
    const o = item as Record<string, unknown>;
    const op = o.op;
    if (typeof op !== 'string' || !OPS.includes(op.toUpperCase() as Op)) {
      throw new ApiError('INVALID_OPCODE', `指令 #${id} 非法操作码: ${JSON.stringify(op)}，仅支持 ADD/ADDI/LOAD/NOP`);
    }
    const instr: Instr = { id, op: op.toUpperCase() as Op };
    switch (instr.op) {
      case 'ADD':
        instr.rd = checkReg(o.rd, `#${id}.rd`);
        instr.rs = checkReg(o.rs, `#${id}.rs`);
        instr.rt = checkReg(o.rt, `#${id}.rt`);
        break;
      case 'ADDI':
        instr.rd = checkReg(o.rd, `#${id}.rd`);
        instr.rs = checkReg(o.rs, `#${id}.rs`);
        instr.imm = checkImm(o.imm, `#${id}.imm`);
        break;
      case 'LOAD':
        instr.rd = checkReg(o.rd, `#${id}.rd`);
        instr.rs = checkReg(o.rs, `#${id}.rs`);
        instr.imm = checkImm(o.imm, `#${id}.imm`);
        break;
      case 'NOP':
        break;
    }
    return instr;
  });
}

export function validateRegisters(raw: unknown): number[] {
  const regs = new Array<number>(NUM_REGS).fill(0);
  if (raw === undefined || raw === null) return regs;
  if (Array.isArray(raw)) {
    if (raw.length !== NUM_REGS) {
      throw new ApiError('INVALID_REGISTER', `registers 数组长度必须为 ${NUM_REGS}`);
    }
    raw.forEach((v, i) => {
      regs[i] = checkImm(v, `registers[${i}]`);
    });
  } else if (typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      const m = /^x?(\d+)$/.exec(k);
      if (!m) throw new ApiError('INVALID_REGISTER', `非法寄存器名: ${k}`);
      const idx = Number(m[1]);
      if (idx < 0 || idx >= NUM_REGS) throw new ApiError('INVALID_REGISTER', `寄存器编号越界: ${k}`);
      regs[idx] = checkImm(v, `registers.${k}`);
    }
  } else {
    throw new ApiError('INVALID_REGISTER', 'registers 必须是数组或对象');
  }
  regs[0] = 0;
  return regs;
}

export function validateMemory(raw: unknown, cfg: RunConfig): Record<number, number> {
  const mem: Record<number, number> = {};
  if (raw === undefined || raw === null) return mem;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ApiError('INVALID_MEMORY', 'memory 必须是 { 地址: 整数值 } 的对象');
  }
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^\d+$/.test(k)) {
      throw new ApiError('INVALID_MEMORY', `非法内存地址: ${JSON.stringify(k)}`);
    }
    const addr = Number(k);
    if (addr < 0 || addr > cfg.addrMax) {
      throw new ApiError('OUT_OF_RANGE', `内存地址 ${addr} 超出允许范围 0..${cfg.addrMax}`);
    }
    mem[addr] = checkImm(v, `memory[${k}]`);
  }
  return mem;
}
