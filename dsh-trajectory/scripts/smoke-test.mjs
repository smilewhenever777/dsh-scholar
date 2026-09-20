// Smoke test for dsh-trajectory: store + domain against a temp dir.
// Run after `npm run build` (imports from ../dist).
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TrajStore } from '../dist/store.js';
import { matchLiveProgress } from '../dist/liveprogress.js';
import {
  applyNodePatch, countsByStatus, createNode, newEdgeValidated, normalizeMainline,
} from '../dist/domain.js';

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) {
    console.log(`  ✅ ${name}`);
  } else {
    failures++;
    console.log(`  ❌ ${name} ${detail}`);
  }
}

const dir = mkdtempSync(join(tmpdir(), 'dsh-trajectory-smoke-'));
console.log(`临时目录: ${dir}`);

try {
  /* ---------- init ---------- */
  const store = new TrajStore(dir);
  await store.init();
  check('init 创建目录结构', existsSync(join(dir, 'projects')));

  /* ---------- projects ---------- */
  const createdA = await store.createProject({ name: '视频生成研究', description: '扩散视频方向' });
  const projA = createdA.project;
  check('创建项目 A', !!projA.id && createdA.existed === false);
  const again = await store.createProject({ name: '视频生成研究', activate: true });
  check('同名项目不重复(create-or-get)', again.project.id === projA.id && again.existed === true);
  const createdB = await store.createProject({ name: 'LoRA 方向' });
  const projB = createdB.project;
  check('创建项目 B(不抢活跃)', store.activeProjectId === projA.id);
  await store.setActive(projB.id);
  check('切换活跃项目', store.activeProjectId === projB.id);
  await store.setActive(projA.id);
  check('项目文件可读', store.getFile(projA.id)?.project.name === '视频生成研究');

  /* ---------- nodes ---------- */
  const nIdea = await store.addNode({ projectId: projA.id, kind: 'idea', title: '免训练视频编辑', detail: '注意力注入思路', mainline: true });
  const nExp1 = await store.addNode({ projectId: projA.id, kind: 'experiment', title: '实验:基线复现', status: 'in_progress', parentIds: [nIdea.id], mainline: true });
  check('节点登记(主线追加)', store.getFile(projA.id)?.project.mainline.length === 2);
  const f1 = store.getFile(projA.id);
  check('parentIds 自动建 enables 边', f1?.edges.length === 1
    && f1.edges[0].source === nIdea.id && f1.edges[0].target === nExp1.id);

  const nExp2 = await store.addNode({
    projectId: projA.id, kind: 'experiment', title: '实验:秩扫描', status: 'in_progress',
    refs: { hostId: 'hostA', logPath: 'D:/runs/rank-sweep/log.txt', cmdPattern: 'train.py --rank-sweep' },
    parentIds: [nExp1.id],
  });
  const f2 = store.getFile(projA.id);
  check('refs 落盘', f2?.nodes.find((n) => n.id === nExp2.id)?.refs?.logPath === 'D:/runs/rank-sweep/log.txt');

  const nPaper = await store.addNode({ projectId: projA.id, kind: 'paper', title: '论文:投稿 A 会', mainline: true, parentIds: [nExp2.id] });
  check('主线三步就绪', store.getFile(projA.id)?.project.mainline.join(',') === [nIdea.id, nExp1.id, nPaper.id].join(','));

  // patch semantics: only provided fields change
  const updated = await store.updateNode(nExp1.id, { status: 'done', detail: '基线复现成功,loss 收敛' });
  check('节点状态推进+结论', updated.status === 'done' && updated.detail?.includes('收敛'));
  const cleared = await store.updateNode(nExp2.id, { refs: { hostId: '', logPath: 'D:/runs/rank-sweep/log.txt', cmdPattern: '' } });
  check('ref 空串清除语义', cleared.refs?.hostId === undefined && cleared.refs?.cmdPattern === undefined && !!cleared.refs?.logPath);

  /* ---------- edges validation ---------- */
  let threw = false;
  try { await store.addEdge({ projectId: projA.id, source: nIdea.id, target: nIdea.id }); } catch { threw = true; }
  check('自环拒绝', threw);
  threw = false;
  try { await store.addEdge({ projectId: projA.id, source: 'n_missing', target: nIdea.id }); } catch { threw = true; }
  check('未知端点拒绝', threw);
  const dupEdge = await store.addEdge({ projectId: projA.id, source: nIdea.id, target: nExp1.id, kind: 'enables' });
  check('重复边幂等', dupEdge.existed === true);
  const feedEdge = await store.addEdge({ projectId: projA.id, source: nExp1.id, target: nPaper.id, kind: 'feeds' });
  check('不同 kind 不去重', feedEdge.existed === false && feedEdge.edge.kind === 'feeds');

  /* ---------- mainline normalization ---------- */
  const f3 = store.getFile(projA.id);
  const ml = normalizeMainline([nPaper.id, nExp1.id, nPaper.id, 'n_ghost', '', nIdea.id], f3.nodes.map((n) => n.id));
  check('主线归一化(去重+滤不存在+保序)', ml.join(',') === [nPaper.id, nExp1.id, nIdea.id].join(','));

  /* ---------- counts ---------- */
  const cnt = countsByStatus(f3.nodes);
  check('状态计数', cnt.done === 1 && cnt.in_progress === 1 && cnt.todo === 2);

  /* ---------- cascade delete ---------- */
  const delOk = await store.removeNode(nExp1.id);
  const f4 = store.getFile(projA.id);
  check('删除节点级联清边+主线', delOk
    && !f4.nodes.some((n) => n.id === nExp1.id)
    && !f4.edges.some((e) => e.source === nExp1.id || e.target === nExp1.id)
    && !f4.project.mainline.includes(nExp1.id));

  /* ---------- pure-function patches (domain) ---------- */
  const pn = createNode({ projectId: 'p_x', title: '  测试  ' });
  check('createNode 标题裁剪+默认 kind/status', pn.title === '测试' && pn.kind === 'other' && pn.status === 'todo');
  const pp = applyNodePatch(pn, { tags: ['a', 'a', 'b'], detail: '  ' });
  check('applyNodePatch tags 去重/空 detail 删除', pp.tags?.join(',') === 'a,b' && pp.detail === undefined);
  threw = false;
  try { newEdgeValidated([pn], [], { source: pn.id, target: pn.id }); } catch { threw = true; }
  check('域层自环校验(纯函数)', threw);

  /* ---------- persistence across restart ---------- */
  const store2 = new TrajStore(dir);
  await store2.init();
  check('重启持久(项目数)', store2.files.size === 2);
  check('重启持久(活跃项目)', store2.activeProjectId === projA.id);
  const file2 = store2.getFile(projA.id);
  check('重启持久(节点/边)', file2?.nodes.length === 3 && file2?.edges.length === 1);

  /* ---------- entries(实验台账)+ researchQuestion ---------- */
  const f5 = store2.getFile(projA.id);
  const tNode = f5.nodes[0];
  const add1 = await store2.addEntry(tNode.id, { title: '消融实验 30e', data: '数据集A +1.5pp', conclusion: 'partial', ts: Date.parse('2026-08-22') });
  const add2 = await store2.addEntry(tNode.id, { title: '主表冻结', data: '全部正收益', ts: Date.parse('2026-09-01') });
  const tNode2 = store2.getFile(projA.id).nodes.find((n) => n.id === tNode.id);
  check('台账追加 2 条', tNode2?.entries?.length === 2);
  check('台账 id 前缀与字段', !!add1.entry.id.startsWith('t_') && add1.entry.data === '数据集A +1.5pp');
  // 结构化指标:合法项保留、非法项丢弃、baseline/unit 可选
  const addM = await store2.addEntry(tNode.id, {
    title: '主表(结构化)',
    metrics: [
      { name: '数据集A mAP50-95', value: 0.75, baseline: 0.70 },
      { name: '数据集B mAP50-95', value: 0.82, baseline: 0.78 },
      { name: '', value: 1 },
      { name: 'bad', value: Number.NaN },
      { name: 'nullval', value: null },
    ],
  });
  check('metrics 规范化(2/4 合法)', addM.entry.metrics?.length === 2);
  check('metrics 字段', addM.entry.metrics?.[0].name === '数据集A mAP50-95' && addM.entry.metrics?.[0].baseline === 0.70);
  const tNode3 = store2.getFile(projA.id).nodes.find((n) => n.id === tNode.id);
  check('metrics 落盘', tNode3?.entries?.some((e) => e.id === addM.entry.id && e.metrics?.length === 2));
  check('台账删除', await store2.removeEntry(tNode.id, add1.entry.id) === true
    && store2.getFile(projA.id).nodes.find((n) => n.id === tNode.id).entries.length === 2);
  threw = false;
  try { await store2.addEntry('n_missing', { title: 'x' }); } catch { threw = true; }
  check('台账未知节点拒绝', threw);
  await store2.updateProject(projA.id, { researchQuestion: '能否稳定保留双单模态证据?' });
  check('researchQuestion 落盘', store2.getFile(projA.id).project.researchQuestion === '能否稳定保留双单模态证据?');
  const store5 = new TrajStore(dir);
  await store5.init();
  check('台账/研究问题重启持久', store5.getFile(projA.id)?.nodes.some((n) => (n.entries?.length ?? 0) === 2)
    && store5.getFile(projA.id)?.project.researchQuestion === '能否稳定保留双单模态证据?');

  /* ---------- 工作区绑定管理(冲突/改绑/解绑)---------- */
  await store2.bindWorkspace(projA.id, 'E:/x/wsX');
  threw = false;
  try { await store2.bindWorkspace(projB.id, 'E:/X/WSX'); } catch { threw = true; }
  check('同工作区二次绑定拒绝(大小写不敏感)', threw);
  await store2.bindWorkspace(projA.id, 'E:/x/wsY');
  check('改绑自持有项目放行', store2.getFile(projA.id)?.project.workspaceKey === 'E:/x/wsY');
  threw = false;
  try { await store2.bindWorkspace(projB.id, 'E:/x/wsY'); } catch (e3) { threw = String(e3).includes('已绑定'); }
  check('绑定到已占用工作区被拒并提示', threw);
  check('解绑清空绑定键', (await store2.bindWorkspace(projA.id, '')).workspaceKey === undefined
    && store2.findByWorkspace('E:/x/wsY') === null);
  check('解绑后他人可占用', (await store2.bindWorkspace(projB.id, 'E:/x/wsY')).id === projB.id);

  /* ---------- corrupt file tolerance ---------- */
  writeFileSync(join(dir, 'projects', `${projB.id}.json`), '{corrupt!!');
  const store3 = new TrajStore(dir);
  await store3.init();
  check('损坏文件跳过', store3.files.size === 1 && !!store3.getFile(projA.id));
  check('活跃项目保持(meta)', store3.activeProjectId === projA.id);

  /* ---------- project delete + meta reassign ---------- */
  check('删除项目', await store3.deleteProject(projA.id) === true && store3.files.size === 0);
  check('无项目时活跃为空', store3.activeProjectId === null);

  /* ---------- liveprogress(dashboard 投影,纯函数)---------- */
  {
    const mkFile = (refs) => ({
      project: { id: 'p_x', name: 'x', mainline: [], status: 'active', createdAt: 0, updatedAt: 0 },
      nodes: [{ id: 'n_exp', projectId: 'p_x', kind: 'experiment', title: '实验X', status: 'in_progress', refs, createdAt: 0, updatedAt: 0 }],
      edges: [],
    });
    const dash = {
      hosts: [{ id: 'h1', name: 'H1' }, { id: 'h2', name: 'H2' }],
      snapshots: {
        h1: { ok: true, gpus: [{ index: 0, log: { path: '/home/u/runs/a.log', lines: ['Epoch 12/100', '  269/741 [05:00<09:00]'], mtimeMs: Date.now() } }] },
        h2: { ok: true, gpus: [{ index: 0, processes: [{ cmd: 'python train.py --rank-sweep' }], series: [{ name: 'epoch', points: [{ t: 1, v: 142 }] }] }] },
      },
      staleMinutes: 10,
    };
    const byLog = matchLiveProgress(mkFile({ hostId: 'h1', logPath: String.raw`/HOME/U\runs\a.log/` }), dash);
    check('liveprogress logPath 归一化命中 + tqdm 百分比', byLog.length === 1 && byLog[0].pct !== null && Math.round(byLog[0].pct) === 36 && byLog[0].label === '269/741' && byLog[0].stale === false);
    const byCmd = matchLiveProgress(mkFile({ hostId: 'h2', cmdPattern: 'rank-sweep' }), dash);
    check('liveprogress cmdPattern 命中 + series epoch 回退', byCmd.length === 1 && byCmd[0].pct === null && byCmd[0].label === 'epoch 142');
    const staleDash = { ...dash, snapshots: { h1: { ok: true, gpus: [{ log: { path: '/home/u/runs/a.log', lines: ['  1/10 [00:01<00:09]'], mtimeMs: Date.now() - 20 * 60_000 } }] } } };
    const staled = matchLiveProgress(mkFile({ logPath: '/home/u/runs/a.log' }), staleDash);
    check('liveprogress 停滞判定(mtime 超 staleMinutes)', staled.length === 1 && staled[0].stale === true);
    check('liveprogress dashboard 缺席降级', matchLiveProgress(mkFile({ logPath: '/x' }), null).length === 0);
  }

  /* ---------- stats ---------- */
  const store4 = new TrajStore(dir);
  await store4.init();
  check('stats 空态', store4.stats().projects === 0 && store4.stats().nodes === 0);

  /* ---------- 成环检测(P1-22)---------- */
  const cyc = (await store4.createProject({ name: '环检测项目' })).project;
  const cA = await store4.addNode({ projectId: cyc.id, title: '节点A' });
  const cB = await store4.addNode({ projectId: cyc.id, title: '节点B', parentIds: [cA.id] });
  const cC = await store4.addNode({ projectId: cyc.id, title: '节点C', parentIds: [cB.id] });
  threw = false;
  let cycMsg = '';
  try { await store4.addEdge({ projectId: cyc.id, source: cC.id, target: cA.id }); } catch (e4) { threw = true; cycMsg = String(e4); }
  check('成环边拒绝(A→B→C 后 C→A)', threw);
  check('成环报错含路径节点名', cycMsg.includes('节点A') && cycMsg.includes('节点B') && cycMsg.includes('节点C'));
  threw = false;
  try { await store4.addEdge({ projectId: cyc.id, source: cB.id, target: cA.id }); } catch { threw = true; }
  check('成环边拒绝(两步环 B→A)', threw);
  const okEdge = await store4.addEdge({ projectId: cyc.id, source: cA.id, target: cC.id });
  check('无环边正常创建', okEdge.existed === false);

  /* ---------- ws 缺失 mutating 拒绝(P1-25)---------- */
  threw = false;
  let wsMsg = '';
  try { await store4.resolveProject({ autoCreate: true }); } catch (e5) { threw = true; wsMsg = String(e5); }
  check('mutating(autoCreate)无 ws 抛错不落活跃', threw && wsMsg.includes('无法识别当前工作区'));
  threw = false;
  try { await store4.resolveProject({ mutating: true }); } catch { threw = true; }
  check('REST mutating 无 ws 抛错', threw);
  const autoCreated = await store4.resolveProject({ ws: 'E:/nowhere/ws', autoCreate: true });
  check('mutating 有 ws 仍可 autoCreate', !!store4.getFile(autoCreated.project.id));
  const readFallback = await store4.resolveProject({});
  check('非 mutating 读无 ws 仍回落活跃', readFallback.project.id === store4.activeProjectId);
} catch (err) {
  failures++;
  console.log(`  ❌ 测试过程抛出异常: ${err instanceof Error ? err.stack : String(err)}`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(failures === 0 ? '\n全部通过 ✅' : `\n${failures} 项失败 ❌`);
process.exit(failures === 0 ? 0 : 1);
