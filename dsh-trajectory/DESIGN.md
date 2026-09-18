# 技术设计:dsh-trajectory 研究主线图插件

> v1.1 · 2026-09-02 · 基于 dsh-scholar 已验证的 host+client 架构;
> 进展维护机制借鉴 dsh-kanban(systemPrompt section + context + 模型工具)。

## 1. 架构总览

```
┌─────────────────────── DSH Web 页面(浏览器)────────────────────────┐
│  client 包(React,注入 slots)inject = ['slots','locale',           │
│   'sessions','workspaces']                                          │
│   ├─ sidebar.footer.action   🧭 触发器(order 12,未完成计数徽标)      │
│   ├─ shell.overlay           右抽屉(order 110):主线图 / 清单        │
│   └─ settings.section        设置页(order 130)                     │
│         │ /traj/*          │ 同源 GET /dash/snapshots(实验进度)     │
└────────┴──────────────────┴─────────────────────────────────────────┘
         │                    │
┌────────▼────────────────────▼──────── DSH Host(Cordis)──────────────┐
│  host 包:apply(ctx)  inject = ['settings','webServer','tools',      │
│                                   'systemPrompt'](驼峰!)           │
│  ├─ 设置命名空间 trajectory(dataDir)                                │
│  ├─ REST /traj/*(overview / projects / nodes / edges / stats)     │
│  ├─ Agent 工具 ×10(traj_overview / project_set / project_delete /  │
│  │    node_add / entry_add / node_update / node_remove /           │
│  │    link_add / link_remove / mainline_set)                       │
│  ├─ systemPrompt.section(order 121,主线纪律)                       │
│  ├─ systemPrompt.context(order 122,未完成节点摘要,同步 provider)   │
│  └─ store.ts:<dataDir>/projects/<id>.json + meta.json,            │
│     实例级写锁 + 原子写(随机 tmp + rename),损坏文件隔离 .bad      │
└──────────────────────────────────────────────────────────────────────┘
```

- host 与 client 分离:`tsc` 编 host → `dist/`;`tsdown` 打 client → `dist-client/`
  → `wrap-client.mjs` 包装成 `window.__ModuleLoader__.load({id, factory})` → `dist/client.js`。
- 路由避开 `/api` 前缀(dsh-client-connection 的 RPC 桥会吞掉)。
- 实验进度走 client 同源轮询 `/dash/snapshots`(statusbar 验证过的跨插件读数模式),
  host 不耦合 dashboard。

## 2. 数据模型(src/shared/types.ts)

```ts
TRAJ_NODE_KINDS = ['milestone', 'idea', 'experiment', 'paper', 'writing', 'other']
TRAJ_STATUSES   = ['todo', 'in_progress', 'blocked', 'done', 'dropped']
TRAJ_EDGE_KINDS = ['enables', 'feeds', 'composes']

interface TrajNodeRefs {
  cardId?: string; cardLabel?: string;      // scholar idea 卡
  paperId?: string; paperLabel?: string;    // scholar 论文
  hostId?: string; logPath?: string; cmdPattern?: string;  // dashboard 实验绑定
}
interface TrajNode {
  id: string;              // n_<base36><rand>
  projectId: string;
  kind: TrajNodeKind; title: string; status: TrajStatus;
  detail?: string;         // 结论/说明(done 应写)
  refs?: TrajNodeRefs;
  tags?: string[];
  createdAt: number; updatedAt: number;
}
interface TrajEdge { id: string; source: string; target: string; kind: TrajEdgeKind; }
interface TrajProject {
  id: string;              // p_<base36><rand>
  name: string; description?: string;
  mainline: string[];      // 创新主线:有序节点 id
  status: 'active' | 'archived';
  workspaceKey?: string;   // 绑定的 DSH 工作区(规范化 cwd;1 工作区 ↔ 1 主线,v1.1)
  createdAt: number; updatedAt: number;
}
interface TrajProjectFile { project: TrajProject; nodes: TrajNode[]; edges: TrajEdge[]; }
interface TrajConfig { dataDir: string; }
```

存储布局(`<dataDir>` 默认 `$DSH_HOME/trajectory`):

```
projects/<id>.json   每项目一文件 TrajProjectFile
meta.json            { activeProjectId }
```

