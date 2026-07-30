#!/usr/bin/env python3
"""inv —— 库存的命令行操作（给 agent 和电脑端用）。

数据模型 v2：物料可以同时存在于多个箱子里。
  item.places = [{"box": "L1-2-c" | null, "qty": n}]   box=null 表示未归位
  总数量 = 各 place 之和（不再有单独的 qty 字段）

用法示例：
  python3 inv.py sync                       # 先拉最新（网页可能刚写过）
  python3 inv.py list [关键词]
  python3 inv.py show 12
  python3 inv.py add --name "牛皮纸箱" --qty 50 --counter 张三
  python3 inv.py set 12 --name "新名字" --note "补货后"
  python3 inv.py rm 12
  python3 inv.py photo 12 /path/a.jpg
  python3 inv.py qty 12 30 --box L1-2-c     # 设定 12 号在某箱的数量（省略 --box = 未归位）
  python3 inv.py adjust 12 -5 --box L1-2-c  # 增减
  python3 inv.py move 12 --to L1-2-c --qty 20            # 从未归位搬进箱子
  python3 inv.py move 12 --from L1-2-c --to R1-1-a --qty 5
  python3 inv.py box ls | box add L1 2 c --label 礼盒 | box rm L1-2-c [--force]
  python3 inv.py unplaced                   # 还没上架的
  python3 inv.py push -m "更新库存"          # git add+commit+push
"""
import argparse, json, os, sys, subprocess, datetime

ROOT = os.path.dirname(os.path.abspath(__file__))
DOCS = os.path.join(ROOT, "docs")
INV = os.path.join(DOCS, "inventory.json")
IMG = os.path.join(DOCS, "images")
MAX_EDGE, JPG_Q = 1400, 82


def load():
    with open(INV, encoding="utf-8") as f:
        inv = json.load(f)
    if inv.get("schemaVersion") != 2:
        sys.exit("inventory.json 还是旧格式，先跑 python3 migrate_v2.py")
    inv.setdefault("layout", {}).setdefault("boxes", [])
    return inv


def save(inv):
    with open(INV, "w", encoding="utf-8") as f:
        json.dump(inv, f, ensure_ascii=False, indent=2)


def find(inv, key):
    key = str(key)
    for it in inv["items"]:
        if it["id"] == key or str(it.get("seq")) == key:
            return it
    sys.exit(f"找不到物料：{key}")


def boxes(inv):
    return inv["layout"]["boxes"]


def check_box(inv, box):
    """box 为 None（未归位）或已存在的箱号，否则退出。"""
    if box is None:
        return None
    if not any(b["id"] == box for b in boxes(inv)):
        sys.exit(f"箱子不存在：{box}（用 `inv.py box ls` 看有哪些）")
    return box


def total(it):
    return sum(p.get("qty", 0) for p in it.get("places", []))


def place_qty(it, box):
    for p in it.get("places", []):
        if (p.get("box") or None) == (box or None):
            return p.get("qty", 0)
    return 0


def set_place(it, box, qty):
    it.setdefault("places", [])
    key = box or None
    for p in it["places"]:
        if (p.get("box") or None) == key:
            if qty <= 0:
                it["places"].remove(p)
            else:
                p["qty"] = qty
            return
    if qty > 0:
        it["places"].append({"box": key, "qty": qty})


def where(it):
    ps = [p for p in it.get("places", []) if p.get("qty", 0) > 0]
    if not ps:
        return "（无数量）"
    return " ".join(f"{p['box'] or '未归位'}×{p['qty']}" for p in ps)


def next_id(inv):
    ns = [int(i["id"]) for i in inv["items"] if str(i["id"]).isdigit()]
    return f"{(max(ns) + 1) if ns else 1:03d}"


def next_seq(inv):
    ns = [int(i["seq"]) for i in inv["items"] if str(i.get("seq", "")).lstrip("-").isdigit()]
    return (max(ns) + 1) if ns else 1


def save_photo(item_id, src, idx):
    """压缩一张照片进 docs/images/，返回相对路径。"""
    from PIL import Image, ImageOps
    os.makedirs(IMG, exist_ok=True)
    im = ImageOps.exif_transpose(Image.open(src))
    if im.mode in ("RGBA", "P", "LA"):
        bg = Image.new("RGB", im.size, (255, 255, 255)); im = im.convert("RGBA")
        bg.paste(im, mask=im.split()[-1]); im = bg
    else:
        im = im.convert("RGB")
    im.thumbnail((MAX_EDGE, MAX_EDGE), Image.LANCZOS)
    stamp = datetime.datetime.now().strftime("%H%M%S")
    rel = f"images/{item_id}-{stamp}-{idx}.jpg"
    im.save(os.path.join(DOCS, rel), "JPEG", quality=JPG_Q, optimize=True)
    return rel


