/* 龙首谷1号仓库 —— 纯静态库存 + 留言板，数据存在同仓库的 JSON + images/，写入走 GitHub API。 */
'use strict';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

let inventory = { title: '库存清单', fields: [], items: [] };
let board = { messages: [] };
let editingId = null;          // 正在编辑的条目 id，null 表示新增
let pendingPhotos = [];        // 编辑中新加的照片 {file, url}
let msgPhotos = [];            // 留言待发送的照片 {file, url}

/* ---------- 工具 ---------- */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function toast(msg, ms = 2200) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), ms);
}

function bytesToB64(bytes) {
  let bin = ''; const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  return btoa(bin);
}
const strToB64 = (str) => bytesToB64(new TextEncoder().encode(str));
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

/* ---------- GitHub 写入 ---------- */
const Cfg = {
  get: () => JSON.parse(localStorage.getItem('gh_cfg') || '{}'),
  set: (c) => localStorage.setItem('gh_cfg', JSON.stringify(c)),
  ok() { const c = Cfg.get(); return !!(c.owner && c.repo && c.token); },
};
const GH = {
  base() { const c = Cfg.get(); return `https://api.github.com/repos/${c.owner}/${c.repo}`; },
  headers() { return { Authorization: `Bearer ${Cfg.get().token}`, Accept: 'application/vnd.github+json' }; },
  async getSha(path) {
    const c = Cfg.get();
    const r = await fetch(`${GH.base()}/contents/${path}?ref=${c.branch || 'main'}&t=${Date.now()}`, { headers: GH.headers() });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`读取 ${path} 失败 (${r.status})`);
    return (await r.json()).sha;
  },
  async put(path, contentB64, message, sha) {
    const c = Cfg.get();
    const body = { message, content: contentB64, branch: c.branch || 'main' };
    if (sha) body.sha = sha;
    const r = await fetch(`${GH.base()}/contents/${path}`, {
      method: 'PUT', headers: { ...GH.headers(), 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`提交 ${path} 失败 (${r.status}) ${(await r.text()).slice(0, 200)}`);
    return await r.json();
  },
  prefix() { return Cfg.get().prefix || 'docs/'; },
  // 上传一张照片（已压缩的 blob），返回相对 docs 的路径
  async putImage(relPath, blob, message) {
    const b64 = await blobToB64(blob);
    await GH.put(GH.prefix() + relPath, b64, message);
    return relPath;
  },
  async putJson(relPath, obj, message) {
    const sha = await GH.getSha(GH.prefix() + relPath);
    await GH.put(GH.prefix() + relPath, strToB64(JSON.stringify(obj, null, 2)), message, sha);
  },
};

function requireCfg() {
  if (Cfg.ok()) return true;
  toast('请先到「设置」配置 GitHub token');
  switchTab('set');
  return false;
}

/* ---------- 数据加载 ---------- */
async function loadData() {
  try {
    const inv = await fetch(`./inventory.json?t=${Date.now()}`).then(r => r.json());
    inventory = inv;
  } catch (e) { toast('库存数据加载失败'); }
  try {
    board = await fetch(`./messages.json?t=${Date.now()}`).then(r => r.json());
  } catch (e) { board = { messages: [] }; }
  $('#title').textContent = inventory.title || '库存清单';
  renderInv(); renderMsgs();
}

/* ---------- 库存渲染 ---------- */
function fieldVal(item, key) { return item[key]; }
function renderInv() {
  const q = $('#search').value.trim().toLowerCase();
  const items = inventory.items.filter(it => {
    if (!q) return true;
    return [it.name, it.location, it.note, it.counter, it.seq].some(v => String(v ?? '').toLowerCase().includes(q));
  });
  $('#count').textContent = `${items.length}/${inventory.items.length} 项`;
  const list = $('#invList');
  if (!items.length) { list.innerHTML = `<div class="empty-state">没有匹配的物料</div>`; return; }
  list.innerHTML = items.map(it => {
    const thumb = it.photos && it.photos.length
      ? `<img class="thumb" src="./${esc(it.photos[0])}" loading="lazy" alt="">`
      : `<div class="thumb empty">无图</div>`;
    const loc = it.location ? `<span>📍${esc(it.location)}</span>` : '';
    const cnt = it.counter ? `<span>👤${esc(it.counter)}</span>` : '';
    const note = it.note ? `<div class="note">${esc(it.note)}</div>` : '';
    return `<div class="item" data-id="${esc(it.id)}">
      ${thumb}
      <div class="body">
        <div class="name"><span class="badge">${esc(it.seq)}</span> ${esc(it.name) || '<i>未命名</i>'}</div>
        <div class="meta"><span class="qty">数量 ${esc(it.qty)}</span>${loc}${cnt}</div>
        ${note}
      </div>
    </div>`;
  }).join('');
}

/* ---------- 条目详情 / 编辑 ---------- */
function openDetail(id) {
  const it = inventory.items.find(x => x.id === id);
  if (!it) return;
  const photos = (it.photos || []).map(p =>
    `<img src="./${esc(p)}" data-full="./${esc(p)}" alt="">`).join('');
  const kv = (k, v) => v || v === 0 ? `<div class="kv"><div class="k">${k}</div><div class="v">${esc(v)}</div></div>` : '';
  $('#sheet').innerHTML = `
    <h2>${esc(it.name) || '未命名'} <span class="badge">序号 ${esc(it.seq)}</span></h2>
    ${photos ? `<div class="detail-photos">${photos}</div>` : ''}
    ${kv('数量', it.qty)}${kv('存放位置', it.location)}${kv('盘点人', it.counter)}${kv('备注', it.note)}
    <div class="btns">
      <button class="btn danger" id="dDel">删除</button>
      <button class="btn primary" id="dEdit">编辑</button>
    </div>`;
  $('#dEdit').onclick = () => openEdit(id);
  $('#dDel').onclick = () => delItem(id);
  $$('#sheet .detail-photos img').forEach(img => img.onclick = () => openLightbox(img.dataset.full));
  showSheet();
}

function openEdit(id) {
  editingId = id; pendingPhotos = [];
  const it = id ? inventory.items.find(x => x.id === id) : { seq: nextSeq(), name: '', qty: '', location: '', note: '', counter: '', photos: [] };
  $('#sheet').innerHTML = `
    <h2>${id ? '编辑物料' : '新增物料'}</h2>
    <div class="row2">
      <div class="field"><label>序号</label><input id="fSeq" type="number" value="${esc(it.seq)}"></div>
      <div class="field"><label>数量</label><input id="fQty" type="number" value="${esc(it.qty)}"></div>
    </div>
    <div class="field"><label>名称</label><input id="fName" value="${esc(it.name)}"></div>
    <div class="field"><label>存放位置编号</label><input id="fLoc" value="${esc(it.location)}"></div>
    <div class="field"><label>盘点人</label><input id="fCounter" value="${esc(it.counter)}"></div>
    <div class="field"><label>备注</label><textarea id="fNote">${esc(it.note)}</textarea></div>
    <div class="field"><label>照片</label><div class="photos-edit" id="phEdit"></div></div>
    <input type="file" id="fFiles" accept="image/*" multiple hidden>
    <div class="btns">
      <button class="btn ghost" id="eCancel">取消</button>
      <button class="btn primary" id="eSave">保存</button>
    </div>`;
  renderPhotoEdit(it.photos || []);
  $('#eCancel').onclick = hideSheet;
  $('#eSave').onclick = () => saveItem(it);
  $('#fFiles').onchange = (e) => {
    for (const f of e.target.files) pendingPhotos.push({ file: f, url: URL.createObjectURL(f) });
    e.target.value = ''; renderPhotoEdit(it.photos || []);
  };
  showSheet();
}

function renderPhotoEdit(existing) {
  const ex = existing.map((p, i) =>
    `<div class="ph"><img src="./${esc(p)}" alt=""><button class="del" data-ex="${i}">×</button></div>`).join('');
  const np = pendingPhotos.map((p, i) =>
    `<div class="ph"><img src="${p.url}" alt=""><button class="del" data-np="${i}">×</button></div>`).join('');
  $('#phEdit').innerHTML = ex + np + `<button class="add" id="phAdd">＋</button>`;
  $('#phAdd').onclick = () => $('#fFiles').click();
  $$('#phEdit .del').forEach(b => b.onclick = () => {
    if (b.dataset.ex != null) existing.splice(+b.dataset.ex, 1);
    else pendingPhotos.splice(+b.dataset.np, 1);
    renderPhotoEdit(existing);
  });
}

function nextSeq() { const ns = inventory.items.map(i => +i.seq).filter(n => !isNaN(n)); return ns.length ? Math.max(...ns) + 1 : 1; }
function nextId() { const ns = inventory.items.map(i => parseInt(i.id, 10)).filter(n => !isNaN(n)); return String((ns.length ? Math.max(...ns) : 0) + 1).padStart(3, '0'); }

async function saveItem(orig) {
  if (!requireCfg()) return;
  const id = editingId || nextId();
  const item = {
    id, seq: numOr($('#fSeq').value, ''), name: $('#fName').value.trim(),
    qty: numOr($('#fQty').value, ''), location: $('#fLoc').value.trim(),
    note: $('#fNote').value.trim(), counter: $('#fCounter').value.trim(),
    photos: (orig.photos || []).slice(),
  };
  if (!item.name && !item.photos.length && !pendingPhotos.length) { toast('至少填个名称'); return; }
  const btn = $('#eSave'); btn.disabled = true; btn.textContent = '保存中…';
  try {
    let k = 0;
    for (const p of pendingPhotos) {
      btn.textContent = `上传图片 ${++k}/${pendingPhotos.length}…`;
      const blob = await resizeImage(p.file);
      const rel = `images/${id}-${Date.now()}-${k}.jpg`;
      await GH.putImage(rel, blob, `照片 ${item.name || id}`);
      item.photos.push(rel);
    }
    const idx = inventory.items.findIndex(x => x.id === id);
    if (idx >= 0) inventory.items[idx] = item; else inventory.items.push(item);
    inventory.items.sort((a, b) => (+a.seq || 1e9) - (+b.seq || 1e9));
    btn.textContent = '提交…';
    await GH.putJson('inventory.json', inventory, `${editingId ? '改' : '加'}物料：${item.name || id}`);
    toast('已保存'); hideSheet(); renderInv();
  } catch (e) { toast('保存失败：' + e.message); btn.disabled = false; btn.textContent = '保存'; }
}
function numOr(v, dflt) { const n = parseFloat(v); return v !== '' && !isNaN(n) ? n : dflt; }

async function delItem(id) {
  if (!requireCfg()) return;
  const it = inventory.items.find(x => x.id === id);
  if (!confirm(`确认删除「${it ? it.name || id : id}」？`)) return;
  try {
    inventory.items = inventory.items.filter(x => x.id !== id);
    await GH.putJson('inventory.json', inventory, `删物料：${it ? it.name || id : id}`);
    toast('已删除'); hideSheet(); renderInv();
  } catch (e) { toast('删除失败：' + e.message); }
}

/* ---------- 留言板 ---------- */
function renderMsgs() {
  const list = $('#msgList');
  const msgs = (board.messages || []).slice().reverse();
  if (!msgs.length) { list.innerHTML = `<div class="empty-state">还没有留言。<br>在下面给 agent 留一条（可带图）。</div>`; return; }
  list.innerHTML = msgs.map(m => {
    const agent = m.author === 'agent';
    const imgs = (m.photos || []).map(p => `<img src="./${esc(p)}" data-full="./${esc(p)}" loading="lazy" alt="">`).join('');
    return `<div class="msg ${agent ? 'agent' : ''}">
      <div class="head"><span class="who ${agent ? 'agent' : ''}">${agent ? '🤖 Agent' : '🧑 我'}</span><span class="time">${esc(fmtTime(m.ts))}</span></div>
      ${m.text ? `<div class="text">${esc(m.text)}</div>` : ''}
      ${imgs ? `<div class="imgs">${imgs}</div>` : ''}
    </div>`;
  }).join('');
  $$('#msgList .imgs img').forEach(img => img.onclick = () => openLightbox(img.dataset.full));
}
function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts); if (isNaN(d)) return ts;
  const p = n => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function sendMsg() {
  if (!requireCfg()) return;
  const text = $('#msgText').value.trim();
  if (!text && !msgPhotos.length) { toast('写点什么或加张图'); return; }
  const btn = $('#msgSend'); btn.disabled = true;
  try {
    const ts = new Date().toISOString();
    const stamp = ts.replace(/[:.]/g, '-');
    const photos = [];
    let k = 0;
    for (const p of msgPhotos) {
      const blob = await resizeImage(p.file);
      const rel = `images/msg/${stamp}-${++k}.jpg`;
      await GH.putImage(rel, blob, '留言图片');
      photos.push(rel);
    }
    board.messages = board.messages || [];
    board.messages.push({ id: 'm' + stamp, ts, author: 'user', text, photos });
    await GH.putJson('messages.json', board, '留言：' + (text.slice(0, 20) || '[图片]'));
    $('#msgText').value = ''; msgPhotos = []; renderMsgCompose();
    toast('已发送'); renderMsgs();
    $('#msgList').scrollIntoView({ block: 'end' });
  } catch (e) { toast('发送失败：' + e.message); }
  btn.disabled = false;
}
function renderMsgCompose() {
  // 简单显示待发图片数量
  $('#msgAttach').textContent = msgPhotos.length ? `📎${msgPhotos.length}` : '📎';
}

