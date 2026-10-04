/** 指令与公共类型定义。指令编号即其在程序中的下标，创建后固定不变。 */

export type Op = 'ADD' | 'ADDI' | 'LOAD' | 'NOP';

export interface Instr {
  op: Op;
  /** 目标寄存器（ADD/ADDI/LOAD） */
  rd?: number;
  /** 源寄存器（ADD/ADDI） */
  rs?: number;
  /** 第二源寄存器（ADD） */
  rt?: number;
  /** 基址寄存器（LOAD） */
  base?: number;
  /** 立即数（ADDI/LOAD） */
  imm?: number;
}

export interface Limits {
  numRegs: number;
  memAddrMax: number;
  intMin: number;
  intMax: number;
  maxProgramLen: number;
  maxCycles: number;
  maxReportCycles: number;
}

export const DEFAULT_LIMITS: Limits = {
  numRegs: 8,
  memAddrMax: 1023,
  intMin: -2147483648,
  intMax: 2147483647,
  maxProgramLen: 64,
  maxCycles: 10000,
  maxReportCycles: 1000,
};

export type RunStatus = 'running' | 'completed' | 'budget_exhausted' | 'failed';

export interface ProgramSpec {
  instructions: Instr[];
  /** 初始寄存器值，缺省全部为 0；x0 恒为 0，忽略其初值 */
  initRegs?: Record<string, number>;
  /** 只读内存槽位：地址(字符串整数) -> 整数值 */
  memory?: Record<string, number>;
}

export class SimError extends Error {
  code: string;
  instrId?: number;
  cycle?: number;
  constructor(code: string, message: string, instrId?: number, cycle?: number) {
    super(message);
    this.code = code;
    this.instrId = instrId;
    this.cycle = cycle;
  }
}
