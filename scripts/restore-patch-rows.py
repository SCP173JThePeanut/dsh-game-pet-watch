# 把崩溃时丢掉的插件行补回 cordis.patch.yml（只补缺失的 id，不动已有内容）
import io, os, re, shutil

PATCH = 'C:/Users/Kishin/.dsh/profiles/desktop/cordis.patch.yml'
BACKUP = 'C:/Users/Kishin/.dsh/profiles/desktop/cordis.patch.yml.bak-1791989805495'

cur = io.open(PATCH, encoding='utf-8').read()
bak = io.open(BACKUP, encoding='utf-8').read()

# 当前已有哪些 id
have = set(re.findall(r'^- id:\s*(\S+)', cur, re.M))

# 备份里按 "- id:" 切成块（保留注释头）
head_end = bak.index('- id:')
head = bak[:head_end]
blocks = re.split(r'(?m)^(?=- id:)', bak[head_end:])

missing = []
for blk in blocks:
    m = re.match(r'- id:\s*(\S+)', blk)
    if not m:
        continue
    pid = m.group(1)
    if pid not in have:
        missing.append((pid, blk.rstrip() + '\n'))

if not missing:
    print('没有缺失的 id，无需改动')
    raise SystemExit(0)

shutil.copyfile(PATCH, PATCH + '.pre-restore')
out = cur.rstrip() + '\n\n' + '\n'.join(b for _, b in missing)
io.open(PATCH, 'w', encoding='utf-8', newline='\n').write(out)
print('已补回 %d 个 id：%s' % (len(missing), ', '.join(p for p, _ in missing)))
