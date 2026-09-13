// Smoke test for dsh-scholar: store + domain + graph merge against a temp dir.
// Run after `npm run build` (imports from ../dist).
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PaperStore, assertRebuildAllowed, mergeGraph, filterPapers, filterCards, safeName, conceptId, isConceptWorthyTag } from '../dist/store.js';
import { createPaper, applyPaperPatch, applyCardPatch, createCard, findDuplicate } from '../dist/domain.js';
import { parseArxivId, parseDoi, crossrefToMeta, parseArxivFeed } from '../dist/metadata.js';

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) {
    console.log(`  ✅ ${name}`);
  } else {
    failures++;
    console.log(`  ❌ ${name} ${detail}`);
  }
}

const dir = mkdtempSync(join(tmpdir(), 'dsh-scholar-smoke-'));
console.log(`临时目录: ${dir}`);

try {
  const store = new PaperStore(dir);
  await store.init();
  check('init 创建目录结构', existsSync(join(dir, 'papers')) && existsSync(join(dir, 'cards')));

  // ---- papers ----
  const p1 = createPaper({
    title: 'Video Diffusion Models for Generative AI',
    authors: ['Alice', 'Bob'],
    year: 2024,
    venue: 'CVPR',
    arxivId: '2401.00001',
    summary: '扩散模型用于视频生成的综述。',
    tags: ['视频生成', '扩散模型'],
    importance: 5,
    source: 'agent',
  });
  const p2 = createPaper({
    title: 'LoRA Meets Video Generation',
    authors: ['Carol'],
    year: 2025,
    arxivId: '2501.00002',
    tags: ['LoRA'],
    source: 'agent',
  });
  const p3 = createPaper({ title: 'Unrelated Study on Graphs', source: 'manual' });
  await store.upsertPaper(p1);
  await store.upsertPaper(p2);
  await store.upsertPaper(p3);
  check('论文入库 3 篇', store.papers.size === 3);

  const dup = findDuplicate(store.papers.values(), { title: 'LoRA Meets Video Generation', arxivId: '2501.00002' });
  check('去重命中（arXiv）', dup?.id === p2.id);
  check('去重命中（标题）', findDuplicate(store.papers.values(), { title: 'lora meets video generation' })?.id === p2.id);
  check('去重不误报', findDuplicate(store.papers.values(), { title: 'Another Paper' }) === undefined);

  const patch = applyPaperPatch(p1, { summary: '更新后的总结。', importance: 4 });
  check('补丁合并', patch.summary === '更新后的总结。' && patch.importance === 4 && patch.title === p1.title);

  const q1 = filterPapers([...store.papers.values()], { q: 'lora', tag: 'LoRA' });
  check('检索: q=lora&tag=LoRA', q1.length === 1 && q1[0].id === p2.id);
  const q2 = filterPapers([...store.papers.values()], { yearFrom: 2025 });
  check('检索: 年份>=2025', q2.length === 1 && q2[0].id === p2.id);
  const q3 = filterPapers([...store.papers.values()], { importance: 5 });
  check('检索: 重要度>=5', q3.length === 1 && q3[0].id === p1.id);
  const q4 = filterPapers([...store.papers.values()], { sort: 'title' });
  check('排序: 标题', q4[0].title === 'LoRA Meets Video Generation');
  check('检索: tag 筛选大小写不敏感', filterPapers([...store.papers.values()], { tag: 'lora' }).length === 1
    && filterPapers([...store.papers.values()], { tag: 'LORA' })[0]?.id === p2.id);

  // ---- cards ----
  const c1 = createCard({
    title: '免训练视频编辑思路',
    insight: '把无需训练的分割思路迁移到视频编辑，用注意力注入。',
    paperId: p1.id,
    category: 'method',
    tags: ['视频编辑'],
    importance: 4,
  });
  const c2 = createCard({ title: '低秩适配评测', insight: '评测 LoRA 在不同分辨率下的表现。', paperId: p2.id, category: 'evaluation' });
  await store.upsertCard(c1);
  await store.upsertCard(c2);
  check('卡片入库 2 张', store.cards.size === 2);
  const cards1 = filterCards([...store.cards.values()], { category: 'method', importance: 4 });
  check('卡片筛选: 分类+重要度', cards1.length === 1 && cards1[0].id === c1.id);
  const cards2 = filterCards([...store.cards.values()], { paperId: p2.id });
  check('卡片筛选: 来源论文', cards2.length === 1 && cards2[0].id === c2.id);
  const cards3 = filterCards([...store.cards.values()], { status: 'pending' });
  check('卡片筛选: 默认状态 pending', cards3.length === 2);




  // ---- metadata input parsing (pure, no network) ----
  check('arXiv 解析: 裸 id', parseArxivId('2106.09685') === '2106.09685');
  check('arXiv 解析: 带版本', parseArxivId('2602.20985v2') === '2602.20985');
  check('arXiv 解析: abs 链接', parseArxivId('https://arxiv.org/abs/2501.00002') === '2501.00002');
  check('arXiv 解析: pdf 链接', parseArxivId('http://arxiv.org/pdf/2204.03458v1.pdf') === '2204.03458');
  check('arXiv 解析: 非 arXiv 输入', parseArxivId('https://example.com/x') === null);
  check('DOI 解析: 裸 doi', parseDoi('10.5555/12345678') === '10.5555/12345678');
  check('DOI 解析: doi.org 链接', parseDoi('https://doi.org/10.1000/xyz') === '10.1000/xyz');
  check('DOI 解析: 非 DOI 输入', parseDoi('2106.09685') === null);

  const feed = parseArxivFeed('<feed><title>arXiv</title><entry>' +
    '<id>http://arxiv.org/abs/2602.20985v2</id>' +
    '<title>EW&#45;DETR: Evolving World Object Detection</title>' +
    '<summary>  Real-world detection in evolving environments. </summary>' +
    '<published>2026-02-24T18:00:00Z</published>' +
    '<author><name>Munish Monga</name></author><author><name>C. V. Jawahar</name></author>' +
    '<arxiv:journal_ref>CVPR 2026</arxiv:journal_ref></entry></feed>');
  check('arXiv feed: 标题实体解码+去空格', feed.title === 'EW-DETR: Evolving World Object Detection');
  check('arXiv feed: 作者列表', feed.authors.length === 2 && feed.authors[1] === 'C. V. Jawahar');
  check('arXiv feed: 年份/journal_ref/id 规范化',
    feed.year === 2026 && feed.venue === 'CVPR 2026' && feed.arxivId === '2602.20985');

  const cr = crossrefToMeta({ message: {
    title: ['A Study <i>Inline</i>'],
    author: [{ given: 'Ada', family: 'Lovelace' }, { name: 'Org' }],
    issued: { 'date-parts': [[2024, 6]] },
    'container-title': ['Nature CC'],
    DOI: '10.1000/xyz',
    abstract: '<jats:p>Styled <jats:italic>abstract</jats:italic>.</jats:p>',
  } });
  check('CrossRef: JATS 摘要清洗', cr.abstract === 'Styled abstract.');
  check('CrossRef: 作者/年份/venue', cr.authors[0] === 'Ada Lovelace' && cr.year === 2024 && cr.venue === 'Nature CC');

  // ---- collections (multi-membership folders) ----
  const { collection: colA, existed: exA } = await store.upsertCollection('LoRA 研究');
  const { collection: colA2 } = await store.upsertCollection('lora 研究'); // case-insensitive → same
  check('分区: 名称去重（大小写不敏感）', !exA && colA2.id === colA.id);
  const { collection: colB } = await store.upsertCollection('综述精读');

  const memberPatch = applyPaperPatch(p1, { collectionIds: [colA.id, colB.id] });
  await store.upsertPaper(memberPatch);
  const inBoth = filterPapers([...store.papers.values()], { collection: colA.id });
  const inB = filterPapers([...store.papers.values()], { collection: colB.id });
  check('分区: 多重归属筛选', inBoth.length === 1 && inB.length === 1 && inBoth[0].id === p1.id);
  check('分区: filterPapers 未命中他组', filterPapers([...store.papers.values()], { collection: 'col_missing' }).length === 0);

  // persistence of collections + membership
  const storeC = new PaperStore(dir);
  await storeC.init();
  check('分区: 重启后仍在', storeC.listCollections().length === 2);
  check('分区: 成员关系保留', (storeC.papers.get(p1.id)?.collectionIds ?? []).includes(colB.id));

  // delete strips membership, keeps papers
  const delOk = await storeC.deleteCollection(colA.id);
  check('分区: 删除成功且不删论文', delOk && storeC.papers.size === 3);
  check('分区: 删除后成员剥离', !(storeC.papers.get(p1.id)?.collectionIds ?? []).includes(colA.id)
    && (storeC.papers.get(p1.id)?.collectionIds ?? []).includes(colB.id));
  const again = new PaperStore(dir); await again.init();
  check('分区: 剥离结果落盘', again.listCollections().length === 1 && (again.papers.get(p1.id)?.collectionIds ?? []).length === 1);

  // ensureCollectionNames auto-creates and dedupes
  const ids1 = await again.ensureCollectionNames(['新专题', 'lora 研究']);
  const ids2 = await again.ensureCollectionNames(['新专题']);
  check('分区: 按名建档+自动创建', ids1.length === 2 && ids2.length === 1 && ids1.includes(ids2[0]));
  check('分区: 未知 id 过滤', JSON.stringify(again.filterExistingCollectionIds([ids1[0], 'ghost'])) === JSON.stringify([ids1[0]]));

  // ---- graph ----
  const known = new Set(store.papers.keys());
  const g1 = mergeGraph({ nodes: [], edges: [] }, {
    nodes: [
      { id: p1.id, kind: 'paper', label: p1.title },
      { id: p2.id, kind: 'paper', label: p2.title },
      { id: 'cpt_lora', kind: 'concept', label: 'LoRA' },
      { id: 'cpt_video-diffusion', kind: 'concept', label: 'Video Diffusion' },
      { id: 'ghost-paper', kind: 'paper', label: '不存在的论文' },
    ],
    edges: [
      { source: p1.id, target: 'cpt_video-diffusion', kind: 'uses' },
      { source: p2.id, target: 'cpt_lora', kind: 'proposes' },
      { source: p2.id, target: 'cpt_lora', kind: 'proposes' }, // duplicate
      { source: p1.id, target: 'ghost-paper', kind: 'improves' }, // unknown endpoint
      { source: 'cpt_lora', target: 'cpt_lora', kind: 'uses' }, // self loop
      { source: 'lora', target: 'cpt_video-diffusion', kind: 'uses' }, // bare slug endpoint → resolves to cpt_lora
      { source: 'lora', target: 'cpt_lora', kind: 'extends' }, // self loop AFTER resolution → dropped
    ],
  }, 'append', known);
  check('图谱: 幽灵论文节点被丢弃', !g1.nodes.some((n) => n.id === 'ghost-paper'));
  check('图谱: 概念 id 规范化', g1.nodes.some((n) => n.id === 'cpt_lora'));
  check('图谱: 重复边去重', g1.edges.filter((e) => e.kind === 'proposes').length === 1);
  check('图谱: 幽灵边丢弃', !g1.edges.some((e) => e.target === 'ghost-paper'));
  check('图谱: 自环丢弃', !g1.edges.some((e) => e.source === e.target));
  const slugEdge = g1.edges.find((e) => e.kind === 'uses' && e.source === 'cpt_lora' && e.target === 'cpt_video-diffusion');
  check('图谱: 裸 slug 端点规范化后存活', !!slugEdge);
  check('图谱: 解析后自环丢弃（lora→cpt_lora）', !g1.edges.some((e) => e.kind === 'extends'));

  // ---- P0-2: append 模式必须保留旧边（此前每次增量抽取都会清空全部已存在关系） ----
  const g1b = mergeGraph(g1, {
    nodes: [{ id: p2.id, kind: 'paper', label: p2.title }],
    edges: [{ source: p2.id, target: 'cpt_lora', kind: 'uses' }],
  }, 'append', known);
  check('图谱: append 保留全部旧边', g1b.edges.length === g1.edges.length + 1
    && g1.edges.every((e) => g1b.edges.some((e2) => e2.source === e.source && e2.target === e.target && e2.kind === e.kind)));
  const g1c = mergeGraph(g1, {
    nodes: [],
    edges: [{ source: p1.id, target: 'cpt_video-diffusion', kind: 'uses' }], // 与旧边同键
  }, 'append', known);
  check('图谱: append 旧边参与去重（同键 incoming 不叠加）', g1c.edges.length === g1.edges.length);
  const g1d = mergeGraph(g1, {
    nodes: [
      { id: p2.id, kind: 'paper', label: p2.title },
      { id: 'cpt_lora', kind: 'concept', label: 'LoRA' },
    ],
    edges: [{ source: p2.id, target: 'cpt_lora', kind: 'uses' }],
  }, 'rebuild', known);
  check('图谱: rebuild 仍从空基座开始', g1d.edges.length === 1 && g1d.nodes.length === 2
    && !g1d.nodes.some((n) => n.id === p1.id));

  await store.saveGraph(g1);
  check('图谱落盘', existsSync(join(dir, 'graph.json')));

  // ---- auto paper node on save ----
  const p4 = createPaper({ title: 'Brand New Auto Node Paper', source: 'manual' });
  await store.upsertPaper(p4);
  check('自动补节点: 保存即入图', store.graph.nodes.some((n) => n.id === p4.id && n.label === p4.title));
  const relabeled = applyPaperPatch(p4, { title: 'Renamed Auto Node Paper' });
  await store.upsertPaper(relabeled);
  check('自动补节点: 改标题同步 label', store.graph.nodes.some((n) => n.id === p4.id && n.label === 'Renamed Auto Node Paper'));
  await store.deletePaper(p4.id); // 完整还原（节点/边/文件）
  check('自动补节点: 删除后图还原', !store.graph.nodes.some((n) => n.id === p4.id));

  // ---- persistence: reload from disk ----
  const store2 = new PaperStore(dir);
  await store2.init();
  check('重启后论文仍在', store2.papers.size === 3);
  check('重启后卡片仍在', store2.cards.size === 2);
  check('重启后图谱仍在', store2.graph.nodes.length === g1.nodes.length);
  const s = store2.stats();
  check('stats 统计', s.papers === 3 && s.cards === 2 && s.nodes === 4 && s.edges === 3);

  // p3 从未入图 → unsynced 应包含它
  const un = store2.stats().unsynced;
  check('unsynced: 统计未入图论文', un.some((x) => x.id === p3.id));

  // tag auto-sync: 标签→概念节点 + 论文→uses→概念（启发式，无 AI）
  const ts = store2.tagSyncPatch([...store2.papers.values()]);
  check('tagSync: 生成补丁', ts.nodes.length > 0 && ts.edges.length > 0);
  const g2 = mergeGraph(store2.graph, ts, 'append', new Set(store2.papers.keys()));
  await store2.saveGraph(g2);
  check('tagSync: 合并后概念增加', g2.nodes.filter((n) => n.kind === 'concept').length >= 2);
  check('tagSync: 幂等（再次扫描无新增）', store2.tagSyncPatch([...store2.papers.values()]).nodes.length === 0 && store2.tagSyncPatch([...store2.papers.values()]).edges.length === 0);
  // CJK slug:纯中文标签必须各得其所,不得塌缩到 fallback cpt_concept
  check('CJK slug: 中文标签独立成 id', conceptId('单目标跟踪') === 'cpt_单目标跟踪' && conceptId('空间感知') !== conceptId('目标跟踪'));
  check('CJK slug: 混合标签保留中文字符', conceptId('闭环RL') === 'cpt_闭环rl');
  check('CJK slug: 纯符号标签被判定不值得建概念', !isConceptWorthyTag('🔥🔥') && isConceptWorthyTag('concept') && isConceptWorthyTag('目标跟踪'));
  check('stats: unsynced 字段', Array.isArray(s.unsynced));

  // ---- delete (incl. card link cleanup) ----
  await store2.deletePaper(p3.id);
  check('删除论文', store2.papers.size === 2 && !existsSync(join(dir, 'papers', `${p3.id}.json`)));
  check('删除论文同步清理图谱', !store2.graph.nodes.some((n) => n.id === p3.id));

  await store2.deletePaper(p2.id);
  const c2after = store2.cards.get(c2.id);
  check('删除被引用论文解除卡片关联', !!c2after && c2after.paperId === undefined);

  // legacy orphan self-heal on init
  writeFileSync(join(dir, 'cards', `${c1.id}.json`), JSON.stringify({ ...c1, paperId: 'deleted-ghost-paper' }));
  const storeHeal = new PaperStore(dir);
  await storeHeal.init();
  check('启动自愈历史孤儿引用', storeHeal.cards.get(c1.id)?.paperId === undefined);

  // ---- corrupt file tolerance ----
  writeFileSync(join(dir, 'papers', 'broken.json'), '{not json');
  const store3 = new PaperStore(dir);
  await store3.init();
  check('损坏文件容错', store3.papers.size === 1);
  check('损坏文件清单暴露到 stats', store3.stats().corruptFiles?.includes('papers/broken.json') === true);

  // ---- card relations (self-contained) ----
  {
    const ca = createCard({ title: '关联A', insight: 'a', category: 'method' });
    const cb = createCard({ title: '关联B', insight: 'b', category: 'theory' });
    await store3.upsertCard(ca);
    await store3.upsertCard(cb);
    const rel = applyCardPatch(ca, { relatedCardIds: [cb.id, 'ghost-card'] });
    check('卡片关联: 补丁合并', (rel.relatedCardIds ?? []).length === 2);
    const filtered = store3.filterExistingCardIds(rel.relatedCardIds ?? []);
    check('卡片关联: 未知 id 过滤（store 层）', filtered.length === 1 && filtered[0] === cb.id);
    check('卡片关联: 空数组清除', !(applyCardPatch(rel, { relatedCardIds: [] }).relatedCardIds));
    await store3.upsertCard(applyCardPatch(ca, { relatedCardIds: [cb.id] }));
    await store3.deleteCard(cb.id);
    check('卡片关联: 删除卡片剥离引用', (store3.cards.get(ca.id)?.relatedCardIds ?? []).length === 0);

  // plain / steps 归一化
  const withSteps = applyCardPatch(ca, { plain: '  大白话  ', steps: [' 第一步 ', '', '  ', '  第二步  '] });
  check('plain/steps: 归一化', withSteps.plain === '大白话' && withSteps.steps?.length === 2 && withSteps.steps[0] === '第一步');
  const cleared = applyCardPatch(withSteps, { plain: '', steps: [] });
  check('plain/steps: 空值清除', cleared.plain === undefined && cleared.steps === undefined);
  }

  // ---- P1-19: rebuild 保护 + graph.json.bak 备份 ----
  {
    const big = {
      nodes: Array.from({ length: 15 }, (_, i) => ({ id: `cpt_c${i}`, kind: 'concept', label: `C${i}` })),
      edges: Array.from({ length: 10 }, (_, i) => ({ source: `cpt_c${i}`, target: `cpt_c${(i + 1) % 10}`, kind: 'uses' })),
    }; // 25 项 > 20
    let rejected = false;
    try { assertRebuildAllowed(big, 2, false); } catch { rejected = true; }
    check('rebuild 保护: 缩减型 rebuild 拒绝', rejected);
    let forced = true;
    try { assertRebuildAllowed(big, 2, true); } catch { forced = false; }
    check('rebuild 保护: force=true 放行', forced);
    let enough = true;
    try { assertRebuildAllowed(big, 15, false); } catch { enough = false; } // 15×2 ≥ 25
    check('rebuild 保护: incoming 足量放行', enough);
    let small = true;
    try { assertRebuildAllowed({ nodes: [], edges: [] }, 0, false); } catch { small = false; }
    check('rebuild 保护: 小图谱不拦截', small);

    const before = store3.graph;
    await store3.saveGraphRebuild(before);
    check('rebuild 备份: graph.json.bak 生成', existsSync(join(dir, 'graph.json.bak')));
    const bak = JSON.parse(readFileSync(join(dir, 'graph.json.bak'), 'utf8'));
    check('rebuild 备份: 内容为旧图谱', Array.isArray(bak.nodes) && bak.nodes.length === before.nodes.length);
  }

  // ---- P2: 存储目录热切换（disposed 写保护） ----
  {
    const storeD = new PaperStore(dir);
    await storeD.init();
    storeD.dispose();
    let threw = false;
    try { await storeD.upsertCard(createCard({ title: 'x', insight: 'y' })); }
    catch (err) { threw = /存储目录已切换/.test(String(err?.message ?? err)); }
    check('dispose 后写操作显式失败', threw);
  }

  // ---- P2: 删除论文级联清理精读报告 ----
  {
    const rp = createPaper({ title: 'Report Cascade Paper', source: 'manual' });
    await store3.upsertPaper(rp);
    const reportsDir = join(dir, 'reports');
    mkdirSync(reportsDir, { recursive: true });
    writeFileSync(join(reportsDir, `${rp.id}-123.html`), '<html></html>');
    writeFileSync(join(reportsDir, 'other-paper-1.html'), '<html></html>');
    await store3.deletePaper(rp.id);
    check('删除论文级联清理报告（不影响他人报告）',
      !existsSync(join(reportsDir, `${rp.id}-123.html`)) && existsSync(join(reportsDir, 'other-paper-1.html')));
  }

  // ---- P3: arXiv id 归一（入库/去重路径） ----
  {
    const pn = createPaper({ title: 'Variant Id Paper', arxivId: 'https://arxiv.org/abs/2106.09685v2', source: 'manual' });
    check('arXiv id 归一: 链接+版本 → 裸 id（并作为 paper id）', pn.arxivId === '2106.09685' && pn.id === '2106.09685');
    check('arXiv id 归一: 去重时变体命中', findDuplicate([pn], { arxivId: '2106.09685v3' })?.id === pn.id);
    const pv = createPaper({ title: 'Another Paper', arxivId: 'not-an-arxiv-id', source: 'manual' });
    check('arXiv id 归一: 非 arXiv 输入原样保留', pv.arxivId === 'not-an-arxiv-id');
    const pd = createPaper({ title: 'DOI Search Paper', doi: '10.1000/doitest', source: 'manual' });
    check('检索: doi 字段命中关键词', filterPapers([pd], { q: '10.1000/doitest' }).length === 1);
  }

  // ---- P3: safeName Windows 保留名 ----
  check('safeName: Windows 保留名追加 _',
    safeName('CON') === 'CON_' && safeName('con') === 'con_' && safeName('COM1') === 'COM1_'
    && safeName('nul.tar') === 'nul.tar_' && safeName('concept-x') === 'concept-x');

  // ---- mergeGraph 截断统计（stats 出参） ----
  {
    const stats = { truncatedNodes: false, truncatedEdges: false };
    const many = Array.from({ length: 2100 }, (_, i) => ({ id: `cpt_z${i}`, kind: 'concept', label: `Z${i}` }));
    const out = mergeGraph({ nodes: [], edges: [] }, { nodes: many, edges: [] }, 'append', new Set(), stats);
    check('图谱: 容量截断统计透出', stats.truncatedNodes === true && out.nodes.length <= 2000);
  }

  console.log(`\n目录文件数: papers=${readdirSync(join(dir, 'papers')).length} cards=${readdirSync(join(dir, 'cards')).length}`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n${failures} 项失败`);
  process.exit(1);
}
console.log('\n全部通过 ✔');
