# 技术设计：DSH 学者工作台插件（dsh-scholar）

> 版本 v1.0 · 2026-08-16 · 基于 dsh-server-dashboard 已验证的 host+client 架构

## 1. 架构总览

```
┌─────────────────────── DSH Web 页面（浏览器） ───────────────────────┐
│  client 包（React，注入 slots）                                       │
│   ├─ sidebar.footer.action   📚 触发器（论文数徽标）                  │
│   ├─ shell.overlay           右抽屉：论文库 / 知识图谱 / Idea 书柜      │
│   └─ settings.section        设置页（论文目录、默认标签、统计）         │
│         │ fetch /scholar/*                                             │
└────────┴───────────────────────────────────────────────────────────────┘
         │
┌────────▼──────────────────────── DSH Host（Cordis）───────────────────┐
│  host 包：apply(ctx)                                                   │
│  ├─ inject: settings, webServer, tools                                 │
│  ├─ 设置命名空间 scholar（论文目录、默认标签）                          │
│  ├─ REST 路由 /scholar/*（papers / cards / graph / stats / config）    │
│  ├─ Agent 工具（ctx.tools.register + defineTool）                      │
│  │    paper_save / paper_search / paper_get                            │
│  │    idea_card_create / idea_card_search / idea_card_update           │
│  │    kg_extract（两阶段）/ kg_query                                   │
│  └─ 存储层 store.ts：本地 JSON 文件（论文目录）                        │
│        papers/<id>.json · cards/<id>.json · graph.json                 │
└────────────────────────────────────────────────────────────────────────┘
```

- **host 与 client 分离**（同 dsh-server-dashboard）：`tsc` 编译 host → `dist/`；
  `tsdown` 打包 client → `dist-client/` → `wrap-client.mjs` 包装成
  `window.__ModuleLoader__.load({id, factory})` 格式 → `dist/client.js`。
- **路由一律避开 `/api` 前缀**（dsh-client-connection 的 RPC 桥会吞掉）。
- **AI 能力复用对话模型**：host 侧不引入独立 LLM 调用；论文总结、Idea 卡片、
  知识图谱抽取等 AI 生成内容全部通过 Agent 工具在对话中完成——模型生成结构化
  参数 → 插件校验落盘，结果在对话里可见、可审查。这是本设计的关键决策（见 §8 R1）。

## 2. 数据模型（src/shared/types.ts）

```ts
interface Paper {
  id: string;              // arXiv id 或标题 slug+hash（也是文件名）
  title: string;
  authors: string[];
  year?: number;
  venue?: string;
  arxivId?: string;        // 去重主键之一
  doi?: string;
  url?: string;
  abstract?: string;
  summary?: string;        // AI 一句话总结
  tags: string[];
  importance?: number;     // 1–5
  pdfPath?: string;        // P2 预留
  source: 'agent' | 'manual';
  notes?: string;
  createdAt: number;
  updatedAt: number;
}

type CardCategory = 'method' | 'theory' | 'dataset' | 'evaluation' | 'engineering' | 'other';
type CardStatus = 'pending' | 'validated' | 'adopted' | 'dropped';

interface IdeaCard {
  id: string;              // c_<时间戳><随机>
  title: string;
  insight: string;         // 创新点描述
  paperId?: string;        // 来源论文
  category: CardCategory;
  tags: string[];
  importance: number;      // 1–5
  status: CardStatus;
  notes?: string;
  relatedCardIds?: string[]; // P2
  createdAt: number;
  updatedAt: number;
}

type GraphNodeKind = 'paper' | 'concept';
interface GraphNode { id: string; kind: GraphNodeKind; label: string; }
type GraphEdgeKind = 'proposes' | 'improves' | 'extends' | 'builds_on' | 'compares' | 'uses';
interface GraphEdge { source: string; target: string; kind: GraphEdgeKind; }
interface KnowledgeGraph { nodes: GraphNode[]; edges: GraphEdge[]; }
```

- 概念节点 id 规范化为 `cpt_<slug>`，**幂等**（已带 `cpt_` 前缀的保留），
  保证模型可原样引用现有概念；与论文 id 命名空间天然隔离。
- `graph.json` 保存时校验：论文节点必须真实存在、概念 id 规范化、
  边端点合法、自环丢弃、去重；节点 ≤2000、边 ≤5000 防失控。

## 3. Host 实现

### 3.1 设置与注入

```ts
export const name = 'dsh-scholar';
export const inject = ['settings', 'webServer', 'tools'];
```

