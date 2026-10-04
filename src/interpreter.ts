import { Instr, INT_MAX, INT_MIN, RunConfig, SimError } from './types.js';

export interface InterpResult {
  ok: boolean;
  regs: number[];
  error?: SimError;
}

/** 独立顺序解释器：逐条按程序顺序执行，用于核对流水线最终寄存器。 */
export function interpret(
  program: Instr[],
  initRegs: number[],
  memory: Record<number, number>,
  cfg: RunConfig,
): InterpResult {
  const regs = initRegs.slice();
  regs[0] = 0;
  const fail = (code: SimError['code'], instr: Instr, message: string): InterpResult => ({
    ok: false,
    regs,
    error: { code, cycle: 0, instrId: instr.id, message },
  });
  for (const instr of program) {
    let result: number | undefined;
    switch (instr.op) {
      case 'ADD':
        result = regs[instr.rs!] + regs[instr.rt!];
        break;
      case 'ADDI':
        result = regs[instr.rs!] + instr.imm!;
        break;
      case 'LOAD': {
        const addr = regs[instr.rs!] + instr.imm!;
        if (addr < INT_MIN || addr > INT_MAX) {
          return fail('OVERFLOW', instr, `指令 #${instr.id} 地址计算溢出`);
        }
        if (addr < 0 || addr > cfg.addrMax) {
          return fail('ADDRESS_OUT_OF_RANGE', instr, `指令 #${instr.id} 地址 ${addr} 越界`);
        }
        if (!(addr in memory)) {
          return fail('UNDEFINED_ADDRESS', instr, `指令 #${instr.id} 读取未定义地址 ${addr}`);
        }
        result = memory[addr];
        break;
      }
      case 'NOP':
        break;
    }
    if (result !== undefined) {
      if (result < INT_MIN || result > INT_MAX) {
        return fail('OVERFLOW', instr, `指令 #${instr.id} 运算结果 ${result} 溢出`);
      }
      if (instr.rd !== undefined && instr.rd !== 0) regs[instr.rd] = result;
    }
    regs[0] = 0;
  }
  return { ok: true, regs };
}
