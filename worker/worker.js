/**
 * Cloudflare Worker —— 库存网站的写入代理。
 * GitHub token 只作为 Worker 的 secret 存在服务端，浏览器永远拿不到。
 *
 * 需要的 secret（在 Cloudflare 后台设置）：
 *   GH_TOKEN       —— fine-grained PAT，对本仓库 Contents = Read and write
 *   EDIT_PASSWORD  —— 编辑库存的密码（例如 1217）
 * 可选绑定：
 *   RL（KV namespace）—— 绑了就启用按 IP 限频，不绑则跳过
 */

const OWNER = 'CircleOoneBlood';
const REPO = 'storage';
const BRANCH = 'main';
const PREFIX = 'docs/';                                  // 数据在仓库里的目录
const ALLOW_ORIGIN = 'https://circleooneblood.github.io'; // 只允许你的 Pages 站点跨域调用

const LIM = {
  msgText: 2000,        // 留言文字上限
  msgPhotos: 4,         // 留言图片张数上限
  imgB64: 4_000_000,    // 单图 base64 长度上限（约 3MB 原图）
  rlMax: 10,            // 每 IP 每窗口请求数（需 KV）
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
async function getSha(env, repoPath) {
  const r = await gh(env, 'GET', `contents/${repoPath}?ref=${BRANCH}`, null);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`读取 ${repoPath} 失败 ${r.status}`);
  return (await r.json()).sha;
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
async function putFile(env, repoPath, contentB64, message, sha) {
  const body = { message, content: contentB64, branch: BRANCH };
  if (sha) body.sha = sha;
  const r = await gh(env, 'PUT', `contents/${repoPath}`, body);
  if (!r.ok) throw new Error(`提交 ${repoPath} 失败 ${r.status}: ${(await r.text()).slice(0, 160)}`);
  return r.json();
}
function utf8ToB64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
function badImage(b64) {
  return typeof b64 !== 'string' || b64.length === 0 || b64.length > LIM.imgB64;
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
      if (body.type === 'verify') {
        return json({ ok: body.password === env.EDIT_PASSWORD });
      }
      if (body.type === 'message') {
        if (await rateLimited(env, ip)) return json({ error: '太频繁，请稍后再试' }, 429);
        return await handleMessage(env, body);
      }
      if (body.type === 'inventory') {
        if (body.password !== env.EDIT_PASSWORD) return json({ error: '编辑密码错误' }, 403);
        if (await rateLimited(env, ip)) return json({ error: '太频繁，请稍后再试' }, 429);
        return await handleInventory(env, body);
      }
      return json({ error: '未知操作类型' }, 400);
    } catch (e) {
      return json({ error: String(e && e.message || e) }, 500);
    }
  },
};

async function handleInventory(env, body) {
  const inv = body.inventory;
  if (!inv || !Array.isArray(inv.items)) return json({ error: 'inventory 格式错误' }, 400);
  for (const img of (body.newImages || [])) {
    if (typeof img.path !== 'string' || img.path.includes('..') || !/^images\/[\w.\-\/]+\.jpg$/.test(img.path))
      return json({ error: '图片路径非法' }, 400);
    if (badImage(img.b64)) return json({ error: '图片为空或过大' }, 400);
    await putFile(env, PREFIX + img.path, img.b64, `照片 ${img.path}`, null);
  }
  const sha = await getSha(env, PREFIX + 'inventory.json');
  await putFile(env, PREFIX + 'inventory.json', utf8ToB64(JSON.stringify(inv, null, 2)), body.message || '更新库存', sha);
  return json({ ok: true });
}

async function handleMessage(env, body) {
  const text = String(body.text || '').slice(0, LIM.msgText);
  const photos = (Array.isArray(body.photos) ? body.photos : []).slice(0, LIM.msgPhotos);
  if (!text && !photos.length) return json({ error: '留言不能为空' }, 400);
  const ts = new Date().toISOString();
  const stamp = ts.replace(/[:.]/g, '-');
  const paths = [];
  let k = 0;
  for (const p of photos) {
    if (badImage(p.b64)) return json({ error: '图片为空或过大' }, 400);
    const rel = `images/msg/${stamp}-${++k}.jpg`;
    await putFile(env, PREFIX + rel, p.b64, '留言图片', null);
    paths.push(rel);
  }
  const { sha, data } = await getJson(env, PREFIX + 'messages.json');
  const board = data && Array.isArray(data.messages) ? data : { messages: [] };
  const msg = { id: 'm' + stamp, ts, author: 'user', text, photos: paths };
  board.messages.push(msg);
  await putFile(env, PREFIX + 'messages.json', utf8ToB64(JSON.stringify(board, null, 2)),
    '留言：' + (text.slice(0, 20) || '[图片]'), sha);
  return json({ ok: true, message: msg });
}
