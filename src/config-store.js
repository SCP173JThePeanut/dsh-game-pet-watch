/**
 * 配置落盘：把界面里改的提示词/节奏写回 **profile 的 patch 层**
 * （`<DSH_PROFILE_DIR>/cordis.patch.yml` 里 `id: game-pet-watch` 那一行的 config 段）。
 *
 * 为什么写文件而不是调用 loader API：那一层是官方约定的「用户补丁层」，升级存活；
 * 写回后需要重开 DSH 才生效（本插件会在运行时状态里明说这一点，不假装已经生效）。
 *
 * 安全策略：只改目标行的 config 段，其它行、行外注释、文件头都原样保留（按文本操作，
 * 不用 YAML round-trip 以免吃掉别人的注释与顺序）。写前先备份 `.bak-<时间戳>`。
 */
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const ROW_ID = 'game-pet-watch';
/** 探测到的 patch 文件缓存：界面每一次读状态都问一遍，别每次都扫盘 */
let cachedPatchFile;

/** 允许从界面写回的键（其余键只能手改文件，避免 UI 把不该碰的东西写坏） */
export const EDITABLE_KEYS = [
  'enabled',
  'windowTitle',
  'intervalSec',
  'pluginPort',
  // 内容路径：用户自己填（事件文件 / 采集器 / 机制库），空 = 不启用
  'gohFile',
  'gohCollectorScript',
  'mechanicsQuickFile',
  'mechanicsFile',
  // 安装路径（换机器/换安装位置时用；空 = 自动推）
  'gpwRoot',
  'upstreamPetRoot',
  'upstreamRoot',
  'maxWidth',
  'provider',
  'model',
  'personality',
  'rules',
  'cooldownSec',
  'gohImmediateCooldownSec',
  'gohReactionBudget',
  'gohReactionWindowSec',
  'maxChars',
  'keepShots',
  'pushToPet',
  'petId',
  'memoryRecentTurns',
  'historyHideSystem',
  'memoryAllowSelfNote',
  'compactEvery',
  'memoryLongTermChars',
  'compactSystem',
  'gameSource',
  'databaseSource',
  /** 思考档位 + 接话上限（2026-10-21）：加了 CONFIG_KEYS 还必须加这里，否则保存会被过滤掉 */
  'modelThinking',
  'chainMax',
  'askCapture',
];

