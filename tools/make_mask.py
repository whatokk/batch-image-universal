#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
生成遮罩(用于 /images/edits 的 mask 参数) —— 局部重绘工具

用途: 只改图里的指定区域, 其余像素保持原样。
      例如「背景换掉但主体不动」「只改天空」「只替换画面某一块」。
      遮罩里标为可编辑的区域会被模型重画, 其余区域保持原图不变。

用法:
  1. 编辑 polygons.json, 为每张图列出可编辑区域多边形(归一化坐标 0~1)
     支持 add(可编辑) 与 sub(从可编辑区里挖掉, 如要保留的细节)
  2. python make_mask.py
  3. 产出: masks/<name>.png (遮罩) 与 mask_preview/<name>.jpg (叠加预览, 用于人工核对边界)
     —— 务必先看预览确认边界正确, 再拿去出图, 否则会改错区域。
"""
import json
import os
from PIL import Image, ImageDraw, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))

# 默认以「脚本所在目录」为根；若脚本位于 tools/ 子目录（本仓库的默认布局），
# 则自动上溯到项目根目录，这样 polygons.json / ref / masks 都跟 batch.mjs 同级，
# 不必 cd 到特定目录再运行。
_candidates = [os.path.dirname(HERE), HERE]
ROOT = HERE
for _c in _candidates:
    if os.path.exists(os.path.join(_c, "polygons.json")):
        ROOT = _c
        break
else:
    ROOT = os.path.dirname(HERE) if os.path.basename(HERE) == "tools" else HERE

CFG = os.path.join(ROOT, "polygons.json")
MASK_DIR = os.path.join(ROOT, "masks")
PREVIEW_DIR = os.path.join(ROOT, "mask_preview")


def build_mask(size, add_polys, sub_polys, feather=0, invert_for_openai=True):
    """返回 L 模式遮罩: 255=可编辑区域, 0=保留区域"""
    w, h = size
    # 先全部涂黑(保留), 再把可编辑区涂白
    m = Image.new("L", (w, h), 0)
    d = ImageDraw.Draw(m)
    for poly in add_polys:
        d.polygon([(x * w, y * h) for x, y in poly], fill=255)
    for poly in sub_polys:
        d.polygon([(x * w, y * h) for x, y in poly], fill=0)
    if feather > 0:
        m = m.filter(ImageFilter.GaussianBlur(feather))
    return m


def to_openai_mask(editable):
    """OpenAI /images/edits 语义: 透明(alpha=0)处才会被编辑 -> 把可编辑区做成透明"""
    w, h = editable.size
    rgba = Image.new("RGBA", (w, h), (0, 0, 0, 255))
    # 可编辑区 alpha=0
    rgba.putalpha(editable.point(lambda v: 255 - v))
    return rgba


def main():
    with open(CFG, encoding="utf-8") as f:
        cfg = json.load(f)
    os.makedirs(MASK_DIR, exist_ok=True)
    os.makedirs(PREVIEW_DIR, exist_ok=True)

    for item in cfg["items"]:
        src = os.path.join(ROOT, item["image"])
        im = Image.open(src).convert("RGB")
        w, h = im.size
        editable = build_mask((w, h), item.get("add", []), item.get("sub", []), item.get("feather", 0))

        # 1) 给接口用的 RGBA 遮罩
        out_mask = os.path.join(MASK_DIR, item["name"] + ".png")
        to_openai_mask(editable).save(out_mask)

        # 2) 人工核对用的叠加预览
        prev = im.copy()
        tint = Image.new("RGB", (w, h), (255, 0, 0))
        prev = Image.composite(tint, prev, editable.point(lambda v: int(v * 0.45)))
        # 画边界线
        edge = editable.filter(ImageFilter.FIND_EDGES).point(lambda v: 255 if v > 40 else 0)
        prev = Image.composite(Image.new("RGB", (w, h), (0, 255, 0)), prev, edge)
        prev.thumbnail((760, 1014))
        out_prev = os.path.join(PREVIEW_DIR, item["name"] + ".jpg")
        prev.save(out_prev, quality=88)

        # 统计可编辑占比（用直方图，避免 getdata 在新版 Pillow 中的弃用告警）
        hist = editable.histogram()
        px = sum(hist[128:])
        print(f"{item['name']:<28} {w}x{h}  可编辑占比 {px / (w * h) * 100:5.1f}%  -> {out_mask}")

    print("预览目录:", PREVIEW_DIR)


if __name__ == "__main__":
    main()
