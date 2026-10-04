import * as fs from 'node:fs';
import * as path from 'node:path';
import { compareModes } from './compare';
import { DEMOS } from './demo';
import { renderReport } from './report';
import { Store } from './store';
import { ProgramSpec, SimError } from './types';
import { validateProgram } from './validate';

const DATA_DIR = process.env.DATA_DIR ?? path.join(process.cwd(), 'data');
const DB_PATH = process.env.DB_PATH ?? path.join(DATA_DIR, 'pipeline.db');

function usage(): void {
  console.log(`用法: node dist/cli.js <命令> [参数]

命令:
  demo                          运行全部内置演示（两种转发模式 + 顺序核对）
  validate <program.json>       校验程序文件
  create <program.json>         创建程序，输出 programId
  run <programId> --forwarding on|off [--cycles N] [--budget N]
                                创建运行并推进 N 周期（默认直到结束）
  step <runId> [n]              单周期推进（可指定 n 步）
  status <runId>                查看运行状态
  regs <runId>                  读寄存器
  cycles <runId> [from] [to]    查询周期记录（JSON）
  report <runId>                导出周期×阶段文本报告
  compare <programId>           创建两个独立运行比较转发开关
  runs                          列出全部运行

环境变量: PORT（服务模式）、DATA_DIR、DB_PATH`);
}

function argValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function loadSpec(file: string): ProgramSpec {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as ProgramSpec;
}

function printReport(store: Store, runId: number): void {
  const run = store.getRun(runId);
  console.log(renderReport(store.getCycles(runId), {
    forwarding: run.forwarding === 1,
    status: run.status,
    finalRegs: store.getRegisters(runId),
  }));
}

function main(): void {
  const args = process.argv.slice(2);
  const cmd = args[0];
  if (!cmd || cmd === 'help' || cmd === '--help') return usage();

  const store = new Store(DB_PATH);
  try {
    switch (cmd) {
      case 'demo': {
        for (const [key, demo] of Object.entries(DEMOS)) {
          console.log(`\n================ 演示: ${key} — ${demo.title} ================`);
          const pid = store.createProgram(demo.spec);
          const cmp = compareModes(store, pid);
          console.log(`\n--- forwarding=on (run ${cmp.forwardingOn.runId}) ---`);
          printReport(store, cmp.forwardingOn.runId);
          console.log(`\n--- forwarding=off (run ${cmp.forwardingOff.runId}) ---`);
          printReport(store, cmp.forwardingOff.runId);
          console.log(`\n顺序解释器: ${cmp.sequential.ok ? `[${cmp.sequential.regs!.join(', ')}]` : `失败: ${cmp.sequential.error}`}`);
          console.log(`两种模式最终寄存器一致且与顺序执行一致: ${cmp.regsMatch ? '是' : '否'}`);
        }
        break;
      }
      case 'validate': {
        validateProgram(loadSpec(args[1]), store.limits);
        console.log('校验通过');
        break;
      }
      case 'create': {
        console.log(`programId = ${store.createProgram(loadSpec(args[1]))}`);
        break;
      }
      case 'run': {
        const pid = Number(args[1]);
        const fwd = argValue(args, '--forwarding');
        if (fwd !== 'on' && fwd !== 'off') throw new SimError('INVALID_ARGUMENT', '必须指定 --forwarding on|off');
        const budget = argValue(args, '--budget');
        const runId = store.createRun(pid, fwd === 'on', budget ? Number(budget) : undefined);
        const cycles = argValue(args, '--cycles');
        const r = store.runCycles(runId, cycles ? Number(cycles) : store.getRun(runId).max_cycles);
        console.log(`runId = ${runId}, 推进 ${r.cycles} 周期, 状态 = ${r.status}`);
        printReport(store, runId);
        break;
      }
      case 'step': {
        const runId = Number(args[1]);
        const n = args[2] ? Number(args[2]) : 1;
        for (let i = 0; i < n; i++) {
          const rec = store.stepRun(runId);
          console.log(JSON.stringify(rec));
        }
        break;
      }
      case 'status': {
        console.log(JSON.stringify(store.getRun(Number(args[1])), null, 2));
        break;
      }
      case 'regs': {
        const regs = store.getRegisters(Number(args[1]));
        console.log(regs.map((v, i) => `x${i}=${v}`).join('  '));
        break;
      }
      case 'cycles': {
        const runId = Number(args[1]);
        const from = args[2] ? Number(args[2]) : 0;
        const to = args[3] ? Number(args[3]) : undefined;
        console.log(JSON.stringify(store.getCycles(runId, from, to), null, 2));
        break;
      }
      case 'report': {
        printReport(store, Number(args[1]));
        break;
      }
      case 'compare': {
        const cmp = compareModes(store, Number(args[1]));
        console.log(JSON.stringify(cmp, null, 2));
        break;
      }
      case 'runs': {
        console.log(JSON.stringify(store.listRuns(), null, 2));
        break;
      }
      default:
        usage();
        process.exitCode = 1;
    }
  } catch (e) {
    if (e instanceof SimError) {
      console.error(`错误 [${e.code}] ${e.message}`);
    } else {
      console.error(e);
    }
    process.exitCode = 1;
  } finally {
    store.close();
  }
}

main();
