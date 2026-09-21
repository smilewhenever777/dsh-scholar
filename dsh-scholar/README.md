# dsh-scholar（学者工作台）

DSH Web 插件：辅助科研读论文。

- **论文库**：对话中 AI 看过的重点论文可一键保存到本地论文目录（JSON 文件），
  支持搜索/筛选/详情/编辑/去重。
- **知识图谱**：让 AI 从论文库抽取概念与关系（提出/改进/扩展/基于/对比/使用），
  侧边栏以 SVG 力导向图可视化，按概念过滤。
- **Idea 书柜**：把论文创新点存为 Idea 卡片（分类/标签/重要度/状态），
  多维筛选查阅，随时调用。

数据流说明:论文条目/卡片/图谱/精读会话保存在本地论文目录;精读与追问将论文内容(以及你填写的关注重点)发送给宿主配置的 LLM——provider 是本地还是云端由宿主设置决定;抽图生成宿主附件并送入多模态模型;元数据补全/相关论文/引用同步会访问 arXiv、Crossref、OpenAlex(可配置 openalexEmail 进入 polite pool)。不使用任何独立遥测。

> 面板停靠在**最右侧**，与内侧的服务器看板可同时并排打开（外层面板宽度变化时内层自动让位）；
> 侧边栏两个入口按钮同规格样式、固定排序（服务器在前、学者在后）。

- 需求规格：[REQUIREMENTS.md](./REQUIREMENTS.md)
- 技术设计：[DESIGN.md](./DESIGN.md)

## 功能

- **论文库**
  - AI 保存：对话中说"把这篇论文保存到论文库"，AI 调用 `paper_save` 工具入库
    （自动去重：arXiv ID / DOI / 标题；支持 `collections` 分区名，不存在自动创建）
  - **收集分区**（Zotero 式多重归属）：新建/改名/删除/配色；论文可同属多个分区，
    删除分区不删论文；`paper_update` 让对话中 AI 也能改归属
  - **链接自动填充**：添加表单粘贴 arXiv 链接/编号或 DOI → 自动拉取标题/作者/年份/
    venue/摘要并填入（走官方 arXiv API 与 CrossRef，出网代理可在设置页配置）
  - **PDF 附件**：论文详情页可上传本地 PDF 归档至 `attachments/<id>.pdf`
    （≤50MB，原子写），元数据仍以表单/对话为准
  - 手动添加/编辑/删除；搜索（标题/作者/摘要/标签）、标签/年份/重要度/分区筛选、多种排序
  - 详情页展示 AI 总结、摘要、关联 Idea 卡片
- **Idea 书柜**
  - AI 建档：对话中说"把这篇的创新点记成 idea 卡片"，AI 调用 `idea_card_create`
  - 卡片字段：标题、创新点、来源论文、6 类分类、标签、⭐1-5、4 种状态
    （待验证/已验证/已采用/已搁置）、**卡片间关联**（删除自动剥离）
  - 论文详情页一键**「记一张卡片」**（来源预填，阅读流内随手捕获）
  - 卡片可**复制为 Markdown**（贴进笔记/本子/共享）；**随机回顾**按钮
    （跳过已搁置，从当前列表随机抽一张）、**卡片间关联**（删除自动剥离）
  - 论文详情页一键**「记一张卡片」**（来源预填，随手捕获不离开阅读流）
  - 卡片详情可**复制为 Markdown**（贴进笔记/本子/共享）；**随机回顾**按钮
    （跳过 dropped，从当前列表随机抽一张激活灵感）
  - 卡片墙/列表双视图，分类/标签/重要度/状态/来源论文/关键词组合筛选
- **知识图谱**
  - AI 抽取：对话中让 AI 执行 `kg_extract`（两阶段：准备 → 提交 nodes/edges）
  - 节点 = 论文 + 概念（方法/任务/数据集/指标），6 种关系边
  - SVG 力导向图（Obsidian 式交互）：拖拽牵引邻居、缩放/平移、悬停/点选高亮并淡化
    其余、节点大小随连接度、有向箭头、标签随缩放淡出、一键适配视图、
    概念聚焦可调 1/2 跳、关系图例与节点信息卡