**工作区绑定(v1.1)**:项目经 `workspaceKey`(规范化 cwd,正斜杠/小写比较)与 DSH 工作区 1:1 绑定。
解析顺序(store.resolveProject,路由与工具共用):**显式 projectId > 会话工作区绑定 > 全局活跃**。
- 工具侧:`exec.agent.session.header.cwd`(dsh-kanban 同款);node_add 对无绑定工作区 autoCreate;
- 客户端:sessions/workspaces 服务解析当前工作区(kanban 同款),全部请求带 `ws` 参数,切换即跟随;
- 提示词 context:按装配上下文的会话 cwd 只注入该工作区摘要,无绑定不注入(跨项目零串扰);
- `findByWorkspace`:精确匹配优先,最长路径前缀兜底(会话 cwd 为子目录);`bindWorkspace` 恒为精确匹配。

- 原子写(随机 tmp 后缀 + rename)+ **实例级写锁**(全部 mutating 方法经 promise 链串行,
  防读-改-写交错);损坏文件隔离为 `<file>.bad`(下次启动不再扫到);`deletedIds` 让已删项目的
  在途写入直接丢弃(防并发"复活");上限 项目≤20/节点≤500/边≤1500。
- refs 存 id + 展示 label(模型提供),不强校验 scholar 侧存在性(scholar 独立演进)。

### 2.1 ws 优先与防串写(v1.1)

`resolveProject(opts)`:`mutating = autoCreate || opts.mutating`。mutating 且既无 `projectId`
也无法识别工作区(ws 缺失/为空)时**显式抛错**("无法识别当前工作区…"),绝不静默落全局活跃;
读操作(overview / 工具 traj_overview)保持回落活跃。REST `POST /traj/nodes`、`POST /traj/edges`
传 `mutating: true`(无 ws 且无 projectId → 400)。

### 2.2 成环防护(v1.1)

`domain.assertEdgeAcyclic`:新建边前从 target 沿现有边 DFS,能回到 source 即拒绝
(错误消息含成环路径节点名);`addNode` 的 parentIds 与 REST/工具建边共用此校验
(新节点只作 target,结构上不可能成环,DFS 常数开销)。历史数据中的成环边由客户端
TrajGraphView 检测并在顶部警告;layoutDag 的层推进上限 = 节点数,环不再甩出极远坐标。

## 3. Host 实现

### 3.1 设置与注入

```ts
export const name = 'dsh-trajectory';
export const inject = ['settings', 'webServer', 'tools', 'systemPrompt'];
// 注意:服务名是驼峰 systemPrompt(kebab 会永远 pending,dsh-morning 踩过)
```

- `settingsNamespace('trajectory')`: `{ dataDir }`,默认 `dshHome()/trajectory`
  (`dshHome()` = `DSH_HOME` 环境变量或 `~/.dsh`,morning 同款;记忆/数据都在安装目录)。
- 懒加载单例 store,目录变化重建(同 scholar);apply 时 fire-and-forget 预热,
  让 systemPrompt.context 尽快有数据。

### 3.2 存储层(store.ts)+ 纯函数(domain.ts)

- `TrajStore`:内存 Map(项目文件)+ 原子写整文件;**实例级写锁**(promise 链)包裹全部
  mutating 方法(create/setActive/bind/update/delete/node/edge/entry/mainline),读-改-写串行;
  tmp 文件带随机后缀,rename 失败清理后 rethrow;损坏项目文件隔离 `<file>.bad`;
  `deletedIds` 丢弃已删项目的在途写入;`peekActive()` 同步访问活跃项目(供 prompt context);
  `removeNode` 级联清边+主线;`setMainline` 经 `normalizeMainline`(去重、滤掉不存在 id)。
- `domain.ts` 纯函数:`createProject/applyProjectPatch/createNode/applyNodePatch/
  validateEdge/assertEdgeAcyclic/normalizeMainline`,now 参数注入保证可测;补丁合并只覆盖提供的字段
  (refs 整体替换,空对象删除)。

### 3.3 REST 路由(/traj/*)

