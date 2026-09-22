# P0 运行时能力矩阵 — dsh-dispatch(2026-09-22 实测)

> 依据:DISPATCH-DESIGN-REVISED.md(r2)§1.3「P0 产物:能力与限制清单」。
> 方法:3081 隔离实例(`D:\software\AIApp\DSH-P0TEST`,独立 DSH_HOME/凭据/会话存储),dsh-dispatch P0 探针插件
> (双通道生命周期监听 + dispatch_probe_identity/sleep 工具 + /dispatch/probe/* REST),真实模型(glm-5.3)
> 三次派发 + 一次中断 + 一次唤醒 + 宿主重启冷恢复。全部证据:
> `probe-results/probe-report-*.json` 与 `$DSH_HOME/dispatch/probe/events-*.jsonl`。无 mock。

## 0. 环境

| 项 | 值 |
|---|---|
| 宿主 | `@deepseek-ai/dsh` 0.1.5-rc.2(npm 全局,node v24.13.0) |
| 隔离 home | `D:\software\AIApp\DSH-P0TEST`(settings.yaml + .credentials.yaml 从主 home 复制) |
| 启动 | `dsh web --port 3081 --no-open`(**端口必须 CLI 传**;`DSH_WEB_PORT` 不是宿主认的环境变量) |
| provider | `["spawn","fork"]`;本次全用 `spawn` |
| 模型 | glm / glm-5.3(见发现 2:必须显式传) |

## 1. §1.3 清单逐项结论

| # | 验证项 | 结论 | 证据 |
|---|---|---|---|
| 1 | 宿主版本/包版本/profile | ✅ 全 0.1.5-rc.2;插件 inject=['tools','webServer','agents','subagents'] 全部就位 | env 探针 |
| 2 | provider/LLM 请求值与实际值 | ⚠ 请求值可传(agentOptions.provider/model);**实际值无事件级观察路径**(end 事件不含模型信息)。间接证据:同配置下 completed 正常 | child1/model-test |
| 3 | sponsor 与 child 真实工作区 | ✅ child 会话头 `cwd = sponsor 的 ws`、`parentSession = sponsorId`、`origin:'subagent'`、`delegationDepth:1` | 会话日志解压 |
| 4 | 子代理工具调用的可信 caller 身份 | ✅ **`exec.agent.id === childSessionId`**,实测 identity 工具来电与派发 childId 完全一致 | tool/identity 记录 |
| 5 | start/end 事件作用域、runId、时序 | ✅ **插件级与 sponsor 会话级双通道都全量收到**(R1 风险解除);runId 成对;**start 事件可早于 startContinuable 回执**(06:14:53.713 事件 vs .719 回执) | journal 双通道 |
| 6 | preparing/queued/running 取消实际行为 | ⚠ **见发现 4(最重要)**:接受后立即中断不产生 aborted 终态,已接受工作保留;运行中中断 10.5s 内传入工具、end=aborted | child2/child3 |
| 7 | 结束与静止的观察路径 | ✅ end 事件 stopReason(completed/aborted/error 实测)+ listChildren activity 翻转(running→inactive);**error 无 diagnostic 字段**(观察缺口) | 全部孩子 |
| 8 | 工具过滤、冷恢复后的过滤 | ✅ allow 单测:被滤工具**从子代理提示中彻底消失**(模型自述"无法构造调用",一次可见性成立);冷恢复过滤未直接复测(冷恢复本身 ✅) | child1 报告文本 |
| 9 | 审批、沙箱、目录边界 | ✅(类型+实测)`captureDelegatedPolicyOverrides(sponsor) = { sandboxMode:'workspace-write', approvalPolicy:'never' }` — 委派子代理审批固化 never,不可配置;bash 越界行为未测(P3) | policy 探针 |
| 10 | sponsor 是否被回传消息唤醒 | ⚠ **会**。child1 end(06:15:05.730/06:18:52.427 两次实测)同毫秒级 sponsor 会话日志增长(3786→5158 字节)→ sponsor 被结束通知唤醒,产生推理成本 | sponsorlog 采样 |

## 2. 关键发现(按对设计的影响排序)

### 发现 1:cordis 服务必须声明在 inject 里
未声明而经 ctx 取 `subagents` 直接抛 `cannot get property "subagents" without inject`。
`agents`/`subagents` 都是合法可注入服务名。**结论:插件 inject 静态声明,无懒加载空间。**

### 发现 2:工厂创建的 sponsor 没有默认模型路由
`ctx.agents.create({sessionId, meta:{cwd}})` 创建的 sponsor 不带 agentOptions;
其子代理继承不到模型路由 → **start 事件后 16ms 内 end(stopReason:'error'),会话日志只有头一行**。
settings.yaml 的 `agent-default-model` 只作用于 config-created 会话。
**结论:sponsor 创建时(或每次派发时)必须显式传 agentOptions;这是 v1 启动序 §2.2 第 6 步的硬性修订。**

### 发现 3:sponsor 被子代理结束唤醒(成本事实)
continuable 子代理 settle 时运行时会向父(sponsor)发一条含 outcome 的通知,sponsor 随即推理。
r2 §3.2 的怀疑属实。**结论:sponsor 不能宣称"纯被动零调用";其唤醒成本必须纳入预算并在 UI 披露,
或 P1 验证是否有配置能关停该通知。**

### 发现 4:中断不清除已接受工作(取消语义的硬边界)
child3 全链:接受回执 → 3ms 后 interruptByParent(accepted)→ **subagent/start 照发** → 90 秒无任何工具调用、无 end →
向该 child sendMessage → 唤醒后**一条 identity 调用同时消化初始消息+唤醒消息**,end=`completed`("已唤醒。完成。")。
即:**取消只作用于当前 turn;未开始的 inbox 工作被 park,任何后续消息(插件 send、官方 UI 插话)都会恢复执行**。
另一面:child2(运行中中断)信号 10.5 秒传入 sleep 工具(aborted=true),end=`aborted`,后续 identity 不再执行——运行中取消是可靠的。
**结论:r2 §7.4 的"取消完成"判定必须改为:end(aborted) 观察到 **且** 队列静止确认(或 drainContinuableChildren 释放)。
仅凭 interrupt 回执 accepted 绝不能标取消完成。**

### 发现 5:冷恢复真实存在且跨重启可用
宿主重启后:`listChildren(sponsorId)` 返回全部 7 个历史 child(inactive);
`agents.resume({resumeSessionId})` 领养 sponsor(via=resume);
对旧 child `sendMessage` 成功触发新 activation(新 runId 的 start 事件)。
**注意:子代理模型路由绑定在创建时**——一代孩子(无路由创建)重启后唤醒依旧 error;
当前代(带路由)孩子唤醒正常。
**结论:r2 §0.3"历史会话继续发消息不得重新取得旧任务写权限"的威胁模型成立(续聊通道物理存在);
dispatch 层的撤权必须独立于会话存续,落在工具侧每次调用校验。**

### 发现 6:startContinuable 回执与预留 childId
回执 `{childId, messageId}` 22-31ms 返回;预留 childId 被尊重(reservedMatched=true);
接受瞬间 `listChildren` 已可见(activity:'running')——**"queued"窗口在本环境极短,回执≈已开始调度**。
预留 childId 重复提交的行为未测(P1 补,对应 S4)。

### 发现 7:观察缺口
end(stopReason:'error') 不带 diagnostic(该字段只在 SubagentResult 上,事件面没有);
模型路由不可从事件观察;error 路径的会话日志可以只有头一行(异常 turn 不落盘)。
**结论:r2 的 observedModel 只能记请求值;错误归因要靠 reasonCode + 服务端日志,不能指望子会话日志。**

## 3. 对 r2 设计的修订要求(P1 前落实)

1. **§2.2 启动序第 6 步**:sponsor 领养/创建时校验并写入 agentOptions;或派发请求强制显式模型(允许列表校验)。二者取一,不得两头都缺省。
2. **§7.4 取消流程**:新增"队列静止确认"步骤——`drainContinuableChildren(sponsor,[childId])`(本版 API 存在未实测)或观察到 end+activity=inactive 之后,才允许标记取消完成、释放工作区占用;在此之前任何来源的新消息都可能复活 parked 工作。
3. **§3.2 sponsor 被动性**:按发现 3 改写——唤醒是默认行为;v1 预算页签把 sponsor 唤醒列为成本项;若 P1 找到关停配置再修订。
4. **§4.1 runtime.observedRuns**:runId 即激活周期标识,实测同一 child 多个 runId(child3 两个、冷恢复一个)——r2 "不混写历史派发"的字段设计正确,保留。
5. **§9.1 research-safe**:审批固化 `never` + `sandboxMode:'workspace-write'` 已实测,不可配置——权限边界只能靠 toolFilter + 工具自限(进程隔离),r2 的判断正确且现在有了实测值。
6. **探针插件工程项**:`agents`/`subagents` 进 inject;会话文件名兼容 `session.v3.jsonl.zstd`;测试实例必须 `--port` 传参。

## 4. 未覆盖(转 P1/P3)

toolDeny 路径、maxDepth 二级委派强制、outputSchema/persona、drainContinuableChildren 实测、
预留 childId 重复冲突(409 语义)、bash 工具目录越界、双宿主单写入者、断电窗口。
真实研究目录上的最小闭环任务(读日志/对比报告)属 P3 首任务。

## 5. 证据文件

- `dsh-dispatch/probe-results/probe-report-main-2026-09-22T06-10-40.json`(第一代,无模型路由 → error 路径证据)
- `dsh-dispatch/probe-results/probe-report-main-2026-09-22T06-17-35.json`(第二代,全部正向+中断+唤醒)
- `dsh-dispatch/probe-results/probe-report-post-restart-2026-09-22T06-20-48.json`(冷恢复)
- `D:\software\AIApp\DSH-P0TEST\dispatch\probe\events-*.jsonl`(全量事件流)
- 会话日志:`D:\software\AIApp\DSH-P0TEST\sessions\--D-software-AIApp-DSH-P0TEST-ws--\<sessionId>\session.v3.jsonl.zstd`

**P0 判定:核心链路(身份/工作区/事件/取消/恢复/权限固化)全部取得可复现证据,放行进入 P1;
上表 6 项修订要求与 3 条 ⚠ 观察缺口随 P1 一并落实。**

## 6. P1 期间的真机补充(2026-09-22)

- **toolFilter.deny 严格校验**:deny 未注册的工具名会被宿主直接拒绝启动(loud unknown-name validation)。子代理隔离只下发 allow 白名单——allow 即完备隔离,deny 冗余。
- **业务路径复现 P0 时序**:start 事件先于 startContinuable 回执到达(审计记录 start-accepted-late,归约器不倒退阶段)。
- P1 内核(51 项故障注入测试 + 3081 真机全链 finished/RESULT_SUBMITTED)见 README 与 tests/。
