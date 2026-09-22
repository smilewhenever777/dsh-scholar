# 📚 学者工作台 · dsh-scholar-desk

DSH Web 中的论文阅读与知识整理工作台。把论文、PDF、阅读报告、问答、Idea 和知识图谱保存在一起，减少在文献管理器、对话窗口和零散笔记之间切换。

可独立使用；与研究主线图配合时，论文和 Idea 可关联到实验节点。面板支持停靠、展开和浮动。

## 论文库

- 手动添加，或让 AI 调用 `paper_save` 保存论文；根据 arXiv ID、DOI 和标题识别重复条目。
- 在添加表单粘贴 arXiv 链接、编号或 DOI，补全标题、作者、年份、会议/期刊和摘要。
- 上传本地 PDF，或为带 arXiv ID 的论文下载附件；单个上传文件上限 50MB。
- **分区栏默认在左侧，论文列表在右侧**；窄面板保持左右布局，可手动收起分区栏，长列表独立滚动。
- 一篇论文可属于多个分区，删除分区仅解除归属；支持保存筛选、最近浏览、阅读状态和 1–5 星重要度。
- 按关键词、标签、年份、重要度、阅读状态和分区筛选，支持排序与 BibTeX 导出。
- 详情页展示摘要、AI 总结、备注、报告和关联卡片，可复制 GB/T 7714、APA、BibTeX 引用。

## 精读、追问与多篇对比

内置阅读管线按章节提取论点、证据、实验数据和出处，再综合成 HTML 报告。可选择论文精读、轻量综合或速读；综合失败时尝试降级并标注实际方式。模型不可用或输入无法解析时，仍可能失败。

报告整理主要结论、知识地图、方法与论点、实验、图表、概念、摘录、局限和回忆问题。多模态模型可分析提取的图像；纯文本模型或关闭图像分析时采用文本流程。

阅读完成后，可基于保存的章节片段继续追问。问答记录随会话保存，重读保留已有问答；多篇阅读或基于归档结果的对比可用于梳理共识、分歧和阅读顺序。

模型生成的引用、页码和结论仍需对照原文核实。当前 PDF 提取不是 OCR 服务，扫描版、加密文件和复杂排版可能无法完整解析；解析器设置了大小、处理量和时间预算，超限会中止。

## Idea 书柜与知识图谱

Idea 卡片记录创新点、来源论文、分类、标签、重要度、证据、备注和验证状态。支持**分组、看板、表格、网格、列表五种视图**，以及卡片关联、Markdown 导出、随机回顾、研究方向组合和实验计划交付。

图谱包含论文、概念和 Idea 三类节点，以及 `proposes`、`improves`、`extends`、`builds_on`、`compares`、`uses`、`cites`、`derives_from`、`related` 九种关系。支持标签同步、模型辅助抽取、OpenAlex 引用同步，以及拖拽、缩放、搜索、聚焦和关系过滤。

图谱上限为 2000 个节点、5000 条边，超出时返回截断信息。模型辅助抽取不等于已证实论文之间的科学关系。

## 开始使用

1. 安装后完整重启 DSH，在设置中确认论文目录。
2. 添加论文并上传或下载 PDF。
3. 选择精读方式和关注重点，完成后查看报告或继续追问。
4. 将值得验证的想法记录为 Idea 卡片，按需要关联研究主线。

对话示例：

> 把这篇论文保存到论文库，加入“待阅读”分区。
>
> 精读这篇论文，重点检查方法假设、消融实验和失败情况。
>
> 把报告中值得验证的想法记成卡片，写明证据和来源论文。

界面向宿主输入框交付内容时会保留已有草稿和附件；无法确认唯一目标时采用剪贴板反馈。填入内容不会自动点击发送。

## 安装与更新