| 路由 | 方法 | 说明 |
|---|---|---|
| `/traj/overview` | GET | `{ activeProjectId, ws, projects[], counts, dir }`(badge 轮询;带 ws 按工作区解析,无 ws 回落活跃) |
| `/traj/stats` | GET(校验 method) | 设置页统计 |
| `/traj/config` | GET / PUT | dataDir 读写 |
| `/traj/projects` | GET / POST | 列表(含各项目计数)/ 新建(≤20;带 ws 为工作区绑定创建) |
| `/traj/projects/:id` | GET / PUT / DELETE | 全图 / 补丁(mainline 校验)/ 删除(活跃则重指派) |
| `/traj/projects/:id/active` | PUT | 设为活跃 |
| `/traj/nodes` | POST | 新建(projectId/ws 必给其一,否则 400;parents→enables 边;mainline=true 追加主线尾) |
| `/traj/nodes/:id` | PUT / DELETE | 补丁 / 删除(级联) |
| `/traj/nodes/:id/entries/:eid` | DELETE | 删除台账 |
| `/traj/edges` | POST | 新建(端点存在/同项目/禁自环/**禁成环**/去重;projectId/ws 必给其一) |
| `/traj/edges/:id` | DELETE | 删除 |

- prefix 路由手工解析 `:id`;POST/PUT 强制 application/json(CSRF);schemastery 校验;
  错误分类:文件系统错误(EACCES/EBUSY/ENOENT 等)500,校验/业务拒绝 400。

### 3.4 Agent 工具(tools.ts,10 个)

| 工具 | 参数要点 | 语义 |
|---|---|---|
| `traj_overview` | projectId? | 当前工作区项目全景:主线有序(id/kind/title/status)+分支节点+边+计数;**更新前先调** |
| `traj_project_set` | name?,description?,researchQuestion?,rebindProjectId?,unbind? | 工作区创建/绑定主线;幂等;researchQuestion 演进更新 |
| `traj_project_delete` | projectId,confirm=true | 删除项目(不可恢复,必须显式确认) |
| `traj_node_add` | kind/title 必填;detail/status/tags/refs 字段/parentIds(→enables 边)/mainline?(追加主线尾) | 登记节点(autoCreate 落当前工作区) |
| `traj_entry_add` | nodeId,title,data?,conclusion?,date(YYYY-MM-DD 严格校验,非法落 now+warning) | 记实验台账 |
| `traj_node_update` | id 必填;其余可选;refs 传空串清除对应项 | 推进状态/写结论/绑实验 |
| `traj_node_remove` | id | 删除(级联清边+主线) |
| `traj_link_add` | source/target/kind | 建推进边(**禁自环/禁成环**,DFS 检测) |
| `traj_link_remove` | id | 删边(id 从 traj_overview 拿) |
| `traj_mainline_set` | nodeIds 必填有序 | 重排创新主线 |

- presentCall/presentResult generic 卡片(纯函数,可重放);输出 toJson 去 undefined;
  cmdPattern <4 字符时工具/REST 返回 warning(提示匹配过宽)。

### 3.5 系统提示词(prompt.ts)

- `section({ name:'dsh-trajectory', order:121, text })`:主线纪律(静态文本)——
  规划/开实验/出论文时 node_add;推进时 node_update+结论;与 scholar 分工
  (paper_save 存文献、idea_card_create 记卡,traj 记进展与结构);里程碑用
  mainline_set 串成创新故事线;收尾不留 stale in_progress;更新前先 overview。
  (order 121/122:dsh-kanban 占 113/114,错开避免相对次序取决于加载序。)
- `context({ name:'traj:open-items', order:122, text: 同步 provider })`:
  当前工作区项目未完成节点摘要(kind+title+status,主线在前,≤30 条,标题截断 40 字符,
  整段字符预算 2000);空/错返回 '';只注 open 项保护 KV-cache 前缀;读取全防御式。

### 3.6 权限与安全

- 工具/路由只操作自身 dataDir,无任意路径写;写操作结果对话内可见可审查。

## 4. Client 实现

### 4.1 入口(client/index.tsx)

- `inject = ['slots', 'locale', 'sessions', 'workspaces']`(四服务:sessions/workspaces
  解析当前工作区 cwd);apply-guard `__dshTrajectoryApplied`(effect 可释放)。
- `sidebar.footer.action` order 12:🧭 触发器 + open 计数徽标(30s 轮询 /traj/overview)。
- `shell.overlay` id `dsh-trajectory-drawer` order 110:右抽屉(rail 34px/拖宽
  **360–720/默认 480**/`__dshDock` 发布 + `dsh-dock-change`,scholar Drawer 同款)。