- `settingsNamespace('scholar')` + schemastery：`{ paperDir, defaultTags }`
- `paperDir` 默认值：`path.join(os.homedir(), 'Documents', 'ResearchPapers')`
- 存储单例懒加载并随目录变化重建（`getStore()` 缓存 + 目录比对）

### 3.2 存储层（store.ts）

- `PaperStore(dir)`：内存 Map 缓存 + JSON 落盘；启动全量扫描加载。
- 原子写（tmp + rename）；损坏文件跳过并告警。
- 纯函数（可单测）：`filterPapers / filterCards / mergeGraph / conceptSubgraph /
  conceptId / paperIdFor / allPaperTags` 等。

### 3.3 REST 路由（/scholar/*，见 README 路由表）

| 路由 | 方法 | 说明 |
|---|---|---|
| `/scholar/papers` | GET / POST | 列表（q/tag/yearFrom/yearTo/importance/sort + 全量 tags）/ 新建（去重） |
| `/scholar/papers/:id` | GET / PUT / DELETE | 详情 / 全量更新 / 删除（同步清理图谱） |
| `/scholar/cards` | GET / POST | 列表（组合筛选 + 全量 tags）/ 新建 |
| `/scholar/cards/:id` | GET / PUT / DELETE | 详情 / 更新 / 删除 |
| `/scholar/graph` | GET / PUT | 图谱读取 / 覆盖（经 mergeGraph 校验） |
| `/scholar/stats` | GET | 论文/卡片/节点/边计数 + 目录 |
| `/scholar/config` | GET / PUT | 设置读写 |

- `kind: 'prefix'` 路由自行解析 `:id`；POST/PUT 强制 application/json（CSRF 防护）；
  校验用 schemastery schema。

### 3.4 Agent 工具（tools.ts，defineTool 注册）

| 工具 | 参数要点 | 语义 |
|---|---|---|
| `paper_save` | title 必填；authors/year/venue/arxivId/doi/url/abstract/summary/tags/importance/update | 去重（arXiv/DOI/标题）；已存在且 update=false 返回提示；默认标签并入 |
| `paper_search` | q/tag/yearFrom/yearTo/importance/limit | 精简字段返回，控制 token |
| `paper_get` | id | 完整记录 |
| `idea_card_create` | title/insight 必填；paperId/category/tags/importance/status/notes | paperId 不存在则拒绝 |
| `idea_card_search` | q/category/tag/importance/status/paperId/limit | 组合筛选 |
| `idea_card_update` | id + 可更新字段 | 只合并提供的字段 |
| `kg_extract` | paperId?/mode(append\|rebuild)/nodes?/edges? | 两阶段（见下） |
| `kg_query` | concept?/paperId? | 概念 1 跳子图 / 论文邻域 / 全局热度榜 |

**kg_extract 两阶段**（host 无 LLM 通道的解法）：
1. 不带 nodes/edges 调用 → 返回目标论文元数据（id/标题/作者/年份/venue/标签/
   总结/摘要前 400 字）+ 现有概念清单 + 现有论文清单（≤300），供模型组织抽取；
2. 模型提交 nodes/edges → 校验（论文节点必须存在、概念 id 幂等规范化、端点合法、
   去重）→ `mergeGraph`（append 合并 / rebuild 重建）→ 落盘，返回统计与丢弃明细。

### 3.5 权限与安全

- 工具只操作自身论文目录，无任意路径写；写工具结果对话内可见可审查。
- 路由与工具共用 domain/store 纯函数，行为一致。

## 4. Client 实现

### 4.1 入口（client/index.tsx）

- `inject = ['slots', 'locale']`；locales zh/en（主 zh）。
- `sidebar.footer.action`：📚 触发器 + 论文数徽标（30s 轮询 `/scholar/stats`）。
- `shell.overlay`：右抽屉（宽度拖拽、rail 折叠），三 Tab（论文库/知识图谱/Idea 书柜）。
- `settings.section`：论文目录、默认标签、库统计。
- `nav.ts`：跨视图导航总线（tab + paperId + cardId），图谱/卡片可跳转论文详情。

### 4.2 论文库（PaperLibraryView）

- 工具栏：搜索（250ms 防抖）+ 标签/重要度/年份范围筛选 + 排序 + 添加按钮。
- 列表项：标题、作者、年份/venue、AI 总结两行、标签 chips、⭐。
- 详情视图：全字段、⭐ 快捷调整、编辑/删除、关联卡片列表（点击跳书柜并打开卡片）。
- 表单：全字段（作者/标签逗号分隔输入），新建时预填默认标签。

