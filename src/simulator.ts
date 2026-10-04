import {
  ApiError,
  CycleRecord,
  Instr,
  INT_MAX,
  INT_MIN,
  OperandRecord,
  PipeState,
  RunConfig,
  SimError,
  Slot,
} from './types.js';

export function writesReg(instr: Instr): boolean {
  return instr.op !== 'NOP' && instr.rd !== undefined && instr.rd !== 0;
}

export function sourceRegs(instr: Instr): number[] {
  switch (instr.op) {
    case 'ADD':
      return [instr.rs!, instr.rt!];
    case 'ADDI':
    case 'LOAD':
      return [instr.rs!];
    default:
      return [];
  }
}

export function initialState(regs: number[]): PipeState {
  return {
    pc: 0,
    ifStage: null,
    idStage: null,
    exStage: null,
    memStage: null,
    wbStage: null,
    regs: regs.slice(),
    status: 'running',
    cycle: 0,
  };
}

function slotLabel(slot: Slot | Instr | null): { id: number; op: Instr['op'] } | null {
  if (!slot) return null;
  const instr = 'instr' in slot ? slot.instr : slot;
  return { id: instr.id, op: instr.op };
}

function checkInt32(v: number, instr: Instr, cycle: number): SimError | null {
  if (v < INT_MIN || v > INT_MAX) {
    return {
      code: 'OVERFLOW',
      cycle,
      instrId: instr.id,
      message: `指令 #${instr.id} (${instr.op}) 运算结果 ${v} 超出 32 位有符号整数范围`,
    };
  }
  return null;
}

/**
 * 从本周期开始状态计算下一状态（统一语义，单周期内指令不会穿越多级）。
 * 时序约定：写回在周期前半完成，译码在周期后半读取寄存器堆，
 * 因此同一周期内 WB 级写入对 ID 级可见。
 */
