#!/usr/bin/env python3
"""inv —— 库存 / 留言板的命令行操作（给 agent 和电脑端用）。
直接读写 docs/inventory.json 与 docs/messages.json，照片自动压缩进 docs/images/。
用法示例：
  python3 inv.py list [关键词]
  python3 inv.py show 12
  python3 inv.py add --name "牛皮纸箱" --qty 50 --location 1-2-a --counter 张三
  python3 inv.py set 12 --qty 30 --note "补货后"
  python3 inv.py adjust 12 -5            # 数量增减
  python3 inv.py rm 12
  python3 inv.py photo 12 /path/a.jpg /path/b.jpg
  python3 inv.py inbox                   # 看留言
  python3 inv.py reply "已录入3条" [--photo /path/x.jpg]
  python3 inv.py push -m "更新库存"      # git add+commit+push
"""
import argparse, json, os, sys, subprocess, io, datetime

ROOT = os.path.dirname(os.path.abspath(__file__))
DOCS = os.path.join(ROOT, "docs")
INV = os.path.join(DOCS, "inventory.json")
MSG = os.path.join(DOCS, "messages.json")
IMG = os.path.join(DOCS, "images")
MAX_EDGE, JPG_Q = 1400, 82


def load(p, default):
    try:
        with open(p, encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return default


def save(p, obj):
    with open(p, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)


def find(inv, key):
    key = str(key)
    for it in inv["items"]:
        if it["id"] == key or str(it.get("seq")) == key:
            return it
    return None


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
    out = os.path.join(DOCS, rel)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    im.save(out, "JPEG", quality=JPG_Q, optimize=True)
    return rel


def fmt_item(it):
    p = f" 📷{len(it.get('photos', []))}" if it.get("photos") else ""
    extra = " ".join(x for x in [
        f"@{it['location']}" if it.get("location") else "",
        f"备注:{it['note']}" if it.get("note") else "",
        f"盘:{it['counter']}" if it.get("counter") else "",
    ] if x)
    return f"[{it['seq']:>3}] {it['name'] or '(未命名)'}  ×{it.get('qty','')}{p}  {extra}".rstrip()


# ---------- 命令 ----------
def cmd_list(a):
    inv = load(INV, {"items": []})
    items = inv["items"]
    if a.q:
        q = a.q.lower()
        items = [it for it in items if any(q in str(it.get(k, "")).lower() for k in ("name", "location", "note", "counter", "seq"))]
    for it in items:
        print(fmt_item(it))
    print(f"--- {len(items)}/{len(inv['items'])} 项 ---")


def cmd_show(a):
    inv = load(INV, {"items": []}); it = find(inv, a.id)
    if not it: sys.exit(f"找不到：{a.id}")
    print(json.dumps(it, ensure_ascii=False, indent=2))


def cmd_add(a):
    inv = load(INV, {"items": []})
    iid = next_id(inv)
    it = {"id": iid, "seq": a.seq if a.seq is not None else next_seq(inv),
          "name": a.name, "qty": a.qty if a.qty is not None else "",
          "location": a.location or "", "note": a.note or "", "counter": a.counter or "", "photos": []}
    for i, src in enumerate(a.photo or [], 1):
        it["photos"].append(save_photo(iid, src, i))
    inv["items"].append(it)
    inv["items"].sort(key=lambda x: (float(x["seq"]) if str(x.get("seq","")).lstrip("-").replace(".","").isdigit() else 1e9))
    save(INV, inv); print("已添加："); print(fmt_item(it))


def cmd_set(a):
    inv = load(INV, {"items": []}); it = find(inv, a.id)
    if not it: sys.exit(f"找不到：{a.id}")
    for k in ("name", "qty", "location", "note", "counter", "seq"):
        v = getattr(a, k)
        if v is not None: it[k] = v
    save(INV, inv); print("已更新："); print(fmt_item(it))


def cmd_adjust(a):
    inv = load(INV, {"items": []}); it = find(inv, a.id)
    if not it: sys.exit(f"找不到：{a.id}")
    try:
        it["qty"] = int(it.get("qty") or 0) + a.delta
    except (ValueError, TypeError):
        sys.exit("当前数量不是整数，无法增减")
    save(INV, inv); print("已调整："); print(fmt_item(it))


def cmd_rm(a):
    inv = load(INV, {"items": []}); it = find(inv, a.id)
    if not it: sys.exit(f"找不到：{a.id}")
    inv["items"] = [x for x in inv["items"] if x["id"] != it["id"]]
    save(INV, inv); print(f"已删除：{it['name']}")


def cmd_photo(a):
    inv = load(INV, {"items": []}); it = find(inv, a.id)
    if not it: sys.exit(f"找不到：{a.id}")
    n = len(it.get("photos", []))
    it.setdefault("photos", [])
    for i, src in enumerate(a.files, n + 1):
        it["photos"].append(save_photo(it["id"], src, i))
    save(INV, inv); print(f"已加 {len(a.files)} 张照片到 {it['name']}")


def cmd_inbox(a):
    board = load(MSG, {"messages": []})
    for i, m in enumerate(board["messages"]):
        who = "🤖Agent" if m.get("author") == "agent" else "🧑用户"
        ph = "  📷" + ",".join(m.get("photos", [])) if m.get("photos") else ""
        print(f"#{i} {who} {m.get('ts','')[:16]}\n   {m.get('text','')}{ph}")
    print(f"--- 共 {len(board['messages'])} 条 ---")


def cmd_reply(a):
    board = load(MSG, {"messages": []})
    ts = datetime.datetime.now().isoformat(timespec="seconds")
    stamp = ts.replace(":", "-")
    photos = [save_photo(f"msg/{stamp}", src, i) for i, src in enumerate(a.photo or [], 1)]
    board.setdefault("messages", []).append(
        {"id": "m" + stamp, "ts": ts, "author": "agent", "text": a.text, "photos": photos})
    save(MSG, board); print("已回复留言")


def cmd_push(a):
    msg = a.m or "更新库存/留言"
    subprocess.run(["git", "-C", ROOT, "add", "docs"], check=True)
    subprocess.run(["git", "-C", ROOT, "commit", "-m", msg], check=False)
    subprocess.run(["git", "-C", ROOT, "push"], check=False)


def main():
    p = argparse.ArgumentParser(description="库存/留言 CLI")
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("list"); s.add_argument("q", nargs="?"); s.set_defaults(fn=cmd_list)
    s = sub.add_parser("show"); s.add_argument("id"); s.set_defaults(fn=cmd_show)
    s = sub.add_parser("add")
    s.add_argument("--name", required=True); s.add_argument("--qty", type=int); s.add_argument("--seq", type=int)
    s.add_argument("--location"); s.add_argument("--note"); s.add_argument("--counter")
    s.add_argument("--photo", nargs="*"); s.set_defaults(fn=cmd_add)
    s = sub.add_parser("set"); s.add_argument("id")
    s.add_argument("--name"); s.add_argument("--qty", type=int); s.add_argument("--seq", type=int)
    s.add_argument("--location"); s.add_argument("--note"); s.add_argument("--counter"); s.set_defaults(fn=cmd_set)
    s = sub.add_parser("adjust"); s.add_argument("id"); s.add_argument("delta", type=int); s.set_defaults(fn=cmd_adjust)
    s = sub.add_parser("rm"); s.add_argument("id"); s.set_defaults(fn=cmd_rm)
    s = sub.add_parser("photo"); s.add_argument("id"); s.add_argument("files", nargs="+"); s.set_defaults(fn=cmd_photo)
    s = sub.add_parser("inbox"); s.set_defaults(fn=cmd_inbox)
    s = sub.add_parser("reply"); s.add_argument("text"); s.add_argument("--photo", nargs="*"); s.set_defaults(fn=cmd_reply)
    s = sub.add_parser("push"); s.add_argument("-m"); s.set_defaults(fn=cmd_push)

    a = p.parse_args(); a.fn(a)


if __name__ == "__main__":
    main()
