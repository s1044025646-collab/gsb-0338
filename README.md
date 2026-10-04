# 五级流水线数据冒险与转发回放后端

教学用周期级流水线模拟服务。纯后端（HTTP API + CLI），TypeScript + Node.js + SQLite，
Windows 本地运行，不依赖 Docker / WSL / 外部服务（SQLite 使用 Node 内置 `node:sqlite`，零原生依赖）。

## 教学子集与限制

- 指令仅支持整数 `ADD rd, rs, rt`、`ADDI rd, rs, imm`、`LOAD rd, imm(base)`、`NOP`，用 JSON 描述，不解析汇编。
- 五级流水线：取指 IF、译码 ID、执行 EX、访存 MEM、写回 WB。
- 8 个通用寄存器 `x0..x7`，`x0` 恒为 0（写它被忽略，也不制造依赖）。
- 内存是**只读**整数槽位映射（地址 → 值），`LOAD` 地址 = 基址寄存器 + 立即数。
- 只研究数据相关、转发与停顿：**不**模拟分支、缓存、异常、机器码。
- 整数为 32 位有符号（-2147483648 .. 2147483647），地址范围 0..1023。
- 程序长度 ≤ 64，单运行周期预算 ≤ 10000，单次报告 ≤ 1000 条周期记录（见 `GET /limits`）。

## 时序约定

- 每周期由**本周期开始状态**统一计算下一状态；一条指令不会在一周期内穿过多个阶段。
- 周期记录中各级显示的是该周期**开始**时级内指令；运行创建时已完成首次取指，
  因此周期 0 首条指令位于 IF。
- **写先读后**：WB 在周期前半提交，同周期 ID 读取到的是写回后的新值。
- 停顿：IF/ID 保持，EX 注入气泡（报告中 `~~`），不复制、不丢失指令；NOP 是真实指令，与气泡可区分。
- 取指完成后继续排空流水线，全部真实指令离开 WB 才记为 `completed`；
  达到周期预算未排空记为 `budget_exhausted`。

## 转发规则

- **开启**：EX 级操作数可取自当前 MEM 级（仅 ALU 结果）或 WB 级（任意结果），
  程序顺序上更近的写入者优先（MEM 优先于 WB 优先于寄存器堆）。
  LOAD 的值在 MEM 末才产生，紧邻使用者**必须停顿 1 拍**，之后从 MEM/WB 转发。
- **关闭**：无转发，依赖指令在 ID 等待，直到写入者离开 MEM（写先读后使 WB 同周期可读）。
- 不会从尚未产生加载值的阶段取数；`x0` 不作为转发/冒险目标。

## 错误处理

- 启动前拒绝：非法操作码 `INVALID_OPCODE`、非法寄存器 `INVALID_REGISTER`、
  非整数立即数 `INVALID_IMMEDIATE`、越界初始值 `INVALID_INIT_VALUE`、非法内存 `INVALID_MEMORY` 等。
- 运行时失败（状态 `failed`，带当前指令编号，绝不悄悄生成 0 宣称成功）：
  `ARITHMETIC_OVERFLOW`（整数溢出）、`ADDRESS_OUT_OF_RANGE`（地址越界）、
  `UNDEFINED_MEMORY`（读取未定义地址）。
- 运行状态冲突：`RUN_COMPLETED` / `RUN_FAILED` / `BUDGET_EXHAUSTED`（HTTP 409）。
- 运行的转发模式创建后不可更改；比较请用 compare（自动创建两个独立运行）。

## 构建 / 测试 / 启动 / 演示

```bat
npm install
npm run build     :: 编译 TypeScript 到 dist\
npm test          :: 构建并运行全部测试（node:test）
npm start         :: 启动 HTTP 服务（默认选择空闲端口，PORT=8080 可指定）
npm run demo      :: 运行全部内置演示（两种模式 + 顺序解释器核对）
```

数据目录默认为项目内 `data\`（`DATA_DIR` / `DB_PATH` 可覆盖）。
单步推进在 SQLite 事务中原子提交（周期记录 + 运行状态），重启后从保存状态继续，
结果与不中断运行一致（有测试覆盖）。

## HTTP API

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/programs` | 创建程序与初态 `{instructions, initRegs?, memory?}` → `{programId}` |
| POST | `/validate` | 仅校验程序负载，不创建 |
| POST | `/programs/:id/runs` | 创建运行 `{forwarding: bool, maxCycles?}` → `{runId}` |
| POST | `/programs/:id/compare` | 比较转发开关（两个独立运行 + 顺序解释器核对） |
| POST | `/runs/:id/step` | 单周期推进，返回本周期记录 |
| POST | `/runs/:id/run` | 有限步运行 `{cycles: n}` |
| GET  | `/runs/:id` | 运行状态 |
| GET  | `/runs/:id/registers` | 读寄存器 |
| GET  | `/runs/:id/cycles?from=&to=` | 查询周期记录 |
| GET  | `/runs/:id/report` | 导出周期×阶段文本报告 |
| GET  | `/runs` `/limits` | 列出运行 / 查看限制 |

错误响应：`{"error": {"code": "...", "message": "...", "instrId?": ...}}`。

## CLI

```bat
node dist\cli.js demo                        :: 内置演示（含周期表与寄存器变化）
node dist\cli.js validate program.json
node dist\cli.js create program.json
node dist\cli.js run <programId> --forwarding on [--cycles N] [--budget N]
node dist\cli.js step <runId> [n]
node dist\cli.js status ^| regs ^| cycles ^| report <runId>
node dist\cli.js compare <programId>
node dist\cli.js runs
```

程序文件示例：

```json
{
  "instructions": [
    { "op": "LOAD", "rd": 1, "base": 0, "imm": 0 },
    { "op": "ADD", "rd": 2, "rs": 1, "rt": 1 }
  ],
  "initRegs": { "1": 0 },
  "memory": { "0": 42 }
}
```

## 演示程序

`src/demo.ts` 内置四个教学场景：连续算术依赖、两个前序指令写同一寄存器
（最近写入者优先）、LOAD 后立即使用（停顿 1 拍）、无关指令填补 LOAD 等待。
每个演示都会以两种转发模式运行，并与独立顺序解释器核对最终寄存器一致。

## 代码结构

- `src/simulator.ts` — 周期级流水线核心（状态推进、冒险检测、转发、停顿）
- `src/interpreter.ts` — 独立顺序解释器（核对用）
- `src/validate.ts` — 启动前校验
- `src/store.ts` — SQLite 持久化（程序快照 / 运行状态 / 周期记录，原子提交）
- `src/server.ts` — HTTP API（内置 `node:http`，默认空闲端口）
- `src/cli.ts` / `src/demo.ts` / `src/report.ts` — 命令行、演示、文本报告
- `src/tests/sim.test.ts` — 测试（14 个用例）