### 4.3 Idea 书柜（BookshelfView）

- 筛选器组：分类/状态/重要度/标签/关键词 + 排序 + 卡片墙/列表切换。
- 卡片：分类徽章（按类着色）、标题、insight 摘要、状态色点、⭐、来源论文标记。
- 详情模态：完整内容、状态流转按钮、编辑/删除、"查看论文"跳转。
- 新建模态：来源论文下拉（论文库全量）。

### 4.4 知识图谱（GraphView）

- 自绘 SVG 力导向图（无第三方依赖，~330 行）：
  - 库仑斥力 + 边弹簧 + 分列引力（论文左列、概念右列），≤350 节点 260 次迭代，
    更大规模降迭代；
  - 节点拖拽、滚轮缩放（0.25–3×）、空白拖拽平移；
  - 论文节点=圆角矩形、概念节点=圆点，边按关系类型着色；
  - 点选 → 右上信息卡（关系列表；论文节点提供"查看论文"跳转）；
  - 概念过滤输入 → 1 跳子图；图例悬浮左下角。
- 空态提示引导用户在对话中让 AI 执行 kg_extract。

### 4.5 样式与交互

- 全部沿用 DSH 设计变量 `var(--dsw-alias-*)` / `--dsw-shadow-*`，无第三方 UI 库；
  图标自绘 SVG（ui.tsx）。

## 5. 目录结构

```
dsh-scholar/
  package.json / cordis.patch.yml / tsconfig.json / tsdown.config.ts
  scripts/wrap-client.mjs / smoke-test.mjs
  src/
    index.ts              host 入口（settings + 路由装配 + 工具注册）
    store.ts              本地 JSON 存储 + 筛选/图谱合并纯函数
    domain.ts             论文/卡片创建与补丁合并语义
    routes.ts             /scholar/* 路由（schemastery 校验）
    tools.ts              8 个 Agent 工具（defineTool）
    shared/types.ts       数据模型
    client/               index.tsx / nav.ts / api.ts / ui.tsx / locales.ts
                          PaperLibraryView / BookshelfView / GraphView / SettingsSection
```

## 6. 构建与安装

```sh
npm install --legacy-peer-deps   # 需要 HTTPS_PROXY；npm cache 用工作区 .npm-cache
npm run build                    # tsc + tsdown + wrap-client
npm run smoke                    # 存储层冒烟（临时目录，27 项断言）
dsh plugin --profile web add ./dsh-scholar   # 安装进 web profile（需 pnpm shim 在 PATH）
```

- host 更新需完全重启桌面端/`dsh web`；client 更新刷新页面即生效。
- 注意：勿用 PowerShell `-replace`+`Set-Content` 改写 UTF-8 源文件（GBK 误读会损坏中文），
  一律用 UTF-8 无 BOM 写入。

## 7. 里程碑

| 里程碑 | 内容 | 状态 |
|---|---|---|
| M1 骨架 | 包结构 + 构建链 + 安装进 web profile | ✅ |
| M2 论文库 | store + 路由 + paper_save/search/get 工具 + 列表/详情/编辑 UI | ✅ |
| M3 Idea 书柜 | 卡片 CRUD + 筛选 UI + card 工具 | ✅ |
| M4 知识图谱 | kg_extract/kg_query + graph.json + SVG 力导向可视化 | ✅ |
| M5 打磨 | 设置页、徽标轮询、locales、README、冒烟脚本 | ✅ |

## 8. 风险与对策

| # | 风险 | 对策 |
|---|---|---|
| R1 | host 侧无 LLM 通道，"AI 总结/图谱抽取"怎么做 | 全部通过 Agent 工具由对话模型完成（模型生成结构化参数 → 插件校验落盘）；kg_extract 两阶段解决"模型需先看到库内容"的问题；对话内可见可审查 |
| R2 | 力导向图性能/依赖 | 自绘 SVG + 轻量力模拟，≤500 节点流畅；不引第三方图库 |
| R3 | 客户端 UI 无组件库 | 沿用 --dsw-alias-* 设计变量与自绘图标 |
| R4 | 目录切换导致数据"丢失"感 | 设置页明示当前目录与统计；文档说明搬迁方法 |
| R5 | 工具被模型误用（全库 rebuild） | kg_extract 默认 append；rebuild 需显式参数且对话内可见 |
| R6 | 文件损坏（断电中断写） | 原子写（tmp+rename）；启动加载容错（坏文件跳过并告警） |
| R7 | 概念 id 引用断裂 | conceptId 幂等规范化（cpt_ 前缀保留），模型可原样引用 |
