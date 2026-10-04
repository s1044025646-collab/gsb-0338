import path from 'node:path';
import { readFileSync } from 'node:fs';
import { RunStore } from './store.js';
import { formatReport, formatState } from './report.js';
import { startServer } from './server.js';

const DATA_DIR = process.env.DATA_DIR ?? path.join(process.cwd(), 'data');

const DEMOS: { name: string; input: Record<string, unknown> }[] = [
  {
    name: '连续算术依赖',
    input: {
      program: [
        { op: 'ADDI', rd: 1, rs: 0, imm: 5 },
        { op: 'ADDI', rd: 2, rs: 1, imm: 3 },
        { op: 'ADD', rd: 3, rs: 1, rt: 2 },
      ],
    },
  },
  {
    name: '两个前序指令写同一寄存器',
    input: {
      program: [
        { op: 'ADDI', rd: 1, rs: 0, imm: 5 },
        { op: 'ADDI', rd: 1, rs: 1, imm: 7 },
        { op: 'ADD', rd: 2, rs: 1, rt: 1 },
      ],
    },
  },
  {
    name: 'LOAD 后立即使用',
    input: {
      program: [
        { op: 'LOAD', rd: 1, rs: 0, imm: 4 },
        { op: 'ADDI', rd: 2, rs: 1, imm: 1 },
      ],
      memory: { '4': 100 },
    },
  },
  {
    name: '无关指令填补等待',
    input: {
      program: [
        { op: 'LOAD', rd: 1, rs: 0, imm: 4 },
        { op: 'ADDI', rd: 3, rs: 0, imm: 9 },
        { op: 'ADDI', rd: 2, rs: 1, imm: 1 },
        { op: 'NOP' },
      ],
      memory: { '4': 100 },
    },
  },
];

function usage(): void {
  console.log(`用法: node dist/src/cli.js <命令> [参数]
命令:
  serve [--port=N]                启动 HTTP API（默认自动选择空闲端口）
  create <program.json> [--forwarding=on|off] [--maxCycles=N]
  step <runId> [n]                推进 n 个周期（默认 1）
  run <runId> [n]                 最多推进 n 个周期
  status <runId>                  查看运行状态
  regs <runId>                    读寄存器
  cycles <runId> [from] [limit]   查询周期记录
  report <runId>                  导出周期×阶段文本报告
  compare <program.json>          创建转发开/关两个独立运行并对比
  demo                            运行全部内置演示（两种模式 + 顺序解释器核对）
program.json 格式: { "program": [...], "registers": {...}, "memory": {...} }`);
}

function loadSpec(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
}

function argValue(args: string[], name: string): string | undefined {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split('=')[1] : undefined;
}

function printCompare(store: RunStore, spec: Record<string, unknown>): void {
  const result = store.compare(spec as never);
  for (const [label, r] of [
    ['转发开', result.on],
    ['转发关', result.off],
  ] as const) {
    console.log(`\n===== ${label} (run ${r.run.id}) =====`);
    console.log(formatReport(r.run, store.getCycles(r.run.id), r.regs));
  }
  console.log(`\n顺序解释器寄存器: ${result.interpreter.regs.map((v, i) => `x${i}=${v}`).join(' ')}`);
  console.log(`两种模式与顺序执行一致: ${result.regsMatch ? '是' : '否'}`);
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd || cmd === 'help') return usage();
  if (cmd === 'serve') {
    const port = argValue(args, 'port');
    await startServer(port ? Number(port) : 0);
    return;
  }
  const store = new RunStore(DATA_DIR);
  try {
    switch (cmd) {
      case 'create': {
        const spec = loadSpec(args[0]);
        const fw = argValue(args, 'forwarding');
        const mc = argValue(args, 'maxCycles');
        const info = store.createRun({
          ...spec,
          forwarding: fw === undefined ? undefined : fw === 'on',
          maxCycles: mc ? Number(mc) : undefined,
        } as never);
        console.log(JSON.stringify(info, null, 2));
        break;
      }
      case 'step': {
        const n = Number(args[1] ?? '1');
        for (let i = 0; i < n; i++) console.log(formatReportLine(store, store.step(args[0])));
        console.log(formatState(store.getState(args[0])));
        break;
      }
      case 'run': {
        const { info } = store.runSteps(args[0], Number(args[1] ?? '1000'));
        console.log(JSON.stringify(info, null, 2));
        break;
      }
      case 'status':
        console.log(formatState(store.getState(args[0])));
        break;
      case 'regs':
        console.log(store.getRegisters(args[0]).map((v, i) => `x${i}=${v}`).join(' '));
        break;
      case 'cycles':
        console.log(JSON.stringify(store.getCycles(args[0], Number(args[1] ?? '1'), args[2] ? Number(args[2]) : undefined), null, 2));
        break;
      case 'report': {
        const info = store.getRun(args[0]);
        console.log(formatReport(info, store.getCycles(args[0]), store.getRegisters(args[0])));
        break;
      }
      case 'compare':
        printCompare(store, loadSpec(args[0]));
        break;
      case 'demo': {
        for (const d of DEMOS) {
          console.log(`\n######## 演示: ${d.name} ########`);
          printCompare(store, d.input);
        }
        break;
      }
      default:
        usage();
    }
  } finally {
    store.close();
  }
}

function formatReportLine(store: RunStore, rec: ReturnType<RunStore['step']>): string {
  const st = rec.stages;
  const f = (s: { id: number; op: string } | null) => (s ? `#${s.id}:${s.op}` : '气泡');
  return `周期${rec.cycle}: IF=${f(st.IF)} ID=${f(st.ID)} EX=${f(st.EX)} MEM=${f(st.MEM)} WB=${f(st.WB)}` +
    (rec.stall ? ` 停顿=${rec.stall.reason}` : '') +
    (rec.writeback ? ` 写回x${rec.writeback.reg}=${rec.writeback.value}` : '');
}

main().catch((e) => {
  console.error(e instanceof Error ? `${(e as { code?: string }).code ?? 'ERROR'}: ${e.message}` : e);
  process.exit(1);
});
