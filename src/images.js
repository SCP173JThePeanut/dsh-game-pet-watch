/**
 * 表情包目录：**离线描述 + 模型自己挑**，和动画目录同一套思路。
 *
 * 为什么不在生成时让模型直接出图/出内容：表情包就是磁盘上的 PNG，模型只需要知道
 * "有哪些图、每张什么内容"，然后按语境挑一张。所以流程是：
 *   ① 扫目录拿到图名清单（用户目录优先，回落原版包内目录）；
 *   ② 每张图的**文字描述**离线准备好 —— 优先用现成的：
 *        - 原版包内 config.jsonc 的 memes 表（27 张自带描述）
 *        - 抓取来的 descriptions.json（站点台词）
 *      两者都没有的图，才回落到视觉模型描述（与动画目录同一条 describe 通道）；
 *   ③ 描述进提示词（紧凑一行一张），模型在输出里写 `img` 字段点名；
 *   ④ 只认**目录里真实存在**的名字（防幻觉出图外的名字 → 气泡图裂）。
 *
 * 名字 = 文件名去掉 .png。客户端把 URL 硬编码成 `<名>.png`，所以只收 .png。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** 表情包目录链：用户目录优先，回落原版包内目录（与副本服务器的查找顺序必须一致） */
export function memesDirs(userRoot, upstreamRoot) {
  return [join(userRoot, 'memes'), join(upstreamRoot, 'assets', 'memes')];
}

/** 扫目录：返回 [{name, file, mtime, dir}]（同名以**先出现的目录**为准，即用户目录覆盖包内） */
export function scanMemes(dirs) {
  const out = [];
  const seen = new Set();
  for (const dir of dirs) {
    let names = [];
    try {
      names = readdirSync(dir);
    } catch {
      continue; // 目录不存在很正常（用户还没放图）
    }
    for (const file of names) {
      // 收 .png 与 .webp：站上抓来的图只有 webp，而客户端请求的是 <名>.png，
      // 由副本的图片路由把两者对上（见 gpw-server.cjs 的表情包分支）
      if (!/\.(png|webp)$/i.test(file)) continue;
      const name = file.replace(/\.(png|webp)$/i, '');
      if (!name || seen.has(name)) continue;
      try {
        const info = statSync(join(dir, file));
        seen.add(name);
        out.push({ name, file: join(dir, file), mtime: info.mtimeMs, dir });
      } catch {
        /* 读不到的跳过 */
      }
    }
  }
  return out;
}

/**
 * 去 JSONC 注释（行内 `//`、行尾 `//`、`/* *\/` 块），然后吃掉尾逗号。
 *
 * 必须是**尊重字符串的扫描器**，不能用正则：原版 config.jsonc 里有大量
 * `"键": "值",   // 说明` 这种行尾注释，而正则版会漏掉它们（也可能会误删字符串里的 `//`）。
 * 踩过一次：正则版只删「行首注释」，于是整个配置解析失败、27 张表情包的描述全丢。
 */
