# pipeline-sim：五级流水线数据冒险与转发回放后端

一个纯本地运行的教学用周期级流水线模拟服务。使用 TypeScript + Node.js + SQLite（Node 内置
`node:sqlite`，无原生依赖、无 Docker、无外部服务）。只提供 HTTP API 与 CLI，无图形界面。

## 教学子集与限制

- 指令集仅 4 条整数指令：`ADD rd, rs, rt`、`ADDI rd, rs, imm`、`LOAD rd, imm(rs)`、`NOP`。
- 8 个通用寄存器 `x0..x7`，`x0` 恒为零：写 `x0` 被丢弃，读 `x0` 不产生任何数据依赖。
- 内存是**只读**整数槽位映射（创建运行时以 JSON 对象给出），`LOAD` 地址 = 基址寄存器 + 立即数。
- 五级流水线：IF → ID → EX → MEM → WB。只研究数据相关、转发与停顿；
  **不**解析真实汇编、**不**模拟分支、缓存、异常处理或机器码。
- 整数运算为 32 位有符号（-2147483648..2147483647），内存地址允许范围 0..4096（`addrMax`）。
- 运算溢出或读取未定义地址：运行进入 `failed` 状态，记录出错周期与指令编号，**不会**静默生成零值。

## 时序约定

- 所有流水级统一从**本周期开始状态**计算下一状态，一条指令单周期内不会穿越多个阶段。
- **写回在前半周期、译码读取在后半周期**：同一周期内 WB 级写入对 ID 级可见。
- 转发开启时，EX 级操作数可取自 `EX/MEM`（仅非 LOAD，LOAD 值此时尚未产生）与 `MEM/WB`
  流水寄存器；多个写入者并存时优先取程序顺序上**最近**的有效写入者（先 `EX/MEM` 后 `MEM/WB`）。
- 紧邻 LOAD 的使用者（load-use）必须停顿 1 拍：IF/ID 保持，EX 注入气泡，不复制、不丢失指令。
- 转发关闭时无转发，依赖指令在 ID 等待，直到生产者离开 MEM（进入 WB 后按前半写约定可读）。
- 程序取完后继续排空流水线，全部真实指令写回结束才记为 `done`；NOP 与气泡在周期记录中可区分。
- 达到周期预算（`maxCycles`，默认 10000）但未排空时状态为 `budget_exhausted`（未完成）。

## 快速开始

```powershell
npm install      # 安装 typescript / @types/node
npm run build    # 编译到 dist/
npm test         # 构建并运行全部测试
npm run demo     # 运行 4 个内置演示（两种模式 + 顺序解释器核对）
npm start        # 启动 HTTP API（默认自动选择空闲端口）
```

要求 Node.js ≥ 22.5（建议 ≥ 23，`node:sqlite` 去掉实验警告）。数据保存在项目内 `data/` 目录
（可用环境变量 `DATA_DIR` 覆盖），重启后从保存状态继续，结果与不中断运行一致。

## HTTP API

启动：`npm start` 或 `node dist/src/server.js --port=8080`（默认端口 0 = 自动选空闲端口）。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/runs` | 创建运行：`{program, registers?, memory?, forwarding, maxCycles?}` |
| GET | `/runs` / `/runs/:id` | 列出 / 查询运行状态 |
| POST | `/runs/:id/step` | 原子推进一个周期 |
| POST | `/runs/:id/run` | 有限步运行：`{maxSteps}` |
| GET | `/runs/:id/registers` | 读寄存器 |
| GET | `/runs/:id/cycles?from=&limit=` | 查询周期记录（受 `reportLimit` 限制） |
| GET | `/runs/:id/report` | 周期×阶段文本报告 |
| POST | `/compare` | 同 body 创建转发开/关**两个独立运行**，跑到底并对比 |

指令格式：`{"op":"ADD","rd":3,"rs":1,"rt":2}`、`{"op":"ADDI","rd":1,"rs":0,"imm":5}`、
`{"op":"LOAD","rd":1,"rs":0,"imm":4}`、`{"op":"NOP"}`。指令编号按原程序固定（0 起）。

错误统一为 `{"error":{"code","message"}}`，错误码包括：
`INVALID_OPCODE`、`INVALID_REGISTER`、`INVALID_IMMEDIATE`、`INVALID_PROGRAM`、`INVALID_MEMORY`、
`INVALID_CONFIG`、`INVALID_JSON`、`OUT_OF_RANGE`、`LIMIT_EXCEEDED`、`RUN_NOT_FOUND`、
`RUN_NOT_RUNNING`、`NOT_FOUND`。运行时失败码：`OVERFLOW`、`UNDEFINED_ADDRESS`、`ADDRESS_OUT_OF_RANGE`。

## CLI

```powershell
node dist/src/cli.js serve [--port=N]
node dist/src/cli.js create prog.json [--forwarding=on|off] [--maxCycles=N]
node dist/src/cli.js step <runId> [n]
node dist/src/cli.js run <runId> [n]
node dist/src/cli.js status <runId>
node dist/src/cli.js regs <runId>
node dist/src/cli.js cycles <runId> [from] [limit]
node dist/src/cli.js report <runId>
node dist/src/cli.js compare prog.json
node dist/src/cli.js demo
```

`prog.json` 示例：

```json
{
  "program": [
    { "op": "LOAD", "rd": 1, "rs": 0, "imm": 4 },
    { "op": "ADDI", "rd": 2, "rs": 1, "imm": 1 }
  ],
  "registers": { "x3": 7 },
  "memory": { "4": 100 }
}
```

## 持久化与一致性

SQLite（`data/pipeline.db`）保存程序快照、初始寄存器、内存、配置、当前流水线状态与全部周期记录。
单步推进中「状态更新 + 周期记录写入」在同一事务提交；运行创建后 `forwarding` 等配置不可更改，
比较转发开关通过 `/compare` 或 `compare` 命令创建两个独立运行。

限制参数：程序长度 ≤ 256（`maxProgram`）、周期预算 ≤ 10000（`maxCycles`）、
单次报告 ≤ 1000 条周期记录（`reportLimit`）。

## 验证方式

- 独立顺序解释器（`src/interpreter.ts`）在有效程序上核对两种流水模式最终寄存器一致
  （含 20 组随机程序回归）。
- 手算周期表核对停顿位置与次数：连续算术依赖（开 7 周期 0 停顿 / 关 11 周期 4 停顿）、
  LOAD 紧邻使用（开 1 次 load-use / 关 2 次）、无关指令填补（0 停顿）。
- 覆盖空程序、单指令、`x0` 行为、跨重启推进、预算耗尽、每条写回指令恰好提交一次、
  溢出与未定义地址失败、启动前参数校验。

## 目录结构

```
src/types.ts        类型与默认限制
src/validate.ts     启动前参数校验
src/simulator.ts    周期级流水线核心（统一次态计算）
src/interpreter.ts  独立顺序解释器（核对用）
src/store.ts        SQLite 持久化与运行管理
src/server.ts       HTTP API
src/cli.ts          命令行与内置演示
src/report.ts       周期×阶段文本报告
test/simulator.test.ts  测试（node:test）
```