export function step(
  state: PipeState,
  program: Instr[],
  memory: Record<number, number>,
  cfg: RunConfig,
): { state: PipeState; record: CycleRecord } {
  if (state.status !== 'running') {
    throw new ApiError('RUN_NOT_RUNNING', `运行已结束，状态为 ${state.status}`, 409);
  }
  const cycle = state.cycle + 1;
  const regs = state.regs.slice();
  const record: CycleRecord = {
    cycle,
    stages: {
      IF: slotLabel(state.ifStage),
      ID: slotLabel(state.idStage),
      EX: slotLabel(state.exStage),
      MEM: slotLabel(state.memStage),
      WB: slotLabel(state.wbStage),
    },
    operands: [],
    stall: null,
    writeback: null,
  };

  // 1. 写回（周期前半）：每条有写回的指令恰好在此提交一次。
  if (state.wbStage) {
    const w = state.wbStage;
    if (w.instr.op !== 'NOP' && w.instr.rd !== undefined) {
      const discarded = w.instr.rd === 0;
      if (!discarded) regs[w.instr.rd] = w.result!;
      record.writeback = { instrId: w.instr.id, reg: w.instr.rd, value: w.result!, discarded };
    }
  }

  let error: SimError | null = null;

  // 2. 访存：LOAD 在 MEM 级读取只读内存，结果随指令进入 WB。
  let memResult = state.memStage?.result;
  if (state.memStage && state.memStage.instr.op === 'LOAD') {
    const addr = state.memStage.address!;
    if (addr < 0 || addr > cfg.addrMax) {
      error = {
        code: 'ADDRESS_OUT_OF_RANGE',
        cycle,
        instrId: state.memStage.instr.id,
        message: `指令 #${state.memStage.instr.id} (LOAD) 地址 ${addr} 超出允许范围 0..${cfg.addrMax}`,
      };
    } else if (!(addr in memory)) {
      error = {
        code: 'UNDEFINED_ADDRESS',
        cycle,
        instrId: state.memStage.instr.id,
        message: `指令 #${state.memStage.instr.id} (LOAD) 读取未定义地址 ${addr}`,
      };
    } else {
      memResult = memory[addr];
    }
  }

  // 3. 执行：为 EX 级指令解析操作数（转发优先取程序顺序上最近的写入者）。
  let exResult: number | undefined;
  let exAddress: number | undefined;
  if (state.exStage && !error) {
    const instr = state.exStage.instr;
    const resolve = (reg: number): number => {
      if (reg === 0) {
        record.operands.push({ reg, value: 0, source: 'zero' });
        return 0;
      }
      if (cfg.forwarding) {
        const m = state.memStage;
        if (m && m.instr.op !== 'LOAD' && writesReg(m.instr) && m.instr.rd === reg) {
          record.operands.push({ reg, value: m.result!, source: 'forward:EX/MEM' });
          return m.result!;
        }
        const w = state.wbStage;
        if (w && writesReg(w.instr) && w.instr.rd === reg) {
          record.operands.push({ reg, value: w.result!, source: 'forward:MEM/WB' });
          return w.result!;
        }
      }
      record.operands.push({ reg, value: regs[reg], source: 'regfile' });
      return regs[reg];
    };
    switch (instr.op) {
      case 'ADD': {
        const a = resolve(instr.rs!);
        const b = resolve(instr.rt!);
        exResult = a + b;
        error = checkInt32(exResult, instr, cycle);
        break;
      }
      case 'ADDI': {
        const a = resolve(instr.rs!);
        exResult = a + instr.imm!;
        error = checkInt32(exResult, instr, cycle);
        break;
      }
      case 'LOAD': {
        const base = resolve(instr.rs!);
        exAddress = base + instr.imm!;
        error = checkInt32(exAddress, instr, cycle);
        break;
      }
      case 'NOP':
        break;
    }
  }

  // 4. 停顿检测（针对 ID 级指令的源寄存器；x0 永不构成依赖）。
  let stallReason: CycleRecord['stall'] = null;
  if (state.idStage && !error) {
    const srcs = sourceRegs(state.idStage).filter((r) => r !== 0);
    if (srcs.length > 0) {
      if (cfg.forwarding) {
        const ex = state.exStage;
        if (ex && ex.instr.op === 'LOAD' && ex.instr.rd !== 0 && srcs.includes(ex.instr.rd!)) {
          stallReason = { reason: 'load-use', instrId: state.idStage.id };
        }
      } else {
        const ex = state.exStage;
        if (ex && writesReg(ex.instr) && srcs.includes(ex.instr.rd!)) {
          stallReason = { reason: 'raw-ex', instrId: state.idStage.id };
        } else {
          const m = state.memStage;
          if (m && writesReg(m.instr) && srcs.includes(m.instr.rd!)) {
            stallReason = { reason: 'raw-mem', instrId: state.idStage.id };
          }
        }
      }
    }
  }
  record.stall = stallReason;

  // 5. 统一推进：所有下一级状态仅由本周期开始状态决定。
  const next: PipeState = {
    pc: state.pc,
    ifStage: null,
    idStage: null,
    exStage: null,
    memStage: null,
    wbStage: null,
    regs,
    status: 'running',
    cycle,
  };
  next.wbStage = state.memStage ? { ...state.memStage, result: memResult } : null;
  next.memStage = state.exStage ? { instr: state.exStage.instr, result: exResult, address: exAddress } : null;
  if (stallReason) {
    // 停顿：保持 IF/ID，EX 注入气泡；不复制、不丢失指令。
    next.exStage = null;
    next.idStage = state.idStage;
    next.ifStage = state.ifStage;
  } else {
    next.exStage = state.idStage ? { instr: state.idStage } : null;
    next.idStage = state.ifStage;
    if (state.pc < program.length) {
      next.ifStage = program[state.pc];
      next.pc = state.pc + 1;
    }
  }

  if (error) {
    next.status = 'failed';
    next.error = error;
    record.error = error;
  } else if (
    next.pc >= program.length &&
    !next.ifStage &&
    !next.idStage &&
    !next.exStage &&
    !next.memStage &&
    !next.wbStage
  ) {
    next.status = 'done';
  } else if (cycle >= cfg.maxCycles) {
    next.status = 'budget_exhausted';
  }
  return { state: next, record };
}
