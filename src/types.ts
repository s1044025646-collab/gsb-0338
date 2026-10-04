export type Op = 'ADD' | 'ADDI' | 'LOAD' | 'NOP';

export interface Instr {
  id: number;
  op: Op;
  rd?: number;
  rs?: number;
  rt?: number;
  imm?: number;
}

export interface Slot {
  instr: Instr;
  result?: number;
  address?: number;
}

export type RunStatus = 'running' | 'done' | 'failed' | 'budget_exhausted';

export interface SimError {
  code: 'OVERFLOW' | 'UNDEFINED_ADDRESS' | 'ADDRESS_OUT_OF_RANGE';
  cycle: number;
  instrId: number;
  message: string;
}

export interface PipeState {
  pc: number;
  ifStage: Instr | null;
  idStage: Instr | null;
  exStage: Slot | null;
  memStage: Slot | null;
  wbStage: Slot | null;
  regs: number[];
  status: RunStatus;
  error?: SimError;
  cycle: number;
}

export interface RunConfig {
  forwarding: boolean;
  maxCycles: number;
  maxProgram: number;
  addrMax: number;
  reportLimit: number;
}

export const DEFAULT_CONFIG: RunConfig = {
  forwarding: true,
  maxCycles: 10000,
  maxProgram: 256,
  addrMax: 4096,
  reportLimit: 1000,
};

export const NUM_REGS = 8;
export const INT_MIN = -2147483648;
export const INT_MAX = 2147483647;

export interface OperandRecord {
  reg: number;
  value: number;
  source: 'regfile' | 'zero' | 'forward:EX/MEM' | 'forward:MEM/WB';
}

export interface CycleRecord {
  cycle: number;
  stages: {
    IF: { id: number; op: Op } | null;
    ID: { id: number; op: Op } | null;
    EX: { id: number; op: Op } | null;
    MEM: { id: number; op: Op } | null;
    WB: { id: number; op: Op } | null;
  };
  operands: OperandRecord[];
  stall: { reason: 'load-use' | 'raw-ex' | 'raw-mem'; instrId: number } | null;
  writeback: { instrId: number; reg: number; value: number; discarded: boolean } | null;
  error?: SimError;
}

export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public httpStatus = 400,
  ) {
    super(message);
  }
}
