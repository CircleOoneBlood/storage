# 龙首谷1号仓库 · 库存管理

一个纯静态的库存管理站点，替代原来的 Excel。**人用网页操作，agent 用 CLI 操作，两边读写同一份 git 数据。**

> 🌐 **在线地址**：https://circleooneblood.github.io/storage/
> 由 GitHub Pages 托管（Source = `main` 分支 **`/docs`** 目录）。
> 手机打开即可看库存、增删改、拍照、留言。

## 它是怎么运作的

- 数据就是仓库里的两个 JSON + 一个图片目录，没有后端、没有数据库：
  - `docs/inventory.json` —— 库存条目
  - `docs/messages.json` —— 留言板（人 ↔ agent 的异步通道）
  - `docs/images/` —— 压缩后的照片（web 尺寸）
- `docs/` 由 **GitHub Pages** 托管，手机/电脑打开网页即可看、可改。
- 网页的写入（增删改、传图、发留言）走 **GitHub API**，需要在「设置」里填一个 token（只存在本机浏览器）。

## 两个操作入口

| 入口 | 谁用 | 怎么用 |
|------|------|--------|
| 网页 | 人（手机优先） | 打开 Pages 站点，库存增删改查、拍照上传、发留言 |
| CLI `inv.py` | agent / 电脑端 | 命令行读写 + `git push`，见下 |

## CLI 速查

```bash
python3 inv.py list [关键词]          # 列出/搜索
python3 inv.py show 12                 # 看某条（按序号或 id）
python3 inv.py add --name 牛皮箱 --qty 50 --location 1-2-a
python3 inv.py set 12 --qty 30 --note 补货
python3 inv.py adjust 12 -5            # 数量 -5
python3 inv.py rm 12
python3 inv.py photo 12 a.jpg b.jpg    # 加照片（自动压缩）
python3 inv.py inbox                   # 看留言
python3 inv.py reply "已录入3条"        # agent 回帖
python3 inv.py push -m "更新"          # git add+commit+push
```

## agent 工作闭环

1. 用户在手机留言板发「文字 + 照片」→ 提交进仓库。
2. agent 在电脑端 `git pull` → 读 `docs/messages.json`，直接看到文字、看到照片。
3. agent 用 `inv.py` 改库存、`inv.py reply` 回帖 → `inv.py push`。
4. 用户刷新网页看到结果。

## 数据迁移

`migrate.py` 是一次性脚本：从原始 Excel 抽出 88 条物料 + 84 张图，压缩进 `docs/`。（原始 `.xlsx` 不进仓库。）

## 部署（一次性）

1. 仓库 push 到 GitHub。
2. Settings → Pages → Source 选 `main` 分支、`/docs` 目录，保存。
3. 等 1 分钟，访问 `https://<用户名>.github.io/<仓库名>/`。
4. 网页「设置」里填 owner / repo / token，即可在手机上增删改查。
