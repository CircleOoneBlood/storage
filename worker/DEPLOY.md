# 部署写入代理（Cloudflare Worker）

这个 Worker 替代了"浏览器直连 GitHub"，让 token 留在服务端。全程在 Cloudflare 网页后台点几下，不用命令行。

## 一、准备一个 GitHub token（建议新建一个）

> 之前那个 token 在聊天里出现过，建议在 https://github.com/settings/tokens 把它 **Revoke**，重新建一个。

打开 👉 https://github.com/settings/personal-access-tokens/new
- Repository access → **Only select repositories** → 选 `storage`
- Permissions → Repository permissions → **Contents = Read and write**
- 生成并复制（`github_pat_…`）

## 二、用 wrangler 部署（不要用网页的“Upload static files”上传器！）

那个上传器只接受静态文件，会把脚本当资源传、导致 API 跑不起来。Worker 脚本必须用 `wrangler deploy`。

仓库根已经有正确的 `wrangler.toml`（`main = worker/worker.js`，**不含 assets**）。在仓库根目录执行：

```bash
npx wrangler deploy            # 首次会提示登录，按提示 npx wrangler login
```

部署成功后 URL 形如 `https://storage-proxy.<你的子域>.workers.dev`（同名重复部署会覆盖、URL 不变）。

## 三、设置两个 secret（即“内部密码”，只存服务端）

```bash
printf %s '你的GitHub_token' | npx wrangler secret put GH_TOKEN
printf %s '1217'             | npx wrangler secret put EDIT_PASSWORD
```

secret 立即生效，不必再 deploy。`EDIT_PASSWORD` 就是改库存用的内部密码，不会出现在公开网站/仓库里。

## 四、地址

`docs/app.js` 里的 `WORKER_URL_BUILTIN` 已写好这个地址；如换了 URL，改这里或在网页「设置 → Worker 地址」填。

## 五（可选）、防刷限频

开放留言板可能招 spam。想加按 IP 限频：
1. Workers & Pages → **KV** → 创建一个 namespace（名字随意）。
2. 回到 Worker → Settings → **Bindings / KV Namespace Bindings** → 变量名填 **`RL`**，绑定刚建的 namespace → Deploy。

Worker 代码检测到 `RL` 就自动启用限频（默认每 IP 每 60 秒 10 次），不绑则跳过。