function scalar(value) {
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  if (value === null || value === undefined) return "''";
  const text = String(value);
  if (text === '') return "''";
  // 单引号包裹（YAML 单引号里 '' 表示一个单引号），多行文本也能安全承载
  return "'" + text.replace(/'/g, "''") + "'";
}

/**
 * 把一个键值渲染成 YAML 文本（可能多行）。
 *
 * 单行文本用单引号；**多行文本用块标量 `|-`**。为什么不用单引号跨行：
 * YAML 的单引号跨行标量会把换行**折叠成空格** —— 实测现有的 rules 存进去再读出来，
 * 换行全变成空格了（提示词本来分行写的断句就没了）。块标量按原样保留换行，
 * 而且内容行统一缩进，结构上也不像跨行引号那样容易被写坏。
 */
function renderKeyValue(key, value, keyIndent) {
  if (typeof value === 'boolean' || typeof value === 'number') return `${keyIndent}${key}: ${value}`;
  if (value === null || value === undefined) return `${keyIndent}${key}: ''`;
  const text = String(value);
  if (text === '') return `${keyIndent}${key}: ''`;
  if (!text.includes('\n')) return `${keyIndent}${key}: '${text.replace(/'/g, "''")}'`;
  const bodyIndent = `${keyIndent}  `;
  const body = text.split('\n').map((line) => (line === '' ? '' : bodyIndent + line));
  // `|-` = 字面块 + 去尾换行（与用户输入一致，不额外加空行）
  return `${keyIndent}${key}: |-\n${body.join('\n')}`;
}

/**
 * 求某个键的标量在文本里**占了几行**（返回闭合行的下标）。
 *
 * 要同时认两种形态：
 *   - 单引号跨行标量（DSH 自己写出来的形式）：吃到闭合引号那一行；
 *   - **块标量 `|` / `>`（本插件写出的形式）：吃到第一个"非空且不比键更深缩进"的行为止**。
 * 为什么必须知道长度：替换时只改第一行的话，旧值的续行会残留成裸文本，YAML 就坏了 ——
 * 而 patch 坏掉会让 **DSH 整个起不来**（不是只坏插件）。这个坑真踩过。
 */
function scalarClosingLine(lines, start) {
  const first = lines[start];
  const colon = first.indexOf(':');
  if (colon === -1) return start;
  const keyIndent = (/^\s*/.exec(first)?.[0].length ?? 0);
  const rest = first.slice(colon + 1).trim();

  // 情形一：块标量（本插件写出的多行形式）—— 吃到第一个"非空且不比键更深"的行为止
  if (/^[|>][-+]?\d*$/.test(rest)) {
    let last = start;
    for (let i = start + 1; i < lines.length; i += 1) {
      const line = lines[i];
      if (line.trim() === '') continue; // 块里的空行仍属于块
      const indent = /^\s*/.exec(line)?.[0].length ?? 0;
      if (indent <= keyIndent) break;
      last = i;
    }
    return last;
  }

  // 情形二：单引号跨行标量（DSH 写出的形式）
  if (!rest.startsWith("'")) return start;
  const countQuotes = (s) => (s.match(/'/g) ?? []).length;
  let quotes = countQuotes(rest);
  if (quotes % 2 === 0) return start;
  for (let i = start + 1; i < lines.length; i += 1) {
    quotes += countQuotes(lines[i]);
    if (quotes % 2 === 0) return i;
  }
  return start; // 没找到闭合（文件本来就坏）：保守当单行，交给写盘前的解析校验兜底
}

/** 找到 patch 文件路径 */
export function patchFilePath(profileDir) {
  return join(profileDir, 'cordis.patch.yml');
}

/**
 * 用文本操作把 config 段里的键值改掉。
 * @param {string} text 原文件全文
 * @param {Record<string, unknown>} values 要写的键值
 * @returns {{text:string, changed:string[], created:boolean, error?:string}}
 */
export function applyConfigToPatchText(text, values) {
  const lines = text.split(/\r?\n/);
  /** 找到 `- id: game-pet-watch` 起始的条目块 */
  let rowStart = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (new RegExp(`^\\s*-\\s*id:\\s*${ROW_ID}\\s*$`).test(lines[i])) {
      rowStart = i;
      break;
    }
  }
  if (rowStart === -1) {
    // 还没有本插件的行：补一条 **id 定向的 config 覆盖行**（不写 name —— 插件本体由 bundle 提供，
    // 这一层只负责把配置叠上去；写 name 会变成"再插一行"，等于把插件装两遍）。
    const trailing = text.endsWith('\n') ? '' : '\n';
    const block = [
      `- id: ${ROW_ID}`,
      '  config:',
      ...Object.keys(values).map((key) => renderKeyValue(key, values[key], '    ')),
    ];
    return {
      text: `${text}${trailing}${block.join('\n')}\n`,
      changed: Object.keys(values),
      created: true,
    };
  }
  // 条目块范围：到下一个顶层 `- ` 或文件结尾
  let rowEnd = lines.length;
  for (let i = rowStart + 1; i < lines.length; i += 1) {
    if (/^-\s/.test(lines[i])) {
      rowEnd = i;
      break;
    }
  }
  // 定位 config:（条目内的那一层）
  let configLine = -1;
  let configIndent = '';
  for (let i = rowStart + 1; i < rowEnd; i += 1) {
    const match = /^(\s*)config:\s*$/.exec(lines[i]);
    if (match) {
      configLine = i;
      configIndent = match[1];
      break;
    }
  }
  const changed = [];
  if (configLine === -1) {
    // 没有 config 段：在条目块末尾插入一个
    const indent = (/^(\s*)/.exec(lines[rowStart])?.[1] ?? '') + '    ';
    const block = ['config:', ...Object.keys(values).map((key) => renderKeyValue(key, values[key], `${indent}  `))]
      .map((line, index) => (index === 0 ? indent + line : line));
    lines.splice(rowEnd, 0, ...block);
    for (const key of Object.keys(values)) changed.push(key);
    return { text: lines.join('\n'), changed, created: true };
  }
  // config 段范围：到"下一个条目"或"缩进回到 config 同级/更浅"为止。
  //
  // ⚠️ 历史上这里用"逐行判断缩进 + 靠 scalarClosingLine 跳续行"来算 config 段终点，
  // 但真实 patch 里**多行续行的缩进形态不止一种** ✗ → 段终点会被算早 →
  // 后面的键（如 compactSystem）扫不到 → 被当成新键**再插一遍** ✗✗ →
  // patch 里出现重复键 → YAML 解析失败（实测：`duplicated mapping key` ✓）。
  //
  // 现在改成**不依赖段终点**：子键行的缩进是**固定**的 `childIndent` ✓，
  // 而多行标量的续行一定**更深** ✓ → 用这一条规则扫整个条目就够了 ✓（简单且不会再错 ✓）。
  let configEnd = rowEnd;
  const childIndent = configIndent + '  ';
  {
    const re = new RegExp(`^${childIndent}([A-Za-z0-9_]+):`);
    for (let i = configLine + 1; i < rowEnd; i += 1) {
      if (re.test(lines[i])) {
        configEnd = i;
        break;
      }
    }
    if (configEnd === rowEnd) configEnd = rowEnd;
  }

  /** config 段内所有"子键"的位置（跳过多行续行，避免误判） */
  const childKeys = [];
  for (let i = configLine + 1; i < rowEnd; i += 1) {
    const match = new RegExp(`^${childIndent}([A-Za-z0-9_]+):`).exec(lines[i]);
    if (!match) continue;
    childKeys.push({ key: match[1], start: i, end: scalarClosingLine(lines, i) });
    i = childKeys[childKeys.length - 1].end;
  }

  for (const [key, value] of Object.entries(values)) {
    /**
     * ⚠️ 必须**按行拆开**再插入 ✗→✓。
     *
     * 踩过的坑（实测：patch 里出现重复的 `compactSystem` → YAML 解析失败 → DSH 起不来）：
     * `renderKeyValue` 对多行值返回的是**一个含换行的字符串** ✓，而这里用
     * `lines.splice(i, n, line)` 把它当**一个数组元素**塞进去 ✗ → 之后扫描子键时，
     * 那个元素里"看不见"后面的键 ✗ → 下一个键被当成不存在 → **又插一遍** ✓✓。
     * 拆成多行后，行号与扫描都自洽 ✓。
     */
    const newLines = renderKeyValue(key, value, childIndent).split('\n');
    const existing = childKeys.find((c) => c.key === key);
    if (!existing) {
      lines.splice(configEnd, 0, ...newLines);
      configEnd += newLines.length;
      // 之后的键位置整体下移（保持扫描缓存自洽）
      for (const c of childKeys) {
        if (c.start >= configEnd - newLines.length) {
          c.start += newLines.length;
          c.end += newLines.length;
        }
      }
    } else {
      // 先删掉旧标量的整段（含续行），再写新值 —— 否则多行旧值的尾巴会残留成裸文本
      const removeCount = existing.end - existing.start;
      lines.splice(existing.start, removeCount + 1, ...newLines);
      const delta = newLines.length - (removeCount + 1);
      configEnd += delta;
      for (const c of childKeys) {
        if (c.start > existing.start) {
          c.start += delta;
          c.end += delta;
        }
      }
      existing.end = existing.start + newLines.length - 1;
    }
    changed.push(key);
  }
  return { text: lines.join('\n'), changed, created: false };
}

/**
 * 定位当前 profile 的 patch 文件。
 *
 * 顺序：
 *   1. `DSH_PROFILE_DIR`（profile 形态启动的宿主一定有；
 *      桌面应用里这个变量可能没有，于是走 2）
 *   2. 在 `$DSH_HOME/profiles/<name>/cordis.patch.yml` 里找**含本插件那一行**的那份 ——
 *      这比"猜哪个 profile 在跑"可靠：没装本插件的 profile 里根本不会有这一行。
 *
 * 找不到就返回 undefined（界面会明说写入位置未知），绝不瞎猜一个路径去写。
 */
export function resolvePatchFile() {
  const dir = process.env.DSH_PROFILE_DIR;
  if (dir && dir.trim()) {
    const file = patchFilePath(dir.trim());
    cachedPatchFile = file;
    return file;
  }
  return cachedPatchFile;
}

export async function findPatchFile(dshHome) {
  const fromEnv = resolvePatchFile();
  if (fromEnv) return fromEnv;
  const profilesDir = join(dshHome, 'profiles');
  let names;
  try {
    names = await readdir(profilesDir);
  } catch {
    return undefined;
  }
  for (const name of names) {
    const file = join(profilesDir, name, 'cordis.patch.yml');
    try {
      const text = await readFile(file, 'utf8');
      if (new RegExp(`^\\s*-\\s*id:\\s*${ROW_ID}\\s*$`, 'm').test(text)) {
        cachedPatchFile = file;
        return file;
      }
    } catch {
      /* 这个 profile 没有 patch 文件，继续找 */
    }
  }
  return undefined;
}

/**
 * 写盘前校验：结果必须是**能被真正解析的 YAML**。
 *
 * 这是本插件最重要的一道闸门。原因：patch 文件解析失败会让 **DSH 整个起不来**
 * （`DesktopHostFatalError: failed to parse overlay ...`），用户看到的是"应用无法启动"。
 * 我们踩过一次：多行提示词替换时旧值续行残留 → YAML 坏 → DSH 崩。
 * 所以这里宁可**不写**，也不能写出坏文件。
 *
 * 解析器优先从 profile 的 node_modules 借（DSH 自带 js-yaml / yaml）；
 * 借不到就退化成结构不变量检查（条目数不变 + 行数没暴涨）。
 */
async function validatePatchText(next, before, profileDir) {
  try {
    const { createRequire } = await import('node:module');
    const { pathToFileURL } = await import('node:url');
    const req = createRequire(join(profileDir, 'noop.js'));
    let yaml;
    try {
      yaml = req('js-yaml');
    } catch {
      try {
        yaml = await import(pathToFileURL(join(profileDir, 'node_modules', 'yaml', 'dist', 'index.js')).href);
      } catch {
        yaml = undefined;
      }
    }
    if (yaml) {
      const load = typeof yaml.load === 'function' ? yaml.load : yaml.default?.parse;
      if (typeof load === 'function') {
        const doc = load(next);
        if (!Array.isArray(doc)) return { ok: false, message: '结果不是 YAML 数组' };
        return { ok: true, rows: doc.length };
      }
    }
  } catch (error) {
    return { ok: false, message: 'YAML 校验未通过：' + (error?.message ?? String(error)).split('\n')[0] };
  }
  // 没有解析器：退化成结构不变量检查
  const countRows = (text) => (text.match(/^\s*-\s*id:\s*\S+\s*$/gm) ?? []).length;
  const rowsBefore = countRows(before);
  const rowsAfter = countRows(next);
  if (rowsAfter < rowsBefore) return { ok: false, message: `条目数变少（${rowsBefore} → ${rowsAfter}）` };
  const linesBefore = before.split('\n').length;
  const linesAfter = next.split('\n').length;
  if (linesAfter > linesBefore * 2 + 10) {
    return { ok: false, message: `行数异常增长（${linesBefore} → ${linesAfter}），疑似重复写入` };
  }
  return { ok: true, rows: rowsAfter, degraded: true };
}

/**
 * 读 → 改 → 备份 → 写。
 * @param {Record<string, unknown>} values 只取 EDITABLE_KEYS 里的键
 * @param {string} [dshHome] 用于 2 号探测路径
 */
export async function writeConfigToProfile(values, dshHome) {
  const file = dshHome ? await findPatchFile(dshHome) : resolvePatchFile();
  if (!file) {
    return {
      ok: false,
      message: '定位不到 profile 的 patch 文件：既没有 DSH_PROFILE_DIR，也没在 $DSH_HOME/profiles/*/cordis.patch.yml 里找到本插件那一行',
    };
  }

  const picked = {};
  for (const key of EDITABLE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(values ?? {}, key)) picked[key] = values[key];
  }
  if (Object.keys(picked).length === 0) return { ok: false, message: '没有可写入的字段' };

  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    return { ok: false, message: `读不到 patch 文件：${file}（${error?.message ?? error}）` };
  }

  const result = applyConfigToPatchText(text, picked);
  if (result.error) return { ok: false, message: result.error };
  if (result.text === text) return { ok: true, file, changed: [], note: '内容没有变化' };

  // 写盘前必须过解析校验：宁可写不进去，也不能写出让 DSH 起不来的 patch
  const check = await validatePatchText(result.text, text, dirname(file));
  if (!check.ok) {
    return {
      ok: false,
      file,
      message: `写入被拒绝（原文件未改动）：${check.message}`,
    };
  }

  const backup = `${file}.bak-${Date.now()}`;
  try {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(backup, text, 'utf8');
    await writeFile(file, result.text, 'utf8');
  } catch (error) {
    return { ok: false, message: `写入失败：${error?.message ?? error}` };
  }
  return { ok: true, file, backup, changed: result.changed, validated: check.degraded ? 'structural' : 'yaml' };
}
/**
 * 从 patch 文本里取出 `- id: <rowId>` 那条的 config 段（**只读，容错**）。
 *
 * 只支持本插件自己写出来的形状：标量 / 布尔 / 数字 / 引号字符串 / `[]` 内联数组 /
 * `|- | |+ >-` 块字符串。解析不出来就返回空对象 —— 宁可少一层，不让插件起不来。
 *
 * @param {string} text  cordis.patch.yml 的内容
 * @param {string} [rowId='game-pet-watch']
 * @returns {Record<string, unknown>}
 */
