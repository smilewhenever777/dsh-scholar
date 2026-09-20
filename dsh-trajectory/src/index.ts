/**
 * dsh-trajectory — host half.
 *
 * Cordis plugin providing:
 *  - settings namespace `trajectory` (data directory)
 *  - REST routes /traj/* (overview / projects / nodes / edges / stats / config)
 *  - ten agent-facing tools (traj_overview / traj_project_set / traj_project_delete /
 *    traj_node_add / traj_entry_add / traj_node_update / traj_node_remove /
 *    traj_link_add / traj_link_remove / traj_mainline_set)
 *  - systemPrompt integration: discipline section + open-items context
 *
 * Data lives as local JSON files under the configured data directory
 * (see src/store.ts). All trajectory content flows through tool arguments
 * produced in conversation — the host never calls an LLM itself.
 */
import type { Context } from '@deepseek-ai/cordis';
import z from 'schemastery';
// 仅加载 dsh-settings 的 Context 类型增强(ctx.settings);0.1.5 起无值导出需要
import type {} from '@deepseek-ai/dsh-settings';
import type { TrajConfig } from './shared/types.js';
import { TrajStore } from './store.js';
import { registerTrajRoutes } from './routes.js';
import { registerTrajTools } from './tools.js';
import { registerTrajPrompt } from './prompt.js';

export const name = 'dsh-trajectory';

/** Host services this plugin waits for. 服务名是驼峰 `systemPrompt`
 *  (dsh-web-app 自己 ctx.inject(["systemPrompt"]);kebab 的 'system-prompt'
 *  会永远 pending——dsh-morning 曾踩过这个坑)。 */
export const inject = ['settings', 'webServer', 'tools', 'systemPrompt'];

// 0.1.5 起 dsh-settings 移除了 settingsNamespace 包装:命名空间直接以字面量传入
const NS = 'trajectory';

function dshHome(): string {
  const home = process.env.DSH_HOME?.trim();
  if (home) return home;
  return `${process.env.USERPROFILE ?? process.env.HOME ?? process.cwd()}/.dsh`;
}

function defaultDataDir(): string {
  return `${dshHome()}/trajectory`;
}

const TrajConfigSchema = z.object({
  // default('') 而非 required():首次注册时空配置会校验失败;空串由 getConfig 兜底
  dataDir: z.string().default(''),
});

export function apply(ctx: Context) {
  const scope = ctx.settings.register(NS, TrajConfigSchema, {});

  const getConfig = (): TrajConfig => {
    const cfg = scope.get() as TrajConfig | undefined;
    return { dataDir: cfg?.dataDir?.trim() || defaultDataDir() };
  };

  // Lazy singleton store, re-created when the configured directory changes.
  let store: TrajStore | null = null;
  let storeDir = '';
  let storePromise: Promise<TrajStore> | null = null;

  const getStore = (): Promise<TrajStore> => {
    const dir = getConfig().dataDir;
    if (!storePromise || storeDir !== dir) {
      storeDir = dir;
      const s = new TrajStore(dir);
      storePromise = s.init()
        .then(() => {
          store = s;
          const st = s.stats();
          console.log(`[dsh-trajectory] 主线图就绪: ${dir}（${st.projects} 个项目 / ${st.nodes} 节点 / ${st.edges} 边）`);
          return s;
        })
        .catch((err) => {
          storePromise = null;
          throw err;
        });
    }
    return storePromise;
  };

  const updateConfig = async (patch: Partial<TrajConfig>): Promise<void> => {
    await scope.update({ ...getConfig(), ...patch });
  };

  // warm the store so the systemPrompt context provider has data on first assembly
  void getStore().catch((err) => {
    console.warn(`[dsh-trajectory] 数据目录初始化失败: ${err instanceof Error ? err.message : String(err)}`);
  });

  registerTrajRoutes(ctx, getStore, getConfig, updateConfig);
  registerTrajTools(ctx, getStore);
  registerTrajPrompt(ctx, { getStore: () => store });

  console.log('[dsh-trajectory] host half ready: settings ns + /traj/* routes + 10 agent tools + systemPrompt');
}
