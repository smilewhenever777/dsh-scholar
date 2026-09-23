# dsh-dispatch v0.9.0 对补充方案的实现核查

> 核查日期：2026-09-23。范围为当前 `main` 的 `8f4a0cd`，工作区原本干净。本轮只做代码、测试和隔离临时数据复现，没有修改现有 DSH 用户数据，也没有启动真实模型 Run。对照基准为 [完整版本补充方案](workbench-v1-completion-plan.md)。

## 结论

**目前不能把阶段 A–D 标为完成，更不适合把自动化规则投入无人值守运行。** 旧的单 Agent 核心链仍可构建、现有测试通过；新增小队只有配置面，没有可执行链；自动化存在启动时机、计划时间、并发去重和重启恢复缺陷。界面新增了入口和两栏任务页，但多个表单与展示仍与新数据模型脱节。

## 已做到的部分

- `WorkbenchRoot` 升为 v2，新增项目目标/说明、Agent 展示描述和任务 `assignment` 字段；原单 Agent 路径、人工验收、旧派发历史代码仍在。
- 两栏任务详情、执行活动筛选和顺序切换、小队及自动化页面骨架已加入；插件 `npm test` 构建成功，**73/73** 现有测试通过；仓库 `npm test` 和 `npm run check:release` 均通过。
- 上述通过结果不覆盖小队和自动化：`dsh-dispatch/tests` 中没有这些新功能、v1→v2 迁移、定时/停机/并发的测试。

## 阻断项：先修这些再试无人值守

### P0-1：小队只是配置实体，任务无法分派并执行

任务创建和更新把 `assigneeId` 只当 Agent ID 校验；[service.ts](../src/workbench/service.ts) 的 `createTask`（146–153 行）、`updateTask`（171–175 行）没有接收 `assignment: {kind:'squad'}`，`start`（231–242 行）也只从 Agent 分支取配置。客户端却在任务表单下拉框提供小队 ID（[workbench.tsx](../src/client/workbench.tsx) 853 行），选择后会得到“执行者不存在”。小队的 `createExecution`、`onRunFinished` 在仓库中没有调用者；目标适配器 `finalize`（[target.ts](../src/workbench/target.ts) 75 行）仍把任意成功 Run 直接设为 `in_review`，没有“中间步保持 `in_progress`”。

**验收修复**：任务 API 使用带类型的 assignment；手动运行创建持久小队执行并启动第一步；每步 Run 完成经幂等回调进入下一步，末步才待验收；失败/取消/槽竞争/冷重启不丢步或重跑两次。补至少 2 步、3 步和边界重启测试。

### P0-2：新增路由把异步结果当同步 JSON 发送

[routes.ts](../src/workbench/routes.ts) 171、173、178、179 行的 Squad/Automation POST、PATCH 把 `Promise` 直接传给 `send()`，而 `send`（13–17 行）立即 `JSON.stringify(data)`。因此响应会是 `201 {}` 或 `200 {}`；异步校验/写入失败也无法按 4xx 返回，可能成为未处理的 Promise rejection。旧项目/Agent/任务路由均正确使用了 `await`，新路由遗漏。

**验收修复**：四处先 `await` 再 `send`，对成功、无效输入、版本冲突和存储失败做 HTTP 级测试；不要用空对象的 2xx 表示保存成功。

### P0-3：每次 HTTP 请求新建一个自动化调度器，宿主启动却不启动调度

[index.ts](../src/index.ts) 122–148 行在传给 `registerWorkbenchRoutes` 的 `getServices()` 中每次构造 `SquadService` 和 `AutomationService` 并调用 `automation.start()`；[routes.ts](../src/workbench/routes.ts) 104 行每个工作台请求都会调用这个工厂。结果是宿主重启后没有请求就没有调度器；打开工作台后的 5 秒 overview 轮询会持续增加 30 秒定时器。卸载只清理派发服务和工作台锁（[index.ts](../src/index.ts) 162–169 行），从未调用这些调度器的 `stop()`。多调度器又放大并发重复触发风险。

