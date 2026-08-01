/* 龙首谷1号仓库 —— 纯静态库存 + 2.5D 货架。
   数据 = 同仓库的 docs/inventory.json；写入经 Cloudflare Worker 代理（ops 补丁，不做整表覆盖）。 */
'use strict';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

let inventory = { title: '库存清单', schemaVersion: 2, layout: { levels: 4, slots: ['a'], racks: [], boxes: [] }, items: [] };
let query = '';
let pendingPhotos = [];        // 编辑中新加的照片 {file, url}
let editingId = null;

/* ---------- 工具 ---------- */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** toast(文字) 或 toast(文字, {ms, undo: 撤销时执行的函数}) */
function toast(msg, opts = {}) {
  const ms = opts.ms || (opts.undo ? 6000 : 2400);
  const t = $('#toast');
  t.textContent = msg;
  if (opts.undo) {
    const b = document.createElement('button');
    b.className = 'toast-undo'; b.textContent = '撤销';
    b.onclick = () => { t.classList.remove('show'); opts.undo(); };
    t.appendChild(b);
  }
  t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), ms);
}

const blobToB64 = (blob) => new Promise((res, rej) => {
  const r = new FileReader(); r.onload = () => res(r.result.split(',')[1]); r.onerror = rej; r.readAsDataURL(blob);
});
async function resizeImage(file, maxEdge = 1400, q = 0.82) {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }).catch(() => null);
  const src = bmp || await loadImgEl(file);
  let w = src.width, h = src.height;
  const scale = Math.min(1, maxEdge / Math.max(w, h));
  w = Math.round(w * scale); h = Math.round(h * scale);
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  c.getContext('2d').drawImage(src, 0, 0, w, h);
  return await new Promise(r => c.toBlob(r, 'image/jpeg', q));
}
function loadImgEl(file) {
  return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = URL.createObjectURL(file); });
}
async function fileToB64(file) { return await blobToB64(await resizeImage(file)); }
async function fileToThumbB64(file) { return await blobToB64(await resizeImage(file, 320, 0.75)); }

/* 缩略图：`images/x.jpg` 的缩略图固定是 `images/thumbs/x.jpg`，按规则拼、拼不到就回退原图。
   列表里每张只显示 64px 却下 1400px 的原图，这一下把流量砍到 8%。 */
