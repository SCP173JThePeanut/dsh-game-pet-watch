"""
把 P1-1 的配图 CSS 补齐到**所有副本**（原版规则是 width:0.34×体型 + height:auto + object-fit:cover）。

为什么要单独写个脚本：
  这个 CSS 在仓库里有 3 份（web overlay 的 lib/client.js、桌面的 electron-helper/shared-core.js、
  以及桌面副本的 electron-helper-copy/shared-core.js）。我上次只改了实际在用的那份 ——
  另外两份留着老规则，凡是用到它们的界面就仍然是"长图被裁 + 大图很小"（OpenCode 复核时发现的）。
  以后再出现第 4 份，跑一次这个脚本即可；check-image-css.mjs 会盯着别再漏。

用法：python scripts/fix-image-css.py [--dry]
"""
import io, sys, os

DRY = '--dry' in sys.argv

# 默认目标：本仓库里"定义配图 CSS"的两份。也可在命令行追加任意路径，例如要补上游包：
#   python scripts/fix-image-css.py "<...>/node_modules/dsh-pet/runtime/electron-helper/shared-core.js"
DEFAULT_TARGETS = [
    'runtime/electron-helper/shared-core.js',
    'lib/client.js',
]
EXTRA = [a for a in sys.argv[1:] if not a.startswith('--')]
TARGETS = DEFAULT_TARGETS + EXTRA

NEW_CSS = '''const MEME_IMG_CLASS = "pet-bub-img";
const MEME_BUBBLE_CLASS = "has-img";
/**
 * 配图尺寸（**副本改过**，原版是写死宽度 0.34×宠物体型 + height:auto + object-fit:cover）。
 *
 * 原版三个问题（都已实测）：
 *   ① 竖长图被切：高度完全不限，长图顶出窗口（实测 top=-79，被裁 79px）
 *   ② 大图显示太小：写死 0.34×体型 ≈184px，画质再高也看不清
 *   ③ cover 会裁掉画面边缘（表情包的文字常在最下面，一裁就废）
 *
 * 现在：**限宽 + 限高 + contain**（等比缩放、完整可见）。
 *   宽上限 1.0×体型、高上限 0.44×体型 —— 0.44 来自实测：气泡上方可用空间约 0.62×体型，
 *   扣掉文字行与内边距后的余量。改窗口留白（WINDOW_MARGIN_RATIO）必须重算这个数。
 */
const MEME_BUBBLE_CSS = [
\t".pet-bub-img{display:block;width:auto;height:auto;",
\t"max-width:calc(var(--dsh-pet-size,var(--pet-size,462px))*1.0);",
\t"max-height:calc(var(--dsh-pet-size,var(--pet-size,462px))*0.44);",
\t"border-radius:calc(var(--dsh-pet-size,var(--pet-size,462px))*0.026);",
\t"margin:0 auto calc(var(--dsh-pet-size,var(--pet-size,462px))*0.017);object-fit:contain;",
\t"pointer-events:none;user-select:none}",
\t// 带图的气泡要放宽：文字气泡的 max-width 是 0.5×体型，图片比它宽就会挂在背景外面
\t// （实测：图 432 宽、气泡只有 180 宽，左右各凸 260px）。这里放到 1.15×体型。
\t".pet-bubble.has-img,.dsh-pet-bubble.has-img{min-width:0;",
\t"max-width:calc(var(--dsh-pet-size,var(--pet-size,462px))*1.15)}"
].join("");'''

def patch(path):
    if not os.path.exists(path):
        return 'skip (missing)'
    s = io.open(path, encoding='utf-8').read()
    start = s.index('const MEME_IMG_CLASS = "pet-bub-img";')
    end = s.index('.join("");', start) + len('.join("");')
    old = s[start:end]
    if 'max-height' in old and 'object-fit:contain' in old:
        return 'already-fixed'
    s = s[:start] + NEW_CSS + s[end:]
    if not DRY:
        io.open(path, 'w', encoding='utf-8', newline='\n').write(s)
    return 'patched'

for t in TARGETS:
    print('  %-52s %s' % (t, patch(t)))
print('  (--dry 演练模式，未写盘)' if DRY else '  完成')
