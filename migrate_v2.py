#!/usr/bin/env python3
"""一次性迁移：inventory.json v1 -> v2。

v1: item 有 qty(单个数字) + location(自由文本)
v2: item 有 places=[{box, qty}]（box=None 表示未归位），总数 = 各 place 之和
    顶层新增 layout（货架 / 层 / 槽位 / 箱子）

旧的 location 文本不丢，存进 legacyLocation，等实体货架贴好标签后再认领。
"""
import json, os, sys, shutil

ROOT = os.path.dirname(os.path.abspath(__file__))
INV = os.path.join(ROOT, "docs", "inventory.json")

# 物理布局：通道两侧各两个货架，每个货架从下往上 4 层，每层槽位从左到右 a..f
RACKS = [
    {"id": "L1", "name": "左1架", "side": "left", "order": 1},
    {"id": "L2", "name": "左2架", "side": "left", "order": 2},
    {"id": "R1", "name": "右1架", "side": "right", "order": 1},
    {"id": "R2", "name": "右2架", "side": "right", "order": 2},
]
LEVELS = 4
SLOTS = ["a", "b", "c", "d", "e", "f"]


def main():
    with open(INV, encoding="utf-8") as f:
        inv = json.load(f)

    if inv.get("schemaVersion") == 2:
        sys.exit("已经是 v2，无需迁移")

    shutil.copy(INV, INV + ".v1.bak")

    items = []
    for it in inv.get("items", []):
        qty = it.get("qty")
        try:
            qty = int(qty)
        except (TypeError, ValueError):
            qty = 0
        new = {
            "id": it["id"],
            "seq": it.get("seq"),
            "name": it.get("name", ""),
            "note": it.get("note", ""),
            "counter": it.get("counter", ""),
            "photos": it.get("photos", []),
            # 全部先落到「未归位」，等实体货架编号确定后再逐条归位
            "places": [{"box": None, "qty": qty}] if qty else [],
        }
        if it.get("location"):
            new["legacyLocation"] = it["location"]
        items.append(new)

    out = {
        "title": inv.get("title", "库存清单"),
        "schemaVersion": 2,
        "layout": {"levels": LEVELS, "slots": SLOTS, "racks": RACKS, "boxes": []},
        "items": items,
    }

    with open(INV, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)

    legacy = sum(1 for i in items if i.get("legacyLocation"))
    total = sum(sum(p["qty"] for p in i["places"]) for i in items)
    print(f"迁移完成：{len(items)} 条物料，合计 {total} 件，全部标记为未归位。")
    print(f"其中 {legacy} 条带旧位置文本（存在 legacyLocation，待认领）。")
    print(f"备份：{INV}.v1.bak")


if __name__ == "__main__":
    main()
