#!/usr/bin/env python3
"""从 https://aigengtu.com/ 抓表情包，转成 PNG 放进副本的表情包目录。

为什么抓这里：站方 robots.txt 明确 `User-agent: * / Allow: /`（只禁 /admin 与 /api），
且图片是顺序编号的公开 CDN，抓取量小、可重复运行。

为什么用站点的**台词当描述**：归档页每张图的 `alt` 里就带着台词，正好是"给模型看的挑选依据"，
所以抓来的图**不需要再跑视觉模型**（零成本），与动画目录"读离线描述"同一套思路。

为什么必须转 PNG：客户端把配图 URL 硬编码成 `<名>.png`（见 shared-core 的 memeImageUrl），
webp 存进去会图裂。

用法（用 DSH 自带的 Python）：
  python fetch-memes.py --limit 40
  python fetch-memes.py --pages 2 --limit 80
  python fetch-memes.py --dry-run          # 只看会抓哪些，不写文件
"""
import argparse
import html as html_mod
import io
import json
import os
import re
import sys
import time
import urllib.request

ARCHIVE = "https://aigengtu.com/archive"
UA = "dsh-game-pet-watch/1.0 (personal desktop pet; +https://aigengtu.com/robots.txt)"
DEFAULT_OUT = os.path.join(os.path.expanduser("~"), ".dsh", "dsh-pet-gpw", "memes")

# 卡片形如：<img class="ar-thumb" src="https://img.aigengtu.com/0_preview/meme/001.webp"
#           alt="#001 台词…">
CARD_RE = re.compile(
    r'src="https://img\.aigengtu\.com/0_preview/meme/(\d+)\.webp"\s+alt="#\d+\s*([^"]*)"',
    re.S,
)


def fetch(url: str, timeout: int = 30) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "*/*"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def parse_cards(html: str):
    """返回 [(编号, 台词)]，保持页面顺序。"""
    out = []
    seen = set()
    for num, caption in CARD_RE.findall(html):
        if num in seen:
            continue
        seen.add(num)
        # alt 里有 HTML 实体（&#39; 之类），不解码就会把实体本身写进给模型看的描述
        text = html_mod.unescape(caption)
        out.append((num, re.sub(r"\s+", " ", text).strip()))
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--pages", type=int, default=1, help="抓前几页（每页 60 张）")
    ap.add_argument("--limit", type=int, default=40, help="最多抓多少张")
    ap.add_argument("--out", default=DEFAULT_OUT, help="表情包目录（默认副本的用户 memes 目录）")
    ap.add_argument("--prefix", default="梗鲸", help="文件名前缀（编号自动补零）")
    ap.add_argument("--dry-run", action="store_true", help="只列出将抓取的条目")
    args = ap.parse_args()

    cards = []
    for page in range(1, max(1, args.pages) + 1):
        url = ARCHIVE if page == 1 else f"{ARCHIVE}?p={page}"
        try:
            html = fetch(url).decode("utf-8", "replace")
        except Exception as error:  # noqa: BLE001 - 网络错误直接报出来即可
            print(f"抓列表失败（{url}）：{error}", file=sys.stderr)
            return 1
        found = parse_cards(html)
        print(f"  第 {page} 页：{len(found)} 张")
        cards.extend(found)
        if len(cards) >= args.limit:
            break
        time.sleep(0.2)

    cards = cards[: args.limit]
    if not cards:
        print("没解析到任何卡片（站点结构可能变了）", file=sys.stderr)
        return 1

    if args.dry_run:
        for num, caption in cards:
            print(f"  {args.prefix}{num}  {caption[:40]}")
        print(f"（dry-run：共 {len(cards)} 张，未写文件）")
        return 0

    try:
        from PIL import Image  # 只有真要转 PNG 时才要求 Pillow
    except ImportError:
        print("需要 Pillow（DSH 自带 Python 里有）：from PIL import Image 失败", file=sys.stderr)
        return 1

    os.makedirs(args.out, exist_ok=True)
    desc_path = os.path.join(args.out, "descriptions.json")
    descriptions = {}
    if os.path.exists(desc_path):
        try:
            with io.open(desc_path, encoding="utf-8") as fh:
                descriptions = json.load(fh)
        except Exception:
            print("descriptions.json 读不动，将重建", file=sys.stderr)

    saved = skipped = failed = 0
    for num, caption in cards:
        name = f"{args.prefix}{num}"
        target = os.path.join(args.out, name + ".png")
        descriptions[name] = caption
        if os.path.exists(target):
            skipped += 1
            continue
        try:
            raw = fetch(f"https://img.aigengtu.com/0_preview/meme/{num}.webp")
            image = Image.open(io.BytesIO(raw)).convert("RGB")
            image.save(target, "PNG")
            saved += 1
            print(f"  ↓ {name}.png  {caption[:36]}")
        except Exception as error:  # noqa: BLE001
            failed += 1
            print(f"  ✗ {num} 失败：{error}", file=sys.stderr)
        time.sleep(0.15)  # 对站方客气一点

    with io.open(desc_path, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(descriptions, fh, ensure_ascii=False, indent=1, sort_keys=True)

    print(f"完成：新增 {saved}、已存在 {skipped}、失败 {failed}；台词表 {desc_path}")
    print("接着让插件重新扫目录：POST http://127.0.0.1:19387/game-pet-watch/images")
    return 0 if failed == 0 else 2


if __name__ == "__main__":
    raise SystemExit(main())