**验收修复**：宿主服务 ready 时只创建一个调度器并启动，路由取同一服务对象；在 Cordis 生命周期内停止。无浏览器打开时仍能按时触发，轮询一小时定时器数量保持 1。

### P0-4：cron、时区和停机语义与 UI/方案不符

[automation.ts](../src/workbench/automation.ts) 222–247 行只读取 cron 的**小时字段**，分钟、日期、月份、星期和 `timezone` 全部未参与计算；`isValidCron` 还接受越界数字及 `*/0`。UI 却明确写“分 时 日 月 周”、展示 `0 9 * * *` 等示例（[workbench.tsx](../src/client/workbench.tsx) 845–847 行）。隔离复现：创建 `*/5 * * * *` 后，下一次时间距离创建时间约 **14 分钟**，不是接下来 5 分钟的整点。`missed_offline` 仅在联合类型和注释出现，完全没有生成逻辑；宿主停机后保存的过期 `nextTriggerAt` 会在恢复后的下一次 tick 被执行一次，违反“错过不补跑”。

**验收修复**：使用可靠的带时区 cron 计算，保存前校验范围和 IANA 时区，显示接下来 5 次；重启时推进游标并记录错过时间窗摘要，不执行旧计划时刻。覆盖分钟/周规则、时区、夏令时和停机重启。

### P0-5：触发去重、入场和崩溃恢复未闭环

[automation.ts](../src/workbench/automation.ts) 165–177 行先在锁外查询是否已有 attempt，随后另一次写入随机 ID；两个调度器会同时通过检查。隔离并发复现：同一 `(ruleId, scheduledAt)` 得到 **2 条 attempt、2 次 `startTask` 调用**。`planned` 落盘后若崩溃，恢复时只返回旧 attempt，不推进游标或对账 Run，规则可能永远卡住；启动成功但更新 attempt 前崩溃，审计仍是 `planned`。`isSlotBusy()` 只是创建任务前的一次查询，之后若别的运行占槽，[index.ts](../src/index.ts) 130–138 行会先建任务再启动失败，留下无 attempt 关联的待办任务。幂等键包含 `Date.now()`，不能用计划时刻定位重试。

**验收修复**：把 `(ruleId, scheduledAt)` 作为存储内唯一键，在同一原子操作里领取；给任务/Run 使用确定性操作 ID；原子入场或带令牌的单槽预留先于任务创建；恢复时对 `planned` 与实际 Run 对账。并发、槽竞争和每个崩溃切点都应满足“一次计划最多一条任务、一次首 Run”。

## 重要缺口：影响日常使用与数据可信度

### P1-1：新页面表单与 revision 接线错误

- [workbench.tsx](../src/client/workbench.tsx) 585 行要求除 Agent 外所有表单都有 `form.title`；小队只有 `name`，所以“新建小队”始终在前端报“项目名称”缺失。
- 同文件 605–618 行编辑小队/自动化时，从 `overview.tasks` 寻找当前实体，`expectedRevision` 为 `undefined`；服务端 [squad.ts](../src/workbench/squad.ts) 104–107 行和 [automation.ts](../src/workbench/automation.ts) 109–112 行只在收到合法整数时才检查，实际上可绕过并发保护。
- 同文件 529–530 行只在挂载时加载小队/自动化列表，保存后的 `mutate()` 只刷新 overview 与任务详情；新实体和启停结果可能要关闭重开工作台才出现。
- v2 新任务只写 `assignment`，任务详情仍读 `selected.assigneeId`（709–722 行）；表单编辑时也没有把 `assignment` 映射回 `assigneeId`（569–573 行）。因此属性显示“未分派”，编辑保存可能把原 Agent 分派清空。

**验收修复**：表单按类型校验；新旧 assignment 显示和编辑统一；所有修改必须带准确 revision；保存后只刷新对应资源并保留草稿/定位。对真实 v2 任务做浏览器级创建、编辑、分派和双窗口冲突测试。

### P1-2：工作台存储的“失败不写入”不变量不成立

