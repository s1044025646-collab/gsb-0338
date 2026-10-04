import { CycleRecord, PipeState } from './types.js';
import { RunInfo } from './store.js';

function fmtStage(s: { id: number; op: string } | null): string {
  if (!s) return '气泡'.padEnd(8, ' ');
  return `#${s.id}:${s.op}`.padEnd(8, ' ');
}

/** 周期 × 阶段文本表 + 每周期寄存器写回变化。 */
export function formatReport(info: RunInfo, cycles: CycleRecord[], finalRegs: number[]): string {
  const lines: string[] = [];
  lines.push(`运行 ${info.id}  转发=${info.forwarding ? '开' : '关'}  状态=${info.status}  周期数=${info.cycle}`);
  lines.push('周期  | IF       | ID       | EX       | MEM      | WB       | 停顿     | 写回');
  lines.push('------+----------+----------+----------+----------+----------+----------+---------------');
  for (const c of cycles) {
    const stall = c.stall ? `${c.stall.reason}#${c.stall.instrId}` : '';
    const wb = c.writeback
      ? `x${c.writeback.reg}=${c.writeback.value}${c.writeback.discarded ? '(丢弃)' : ''} (#${c.writeback.instrId})`
      : '';
    const err = c.error ? ` 错误:${c.error.code}` : '';
    lines.push(
      `${String(c.cycle).padEnd(5, ' ')} | ${fmtStage(c.stages.IF)} | ${fmtStage(c.stages.ID)} | ${fmtStage(c.stages.EX)} | ${fmtStage(c.stages.MEM)} | ${fmtStage(c.stages.WB)} | ${stall.padEnd(8, ' ')} | ${wb}${err}`,
    );
  }
  lines.push(`最终寄存器: ${finalRegs.map((v, i) => `x${i}=${v}`).join(' ')}`);
  return lines.join('\n');
}

export function formatState(state: PipeState): string {
  const s = (x: { instr: { id: number; op: string } } | { id: number; op: string } | null): string => {
    if (!x) return '气泡';
    const instr = 'instr' in x ? x.instr : x;
    return `#${instr.id}:${instr.op}`;
  };
  return [
    `周期=${state.cycle} 状态=${state.status} PC=${state.pc}`,
    `IF=${s(state.ifStage)} ID=${s(state.idStage)} EX=${s(state.exStage)} MEM=${s(state.memStage)} WB=${s(state.wbStage)}`,
    `寄存器: ${state.regs.map((v, i) => `x${i}=${v}`).join(' ')}`,
    state.error ? `错误: ${state.error.code} 指令#${state.error.instrId} ${state.error.message}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}
