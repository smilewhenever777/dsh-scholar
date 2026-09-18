# dsh-trajectory · 研究主线图

把研究项目可视化为**分层 DAG 主线图**:节点 = 里程碑/创新点/实验/论文/写作,边 = 推进关系,
**创新主线** = 图上高亮的关键路径;agent 在对话中主动维护,实验节点实时显示 dashboard 训练进度。

> 回答一个问题:**"我的研究走到哪了、卡在哪了?"**

## 按工作区绑定(v1.1)

**主线图与 DSH 工作区 1:1 绑定**——侧栏里每个工作区(RGBTfusion / RF-DETR / xiaoshuo …)
就是一项研究,各有一份独立主线:

- **抽屉跟随**:当前会话在哪个工作区,主线图就显示那一份;切工作区即切换;
- **对话落地**:所有 `traj_*` 工具按会话工作区解析(dsh-kanban 同款 `exec.agent.session.header.cwd`),
  在 RGBTfusion 里说「把计划拆成主线」,登记的就是 RGBTfusion 的主线;工作区还没有主线时自动创建并绑定
  (`traj_project_set`,name 省略用目录名);
- **ws 优先语义(防串写)**:写入类操作(REST `POST /traj/nodes`、`POST /traj/edges` 与工具的
  node_add/link_add/mainline_set)**无 `ws` 且无 `projectId` 时直接报错(REST 400)**,
  绝不静默落到全局活跃项目;读类(overview)无 ws 才回落全局活跃;
- **提示词注入**:每轮装配只注入**当前工作区**的未完成节点摘要(标题截断 40 字、整段预算 2000 字符),跨项目零串扰;
- **侧栏徽标**:当前工作区主线的未完成数;
- 会话 cwd 是工作区**子目录**时按最长路径前缀匹配兜底;绑定操作本身恒为精确匹配。

数据仍集中存于 `<DSH_HOME>/trajectory/projects/*.json`(`project.workspaceKey` 记绑定,正斜杠规范化),
不写工作区目录。

## 功能

- **清单页 = 项目梳理视图(默认主力视图)**:研究问题卡(带**主线进度头图**:完成度 X/Y·% +
  状态分布堆叠条 + 绑定体检「实验 a/b 在跑」)→ 搜索/状态筛选/主线序-时间序切换工具栏 →
  主线里程碑垂直时间线(编号圆点,已完成打勾;时间序下带日期刻度)→ 每个节点的**实验台账**
  (日期 · 做了什么 · 数据着色/结构化指标对比表 · 结论)→ 分支工作 → 底部弱化的待办 chips。
  节点卡悬停浮现快捷流转(▶进行中/✓完成);主角是「已发生的工作」,不是计划。
- **实验台账(TrajEntry)**:节点上按时间排列的已有工作记录。AI 干完实验/得出结论时用
  `traj_entry_add` 记录(data 自由文本里的 +1.34pp/-2.31pp 自动绿红着色;**metrics 结构化指标**
  `{name,value,baseline?,unit?}` 渲染为对比表,是可计算的数据资产)。
- **全页视图 + 汇报模式**:中央接管(避侧栏/右舷)看板与**汇报模式**(story)一键切换——
  组会投屏的一页式叙事(封面/研究问题/主线演变带数据/卡点/下一步);「导出 Markdown」
  生成汇报骨架;打开全页后 Ctrl+P 直接打印干净版(工具栏自动隐藏)。
