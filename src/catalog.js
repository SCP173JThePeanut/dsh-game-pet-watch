/**
 * 动画目录（catalog）：**离线**给每一段动画生成一句文字描述，运行时只读文本、不再看视频。
 *
 * 为什么要这样：运行时"每次看 12 帧图"要多花约 2,000 token/次且模型还得现场理解画面；
 * 而一段动画的语义是**固定不变**的——查一次、写进描述、之后每次只读那几十个字。
 * 建库成本只在第一次（106 段 × 一次带图调用），之后永远是从磁盘读文本。
 *
 * 分工：
 *   - 画面（抽帧九宫格）：由 dsh-pet-gpw 副本生成（它本来就会解 webm）→ /gpw/sheet
 *   - 描述（看图写话）：由本插件调用当前多模态模型 → 落盘 catalog.json
 *   两边的缓存键都是「来源文件 mtime + 参数」，所以素材没换就一次都不会重跑。
 *
 * catalog.json 结构（按需增删，读方一律容错）：
 *   {
 *     v: 1,
 *     builtAt: 1789...,
 *     model: 'deepseek-account/deepseek-flash',
 *     items: {
 *       "待机呼吸休闲.webm": {
 *         at, mtime, sheet: '路径', model,
 *         action: '呼吸的同时偶尔眨眼、身体轻微起伏',
 *         mood: ['平静','放松'], scene: ['待机','无事发生时'],
 *         text: '（可选）画面里出现的文字',
 *         edited: true（人工改过就不再被批量覆盖）
 *       }
 *     }
 *   }
 */
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

const EMPTY = () => ({ v: 1, builtAt: null, model: '', items: {} });

/** 给模型看的指令：只要句式固定、字段少，小模型也能稳定输出 JSON */
export const DEFAULT_DESCRIBE_SYSTEM = [
  '你在给一段桌面宠物的循环动画写"索引卡"，供另一个模型在运行时挑选动画用。',
  '你会收到一张九宫格：同一段动画按时间顺序的 12 帧，每帧左上角有 #序号 与 秒数。',
  '只输出一个 JSON 对象，不要任何解释、不要代码块围栏：',
  '{"action":"这一系列帧里角色在做什么，一句话，30 字内","mood":["情绪标签1","情绪标签2"],',
  '"scene":["适合在什么场合播放，短标签"],"text":"画面里出现的文字，没有就空串"}',
  '要求：',
  '- action 描述**动作本身**（例如"闭眼打瞌睡，身体轻微起伏"），不要复述宠物长相。',
  '- mood 给 1~3 个通用情绪标签（如 开心/害羞/生气/累/无聊/得意/慌/平静/专注）。',
  '- scene 给 0~2 个**真正有区分度**的场合标签，只在明显适用时才写：',
  '    深夜/庆祝/安慰主人/主人成功时/主人失败时/被拖拽/被点击/互动/整点时/节日；',
  '  ⚠️ **不要**给所有动画都写"待机"——如果这段动画没什么特殊场合，scene 就给空数组 []。',
  '  待机是默认状态，写了等于没写，反而让挑选动画的模型无从判断。',
  '- action 里保留**画面独有的具体细节**：道具、颜色、动作转折（例如"掏出一只瘪空的小钱袋"），',
  '  这些细节比抽象概括更有用。',
  '- 只描述你**真的看到**的，看不清就写保守的描述，不要编。',
].join('\n');

export class CatalogStore {
  /**
   * @param {{file:string, describe:(args:{system:string,text:string,image:string})=>Promise<{raw:string}>, log?:(m:string)=>void}} options
   */
  constructor(options) {
    this.file = options.file;
    this.describe = options.describe;
    this.log = options.log ?? (() => {});
    this.data = EMPTY();
    this.loaded = false;
    this.writeChain = Promise.resolve();
  }