- **设置**：论文目录路径（默认 `~/Documents/ResearchPapers`）、新建论文默认标签

## AI 工具集（共 11 个）

| 工具 | 说明 |
|---|---|
| `paper_save` | 保存/更新论文（arXiv id 自动归一去重、可合并更新、可指定收集分区；带 arxivId 自动下载 PDF） |
| `paper_fetch_pdf` | 为已入库论文下载并归档 PDF（arXiv；关键词多命中时返回候选列表要求精确 id） |
| `paper_save_report` | 归档 deepread 精读报告 HTML 到论文库（多命中同样返回候选列表） |
| `paper_search` / `paper_get` | 检索（标题/作者/摘要/标签/DOI）/ 读取论文 |
| `paper_update` | 更新已有论文（元数据/标签/重要度/收集分区等，只更新提供的字段） |
| `idea_card_create` / `idea_card_search` / `idea_card_update` | Idea 卡片建档（可关联已有卡片，未知关联 id 会以 droppedRelatedIds 回传）/ 检索 / 更新（含关联整体替换） |
| `kg_extract` | 知识图谱抽取（两阶段：准备 → 提交）。准备阶段全库调用只返回 unsynced 清单（≤100）+ 全库计数，单篇（paperId）才返回完整元数据；现有概念按度数截断 top 200。rebuild 有缩减保护（详见下） |
| `kg_query` | 图谱查询（某概念的关联论文、某论文的关系、概念热度） |

所有工具声明了会话卡片呈现（presentCall/presentResult）：支持卡片渲染的 DSH 版本会在对话中显示结构化结果卡，旧版自动回退为文本。

### 数据保护语义（写路径）

- **部分更新**：REST `PUT /scholar/papers/:id`、`PUT /scholar/cards/:id` 与 `POST /scholar/papers` 的
  dup+update 分支均为**部分更新语义**——只修改请求体里实际提交的字段，未提交字段
  （如 AI 精读 summary、tags）保持不变；要清空某字段请显式提交空值（`""` / `[]`）。
- **写互斥**：存储层所有写操作走实例级互斥链 + 随机后缀临时文件原子写，
  对话工具与 REST 面板并发写不会互相覆盖或产生撕裂文件。
- **rebuild 保护**：`kg_extract` 与 `PUT /scholar/graph` 在 mode=rebuild 时，
  若现有图谱规模（节点+边）> 20 而提交总量不足现有的 50%，会被拒绝
  （防止模型幻觉一次性清空图谱）；确认缩减重建需 `force=true`，
  执行前旧图谱自动备份为 `graph.json.bak`（保留一代）。
- **存储目录热切换**：设置页切换论文目录后，旧 store 立即失效，
  在途请求的写操作显式报错"存储目录已切换，请重试"，不会写旧目录。
- **级联清理**：删除论文会同步清理图谱节点/边、卡片关联、PDF 附件与精读报告文件；
  损坏 JSON 文件在启动时跳过并通过 `/scholar/stats` 的 `corruptFiles` 暴露。

## 构建 / 安装

```sh
npm install          # 需要 HTTPS_PROXY 可用
npm run build        # tsc（宿主）+ tsdown（客户端）+ 包装器
npm run smoke        # 存储层冒烟测试（临时目录）
# 安装进 web profile（父目录执行）：
dsh plugin --profile web add ./dsh-scholar
# 或手动：profiles/web/package.json 加 link 依赖 + dsh.profile.bundles 加包名，pnpm install
```

- 宿主侧代码更新需完全重启桌面端/`dsh web`；客户端 UI 刷新页面即生效

## 路由