- **主线图**(分层 DAG):主线节点按序排成高亮脊柱带(带阶段编号),分支上下展开;滚轮缩放/
  拖拽平移/点选高亮 1 跳/适应视图/**全页视图**(中央接管,避开侧栏与右舷面板,Esc 退出并还原抽屉形态);
  视图不随数据轮询重置(fit 只在首次加载/切换项目/手动点按时执行);
  状态筛选 chips 带计数;实验节点实时进度条;信息卡支持状态流转、主线增删、编辑、删除;
  历史成环边顶部警告提示(写入侧已拒绝新建)。
- **实验实时进度**:节点绑定 dashboard(主机 id / 日志路径 / 命令特征任一)后,打开期间
  每 8s 轮询 `/dash/snapshots` 映射进度(百分比优先取原始日志行的 tqdm `cur/total`,
  回退 series 的 epoch/progress 值;日志 10 分钟未动标记「停滞?」)。dashboard 缺席时静默降级。
- **跨插件引用(scholar 深链)**:节点可关联 scholar 的 idea 卡/论文(id + 显示名),
  清单卡与信息卡上的引用可点击 —— CustomEvent 约定(`dsh-scholar-nav`)直开学者的抽屉并定位。
- **Agent 主动维护**(dsh-kanban 验证的双层机制):系统提示词注入主线纪律 + 会话装配注入
  当前工作区未完成节点摘要;对话里说「把实验数据记到主线上」AI 会用 `traj_entry_add` 落台账。
- **多项目 · 按工作区绑定**:1 工作区 ↔ 1 主线,抽屉/徽标/对话读写均跟随当前工作区;
  侧栏图标徽标 = 当前工作区未完成数。

## AI 工具集(10 个)

| 工具 | 作用 |
|---|---|
| `traj_overview` | 读当前**工作区**项目全景(主线有序 + 分支 + 边 + 计数 + **绑定实验实时进度**,dashboard loopback 投影,缺席降级);**任何更新前先调** |
| `traj_project_set` | 为当前工作区创建并绑定主线(name 省略用目录名;`researchQuestion` 写研究问题) |
| `traj_project_delete` | 删除项目(连同节点/台账/边/主线,**不可恢复**;必须 confirm=true) |
| `traj_node_add` | 登记节点(**落到当前工作区主线**,无主线自动建);parentIds 自动建 enables 边;mainline=true 追加主线尾 |
| `traj_entry_add` | **记实验台账**:nodeId + 做了什么 + 关键数据(data 自由文本 / metrics 结构化指标,含基线差值)+ 结论 + 日期;清单页按时间展示 |
| `traj_node_update` | 推进状态/写结论/绑实验;done 应写 detail 结论;ref 字段传空串清除 |
| `traj_node_remove` | 删除节点(级联清边 + 主线) |
| `traj_link_add` / `traj_link_remove` | 推进边增删(enables 验证后才能 / feeds 产出喂给 / composes 汇入论文);**建边拒绝成环** |
| `traj_mainline_set` | 重排当前工作区主线的创新关键路径(有序节点 id 数组) |

presentCall/presentResult 为纯函数 generic 卡片(会话重放可重建)。

## 构建 / 安装

```sh
npm install --legacy-peer-deps   # npm cache 用工作区 .npm-cache
npm run build                    # tsc + tsdown + wrap-client
npm run smoke                    # 存储层冒烟(49 项断言,含环检测/ws 缺失防误写)
dsh plugin --profile web add ./dsh-trajectory   # 路径含空格时该命令会写坏 link,见下
```

- **路径含空格的安装坑**:工作区路径含空格(如 `my plugins`)时 `dsh plugin add` 会按空格截断,
  在 profile package.json 写出坏 link(还会按空格截断多出残条目)。手工修法:
  1. profile `package.json`:`"dsh-trajectory": "link:<克隆本仓库后的 .../dsh-trajectory 子目录绝对路径>"`
     (**正斜杠**,反斜杠会被 pnpm 当转义序列吞掉),删掉被截断产生的残条目,
     `dsh.profile.bundles` 追加 `"dsh-trajectory"`;
  2. profile 目录跑 `pnpm install`,确认 `node_modules/dsh-trajectory` 符号链接指向本目录。
- host 更新需完全重启桌面端/`dsh web`;client 更新刷新页面即生效。
- 插件**自带 node_modules 必须含完整 @deepseek-ai 闭包**(宿主从插件目录解析依赖,
  不会回退到 profile 的 hoisted 树):dsh-tools 运行时还会 import 未声明的
  `dsh-scope` / `dsh-session`;dsh-llm 需要 `dsh-timeout`——均已写进 devDependencies。

## 路由

| 路由 | 方法 | 说明 |
|---|---|---|
| `/traj/overview` | GET | 活跃项目 + 项目列表 + 状态计数(badge 轮询;带 `ws` 时按工作区解析) |
| `/traj/stats` | GET | 设置页统计 |
| `/traj/config` | GET / PUT | 数据目录 |
| `/traj/projects` | GET / POST | 列表 / 新建(同名 create-or-get 并激活;带 `ws` 为工作区绑定创建) |
| `/traj/projects/:id` | GET / PUT / DELETE | 全图 / 补丁(mainline 校验)/ 删除 |
| `/traj/projects/:id/active` | PUT | 设为活跃 |
| `/traj/nodes` | POST | 新建(projectId/ws 二选一必给,否则 400) |
| `/traj/nodes/:id` | PUT / DELETE | 补丁 / 删除(级联) |
| `/traj/nodes/:id/entries/:eid` | DELETE | 删除节点上一条实验台账 |
| `/traj/edges` | POST | 新建(端点校验/禁自环/禁成环/去重;projectId/ws 二选一必给) |
| `/traj/edges/:id` | DELETE | 删除 |

## 数据

默认 `<DSH_HOME>/trajectory`(未设置 `$DSH_HOME` 环境变量时为 `~/.dsh/trajectory`):
`projects/<id>.json` 每项目一文件(`{project, nodes, edges}`),`meta.json` 存活跃项目 id。
原子写(随机 tmp 后缀 + rename)且全部写入经实例级写锁串行;损坏文件隔离为 `<file>.bad`
(下次启动不再扫到);已删项目的在途写入被丢弃(防复活);上限 项目 20 / 节点 500 / 边 1500。
设置页可改目录。

## 目录结构

```
dsh-trajectory/
  package.json / cordis.patch.yml / tsconfig.json / tsdown.config.ts
  REQUIREMENTS.md / DESIGN.md / README.md
  scripts/wrap-client.mjs / smoke-test.mjs
  src/
    index.ts prompt.ts store.ts domain.ts routes.ts tools.ts shared/types.ts
    client/
      index.tsx          入口:apply-guard + 三槽 + Drawer(链式让位)
      dash.ts            dashboard 实时进度映射
      TrajGraphView.tsx  分层 DAG 主线图
      TrajListView.tsx   清单
      NodeEditor.tsx     节点/项目编辑 Modal
      SettingsSection.tsx ui.tsx api.ts nav.ts locales.ts
```

## 已知坑(装机实录,2026-08-31)

1. **locale 命名空间必须用完整插件名**:官方 shell 自带 `@deepseek-ai/dsh-client-ui-trajectory`
   (会话消息轨迹导航),裸名 `'trajectory'` 与其字典冲突(单占有主)→ 全部文案渲染成 raw key。
   本插件用 `dsh-trajectory`。dsh-kanban 用 `dsh-kanban` 同理。
2. **systemPrompt 服务名是驼峰** `systemPrompt`(dsh-web-app 自己 `ctx.inject(["systemPrompt"])`);
   kebab 的 `'system-prompt'` 会永远 pending(dsh-morning 踩过,已顺手修复)。
3. **schemastery 注册 schema**:`z.string().required()` 在首次注册的空配置上直接抛错,
   用 `.default('')` + getConfig 兜底。
4. **工具参数 DSL 不支持 `items.required`**(主线条目的 items 里不能写 required)。
5. `dsh plugin add` 对含空格路径的处理见上「构建 / 安装」。

设计细节见 [DESIGN.md](DESIGN.md),需求与验收见 [REQUIREMENTS.md](REQUIREMENTS.md)。

## 安装(npm 发布版)

```sh
dsh plugin --profile web add dsh-trajectory
# 然后完全重启 dsh web
```

- 自定义路由(`/dash/*` `/scholar/*` `/traj/*` `/statusbar/*`)仅接受本机(loopback)访问;
  若以 `--host 0.0.0.0` 对局域网开放 Web UI,插件路由也不会暴露给远程。
- 从源码 link 安装(开发):路径含空格时 `dsh plugin add` 会写坏 profile,请按仓库内文档手工修 link。

## Changelog

见 [CHANGELOG.md](./CHANGELOG.md)。
