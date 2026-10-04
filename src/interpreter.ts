import { Instr, Limits, SimError } from './types';

/** 独立顺序解释器：按程序顺序逐条执行，用于核对流水线最终寄存器。 */
export function interpret(
  prog: Instr[],
  initRegs: number[],
  memory: Map<number, number>,
  limits: Limits,
): number[] {
  const regs = initRegs.slice();
  regs[0] = 0;
  const check = (v: number, i: number) => {
    if (v < limits.intMin || v > limits.intMax) {
      throw new SimError('ARITHMETIC_OVERFLOW', `指令 ${i} 顺序执行溢出`, i);
    }
    return v;
  };
  prog.forEach((ins, i) => {
    switch (ins.op) {
      case 'NOP':
        break;
      case 'ADD':
        if (ins.rd !== 0) regs[ins.rd!] = check(regs[ins.rs!] + regs[ins.rt!], i);
        break;
      case 'ADDI':
        if (ins.rd !== 0) regs[ins.rd!] = check(regs[ins.rs!] + ins.imm!, i);
        break;
      case 'LOAD': {
        const addr = check(regs[ins.base!] + ins.imm!, i);
        if (addr < 0 || addr > limits.memAddrMax) {
          throw new SimError('ADDRESS_OUT_OF_RANGE', `指令 ${i}（LOAD）地址 ${addr} 越界`, i);
        }
        const v = memory.get(addr);
        if (v === undefined) {
          throw new SimError('UNDEFINED_MEMORY', `指令 ${i}（LOAD）读取未定义地址 ${addr}`, i);
        }
        if (ins.rd !== 0) regs[ins.rd!] = v;
        break;
      }
    }
    regs[0] = 0;
  });
  return regs;
}