const thumbOf = (p) => String(p || '').replace(/^images\//, 'images/thumbs/');
const imgTag = (p, cls = '') => `<img${cls ? ` class="${cls}"` : ''} src="./${esc(thumbOf(p))}" loading="lazy" alt="" draggable="false"` +
  ` onerror="this.onerror=null;this.src='./${esc(p)}'">`;

/* ---------- 数据模型（v2）----------
   item.places = [{box: 'L1-2-c'|null, qty: n}]，box=null 表示未归位；总数 = 各 place 之和。 */
const L = () => inventory.layout || (inventory.layout = { levels: 4, slots: ['a'], racks: [], boxes: [] });
const total = (it) => (it.places || []).reduce((s, p) => s + (p.qty || 0), 0);
const placeQty = (it, box) => ((it.places || []).find(p => (p.box ?? null) === (box ?? null)) || {}).qty || 0;
const boxById = (id) => L().boxes.find(b => b.id === id);
const boxAt = (rack, level, slot) => L().boxes.find(b => b.rack === rack && b.level === level && b.slot === slot);
const rackById = (id) => L().racks.find(r => r.id === id);
/* 每个区可以有自己的层数/槽位：货架 4 层 a-f，正面墙 1 层 4 位，地面 1 排 6 位 */
const rackSlots = (id) => (rackById(id) || {}).slots || L().slots;
const rackLevels = (id) => (rackById(id) || {}).levels || L().levels || 4;
const levelWord = (id) => (rackById(id) || {}).levelLabel || '层';
const boxName = (id) => {
  if (!id) return '未归位';
  const b = boxById(id);
  if (!b) return id;
  return b.label ? `${id}（${b.label}）` : id;
};
/** 某箱里有哪些物料：[{item, qty}] */
const itemsInBox = (boxId) => inventory.items
  .map(it => ({ item: it, qty: placeQty(it, boxId) }))
  .filter(x => x.qty > 0);
/** 一个物料的位置摘要，给列表用 */
function placeSummary(it) {
  const ps = (it.places || []).filter(p => p.qty > 0);
  if (!ps.length) return '<span class="tag none">无数量</span>';
  return ps.map(p => p.box
    ? `<span class="tag">${esc(p.box)} ×${p.qty}</span>`
    : `<span class="tag none">未归位 ×${p.qty}</span>`).join('');
}

/** 箱号或箱名命中的箱子。搜「礼盒」既能搜到叫礼盒的物料，也能搜到贴着「礼盒」标签的箱子。 */
function matchedBoxIds() {
  if (!query) return new Set();
  return new Set(L().boxes
    .filter(b => String(b.id).toLowerCase().includes(query) || String(b.label || '').toLowerCase().includes(query))
    .map(b => b.id));
}
function matches(it, q, boxHits) {
  if (!q) return false;
  return [it.name, it.note, it.counter, it.seq, it.legacyLocation].some(v => String(v ?? '').toLowerCase().includes(q))
    || (it.places || []).some(p => p.qty > 0 && (String(p.box ?? '').toLowerCase().includes(q)
        || (boxHits && p.box && boxHits.has(p.box))));      // 箱子名命中 -> 里面的东西一起命中
}
const matchedIds = () => {
  if (!query) return new Set();
  const boxHits = matchedBoxIds();
  return new Set(inventory.items.filter(it => matches(it, query, boxHits)).map(it => it.id));
};

/* ---------- 写入：经 Cloudflare Worker 代理 ---------- */
const WORKER_URL_BUILTIN = 'https://storage.circleooneblood666.workers.dev';

const Cfg = {
  get: () => JSON.parse(localStorage.getItem('cfg') || '{}'),
  set: (c) => localStorage.setItem('cfg', JSON.stringify(c)),
  worker: () => (Cfg.get().workerUrl || WORKER_URL_BUILTIN || '').trim().replace(/\/+$/, ''),
  password: () => Cfg.get().password || '',
  who: () => Cfg.get().who || '',
  ready: () => !!Cfg.worker(),
  canEdit: () => !!Cfg.worker() && !!Cfg.password(),
};

async function api(payload) {
  const url = Cfg.worker();
  if (!url) throw new Error('尚未配置 Worker 地址');
  const r = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
  let j = {};
  try { j = await r.json(); } catch (e) { /* ignore */ }
  if (!r.ok) throw new Error(j.error || ('请求失败 ' + r.status));
  return j;
}

/** 所有写入的唯一入口：发 ops 补丁，服务端在最新数据上应用并返回权威结果。 */
async function commit(ops, opts = {}) {
  if (!requireEdit()) return false;
  const res = await api({
    type: 'inventory', password: Cfg.password(), by: Cfg.who(),
    ops, newImages: opts.newImages || [], message: opts.message || '更新库存',
  });
  if (res.inventory) { inventory = res.inventory; renderAll(); }
  return true;
}

/* ---------- ＋/− 的即时反馈 ----------
   每点一下就发一次请求太慢了：一趟 Worker→GitHub 读+写要一两秒，
   期间按钮还被禁用，连点五下有四下像没反应，而且会留下五个 commit。
   改成：内存里立刻改、界面立刻变，停手 700ms 后把这一串合并成一次提交。 */
const Pending = { ops: new Map(), timer: null, flushing: false };

function setPlaceLocal(it, box, qty) {
  it.places = it.places || [];
  const key = box ?? null;
  const p = it.places.find(x => (x.box ?? null) === key);
  if (qty <= 0) { if (p) it.places.splice(it.places.indexOf(p), 1); return; }
  if (p) p.qty = qty; else it.places.push({ box: key, qty });
}

function bumpPlace(itemId, box, delta) {
  if (!requireEdit()) return;
  const it = inventory.items.find(x => x.id === itemId);
  if (!it) return;
  const next = Math.max(0, placeQty(it, box) + delta);
  setPlaceLocal(it, box, next);
  Pending.ops.set(`${itemId}|${box ?? ''}`, { op: 'setPlace', id: itemId, box: box ?? null, qty: next });
  document.body.classList.add('saving');
  drawSheet();                                  // 只重画弹层，够快
  clearTimeout(Pending.timer);
  Pending.timer = setTimeout(flushPending, 700);
}

/** 把还没发出去的改动重新盖到最新数据上（ops 存的是绝对值，直接盖就对） */
function applyPendingLocally() {
  for (const op of Pending.ops.values()) {
    const it = inventory.items.find(x => x.id === op.id);
    if (it) setPlaceLocal(it, op.box, op.qty);
  }
}

async function flushPending() {
  clearTimeout(Pending.timer);
  if (Pending.flushing || !Pending.ops.size) return;
  Pending.flushing = true;
  const ops = [...Pending.ops.values()];
  Pending.ops.clear();
  const names = [...new Set(ops.map(o => {
    const it = inventory.items.find(x => x.id === o.id); return it ? (it.name || it.id) : o.id;
  }))];
  try {
    await commit(ops, { message: `改数量：${names.slice(0, 3).join('、')}${names.length > 3 ? ' 等' : ''}` });
    if (Pending.ops.size) { applyPendingLocally(); renderAll(); }   // 提交期间又点了，盖回去
    else toast('已保存');
  } catch (e) {
    toast('保存失败：' + e.message);
    Pending.ops.clear();
    await loadData();                            // 拉回服务端的真实状态
  } finally {
    Pending.flushing = false;
    drawSheet();
    if (Pending.ops.size) { Pending.timer = setTimeout(flushPending, 400); }
    else document.body.classList.remove('saving');
  }
}

function requireEdit() {
  if (!Cfg.worker()) { toast('请先到「设置」填入 Worker 地址'); switchTab('set'); return false; }
  if (!Cfg.password()) { toast('请先到「设置」填写编辑密码'); switchTab('set'); return false; }
  return true;
}

/* ---------- 数据加载 ---------- */
async function loadData() {
  // 先读静态文件（快），再从 Worker 拉一次最新的（绕开 Pages 构建延迟）
  try {
    inventory = await fetch(`./inventory.json?t=${Date.now()}`).then(r => r.json());
    renderAll();
  } catch (e) { toast('库存数据加载失败'); }
  if (Cfg.worker()) {
    try {
      const res = await api({ type: 'read' });
      if (res.inventory && JSON.stringify(res.inventory) !== JSON.stringify(inventory)) {
        inventory = res.inventory; renderAll();
      }
    } catch (e) { /* Worker 不可用不影响只读浏览 */ }
  }
}

function renderAll() {
  $('#title').textContent = inventory.title || '库存清单';
  renderInv(); renderModes(); renderShelf(); renderUnplaced();
}

/* ---------- 库存列表 ---------- */
function renderInv() {
  const ids = matchedIds();
  const items = query ? inventory.items.filter(it => ids.has(it.id)) : inventory.items;
  const sum = items.reduce((s, it) => s + total(it), 0);
  $('#count').textContent = `${items.length}/${inventory.items.length} 项 · ${sum} 件`;
  const list = $('#invList');
  if (!items.length) { list.innerHTML = `<div class="empty-state">没有匹配的物料</div>`; return; }
  list.innerHTML = items.map(it => {
    const thumb = it.photos && it.photos.length
      ? imgTag(it.photos[0], 'thumb')
      : `<div class="thumb empty">无图</div>`;
    const note = it.note ? `<div class="note">${esc(it.note)}</div>` : '';
    return `<div class="item" data-id="${esc(it.id)}">
      ${thumb}
      <div class="body">
        <div class="name"><span class="badge">${esc(it.seq)}</span> ${esc(it.name) || '<i>未命名</i>'}</div>
        <div class="meta"><span class="qty">${total(it)} 件</span></div>
        <div class="places">${placeSummary(it)}</div>
        ${note}
      </div>
    </div>`;
  }).join('');
}

/* ---------- 2.5D 货架（走廊视角）---------- */
/** 一个货架显示几列：至少 4 列，有箱子占到更靠右的槽位就跟着扩。
    按整个货架算而不是按层算，各层的格子才对得齐；也不再自动多露一个空位——
    要加箱子走右边那个 ＋，或者点层号进面板。 */
function rackCols(rackId) {
  const all = rackSlots(rackId), levels = rackLevels(rackId);
  let last = Math.min(3, all.length - 1);
  for (let lv = 1; lv <= levels; lv++)
    all.forEach((s, i) => { if (i > last && boxAt(rackId, lv, s)) last = i; });
  return all.slice(0, last + 1);
}
/** 这一层第一个还空着的槽位 */
function firstFreeSlot(rackId, level) {
  return rackSlots(rackId).find(s => !boxAt(rackId, level, s)) || null;
}

/** 视野：null=全部 / 'left' / 'right' / 某个货架 id。挤在一起看不清名字，摊开了才写得下 */
let focus = null;
const focusMode = () => !focus ? 'all' : ((focus === 'left' || focus === 'right') ? 'side' : 'rack');
const rackVisible = (r) => !focus || focus === r.side || focus === r.id;

function setFocus(k) { focus = k || null; renderShelf(); renderModes(); }

/** 右上角那个圆图标：没聚焦时是「放大看」，聚焦时变成醒目的返回键 */
const focusIco = (rid) => focus === rid
  ? `<span class="ico back" title="返回全部">↩</span>`
  : `<span class="ico" title="只看这里">⤢</span>`;

function renderModes() {
  const racks = L().racks || [];
  const chips = [{ k: '', t: '全部' }, { k: 'left', t: '左侧' }, { k: 'right', t: '右侧' }]
    .concat(racks.map(r => ({ k: r.id, t: r.name || r.id })));
  $('#shelfModes').innerHTML = chips.map(c =>
    `<button class="chip${(focus || '') === c.k ? ' on' : ''}" data-focus="${esc(c.k)}">${esc(c.t)}</button>`).join('');
}

function renderShelf() {
  const hits = matchedIds(), boxHits = matchedBoxIds();
  const wh = $('#warehouse');
  const racks = L().racks || [];
  wh.className = 'warehouse mode-' + focusMode() + (flatView() ? ' flat' : '');
  $('#viewToggle').style.display = focusMode() === 'all' ? '' : 'none';   // 只看一侧/一架时不倾斜，切换没意义
  if (!racks.length) { wh.innerHTML = `<div class="empty-state">还没有配置货架</div>`; renderShelfHint(); return; }
  // 左侧倒着排，让 1 号架紧挨通道，两边对称
  const pick = (s) => racks.filter(r => r.side === s && rackVisible(r))
    .sort((a, b) => ((a.order || 0) - (b.order || 0)) * (s === 'left' ? -1 : 1));
  const l = pick('left'), r = pick('right'), f = pick('front'), g = pick('floor');
  // 走廊里从左到右：左侧货架 → 尽头的墙 → 右侧货架。
  // 墙就摆在原来「通道」的位置——站在通道里看过去，尽头那面墙本来就在两排货架中间。
  const mk = `<i class="mk bl"></i><i class="mk br"></i>`;   // 量斜度用的角点，看不见
  const corridor =
    (l.length ? `<div class="side left">${l.map(x => rackHtml(x, hits, boxHits)).join('')}${mk}</div>` : '') +
    (f.length ? `<div class="side front">${f.map(x => rackHtml(x, hits, boxHits)).join('')}</div>` : '') +
    (r.length ? `<div class="side right">${r.map(x => rackHtml(x, hits, boxHits)).join('')}${mk}</div>` : '');
  wh.innerHTML =
    (corridor ? `<div class="corridor">${corridor}</div>` : '') +
    (g.length ? `<div class="side floor">${g.map(x => rackHtml(x, hits, boxHits)).join('')}</div>` : '');
  renderShelfHint();
  requestAnimationFrame(fitFloor);
}

/** 让地面梯形的两条斜边接着两侧货架的底边走 —— 光靠固定角度对不上，
    货架宽度一变斜度就变，所以在两侧各埋一个角点，量出投影后的实际斜率再裁形状。 */
function fitFloor() {
  const floor = $('#warehouse .side.floor .floor-plane');
  if (!floor) return;
  const wh = $('#warehouse');
  const tilted = !wh.classList.contains('flat') && focusMode() === 'all'
    && window.matchMedia('(min-width: 760px)').matches;
  const reset = () => {
    floor.style.clipPath = '';
    const h = $('#warehouse .side.floor .rack-head');
    if (h) { h.style.width = ''; h.style.marginLeft = ''; h.style.marginRight = ''; }
  };
  if (!tilted) { reset(); return; }

  const box = floor.getBoundingClientRect();
  if (box.height < 10) { reset(); return; }      // 页面还没显示，量不出来
  const wall = $('#warehouse .side.front');
  // 远端窄边贴着尽头那面墙的宽度，近端宽边张到两侧货架被转出去的最外沿，
  // 两条斜边于是就顺着货架倾斜的方向走。
  const outer = (sideSel, which) => {
    const el = $(`#warehouse .side.${sideSel} > .mk.${which}`);
    return el ? el.getBoundingClientRect().left : null;
  };
  const lOut = outer('left', 'bl'), rOut = outer('right', 'br');
  const w = wall ? wall.getBoundingClientRect() : null;
  if (lOut === null || rOut === null || !w) { reset(); return; }

  // 全张到最外沿会收得太狠、看着像座山，收一点让坡度平缓些
  const SPREAD = 0.72;
  const H = box.height;
  const px = (x) => Math.round(x - box.left);
  const nearL = w.left + (lOut - w.left) * SPREAD;
  const nearR = w.right + (rOut - w.right) * SPREAD;
  const pts = [[px(w.left), 0], [px(w.right), 0], [px(nearR), H], [px(nearL), H]];
  floor.style.clipPath = `polygon(${pts.map(p => `${p[0]}px ${p[1]}px`).join(',')})`;
  // 标题那一行的点击范围收成跟上底一样宽，免得看着在中间、边上却也能点到
  const head = $('#warehouse .side.floor .rack-head');
  if (head) {
    head.style.width = Math.round(w.width) + 'px';
    head.style.marginLeft = 'auto'; head.style.marginRight = 'auto';
  }
}

function renderShelfHint() {
  const el = $('#shelfHint');
  if (!query) {
    el.innerHTML = Cfg.canEdit()
      ? `点<b>层号</b>加箱子，点<b>箱子</b>看内容；<b>拖</b>托盘里的东西上架，<b>拖箱子</b>换位置（手机长按起拖）。`
      : `点<b>层号</b>加箱子，点<b>箱子</b>看里面装了什么。`;
    return;
  }
  // 统计从数据来、不从 DOM 来——被当前视野挡住的箱子也得算进去
  const ids = matchedIds();
  const boxes = new Set();
  let free = 0;
  for (const it of inventory.items) {
    if (!ids.has(it.id)) continue;
    for (const p of (it.places || [])) {
      if (!p.qty) continue;
      if (p.box) boxes.add(p.box); else free += p.qty;
    }
  }
  const named = matchedBoxIds();                       // 箱名/箱号本身被搜中的
  const other = [...boxes].filter(b => !named.has(b)); // 只是「里面装着命中物料」的
  const all = new Set([...boxes, ...named]);
  if (!all.size && !free) { el.innerHTML = `「${esc(query)}」没有匹配的物料或箱子`; return; }
  const where = [...new Set([...all].map(b => (rackById((boxById(b) || {}).rack) || {}).name || ''))].filter(Boolean);
  const parts = [];
  if (named.size) parts.push(`是 <b>${named.size}</b> 个箱子的名字`);
  if (other.length) parts.push(`在另外 <b>${other.length}</b> 个箱子里`);
  if (free) parts.push(`还有 <b>${free}</b> 件<b>未归位</b>（在下面的托盘）`);
  const hidden = [...all].filter(id => {
    const b = boxById(id), rk = b && rackById(b.rack);
    return rk && !rackVisible(rk);
  }).length;
  el.innerHTML = `🔦「${esc(query)}」${parts.join('，')}`
    + (where.length ? ` <i>· ${esc(where.join('、'))}</i>` : '')
    + (hidden ? ` <i>（其中 ${hidden} 个不在当前视野，点「全部」看）</i>` : '');
}

/** 搜到了就把命中的地方滚到眼前：托盘横着滚过去，货架上的箱子滚进视口 */
let revealTimer = null;
function revealHits() {
  clearTimeout(revealTimer);
  revealTimer = setTimeout(doReveal, 260);
}
function doReveal() {
  if (!query || !$('#page-shelf').classList.contains('active')) return;

  // 托盘横向居中。用 rect 算，不用 offsetLeft ——
  // .tray-item 的 offsetParent 是 body，offsetLeft 里混着整页的偏移，算出来会偏几百像素。
  const tray = $('#unplaced .tray');
  const th = tray && $('.tray-item.hit', tray);
  if (th) {
    const r = th.getBoundingClientRect(), t = tray.getBoundingClientRect();
    const want = tray.scrollLeft + (r.left - t.left) - (t.width - r.width) / 2;
    scrollTo1D(tray, Math.max(0, Math.round(want)));
  }

  const sh = $('#warehouse .slot.hit');
  if (sh) {
    scrollPageTo(sh, 'center');            // 在货架上：把那个箱子摆到视口正中
  } else if (th) {
    // 只在未归位里：把「未归位」这一栏顶到搜索框正下方。
    // 之前是把它居中，结果整屏都是空货架、命中的小卡片被挤在屏幕最底下。
    scrollPageTo($('#unplaced'), 'top');
  }
}
/** 距离远就直接跳，别让人盯着它飞半天 */
const jump = (d) => Math.abs(d) > 1200 ? 'auto' : 'smooth';
/** 顶栏和搜索框是 sticky 的，滚到「顶部」要把它们的高度让出来 */
function stickyTop() {
  const tb = $('.topbar'), sb = $('#page-shelf .searchbar');
  return (tb ? tb.offsetHeight : 0) + (sb ? sb.offsetHeight : 0) + 8;
}
function scrollPageTo(el, where) {
  const r = el.getBoundingClientRect();
  const y = where === 'top'
    ? window.scrollY + r.top - stickyTop()
    : window.scrollY + r.top + r.height / 2 - window.innerHeight / 2;
  window.scrollTo({ top: Math.max(0, Math.round(y)), behavior: jump(y - window.scrollY) });
}
function scrollTo1D(el, left) {
  const d = left - el.scrollLeft;
  if (Math.abs(d) < 2) return;
  el.scrollTo({ left, behavior: jump(d) });
}

function rackHtml(rack, hits, boxHits) {
  const levels = [];
  for (let lv = rackLevels(rack.id); lv >= 1; lv--) levels.push(levelHtml(rack, lv, hits, boxHits));
  const n = L().boxes.filter(b => b.rack === rack.id).length;
  return `<div class="rack" data-rack="${esc(rack.id)}">
    <button class="rack-head" data-focus="${focus === rack.id ? '' : esc(rack.id)}"
            title="${focus === rack.id ? '点一下退回全部' : '点一下只看这个货架'}">
      <b>${esc(rack.name || rack.id)}</b><span class="cnt">${n} 箱</span>${focusIco(rack.id)}
    </button>
    ${rack.side === 'floor' ? '<div class="floor-plane"></div>' : ''}
    <div class="levels">${levels.join('')}</div>
  </div>`;
}

function levelHtml(rack, lv, hits, boxHits) {
  const zoomed = focusMode() !== 'all';       // 摊开看的时候才让直接点着加箱子
  const slots = rackCols(rack.id).map(s => {
    const box = boxAt(rack.id, lv, s);
    if (!box) return zoomed
      ? `<button class="slot empty" data-add="${esc(rack.id)}|${lv}|${esc(s)}" title="在 ${esc(rack.id)}-${lv}-${esc(s)} 加个箱子">${esc(s)}</button>`
      : `<span class="slot empty idle">${esc(s)}</span>`;   // 整体视图只标位置，不当按钮
    const inside = itemsInBox(box.id);
    const pieces = inside.reduce((a, x) => a + x.qty, 0);
    const selfHit = !!(boxHits && boxHits.has(box.id));      // 箱子名/箱号被搜中
    const hit = selfHit || inside.some(x => hits.has(x.item.id));
    const hitN = inside.filter(x => hits.has(x.item.id)).reduce((a, x) => a + x.qty, 0);
    // 名单只在「左侧/右侧/单个货架」这些摊得开的视野下显示（CSS 控制），窄视野里塞不下
    // 名单只列名字不列数量：一眼看「有什么」，具体几件点进箱子面板看（鼠标悬停也能看到）
    const names = inside.length
      ? inside.map(x => `<span class="s-item${hits.has(x.item.id) ? ' hit' : ''}"` +
          ` title="${esc(x.item.name) || x.item.id} ×${x.qty}">${esc(x.item.name) || x.item.id}</span>`).join('')
      : `<span class="s-item empty">空箱</span>`;
    return `<button class="slot box${hit ? ' hit' : ''}${pieces ? '' : ' vacant'}" data-box="${esc(box.id)}" data-drag="box">
      <span class="s-id">${esc(s)}</span>
      <span class="s-label${box.label ? '' : ' dflt'}${selfHit ? ' lbl-hit' : ''}">${esc(box.label || '箱子')}</span>
      <span class="s-n">${inside.length ? `${inside.length}种·${pieces}件` : '空'}</span>
      <span class="s-items">${names}</span>
      ${hit ? `<span class="s-hit">${hitN}</span>` : ''}
    </button>`;
  }).join('');
  // 摊开看时右端挂一个窄 ＋，代替「自动多露一个空位」
  const free = firstFreeSlot(rack.id, lv);
  const add = (zoomed && Cfg.canEdit() && free)
    ? `<button class="slot add" data-add="${esc(rack.id)}|${lv}|${esc(free)}" title="在第 ${lv} ${levelWord(rack.id)}加个箱子（${esc(rack.id)}-${lv}-${esc(free)}）">＋</button>`
    : '';
  return `<div class="level">
    <button class="level-tag" data-level="${esc(rack.id)}|${lv}" title="第 ${lv} ${levelWord(rack.id)}：加/删箱子">${lv}</button>
    <div class="slots">${slots}${add}</div>
  </div>`;
}

/* ---------- 未归位托盘 ---------- */
function renderUnplaced() {
  const hits = matchedIds();
  const all = inventory.items.map(it => ({ it, qty: placeQty(it, null) })).filter(x => x.qty > 0);
  // 搜索时托盘只留匹配的：88 个小卡片里挑一个高亮，眼睛还是得自己找
  const list = query ? all.filter(x => hits.has(x.it.id)) : all;
  const el = $('#unplaced');
  if (!all.length) { el.innerHTML = `<div class="tray-head">📥 未归位 <span>全部已上架 🎉</span></div>`; return; }
  if (!list.length) {
    el.innerHTML = `<div class="tray-head">📥 未归位 <span>没有匹配「${esc(query)}」的，${all.length} 种未归位</span></div>`;
    return;
  }
  const sum = list.reduce((s, x) => s + x.qty, 0);
  const head = query
    ? `📥 未归位 · 匹配「${esc(query)}」<span>${list.length} 种 · ${sum} 件（共 ${all.length} 种未归位）</span>`
    : `📥 未归位 <span>${list.length} 种 · ${sum} 件</span>`;
  el.innerHTML = `<div class="tray-head">${head}</div>
    <div class="tray">${list.map(x => `
      <button class="tray-item${hits.has(x.it.id) ? ' hit' : ''}" data-place="${esc(x.it.id)}"
              data-drag="item" data-qty="${x.qty}">
        ${x.it.photos && x.it.photos[0] ? imgTag(x.it.photos[0]) : '<i class="noimg">无图</i>'}
        <span class="t-name">${esc(x.it.name) || '未命名'}</span>
        <span class="t-qty">×${x.qty}</span>
      </button>`).join('')}</div>`;
}

/* ---------- 弹层（带返回栈）---------- */
let sheetStack = [];
function openSheet(fn) { sheetStack.push(fn); drawSheet(); showSheet(); }
function replaceSheet(fn) { sheetStack = [fn]; drawSheet(); showSheet(); }
function backSheet() { sheetStack.pop(); if (!sheetStack.length) return hideSheet(); drawSheet(); }
function drawSheet() { const fn = sheetStack[sheetStack.length - 1]; if (fn) fn($('#sheet')); }
function showSheet() { $('#sheetMask').classList.add('show'); $('#sheet').classList.add('show'); }
function hideSheet() {
  $('#sheetMask').classList.remove('show'); $('#sheet').classList.remove('show');
  sheetStack = []; editingId = null; pendingPhotos = [];
  flushPending();                       // 关掉弹层就别再等那 700ms 了
}
const backBtn = () => sheetStack.length > 1 ? `<button class="sheet-back" id="sBack">‹ 返回</button>` : '';
function wireBack(el) { const b = $('#sBack', el); if (b) b.onclick = backSheet; }

/** 包一层：动作执行中禁用按钮，失败弹 toast */
async function guard(btn, label, fn) {
  const old = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = label; }
  try { await fn(); }
  catch (e) { toast('失败：' + e.message); }
  finally { if (btn && btn.isConnected) { btn.disabled = false; btn.textContent = old; } }
}

