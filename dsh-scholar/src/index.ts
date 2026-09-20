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
import { setOpenalexContact } from './related.js';

export const name = 'dsh-scholar';

/** Host services this plugin waits for (settings registry, http carrier, tool registry, prompt assembly,
 *  llm/fs/attachments 供自有精读引擎：llm 流式调用、PDF 读取、VLM 图片附件）。 */
export const inject = ['settings', 'webServer', 'tools', 'systemPrompt', 'llm', 'fs', 'attachments'];

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
  openalexEmail: z.string().default(''),
  // 科研精读动线（v1.17+）：对话精读的 focus 锚点 / VLM 读图开关
  researchFocus: z.string().default(''),
  vlmFigures: z.union(['auto', 'off']).default('auto'),
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
        '2) 精读：用 paper_read 工具（学者工作台自带引擎，读论文 PDF→自动归档五段式报告并回填 summary，',
        '   长文自动转后台任务）。**对话中一律裸读**：mode=paper（速读筛文献用 quick），',
        '   不自动拼 focus——不拼研究方向/学术透镜/库内相关论文/已有卡（让论文自己说话，',
        '   上下文堆叠会带偏理解）。唯一例外：用户消息里明确点名了具体关注点时，',
        '   可仅把用户点名的原话作为 focus 传入，不要自行扩展。',
        '   **禁止旁路**：不要自己读 PDF/抽文本再手写 HTML 报告用 paper_save_report 归档，',
        '   也不要声称用某个"精读引擎"——一律走 paper_read（手写报告会丢追问会话、',
        '   对比原料、模式标记，且格式与库内不一致）。paper_save_report 仅限归档',
        '   用户明确提供的、非精读产出的外部 HTML。',
        '   - 需要带研究方向/透镜/相关论文的复读（对比定位、迁移分析）：**引导用户用',
        '     论文库详情页的「精读」面板**（可勾选上下文、编辑 focus、批量多篇、进度可见），',
        '     不要在对话里拼这些上下文。',
        '   - 速读/筛文献：mode=quick。',
        '   - 轻量档：用户说"轻量精读/快速深读/API 忙就随便读下"时 paper_read 传 light=true',
        '   （长文综合走摘要，快而稳，精度略降）；默认不传（标准深读）。',
        '   - **长文转后台任务后：用 job_output（wait:true, timeout 90s）轮询并向用户播报进度**',
        '     （"第 3/8 段完成，正在读第 4 段"），未完成就继续轮询——用户应能在对话里看到精读走到哪一步。',
        '3) 沉淀：从精读结论提取 1-3 条创新点，用 idea_card_create 建卡并标注来源论文',
        '   （evidence 引用报告中的具体数据与表号；报告可用 paper_read 的 path 参数速读已归档文件）。',
        '4) 追问：用户对某篇论文提具体问题时用 paper_ask（带页码出处的交互式精读）。',
        '用户提到的论文尚未入库时，先 paper_save 再走上述流程。',
      ].join('\n'),
    }),
    'dsh-scholar: workflow prompt',
  );

  // 研究方向常驻注入：供建卡/回答研究问题时的方向感；对话精读已改为一律裸读，
  // 带方向的复读引导到论文库精读面板（面板会取设置页的研究方向预填 focus）。
  ctx.effect(
    () => (ctx as any).systemPrompt.context({
      name: 'scholar:research-focus',
      order: 152,
      text: () => {
        const focus = (getConfig().researchFocus ?? '').trim().slice(0, 400);
        if (focus === '') return '';
        return `[学者工作台·研究方向] ${focus}\n（对话中精读不拼 focus；带方向的复读请引导用户用论文库「精读」面板。）`;
      },
    }),
    'dsh-scholar: research focus context',
  );

  const scope = ctx.settings.register(NS, ScholarConfigSchema, {});

  const getConfig = (): ScholarConfig => {
    const cfg = scope.get() as ScholarConfig | undefined;
    const config = {
      paperDir: cfg?.paperDir?.trim() || defaultPaperDir(),
      defaultTags: cfg?.defaultTags ?? [],
      fetchProxy: cfg?.fetchProxy?.trim() || '',
      openalexEmail: cfg?.openalexEmail?.trim() || '',
      researchFocus: cfg?.researchFocus ?? '',
      vlmFigures: cfg?.vlmFigures === 'off' ? 'off' as const : 'auto' as const,
    };
    // OpenAlex polite pool 联系邮箱：配置即生效（related 路由/引用同步共用）
    setOpenalexContact(config.openalexEmail || undefined);
    return config;
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