[store.ts](../src/workbench/store.ts) 230–240 行把真实根对象直接交给 `mutate(fn)`。如果 `fn` 先改字段再抛出校验错误，内存已变，下一次成功写入会把这次**被拒绝**的修改一起持久化。隔离复现：一次抛错修改把项目标题改为 `changed-with-error`；下一次空修改后，磁盘 JSON 也变成该值。新小队和规则的 `update` 都是先改名称再继续校验，触发路径明确。`snapshot()` 返回同一引用；`SquadService.root()` 与 `AutomationService.root()` 在读取时还直接补写空集合。

**验收修复**：每次变更用克隆候选根，校验成功后才写临时文件并替换内存；失败候选彻底丢弃。为字段中途校验失败、写盘失败和并发提交加测试。

### P1-3：迁移和新实体校验不足

[store.ts](../src/workbench/store.ts) 92–115 行只校验项目/Agent/任务的少数字段，不校验 v2 assignment、小队、执行、自动化规则、attempt 的结构和引用。`init()`（165–169 行）每次启动都重新持久化，包括本来已是 v2 的数据，使 revision 增加并覆盖备份；注释所说的“迁移后才写”与行为不符。旧 v1→v2 迁移和损坏后的只读恢复也没有新增测试。

**验收修复**：显式区分“读 v2”与“迁移 v1”，先备份再验证/写入；所有新增实体和关联在加载时校验，不合法则只读故障态；保留可恢复备份和迁移回执。

## 体验与发布缺口

- **Run 仍嵌在任务主栏**：[workbench.tsx](../src/client/workbench.tsx) 676 行直接挂 `RunPanel`，任务讨论在其后（701 行）；[workbench-style.ts](../src/client/workbench-style.ts) 248 行仍给活动区 72vh 内滚动。两栏结构有了，但专用 Run 阅读视图、任务讨论主线、可定位历史 Run 的目标尚未达成。50/500 事件也没有虚拟列表或浏览器性能证据。
- **项目/Agent 只补了字段**：项目页未展示进度/最近活动/归档筛选；Agent 页仍主要显示模型和工具数，缺最近 Run、受阻原因与人话权限摘要。总览仍返回全部任务，`withRuns` 对每个任务扫描全部派发记录（[service.ts](../src/workbench/service.ts) 59–70 行）；规模变大后成本明显上升。
- **自动化会默认启用**：[automation.ts](../src/workbench/automation.ts) 95 行 `enabled: raw.enabled !== false`，表单没有启用选项，保存即投入执行，与方案中的“用户明确启用后运行”不一致。页面只显示原始 cron，没有触发预览、中文失败分类或审计与任务/Run 的可点击链路。
- **文档与包版本不一致**：[README.md](../README.md) 前文仍称“小队与定时自动化将在后续实施”，后面又写“阶段 A–D 交付”。`package.json` 是 `0.9.0`，而 `package-lock.json` 顶层仍是 `0.5.0`。`check:release` 通过不代表这些语义已验收。

## 本轮验证与限制

| 检查 | 结果 |
| --- | --- |
| `dsh-dispatch` 的 `npm test` | 构建成功，73/73 通过；没有新阶段专项测试 |
| 仓库 `npm test` | 退出码 0；包含插件构建和现有仓库回归，未覆盖新增小队/自动化行为 |
| 仓库 `npm run check:release` | `currentIssues: []`，包可打包 |
| 并发自动化隔离复现 | 同一计划时间 2 条 attempt、2 次启动调用 |
| cron 隔离复现 | `*/5 * * * *` 被算到下一整点，样本偏差约 14 分钟 |
| 失败变更隔离复现 | 抛错后的内存改动被后续成功写入带上磁盘 |
| 真实 DSH/浏览器 | 工作台 overview 本机 HTTP 200；**未启动模型或做交互走查**。现代码每次请求会创建调度器，为避免进一步增加宿主定时器，本轮停止访问在线工作台 |

**建议修复顺序**：先关闭新规则的无人值守触发入口或修复 P0-2～P0-5；再接通 P0-1 的小队全链；随后修 P1 表单/存储/迁移；最后完成 Run 阅读、项目/Agent 体验和 50/500 事件实测。每项修复新增能失败于当前代码的测试，再更新 README 与版本锁文件，并做无 trajectory 的隔离宿主端到端验收。
