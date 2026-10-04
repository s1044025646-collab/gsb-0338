import { ProgramSpec } from './types';

/** 教学演示程序集。 */
export const DEMOS: Record<string, { title: string; spec: ProgramSpec }> = {
  arith_chain: {
    title: '连续算术依赖（ADD 链）',
    spec: {
      instructions: [
        { op: 'ADDI', rd: 1, rs: 0, imm: 5 },
        { op: 'ADD', rd: 2, rs: 1, rt: 1 },
        { op: 'ADD', rd: 3, rs: 2, rt: 1 },
      ],
    },
  },
  two_writers: {
    title: '两个前序指令写同一寄存器（最近写入者优先）',
    spec: {
      instructions: [
        { op: 'ADDI', rd: 1, rs: 0, imm: 1 },
        { op: 'ADDI', rd: 1, rs: 1, imm: 10 },
        { op: 'ADD', rd: 2, rs: 1, rt: 1 },
      ],
    },
  },
  load_use: {
    title: 'LOAD 后立即使用（必须停顿一拍）',
    spec: {
      instructions: [
        { op: 'LOAD', rd: 1, base: 0, imm: 0 },
        { op: 'ADD', rd: 2, rs: 1, rt: 1 },
      ],
      memory: { '0': 42 },
    },
  },
  gap_fill: {
    title: '无关指令填补 LOAD 等待（无需停顿）',
    spec: {
      instructions: [
        { op: 'LOAD', rd: 2, base: 0, imm: 0 },
        { op: 'ADDI', rd: 1, rs: 0, imm: 7 },
        { op: 'ADD', rd: 3, rs: 1, rt: 1 },
        { op: 'ADD', rd: 4, rs: 2, rt: 2 },
      ],
      memory: { '0': 100 },
    },
  },
};
