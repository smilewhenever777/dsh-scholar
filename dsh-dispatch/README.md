# dsh-dispatch — 研究任务派发引擎

> 状态:**P3 最小真实研究任务闭环已交付并通过真机 E2E**(2026-09-22)。
> 设计全文见仓库根 `DISPATCH-DESIGN-REVISED.md`(r2);P0 运行时实测结论见
> [docs/runtime-capabilities.md](docs/runtime-capabilities.md)。

## 关卡进度

- **P0 运行时语义验证**:✅(探针 + 真实模型三链 + 冷恢复)
- **P1 无界面执行内核**:✅ 63/63 故障注入测试 + smoke + 3081 真机全链
- **P2 trajectory 安全接入**:✅ 双插件 E2E 全绿(`scripts/e2e-p2.mjs`):
  真实节点 → 派发(真实子代理)→ finished/RESULT_SUBMITTED → 回写 applied →
  节点 status=done、台账(⚡进度+🏁终局)、所有权释放+finalize 回执在册;无 token 写路径 403
- **P3 最小真实研究任务闭环**:✅ 附录 B 首任务真机 E2E 全绿(`scripts/e2e-p3.mjs`):
  三日志对比 → 报告文件 + 结构化 metrics 台账(TrajEntry.metrics)+ done 回写;
  **负结果如实报告**(exp_c 低于基线如实写入);不可访问日志 → blocked 且不编造
- **P4 客户端与发布**:⬜(右侧栏页签/节点按钮/徽标/详情)

## P1 内核结构

```text
src/types.ts          内部模型 + reasonCode + 规范化事件(§4.1)
src/reducer.ts        纯状态归约:阶段机/终态决策表/取消完成竞争(§4.2-4.4,含 P0 修订)
src/store.ts          单写入者 JSON store:原子写/幂等索引/占用/损坏只读/跨进程锁(§4.6-4.7)
src/service.ts        编排:启动十步/取消静止确认/接管/预算/对账/回写补偿(§2.2/§5.2/§5.6/§7)
src/runtime.ts        ctx.subagents 薄封装(真机语义注释)+ MockRuntime(故障注入)
src/adapters/target.ts 目标四动作契约(§5.4):内存实现=原型 + HttpTrajectoryAdapter 真实现
src/workerfs.ts       P3 受控文件面(读/列表限工作区,写仅报告目录)
src/policy.ts         research-safe 工具面/模型允许列表/worker 门控(§9)
src/prompt.ts         任务快照哈希/任务卡/执行协议单一来源(§6)
src/tools.ts          执行者工具(2 汇报 + 3 文件面,exec.agent 可信归属)
src/probe.ts          P0 探针面(保留)
```

## P2:trajectory 接入面(§5.4/§5.5/§5.6)

- **契约**:trajectory `/traj/dispatch-op`(read/claim/progress/finalize/revoke),全部在其
  `mutate()` 临界区内完成条件校验+幂等+修改;finalize 结论+状态+台账+回执同一次原子提交。
- **服务身份**:`x-dispatch-token` 与 `$DSH_HOME/.dispatch-service-token` 一致
  (trajectory 启动时创建;模型无文件工具读不到;凭据不进 prompt);无 token → 403。
- **指纹**:trajectory 单侧计算随 read 返回;claim 时重算比对,两端无算法漂移。
  人工编辑(含仅改 status)/删除/改绑 → 撤销所有权;台账写入不自失效。
- **回写**:终态 → pending → `operationId=dispatchId:finalize` 幂等终写;
  SUPERSEDED→skipped_superseded、删除→skipped_deleted、暂时不可用→error 由对账补偿
  (只做幂等状态同步,绝不重跑模型)。状态映射:done→done;blocked/failed→blocked;aborted 不回退。

## P3 受控文件面(§0.3/§9.2)

| 工具 | 边界 |
|---|---|
| dispatch_read_file | 仅工作区内文本;realpath 防符号链接逃逸;1MB 截断;二进制拒绝 |
| dispatch_list_dir | 仅工作区内目录;条目上限 500 |
| dispatch_write_report | **唯一文件写入口**,仅 `<ws>/dispatch-reports/<dispatchId>/`;文件名白名单;2MB |
| dispatch_progress | 台账;metrics 数组 → trajectory `TrajEntry.metrics`(name/value/baseline/unit) |
| dispatch_report | 最终结果;文件交付物以路径入 evidence |

硬边界:DSH_HOME 整体不可读;trajectory 直写工具无条件排除;
**工作区必须在 DSH_HOME 之外**(3081 测试环境为此使用 `D:\software\AIApp\DSH-P0TEST-ws`)。

## 验证

```bash
cd dsh-dispatch && npm test      # build + 63 项故障注入矩阵(T01-T28 的 P1-P3 范围)
npm run smoke                    # 无 LLM 冒烟
cd ../dsh-trajectory && npm test # 5 项 dispatch-op 单元测试(+ 既有 smoke)
# 真机:启动 3081 隔离实例后
node scripts/e2e-p2.mjs          # 双插件派发全链
node scripts/e2e-p3.mjs          # 附录 B 首任务(三日志对比 + blocked 分支)
```

## 真机新增事实(累计)

- toolFilter.deny 严格校验未注册工具名 → 只下发 allow(allow 即完备隔离)(P1)。
- start 事件先于 API 回执;归约器不倒退阶段(P0/P1 双证实)。
- **工作区不得位于 DSH_HOME 内**,否则 DSH_HOME 守卫挡掉整个工作区;模型在该场景下
  的多路径探针+交叉验证+如实 blocked 行为完全符合协议(P3)。
- **工具参数 schema 形状必须与约定一致**:metrics 声明为 object 时数组被拒、模型静默降级;
  改 array 后贯通(P3)。
- **PID 复用会骗过 writer.lock 存活检查**(锁内 PID 被 WeLink 复用 → 新实例保守只读)。
  已知改进项:锁加心跳时间戳,活性 = PID 存活且心跳新鲜。

## REST(§5.1 P1-P3 子集)

`POST /dispatch/start|cancel|takeover|reconcile|resolve`,`GET /dispatch/status/:id|list`,
探针面 `/dispatch/probe/*`。全部过 loopback 三重守卫,错误码稳定
(IDEMPOTENCY_CONFLICT / NODE_OCCUPIED / WORKSPACE_OCCUPIED / CAPACITY_EXCEEDED / STORE_READONLY / …)。

## 明确不做(当前)

客户端 UI(P4)、无人值守任务、多执行槽、受控代码修改与前台执行(待后续按 P0 结论评估放开)。
settings 命名空间 `dispatch`(targetBackend 默认 memory;3081 测试环境已设 trajectory)。
