/**
 * Worker 里 applyOps 的单元测试。跑： node worker/test-ops.mjs
 * 只在内存里算，不碰网络、不碰线上仓库。
 *
 * 注意：docs/inventory.json 是活数据（网页那边随时在建箱子、归位），
 * 所以这里先把它归一化成「只剩固定区域、所有东西都未归位」的干净起点，
 * 数量也从数据里现算 —— 否则用户在网页上动一下，测试就红一片。
 */
import { applyOps } from './worker.js';
import fs from 'fs';

const raw = JSON.parse(fs.readFileSync(new URL('../docs/inventory.json', import.meta.url), 'utf8'));
const base = {
  ...raw,
  layout: { ...raw.layout, boxes: (raw.layout.boxes || []).filter(b => b.fixed) },
  items: raw.items.map(it => {
    const q = (it.places || []).reduce((s, p) => s + (p.qty || 0), 0);
    return { ...it, places: q ? [{ box: null, qty: q }] : [] };
  }),
};

let ok = 0, fail = 0;
const t = (name, fn) => { try { fn(); console.log('✅', name); ok++; } catch (e) { console.log('❌', name, '->', e.message); fail++; } };
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`); };
const bx = (inv) => inv.layout.boxes.filter(b => !b.fixed);           // 忽略地面/正面墙这两个固定区
const qty = (inv, id, box) => ((inv.items.find(i => i.id === id).places || []).find(p => (p.box ?? null) === (box ?? null)) || {}).qty || 0;
const total = (inv, id) => (inv.items.find(i => i.id === id).places || []).reduce((s, p) => s + p.qty, 0);
const sum = (inv) => inv.items.reduce((s, i) => s + (i.places || []).reduce((t, p) => t + p.qty, 0), 0);

// 起点里的数量现算，不写死
const TOTAL = sum(base);
const Q = (id) => total(base, id);
const [A, B, C] = base.items.filter(i => Q(i.id) > 5).slice(0, 3).map(i => i.id);
if (!A || !B || !C) throw new Error('数据里找不到三个数量 >5 的物料，测试没法跑');

t('建箱子', () => {
  const r = applyOps(base, [{ op: 'addBox', box: { rack: 'L1', level: 2, slot: 'c', label: '礼盒' } }]);
  eq(bx(r).length, 1, '箱数'); eq(bx(r)[0].id, 'L1-2-c', '箱号');
  eq(bx(base).length, 0, '不能改到原对象');
});
t('重复建箱报错', () => {
  try { applyOps(base, [{ op: 'addBox', box: { rack: 'L1', level: 2, slot: 'c' } }, { op: 'addBox', box: { rack: 'L1', level: 2, slot: 'c' } }]); throw new Error('应该报错'); }
  catch (e) { if (!e.message.includes('已经有箱子')) throw e; }
});
t('非法层/槽被拒', () => {
  for (const b of [{ rack: 'L1', level: 9, slot: 'a' }, { rack: 'L1', level: 1, slot: 'z' }, { rack: 'XX', level: 1, slot: 'a' }]) {
    let threw = false; try { applyOps(base, [{ op: 'addBox', box: b }]); } catch (e) { threw = true; }
    if (!threw) throw new Error('没拦住 ' + JSON.stringify(b));
  }
});
t('归位：未归位 -> 箱子', () => {
  const n = Q(A) - 5;
  const r = applyOps(base, [{ op: 'addBox', box: { rack: 'L1', level: 2, slot: 'c' } }, { op: 'move', id: A, from: null, to: 'L1-2-c', qty: n }]);
  eq(qty(r, A, null), 5, '剩余未归位'); eq(qty(r, A, 'L1-2-c'), n, '箱内'); eq(total(r, A), Q(A), '总数不变');
});
t('一品多箱，总数=求和', () => {
  const n = Q(A) - 3;
  const r = applyOps(base, [
    { op: 'addBox', box: { rack: 'L1', level: 2, slot: 'c' } }, { op: 'addBox', box: { rack: 'R2', level: 1, slot: 'a' } },
    { op: 'move', id: A, from: null, to: 'L1-2-c', qty: n }, { op: 'move', id: A, from: null, to: 'R2-1-a', qty: 3 }]);
  eq(qty(r, A, null), 0, '未归位清零'); eq(total(r, A), Q(A), '总数');
  eq((r.items.find(i => i.id === A).places || []).length, 2, '两个 place');
});
t('搬超量被拒', () => {
  let threw = false;
  try { applyOps(base, [{ op: 'addBox', box: { rack: 'L1', level: 1, slot: 'a' } }, { op: 'move', id: A, from: null, to: 'L1-1-a', qty: Q(A) + 1 }]); }
  catch (e) { threw = e.message.includes(`只有 ${Q(A)}`); }
  if (!threw) throw new Error('没拦住超量搬运');
});
t('删箱：有货时拒绝，force 时退回未归位', () => {
  const mid = applyOps(base, [{ op: 'addBox', box: { rack: 'L1', level: 1, slot: 'a' } }, { op: 'move', id: A, from: null, to: 'L1-1-a', qty: Q(A) }]);
  let threw = false; try { applyOps(mid, [{ op: 'delBox', id: 'L1-1-a' }]); } catch (e) { threw = e.message.includes('还有 1 种物料'); }
  if (!threw) throw new Error('有货竟然让删');
  const r = applyOps(mid, [{ op: 'delBox', id: 'L1-1-a', force: true }]);
  eq(bx(r).length, 0, '箱已删'); eq(qty(r, A, null), Q(A), '退回未归位');
});
t('删箱不重排其它槽位（保住实体标签）', () => {
  const mid = applyOps(base, [{ op: 'addBox', box: { rack: 'L1', level: 1, slot: 'a' } }, { op: 'addBox', box: { rack: 'L1', level: 1, slot: 'b' } }, { op: 'addBox', box: { rack: 'L1', level: 1, slot: 'c' } }]);
  const r = applyOps(mid, [{ op: 'delBox', id: 'L1-1-b' }]);
  eq(bx(r).map(b => b.id), ['L1-1-a', 'L1-1-c'], 'c 不能变成 b');
});
t('setItem 省略 places 时不动服务端归位', () => {
  const mid = applyOps(base, [{ op: 'addBox', box: { rack: 'L1', level: 1, slot: 'a' } }, { op: 'move', id: A, from: null, to: 'L1-1-a', qty: Q(A) }]);
  const it = { ...mid.items.find(i => i.id === A) }; delete it.places; it.name = '改了名字';
  const r = applyOps(mid, [{ op: 'setItem', item: it }]);
  eq(r.items.find(i => i.id === A).name, '改了名字', '名字改了');
  eq(qty(r, A, 'L1-1-a'), Q(A), '归位没被覆盖');
});
t('并发模拟：A 改物料名 + B 归位另一物料，互不覆盖', () => {
  const s1 = applyOps(base, [{ op: 'addBox', box: { rack: 'R1', level: 3, slot: 'b' } }]);
  const itB = { ...s1.items.find(i => i.id === B) }; delete itB.places; itB.name = 'A改的名';
  const s2 = applyOps(s1, [{ op: 'setItem', item: itB }]);
  const s3 = applyOps(s2, [{ op: 'move', id: C, from: null, to: 'R1-3-b', qty: 3 }]);
  eq(s3.items.find(i => i.id === B).name, 'A改的名', 'A 的改动还在');
  eq(qty(s3, C, 'R1-3-b'), 3, 'B 的改动也在');
});
t('新增物料 + 非法 id 被拒', () => {
  const r = applyOps(base, [{ op: 'setItem', item: { id: 'zz1', seq: 999, name: '新东西', places: [{ box: null, qty: 5 }] } }]);
  eq(total(r, 'zz1'), 5, '新物料数量');
  let threw = false; try { applyOps(base, [{ op: 'setItem', item: { id: '../evil', name: 'x' } }]); } catch (e) { threw = true; }
  if (!threw) throw new Error('非法 id 没拦住');
});
t('非法图片路径被过滤', () => {
  const r = applyOps(base, [{ op: 'setItem', item: { id: 'zz2', name: 'x', photos: ['images/ok-1.jpg', '../../etc/passwd', 'images/e.png', 'images/thumbs/ok-1.jpg'] } }]);
  eq(r.items.find(i => i.id === 'zz2').photos, ['images/ok-1.jpg', 'images/thumbs/ok-1.jpg'], '只留合法 jpg');
});
t('setPlace 置 0 会移除该 place', () => {
  const mid = applyOps(base, [{ op: 'addBox', box: { rack: 'L2', level: 4, slot: 'f' } }, { op: 'setPlace', id: B, box: 'L2-4-f', qty: 10 }]);
  eq(qty(mid, B, 'L2-4-f'), 10, '设了 10');
  const r = applyOps(mid, [{ op: 'setPlace', id: B, box: 'L2-4-f', qty: 0 }]);
  eq((r.items.find(i => i.id === B).places || []).some(p => p.box === 'L2-4-f'), false, 'place 已移除');
});
t('往不存在的箱子放货被拒', () => {
  let threw = false; try { applyOps(base, [{ op: 'move', id: A, from: null, to: 'L9-9-z', qty: 1 }]); } catch (e) { threw = e.message.includes('箱子不存在'); }
  if (!threw) throw new Error('没拦住');
});
t('移箱：箱号跟着位置走，箱里的货不能丢', () => {
  const mid = applyOps(base, [{ op: 'addBox', box: { rack: 'L1', level: 2, slot: 'a', label: '礼盒' } },
    { op: 'move', id: A, from: null, to: 'L1-2-a', qty: Q(A) }, { op: 'move', id: B, from: null, to: 'L1-2-a', qty: Q(B) }]);
  const r = applyOps(mid, [{ op: 'moveBox', id: 'L1-2-a', rack: 'R2', level: 4, slot: 'f' }]);
  eq(bx(r).map(b => b.id), ['R2-4-f'], '新箱号');
  eq(bx(r)[0].label, '礼盒', '标签跟着走');
  eq(qty(r, A, 'R2-4-f'), Q(A), 'A 跟着到新箱号');
  eq(qty(r, B, 'R2-4-f'), Q(B), 'B 跟着到新箱号');
  eq(qty(r, A, 'L1-2-a'), 0, '旧箱号下没有残留');
  eq(total(r, A), Q(A), '总数不变');
});
t('移箱到已占用的槽位被拒', () => {
  const mid = applyOps(base, [{ op: 'addBox', box: { rack: 'L1', level: 1, slot: 'a' } }, { op: 'addBox', box: { rack: 'L1', level: 1, slot: 'b' } }]);
  let threw = false; try { applyOps(mid, [{ op: 'moveBox', id: 'L1-1-a', rack: 'L1', level: 1, slot: 'b' }]); } catch (e) { threw = e.message.includes('已经有箱子'); }
  if (!threw) throw new Error('没拦住');
});
t('移箱到原位是空操作', () => {
  const mid = applyOps(base, [{ op: 'addBox', box: { rack: 'L1', level: 1, slot: 'a' } }, { op: 'move', id: A, from: null, to: 'L1-1-a', qty: 5 }]);
  const r = applyOps(mid, [{ op: 'moveBox', id: 'L1-1-a', rack: 'L1', level: 1, slot: 'a' }]);
  eq(bx(r).map(b => b.id), ['L1-1-a'], '箱号不变'); eq(qty(r, A, 'L1-1-a'), 5, '货不变');
});
t('移箱非法目标被拒', () => {
  const mid = applyOps(base, [{ op: 'addBox', box: { rack: 'L1', level: 1, slot: 'a' } }]);
  for (const o of [{ rack: 'XX', level: 1, slot: 'a' }, { rack: 'L1', level: 9, slot: 'a' }, { rack: 'L1', level: 1, slot: 'z' }]) {
    let threw = false; try { applyOps(mid, [{ op: 'moveBox', id: 'L1-1-a', ...o }]); } catch (e) { threw = true; }
    if (!threw) throw new Error('没拦住 ' + JSON.stringify(o));
  }
});
t('拖拽落到空槽位：建箱+归位 一次提交', () => {
  const r = applyOps(base, [{ op: 'addBox', box: { rack: 'R1', level: 3, slot: 'b' } }, { op: 'move', id: C, from: null, to: 'R1-3-b', qty: Q(C) }]);
  eq(qty(r, C, 'R1-3-b'), Q(C), '落进新建的箱子'); eq(qty(r, C, null), 0, '未归位清空');
});
t('撤销一次拖拽能完全还原', () => {
  const after = applyOps(base, [{ op: 'addBox', box: { rack: 'R1', level: 3, slot: 'b' } }, { op: 'move', id: C, from: null, to: 'R1-3-b', qty: Q(C) }]);
  const undone = applyOps(after, [{ op: 'move', id: C, from: 'R1-3-b', to: null, qty: Q(C) }, { op: 'delBox', id: 'R1-3-b' }]);
  eq(bx(undone).length, 0, '箱子撤掉了');
  eq(qty(undone, C, null), Q(C), '货回到未归位');
  eq(sum(undone), TOTAL, '总数回到原样');
});
t('地面 / 正面墙也能建箱子放货（各用各的槽位）', () => {
  const r = applyOps(base, [
    { op: 'addBox', box: { rack: 'G', level: 1, slot: 'e', label: '大件' } },
    { op: 'addBox', box: { rack: 'W', level: 1, slot: 'd' } },
    { op: 'move', id: A, from: null, to: 'G-1-e', qty: Q(A) },
    { op: 'move', id: B, from: null, to: 'W-1-d', qty: Q(B) }]);
  eq(bx(r).map(b => b.id).sort(), ['G-1-e', 'W-1-d'], '两个区各建了一个箱');
  eq(qty(r, A, 'G-1-e'), Q(A), '地面箱里的货');
  eq(qty(r, B, 'W-1-d'), Q(B), '墙上箱里的货');
  eq(bx(r).find(b => b.id === 'G-1-e').label, '大件', '标签');
});
t('每个区按自己的层数/槽位校验', () => {
  // 正面墙只有 a-d 一层，地面只有 1 排 a-f
  for (const b of [{ rack: 'W', level: 1, slot: 'e' }, { rack: 'W', level: 2, slot: 'a' }, { rack: 'G', level: 2, slot: 'a' }]) {
    let threw = false; try { applyOps(base, [{ op: 'addBox', box: b }]); } catch (e) { threw = true; }
    if (!threw) throw new Error('没拦住 ' + JSON.stringify(b));
  }
  // 货架仍然是 4 层 a-f
  const r = applyOps(base, [{ op: 'addBox', box: { rack: 'L1', level: 4, slot: 'f' } }]);
  eq(bx(r).map(b => b.id), ['L1-4-f'], '货架照旧');
});
t(`全库总数守恒（${base.items.length} 条 ${TOTAL} 件）`, () => {
  const r = applyOps(base, [{ op: 'addBox', box: { rack: 'L1', level: 1, slot: 'a' } }, { op: 'addBox', box: { rack: 'L1', level: 1, slot: 'b' } },
    { op: 'move', id: A, from: null, to: 'L1-1-a', qty: Q(A) }, { op: 'move', id: A, from: 'L1-1-a', to: 'L1-1-b', qty: Math.floor(Q(A) / 2) }]);
  eq(sum(r), TOTAL, '搬来搬去总数不变');
});

console.log(`\n${ok} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