- `settings.section` order **130**(WORKBENCH-LAYOUT 分区公约:服务器100→学者110→
  皮肤中心120→主线图130)。
- tab 总线 nav.ts(`'graph' | 'list'`),useSyncExternalStore,快照值稳定。
- 数据/进度轮询:抽屉 closed 且非全页时停;rail 只剩徽标,overview 轮询降为 30s;
  loadOverview/loadFile 带请求序号守卫(丢弃乱序过期响应)。

### 4.2 主线图(TrajGraphView,核心)

- **布局(确定性,无力模拟)**:
  1. 主线节点层号 = mainline 序号(脊柱列);其余节点拓扑序最长路径分层
     (主线节点层号固定;层推进上限 = 节点数,防历史环数据甩出极远坐标)。
  2. 竖排:主线沿 y 轴自上而下(行距 ROW_H=104),分支沿 x 轴左右展开(LANE_X=216);
     分支节点在层内按父节点 y 的 barycenter 排序,槽位 ±1…±5 交替,第 11 个起
     按符号交替绝对值递增续排(同列任意数量不重叠)。
  3. 画布尺寸由布局外延;**fitView 只在挂载后首次布局、切换项目、手动点 fit 按钮时
     执行**——10s 数据轮询刷新不再重置用户的平移/缩放。
- **成环兜底**:加载后对每条边做 DFS 检测(从 target 能否回到 source),历史成环边
  顶部警告 chip「N 条成环边(历史数据),建议删除」。
- **交互**(scholar GraphView 外壳):view transform 缩放(0.3–2.5×)平移、节点拖拽
  (会话内偏移存 ref,状态筛选激活时同样叠加;拖拽经 dragTick 触发 memo 重算,
  不原地改 memo 结果)、点选高亮 1 跳、ResizeObserver。
- **节点卡**:圆角矩形 **176×70**;kind 徽标 + 状态 pill + 标题两行(按卡宽截断 14 字/行)+
  实验进度条;milestone 加 accent 左条+粗边。
- **边**:三次贝塞尔(上缘→下缘),kind 着色,箭头;主线相邻边(accent)加粗。
- **信息卡**:右上玻璃卡——标题/kind/状态、detail、refs(卡/论文 label、实验绑定)、
  状态流转 5 按钮、编辑/删除;进度行(running pct / 停滞)。
- **工具栏**:筛选框、fit、全页、成环警告 chip、计数 pill。

### 4.3 实验实时进度(useDashProgress)

