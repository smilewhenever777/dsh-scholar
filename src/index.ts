/**
 * dsh-scholar — host half.
 *
 * Cordis plugin providing:
 *  - settings namespace `scholar` (paper directory, default tags)
 *  - REST routes /scholar/* (papers / cards / graph / stats / config)
 *  - eleven agent-facing tools (paper_save / paper_fetch_pdf / paper_save_report /
 *    paper_update / paper_search / paper_get /
 *    idea_card_create / idea_card_search / idea_card_update / kg_extract / kg_query)
 *
 * Data lives as local JSON files under the configured paper directory
 * (see src/store.ts). All AI-generated content flows through tool arguments
 * produced in conversation — the host never calls an LLM itself.
 */
import type { Context } from '@deepseek-ai/cordis';
import z from 'schemastery';
// 仅加载 dsh-settings 的 Context 类型增强(ctx.settings);0.1.5 起无值导出需要
import type {} from '@deepseek-ai/dsh-settings';
import type { ScholarConfig } from './shared/types.js';
import { PaperStore } from './store.js';
import { registerScholarRoutes } from './routes.js';
import { registerScholarTools } from './tools.js';

export const name = 'dsh-scholar';

/** Host services this plugin waits for (settings registry, http carrier, tool registry, prompt assembly). */
export const inject = ['settings', 'webServer', 'tools', 'systemPrompt'];

// 0.1.5 起 dsh-settings 移除了 settingsNamespace 包装:命名空间直接以字面量传入
const NS = 'scholar';

function defaultPaperDir(): string {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? process.cwd();
  return `${home}/Documents/ResearchPapers`;
}

const ScholarConfigSchema = z.object({
  paperDir: z.string().required(),
  defaultTags: z.array(z.string()).default([]),
  fetchProxy: z.string().default(''),
});

export function apply(ctx: Context) {
  // 科研精读动线：把 保存 → 精读 → 沉淀 串成 agent 的默认工作方式
  ctx.effect(
    () => (ctx as any).systemPrompt.section({
      name: 'dsh-scholar-workflow',
      order: 151,
      text: [
        '科研论文动线（用户要求保存、精读、沉淀论文时严格遵守）：',
        '1) 保存：用 paper_save 入库；参数带 arxivId 时会自动从 arXiv 下载 PDF 归档，无需手动处理；',
        '   非 arXiv 来源会返回 pdfWarning，转告用户在论文详情页手动上传。',
        '2) 精读：先 paper_search / paper_get 找到该论文的 pdfPath，然后用 deepread 工具读该 PDF 路径；',
        '   科研论文默认 map 模式（每个重要主张给出证据、出处与置信度），完成后导出 html，',
        '   并调用 paper_save_report 把报告 html 内容存回论文库。',
        '3) 沉淀：从精读结论提取 1-3 条创新点，用 idea_card_create 建卡并标注来源论文；',
        '   再用 paper_update 将该论文的 summary 更新为精读核心结论。',
        '用户提到的论文尚未入库时，先 paper_save 再走上述流程。',
      ].join('\n'),
    }),
    'dsh-scholar: workflow prompt',
  );

  const scope = ctx.settings.register(NS, ScholarConfigSchema, {});

  const getConfig = (): ScholarConfig => {
    const cfg = scope.get() as ScholarConfig | undefined;
    return {
      paperDir: cfg?.paperDir?.trim() || defaultPaperDir(),
      defaultTags: cfg?.defaultTags ?? [],
      fetchProxy: cfg?.fetchProxy?.trim() || '',
    };
  };

  // Lazy singleton store, re-created when the configured directory changes.
  let storePromise: Promise<PaperStore> | null = null;
  let storeDir = '';

  const getStore = (): Promise<PaperStore> => {
    const dir = getConfig().paperDir;
    if (!storePromise || storeDir !== dir) {
      // 目录热切换：旧 store 打 disposed 标记，在途请求的后续写操作会显式失败
      // （而不是"写旧目录成功但新库里没有"）
      storePromise?.then((old) => old.dispose()).catch(() => {});
      storeDir = dir;
      const store = new PaperStore(dir);
      storePromise = store.init()
        .then(() => {
          const s = store.stats();
          console.log(`[dsh-scholar] 论文库就绪: ${dir}（${s.papers} 篇论文 / ${s.cards} 张卡片 / 图谱 ${s.nodes} 节点 ${s.edges} 边）`);
          return store;
        })
        .catch((err) => {
          storePromise = null;
          throw err;
        });
    }
    return storePromise;
  };

  const updateConfig = async (patch: Partial<ScholarConfig>): Promise<void> => {
    await scope.update({ ...getConfig(), ...patch });
  };

  registerScholarRoutes(ctx, getStore, getConfig, updateConfig);
  const toolCount = registerScholarTools(ctx, getStore, getConfig);

  console.log(`[dsh-scholar] host half ready: settings ns + /scholar/* routes + ${toolCount} agent tools`);
}
