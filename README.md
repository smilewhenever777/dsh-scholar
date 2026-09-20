# DSH 自研插件集

[DeepSeek Harness (DSH)](https://www.npmjs.com/package/@deepseek-ai/dsh) 的三个自研插件，统一仓库（monorepo），每插件一个子目录、独立 npm 包。

| 插件 | 子目录 | npm 包 | 一句话 |
|---|---|---|---|
| 📚 学者工作台 | [`dsh-scholar/`](./dsh-scholar) | [`dsh-scholar-desk`](https://www.npmjs.com/package/dsh-scholar-desk) | 文献库 + 论文精读 + 知识图谱 + Idea 卡片（引用同步/看板视图/实验计划） |
| 🖥️ 服务器看板 | [`dsh-server-dashboard/`](./dsh-server-dashboard) | [`dsh-server-dashboard`](https://www.npmjs.com/package/dsh-server-dashboard) | SSH 舰队 GPU 监控（自动轮询/降级帧/右侧栏 GPU 页签） |
| 🧭 研究主线图 | [`dsh-trajectory/`](./dsh-trajectory) | [`dsh-trajectory`](https://www.npmjs.com/package/dsh-trajectory) | 研究主线 DAG + 实验台账 + 训练进度跟随 |

## 安装

要求 DSH ≥ 0.1.5-rc.2：

```sh
dsh plugin add dsh-scholar-desk        # 学者工作台
dsh plugin add dsh-server-dashboard    # 服务器看板（npm 重发中，可先用源码安装）
dsh plugin add dsh-trajectory          # 研究主线图（npm 重发中，可先用源码安装）
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
