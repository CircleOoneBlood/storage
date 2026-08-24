# 龙首谷仓库 · 库存管理

一个纯静态的库存管理站点，替代原来的 Excel。**人用网页操作，agent 用 CLI 操作，两边读写同一份 git 数据。**

管着两个仓库，**每个仓库一份独立 JSON**（物料、货架、箱号互不相干）。网页点顶栏标题切换，CLI 用 `--wh` 选：

| 仓库 | id | 数据文件 | 箱号 |
|------|----|----------|------|
| 龙首谷1号仓库（默认） | `1` | `docs/inventory.json` | `L1-2-c` 这类 |
| 龙首谷白色帐篷仓库 | `tent` | `docs/inventory-tent.json` | 统一 `T` 前缀（`TG-1-a`），实体箱标签不会和1号仓撞 |

> 🌐 **在线地址**：https://circleooneblood.github.io/storage/
> 由 GitHub Pages 托管（Source = `main` 分支 **`/docs`** 目录）。
> 手机打开即可看库存、改数量、拍照、在货架图上找东西。

## 它是怎么运作的

- 数据就是仓库里的一个 JSON + 一个图片目录，没有后端、没有数据库：
  - `docs/inventory.json` / `docs/inventory-tent.json` —— 每仓库一份：货架布局 + 库存条目
  - `docs/images/` —— 压缩后的照片（长边 1400px）
  - `docs/images/thumbs/` —— 缩略图（长边 320px），**列表/托盘/详情条带都用它，只有点开灯箱才拉原图**
    - 路径按规则拼：`images/x.jpg` → `images/thumbs/x.jpg`，所以 JSON 里不用记第二个路径；拼不到会自动回退原图
    - 实测：滚完整个列表从 13.1MB 降到 1.0MB（8%）
    - 补生成：`python3 make_thumbs.py`（可重复跑，只补缺的；`--force` 全部重做）
- `docs/` 由 **GitHub Pages** 托管，手机/电脑打开同一个地址（响应式）。
- 网页的**写入经一个 [Cloudflare Worker](worker/) 代理**（`worker/worker.js`）：GitHub token 只存在 Worker 服务端，浏览器不接触。
  - **看库存**：不用任何配置，谁都能看。
  - **改库存 / 加物料 / 传图 / 动货架**：需要**编辑密码**（Worker 的 `EDIT_PASSWORD` secret，不写进仓库）。

## 数据模型（v2：一个物料可以放在多个箱子里）

```jsonc
{
  "schemaVersion": 2,
  "layout": {
    "levels": 4,                      // 每个货架从下往上 4 层
    "slots": ["a","b","c","d","e","f"], // 每层槽位，从左到右
    "racks": [ { "id": "L1", "name": "左1架", "side": "left", "order": 1 }, ... ],
    "boxes": [ { "id": "L1-2-c", "rack": "L1", "level": 2, "slot": "c", "label": "礼盒" } ]
  },
  "items": [{
    "id": "001", "seq": 1, "name": "金大白色纸袋", "photos": ["images/001-1.jpg"],
    "places": [ { "box": "L1-2-c", "qty": 20 }, { "box": null, "qty": 7 } ]
  }]
}
```

- **箱号 = `区-层-槽位`**，例如 `L1-2-c` = 左1架、从下数第 2 层、从左数第 3 个箱子。
- **每个区可以有自己的层数和槽位**（`rack.levels` / `rack.slots`，不填就用全局的）：
  四个货架是 4 层 × a–f；**正面墙** 1 层 × a–d；**地面** 1 排 × a–f（`levelLabel` 写「排」，
  因为东西是平铺的不是叠起来的）。
- `places` 里 `box: null` 表示**未归位**（还没上架）。
- **总数量 = 各 place 之和**，没有单独的 `qty` 字段（避免两处数字打架）。
- **删箱子不会让后面的槽位往前挪** —— 实体箱上贴的标签才不会错乱。

## 网页有什么

| 页 | 干什么 |
|---|---|
| 📦 库存 | 搜索、看每条的总数和分布、改资料、＋/− 调数量、加物料、拍照 |
| 🗄️ 货架 | **2.5D 走廊视角**：左右各两个货架当成一整面墙一起倾斜，右上角可切「侧视 / 正视」（记在本机）。点层号加箱子，点箱子看/改里面装了什么，未归位的东西在下面的托盘里 |

**视野**：顶部一排 `全部 / 左侧 / 右侧 / 各个货架`，也可以直接点货架标题进出。

- `全部` 挤在一屏里，箱子只显示标签和「N种·M件」
- 切到 `左侧 / 右侧 / 单个货架` 后不再倾斜、箱子摊开，**每个箱子直接列出里面所有物料的名字和数量**，装太多就在箱子里上下滚
| ⚙️ 设置 | 编辑密码、你的名字（会记进改动记录）、Worker 地址 |