export function parseJsonc(text) {
  const src = String(text);
  let out = '';
  let inString = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    const next = src[i + 1];
    if (inLine) {
      if (ch === '\n') {
        inLine = false;
        out += ch;
      }
      continue;
    }
    if (inBlock) {
      if (ch === '*' && next === '/') {
        inBlock = false;
        i += 1;
      }
      continue;
    }
    if (inString) {
      out += ch;
      if (ch === '\\') {
        out += next ?? '';
        i += 1;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === '/' && next === '/') {
      inLine = true;
      i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlock = true;
      i += 1;
      continue;
    }
    out += ch;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

/** 原版包内 config.jsonc 的 memes 表：{ 图名: 描述 }（读不到就是空表） */
export function readPackageMemes(upstreamRoot) {
  for (const file of ['config.jsonc', 'config.json']) {
    const path = join(upstreamRoot, 'assets', file);
    if (!existsSync(path)) continue;
    try {
      const memes = parseJsonc(readFileSync(path, 'utf8'))?.memes;
      if (memes && typeof memes === 'object' && !Array.isArray(memes)) {
        return Object.fromEntries(
          Object.entries(memes).filter(([k, v]) => k && typeof v === 'string' && v.trim()),
        );
      }
    } catch {
      /* 配置坏掉不该拖死插件：当作没有描述 */
    }
  }
  return {};
}

/** 抓取脚本写的台词表：{ 图名: 描述 } */
export function readScrapedDescriptions(userRoot) {
  const path = join(userRoot, 'memes', 'descriptions.json');
  if (!existsSync(path)) return {};
  try {
    const data = JSON.parse(readFileSync(path, 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

/**
 * 把磁盘上的表情包同步进目录（**只补缺的**，已有条目不覆盖——人工改过的更不该动）。
 *
 * @param {{store:import('./catalog.js').CatalogStore, dirs:string[], descriptions:Record<string,string>,
 *          describe?:(input:{name:string,file:string})=>Promise<void>, log?:(m:string)=>void}} options
 */
export async function syncImageCatalog(options) {
  const { store, dirs, descriptions } = options;
  /**
   * **每次同步最多补几张视觉描述**（默认 3 ✓）。
   *
   * 事故：图库改成数字 id 之后，同步器把大批图当成"没有描述的新图" ✗，
   * 一次同步打了 87 / 97 次视觉调用 ✗✗（真花钱 ✓）。
   * 有了上限，最坏情况也只是"这次少补几张、下次再补" ✓ —— 不会再一夜烧掉一大笔 ✓。
   */
  const maxDescribe = Number.isFinite(Number(options.maxDescribe)) ? Number(options.maxDescribe) : 3;
  let describeBudget = maxDescribe;
  const log = options.log ?? (() => {});
  await store.load();
  const found = scanMemes(dirs);
  let added = 0;
  let described = 0;
  let failed = 0;
  let enriched = 0;
  let purged = 0;
  let skippedDescribe = 0;

  /**
   * 先清僵尸条目：目录里已经没有的图必须从清单里删掉。
   * 否则模型会挑到它、客户端请求 404、气泡图裂 —— 而且用户删过图之后清单会越积越脏。
   */
  const present = new Set(found.map((image) => image.name));
  for (const name of Object.keys(store.data.items)) {
    if (present.has(name)) continue;
    delete store.data.items[name];
    purged += 1;
  }
  if (purged) log(`表情包目录清掉 ${purged} 条已删除的图`);

  for (const image of found) {
    const existing = store.item(image.name);
    if (existing) {
      /**
       * 已存在的条目：**更好的离线描述可以覆盖**，人工改过的绝不覆盖。
       *
       * "更好" = 有离线描述、内容不同、且**更长**。这条规则同时覆盖两种情况：
       *   ① 早先是视觉描述（只知道画面长什么样）→ 换成站方的"台词 + 适合场合"；
       *   ② 离线描述本身被补充得更详细了（例如用 story.zh 升级过）→ 也要生效，
       *      否则磁盘上升级了、目录里还是旧的（我就踩了这个：28 条升级进不了目录）。
       * 只允许变长，避免两个来源反复互相覆盖导致每轮同步都在写盘。
       */
      const known = descriptions[image.name];
      const offlineText = typeof known === 'string' ? known.trim() : '';
      const currentText = String(existing.text ?? '').trim();
      const better =
        !existing.edited && offlineText && offlineText !== currentText && offlineText.length > currentText.length;
      if (better) {
        existing.text = offlineText;
        existing.source = 'offline';
        existing.at = Date.now();
        enriched += 1;
        continue;
      }
      /**
       * **条目存在但没描述 → 补一次** ✗→✓。
       *
       * 踩过的坑（主人问"图片是不是都读进来了"，对账发现一张 `qq-玉米龟龟` 永远没描述 ✗）：
       * 已存在的条目原来直接 `continue` ✗ → 描述为空的那种（视觉描述那次失败过 ✓）
       * **再也不会被补** ✗。所以这里对"空描述"网开一面 ✓（人工改过的仍然不动 ✓）。
       */
      if (!existing.edited && !currentText && options.describe) {
        try {
          await options.describe({ name: image.name, file: image.file });
          described += 1;
        } catch (error) {
          failed += 1;
          log(`表情包「${image.name}」补描述失败：${error?.message ?? error}`);
        }
      }
      continue;
    }

    const known = descriptions[image.name];
    if (typeof known === 'string' && known.trim()) {
      // 有现成描述：直接写进目录，零成本（这正是"离线描述"的意思）
      store.data.items[image.name] = {
        at: Date.now(),
        mtime: image.mtime,
        file: image.file,
        text: known.trim(),
        source: 'offline',
      };
      added += 1;
    } else if (options.describe && describeBudget > 0) {
      /**
       * 没描述才动用视觉模型（与动画目录同一条通道）。
       * **逐张容错**：某张描述失败（没模型、网络抖、图损坏）只跳过这一张 ——
       * 早先异常会冒出去让整次同步作废，连有离线描述的那几十张也进不来
       * （实测就是这么坏的：表情包目录一直 0 张）。
       */
      try {
        await options.describe({ name: image.name, file: image.file });
        describeBudget -= 1;
        described += 1;
      } catch (error) {
        failed += 1;
        log(`表情包「${image.name}」没有描述且描述失败，本次跳过：${error?.message ?? error}`);
      }
    } else if (options.describe && describeBudget <= 0) {
      skippedDescribe += 1;
    }
  }
  if (skippedDescribe) {
    log(`表情包目录：这次先补 ${described} 张描述，还有 ${skippedDescribe} 张没描述的下次再来（每次上限 ${maxDescribe} ✓ 防一次性烧太多）`);
  }
  if (added || described || enriched || purged) {
    store.data.builtAt = Date.now();
    await store.persist();
    log(
      `表情包目录已同步：新增 ${added} 张（离线描述）、视觉描述 ${described} 张` +
        (enriched ? `、用离线描述替换视觉描述 ${enriched} 张` : '') +
        (purged ? `、清掉僵尸条目 ${purged} 条` : ''),
    );
  }
  return { total: found.length, added, described, failed, enriched, purged, skippedDescribe };
}

/**
 * 给提示词用的一行一张清单（只带名字与描述，模型据此挑图）。
 *
 * 三个改动：
 *   ① **标明来源**：QQ 群/私聊收进来的图文件名带 `qq-` 前缀 → 标成「群里人发过的」✓
 *      并**排在清单最前面** ✓（模型对前几项更敏感 → 更容易"用群里的图接群里的话" ✓）
 *   ② **门槛写死**：只有**非常契合**才配；勉强凑一张就不配 ✓
 *   ③ **显式框起来 + 声明"这不是你的性格"** ✗→✓（主人对比基线后的结论 ✓）：
 *      表情包描述写得很有人味（「跑路也不喊一声喵」✓「本鱼怎么还记得喵」✓），
 *      而模型**分不清"素材说明"和"我的人设"** ✗ → 直接照着模仿那种语气 ✓，
 *      于是"带不带这份清单，表现完全不一样" ✓。
 *      所以：用 `<meme_library>` 标签框住 ✓ + 明确写"不是你的性格/风格/记忆、不要模仿语气" ✓
 *      + **把描述截短到 28 字** ✓（细节留在目录里，提示词里只留"够挑图"的信息 ✓）。
 */
export function imagePromptBlock(store, limit = 0) {
  const items = store?.data?.items ?? {};
  const entries = Object.entries(items).map(([name, item]) => ({
    name,
    text: String(item?.text ?? '').trim(),
    fromQq: /(^|[\\/])qq-/.test(String(item?.file ?? item?.sheet ?? '')),
  }));
  const ordered = [...entries.filter((e) => e.fromQq), ...entries.filter((e) => !e.fromQq)];
  const picked = limit > 0 ? ordered.slice(0, limit) : ordered;
  const lines = picked
    .filter((e) => e.text)
    .map((e) => {
      // 描述截短到 28 字：够挑图就行 ✓，越短越不容易把它的语气带进人设 ✓
      const short = e.text.length > 28 ? `${e.text.slice(0, 28)}…` : e.text;
      return `- ${e.name}${e.fromQq ? '（群里人发过的）' : ''}：${short}`;
    });
  if (!lines.length) return '';
  return [
    '<meme_library>',
    '下面是**图片素材库的目录** —— 一个"可以拿来配图的图"的清单。',
    '',
    '⚠️ 重要：这里的每一行**只是图片内容的说明**，属于**素材数据**：',
    '   它**不是**你的性格、**不是**你的说话风格、**不是**你的记忆、也**不是**主人对你说的话。',
    '   **不要模仿这些说明的语气和口癖**；没有配图的时候也不要提起它们。',
    '   你的性格和说话方式，只由上面的人设与规则决定。',
    '',
    '用法：只有某张图跟当前这句话**非常契合**时才配一张（比如刚好接住一个梗）；',
    '**宁可不配** —— 勉强凑一张比不配更糟。优先用标了「群里人发过的」那些；同一张不要连着用。',
    '配图时在输出里写 img 字段填它的名字（必须原样照抄）：',
    ...lines,
    '</meme_library>',
  ].join('\n');
}
