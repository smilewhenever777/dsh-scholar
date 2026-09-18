# 需求规格:dsh-trajectory 研究主线图

> v1.0 · 2026-08-31 · 目标:把研究项目可视化为**分层 DAG 主线图**,agent 在对话中主动维护,
> 实验节点实时映射 dashboard 训练进度,idea/论文节点引用 scholar 数据。

## 1. 目标

回答一个问题:**"我的研究走到哪了、卡在哪了?"**

把一个研究项目抽象为节点图:

- 节点 = 里程碑 / 创新点(idea) / 实验 / 论文 / 写作 / 其他
- 边 = 推进关系(enables 验证后才能 / feeds 产出喂给 / composes 汇入论文)
- 创新主线 = 图上一条高亮的关键路径(有序里程碑链)
- 状态 = todo / in_progress / blocked / done / dropped

## 2. 典型场景

1. 早上看一眼主线图:实验1 78% 在跑、实验3 受阻、论文节点待办——今天该推哪步一目了然。
2. 对话里说"我们开个新方向:X"→ agent `traj_project_set` 建项目、把计划拆成节点串成主线。
3. 实验跑完,说"实验1 结束了,结论是 Y"→ agent 推进节点状态并写结论;打开主线图已更新。
4. 新会话恢复上下文:系统提示词自动注入未完成节点摘要,agent 上来就知道项目进展。
5. 讲组会:打开主线图,主线脊柱横贯,分支展开,直接当 roadmap 讲。

## 3. 功能需求

### F1 项目与节点模型
- 多项目支持,同一时刻一个活跃项目;项目含 name/description/mainline(有序节点 id)/status(active|archived)。
- 节点字段:title/kind/status/detail(结论)/tags/refs(跨插件引用);边字段:source/target/kind。
- refs:`cardId/cardLabel`(scholar idea 卡)、`paperId/paperLabel`(scholar 论文)、
  `hostId/logPath/cmdPattern`(dashboard 实验绑定,用于实时进度匹配)。
- 校验:边端点必须存在且同项目、禁自环、去重;主线 id 必须存在、去重;
  上限 项目≤20 / 每项目节点≤500 / 边≤1500。

### F2 主线图可视化(核心)
- 分层 DAG:主线节点按 mainline 顺序排成水平脊柱(高亮),分支节点按最长路径分层、
  上下交替展开;确定性布局,无力模拟。
- 交互:滚轮缩放(0.25–3×)/空白拖拽平移/节点拖拽(会话内视觉偏移)/点选高亮 1 跳/fitView。
- 节点卡:kind 徽标 + 标题 + 状态色点;实验节点显示实时进度条(见 F4);主线边加粗 accent。
- 点选 → 玻璃信息卡:状态快捷流转按钮、detail、refs 展示、编辑/删除。
- 工具栏:项目切换/新建、添加节点、fitView、计数;空态引导用 agent 工具或手动添加。

### F3 清单视图
- 按状态分组(进行中/受阻/待办/已完成/已放弃)的平铺列表,行内迷你进度条,点击进入编辑。

### F4 实验实时进度(dashboard 联动)
- 抽屉打开且存在绑定的实验节点时,每 8s 轮询 `/dash/snapshots`(dashboard 有缓存+single-flight)。
- 匹配:logPath 精确匹配 `gpu.log.path`(大小写/斜杠不敏感);否则 cmdPattern 子串匹配
  `gpu.processes[].cmd`;hostId 可限定主机。未绑定主机则全主机扫描。
- 进度:优先从原始日志行解析 tqdm `cur/total`(分母客户端解析);回退 series
  (progress/epoch)显示原始值;日志 mtime 超 10min 标记「停滞?」。
- 纯 client 轮询,零 host 耦合;dashboard 缺席时静默降级为无进度。

### F5 Agent 工具集(8 个)
`traj_overview` / `traj_project_set` / `traj_node_add` / `traj_node_update` /
`traj_node_remove` / `traj_link_add` / `traj_link_remove` / `traj_mainline_set`。
全部经 defineTool 校验落盘;presentCall/presentResult 用 generic 卡片(纯函数,可重放)。

### F6 系统提示词双层机制(借 dsh-kanban)
- section(order 113):研究主线纪律——何时建节点/推进状态/写结论、与 scholar 分工、
  收尾不留 stale in_progress、更新前先 traj_overview。
- context(order 114):会话装配时同步注入活跃项目**未完成**节点摘要(≤30 条,
  保护 KV-cache 前缀);空/错返回 '',绝不 crash prompt 装配。

### F7 设置与入口
- 侧栏 footer 第 4 图标(order 12,服务器10→学者11→主线12),🧭 图标 + 未完成计数徽标(30s 轮询)。
- 右抽屉(shell.overlay id `dsh-trajectory-drawer` order 110):rail 折叠/宽度拖拽/`__dshDock` 发布。
- 设置页(order 120):数据目录、项目/节点统计。

## 4. 非目标(v1 不做)

- 跨插件深链跳转(scholar/dashboard 的 nav bus 是模块内部的;refs 仅展示 id/label)
- 项目重命名/归档 UI(agent 可经 traj_project_set 建新;重命名走编辑数据文件,P2)
- 甘特/时间线视图、力导向布局(已评审,选分层 DAG)
- 移动端
- host 侧自动实验发现并自动建节点(节点由 agent/用户显式登记,避免噪音)

## 5. 默认数据目录

`$DSH_HOME/trajectory`(DSH_HOME 缺省 `~/.dsh`);每项目一文件
`projects/<id>.json`(`{ project, nodes, edges }`),`meta.json` 存活跃项目 id。
设置页可改目录(改后重建 store,同 scholar paperDir 语义)。

## 6. 验收标准

1. `npm run build` + `npm run smoke` 全绿(smoke 覆盖 CRUD/边校验/主线校验/级联删除/损坏容错/重启持久/活跃切换)。
2. `dsh plugin --profile web add ./dsh-trajectory` 安装后,host 重启,页面刷新:
   侧栏第 4 图标出现,抽屉打开/折叠/拖宽正常,与 dashboard、scholar 三抽屉共存让位。
3. 对话中「建一个研究项目 X,把计划拆成主线」→ agent 建项目+节点+主线;打开主线图可见。
4. 「实验1完成了,结论是 Y」→ 节点变 done、detail 写入;`/traj/overview` 计数一致。
5. 绑定真实实验的节点在图上显示实时进度;dashboard 停机时图正常(无进度显示)。
