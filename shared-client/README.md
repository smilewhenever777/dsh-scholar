# dsh-plugin-shared-client

三个科研插件共用的客户端源码。各插件的构建工具直接编译这些 TypeScript 文件，发布包中只包含编译后的 bundle，不需要为共享目录单独安装 npm 包。

- `src/index.ts` 提供 JSON 请求、查询串、浮窗几何和事件轮询。请求同时保留调用方取消信号及超时；浮窗校验有限数并避开原生标题栏。
- `src/desktop.ts` 提供官方桌面识别、目录选择、文件定位、当前会话工作区解析、非破坏对话输入，以及多个抽屉共用的布局所有权和空间协调。
- `src/PanelMenu.tsx` 提供共享的次要面板操作菜单，支持键盘导航、Esc、点击外部关闭与焦点返回；停靠面板只为原生标题栏留空间，不再累计内容工具栏高度。

- `src/Workbench.tsx` 提供共享面板标题、空状态、主题变量、卡片与表单样式，使用宿主颜色和本地资源；尊重系统减少动态效果设置。

客户端 tsconfig 的 `rootDir` 需要覆盖共享源码；React 类型通过 `paths` 指向各插件自己的开发依赖，参照三个插件的 `tsconfig.client.json`。请将本目录与插件源码一起保留，不能从源码发布清单中删去。

从仓库根目录构建插件后，运行 `npm run test:desktop:contract`。真实官方桌面验收见 [测试说明](../tests/README.md) 和 [兼容性审查](../tests/DESKTOP-COMPATIBILITY.md)。

本包为 MIT 许可，详见 [LICENSE](./LICENSE)。
