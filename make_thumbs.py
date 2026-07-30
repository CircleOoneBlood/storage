#!/usr/bin/env python3
"""给 docs/images/ 下的照片批量生成缩略图到 docs/images/thumbs/。

列表页和托盘里每张图只显示 64px 左右，却在下载 1400px 的原图——
84 张 14MB，手机在仓库现场滚一遍就是十几兆流量。缩略图把这个砍掉九成。

约定：`images/x.jpg` 的缩略图固定是 `images/thumbs/x.jpg`，
所以 inventory.json 不用记第二个路径，前端按规则拼就行（拼不到会自动回退到原图）。

可重复运行，已存在且比原图新的会跳过。
"""
import os, sys

ROOT = os.path.dirname(os.path.abspath(__file__))
IMG = os.path.join(ROOT, "docs", "images")
THUMBS = os.path.join(IMG, "thumbs")
MAX_EDGE, Q = 320, 75


def main():
    from PIL import Image, ImageOps
    os.makedirs(THUMBS, exist_ok=True)
    force = "--force" in sys.argv

    srcs = sorted(f for f in os.listdir(IMG)
                  if f.lower().endswith(".jpg") and os.path.isfile(os.path.join(IMG, f)))
    made = skipped = 0
    src_bytes = out_bytes = 0
    for name in srcs:
        s = os.path.join(IMG, name)
        d = os.path.join(THUMBS, name)
        src_bytes += os.path.getsize(s)
        if not force and os.path.exists(d) and os.path.getmtime(d) >= os.path.getmtime(s):
            out_bytes += os.path.getsize(d); skipped += 1; continue
        im = ImageOps.exif_transpose(Image.open(s)).convert("RGB")
        im.thumbnail((MAX_EDGE, MAX_EDGE), Image.LANCZOS)
        im.save(d, "JPEG", quality=Q, optimize=True, progressive=True)
        out_bytes += os.path.getsize(d); made += 1

    # 原图已经删掉的缩略图顺手清掉
    stale = [f for f in os.listdir(THUMBS) if not os.path.exists(os.path.join(IMG, f))]
    for f in stale:
        os.remove(os.path.join(THUMBS, f))

    mb = lambda b: f"{b / 1048576:.1f}MB"
    print(f"生成 {made} 张，跳过 {skipped} 张" + (f"，清掉 {len(stale)} 张孤儿缩略图" if stale else ""))
    print(f"原图 {mb(src_bytes)} → 缩略图 {mb(out_bytes)}"
          + (f"（列表流量降到 {out_bytes / src_bytes:.0%}）" if src_bytes else ""))


if __name__ == "__main__":
    main()