/* ---------- 物料详情 ---------- */
function openItem(id) {
  openSheet((el) => {
    const it = inventory.items.find(x => x.id === id);
    if (!it) return backSheet();
    // 详情条带用缩略图，点开灯箱才拉原图
    const photos = (it.photos || []).map(p =>
      `<img src="./${esc(thumbOf(p))}" data-full="./${esc(p)}" alt="" onerror="this.onerror=null;this.src='./${esc(p)}'">`).join('');
    const places = (it.places || []).filter(p => p.qty > 0);
    const rows = places.length ? places.map(p => `
      <div class="place-row" data-box="${esc(p.box ?? '')}">
        <span class="pr-where${p.box ? '' : ' none'}">${esc(boxName(p.box))}</span>
        <span class="pr-qty">×${p.qty}</span>
        <button class="mini" data-d="-1">−</button>
        <button class="mini" data-d="1">＋</button>
        <button class="mini move">移动</button>
      </div>`).join('') : `<div class="hint">这条还没有任何数量</div>`;
    el.innerHTML = `${backBtn()}
      <h2>${esc(it.name) || '未命名'} <span class="badge">序号 ${esc(it.seq)}</span></h2>
      ${photos ? `<div class="detail-photos">${photos}</div>` : ''}
      <div class="kv"><div class="k">总数量</div><div class="v"><b>${total(it)}</b> 件</div></div>
      ${it.counter ? `<div class="kv"><div class="k">盘点人</div><div class="v">${esc(it.counter)}</div></div>` : ''}
      ${it.note ? `<div class="kv"><div class="k">备注</div><div class="v">${esc(it.note)}</div></div>` : ''}
      ${it.legacyLocation ? `<div class="kv"><div class="k">旧位置</div><div class="v">${esc(it.legacyLocation)} <i class="hint">（旧编号，待认领）</i></div></div>` : ''}
      <h3>存放分布</h3>
      ${rows}
      <div class="btns">
        <button class="btn ghost" id="iPut">放进箱子</button>
        <button class="btn ghost" id="iEdit">编辑</button>
        <button class="btn danger" id="iDel">删除</button>
      </div>`;
    wireBack(el);
    $$('.detail-photos img', el).forEach(img => img.onclick = () => openLightbox(img.dataset.full));
    $$('.place-row', el).forEach(row => {
      const box = row.dataset.box || null;
      $$('.mini', row).forEach(b => b.onclick = () => {
        if (b.classList.contains('move')) return openMove(it.id, box);
        bumpPlace(it.id, box, +b.dataset.d);
      });
    });
    $('#iPut', el).onclick = () => openMove(it.id, null);
    $('#iEdit', el).onclick = () => openEdit(it.id);
    $('#iDel', el).onclick = async () => {
      if (!confirm(`确认删除「${it.name || it.id}」？总共 ${total(it)} 件都会消失。`)) return;
      await guard($('#iDel', el), '删除中…', async () => {
        await commit([{ op: 'delItem', id: it.id }], { message: `删物料：${it.name || it.id}` });
        hideSheet(); toast('已删除');
      });
    };
  });
}

