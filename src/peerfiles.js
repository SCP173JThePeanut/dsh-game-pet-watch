/**
 * 读对家副本**落盘的文件**（只读）—— 让"关着的对家"也还能出现在历史里。
 *
 * 背景：对家的说话记录有两份存在形式：
 *   ① 活着时：`GET /gw/log`（实时，但要它的进程在跑才能读）
 *   ② 落盘后：`<它的 userRoot>/state.json` 里的 `log` 数组（**进程关掉文件还在**）
 *
 * 只做 ① 的话，"对家一关，它说过的话就从历史里消失"。所以这里把 ② 也读进来：
 * 每个兄弟 userRoot（`$DSH_HOME/dsh-pet-*`，排除自己的）都扫一遍，
 * 取 `state.json` 的 `log`，名字从同目录的 `prefs.json` 的 `petName` 取。
 *
 * 注意边界：
 *   - 只读，绝不写别人的文件；
 *   - 文件里只留最近 200 条（副本自己的上限），所以"更早的"仍然要靠我们这边的
 *     历史日志（journal）——两者互补：文件补"关闭期间没看到的"，日志保"看过的永不丢"；
 *   - 解析失败/半行都跳过，不能让一个坏文件拖垮历史页。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** 读一个 userRoot 的名字（prefs.json 的 petName），没有就空串 */
function readPetName(userRoot) {
  try {
    const raw = JSON.parse(readFileSync(join(userRoot, 'prefs.json'), 'utf8'));
    return typeof raw?.petName === 'string' ? raw.petName.trim() : '';
  } catch {
    return '';
  }
}

/**
 * 扫所有兄弟副本的落盘记录。
 * @param {{dshHome:string, selfUserRoot?:string, limitPerPeer?:number, log?:(m:string)=>void}} options
 * @returns {Array<{at:number, kind:'peer', who:string, text:string, image?:string, source:'peerfile'}>}
 */
/** 上一次打过的对家摘要（用于节流 ✓） */
let lastPeersLog = { line: '', at: 0 };

export function readPeerLogs(options) {
  const dshHome = options.dshHome;
  const selfUserRoot = options.selfUserRoot ? options.selfUserRoot.replace(/[\\/]+$/, '').toLowerCase() : '';
  const limitPerPeer = Math.max(1, Number(options.limitPerPeer ?? 200));
  const log = options.log ?? (() => {});
  const out = [];
  const peers = [];

  let names = [];
  try {
    names = readdirSync(dshHome);
  } catch {
    return out;
  }

  for (const name of names) {
    if (!/^dsh-pet-/.test(name)) continue; // 约定：副本的用户目录都叫 dsh-pet-*
    const userRoot = join(dshHome, name);
    if (selfUserRoot && userRoot.replace(/[\\/]+$/, '').toLowerCase() === selfUserRoot) continue; // 自己那份走实时接口
    const stateFile = join(userRoot, 'state.json');
    if (!existsSync(stateFile)) continue;

    let entries = [];
    try {
      const parsed = JSON.parse(readFileSync(stateFile, 'utf8'));
      entries = Array.isArray(parsed?.log) ? parsed.log.slice(-limitPerPeer) : [];
    } catch (error) {
      log(`对家文件读不动（跳过）：${stateFile} — ${error?.message ?? error}`);
      continue;
    }
    const petName = readPetName(userRoot) || name;
    let count = 0;
    for (const entry of entries) {
      if (!Number.isFinite(entry?.at) || typeof entry?.text !== 'string' || !entry.text.trim()) continue;
      out.push({
        at: entry.at,
        kind: 'peer',
        who: petName,
        text: entry.text.trim(),
        ...(typeof entry.image === 'string' && entry.image ? { image: entry.image } : {}),
        source: 'peerfile',
      });
      count += 1;
    }
    if (count) peers.push(`${petName}(${count})`);
  }

  /**
   * 节流：只按**对家集合**判断（名字 ✓），**不能带条数** ✗。
   *
   * 第一版拿 "名字(条数)" 当摘要 ✗ → 对家每说一句条数就变 ✓ → 摘要每次都"变了" ✓
   * → 等于没节流 ✓（实测重启后仍然 4 秒一条刷屏 ✗）。条数只作为附带信息打出来 ✓。
   */
  const peerNames = peers.map((p) => String(p).replace(/\(\d+\)$/, '')).join('、');
  if (peerNames && (peerNames !== lastPeersLog.line || Date.now() - lastPeersLog.at > 10 * 60_000)) {
    lastPeersLog = { line: peerNames, at: Date.now() };
    log('对家落盘记录：' + peers.join('、'));
  }
  return out;
}