export function parsePatchConfig(text, rowId = ROW_ID) {
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n');
  /** 顶层行：缩进为 0 且以 `- ` 开头（YAML 数组的一项） */
  const isTopLevel = (line) => /^- /.test(line);

  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^-\s+id:\s*(\S+)\s*$/.exec(lines[i]);
    if (m && m[1].replace(/^['"]|['"]$/g, '') === rowId) {
      start = i;
      break;
    }
  }
  if (start < 0) return {};

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (isTopLevel(lines[i])) {
      end = i;
      break;
    }
  }
  const block = lines.slice(start + 1, end);

  /** config: 必须在 2 空格缩进处 */
  const cfgAt = block.findIndex((l) => /^ {2}config:\s*$/.test(l));
  if (cfgAt < 0) return {};

  const out = {};
  for (let i = cfgAt + 1; i < block.length; i += 1) {
    const line = block[i];
    if (!line.trim()) continue;
    if (/^ {0,3}\S/.test(line)) break; // 回到 config 之外
    const kv = /^ {4}([A-Za-z0-9_]+):(?:\s*(.*))?$/.exec(line);
    if (!kv) continue;
    const key = kv[1];
    const rest = (kv[2] ?? '').trim();

    /** 块字符串：把缩进 >= 6 的后续行都收进来 */
    if (/^\|[+-]?$|^>[+-]?$/.test(rest)) {
      const buf = [];
      let j = i + 1;
      for (; j < block.length; j += 1) {
        const l = block[j];
        if (!l.trim()) {
          buf.push('');
          continue;
        }
        const indent = l.length - l.trimStart().length;
        if (indent < 6) break;
        buf.push(l.slice(6));
      }
      i = j - 1;
      out[key] = buf.join('\n').trim();
      continue;
    }

    out[key] = parseScalar(rest);
  }
  return out;
}