/* ---------- 移动 / 归位 ---------- */
function openMove(itemId, fromBox) {
  openSheet((el) => {
    const it = inventory.items.find(x => x.id === itemId);
    if (!it) return backSheet();
    const have = placeQty(it, fromBox);
    const boxes = L().boxes.slice().sort((a, b) => a.id.localeCompare(b.id));
    el.innerHTML = `${backBtn()}
      <h2>移动「${esc(it.name) || it.id}」</h2>
      <div class="hint">从 <b>${esc(boxName(fromBox))}</b> 里现有 <b>${have}</b> 件</div>
      <div class="field"><label>移动数量</label><input id="mQty" type="number" min="1" max="${have}" value="${have}"></div>
      <div class="field"><label>移到哪里</label>
        <select id="mTo">
          ${fromBox ? `<option value="">未归位（拿下货架）</option>` : ''}
          ${boxes.filter(b => b.id !== fromBox).map(b => `<option value="${esc(b.id)}">${esc(boxName(b.id))}</option>`).join('')}
        </select>
      </div>
      ${boxes.length ? '' : `<div class="hint">还没有任何箱子，先去「货架」页建一个。</div>`}
      <div class="btns"><button class="btn ghost" id="mCancel">取消</button><button class="btn primary" id="mOk">移动</button></div>`;
    wireBack(el);
    $('#mCancel', el).onclick = backSheet;
    $('#mOk', el).onclick = () => {
      const qty = Math.min(have, Math.max(1, parseInt($('#mQty', el).value, 10) || 0));
      const to = $('#mTo', el).value || null;
      if (!qty) return toast('数量要大于 0');
      if (to === null && fromBox === null) return toast('目的地和来源一样');
      guard($('#mOk', el), '移动中…', async () => {
        await commit([{ op: 'move', id: it.id, from: fromBox, to, qty }],
          { message: `移库：${it.name || it.id} ${boxName(fromBox)}→${boxName(to)} ×${qty}` });
        toast('已移动'); backSheet();
      });
    };
  });
}

