import { CycleRecord, StageName } from './simulator';

const STAGES: StageName[] = ['IF', 'ID', 'EX', 'MEM', 'WB'];

function cell(r: CycleRecord, s: StageName): string {
  const d = r.stages[s];
  if (d.instr === 'empty') return '.';
  if (d.instr === 'bubble') return '~~';
  return d.op === 'NOP' ? `#${d.instr}(nop)` : `#${d.instr}`;
}

/** 周期 × 阶段 文本表 + 停顿/转发/写回明细 + 寄存器变化。 */
export function renderReport(
  cycles: CycleRecord[],
  opts: { forwarding: boolean; status: string; finalRegs: number[] },
): string {
  const lines: string[] = [];
  lines.push(`模式: forwarding=${opts.forwarding ? 'on' : 'off'}  状态: ${opts.status}  周期数: ${cycles.length}`);
  lines.push('');
  const header = '周期 | IF   | ID   | EX   | MEM  | WB   | 事件';
  lines.push(header);
  lines.push('-'.repeat(64));
  const regChanges: string[] = [];
  for (const c of cycles) {
    const events: string[] = [];
    if (c.stall) events.push(`停顿: ${c.stall.reason}`);
    if (c.operands?.a && c.operands.a.src !== 'REG') {
      events.push(`转发 a: x${c.operands.a.reg} <- ${c.operands.a.src === 'FWD_MEM' ? 'EX/MEM' : 'MEM/WB'} (${c.operands.a.value})`);
    }
    if (c.operands?.b && c.operands.b.src !== 'REG') {
      events.push(`转发 b: x${c.operands.b.reg} <- ${c.operands.b.src === 'FWD_MEM' ? 'EX/MEM' : 'MEM/WB'} (${c.operands.b.value})`);
    }
    if (c.writeback) {
      events.push(`写回: x${c.writeback.reg} = ${c.writeback.value} (指令 ${c.writeback.instrId})`);
      regChanges.push(`周期 ${c.cycle}: x${c.writeback.reg} <= ${c.writeback.value}`);
    }
    if (c.error) events.push(`错误: ${c.error.code} ${c.error.message}`);
    lines.push(
      `${String(c.cycle).padStart(4)} | ${STAGES.map((s) => cell(c, s).padEnd(4)).join(' | ')} | ${events.join('; ')}`,
    );
  }
  lines.push('');
  lines.push('寄存器变化:');
  lines.push(regChanges.length ? regChanges.join('\n') : '(无写回)');
  lines.push('');
  lines.push(`最终寄存器: [${opts.finalRegs.map((v, i) => `x${i}=${v}`).join(', ')}]`);
  return lines.join('\n');
}
