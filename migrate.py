#!/usr/bin/env python3
"""一次性迁移：从 Excel 盘点表抽出物料数据 + 图片，生成 docs/inventory.json 与 docs/images/。
图片会被压缩到 web 友好尺寸（最长边 1400px，jpg q82），并修正手机照片的 EXIF 旋转。
"""
import zipfile, json, io, os
import xml.etree.ElementTree as ET
from collections import defaultdict
from PIL import Image, ImageOps

SRC = "龙首谷1号仓库物料盘点清单.xlsx"
OUT_DIR = "docs"
IMG_DIR = os.path.join(OUT_DIR, "images")
MAX_EDGE = 1400
JPG_Q = 82

NS_MAIN = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
NS_XDR = "{http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing}"
NS_A = "{http://schemas.openxmlformats.org/drawingml/2006/main}"
NS_R = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"

z = zipfile.ZipFile(SRC)

# --- 1. 读 sharedStrings ---
shared = []
try:
    root = ET.fromstring(z.read("xl/sharedStrings.xml"))
    for si in root:
        shared.append("".join(t.text or "" for t in si.iter(NS_MAIN + "t")))
except KeyError:
    pass

# --- 2. 读 sheet 数据（行 -> {列字母: 值}）---
def cell_value(c):
    t = c.get("t")
    v = c.find(NS_MAIN + "v")
    if v is None:
        isn = c.find(NS_MAIN + "is")
        return "".join(x.text or "" for x in isn.iter(NS_MAIN + "t")) if isn is not None else ""
    if t == "s":
        return shared[int(v.text)]
    return v.text

def col_letters(ref):
    return "".join(ch for ch in ref if ch.isalpha())

sheet = ET.fromstring(z.read("xl/worksheets/sheet1.xml"))
sdata = sheet.find(NS_MAIN + "sheetData")
rows = {}  # excel_row(1-based) -> {col_letter: value}
for rowel in sdata.findall(NS_MAIN + "row"):
    rnum = int(rowel.get("r"))
    cells = {}
    for c in rowel.findall(NS_MAIN + "c"):
        cells[col_letters(c.get("r"))] = cell_value(c)
    rows[rnum] = cells

# --- 3. 图片：from_row(0-based) -> [media 路径]，按锚点顺序 ---
rels = ET.fromstring(z.read("xl/drawings/_rels/drawing1.xml.rels"))
rid2media = {r.get("Id"): r.get("Target").replace("../", "xl/") for r in rels}
drawing = ET.fromstring(z.read("xl/drawings/drawing1.xml"))
row2media = defaultdict(list)
for an in drawing:
    frm = an.find(NS_XDR + "from")
    if frm is None:
        continue
    rrow = frm.find(NS_XDR + "row")
    blip = an.find(".//" + NS_A + "blip")
    if rrow is None or blip is None:
        continue
    embed = blip.get(NS_R + "embed")
    media = rid2media.get(embed)
    if media:
        row2media[int(rrow.text)].append(media)

# --- 4. 图片压缩落盘 ---
os.makedirs(IMG_DIR, exist_ok=True)
def save_web_image(media_path, out_name):
    raw = z.read(media_path)
    im = Image.open(io.BytesIO(raw))
    im = ImageOps.exif_transpose(im)          # 修正手机照片旋转
    if im.mode in ("RGBA", "P", "LA"):
        bg = Image.new("RGB", im.size, (255, 255, 255))
        im = im.convert("RGBA")
        bg.paste(im, mask=im.split()[-1])
        im = bg
    else:
        im = im.convert("RGB")
    im.thumbnail((MAX_EDGE, MAX_EDGE), Image.LANCZOS)
    out_path = os.path.join(IMG_DIR, out_name)
    im.save(out_path, "JPEG", quality=JPG_Q, optimize=True)
    return os.path.getsize(out_path)

# --- 5. 组装 items（数据行 = Excel 第 3 行起）---
HEADER_ROW = 2          # 第 2 行是表头
items = []
COLMAP = {  # 列字母 -> 字段
    "A": ("seq", "int"), "B": ("name", "str"), "C": ("qty", "int"),
    "D": ("location", "str"), "E": ("note", "str"), "F": ("counter", "str"),
}
def to_int(s):
    try:
        return int(float(str(s).strip()))
    except Exception:
        return str(s).strip()

total_bytes = 0
dropped = []
data_rows = sorted(r for r in rows if r > HEADER_ROW)
for rnum in data_rows:
    cells = rows[rnum]
    rec = {}
    for col, (key, typ) in COLMAP.items():
        val = cells.get(col, "")
        val = val if val is not None else ""
        rec[key] = to_int(val) if typ == "int" else str(val).strip()
    seq = rec.get("seq")
    media_list = row2media.get(rnum - 1, [])  # 0-based 锚点行
    name = str(rec.get("name", "")).strip()
    has_name = bool(name)
    has_qty = isinstance(rec.get("qty"), int)
    has_photo = len(media_list) > 0
    # 丢弃完全空的废行（无名 + 无数量 + 无照片）
    if not (has_name or has_qty or has_photo):
        dropped.append((rnum, seq, "空行"))
        continue
    # 丢弃总计/小计这类汇总行
    if name in ("合计", "总计", "小计", "总数"):
        dropped.append((rnum, seq, f"汇总行({name})"))
        continue
    item_id = f"{seq:03d}" if isinstance(seq, int) else f"r{rnum}"
    rec["id"] = item_id
    # 图片
    photos = []
    for i, media in enumerate(media_list, 1):
        out_name = f"{item_id}-{i}.jpg"
        total_bytes += save_web_image(media, out_name)
        photos.append(f"images/{out_name}")
    rec["photos"] = photos
    items.append(rec)

# id 顺序在前
items = [{"id": it.pop("id"), **it} for it in items]

inventory = {
    "title": "龙首谷1号仓库物料清单",
    "fields": [
        {"key": "seq", "label": "序号", "type": "number"},
        {"key": "name", "label": "名称", "type": "text"},
        {"key": "qty", "label": "数量", "type": "number"},
        {"key": "location", "label": "存放位置编号", "type": "text"},
        {"key": "note", "label": "备注", "type": "text"},
        {"key": "counter", "label": "盘点人", "type": "text"},
    ],
    "items": items,
}

os.makedirs(OUT_DIR, exist_ok=True)
with open(os.path.join(OUT_DIR, "inventory.json"), "w", encoding="utf-8") as f:
    json.dump(inventory, f, ensure_ascii=False, indent=2)

# 留言板种子文件
msg_path = os.path.join(OUT_DIR, "messages.json")
if not os.path.exists(msg_path):
    with open(msg_path, "w", encoding="utf-8") as f:
        json.dump({"messages": []}, f, ensure_ascii=False, indent=2)

n_photos = sum(len(it["photos"]) for it in items)
print(f"保留物料条目: {len(items)}")
print(f"有照片的条目: {sum(1 for it in items if it['photos'])}")
print(f"导出图片: {n_photos} 张, 合计 {total_bytes/1024/1024:.1f} MB")
print(f"丢弃行: {len(dropped)} 行 -> {[(d[0], d[2]) for d in dropped]}")
print(f"输出: {OUT_DIR}/inventory.json, {IMG_DIR}/")
print("首条:", json.dumps(items[0], ensure_ascii=False))
print("末条:", json.dumps(items[-1], ensure_ascii=False))