/* ---------- 箱子面板 ---------- */
function openBox(boxId) {
  openSheet((el) => {
    const b = boxById(boxId);
    if (!b) return backSheet();
    const inside = itemsInBox(boxId);
    const rack = rackById(b.rack);
    const rows = inside.length ? inside.map(x => `
      <div class="place-row" data-id="${esc(x.item.id)}">
        ${x.item.photos && x.item.photos[0] ? imgTag(x.item.photos[0], 'pr-img') : ''}
        <span class="pr-where">${esc(x.item.name) || x.item.id}</span>
        <span class="pr-qty">×${x.qty}</span>
        <button class="mini" data-d="-1">−</button>
        <button class="mini" data-d="1">＋</button>
        <button class="mini move">移出</button>
      </div>`).join('') : `<div class="hint">这个箱子是空的。</div>`;
    const open = !!b.open;
    el.innerHTML = `${backBtn()}
      <h2>${open ? '📍' : '📦'} ${esc(open ? (rack ? rack.name : b.rack) : b.id)}</h2>
      ${open
        ? `<div class="hint">这块区域不分格子，东西直接放在这儿。</div>`
        : `<div class="hint">${esc(rack ? rack.name : b.rack)} · 第 ${b.level} ${levelWord(b.rack)} · ${esc(b.slot)} 位</div>
           <div class="field"><label>箱子标签（写在实体箱上的那个）</label><input id="bLabel" value="${esc(b.label || '')}" placeholder="例如 礼盒 / 纸袋"></div>`}
      <h3>${open ? '这里放着' : '箱内物料'}（${inside.length} 种 · ${inside.reduce((a, x) => a + x.qty, 0)} 件）</h3>
      ${rows}
      <div class="btns">
        <button class="btn ${open ? 'primary' : 'ghost'}" id="bAdd">放入物料</button>
        ${open ? '' : `<button class="btn primary" id="bSave">保存标签</button>`}
      </div>
      ${open ? '' : `<div class="btns"><button class="btn danger" id="bDel">删除这个箱子</button></div>`}`;
    wireBack(el);
    $$('.place-row', el).forEach(row => {
      const it = inventory.items.find(x => x.id === row.dataset.id);
      $$('.mini', row).forEach(btn => btn.onclick = () => {
        if (btn.classList.contains('move')) return openMove(it.id, boxId);
        bumpPlace(it.id, boxId, +btn.dataset.d);
      });
    });
    if ($('#bSave', el)) $('#bSave', el).onclick = () => guard($('#bSave', el), '保存中…', async () => {
      await commit([{ op: 'setBox', id: boxId, label: $('#bLabel', el).value.trim() }], { message: `箱 ${boxId} 改标签` });
      toast('已保存');
    });
    $('#bAdd', el).onclick = () => openPicker(boxId);
    if ($('#bDel', el)) $('#bDel', el).onclick = async () => {     // 地面 / 正面墙是固定区域，没有这个按钮
      const n = inside.length;
      const msg = n ? `${boxId} 里还有 ${n} 种物料。删除后它们会退回「未归位」，确定？` : `确认删除箱子 ${boxId}？`;
      if (!confirm(msg)) return;
      await guard($('#bDel', el), '删除中…', async () => {
        await commit([{ op: 'delBox', id: boxId, force: true }], { message: `删箱：${boxId}` });
        toast('已删除'); backSheet();
      });
    };
  });
}

/** 选一个物料放进某个箱子 */
function openPicker(boxId) {
  let pq = '';
  openSheet((el) => {
    const cands = inventory.items
      .map(it => ({ it, free: placeQty(it, null) }))
      .filter(x => !pq || String(x.it.name || '').toLowerCase().includes(pq) || String(x.it.seq).includes(pq));
    el.innerHTML = `${backBtn()}
      <h2>放进 ${esc(boxName(boxId))}</h2>
      <div class="field"><input id="pQ" placeholder="搜物料名 / 序号…" value="${esc(pq)}"></div>
      <div class="picker">${cands.slice(0, 60).map(x => `
        <button class="pick" data-id="${esc(x.it.id)}">
          <span class="p-name">${esc(x.it.name) || x.it.id}</span>
          <span class="p-free">${x.free ? `未归位 ${x.free}` : `总 ${total(x.it)}`}</span>
        </button>`).join('') || '<div class="hint">没有匹配</div>'}</div>`;
    wireBack(el);
    const q = $('#pQ', el);
    q.oninput = () => { pq = q.value.trim().toLowerCase(); drawSheet(); $('#pQ').focus(); };
    $$('.pick', el).forEach(btn => btn.onclick = () => {
      const it = inventory.items.find(x => x.id === btn.dataset.id);
      const free = placeQty(it, null);
      const n = parseInt(prompt(`放多少个「${it.name || it.id}」进 ${boxName(boxId)}？\n（未归位还有 ${free} 个）`, String(free || 1)), 10);
      if (!n || n <= 0) return;
      guard(btn, '…', async () => {
        if (n <= free) {
          await commit([{ op: 'move', id: it.id, from: null, to: boxId, qty: n }], { message: `入箱：${it.name || it.id} → ${boxId} ×${n}` });
        } else {
          // 未归位不够：直接把箱内数量加上去（相当于新点出来的货）
          await commit([{ op: 'setPlace', id: it.id, box: boxId, qty: placeQty(it, boxId) + n }], { message: `入箱：${it.name || it.id} → ${boxId} ×${n}` });
        }
        toast('已放入'); backSheet();
      });
    });
  });
}

