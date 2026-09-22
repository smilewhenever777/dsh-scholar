# Changelog · dsh-trajectory 研究主线图

## 0.3.0 (2026-09-22)

- 完整节点草稿保护覆盖关联字段、父节点和主线状态，支持会话内按项目及节点恢复。
- 节点与主线一次原子落盘，失败不污染内存状态。
- 关联论文、Idea 和服务器支持名称搜索及缓存预览；进度匹配歧义时不擅自选择。
- 完善弹窗键盘焦点、窄屏交互和打包前客户端类型检查。

## v0.2.0 — 2026-09-18 · 梳理视图 + 组会输出 + 动效层

> 从"未来计划看板"进化为"研究项目现状梳理台"——清单页是主战场,
> 台账数字成为可计算资产,组会输出一键直达。

### 功能(核心)

- **清单页 = 项目梳理视图(默认)**:研究问题卡(带主线进度头图 X/Y·% + 状态分布
  堆叠条 + 绑定体检"实验 a/b 在跑")→ 主线里程碑垂直时间线(编号圆点/spring 弹入/
  完成绿波纹)→ 每节点实验台账(日期·做了什么·数据·结论)→ 分支工作 → 弱化待办
- **实验台账(TrajEntry)**:AI 干完实验/得出结论时 `traj_entry_add` 记录;
  自由文本 `+1.34pp`/`-2.31pp` 自动绿红着色;**结构化指标 metrics**
  `{name,value,baseline?,unit?}` 渲染为对比表,是可计算的数据资产
- **工作区绑定**:1 DSH 工作区 ↔ 1 研究主线;抽屉/徽标/AI 读写均跟随当前会话
  工作区;子目录最长前缀兜底;绑错可经项目设置 Modal(⚙)解绑/改绑/删除
- **组会输出三件套**:
  - 汇报页签点击直接全屏(story 视图:问题卡→时间线→节点卡→台账常开→卡点→下一步)
  - 「导出 Markdown」一键下载汇报骨架(含结构化数据与基线差值)
  - 全页模式 Ctrl+P 打印干净版(工具栏自动隐藏)
- **scholar 深链**:refs 中的论文/想法卡可点击直开学者抽屉定位
  (CustomEvent `dsh-scholar-nav` 约定)
- **实时进度并入 `traj_overview`**:AI 口头汇报可报"基线训练 269/741(36%)、无停滞"
  (host 侧 dashboard loopback 投影,缺席静默降级)
- **晨报主线节数字化**(dsh-morning 联动):活跃+最近项目逐个拉取,
  报主线完成度/最新台账数字(结构化 metrics 优先)/待推进节点

### Agent 工具集(10 个)

| 工具 | 说明 |
|---|---|
| `traj_overview` | 当前工作区项目全景(主线+分支+边+计数+**绑定实验实时进度**);更新前先调 |
| `traj_project_set` | 为当前工作区创建并绑定主线;`rebindProjectId` 改绑 / `unbind` 解绑 |
| `traj_project_delete` | 删除项目(需显式 `confirm: true`) |
| `traj_node_add` | 登记节点;parentIds 自动建 enables 边;mainline=true 追加主线尾 |
| `traj_node_update` | 推进状态/写结论/绑实验;ref 字段传空串清除 |
| `traj_node_remove` | 删除节点(级联清边+主线) |
| `traj_link_add` / `traj_link_remove` | 推进边增删(enables/feeds/composes) |
| `traj_mainline_set` | 重排创新主线(有序节点 id 数组) |
| `traj_entry_add` | **记实验台账**:title + data(自由文本)/ **metrics**(结构化指标) + conclusion + date |

### UI / 动效(Material 3 范式,零依赖纯 CSS)

- **动效令牌系统**:140/220/320ms 三档 + standard/spring 缓动;全部包裹
  `prefers-reduced-motion: no-preference`(系统"减少动态"一键关断)
- **清单编排**:里程碑卡片 45ms 递进滑入,圆点 spring 弹入,完成绿波纹;
  筛选/排序切换同样重放
- **画布**:节点卡 230×96(大信息卡),文字 14px 标题;依赖边带类型胶囊标签
  (验证后才能/产出喂给/汇入论文)+ 不同线型(实线/长虚线/双线);
  主线描线 draw-on(轮询刷新不重放);节点 stagger 浮现
- **微交互**:卡片 hover 上浮、快捷流转按钮滑入、chip 按压回弹、
  进度条 clip-path 展开、% 数字渐升(CountUp)
- **台账展开**:grid 0fr→1fr 纯 CSS 高度动画
- **容器**:抽屉滑入(220ms)、全页 scale+fade、Tab crossfade
- **骨架屏**:shimmer 微光替代加载文字
- **弹窗不透明底**:半透明皮肤(blue-fantasy)下所有 Modal 垫不透明底

### 工程保障

- Host:写锁串行化 + 随机 tmp 后缀原子写 + 损坏文件 `.bad` 隔离 + 防复活
- API:CSRF 防护(强制 application/json)+ 1MB body 上限 + 键白名单(原型污染防护)
- 空 patch PUT 不落盘(防 updatedAt 搅动);`traj_overview` 无绑定时跳过 loopback
- Smoke 测试 54 项断言(CRUD/边校验/主线归一化/级联/绑定冲突/metrics/liveprogress)
- 两轮代码审计(安全面/数据完整性/API 边缘用例/性能),全部通过

### 数据

- 默认 `$DSH_HOME/trajectory/projects/<id>.json`(原子写)
- `TrajMetric {name, value, baseline?, unit?}` 结构化指标(向后兼容,自由文本并存)
- 18 条历史台账已回填结构化指标

---

## 0.1.2 (2026-09-16)

- 侧栏「汇报」按钮点击直接进入全屏汇报模式
- 图视图视觉大修:节点卡放大 + 文字升级 + 边加粗 + 间距收紧 + fitView 范围调整
- 边类型胶囊标签 + 不同线型 + 脊柱「主线」标注
- 修复:CSS 动画 transform 覆盖 SVG 节点定位(双层 `<g>` 包裹)

## 0.1.1 (2026-09-15)

- 汇报模式对齐清单视觉语言(复用 DigestNode/EntryRow present 变体)
- 台账数据可视化:差值着色 + 结构化指标 metrics 对比表
- scholar 深链(refs 可点击直开论文/卡片)
- `traj_overview` 并入实时进度(liveprogress.ts)
- 打印视图(@media print)
- 晨报主线节数字化

## 0.1.0 (2026-09-11)

首发版本:按工作区 1:1 绑定的研究项目 DAG,主线关键路径+实验台账+实时训练进度联动;10 个 agent 工具主动维护。