/* ---------- 弹层 / 灯箱 / tab ---------- */
function showSheet() { $('#sheetMask').classList.add('show'); $('#sheet').classList.add('show'); }
function hideSheet() { $('#sheetMask').classList.remove('show'); $('#sheet').classList.remove('show'); editingId = null; pendingPhotos = []; }
function openLightbox(src) { $('#lightboxImg').src = src; $('#lightbox').classList.add('show'); }
function switchTab(tab) {
  $$('.tabbar button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  $$('.page').forEach(p => p.classList.remove('active'));
  $(`#page-${tab}`).classList.add('active');
  $('#fabAdd').style.display = tab === 'inv' ? '' : 'none';
}

/* ---------- 设置 ---------- */
function loadCfgForm() {
  const c = Cfg.get();
  $('#cfgOwner').value = c.owner || 'CircleOoneBlood'; $('#cfgRepo').value = c.repo || 'storage';
  $('#cfgBranch').value = c.branch || 'main'; $('#cfgPrefix').value = c.prefix || 'docs/';
  $('#cfgToken').value = c.token || '';
  updateStatusDot();
}
function saveCfg() {
  Cfg.set({
    owner: $('#cfgOwner').value.trim(), repo: $('#cfgRepo').value.trim(),
    branch: $('#cfgBranch').value.trim() || 'main', prefix: $('#cfgPrefix').value.trim() || 'docs/',
    token: $('#cfgToken').value.trim(),
  });
  updateStatusDot(); toast('已保存设置');
}
async function testCfg() {
  saveCfg();
  $('#cfgStatus').textContent = '测试中…';
  try {
    const r = await fetch(GH.base(), { headers: GH.headers() });
    if (!r.ok) throw new Error(r.status === 404 ? '仓库不存在或无权限' : `HTTP ${r.status}`);
    const j = await r.json();
    $('#cfgStatus').textContent = `✅ 连接成功：${j.full_name}（${j.private ? '私有' : '公开'}）`;
  } catch (e) { $('#cfgStatus').textContent = '❌ ' + e.message; }
}
function updateStatusDot() {
  const d = $('#statusDot');
  d.className = 'status-dot ' + (Cfg.ok() ? 'ok' : 'bad');
  d.title = Cfg.ok() ? '可写入' : '未配置写入';
}

/* ---------- 事件绑定 / 启动 ---------- */
function bind() {
  $('#search').oninput = renderInv;
  $('#invList').onclick = (e) => { const el = e.target.closest('.item'); if (el) openDetail(el.dataset.id); };
  $('#fabAdd').onclick = () => { if (requireCfg()) openEdit(null); };
  $('#sheetMask').onclick = hideSheet;
  $('#lightbox').onclick = () => $('#lightbox').classList.remove('show');
  $$('.tabbar button').forEach(b => b.onclick = () => switchTab(b.dataset.tab));
  $('#msgSend').onclick = sendMsg;
  $('#msgAttach').onclick = () => $('#msgFiles').click();
  $('#msgFiles').onchange = (e) => { for (const f of e.target.files) msgPhotos.push({ file: f, url: URL.createObjectURL(f) }); e.target.value = ''; renderMsgCompose(); };
  $('#msgText').oninput = (e) => { e.target.style.height = 'auto'; e.target.style.height = Math.min(120, e.target.scrollHeight) + 'px'; };
  $('#cfgSave').onclick = saveCfg;
  $('#cfgTest').onclick = testCfg;
}

bind();
loadCfgForm();
loadData();