[GitHub Release v0.3.0](https://github.com/smilewhenever777/dsh-scholar/releases/tag/v0.3.0) 提供预构建包和校验文件。GitHub 发布与 npm 发布相互独立；本次没有发布 npm 版本。使用源码安装时可先在仓库根目录执行 `git checkout v0.3.0` 固定版本。

npm 已发布版本：

```sh
dsh plugin --profile web add dsh-scholar-desk
```

当前源码安装，在仓库根目录执行：

```sh
npm ci --prefix dsh-scholar
npm run build --prefix dsh-scholar
dsh plugin --profile web add ./dsh-scholar
```

安装、升级后完整重启宿主并重新加载页面。部分 DSH 版本无法正确注册含空格的本地路径，优先使用无空格路径；若链接损坏，可校正 profile 的 `package.json` 中 `dsh-scholar-desk` 的 `link:` 路径及 `dsh.profile.bundles`，再在 profile 目录运行 `pnpm install`。链接路径使用正斜杠。

源码更新不会自动发布到 npm，当前改动见 [更新记录](./CHANGELOG.md)。

## 配置、存储与隐私

| 设置 | 用途 |
|---|---|
| `paperDir` | 本地存储根目录，默认 `~/Documents/ResearchPapers` |
| `defaultTags` | 新建论文的默认标签 |
| `fetchProxy` | 元数据和 PDF 抓取的代理 |
| `openalexEmail` | 可选的 OpenAlex 请求标识 |
| `researchFocus` | 阅读关注点和宿主对话上下文中的研究方向 |
| `vlmFigures` | 自动尝试图像分析或关闭 |

条目、卡片、分区、图谱、附件、报告和精读会话保存在所选目录的 JSON / PDF / HTML 文件中。元数据、相关论文和引用同步访问 arXiv、Crossref、OpenAlex；精读、追问和图像分析将内容交给宿主模型，是否访问云端由 provider 决定。插件没有独立遥测。

`/scholar/*` 路由限制本机访问并校验来源。内置报告将结构化内容转义后渲染；`paper_save_report` 也可归档外部 HTML。在线读取使用 CSP 沙箱及 `nosniff`，外部 HTML 下载后直接打开不再受这些响应头保护。

## 编辑与数据保护

- 更新只修改实际提交的字段，未提交的摘要、标签等保持不变；显式空字符串或空数组用于清空。
- 快捷评分和阅读状态按同一论文串行写入，迟到响应不会切换当前论文。
- 后台刷新和关联卡片重试保留问答草稿；卡片保存失败显示错误，不播放成功反馈。
- 写操作使用实例内互斥和临时文件替换。切换存储目录后，在途旧目录写入报错，需要重新操作。
- 删除论文级联处理附件、阅读产物和相关引用；重要目录建议自行备份。
- 大幅缩减图谱的 rebuild 需显式确认，重建前保留一代 `graph.json.bak`。

## 对话工具（13 个）

| 工具 | 作用 |
|---|---|
| `paper_save` | 保存论文、合并更新及分区归属 |
| `paper_fetch_pdf` | 下载已有论文的 arXiv PDF |
| `paper_save_report` | 归档外部阅读报告 HTML |
| `paper_update` | 部分更新论文 |
| `paper_search` / `paper_get` | 检索 / 读取详情 |
| `paper_read` / `paper_ask` | 阅读本地论文或报告 / 基于已保存会话追问 |
| `idea_card_create` / `idea_card_search` / `idea_card_update` | 新建、检索和更新 Idea |
| `kg_extract` / `kg_query` | 准备和提交关系 / 查询图谱 |

## 开发接口

| 路由 | 作用 |
|---|---|
| `/scholar/config`、`/scholar/stats` | 设置和统计 |
| `/scholar/fetch` | arXiv / DOI 元数据 |
| `/scholar/collections` 及 `/:id` | 分区管理 |
| `/scholar/papers` 及 `/:id` | 列表、创建、部分更新、删除 |
| `/scholar/papers/:id/pdf` | PDF 读取与上传 |
| `/scholar/papers/:id/reports` 及 `/:file` | 报告列表、读取与删除 |
| `/scholar/papers/:id/related` | 相关论文 |
| `/scholar/cards` 及 `/:id` | Idea 管理 |
| `/scholar/graph`、`/scholar/graph/auto-sync`、`/scholar/graph/cite-sync` | 图谱及同步 |
| `/scholar/read/run`、`/scholar/read/compare`、`/scholar/read/status`、`/scholar/read/cancel` | 阅读、对比及任务状态 |
| `/scholar/read/ask`、`/scholar/read/session`、`/scholar/read/vlm-test` | 追问、会话与图像能力检查 |

列表接口支持筛选及可选分页，论文库默认使用全量结果。实现见 `src/routes.ts`；精读位于 `src/read/`，存储位于 `src/store.ts`。

## 验证与许可证

插件目录可运行 `npm run build`、`npm run smoke`。`npm pack` 会先构建；跨插件验证见 [测试说明](../tests/README.md)。

[技术设计](./DESIGN.md) · [更新记录](./CHANGELOG.md) · [MIT 许可证](./LICENSE)
