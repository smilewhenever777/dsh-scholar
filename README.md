# DSH 自研插件集

[DeepSeek Harness (DSH)](https://www.npmjs.com/package/@deepseek-ai/dsh) 的三个自研插件，统一仓库（monorepo），每插件一个子目录、独立 npm 包，MIT 协议。

| 插件 | 子目录 | npm 包 | 一句话 |
|---|---|---|---|
| 📚 学者工作台 | [`dsh-scholar/`](./dsh-scholar) | [`dsh-scholar-desk`](https://www.npmjs.com/package/dsh-scholar-desk) | 文献库 + 自有精读引擎 + 交互式追问 + 知识图谱 + Idea 卡片 |
| 🖥️ 服务器看板 | [`dsh-server-dashboard/`](./dsh-server-dashboard) | [`dsh-server-dashboard`](https://www.npmjs.com/package/dsh-server-dashboard) | SSH 舰队 GPU 监控（自动轮询 / 降级帧 / 右侧栏 GPU 页签） |
| 🧭 研究主线图 | [`dsh-trajectory/`](./dsh-trajectory) | [`dsh-trajectory`](https://www.npmjs.com/package/dsh-trajectory) | 研究主线 DAG + 实验台账 + 训练进度跟随 |

---

## 📚 学者工作台（dsh-scholar-desk）

科研读论文的一站式工作台：**从"存论文"到"读透论文"到"沉淀想法"的完整闭环**。数据全部本地 JSON 文件，零云依赖。

### 论文库

- **一键入库**：对话中让 AI 保存论文（自动抓取 arXiv / DOI 元数据、自动下载 PDF），或手动添加
- **书目正规化**：GB/T 7714、APA 7、BibTeX 三格式引用一键复制；会议/期刊 CCF 分级徽章；arXiv / DOI 等宽可点链接
- **管理**：阅读状态（想读/在读/读过）、星级、收集分区（多重归属）、保存的筛选、浏览足迹 + 键盘导航、BibTeX 全库导出
- **相关论文发现**：OpenAlex 相似/被引/引用三路，一键入库，引用关系可同步进图谱

### 自有精读引擎（无第三方依赖）

- **学术论文专用管线**：章节感知分段 → 逐段提取（论点/证据/原文引用/页码溯源）→ 全文综合
- **三挡火力**：学术深读（全文综合，最高质量）/ 轻量深读（摘要综合，快）/ 速读（筛文献）
- **四级综合降级链**：全文 → 分半双次 → 摘要 → 分段拼装——API 波动时保证出报告，报告页脚标注实际档位
- **稳定性工程**：推理档位控制（防空结果）、自适应分段并发（过载自动降串行）、段级容错（缺口标注继续跑）
- **九节报告**：一页速览 / 知识地图（嵌套思维导图）/ 方法与论点（四档置信度 + 原文引用）/ 实验还原 / 图表清单 / 概念地图 / 原文摘录 / 局限 / 回忆问题；明暗自适应、模式徽标、可删除重读
- **VLM 读图管线**：多模态模型时自动解读论文图表（纯文本模型自动跳过）

### 交互式追问（像人一样"带着问题反复翻"）

- 精读后可对论文**任意提问**：基于保存的章节块定向检索，回答带页码出处 + 置信度标签 + "片段不足"诚实提示
- 问答记录持久化，重读保留

### 多篇横向对比

- 批量深读后**自动生成对比报告**：维度对比表 / 共识 / 分歧与判据 / 可迁移机会 / 读序建议
- **直接对比已有成果**：用归档的精读产物（sidecar）分钟级出对比，无需重读

### 知识图谱（Obsidian 式）

- 论文/概念/Idea 三类节点，9 种语义边 + 引用边
- **修剪冗余**（隐藏叶概念/孤立节点/平行边）、**全图搜索高亮**、**分区着色**、悬停聚焦淡出、重排缓动动效
- 标签自动同步（零 AI）、AI 深度同步（含同义概念归一）、OpenAlex 引用边同步

### Idea 书柜

- 五视图：分组（按论文）/ 看板（状态流转拖拽）/ 表格 / 网格 / 列表
- 证据字段（Zettelkasten 式文献笔记）、plain 通俗解释、steps 验证流程
- 组合研究方向、生成实验计划、相似卡提醒、导出 Markdown

### 对话集成

- 13 个 agent 工具（paper_save / paper_read / paper_ask / kg_extract…），对话中说"精读/保存/建卡"即可
- 研究方向常驻注入；透镜精读在面板勾选上下文（方向 / 学术透镜 / 相关论文 / 已有卡）
- 长文自动转后台任务 + 对话内进度播报

---

## 🖥️ 服务器看板（dsh-server-dashboard）

SSH 舰队 GPU 监控：自动轮询、网络不佳降级帧、右侧栏 GPU 页签、训练任务状态。

## 🧭 研究主线图（dsh-trajectory）

研究项目可视化为分层 DAG 主线图：与 DSH 工作区 1:1 绑定，实验节点实时映射看板训练进度，清单页梳理项目现状，组会输出一键直达。

---

## 安装

要求 DSH ≥ 0.1.5-rc.2：

```sh
dsh plugin add dsh-scholar-desk        # 学者工作台
dsh plugin add dsh-server-dashboard    # 服务器看板
dsh plugin add dsh-trajectory          # 研究主线图
```

源码安装（免 npm）：

```sh
git clone https://github.com/smilewhenever777/dsh-scholar.git
cd dsh-scholar/<插件目录> && npm install && npm run build
dsh plugin --profile web add ./<插件目录>
```

## 各插件文档

每个插件的完整说明（功能、工具、路由、配置）见各自子目录的 `README.md`。

## License

MIT（每插件同权）