- 抽屉打开或全页存活(且存在带绑定的 experiment 节点)时,8s 轮询 `/dash/snapshots`。
- 匹配:logPath 归一化(小写、`\`→`/`)精确等于 `gpu.log.path`;否则 cmdPattern
  小写子串匹配任一 `gpu.processes[].cmd`;hostId 限定主机。
- 进度:倒序扫 `gpu.log.lines` 找 tqdm `(\d+)/(\d+)\s*\[` → pct + `cur/total`
  (分母只在原始行里有,series 只存分子);回退 series `progress`/`epoch` 最新值
  显示原始数字;停滞阈值优先取响应的 `staleMinutes` 字段(与 dashboard 配置同源),
  缺省回落 10min → stale(琥珀「停滞?」)。
- dashboard 不可达 → 空 Map,静默降级。

### 4.4 清单视图(TrajListView,v1.1 项目梳理形态)

- 研究问题卡置顶(researchQuestion/description 兜底 + 项目计数行);
- 主线里程碑垂直时间线(编号圆点,done 打勾;defaultOpen 展开各节点的实验台账);
- 台账行 = 日期(YYYY/M/D)| 做了什么 | 数据(等宽高亮)| 结论,行尾小删除按钮
  (confirm 后调 DELETE `/traj/nodes/:id/entries/:eid`);
- 分支工作区:未完成在前(in_progress/blocked/todo),done/dropped 排最后;
- 底部弱化的待办 chips;点节点开编辑 Modal。

### 4.5 编辑 Modal + 设置页

- NodeEditorModal:标题/kind/status/detail/tags;refs:cardId+label、paperId+label、
  实验绑定(hostId/logPath/cmdPattern);mainline 开关(在主线位置)。
- SettingsSection:dataDir + 统计(项目/节点/边/状态分布),order 120。

### 4.6 样式

- 全部 `var(--dsw-alias-*)` token + scholar 的 ui.tsx 原语裁剪(T/Z/SchStyles/
  Icon/IconButton/Btn/Input/Textarea/Select/SearchInput/Field/EmptyState/Section/
  Meta/Chip/Modal);状态色:todo=caption,in_progress=business 蓝,blocked=warning
  琥珀,done=success 绿,dropped=灰删除线;z-index 表(drawer 70/modal 200/float
  2147483000)。

## 5. 目录结构

```
dsh-trajectory/
  package.json / cordis.patch.yml / tsconfig.json / tsdown.config.ts / .gitignore
  REQUIREMENTS.md / DESIGN.md / README.md
  scripts/wrap-client.mjs / smoke-test.mjs
  src/
    index.ts              host 入口(settings + 路由 + 工具 + systemPrompt 装配)
    prompt.ts             主线纪律 section + 未完成摘要 context
    store.ts              项目文件存储 + 计数/级联/主线
    domain.ts             纯函数(创建/补丁/校验/归一化)
    routes.ts             /traj/* 路由
    tools.ts              10 个 Agent 工具
    shared/types.ts       数据模型
    client/
      index.tsx           入口:apply-guard + 三槽 + Drawer
      nav.ts / api.ts     tab 总线 / fetch
      ui.tsx              设计 token + 原语(裁剪自 scholar)
      locales.ts          zh/en
      TrajGraphView.tsx   分层 DAG 主线图(布局/交互/进度映射)
      TrajListView.tsx    清单
      NodeEditor.tsx      节点编辑/新建 Modal + 项目新建 Modal
      SettingsSection.tsx 设置页
```

## 6. 构建与安装

```sh
npm install --legacy-peer-deps   # npm cache 用工作区 .npm-cache
npm run build                    # tsc + tsdown + wrap-client
npm run smoke                    # 存储层冒烟(临时目录)
dsh plugin --profile web add ./dsh-trajectory   # 需 pnpm shim 在 PATH
```

- host 更新需完全重启桌面端/`dsh web`;client 更新刷新页面即生效。
- 勿用 PowerShell `-replace`+`Set-Content` 改写 UTF-8 源文件(GBK 误读损坏中文),
  一律 UTF-8 无 BOM 写入。

## 7. 里程碑

| 里程碑 | 内容 | 状态 |
|---|---|---|
| M1 骨架 | 包结构 + 构建链 + 三槽空壳安装进 web profile | ✅ |
| M2 数据层 | store/domain/routes/10 工具 + systemPrompt 双注入 + smoke(49 项) | ✅ |
| M3 主线图 | DAG 布局/交互/节点卡/信息卡/编辑 Modal/清单 | ✅ |
| M4 联动 | dashboard 进度映射 + badge + refs 展示 | ✅ |
| M5 打磨 | locales/README/实测(三抽屉共存/实时进度 epoch 142) | ✅ |
| M6 v2 体验 | 清单进度头图/搜索筛选排序/快捷流转/台账着色+metrics 对比表/时间序/scholar 深链/汇报模式(story)+MD 导出+打印/traj_overview 并入实时进度(liveprogress)/晨报主线节数字化 | ✅ |

## 8. 风险与对策

| # | 风险 | 对策 |
|---|---|---|
| R1 | 三抽屉共存宽度外交 | 复用 `__dshDock` 协议,实测 dashboard+scholar+trajectory;失败再调 order/互斥 |
| R2 | DAG 布局乱 | 主线是显式有序数组 → 脊柱布局确定性;分支交替上下;**写入侧拒绝成环边**(DFS + 环路径报错),历史成环数据由客户端检测提示、布局 cap=节点数兜底 |
| R3 | prompt 注入 token 开销 | 摘要 ≤30 条只注 open 项;标题截断 40 字符 + 整段预算 2000 字符;空项目返回 '' |
| R4 | 模型不主动维护 | kanban 验证的双层机制(指引+会话注入);工具 description 写明触发场景 |
| R5 | progress 分母缺失 | 客户端从 log.lines 原始行解析 tqdm cur/total;series 仅兜底 |
| R6 | 文件损坏 | 原子写 + 写锁 + 随机 tmp;坏文件隔离 `<file>.bad`;已删项目在途写丢弃 |
| R7 | 跨插件 refs 失效 | refs 存 id+label,展示容错(不校验存在性,失败显示原始 id) |
