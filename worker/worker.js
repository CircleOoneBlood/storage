/**
 * Cloudflare Worker —— 库存网站的读写代理。
 * GitHub token 只作为 Worker 的 secret 存在服务端，浏览器永远拿不到。
 *
 * 需要的 secret（在 Cloudflare 后台 / wrangler secret put 设置）：
 *   GH_TOKEN       —— fine-grained PAT，对本仓库 Contents = Read and write
 *   EDIT_PASSWORD  —— 编辑库存的密码（自己设定，不要写进代码/仓库）
 * 可选绑定：
 *   RL（KV namespace）—— 绑了就启用按 IP 限频，不绑则跳过
 *
 * 写入模型：客户端不再上传整份 inventory，而是发一串 ops（改哪条、动哪个箱）。
 * Worker 每次都拉最新数据、在服务端 apply、再带 sha 提交；sha 冲突就重来。
 * 这样多个人同时改「不同的」条目不会互相覆盖。
 */

const OWNER = 'CircleOoneBlood';
const REPO = 'storage';
const BRANCH = 'main';
const PREFIX = 'docs/';                                  // 数据在仓库里的目录
const INV_PATH = PREFIX + 'inventory.json';
const ALLOW_ORIGIN = 'https://circleooneblood.github.io'; // 只允许你的 Pages 站点跨域调用

const LIM = {
  imgB64: 4_000_000,    // 单图 base64 长度上限（约 3MB 原图）
  imgPerReq: 16,        // 单次请求最多传几个图片文件（一张照片 = 原图 + 缩略图 两个）
  ops: 200,             // 单次请求最多几个操作
  retries: 4,           // sha 冲突重试次数
  rlMax: 30,            // 每 IP 每窗口请求数（需 KV）
  rlWindow: 60,         // 限频窗口（秒）
};

const cors = () => ({
  'Access-Control-Allow-Origin': ALLOW_ORIGIN,
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
});
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...cors() } });

