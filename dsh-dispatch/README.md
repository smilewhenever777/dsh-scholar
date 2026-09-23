# dsh-dispatch — 研究任务派发引擎

## 独立 AI 团队工作台（第一里程碑）

`dsh-dispatch` 现在可以独立于 `dsh-trajectory` 使用。安装插件并重新加载 DSH 客户端后，点击侧栏底部的 **◈ AI 团队**，进入大幅工作台。右侧「任务派发」页签提供状态摘要与入口。

1. 创建项目，绑定一个已存在的本机工作区绝对路径。工作区不能位于 `DSH_HOME` 中，且每个路径只绑定一个项目。
2. 在 Agent 目录创建执行者，选择 DSH 设置允许的模型、受控工具权限并填写工作指令。
3. 创建任务，写明目标和验收标准。分派 Agent 后任务仍保持待办；点击「手动运行」才启动子代理。
4. 在任务详情查看每次 Run 的会话消息、工具调用、结果、报告与证据。正常完成进入「待验收」，只有人工接受才进入「已完成」；填写意见退回后可再次运行，旧 Run 保留。

执行详情默认先显示中文状态、最近进度、报告和证据；「执行过程」把 Agent 消息与工具调用分开展示，长参数和工具结果默认折叠，「原始记录」保留按序事件。任务有多次运行时可选择任意两次对照结果、报告和证据数量。证据区域显示工作区内的完整路径并可复制。

看板支持拖动待办与受阻任务，也可在任务详情使用键盘可操作的状态选择。首版全局仅一个执行槽，忙时返回明确冲突原因，不自动排队。执行者沿用当前受控读取、报告写入和进度工具；工具白名单在服务端收紧。旧 trajectory 派发保留原接口，在工作台的「旧派发历史」中只读展示，不会自动转换为已验收任务。

工作台接口为 `/dispatch/workbench/*`，写入需要当前 `expectedRevision`；失配返回 409。项目、Agent、任务及讨论保存在 `$DSH_HOME/dispatch/workbench.json`，写前留备份，损坏后进入只读故障态。Run 存储仍是 `$DSH_HOME/dispatch/dispatches.json`。会话记录通过 DSH `sessionQuery` 读取，前端只接收该 Run 子会话的可见消息与工具事件；系统提示词和推理内容不会下发。

当前交付范围是第一里程碑。顺序执行的小队与本地定时自动化将在核心闭环验收后实施；停机期间错过的定时触发不会补跑。

### 工作台验证

```bash
cd dsh-dispatch
npm test
npm run smoke
```

隔离宿主真机脚本需要设置 `DSH_E2E_BASE`（本机 URL）、`DSH_E2E_WS`（独立工作区）和 `DSH_E2E_RECEIPT`（结果 JSON 路径），然后运行 `npm run e2e:workbench`；宿主重启后使用同一组变量运行 `npm run e2e:workbench -- --post-restart`。脚本会调用实际模型并生成两个 Run。

若从旧版升级，请先备份 `DSH_HOME`，升级插件后重启 DSH 宿主并重新加载客户端。`dispatches.json` v2 会升级为 v3 根格式并保留备份；旧 Run 记录保持原样。

---

> 以下 P0–P3 记录保留为原 trajectory 集成的历史验收资料（2026-09-22）。
> 设计全文见仓库根 `DISPATCH-DESIGN-REVISED.md`(r2);P0 运行时实测结论见
> [docs/runtime-capabilities.md](docs/runtime-capabilities.md)。

## v0.9.0 方案阶段 A–D(2026-09-23)

| 阶段 | 交付 |
|---|---|
| A 任务/Run 阅读 | 活动流重组(评论/交付/决定主线+进度收起);「关键事件」筛选;工具摘要行;顺序切换 |
| B 数据升级 | schema v2(assignment 多态);Project goal/description/archived;Agent displayDescription;写前备份 |
| C 固定小队 | Squad/SquadExecution;步骤快照;中间步自动接续/失败暂停;REST + 客户端 UI |
| D 定时自动化 | AutomationRule/TriggerAttempt;30s 调度器;(ruleId,scheduledAt) 幂等;忙跳过;REST + 客户端 UI |

## v0.6.0 UI/UX 优化(2026-09-23,四波)

| 波次 | 内容 |
|---|---|
| 交互止血 | 错误按发生处渲染(modal/抽屉内);ConfirmModal+toast 替换全部 window.prompt/alert;表单必填校验+autoFocus+焦点陷阱;409 友好+自动刷新重试;看板五列可拖入+非法目标 toast;rightbar 按钮不再卸载重建 |
| 视觉统一 | 全部颜色经 dsw-alias 令牌+color-mix 派生(亮色宿主自动适配);动效令牌体系(过渡/stagger/滑入/弹入/抖动/脉冲);导航图标化+窄屏适配;统计卡状态语义色;bundle minify(183KB→141KB) |
| 信息架构 | Run 执行过程对话化(Agent 气泡+头像 chip,安全 markdown 渲染);自动滚动+新事件浮标;总览计数可点带筛选;Agent 指令折叠;旧表中文;抽屉隐藏 revision |
| 架构打磨 | overview timeline 瘦身(最近 6+总数);?sinceRevision 短路(零负载轮询);讨论区显示截取说明 |

## 关卡进度

- **P0 运行时语义验证**:✅(探针 + 真实模型三链 + 冷恢复)
- **P1 无界面执行内核**:✅ 63/63 故障注入测试 + smoke + 3081 真机全链
- **P2 trajectory 安全接入**:✅ 双插件 E2E 全绿(`scripts/e2e-p2.mjs`):
  真实节点 → 派发(真实子代理)→ finished/RESULT_SUBMITTED → 回写 applied →
  节点 status=done、台账(⚡进度+🏁终局)、所有权释放+finalize 回执在册;无 token 写路径 403
- **P3 最小真实研究任务闭环**:✅ 附录 B 首任务真机 E2E 全绿(`scripts/e2e-p3.mjs`):
  三日志对比 → 报告文件 + 结构化 metrics 台账(TrajEntry.metrics)+ done 回写;
  **负结果如实报告**(exp_c 低于基线如实写入);不可访问日志 → blocked 且不编造
- **P4 客户端与发布**:✅ 右侧栏页签和 trajectory 节点入口已交付;独立工作台见上文。

## 并发语义(v0.10.0 起:跨工作区并行)

- **全局并发上限**可配(`maxConcurrentDispatches`,默认 3):不同工作区的任务可同时运行
- **重叠工作区互斥**保持:同一工作区、或父子目录关系的工作区,同时只允许一个派发
  (占用判定为路径包含,大小写不敏感);同任务/同节点照旧 `NODE_OCCUPIED`
- 触发顺序:节点互斥 → 工作区互斥 → 并发上限(409 `CAPACITY_EXCEEDED`)
- 自动化到点时仅当并发满才记 `skipped_busy`;工作区被占则记 `failed`(原因可见)
- 小队步骤共享全局配额;工作台导航脚注实时显示 `进行中 n/N`(overview.concurrency)

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

无人值守任务、多执行槽、受控代码修改与前台执行(待后续按 P0 结论评估放开)。
settings 命名空间 `dispatch`(targetBackend 默认 memory;3081 测试环境已设 trajectory)。

## 第三方许可

看板交互打包了 `@dnd-kit/core`、`@dnd-kit/accessibility` 和 `@dnd-kit/utilities`。这些包使用以下 MIT 许可；工作台界面及其他业务代码由本项目实现，没有复制 Multica UI 源码。

```text
MIT License

Copyright (c) 2021, Claudéric Demers

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
