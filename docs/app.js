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

/* ---------- 写入：经 Cloudflare Worker 代理（GitHub token 只在服务端，浏览器不接触）---------- */
// 部署 Worker 后把地址填这里（留空则用「设置」里手动填的地址）。留言板对所有人开放，靠的就是这个内置地址。
const WORKER_URL_BUILTIN = 'https://storage.circleooneblood666.workers.dev';

const Cfg = {
  get: () => JSON.parse(localStorage.getItem('cfg') || '{}'),
  set: (c) => localStorage.setItem('cfg', JSON.stringify(c)),
  worker: () => (Cfg.get().workerUrl || WORKER_URL_BUILTIN || '').trim().replace(/\/+$/, ''),
  password: () => Cfg.get().password || '',
  ready: () => !!Cfg.worker(),                          // 能发留言（开放，只要配好 Worker 地址）
  canEdit: () => !!Cfg.worker() && !!Cfg.password(),    // 能改库存（额外要密码）
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

// 压缩一张图片并转 base64（发给 Worker 提交）
async function fileToB64(file) { return await blobToB64(await resizeImage(file)); }

function requireWorker() {
  if (Cfg.ready()) return true;
  toast('请先到「设置」填入 Worker 地址');
  switchTab('set');
  return false;
}
function requireEdit() {
  if (!requireWorker()) return false;
  if (!Cfg.password()) { toast('请先到「设置」填写编辑密码'); switchTab('set'); return false; }
  return true;
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
  if (!requireEdit()) return;
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
    const newImages = [];
    let k = 0;
    for (const p of pendingPhotos) {
      btn.textContent = `处理图片 ${++k}/${pendingPhotos.length}…`;
      const path = `images/${id}-${Date.now()}-${k}.jpg`;
      newImages.push({ path, b64: await fileToB64(p.file) });
      item.photos.push(path);
    }
    const items = inventory.items.slice();
    const idx = items.findIndex(x => x.id === id);
    if (idx >= 0) items[idx] = item; else items.push(item);
    items.sort((a, b) => (+a.seq || 1e9) - (+b.seq || 1e9));
    const next = { ...inventory, items };
    btn.textContent = '提交…';
    await api({ type: 'inventory', password: Cfg.password(), inventory: next, newImages, message: `${editingId ? '改' : '加'}物料：${item.name || id}` });
    inventory = next;                     // 成功才落到内存
    toast('已保存'); hideSheet(); renderInv();
  } catch (e) { toast('保存失败：' + e.message); btn.disabled = false; btn.textContent = '保存'; }
}
function numOr(v, dflt) { const n = parseFloat(v); return v !== '' && !isNaN(n) ? n : dflt; }

async function delItem(id) {
  if (!requireEdit()) return;
  const it = inventory.items.find(x => x.id === id);
  if (!confirm(`确认删除「${it ? it.name || id : id}」？`)) return;
  try {
    const next = { ...inventory, items: inventory.items.filter(x => x.id !== id) };
    await api({ type: 'inventory', password: Cfg.password(), inventory: next, message: `删物料：${it ? it.name || id : id}` });
    inventory = next;
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
  if (!requireWorker()) return;
  const text = $('#msgText').value.trim();
  if (!text && !msgPhotos.length) { toast('写点什么或加张图'); return; }
  const btn = $('#msgSend'); btn.disabled = true;
  try {
    const photos = [];
    for (const p of msgPhotos) photos.push({ b64: await fileToB64(p.file) });
    const res = await api({ type: 'message', text, photos });
    board.messages = board.messages || [];
    if (res.message) board.messages.push(res.message);
    $('#msgText').value = ''; $('#msgText').style.height = 'auto'; msgPhotos = []; renderMsgCompose();
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
  $('#cfgWorker').value = c.workerUrl || '';
  $('#cfgPassword').value = c.password || '';
  updateStatusDot();
}
function saveCfg() {
  Cfg.set({
    workerUrl: $('#cfgWorker').value.trim(),
    password: $('#cfgPassword').value.trim(),
  });
  updateStatusDot(); toast('已保存设置');
}
async function testCfg() {
  saveCfg();
  $('#cfgStatus').textContent = '测试中…';
  try {
    const res = await api({ type: 'verify', password: Cfg.password() });
    $('#cfgStatus').textContent = res.ok
      ? '✅ Worker 正常，密码正确，可编辑库存'
      : '⚠️ Worker 正常，但密码不对（留言板仍可用）';
  } catch (e) { $('#cfgStatus').textContent = '❌ ' + e.message; }
}
function updateStatusDot() {
  const d = $('#statusDot');
  const ready = Cfg.ready();
  d.className = 'status-dot ' + (Cfg.canEdit() ? 'ok' : (ready ? '' : 'bad'));
  d.title = Cfg.canEdit() ? '可编辑库存' : (ready ? '可留言（编辑需密码）' : '未配置 Worker');
}

/* ---------- 事件绑定 / 启动 ---------- */
function bind() {
  $('#search').oninput = renderInv;
  $('#invList').onclick = (e) => { const el = e.target.closest('.item'); if (el) openDetail(el.dataset.id); };
  $('#fabAdd').onclick = () => { if (requireEdit()) openEdit(null); };
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
