# 部署写入代理（Cloudflare Worker）

这个 Worker 让 GitHub token 留在服务端，浏览器永远拿不到。网页所有写入都走它。

> ⚠️ **改了 `worker/worker.js` 就必须重新部署**，否则网页和 Worker 对不上协议，一改库存就报错。

## 日常：改完代码重新部署

```bash
cd ~/dev/storage
npx wrangler deploy
```

- `wrangler.toml` 里 `name = "storage"`，同名重复部署会覆盖，**URL 不变**（`https://storage.circleooneblood666.workers.dev`）。
- **secret 不会被 deploy 覆盖**，不用重设。
- 部署后边缘节点要**几十秒到一两分钟**才全换成新版本，期间新旧代码会混着响应，属正常现象。
- 验证：网页「设置 → 测试」出现 ✅；或者
  ```bash
  curl -s -X POST https://storage.circleooneblood666.workers.dev \
    -H 'Content-Type: application/json' -d '{"type":"read"}' | head -c 80
  ```
  返回 `{"ok":true,"inventory":...}` 就对了。

## 首次配置（已经做过，留档）

**一、GitHub token**：https://github.com/settings/personal-access-tokens/new
- Repository access → **Only select repositories** → 选 `storage`
- Permissions → Repository permissions → **Contents = Read and write**

**二、登录并部署**

```bash
npx wrangler login        # 浏览器授权一次，凭证存在 ~/.wrangler，之后不用再登
npx wrangler deploy
```

> 别用网页后台的 **「Upload static files」上传器** —— 它只收静态文件，会把脚本当资源传，API 跑不起来。
> 网页后台的 **Workers & Pages → storage → Edit code** 那个代码编辑器倒是可以用（贴全文再 Deploy），只是每次都得手动贴 300 行。

**三、两个 secret**

```bash
printf %s '你的GitHub_token' | npx wrangler secret put GH_TOKEN
printf %s '你的编辑密码'      | npx wrangler secret put EDIT_PASSWORD
```

secret 立即生效，不必再 deploy。值只存在 Cloudflare，不进仓库。

**四、地址**：`docs/app.js` 的 `WORKER_URL_BUILTIN` 已写好；换了 URL 就改这里，或在网页「设置 → Worker 地址」临时填。

## 可选：限频

Worker 检测到名为 `RL` 的 KV 绑定就自动启用按 IP 限频（默认每 IP 每 60 秒 30 次），不绑则完全不限频。

绑法：Workers & Pages → **KV** → 建一个 namespace → 回到 Worker → Settings → **Bindings / KV Namespace Bindings** → 变量名填 **`RL`** → 绑定 → Deploy。

> 现在没绑。留言板已经删掉、公开写入面没了；剩下的风险是编辑密码可以被慢慢爆破。数据都在 git 里、任何破坏都能回滚，所以优先级不高——哪天想收紧，绑个 KV 是最省事的一步。

## 支持的请求

| type | 要密码 | 干什么 |
|---|---|---|
| `read` | 否 | 返回最新 `inventory.json`（绕开 Pages 构建延迟）|
| `verify` | — | 校验编辑密码是否正确 |
| `inventory` | 是 | 带 `ops` 数组做补丁写入，服务端在最新数据上应用后提交 |

`ops` 支持：`setItem` / `delItem` / `setPlace` / `move` / `addBox` / `setBox` / `delBox` / `setRack`。
本地跑 `node worker/test-ops.mjs` 可以在不碰线上的情况下验证这套逻辑（15 个用例）。
