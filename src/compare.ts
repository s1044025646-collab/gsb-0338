import { interpret } from './interpreter';
import { Store } from './store';
import { RunStatus } from './types';

export interface CompareResult {
  programId: number;
  forwardingOn: { runId: number; status: RunStatus; cycles: number; regs: number[] };
  forwardingOff: { runId: number; status: RunStatus; cycles: number; regs: number[] };
  sequential: { ok: boolean; regs?: number[]; error?: string };
  regsMatch: boolean;
}

/** 比较转发开关：创建两个独立运行，跑到底后与顺序解释器核对。 */
export function compareModes(store: Store, programId: number, maxCycles?: number): CompareResult {
  const onId = store.createRun(programId, true, maxCycles);
  const offId = store.createRun(programId, false, maxCycles);
  const budget = store.getRun(onId).max_cycles;
  store.runCycles(onId, budget);
  store.runCycles(offId, budget);
  const on = store.getRun(onId);
  const off = store.getRun(offId);
  const prog = store.getProgram(programId);
  let sequential: CompareResult['sequential'];
  try {
    sequential = { ok: true, regs: interpret(prog.instructions, prog.initRegs, prog.memory, store.limits) };
  } catch (e) {
    sequential = { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  const onRegs = store.getRegisters(onId);
  const offRegs = store.getRegisters(offId);
  const eq = (a: number[], b: number[]) => a.length === b.length && a.every((v, i) => v === b[i]);
  const regsMatch =
    on.status === 'completed' && off.status === 'completed' &&
    eq(onRegs, offRegs) &&
    (!sequential.ok || eq(onRegs, sequential.regs!));
  return {
    programId,
    forwardingOn: { runId: onId, status: on.status, cycles: on.cycle, regs: onRegs },
    forwardingOff: { runId: offId, status: off.status, cycles: off.cycle, regs: offRegs },
    sequential,
    regsMatch,
  };
}
