# 部署写入代理（Cloudflare Worker）

这个 Worker 替代了"浏览器直连 GitHub"，让 token 留在服务端。全程在 Cloudflare 网页后台点几下，不用命令行。

## 一、准备一个 GitHub token（建议新建一个）

> 之前那个 token 在聊天里出现过，建议在 https://github.com/settings/tokens 把它 **Revoke**，重新建一个。

打开 👉 https://github.com/settings/personal-access-tokens/new
- Repository access → **Only select repositories** → 选 `storage`
- Permissions → Repository permissions → **Contents = Read and write**
- 生成并复制（`github_pat_…`）

## 二、创建 Worker

1. 登录 https://dash.cloudflare.com → 左侧 **Workers & Pages** → **Create** → **Create Worker**。
2. 取个名字，比如 `storage-proxy` → **Deploy**（先建出一个默认 Worker）。
3. 点 **Edit code** → 把仓库里 `worker/worker.js` 的**全部内容**粘贴进去覆盖 → 右上 **Deploy**。

## 三、配置两个 secret

进入这个 Worker 的 **Settings → Variables and Secrets**（或 Variables）→ **Add**，加两条（类型选 **Secret/Encrypt**）：

| 名称 | 值 |
|------|----|
| `GH_TOKEN` | 第一步复制的 GitHub token |
| `EDIT_PASSWORD` | `1217` |

保存后再 **Deploy** 一次让 secret 生效。

## 四、拿到 Worker 地址

在 Worker 概览页能看到地址，形如：
```
https://storage-proxy.<你的子域>.workers.dev
```
**把这个地址发给我**，我写进网站（这样留言板对所有访客都能用）；或者你自己在网站底部「设置 → Worker 地址」里填上、密码填 `1217`，点"测试"显示 ✅ 即可。

## 五（可选）、防刷限频

开放留言板可能招 spam。想加按 IP 限频：
1. Workers & Pages → **KV** → 创建一个 namespace（名字随意）。
2. 回到 Worker → Settings → **Bindings / KV Namespace Bindings** → 变量名填 **`RL`**，绑定刚建的 namespace → Deploy。

Worker 代码检测到 `RL` 就自动启用限频（默认每 IP 每 60 秒 10 次），不绑则跳过。