/** YAML 标量 → JS 值（够用就好，不认识的原样返回字符串） */
function parseScalar(raw) {
  const s = String(raw ?? '').trim();
  if (s === '' || s === 'null' || s === '~') return null;
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === '[]') return [];
  if (/^\[.*\]$/.test(s)) {
    return s
      .slice(1, -1)
      .split(',')
      .map((part) => parseScalar(part))
      .filter((v) => v !== '' && v !== null);
  }
  if (/^'.*'$/.test(s)) return s.slice(1, -1).replace(/''/g, "'");
  if (/^".*"$/.test(s)) {
    try {
      return JSON.parse(s);
    } catch {
      return s.slice(1, -1);
    }
  }
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return s;
}

/** 同步找 patch 文件（启动期用；resolvePatchFile 只认环境变量/缓存） */
export function findPatchFileSync(dshHome) {
  const fromEnv = resolvePatchFile();
  if (fromEnv) return fromEnv;
  const profilesDir = join(dshHome, 'profiles');
  let names = [];
  try {
    names = readdirSync(profilesDir);
  } catch {
    return undefined;
  }
  for (const name of names) {
    const file = join(profilesDir, name, 'cordis.patch.yml');
    try {
      const text = readFileSync(file, 'utf8');
      if (new RegExp(`^\\s*-\\s*id:\\s*${ROW_ID}\\s*$`, 'm').test(text)) {
        cachedPatchFile = file;
        return file;
      }
    } catch {
      /* 继续找 */
    }
  }
  return undefined;
}

/** 读 profile patch 里的 config（找不到就空对象，绝不抛） */
export function readPatchConfig(dshHome) {
  try {
    const file = findPatchFileSync(dshHome);
    if (!file) return { config: {}, file: '' };
    return { config: parsePatchConfig(readFileSync(file, 'utf8')), file };
  } catch {
    return { config: {}, file: '' };
  }
}