def fmt_item(it):
    p = f" 📷{len(it.get('photos', []))}" if it.get("photos") else ""
    extra = " ".join(x for x in [
        f"备注:{it['note']}" if it.get("note") else "",
        f"盘:{it['counter']}" if it.get("counter") else "",
    ] if x)
    return f"[{str(it.get('seq','')):>3}] {it['name'] or '(未命名)'}  共{total(it)}{p}  {where(it)}  {extra}".rstrip()


# ---------- 命令 ----------
def cmd_list(a):
    inv = load()
    items = inv["items"]
    if a.q:
        q = a.q.lower()
        items = [it for it in items
                 if any(q in str(it.get(k, "")).lower() for k in ("name", "note", "counter", "seq"))
                 or any(q in str(p.get("box") or "").lower() for p in it.get("places", []))]
    for it in items:
        print(fmt_item(it))
    print(f"--- {len(items)}/{len(inv['items'])} 项，合计 {sum(total(i) for i in items)} 件 ---")


def cmd_show(a):
    inv = load()
    print(json.dumps(find(inv, a.id), ensure_ascii=False, indent=2))


def cmd_add(a):
    inv = load()
    iid = next_id(inv)
    it = {"id": iid, "seq": a.seq if a.seq is not None else next_seq(inv),
          "name": a.name, "note": a.note or "", "counter": a.counter or "", "photos": [],
          "places": []}
    box = check_box(inv, a.box)
    if a.qty:
        set_place(it, box, a.qty)
    for i, src in enumerate(a.photo or [], 1):
        it["photos"].append(save_photo(iid, src, i))
    inv["items"].append(it)
    inv["items"].sort(key=lambda x: x.get("seq") if isinstance(x.get("seq"), (int, float)) else 1e9)
    save(inv); print("已添加："); print(fmt_item(it))


def cmd_set(a):
    inv = load(); it = find(inv, a.id)
    for k in ("name", "note", "counter", "seq"):
        v = getattr(a, k)
        if v is not None:
            it[k] = v
    save(inv); print("已更新："); print(fmt_item(it))


def cmd_rm(a):
    inv = load(); it = find(inv, a.id)
    inv["items"] = [x for x in inv["items"] if x["id"] != it["id"]]
    save(inv); print(f"已删除：{it['name']}（共 {total(it)} 件）")


def cmd_photo(a):
    inv = load(); it = find(inv, a.id)
    n = len(it.get("photos", []))
    it.setdefault("photos", [])
    for i, src in enumerate(a.files, n + 1):
        it["photos"].append(save_photo(it["id"], src, i))
    save(inv); print(f"已加 {len(a.files)} 张照片到 {it['name']}")


def cmd_qty(a):
    inv = load(); it = find(inv, a.id); box = check_box(inv, a.box)
    set_place(it, box, a.qty)
    save(inv); print("已设定："); print(fmt_item(it))


def cmd_adjust(a):
    inv = load(); it = find(inv, a.id); box = check_box(inv, a.box)
    cur = place_qty(it, box)
    if cur + a.delta < 0:
        sys.exit(f"{box or '未归位'} 只有 {cur} 个，减不了 {abs(a.delta)}")
    set_place(it, box, cur + a.delta)
    save(inv); print("已调整："); print(fmt_item(it))


def cmd_move(a):
    inv = load(); it = find(inv, a.id)
    src, dst = check_box(inv, getattr(a, "from")), check_box(inv, a.to)
    if (src or None) == (dst or None):
        sys.exit("来源和目的地一样")
    have = place_qty(it, src)
    qty = a.qty if a.qty is not None else have
    if qty <= 0 or qty > have:
        sys.exit(f"{src or '未归位'} 里只有 {have} 个")
    set_place(it, src, have - qty)
    set_place(it, dst, place_qty(it, dst) + qty)
    save(inv); print(f"已移动 {qty} 个："); print(fmt_item(it))


def cmd_unplaced(a):
    inv = load()
    rows = [it for it in inv["items"] if place_qty(it, None) > 0]
    for it in rows:
        print(f"[{str(it.get('seq','')):>3}] {it['name'] or '(未命名)'}  未归位 {place_qty(it, None)}"
              + (f"  旧位置:{it['legacyLocation']}" if it.get("legacyLocation") else ""))
    print(f"--- {len(rows)} 种，共 {sum(place_qty(i, None) for i in rows)} 件未归位 ---")


