// 空闲退避观察器：定时采样插件的活跃度状态，验证"人走→退避、人回→立刻恢复"。
//   node scripts/backoff-watch.mjs [--minutes 30] [--every 30]
//
// 采样字段（都来自插件 /state 的 runtime）：
//   idleMs              键鼠空闲毫秒（Win32 GetLastInputInfo）
//   backoff             当前倍数（1 = 正常）
//   effectiveIntervalSec 实际间隔 = intervalSec × backoff
//   screenChanged       这一轮的截图字节数是否与上轮不同
//   captures            累计截帧数（用来算"这段时间真的问了几次"）
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = argv.indexOf(name);
  return i !== -1 && argv[i + 1] ? Number(argv[i + 1]) : fallback;
};
const MINUTES = argOf('--minutes', 30);
const EVERY_MS = argOf('--every', 30) * 1000;
const PLUGIN = 'http://127.0.0.1:19387/game-pet-watch/state';
const OUT_DIR = join(homedir(), '.dsh', 'dsh-pet-gpw');
const JSON_OUT = join(OUT_DIR, 'backoff-watch.json');
const LOG_OUT = join(OUT_DIR, 'backoff-watch.log');

const samples = [];
const startedAt = Date.now();
const deadline = startedAt + MINUTES * 60 * 1000;

const line = (text) => {
  process.stdout.write(text + '\n');
  try {
    appendFileSync(LOG_OUT, text + '\n', 'utf8');
  } catch {
    /* 落盘失败不影响观察 */
  }
};

line(`观察开始：${new Date().toLocaleTimeString()}，每 ${EVERY_MS / 1000}s 一次，共 ${MINUTES} 分钟`);

async function sample() {
  try {
    const res = await fetch(PLUGIN, { signal: AbortSignal.timeout(5000) });
    const data = await res.json();
    if (!data?.ok) throw new Error('state 不是 ok');
    const r = data.runtime ?? {};
    return {
      at: Date.now(),
      idleSec: r.idleMs === null || r.idleMs === undefined ? null : Math.round(r.idleMs / 1000),
      backoff: r.backoff ?? null,
      effectiveIntervalSec: r.effectiveIntervalSec ?? null,
      lastFrameBytes: r.lastFrameBytes ?? null,
      captures: r.captures ?? null,
      speaks: r.speaks ?? null,
      running: r.running === true,
      lastFrameAt: r.lastFrameAt ?? null,
    };
  } catch (error) {
    return { at: Date.now(), error: String(error?.message ?? error) };
  }
}

let lastCaptures = null;
while (Date.now() < deadline) {
  const s = await sample();
  if (s.error) {
    line(`${new Date().toLocaleTimeString()}  采样失败：${s.error}`);
  } else {
    const delta = lastCaptures === null || s.captures === null ? null : s.captures - lastCaptures;
    lastCaptures = s.captures;
    samples.push(s);
    line(
      `${new Date(s.at).toLocaleTimeString()}  空闲 ${String(s.idleSec).padStart(5)}s  ` +
        `倍数 ${String(s.backoff).padStart(2)}×  实际间隔 ${String(s.effectiveIntervalSec).padStart(4)}s  ` +
        `帧 ${s.lastFrameBytes ?? '?'}B  累计截取 ${s.captures}` +
        (delta === null ? '' : `（本轮 +${delta}）`) +
        `  开口 ${s.speaks}`,
    );
  }
  await new Promise((r) => setTimeout(r, EVERY_MS));
}

// ---- 结论 ----
const ok = samples.filter((s) => !s.error);
const quiet = ok.filter((s) => s.idleSec !== null && s.idleSec >= 60);
const backedOff = ok.filter((s) => (s.backoff ?? 1) > 1);
const recovered = ok.filter((s) => s.idleSec !== null && s.idleSec < 60 && (s.backoff ?? 1) === 1);
const maxFactor = Math.max(1, ...ok.map((s) => s.backoff ?? 1));
const busySamples = ok.filter((s) => s.idleSec !== null && s.idleSec < 60);
const firstCapture = ok.find((s) => s.captures !== null)?.captures ?? 0;
const lastCapture = [...ok].reverse().find((s) => s.captures !== null)?.captures ?? 0;

const summary = {
  startedAt,
  finishedAt: Date.now(),
  minutes: MINUTES,
  samples: samples.length,
  failed: samples.length - ok.length,
  quietSamples: quiet.length,
  backedOffSamples: backedOff.length,
  recoveredSamples: recovered.length,
  maxFactor,
  capturesDuringWindow: Math.max(0, lastCapture - firstCapture),
  idleRangeSec: ok.length
    ? [Math.min(...ok.map((s) => s.idleSec ?? 0)), Math.max(...ok.map((s) => s.idleSec ?? 0))]
    : null,
  samplesDetail: samples,
};
writeFileSync(JSON_OUT, JSON.stringify(summary, null, 2), 'utf8');

line('');
line('=== 结论 ===');
line(`  采样 ${summary.samples} 次（失败 ${summary.failed}）`);
line(`  空闲区间：${summary.idleRangeSec ? summary.idleRangeSec[0] + 's ~ ' + summary.idleRangeSec[1] + 's' : '无数据'}`);
line(`  "安静"样本（空闲≥60s 且画面无变化）：${summary.quietSamples}`);
line(`  进入退避的样本：${summary.backedOffSamples}，最大倍数 ${summary.maxFactor}×`);
line(`  人在场的样本（空闲<60s）：${busySamples.length}，其中倍数已回到 1× 的：${summary.recoveredSamples}`);
line(`  窗口内新增截取：${summary.capturesDuringWindow} 次`);
line(`  报告：${JSON_OUT}`);
line('');
if (summary.backedOffSamples === 0 && summary.quietSamples === 0) {
  line('  判定：这段时间里没有出现"安静"状态（可能你一直在动，或画面一直在变）——退避没被触发，不算通过也不算失败。');
} else if (summary.backedOffSamples > 0) {
  line('  判定：退避**已触发**。人回来的样本里倍数回到 1× 说明恢复路径也在工作。');
} else {
  line('  判定：出现安静但倍数没升——检查 capture.idleMs() 探针是否可用（PowerShell 探针失败时会保守地不降频）。');
}
