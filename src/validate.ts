import { Instr, Limits, ProgramSpec, SimError } from './types';

function isInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v);
}

/** 启动前校验：非法操作码、寄存器、非整数立即数、越界初始值一律拒绝。 */
export function validateProgram(spec: ProgramSpec, limits: Limits): Instr[] {
  if (!spec || !Array.isArray(spec.instructions)) {
    throw new SimError('INVALID_PROGRAM', 'instructions 必须是数组');
  }
  if (spec.instructions.length > limits.maxProgramLen) {
    throw new SimError('LIMIT_EXCEEDED', `程序长度超过限制 ${limits.maxProgramLen}`);
  }
  spec.instructions.forEach((ins, i) => {
    if (!ins || typeof ins !== 'object') {
      throw new SimError('INVALID_INSTRUCTION', `指令 ${i} 不是对象`, i);
    }
    const checkReg = (v: unknown, field: string) => {
      if (!isInt(v) || v < 0 || v >= limits.numRegs) {
        throw new SimError('INVALID_REGISTER', `指令 ${i} 的 ${field} 非法（0..${limits.numRegs - 1}）`, i);
      }
    };
    const checkImm = (v: unknown) => {
      if (!isInt(v) || v < limits.intMin || v > limits.intMax) {
        throw new SimError('INVALID_IMMEDIATE', `指令 ${i} 的立即数不是合法整数`, i);
      }
    };
    switch (ins.op) {
      case 'ADD':
        checkReg(ins.rd, 'rd'); checkReg(ins.rs, 'rs'); checkReg(ins.rt, 'rt');
        break;
      case 'ADDI':
        checkReg(ins.rd, 'rd'); checkReg(ins.rs, 'rs'); checkImm(ins.imm);
        break;
      case 'LOAD':
        checkReg(ins.rd, 'rd'); checkReg(ins.base, 'base'); checkImm(ins.imm);
        break;
      case 'NOP':
        break;
      default:
        throw new SimError('INVALID_OPCODE', `指令 ${i} 的操作码非法: ${String((ins as Instr).op)}`, i);
    }
  });
  if (spec.initRegs !== undefined) {
    if (typeof spec.initRegs !== 'object' || spec.initRegs === null) {
      throw new SimError('INVALID_INIT_VALUE', 'initRegs 必须是对象');
    }
    for (const [k, v] of Object.entries(spec.initRegs)) {
      const idx = Number(k);
      if (!Number.isInteger(idx) || idx < 0 || idx >= limits.numRegs) {
        throw new SimError('INVALID_REGISTER', `初始寄存器编号非法: ${k}`);
      }
      if (!isInt(v) || v < limits.intMin || v > limits.intMax) {
        throw new SimError('INVALID_INIT_VALUE', `寄存器 x${idx} 初始值越界或非整数`);
      }
    }
  }
  if (spec.memory !== undefined) {
    if (typeof spec.memory !== 'object' || spec.memory === null) {
      throw new SimError('INVALID_MEMORY', 'memory 必须是对象');
    }
    for (const [k, v] of Object.entries(spec.memory)) {
      const addr = Number(k);
      if (!Number.isInteger(addr) || addr < 0 || addr > limits.memAddrMax) {
        throw new SimError('INVALID_MEMORY', `内存地址越界: ${k}（0..${limits.memAddrMax}）`);
      }
      if (!isInt(v) || v < limits.intMin || v > limits.intMax) {
        throw new SimError('INVALID_MEMORY', `内存地址 ${k} 的值不是合法整数`);
      }
    }
  }
  return spec.instructions;
}

export function buildInitRegs(spec: ProgramSpec, limits: Limits): number[] {
  const regs = new Array(limits.numRegs).fill(0);
  for (const [k, v] of Object.entries(spec.initRegs ?? {})) {
    const idx = Number(k);
    if (idx !== 0) regs[idx] = v; // x0 恒为 0
  }
  return regs;
}

export function buildMemory(spec: ProgramSpec): Map<number, number> {
  const mem = new Map<number, number>();
  for (const [k, v] of Object.entries(spec.memory ?? {})) {
    mem.set(Number(k), v);
  }
  return mem;
}