  async load() {
    if (this.loaded) return this.data;
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8'));
      this.data = {
        v: 1,
        builtAt: typeof parsed?.builtAt === 'number' ? parsed.builtAt : null,
        model: typeof parsed?.model === 'string' ? parsed.model : '',
        items: parsed?.items && typeof parsed.items === 'object' ? parsed.items : {},
      };
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        try {
          await rename(this.file, `${this.file}.bak-${Date.now()}`);
          this.log('动画目录损坏，已备份重来：' + this.file);
        } catch {
          /* 备份失败也不阻塞 */
        }
      }
      this.data = EMPTY();
    }
    this.loaded = true;
    return this.data;
  }

  async persist() {
    const snapshot = JSON.stringify(this.data, null, 2);
    this.writeChain = this.writeChain.then(async () => {
      await mkdir(dirname(this.file), { recursive: true });
      await writeFile(this.file, snapshot, 'utf8');
    });
    return this.writeChain;
  }

  /** 某段动画当前有效的描述（没有就 undefined） */
  item(name) {
    return this.data.items[name];
  }

  /**
   * 描述一段动画并落盘。
   * @param {{name:string, mtime:number, sheet:string}} input
   * @param {{system:string, model:string, force?:boolean, prompt?:string, source?:string}} options
   *   `prompt` 可换掉默认的"动画索引卡"措辞 —— **图片目录要用自己的措辞** ✗→✓
   *   （原来给表情包也发"请为动画「X」写索引卡" ✗，虽然模型看画面照样写得对 ✓，但措辞串味 ✓）；
   */
  async describeOne(input, options) {
    await this.load();
    const existing = this.data.items[input.name];
    // 人工改过的条目不再被批量覆盖（除非 force）
    if (existing && existing.edited && !options.force) {
      return { name: input.name, skipped: 'edited' };
    }
    if (existing && existing.mtime === input.mtime && !options.force) {
      return { name: input.name, skipped: 'cached' };
    }
    const { raw } = await this.describe({
      system: options.system,
      text: options.prompt ?? `请为动画「${input.name}」写索引卡。文件名只是线索，以你看到的画面为准。`,
      image: input.sheet,
    });
    const parsed = parseDescribe(raw);
    const item = {
      at: Date.now(),
      mtime: input.mtime,
      sheet: input.sheet,
      /** 同一路径也写一份 `file` ✓ —— 图片目录的消费方（发送端/对账工具）按 `file` 找 ✓ */
      file: input.sheet,
      model: options.model,
      /** 来源标记：offline（离线描述）/ vision（视觉模型）/ 人工（edited）✓ —— 审计要看得到 ✓ */
      source: options.source ?? 'vision',
      /**
       * **谁生成的这条描述** ✓（鱼表里的 id，例如 legacy / current ✓）。
       *
       * 为什么必须有：多鱼之后图库是**共用**的 ✓（文件只有一套数字编号 ✓），
       * 但描述要分家 ✓ —— 没有这个标记就分不清"这条是 7341 写的还是 7342 写的" ✗，
       * 也就无法做到"每条鱼只挑自己账上的图" ✓、更没法知道**还欠哪几张** ✓。
       * 老条目没有这个字段 = 从共用种子来的 ✓ → 会被算作"不是我的" ✓ → 各鱼会补上自己那份 ✓。
       */
      by: typeof options.by === 'string' ? options.by : '',
      action: parsed.action,
      mood: parsed.mood,
      scene: parsed.scene,
      text: parsed.text,
      raw: parsed.ok ? undefined : String(raw).slice(0, 300),
    };
    this.data.items[input.name] = item;
    this.data.builtAt = Date.now();
    this.data.model = options.model;
    await this.persist();
    return { name: input.name, item };
  }

  /** 人工改写：标 edited，批量不再覆盖 */
  async edit(name, patch) {
    await this.load();
    const current = this.data.items[name] ?? { at: Date.now(), mtime: 0 };
    this.data.items[name] = {
      ...current,
      ...patch,
      at: Date.now(),
      edited: true,
    };
    await this.persist();
    return this.data.items[name];
  }

  async remove(name) {
    await this.load();
    if (!this.data.items[name]) return false;
    delete this.data.items[name];
    await this.persist();
    return true;
  }

  /** 给提示词用的紧凑清单：一行一段，只保留模型挑动画真正需要的字段 */
  promptBlock(onlyNames) {
    const names = onlyNames ?? Object.keys(this.data.items);
    const lines = [];
    for (const name of names) {
      const item = this.data.items[name];
      if (!item || !item.action) continue;
      const mood = Array.isArray(item.mood) && item.mood.length ? `｜情绪：${item.mood.join('/')}` : '';
      const scene = Array.isArray(item.scene) && item.scene.length ? `｜场合：${item.scene.join('/')}` : '';
      const text = item.text ? `｜画面文字：${item.text}` : '';
      lines.push(`- ${name}：${item.action}${mood}${scene}${text}`);
    }
    return lines.join('\n');
  }

  stats() {
    const items = Object.values(this.data.items);
    return {
      total: items.length,
      edited: items.filter((i) => i.edited).length,
      described: items.filter((i) => i.action).length,
      builtAt: this.data.builtAt,
      model: this.data.model,
      chars: this.promptBlock().length,
    };
  }

  snapshot() {
    return {
      builtAt: this.data.builtAt,
      model: this.data.model,
      items: Object.fromEntries(
        Object.entries(this.data.items).map(([name, item]) => [name, { ...item, raw: undefined }]),
      ),
      stats: this.stats(),
    };
  }
}

/** 把模型输出解析成索引卡；容错：代码块围栏、前后废话、字段缺失 */
export function parseDescribe(raw) {
  const text = String(raw ?? '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) {
    const fallback = text.replace(/```[a-z]*|```/g, '').trim().split(/\r?\n/)[0] ?? '';
    return { ok: false, action: fallback.slice(0, 60), mood: [], scene: [], text: '' };
  }
  let obj;
  try {
    obj = JSON.parse(text.slice(start, end + 1));
  } catch {
    return { ok: false, action: '', mood: [], scene: [], text: '' };
  }
  const list = (value, max) =>
    (Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[、,，/]/) : [])
      .map((s) => String(s).trim())
      .filter(Boolean)
      .slice(0, max);
  return {
    ok: true,
    action: String(obj.action ?? '').trim().slice(0, 120),
    mood: list(obj.mood, 3),
    scene: list(obj.scene, 3),
    text: String(obj.text ?? '').trim().slice(0, 60),
  };
}

/**
 * @param {string} dataDir 数据目录（见 memoryFilePath 的说明）
 */
export function catalogFilePath(dataDir) {
  return join(dataDir, 'catalog.json');
}