def cmd_box(a):
    inv = load(); L = inv["layout"]
    if a.action == "ls":
        for r in L["racks"]:
            bs = [b for b in boxes(inv) if b["rack"] == r["id"]]
            print(f"{r['id']} {r.get('name','')}  {len(bs)} 箱")
            for lv in range(L.get("levels", 4), 0, -1):
                row = [b for b in bs if b["level"] == lv]
                if not row:
                    continue
                cells = []
                for b in sorted(row, key=lambda x: x["slot"]):
                    n = sum(place_qty(i, b["id"]) for i in inv["items"])
                    cells.append(f"{b['slot']}:{b.get('label') or '-'}({n})")
                print(f"   第{lv}层  " + "  ".join(cells))
        print(f"--- 共 {len(boxes(inv))} 个箱子 ---")
        return
    if a.action == "add":
        if not any(r["id"] == a.rack for r in L["racks"]):
            sys.exit(f"货架不存在：{a.rack}")
        if not (1 <= a.level <= L.get("levels", 4)):
            sys.exit("层号超范围")
        if a.slot not in L.get("slots", []):
            sys.exit(f"槽位非法（可选 {' '.join(L.get('slots', []))}）")
        bid = f"{a.rack}-{a.level}-{a.slot}"
        if any(b["id"] == bid for b in boxes(inv)):
            sys.exit(f"{bid} 已经有箱子了")
        boxes(inv).append({"id": bid, "rack": a.rack, "level": a.level, "slot": a.slot, "label": a.label or ""})
        save(inv); print(f"已加箱：{bid}")
        return
    if a.action == "rm":
        bid = a.rack            # rm 时第一个位置参数就是箱号
        if not any(b["id"] == bid for b in boxes(inv)):
            sys.exit(f"箱子不存在：{bid}")
        used = [i for i in inv["items"] if place_qty(i, bid) > 0]
        if used and not a.force:
            sys.exit(f"{bid} 里还有 {len(used)} 种物料，加 --force 会把它们退回未归位")
        for it in used:
            q = place_qty(it, bid)
            set_place(it, bid, 0)
            set_place(it, None, place_qty(it, None) + q)
        # 不重排其它槽位：实体箱上的标签才不会错乱
        L["boxes"] = [b for b in boxes(inv) if b["id"] != bid]
        save(inv); print(f"已删箱：{bid}" + (f"（{len(used)} 种物料退回未归位）" if used else ""))


def cmd_sync(a):
    """先拉最新再动手——网页那边随时可能刚写过。"""
    subprocess.run(["git", "-C", ROOT, "pull", "--rebase"], check=True)
    inv = load()
    print(f"已同步：{len(inv['items'])} 项，{len(boxes(inv))} 个箱子，"
          f"{sum(total(i) for i in inv['items'])} 件")


def cmd_push(a):
    subprocess.run(["git", "-C", ROOT, "add", "docs"], check=True)
    subprocess.run(["git", "-C", ROOT, "commit", "-m", a.m or "更新库存"], check=False)
    subprocess.run(["git", "-C", ROOT, "push"], check=False)


def main():
    p = argparse.ArgumentParser(description="库存 CLI（数据模型 v2：一品可多箱）")
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("list"); s.add_argument("q", nargs="?"); s.set_defaults(fn=cmd_list)
    s = sub.add_parser("show"); s.add_argument("id"); s.set_defaults(fn=cmd_show)

    s = sub.add_parser("add")
    s.add_argument("--name", required=True); s.add_argument("--qty", type=int); s.add_argument("--seq", type=int)
    s.add_argument("--box", help="放进哪个箱子（省略=未归位）"); s.add_argument("--note"); s.add_argument("--counter")
    s.add_argument("--photo", nargs="*"); s.set_defaults(fn=cmd_add)

    s = sub.add_parser("set"); s.add_argument("id")
    s.add_argument("--name"); s.add_argument("--seq", type=int)
    s.add_argument("--note"); s.add_argument("--counter"); s.set_defaults(fn=cmd_set)

    s = sub.add_parser("rm"); s.add_argument("id"); s.set_defaults(fn=cmd_rm)
    s = sub.add_parser("photo"); s.add_argument("id"); s.add_argument("files", nargs="+"); s.set_defaults(fn=cmd_photo)

    s = sub.add_parser("qty", help="设定某位置的数量")
    s.add_argument("id"); s.add_argument("qty", type=int); s.add_argument("--box"); s.set_defaults(fn=cmd_qty)
    s = sub.add_parser("adjust", help="某位置增减")
    s.add_argument("id"); s.add_argument("delta", type=int); s.add_argument("--box"); s.set_defaults(fn=cmd_adjust)
    s = sub.add_parser("move", help="在箱子之间搬运")
    s.add_argument("id"); s.add_argument("--from", dest="from"); s.add_argument("--to")
    s.add_argument("--qty", type=int); s.set_defaults(fn=cmd_move)

    s = sub.add_parser("unplaced", help="列出未归位的物料"); s.set_defaults(fn=cmd_unplaced)

    s = sub.add_parser("box", help="箱子：ls / add 货架 层 槽 / rm 箱号")
    s.add_argument("action", choices=["ls", "add", "rm"])
    s.add_argument("rack", nargs="?"); s.add_argument("level", nargs="?", type=int); s.add_argument("slot", nargs="?")
    s.add_argument("--label"); s.add_argument("--force", action="store_true"); s.set_defaults(fn=cmd_box)

    s = sub.add_parser("sync", help="git pull --rebase"); s.set_defaults(fn=cmd_sync)
    s = sub.add_parser("push"); s.add_argument("-m"); s.set_defaults(fn=cmd_push)

    a = p.parse_args(); a.fn(a)


if __name__ == "__main__":
    main()