/* ---------- 层面板：加箱子 ---------- */
function openLevel(rackId, level) {
  openSheet((el) => {
    const rack = rackById(rackId);
    const slots = rackSlots(rackId);
    const used = slots.filter(s => boxAt(rackId, level, s));
    const freeSlots = slots.filter(s => !boxAt(rackId, level, s));
    el.innerHTML = `${backBtn()}
      <h2>${esc(rack ? rack.name : rackId)} · 第 ${level} ${levelWord(rackId)}</h2>
      <div class="hint">槽位从左到右 ${slots.join(' ')}，已有 ${used.length} 个箱子。<br>
        删掉中间的箱子不会让后面的往前挪——实体箱上的标签才不会错乱。</div>
      <div class="slot-grid">${slots.map(s => {
        const b = boxAt(rackId, level, s);
        return b
          ? `<button class="sg has" data-open="${esc(b.id)}"><b>${esc(s)}</b><span>${esc(b.label || '箱子')}</span></button>`
          : `<button class="sg" data-new="${esc(s)}"><b>${esc(s)}</b><span>空位</span></button>`;
      }).join('')}</div>
      <div class="btns">
        <button class="btn primary" id="lFill" ${freeSlots.length ? '' : 'disabled'}>一键铺满前 4 个槽位</button>
      </div>`;
    wireBack(el);
    $$('.sg[data-open]', el).forEach(b => b.onclick = () => openBox(b.dataset.open));
    $$('.sg[data-new]', el).forEach(b => b.onclick = () => guard(b, '…', async () => {
      await commit([{ op: 'addBox', box: { rack: rackId, level, slot: b.dataset.new } }],
        { message: `加箱：${rackId}-${level}-${b.dataset.new}` });
      toast('已加箱');
    }));
    $('#lFill', el).onclick = () => guard($('#lFill', el), '创建中…', async () => {
      const ops = slots.slice(0, 4).filter(s => !boxAt(rackId, level, s))
        .map(s => ({ op: 'addBox', box: { rack: rackId, level, slot: s } }));
      if (!ops.length) return toast('前 4 个槽位已经满了');
      await commit(ops, { message: `铺满 ${rackId} 第 ${level} 层` });
      toast(`已建 ${ops.length} 个箱子`);
    });
  });
}

/* ---------- 新增 / 编辑物料 ---------- */
function openEdit(id) {
  editingId = id; pendingPhotos = [];
  const it0 = id ? inventory.items.find(x => x.id === id) : null;
  // 数量在这儿直接改：每个存放位置一行，可以点 ＋/− 也可以直接把数字敲进去。
  // 存副本，取消就当没发生过。
  const edited = (it0 ? (it0.places || []).filter(p => p.qty > 0) : [{ box: null, qty: 0 }])
    .map(p => ({ box: p.box ?? null, qty: p.qty }));
  if (!edited.length) edited.push({ box: null, qty: 0 });

  openSheet((el) => {
    const cur = it0 || { seq: nextSeq(), name: '', note: '', counter: '', photos: [] };
    el.innerHTML = `${backBtn()}
      <h2>${id ? '编辑物料' : '新增物料'}</h2>
      <div class="field"><label>名称</label><input id="fName" value="${esc(cur.name)}"></div>
      <div class="row2">
        <div class="field"><label>序号</label><input id="fSeq" type="number" value="${esc(cur.seq)}"></div>
        <div class="field"><label>盘点人</label><input id="fCounter" value="${esc(cur.counter)}"></div>
      </div>
      <h3>数量与位置</h3>
      <div id="qRows"></div>
      <div class="hint sub">每一行改的是<b>那个位置上</b>的数量；改「合计」是加减这条物料的<b>总数</b>，多出来/少掉的算在「未归位」上。</div>
      <div class="field"><label>备注</label><textarea id="fNote">${esc(cur.note)}</textarea></div>
      <div class="field"><label>照片</label><div class="photos-edit" id="phEdit"></div></div>
      <input type="file" id="fFiles" accept="image/*" multiple hidden>
      <div class="btns">
        <button class="btn ghost" id="eCancel">取消</button>
        <button class="btn primary" id="eSave">保存</button>
      </div>`;
    wireBack(el);
    const keepPhotos = (cur.photos || []).slice();     // 副本，取消时不影响内存里的原数据
    renderPhotoEdit(keepPhotos);
    renderQtyRows(edited);
    $('#eCancel', el).onclick = () => sheetStack.length > 1 ? backSheet() : hideSheet();
    $('#fFiles', el).onchange = (e) => {
      for (const f of e.target.files) pendingPhotos.push({ file: f, url: URL.createObjectURL(f) });
      e.target.value = ''; renderPhotoEdit(keepPhotos);
    };
    $('#eSave', el).onclick = () => saveItem(id, cur, keepPhotos, edited, el);
  });
}

/** 编辑弹层里的「数量与位置」：每行一个位置，＋/− 或直接敲数字 */
function renderQtyRows(edited) {
  const wrap = $('#qRows');
  if (!wrap) return;
  const used = new Set(edited.map(p => p.box ?? ''));
  const free = [null, ...L().boxes.map(b => b.id)].filter(b => !used.has(b ?? ''));
  const sumAll = () => edited.reduce((s, p) => s + (p.qty || 0), 0);
  const placed = () => edited.reduce((s, p) => s + (p.box ? (p.qty || 0) : 0), 0);
  wrap.innerHTML = `
    <div class="qrow total">
      <span class="q-where"><b>合计</b></span>
      <button class="mini" data-td="-1">−</button>
      <input class="q-num" id="qTotalNum" type="number" inputmode="numeric" min="0" value="${sumAll()}">
      <button class="mini" data-td="1">＋</button>
      <span class="q-unit">件</span>
    </div>` + edited.map((p, i) => `
    <div class="qrow" data-i="${i}">
      <span class="q-where${p.box ? '' : ' none'}">${esc(boxName(p.box))}</span>
      <button class="mini" data-d="-1">−</button>
      <input class="q-num" type="number" inputmode="numeric" min="0" value="${p.qty}">
      <button class="mini" data-d="1">＋</button>
      <button class="mini del" title="从这里清空">✕</button>
    </div>`).join('')
    + (free.length ? `<div class="qadd">
        <select id="qNew"><option value="__">＋ 加一个存放位置…</option>
          ${free.map(b => `<option value="${esc(b ?? '')}">${esc(boxName(b))}</option>`).join('')}
        </select></div>` : '');

  const paint = () => { const t = $('#qTotalNum', wrap); if (t) t.value = sumAll(); };

  /** 改总数：差额记在「未归位」上。已经上架的不会被偷偷拿走，所以总数不能低于已上架的数。 */
  const setTotal = (v) => {
    const floor = placed();
    const want = Math.max(0, Math.floor(Number(v) || 0));
    if (want < floor) toast(`已经上架了 ${floor} 件，总数不能更少；要减就改对应位置那一行`);
    const free0 = Math.max(0, want - floor);
    const row = edited.find(p => !p.box);
    if (row) row.qty = free0; else if (free0) edited.push({ box: null, qty: free0 });
    renderQtyRows(edited);
  };
  const tNum = $('#qTotalNum', wrap);
  tNum.onchange = () => setTotal(tNum.value);
  $$('.qrow.total .mini', wrap).forEach(b => b.onclick = () => setTotal(sumAll() + (+b.dataset.td)));

  $$('.qrow:not(.total)', wrap).forEach(row => {
    const i = +row.dataset.i, num = $('.q-num', row);
    num.oninput = () => { edited[i].qty = Math.max(0, parseInt(num.value, 10) || 0); paint(); };
    $$('.mini', row).forEach(b => b.onclick = () => {
      if (b.classList.contains('del')) { edited.splice(i, 1); if (!edited.length) edited.push({ box: null, qty: 0 }); return renderQtyRows(edited); }
      edited[i].qty = Math.max(0, (edited[i].qty || 0) + (+b.dataset.d));
      num.value = edited[i].qty; paint();
    });
  });
  const sel = $('#qNew', wrap);
  if (sel) sel.onchange = () => {
    if (sel.value === '__') return;
    edited.push({ box: sel.value || null, qty: 1 });
    renderQtyRows(edited);
  };
}

function renderPhotoEdit(existing) {
  const ex = existing.map((p, i) => `<div class="ph">${imgTag(p)}<button class="del" data-ex="${i}">×</button></div>`).join('');
  const np = pendingPhotos.map((p, i) => `<div class="ph"><img src="${p.url}" alt=""><button class="del" data-np="${i}">×</button></div>`).join('');
  const wrap = $('#phEdit');
  wrap.innerHTML = ex + np + `<button class="add" id="phAdd">＋</button>`;
  $('#phAdd').onclick = () => $('#fFiles').click();
  $$('#phEdit .del').forEach(b => b.onclick = () => {
    if (b.dataset.ex != null) existing.splice(+b.dataset.ex, 1);
    else pendingPhotos.splice(+b.dataset.np, 1);
    renderPhotoEdit(existing);
  });
}

const nextSeq = () => { const ns = inventory.items.map(i => +i.seq).filter(n => !isNaN(n)); return ns.length ? Math.max(...ns) + 1 : 1; };
const nextId = () => { const ns = inventory.items.map(i => parseInt(i.id, 10)).filter(n => !isNaN(n)); return String((ns.length ? Math.max(...ns) : 0) + 1).padStart(3, '0'); };

