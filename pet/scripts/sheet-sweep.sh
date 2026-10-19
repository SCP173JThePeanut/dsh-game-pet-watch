#!/usr/bin/env bash
# 批量压测抽帧台：把每段动画都过一遍，报告成功/失败与耗时。
# 用法： bash scripts/sheet-sweep.sh [端口] [并发数]
set -u
PORT="${1:-7341}"
OUT="${TMPDIR:-/tmp}/gpw-sheet-sweep"
mkdir -p "$OUT"

curl -s -m 10 "http://127.0.0.1:${PORT}/gpw/assets" > "$OUT/assets.json" || true
python - "$OUT" <<'PY'
import json, sys, os
out = sys.argv[1]
data = json.load(open(os.path.join(out, 'assets.json'), encoding='utf-8'))
files = [f['file'] for f in data.get('files', [])]
print('\n'.join(files))
PY
