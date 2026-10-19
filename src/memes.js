/**
 * 梗鲸表情包库（aigengtu.com）—— **按需检索 + 下载**，让模型自己要图。
 *
 * 为什么可以用：站方 robots.txt 明确 `User-agent: * / Allow: /`（只禁 /admin 与 /api），
 * 所以我们只用它**公开的静态索引** `gallery-index.json`（不在 /api/ 下）与公开 CDN 图片。
 *
 * 数据来源（一次 1.2MB，缓存到本地、默认 24 小时有效）：
 *   { gallery: { <分类>: { images: [{ alt, name, story:{zh,en}, preview, original, ... }] } } }
 *   - `alt` / `name`：这张图的台词（就是图上写的字）
 *   - `story.zh`：这张图**什么梗、适合什么场合用** —— 挑图最需要的字段
 *   - `preview`：512×512 webp（气泡尺寸够用，40KB，比原图省）
 *
 * 格式问题：站上只有 webp，而客户端把配图 URL 硬编码成 `<名>.png`。
 * 这里**不转格式**（Node 没有图像库，转就要拉 Python），改成：文件如实存 `.webp`，
 * 由副本的图片路由把 `<名>.png` 回落到 `<名>.webp`。少一层转换、也少一个依赖。
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { queryTerms } from './mechanics.js';

const INDEX_URL = 'https://aigengtu.com/gallery-index.json';
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** 索引缓存：读本地（未过期就直接用），否则下载一份。网络失败但有旧缓存时用旧的。 */
export async function loadGalleryIndex(options) {
  const { file, maxAgeMs = DEFAULT_MAX_AGE_MS, log = () => {} } = options;
  let cached = null;
  try {
    if (existsSync(file)) {
      const age = Date.now() - statSync(file).mtimeMs;
      cached = JSON.parse(readFileSync(file, 'utf8'));
      if (age < maxAgeMs) return { index: cached, from: 'cache' };
    }
  } catch (error) {
    log('表情包索引缓存读不动，将重新下载：' + (error?.message ?? error));
  }
  try {
    const response = await fetch(INDEX_URL, {
      headers: { 'user-agent': 'dsh-game-pet-watch/1.0 (personal desktop pet)' },
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const index = await response.json();
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, JSON.stringify(index), 'utf8');
    return { index, from: 'network' };
  } catch (error) {
    if (cached) {
      log('表情包索引下载失败，用旧缓存：' + (error?.message ?? error));
      return { index: cached, from: 'stale-cache' };
    }
    throw error;
  }
}

/** 把索引拍平成条目数组（带分类），便于检索 */
export function flattenGallery(index) {
  const out = [];
  const gallery = index?.gallery ?? {};
  for (const [category, section] of Object.entries(gallery)) {
    for (const item of section?.images ?? []) {
      if (!item?.preview) continue;
      out.push({ ...item, category: item.category || category });
    }
  }
  return out;
}

/**
 * 图库条目 → 给模型看的描述。
 *
 * 图库里**本来就有**两段可用文本：`alt`（图上的台词）与 `story.zh`（这个梗的来历 + **什么场合适合用**）。
 * 早先只存了 `alt`，等于把最有挑选价值的那段丢了 —— 模型只能看到"图上有句话"，
 * 却不知道什么时候该发它。现在拼成"台词（适合：…）"，并把场合那段截短以控制提示词体积。
 */
export function describeFromGallery(item) {
  const alt = String(item?.alt ?? item?.name ?? '').trim();
  const story = String(item?.story?.zh ?? '').replace(/\s+/g, ' ').trim();
  if (!alt) return story.slice(0, 100);
  if (!story) return alt;
  const use = story.length > 70 ? story.slice(0, 70) + '…' : story;
  return `${alt}（适合：${use}）`;
}

/** 条目 → 本地文件名（用站点编号，稳定且唯一；已有同名文件就直接复用，不重复下载） */
export function memeNameOf(item) {
  const match = /\/meme\/(\d+)\.[a-z0-9]+$/i.exec(String(item?.original || item?.preview || ''));
  return match ? `梗鲸${match[1]}` : '';
}

/** 检索：台词 + 场合说明 + 分类一起打分（story.zh 是"什么场合用"，权重最高） */
export function searchGallery(entries, query, options = {}) {
  const terms = queryTerms(query);
  const limit = Math.max(1, Number(options.limit ?? 3));
  const scored = [];
  for (const item of entries) {
    const story = String(item?.story?.zh ?? '');
    const alt = String(item?.alt ?? item?.name ?? '');
    const category = String(item?.category ?? '');
    let score = 0;
    for (const term of terms) {
      if (story.includes(term)) score += 4;
      if (alt.includes(term)) score += 6;
      if (category.includes(term)) score += 2;
    }
    if (score > 0) scored.push({ item, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

/**
 * 下载一张（存 `.webp`，见文件头说明）。
 * 已存在就跳过——同一个编号被抓过一次就不再下载（幂等，也让"重复问同一件事"不再打网络）。
 */
export async function downloadMeme(item, dir, log = () => {}) {
  const name = memeNameOf(item);
  if (!name) return { ok: false, error: '这张图没有可用的编号，跳过' };
  mkdirSync(dir, { recursive: true });
  const target = join(dir, name + '.webp');
  if (existsSync(target)) return { ok: true, name, file: target, cached: true };
  const url = item.preview || item.original;
  const response = await fetch(url, {
    headers: { 'user-agent': 'dsh-game-pet-watch/1.0 (personal desktop pet)' },
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) return { ok: false, name, error: 'HTTP ' + response.status };
  const bytes = Buffer.from(await response.arrayBuffer());
  writeFileSync(target, bytes);
  log(`已下载表情包 ${name}.webp（${Math.round(bytes.length / 1024)}KB）：${String(item.alt ?? '').slice(0, 30)}`);
  return { ok: true, name, file: target, bytes: bytes.length };
}

/**
 * 检索 + 下载一步到位，返回给模型看的结果文本。
 * 只下载**第一名**（其余只报名字）——一次工具调用最多写一个文件，避免模型一次拉一堆。
 */
export async function findAndFetchMeme(query, context) {
  const { entries, dir, descriptions, log = () => {} } = context;
  const hits = searchGallery(entries, query, { limit: 3 });
  if (!hits.length) {
    return { ok: false, text: `表情包库里没搜到和「${query}」相关的图。可以换个说法再搜一次（比如把情绪换成具体场景）。` };
  }
  const best = hits[0].item;
  const result = await downloadMeme(best, dir, log);
  if (!result.ok) return { ok: false, text: `搜到了图但取不下来（${result.error}）——不要编造名字，换个说法再试。` };
  /**
   * 台词写进描述表**并落盘**：本地目录同步时就有了离线描述，不必再跑视觉模型。
   * 踩过的坑：早先只改了内存里的对象、没写回文件 —— 于是按需下载的图在**下一次**同步时
   * 没有描述，落到视觉通道；而那个通道一失败，整批同步就作废（表情包目录一直是 0 张）。
   */
  if (descriptions && result.name && !descriptions[result.name]) {
    descriptions[result.name] = describeFromGallery(best);
    try {
      writeFileSync(join(dir, 'descriptions.json'), JSON.stringify(descriptions, null, 1), 'utf8');
    } catch (error) {
      log('台词表写回失败（不影响这次配图）：' + (error?.message ?? error));
    }
  }
  const others = hits.slice(1).map((h) => `${String(h.item.alt ?? '').slice(0, 24)}`).join(' / ');
  return {
    ok: true,
    name: result.name,
    cached: Boolean(result.cached),
    text:
      `已取到表情包「${result.name}」：${String(best.alt ?? '')}` +
      (best.story?.zh ? `（用法：${String(best.story.zh).slice(0, 120)}）` : '') +
      `。把 img 字段填 "${result.name}" 就会发给主人。` +
      (others ? `\n其它候选：${others}` : ''),
  };
}

/** 给模型看的工具定义 */
export const MEME_TOOL = {
  name: 'goh_meme',
  description:
    '从梗鲸表情包库（2000+ 张 DeepSeek/AI 拟人梗图）里按关键词搜一张合适的表情包，下载到本地并返回它的名字。' +
    '当你想配一张图但常驻清单里没有合适的，就用它搜（关键词写场景或情绪，如"加班"、"没电了"、"被夸奖"）。' +
    '拿到名字后，把名字填进最终回复的 img 字段。一次只取一张。',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '想找什么样的表情包：场景、情绪或台词关键词' },
    },
    required: ['query'],
    additionalProperties: false,
  },
};