async function saveItem(id, cur, keepPhotos, edited, el) {
  const btn = $('#eSave', el);
  const itemId = id || nextId();
  const name = $('#fName', el).value.trim();
  if (!name && !keepPhotos.length && !pendingPhotos.length) return toast('至少填个名称');
  await guard(btn, '保存中…', async () => {
    const newImages = [];
    const photos = keepPhotos.slice();
    let k = 0;
    for (const p of pendingPhotos) {
      btn.textContent = `处理图片 ${++k}/${pendingPhotos.length}…`;
      const path = `images/${itemId}-${Date.now()}-${k}.jpg`;
      newImages.push({ path, b64: await fileToB64(p.file) });
      newImages.push({ path: thumbOf(path), b64: await fileToThumbB64(p.file) });  // 缩略图一起传
      photos.push(path);
    }
    btn.textContent = '提交…';
    const item = {
      id: itemId, seq: parseFloat($('#fSeq', el).value) || nextSeq(), name,
      note: $('#fNote', el).value.trim(), counter: $('#fCounter', el).value.trim(), photos,
    };
    const ops = [];
    if (!id) {                                   // 新物料：直接把填好的数量带上
      item.places = edited.filter(p => p.qty > 0).map(p => ({ box: p.box, qty: p.qty }));
      ops.push({ op: 'setItem', item });
    } else {
      // 编辑：setItem 不带 places（免得覆盖别人刚做的归位），
      // 数量只对「真改动过的位置」发 setPlace —— 精准打补丁，不整条覆盖
      ops.push({ op: 'setItem', item });
      const before = new Map((cur.places || []).filter(p => p.qty > 0).map(p => [p.box ?? '', p.qty]));
      const after = new Map(edited.filter(p => p.qty > 0).map(p => [p.box ?? '', p.qty]));
      for (const k of new Set([...before.keys(), ...after.keys()])) {
        const a = after.get(k) || 0;
        if (a !== (before.get(k) || 0)) ops.push({ op: 'setPlace', id: itemId, box: k || null, qty: a });
      }
    }
    await commit(ops, { newImages, message: `${id ? '改' : '加'}物料：${name || itemId}` });
    toast('已保存'); hideSheet();
  });
}

/* ---------- 视角：侧视（走廊透视）/ 正视（不倾斜）---------- */
const flatView = () => localStorage.getItem('shelfFlat') === '1';
function setFlatView(v) {
  localStorage.setItem('shelfFlat', v ? '1' : '0');
  applyView(); fitFloor();
  setTimeout(fitFloor, 450);            // 倾斜动画放完再对一次
}
function applyView() {
  const flat = flatView();
  $('#warehouse').classList.toggle('flat', flat);
  const b = $('#viewToggle');
  b.textContent = flat ? '正视' : '侧视';
  b.title = flat ? '当前正视，点一下转成走廊侧视' : '当前走廊侧视，点一下转正';
}