async function gh(env, method, path, body) {
  return fetch(`https://api.github.com/repos/${OWNER}/${REPO}/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.GH_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'storage-worker',
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}
async function getJson(env, repoPath) {
  const r = await gh(env, 'GET', `contents/${repoPath}?ref=${BRANCH}`, null);
  if (r.status === 404) return { sha: null, data: null };
  if (!r.ok) throw new Error(`读取 ${repoPath} 失败 ${r.status}`);
  const j = await r.json();
  const bin = atob(j.content.replace(/\n/g, ''));
  const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
  return { sha: j.sha, data: JSON.parse(new TextDecoder().decode(bytes)) };
}
/** 返回 {ok, status}；sha 冲突（409/422）不抛异常，交给调用方重试。 */
async function putFile(env, repoPath, contentB64, message, sha) {
  const body = { message, content: contentB64, branch: BRANCH };
  if (sha) body.sha = sha;
  const r = await gh(env, 'PUT', `contents/${repoPath}`, body);
  if (r.ok) return { ok: true, status: r.status };
  if (r.status === 409 || r.status === 422) return { ok: false, status: r.status };
  throw new Error(`提交 ${repoPath} 失败 ${r.status}: ${(await r.text()).slice(0, 160)}`);
}
function utf8ToB64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
async function rateLimited(env, ip) {
  if (!env.RL) return false;                 // 未绑定 KV 则不限频
  const key = `rl:${ip}`;
  const cur = parseInt((await env.RL.get(key)) || '0', 10);
  if (cur >= LIM.rlMax) return true;
  await env.RL.put(key, String(cur + 1), { expirationTtl: LIM.rlWindow });
  return false;
}

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors() });
    if (req.method !== 'POST') return json({ error: '只支持 POST' }, 405);

    let body;
    try { body = await req.json(); } catch { return json({ error: '请求体不是合法 JSON' }, 400); }
    const ip = req.headers.get('CF-Connecting-IP') || '?';

    try {
      if (await rateLimited(env, ip)) return json({ error: '太频繁，请稍后再试' }, 429);

      if (body.type === 'verify') return json({ ok: body.password === env.EDIT_PASSWORD });

      // 读最新数据（绕开 GitHub Pages 的构建延迟，改完立刻能看到）
      if (body.type === 'read') {
        const { data } = await getJson(env, INV_PATH);
        return json({ ok: true, inventory: data });
      }

      if (body.type === 'inventory') {
        if (body.password !== env.EDIT_PASSWORD) return json({ error: '编辑密码错误' }, 403);
        return await handleInventory(env, body);
      }
      return json({ error: '未知操作类型' }, 400);
    } catch (e) {
      return json({ error: String(e && e.message || e) }, 500);
    }
  },
};

/* ---------------- 写入 ---------------- */

const RE_IMG = /^images\/(thumbs\/)?[\w.\-]+\.jpg$/;   // thumbs/ 是缩略图，规则拼出来的
const RE_ITEM_ID = /^[\w-]{1,16}$/;

function badImage(b64) {
  return typeof b64 !== 'string' || b64.length === 0 || b64.length > LIM.imgB64;
}

async function handleInventory(env, body) {
  const ops = Array.isArray(body.ops) ? body.ops : null;
  if (!ops || !ops.length) return json({ error: '没有可执行的操作' }, 400);
  if (ops.length > LIM.ops) return json({ error: '一次操作太多' }, 400);

  // 图片先落盘（路径带时间戳，不会撞车）；inventory 里引用它们
  const imgs = body.newImages || [];
  if (imgs.length > LIM.imgPerReq) return json({ error: '一次传的图片太多' }, 400);
  for (const img of imgs) {
    if (typeof img.path !== 'string' || img.path.includes('..') || !RE_IMG.test(img.path))
      return json({ error: '图片路径非法' }, 400);
    if (badImage(img.b64)) return json({ error: '图片为空或过大' }, 400);
  }
  for (const img of imgs) {
    const r = await putFile(env, PREFIX + img.path, img.b64, `照片 ${img.path}`, null);
    if (!r.ok) return json({ error: `照片 ${img.path} 提交冲突，请重试` }, 409);
  }

  const by = String(body.by || '').slice(0, 24).replace(/[\r\n]/g, '');
  const note = String(body.message || '更新库存').slice(0, 120).replace(/[\r\n]/g, '');
  const commitMsg = by ? `${note}（${by}）` : note;

  let lastErr = null;
  for (let attempt = 0; attempt < LIM.retries; attempt++) {
    const { sha, data } = await getJson(env, INV_PATH);
    if (!data) return json({ error: 'inventory.json 不存在' }, 500);
    let next;
    try {
      next = applyOps(data, ops);
    } catch (e) {
      return json({ error: String(e.message || e) }, 400);   // 业务错误，重试也没用
    }
    const r = await putFile(env, INV_PATH, utf8ToB64(JSON.stringify(next, null, 2)), commitMsg, sha);
    if (r.ok) return json({ ok: true, inventory: next });
    lastErr = r.status;
    // 冲突：别人刚好也在写，退一小步重来
    await new Promise(res => setTimeout(res, 150 * (attempt + 1)));
  }
  return json({ error: `提交冲突太多次（${lastErr}），请稍后重试` }, 409);
}

/** 在服务端把 ops 应用到最新的 inventory 上，返回新对象。抛错 = 客户端请求有问题。 */
export function applyOps(inv, ops) {
  const next = JSON.parse(JSON.stringify(inv));
  next.schemaVersion = 2;
  next.layout = next.layout || { levels: 4, slots: ['a', 'b', 'c', 'd', 'e', 'f'], racks: [], boxes: [] };
  next.layout.boxes = next.layout.boxes || [];
  next.items = next.items || [];

  const L = next.layout;
  const boxById = (id) => L.boxes.find(b => b.id === id);
  const itemById = (id) => next.items.find(i => i.id === id);
  const validBox = (id) => id === null || id === undefined ? null : (boxById(id) ? id : bad(`箱子不存在：${id}`));
  const bad = (m) => { throw new Error(m); };

  for (const op of ops) {
    switch (op && op.op) {
      case 'setItem': {
        const it = op.item;
        if (!it || !RE_ITEM_ID.test(String(it.id || ''))) bad('物料 id 非法');
        const clean = {
          id: String(it.id),
          seq: typeof it.seq === 'number' ? it.seq : null,
          name: String(it.name || '').slice(0, 120),
          note: String(it.note || '').slice(0, 500),
          counter: String(it.counter || '').slice(0, 40),
          photos: (Array.isArray(it.photos) ? it.photos : []).filter(p => typeof p === 'string' && RE_IMG.test(p)).slice(0, 12),
        };
        const old = itemById(clean.id);
        // places 省略时保留服务端现有的：改个名字不该把别人刚做的归位覆盖掉
        if (it.places !== undefined) clean.places = normPlaces(it.places, validBox, bad);
        else clean.places = old ? (old.places || []) : [];
        if (old) {
          Object.assign(old, clean);
        } else {
          next.items.push(clean);
        }
        break;
      }
      case 'delItem': {
        const i = next.items.findIndex(x => x.id === String(op.id));
        if (i >= 0) next.items.splice(i, 1);
        break;
      }
      case 'setPlace': {                       // 设定某物品在某个箱（或未归位）的数量
        const it = itemById(String(op.id)) || bad(`物料不存在：${op.id}`);
        const box = validBox(op.box ?? null);
        const qty = Math.max(0, Math.floor(Number(op.qty) || 0));
        setPlaceQty(it, box, qty);
        break;
      }
      case 'move': {                           // 从一个箱挪 qty 个到另一个箱
        const it = itemById(String(op.id)) || bad(`物料不存在：${op.id}`);
        const from = validBox(op.from ?? null), to = validBox(op.to ?? null);
        const qty = Math.max(0, Math.floor(Number(op.qty) || 0));
        const have = placeQty(it, from);
        if (qty > have) bad(`${it.name || it.id} 在来源里只有 ${have} 个`);
        setPlaceQty(it, from, have - qty);
        setPlaceQty(it, to, placeQty(it, to) + qty);
        break;
      }
      case 'addBox': {
        const b = op.box || {};
        const rack = L.racks.find(r => r.id === b.rack) || bad(`货架不存在：${b.rack}`);
        const level = Math.floor(Number(b.level));
        if (!(level >= 1 && level <= (L.levels || 4))) bad('层号超范围');
        if (!L.slots.includes(b.slot)) bad('槽位非法');
        const id = `${rack.id}-${level}-${b.slot}`;
        if (boxById(id)) bad(`${id} 已经有箱子了`);
        L.boxes.push({ id, rack: rack.id, level, slot: b.slot, label: String(b.label || '').slice(0, 40) });
        break;
      }
      case 'moveBox': {                        // 整箱挪到另一个槽位（箱号跟着位置走）
        const b = boxById(String(op.id)) || bad(`箱子不存在：${op.id}`);
        const rack = L.racks.find(r => r.id === op.rack) || bad(`货架不存在：${op.rack}`);
        const level = Math.floor(Number(op.level));
        if (!(level >= 1 && level <= (L.levels || 4))) bad('层号超范围');
        if (!L.slots.includes(op.slot)) bad('槽位非法');
        const newId = `${rack.id}-${level}-${op.slot}`;
        if (newId === b.id) break;
        if (boxById(newId)) bad(`${newId} 已经有箱子了`);
        // 箱号变了，所有指着旧箱号的存放记录都要跟着改，否则货就丢了
        for (const it of next.items)
          for (const p of (it.places || [])) if (p.box === b.id) p.box = newId;
        b.id = newId; b.rack = rack.id; b.level = level; b.slot = op.slot;
        break;
      }
      case 'setBox': {
        const b = boxById(String(op.id)) || bad(`箱子不存在：${op.id}`);
        if (op.label !== undefined) b.label = String(op.label || '').slice(0, 40);
        break;
      }
      case 'delBox': {
        const id = String(op.id);
        const used = next.items.filter(i => (i.places || []).some(p => p.box === id && p.qty > 0));
        if (used.length && !op.force) bad(`${id} 里还有 ${used.length} 种物料，先搬空或勾选强制删除`);
        for (const it of used) {                // 强制删除：里面的东西退回未归位
          const q = placeQty(it, id);
          setPlaceQty(it, id, 0);
          setPlaceQty(it, null, placeQty(it, null) + q);
        }
        const i = L.boxes.findIndex(b => b.id === id);
        if (i >= 0) L.boxes.splice(i, 1);       // 注意：不重排其它槽位，实体标签才不会错乱
        break;
      }
      case 'setRack': {
        const r = L.racks.find(x => x.id === String(op.id)) || bad(`货架不存在：${op.id}`);
        if (op.name !== undefined) r.name = String(op.name || '').slice(0, 24);
        break;
      }
      default:
        bad(`未知操作：${op && op.op}`);
    }
  }

  next.items.sort((a, b) => (num(a.seq) ?? 1e9) - (num(b.seq) ?? 1e9));
  return next;
}

const num = (v) => (typeof v === 'number' && !isNaN(v)) ? v : null;
const placeQty = (it, box) => ((it.places || []).find(p => (p.box ?? null) === (box ?? null)) || {}).qty || 0;

function setPlaceQty(it, box, qty) {
  it.places = it.places || [];
  const key = box ?? null;
  const p = it.places.find(x => (x.box ?? null) === key);
  if (qty <= 0) {
    if (p) it.places.splice(it.places.indexOf(p), 1);
    return;
  }
  if (p) p.qty = qty; else it.places.push({ box: key, qty });
}

function normPlaces(places, validBox, bad) {
  if (!Array.isArray(places)) return [];
  const out = [];
  for (const p of places.slice(0, 64)) {
    const box = validBox(p.box ?? null);
    const qty = Math.max(0, Math.floor(Number(p.qty) || 0));
    if (!qty) continue;
    const dup = out.find(x => (x.box ?? null) === (box ?? null));
    if (dup) dup.qty += qty; else out.push({ box: box ?? null, qty });
  }
  return out;
}