**搜索即定位**：在货架页搜物料名，装着它的箱子会**闪烁高亮**并标出数量，箱内名单里那一行也会highlight——这是找东西最快的路。

- **还没归位的也会闪**：下面的托盘会自动横向滚到它跟前，提示条写明「还有 N 件未归位」
- 命中的箱子如果被当前视野挡住了，提示条会告诉你有几个、让你切回「全部」

**拖拽**（要编辑权限才启用，免得只读浏览时手势被劫持）：
- **托盘里的未归位物料 → 箱子**：直接归位；落在**空槽位**上会顺手把箱子建出来
- **箱子 → 空槽位**：整箱挪位置，箱号跟着位置走，里面的货一起跟过去
- 手机上**长按 220ms 起拖**，之前的滑动留给页面滚动和托盘横滑；拖到屏幕上下边缘会自动滚
- 一次拖 = 把该处的数量**全部**搬过去；要拆分就进箱子面板用「移出」
- 每次拖完的 toast 里有**撤销**，顺手建的箱子也会一起撤掉

实现用的是 Pointer Events 而不是 HTML5 drag-and-drop —— 后者在手机上完全不工作，而这网站主要就是在仓库现场用手机开的。

**编辑密码是「一台设备记一次」**：默认空白、只读浏览；输入一次存在本机 `localStorage`，之后打开就是可编辑状态。设置页**从不回填**密码（不会一打开就明晃晃摆在那），留空保存 = 保持原样，共用设备可以点「清除本机记住的密码」。

## CLI 速查（agent / 电脑端）

```bash
python3 inv.py --wh tent list             # 操作白色帐篷仓库（--wh 放在子命令前面；不写 = 1号仓）
python3 inv.py sync                       # 先拉最新（网页那边随时可能刚写过）
python3 inv.py list [关键词]               # 列出/搜索，显示总数与分布
python3 inv.py show 12
python3 inv.py add --name 牛皮箱 --qty 50 [--box L1-2-c]
python3 inv.py set 12 --name 新名字 --note 补货
python3 inv.py rm 12
python3 inv.py photo 12 a.jpg b.jpg       # 加照片（自动压缩）

python3 inv.py qty 12 30 --box L1-2-c     # 设定某处数量（省略 --box = 未归位）
python3 inv.py adjust 12 -5 --box L1-2-c  # 某处增减
python3 inv.py move 12 --to L1-2-c --qty 20            # 从未归位搬上架
python3 inv.py move 12 --from L1-2-c --to R1-1-a --qty 5
python3 inv.py unplaced                   # 还没上架的

python3 inv.py box ls                     # 按货架/层画出所有箱子
python3 inv.py box add L1 2 c --label 礼盒
python3 inv.py box rm L1-2-c [--force]    # 有货时要 --force，货会退回未归位

python3 inv.py push -m "更新库存"          # git add+commit+push
```

## 多人同时改，为什么不会互相覆盖

网页**不再上传整份 inventory**，而是发一串 ops（`setItem` / `move` / `addBox` …）。
Worker 收到后：拉最新数据 → 在服务端应用这些 ops → 带 sha 提交；sha 冲突就自动重来（最多 4 次）。

所以两个人同时改**不同的**条目，两边的改动都会保留。同一条目同时改仍然是后写的赢——这个是预期行为。

改动记录带上操作人（设置里填的名字），commit message 形如 `移库：金大白色纸袋 未归位→L1-2-c ×20（张三）`。

```bash
node worker/test-ops.mjs      # 15 个用例，覆盖并发、超量搬运、删箱退货、路径注入等
```

## 部署

- 网页：push 到 `main` 即可，GitHub Pages 自动更新（构建 30 秒~几分钟，排队时更久）。
  - ⚠️ **改完 `docs/app.js` 或 `docs/style.css`，记得把 `index.html` 里的 `?v=N` 加 1**。
    Pages 给 js/css 发的是 `max-age=600`，不换地址的话浏览器会继续吃十分钟旧的，
    看起来就像「改了没生效」。
  - 数据（`inventory.json`）不受这个影响：网页是找 Worker 要最新的，不等 Pages。
- Worker：见 [`worker/DEPLOY.md`](worker/DEPLOY.md)。**改了 `worker/worker.js` 一定要重新 `npx wrangler deploy`**，否则网页写入会失败。

## 历史

`migrate.py` 从原始 Excel 抽出 88 条物料 + 84 张图（原始 `.xlsx` 不进仓库）。
`migrate_v2.py` 把 v1（单一 `qty` + 自由文本 `location`）迁到 v2（`places` 多箱存放 + `layout`）。旧的位置文本保留在 `legacyLocation` 字段里等待认领。