/* ---------- 灯箱 / tab / 设置 ---------- */
function openLightbox(src) { $('#lightboxImg').src = src; $('#lightbox').classList.add('show'); }
function switchTab(tab) {
  $$('.tabbar button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  $$('.page').forEach(p => p.classList.remove('active'));
  $(`#page-${tab}`).classList.add('active');
  $('#fabAdd').style.display = tab === 'inv' ? '' : 'none';
  // 切页时页面刚显示，等一帧再量尺寸（display:none 的时候什么都量不出来）
  if (tab === 'shelf') requestAnimationFrame(() => { fitFloor(); if (query) doReveal(); });
}

function loadCfgForm() {
  const c = Cfg.get();
  $('#cfgWorker').value = c.workerUrl || '';
  $('#cfgWho').value = c.who || '';
  $('#cfgPassword').value = '';        // 从不回填密码：一打开设置就明晃晃摆着不合适
  updatePwState();
  updateStatusDot();
}
function updatePwState() {
  const has = !!Cfg.password();
  $('#pwState').textContent = has
    ? '✅ 这台设备已经记住密码了。留空保存不会动它。'
    : '这台设备还没存密码，现在只能浏览。输入一次就会记在本机（只存这台设备，不上传）。';
  $('#cfgClear').parentElement.style.display = has ? '' : 'none';
}
function saveCfg() {
  const typed = $('#cfgPassword').value.trim();
  const cur = Cfg.get();
  Cfg.set({
    workerUrl: $('#cfgWorker').value.trim(),
    who: $('#cfgWho').value.trim(),
    password: typed || cur.password || '',     // 留空 = 保持原样，不是清空
  });
  $('#cfgPassword').value = '';
  updatePwState(); updateStatusDot(); renderShelf(); toast('已保存设置');
}
function clearCfgPassword() {
  const c = Cfg.get(); delete c.password; Cfg.set(c);
  $('#cfgPassword').value = '';
  updatePwState(); updateStatusDot(); renderShelf();
  $('#cfgStatus').textContent = '';
  toast('已清除本机密码，现在是只读状态');
}
async function testCfg() {
  saveCfg();
  $('#cfgStatus').textContent = '测试中…';
  try {
    const res = await api({ type: 'verify', password: Cfg.password() });
    $('#cfgStatus').textContent = res.ok ? '✅ Worker 正常，密码正确，可以改库存' : '⚠️ Worker 正常，但密码不对（还能浏览）';
  } catch (e) { $('#cfgStatus').textContent = '❌ ' + e.message; }
}
function updateStatusDot() {
  const d = $('#statusDot');
  d.className = 'status-dot ' + (Cfg.canEdit() ? 'ok' : (Cfg.ready() ? '' : 'bad'));
  d.title = Cfg.canEdit() ? '可编辑' : (Cfg.ready() ? '只读（改库存需密码）' : '未配置 Worker');
}

/* ---------- 拖拽：把未归位的东西拖上货架，把箱子拖到别的槽位 ----------
   用 Pointer Events 而不是 HTML5 的 drag-and-drop —— 后者在手机上根本不工作，
   而这网站主要就是在仓库现场用手机开的。
   手机上「长按 220ms」才起拖，之前的滑动留给页面滚动和托盘横滑；鼠标则移动几像素就起拖。 */
const DRAG = { st: null, clickGuard: false };

const tryRun = async (fn, label) => { try { await fn(); } catch (e) { toast(label + '：' + e.message); } };

function onPointerDown(e) {
  if (!e.isPrimary || e.button > 0) return;
  const el = e.target.closest && e.target.closest('[data-drag]');
  if (!el || !Cfg.canEdit()) return;              // 没编辑权限就别劫持手势
  const kind = el.dataset.drag;
  const st = DRAG.st = {
    kind, el, pointerId: e.pointerId, moving: false, timer: null,
    startX: e.clientX, startY: e.clientY, x: e.clientX, y: e.clientY,
    id: kind === 'item' ? el.dataset.place : el.dataset.box,
  };
  if (e.pointerType !== 'mouse') st.timer = setTimeout(startDrag, 220);
}

function startDrag() {
  const st = DRAG.st;
  if (!st || st.moving) return;
  st.moving = true;
  const r = st.el.getBoundingClientRect();
  st.ox = st.x - r.left; st.oy = st.y - r.top;
  const g = st.el.cloneNode(true);
  g.classList.add('drag-ghost');
  g.style.width = r.width + 'px'; g.style.height = r.height + 'px';
  document.body.appendChild(g);
  st.ghost = g;
  st.el.classList.add('drag-src');
  document.body.classList.add('dragging', st.kind === 'item' ? 'drag-item' : 'drag-box');
  if (navigator.vibrate) navigator.vibrate(12);
  moveGhost();
}

function moveGhost() {
  const st = DRAG.st;
  if (st && st.ghost) st.ghost.style.transform = `translate(${st.x - st.ox}px, ${st.y - st.oy}px)`;
}

function onPointerMove(e) {
  const st = DRAG.st;
  if (!st || e.pointerId !== st.pointerId) return;
  st.x = e.clientX; st.y = e.clientY;
  if (!st.moving) {
    const moved = Math.abs(st.x - st.startX) + Math.abs(st.y - st.startY);
    if (e.pointerType === 'mouse') { if (moved > 4) startDrag(); }
    else if (moved > 10) { clearTimeout(st.timer); DRAG.st = null; }   // 是在滚动，不是拖
    return;
  }
  e.preventDefault();
  moveGhost(); hitTest(); edgeScroll();
}

function validTarget(st, slot) {
  if (st.kind === 'item') return true;                    // 物料：已有的箱子和空槽位都能落
  return slot.classList.contains('empty');                // 箱子：只能挪到空槽位
}

function hitTest() {
  const st = DRAG.st;
  const under = document.elementFromPoint(st.x, st.y);
  const slot = (under && under.closest) ? under.closest('.slot') : null;
  if (st.hover === slot) return;
  if (st.hover) st.hover.classList.remove('drop-ok', 'drop-no');
  st.hover = slot || null; st.target = null;
  if (!slot) return;
  const ok = validTarget(st, slot);
  slot.classList.add(ok ? 'drop-ok' : 'drop-no');
  if (ok) st.target = slot;
}

/** 拖到屏幕上下边缘时自动滚动，不然托盘在底下、货架在上面根本够不着 */
function edgeScroll() {
  const st = DRAG.st, m = 90, h = window.innerHeight;
  let d = 0;
  if (st.y < m) d = -(m - st.y) / 4;
  else if (st.y > h - m) d = (st.y - (h - m)) / 4;
  if (d) window.scrollBy(0, d);
}

function cleanupDrag(st) {
  if (st.ghost) st.ghost.remove();
  if (st.hover) st.hover.classList.remove('drop-ok', 'drop-no');
  if (st.el) st.el.classList.remove('drag-src');
  document.body.classList.remove('dragging', 'drag-item', 'drag-box');
}

function onPointerUp(e) {
  const st = DRAG.st;
  if (!st || (e && e.pointerId !== st.pointerId)) return;
  clearTimeout(st.timer);
  DRAG.st = null;
  if (!st.moving) return;                       // 只是点了一下，交给 click
  cleanupDrag(st);
  DRAG.clickGuard = true;                       // 吞掉拖完那一下的 click，别顺手开面板
  setTimeout(() => { DRAG.clickGuard = false; }, 350);
  if (st.target) drop(st, st.target);
}

function onPointerCancel() {
  const st = DRAG.st;
  if (!st) return;
  clearTimeout(st.timer); DRAG.st = null;
  if (st.moving) cleanupDrag(st);
}

/** 槽位元素 → 箱号；空槽位返回 null 但给出建箱所需的坐标 */
function slotTarget(slot) {
  if (slot.dataset.box) return { boxId: slot.dataset.box, spot: null };
  const [rack, lv, s] = slot.dataset.add.split('|');
  return { boxId: `${rack}-${lv}-${s}`, spot: { rack, level: +lv, slot: s } };
}

async function drop(st, slot) {
  const { boxId, spot } = slotTarget(slot);

  if (st.kind === 'item') {
    const it = inventory.items.find(x => x.id === st.id);
    if (!it) return;
    const qty = placeQty(it, null);
    if (!qty) return toast('这条已经没有未归位的了');
    const name = it.name || it.id;
    const ops = [];
    if (spot) ops.push({ op: 'addBox', box: spot });      // 落在空槽位上：顺手把箱子建出来
    ops.push({ op: 'move', id: it.id, from: null, to: boxId, qty });
    toast('放入中…', { ms: 15000 });
    await tryRun(async () => {
      await commit(ops, { message: `入箱：${name} → ${boxId} ×${qty}` });
      toast(`${name} ×${qty} → ${boxName(boxId)}`, {
        undo: () => tryRun(async () => {
          const back = [{ op: 'move', id: it.id, from: boxId, to: null, qty }];
          if (spot) back.push({ op: 'delBox', id: boxId });   // 顺手建的箱子也一起撤掉
          await commit(back, { message: `撤销入箱：${name} ← ${boxId} ×${qty}` });
          toast('已撤销');
        }, '撤销失败'),
      });
    }, '放入失败');
    return;
  }

  // 挪箱子（连里面的货一起走）
  const from = st.id, old = boxById(from);
  if (!old || !spot) return;
  const back = { rack: old.rack, level: old.level, slot: old.slot };
  toast('移动中…', { ms: 15000 });
  await tryRun(async () => {
    await commit([{ op: 'moveBox', id: from, ...spot }], { message: `移箱：${from} → ${boxId}` });
    toast(`箱子 ${from} → ${boxId}`, {
      undo: () => tryRun(async () => {
        await commit([{ op: 'moveBox', id: boxId, ...back }], { message: `撤销移箱：${boxId} → ${from}` });
        toast('已撤销');
      }, '撤销失败'),
    });
  }, '移箱失败');
}

function initDrag() {
  // 浏览器原生的图片拖拽会抢走手势（拖出来的是那张图而不是物料），整个站都用不到它
  document.addEventListener('dragstart', (e) => e.preventDefault());
  document.addEventListener('pointerdown', onPointerDown);
  document.addEventListener('pointermove', onPointerMove, { passive: false });
  document.addEventListener('pointerup', onPointerUp);
  document.addEventListener('pointercancel', onPointerCancel);
  // 拖动过程中禁掉原生滚动（pointermove 的 preventDefault 在部分浏览器上拦不住触摸滚动）
  document.addEventListener('touchmove', (e) => {
    if (DRAG.st && DRAG.st.moving) e.preventDefault();
  }, { passive: false });
}

/* ---------- 事件绑定 / 启动 ---------- */
function setQuery(v, syncEl) {
  query = v.trim().toLowerCase();
  if (syncEl) syncEl.value = v;
  renderInv(); renderShelf(); renderUnplaced(); revealHits();
}

function bind() {
  $('#search').oninput = (e) => setQuery(e.target.value, $('#searchShelf'));
  $('#searchShelf').oninput = (e) => setQuery(e.target.value, $('#search'));
  $('#invList').onclick = (e) => { const el = e.target.closest('.item'); if (el) openItem(el.dataset.id); };
  $('#viewToggle').onclick = () => setFlatView(!flatView());
  $('#warehouse').onclick = (e) => {
    if (DRAG.clickGuard) return;                 // 刚拖完，这一下不是点击
    const box = e.target.closest('[data-box]');
    if (box) return openBox(box.dataset.box);
    const add = e.target.closest('[data-add]');
    if (add) { const [r, lv, s] = add.dataset.add.split('|'); if (requireEdit()) quickAddBox(r, +lv, s); return; }
    const f = e.target.closest('[data-focus]');
    if (f) return setFocus(f.dataset.focus);
    const lvl = e.target.closest('[data-level]');
    if (lvl) { const [r, lv] = lvl.dataset.level.split('|'); return openLevel(r, +lv); }
  };
  $('#shelfModes').onclick = (e) => {
    const c = e.target.closest('[data-focus]'); if (c) setFocus(c.dataset.focus);
  };
  $('#unplaced').onclick = (e) => {
    if (DRAG.clickGuard) return;
    const el = e.target.closest('[data-place]'); if (el) openItem(el.dataset.place);
  };
  $('#fabAdd').onclick = () => { if (requireEdit()) openEdit(null); };
  $('#sheetMask').onclick = hideSheet;
  $('#lightbox').onclick = () => $('#lightbox').classList.remove('show');
  $$('.tabbar button').forEach(b => b.onclick = () => switchTab(b.dataset.tab));
  $('#cfgSave').onclick = saveCfg;
  $('#cfgTest').onclick = testCfg;
  $('#cfgClear').onclick = clearCfgPassword;
  let rz = null;
  window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(fitFloor, 120); });
  window.addEventListener('beforeunload', (e) => {
    if (!Pending.ops.size) return;
    flushPending();
    e.preventDefault(); e.returnValue = '';     // 刚点完就关页面，拦一下
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if ($('#lightbox').classList.contains('show')) return $('#lightbox').classList.remove('show');
    if ($('#sheet').classList.contains('show')) backSheet();
  });
}

async function quickAddBox(rackId, level, slot) {
  try {
    await commit([{ op: 'addBox', box: { rack: rackId, level, slot } }], { message: `加箱：${rackId}-${level}-${slot}` });
    toast(`已加箱 ${rackId}-${level}-${slot}`);
  } catch (e) { toast('加箱失败：' + e.message); }
}

bind();
initDrag();
loadCfgForm();
applyView();
loadData();