| 路由 | 方法 | 说明 |
|---|---|---|
| `/scholar/fetch` | GET | 元数据抓取（input = arXiv 链接/编号或 DOI，走设置页代理） |
| `/scholar/collections` | GET / POST | 分区列表（按创建序）/ 新建（同名大小写不敏感去重） |
| `/scholar/collections/:id` | PUT / DELETE | 改名/配色 / 删除（仅解除归属，不删论文） |
| `/scholar/papers` | GET / POST | 列表（q/tag/yearFrom/yearTo/importance/collection/sort + 可选 limit/offset 分页，默认全量）/ 新建（dup+update 分支为部分更新语义） |
| `/scholar/papers/:id` | GET / PUT / DELETE | 详情 / **部分更新**（只改提交字段，未提交字段保持不变）/ 删除（级联清理附件与报告） |
| `/scholar/papers/:id/pdf` | GET / PUT | PDF 附件读取 / 上传替换（octet-stream ≤50MB，校验 `%PDF` 魔数） |
| `/scholar/papers/:id/reports` | GET | 精读报告列表（deepread 产物归档） |
| `/scholar/papers/:id/reports/:file` | GET | 精读报告 html 读取（带 `Content-Security-Policy: sandbox` + `nosniff`，脚本被禁用的沙箱内在线阅读） |
| `/scholar/cards` | GET / POST | 列表（q/category/tag/importance/status/paperId/sort）/ 新建 |
| `/scholar/cards/:id` | GET / PUT / DELETE | 详情 / **部分更新** / 删除 |
| `/scholar/graph` | GET / PUT | 图谱读取 / 合并或整体覆盖（含校验；mode=rebuild 有缩减保护，可带 force 确认；rebuild 前自动备份 graph.json.bak） |
| `/scholar/stats` | GET | 统计（论文/卡片/图谱规模 + unsynced 未入图清单 + corruptFiles 损坏文件清单） |
| `/scholar/config` | GET / PUT | 设置读写 |

## 目录结构

```
src/
  index.ts             Cordis 宿主插件（settings + 路由装配 + 工具注册）
  store.ts             本地 JSON 存储（论文/卡片/图谱，写互斥 + 原子写）
  domain.ts            创建/合并语义（纯函数；arXiv id 归一）
  routes.ts            /scholar/* 路由（schemastery 校验；PUT 为部分更新语义）
  metadata.ts          arXiv/CrossRef 元数据抓取（CONNECT 代理适配：超时/认证/重定向/大小上限）
  tools.ts             11 个 Agent 工具（defineTool）
  shared/types.ts      数据模型
  client/              React 客户端（抽屉 + 三个视图 + 设置页）
scripts/               wrap-client.mjs / smoke-test.mjs
```

## 已知限制

- 精读报告 HTML 由 LLM 生成后原样落盘，host 读取路由以 `Content-Security-Policy: sandbox`
  + `nosniff` 头返回（浏览器在无脚本沙箱中打开）；如需彻底净化需要引入服务端白名单净化器
- `collections=[]` 显式传空数组即清空全部归属（部分更新语义下的文档化行为）
- 出网抓取仅支持 https 数据源；代理路径手动跟随 3xx 重定向（≤5 跳），响应体上限 5MB（文本）/ 50MB（PDF）
- 图谱容量上限 2000 节点 / 5000 边，超出截断并在工具返回中带 truncatedNodes/truncatedEdges
- kg_extract 全库准备阶段只返回 unsynced（≤100）与全库计数，单篇抽取需指定 paperId

## 安装(npm 发布版)

```sh
dsh plugin --profile web add dsh-scholar-desk
# 然后完全重启 dsh web
```

- 自定义路由(`/dash/*` `/scholar/*` `/traj/*` `/statusbar/*`)仅接受本机(loopback)访问;
  若以 `--host 0.0.0.0` 对局域网开放 Web UI,插件路由也不会暴露给远程。
- 从源码 link 安装(开发):路径含空格时 `dsh plugin add` 会写坏 profile,请按仓库内文档手工修 link。

## Changelog

见 [CHANGELOG.md](./CHANGELOG.md)。
