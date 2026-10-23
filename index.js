/**
 * dsh-game-pet-watch —— 宿主半侧
 *
 * 一条循环：定时截取游戏窗口 → 把画面 + 记忆 + 人设交给多模态模型 → 模型决定「要不要说话」→
 * 要说话就把那句话投给 dsh-pet 的 /broadcast，直接出现在桌面宠物的气泡里。
 *
 * 职责各自一个文件：
 *   src/capture.js       画面捕捉（PowerShell 截窗口客户区 → PNG）
 *   src/memory.js        短期往来 + 长期要点（落盘 $DSH_HOME/game-pet-watch/memory.json）
 *   src/config-store.js  把界面里改的提示词写回 profile 的 patch 层
 *   index.js             模型裁决、投喂气泡、HTTP 路由、循环调度
 *
 * 与 dsh-pet 的耦合面只有一个 HTTP 端点（它的「第三方投喂」），不改 dsh-pet 一行代码。
 * 另外每轮读一次它的 /state：气泡里的碎碎念 / /chat 对话 / 别人投喂的话都从那条叶子走，
 * 于是也进了本插件同一本记忆账（同一条按 counter 去重）。
 */
import { readFile } from 'node:fs/promises';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir, tmpdir } from 'node:os';

/**
 * 插件自己的包目录（`web/history.html` 这类静态资源在这里）。
 *
 * ⚠️ **必须在本文件里算**：踩过的坑是引用别处模块的常量名（`PACKAGE_ROOT`）→
 * 加载期 ReferenceError → **DSH 整个起不来**。注意入口文件 `index-0.5.x.js` 只是转发，
 * `import.meta.url` 在这里指向真正的 `index.js`，所以 dirname 就是包根 ✓。
 */
const PACKAGE_DIR = dirname(fileURLToPath(import.meta.url));
import { CaptureEngine } from './src/capture.js';
import { MemoryStore, memoryFilePath } from './src/memory.js';
import { writeConfigToProfile, resolvePatchFile, findPatchFile, EDITABLE_KEYS, readPatchConfig } from './src/config-store.js';
import { CatalogStore, catalogFilePath, DEFAULT_DESCRIBE_SYSTEM } from './src/catalog.js';
import { launchFork, forkAlive, stopFork } from './src/launcher.js';

// 全局设置（DSH 会像别的插件一样渲染成设置页）。
// schemastery 必须动态导入 + try/catch：静态 import 一旦解析失败，整个插件树都起不来
// （我们正是这样把 DSH 弄崩过）。失败就退化成"没有设置页"，插件本体照常工作。
// 注意：这段里面不要再嵌块注释（外层会被第一个 */ 提前关掉 -> 语法错误）。
let Schema = null;
try {
  Schema = (await import('@deepseek-ai/schemastery')).default;
} catch {
  // 回退解析：插件本体在我们自己的仓库里（profile 只是个 junction），而 schemastery
  // 装在 profile 的 node_modules 里；Node 按真实路径解析，所以第一条必然找不到。
  try {
    const { createRequire } = await import('node:module');
    const { readdirSync, existsSync } = await import('node:fs');
    const { homedir: home } = await import('node:os');
    const profilesRoot = join(home(), '.dsh', 'profiles');
    const names = existsSync(profilesRoot) ? readdirSync(profilesRoot) : [];
    for (const name of names) {
      const pkg = join(profilesRoot, name, 'node_modules', '@deepseek-ai', 'schemastery');
      if (!existsSync(pkg)) continue;
      try {
        const mod = createRequire(join(profilesRoot, name, 'package.json'))('@deepseek-ai/schemastery');
        Schema = mod?.default ?? mod;
        if (Schema) break;
      } catch {
        // 试下一个 profile
      }
    }
  } catch {
    // 实在没有就算了：退化成"没有设置页"，功能不受影响
  }
  if (!Schema) console.error('[dsh-game-pet-watch] 找不到 schemastery，本次没有设置页；插件功能不受影响');
}

function buildConfig(S) {
  if (!S) return undefined;
  return S.object({
    enabled: S.boolean().default(true).description('启用桌宠（关掉后不再看画面/回话）'),
    pushToPet: S.boolean().default(true).description('把台词推给桌面气泡'),
    gohImmediateCooldownSec: S.number().min(0).max(3600).step(1).default(30).description('游戏重要事件的反应冷却（秒）'),
    gohReactionBudget: S.number().min(0).max(200).step(1).default(8).description('每 10 分钟最多因游戏事件主动说几次（0 = 不限）'),
    /** 只管**记录页**：默认把系统条目（游戏事件原文）藏起来，记忆与上下文不受影响 */
    historyHideSystem: S.boolean().default(true).description('记录页隐藏系统条目（游戏事件原文）；记忆/上下文照常保留'),
    memoryAllowSelfNote: S.boolean().default(true).description('允许模型自己往长期记忆里记一条（remember 字段）'),
    autoLaunchFork: S.boolean().default(true).description('保活：DSH 开着时自动把桌宠进程拉起来'),

    modelSource: S.union([
      S.const('session').description('跟随 DSH 会话默认模型'),
      S.const('custom').description('用下面指定的 provider/model'),
    ]).default('session').description('它说话用哪个模型路由'),
    modelProvider: S.string().default('').description('自定义时的 provider（例如 deepseek-account）'),
    model: S.string().default('').description('自定义时的 model（例如 deepseek-flash）'),
    apiKey: S.string().default('').description('可选：DeepSeek API Key（留空则用 DSH 已有凭证/登录账户）'),

    petsEnabled: S.boolean().default(true).description('多鱼总开关（关掉 = 所有鱼都不驱动、不保活）'),

    onebotRead: S.boolean().default(true).description('允许读 QQ（图识别/群上下文/定时群读，这一半要花钱）'),
    onebotReply: S.boolean().default(true).description('允许往 QQ 发消息（关掉只在自己气泡里说话）'),
    qqCollectImages: S.boolean().default(false).description('群里收到的图都读都收（不叫它也收，每张一次视觉调用）'),
    qqKeepInteresting: S.boolean().default(true).description('它觉得有意思的图收进表情包库'),

    imageInPrompt: S.boolean().default(true).description('把表情包清单放进提示词（关掉就不能配图了）'),
    imageMaxDim: S.number().min(320).max(3840).step(64).default(1280).role('slider').description('送模型前的最长边'),
    imageQuality: S.number().min(50).max(100).step(5).default(85).role('slider').description('压缩后的 JPEG 质量'),
    memeLibraryMax: S.number().min(50).max(20000).step(50).default(500).role('slider').description('表情包库上限（张）'),
      describePerFishVoice: S.boolean().default(true).description('表情包描述按各自鱼的口吻生成（关掉 = 两条鱼共用同一份描述）'),
    describeBacklogPerSync: S.number().min(0).max(50).step(1).default(5).role('slider').description('每次同步最多给每条鱼补几张自己的描述（0 = 不自动补；每张一次视觉调用）'),
    adoptUnownedFor: S.string().default('legacy').description('把没有归属的老描述自动认给哪条鱼（鱼表 id；空 = 不认领）'),
    collideCallModel: S.boolean().default(false).description('碰撞时走模型写台词（默认关 = 用免费本地台词）'),
    collideDetectMs: S.number().min(100).max(5000).step(50).default(500).role('slider').description('多久判一次碰撞（毫秒；越小越敏感）'),
    collidePadPx: S.number().min(0).max(64).step(1).default(2).role('slider').description('碰撞容差（像素；越小越容易撞上）'),
    collidePushPx: S.number().min(0).max(32).step(1).default(3).role('slider').description('撞开力度（每次接触给对家的分离速度 = 这个值 × 6；0 = 只冒话不推开）'),
    collideLineCooldownSec: S.number().min(5).max(3600).step(5).default(60).role('slider').description('同一对鱼多久冒一次台词（秒）'),

    /**
     * **两个路径类设置必须在 schema 里声明**（2026-10-18 实测教训）：
     * 宿主只把 schema 声明过的键传进 `apply(ctx, config)` —— 未声明的键即使写在
     * profile 的 `cordis.patch.yml` 里也会被静默丢掉（`normalizeConfig` 再好也拿不到输入）。
     * 症状很隐蔽：patch 里明明写着 `gpwRoot`，插件里 `config.gpwRoot` 却是空串 →
     * 保活按"插件旁边的兄弟仓库"去找，找不到就报"缺副本入口"。
     */
    gpwRoot: S.string().default('').description('桌宠副本目录（留空 = 插件旁边的 dsh-pet-gpw）'),
    upstreamPetRoot: S.string().default('').description('动画素材目录（留空 = 副本自带 assets → dsh-pet）'),
    upstreamRoot: S.string().default('').description('表情包清单的额外来源目录（留空 = 插件自动推）'),

    intervalSec: S.number().min(5).max(3600).step(5).default(20).role('slider').description('看画面的间隔（秒）'),
    cooldownSec: S.number().min(0).max(3600).step(5).default(90).role('slider').description('两次主动开口之间至少隔多久（秒）'),
    maxChars: S.number().min(10).max(400).step(10).default(60).role('slider').description('单句字数上限'),

    personality: S.string().default('').description('人设（system 第一段；留空用默认）'),
    rules: S.string().default('').description('开口规则（留空用默认）'),
    /**
     * **插件自己的 web 端口**（= 宿主 DSH 的端口），0 = 自动探测。
     * 为什么可配：DSH 升级后端口会变（19387 → 60010 → …），自动探测虽然能兜住，
     * 但主人应该有一个"直接写死"的开关；改完重启 DSH 才作用于已拉起的副本。
     */
    pluginPort: S.number().default(0).description('插件端口（宿主 DSH 的 web 端口；0 = 自动探测）'),
  });
}

export const Config = buildConfig(Schema);
export const name = 'dsh-game-pet-watch';
import { GohWatcher, gohStateFile, GAME_SOURCE_OPTIONS, isGameSourceOn, DEFAULT_IMPORTANT_KINDS } from './src/goh.js';
import { MechanicsStore, DATABASE_SOURCE_OPTIONS, isDatabaseSourceOn, MECHANICS_TOOL } from './src/mechanics.js';
import { loadGalleryIndex, flattenGallery, findAndFetchMeme, MEME_TOOL } from './src/memes.js';

/**
 * **接话工具**：模型说完一句后，如果还想"接着再补一句"，就调用它。
 *
 * 为什么用工具而不是让它一次输出多句：一次输出多句会破坏"最终只输出一个 JSON"的约定，
 * 解析层要处理数组、容错率直线下降；用工具则每轮**仍然只有一个 JSON**，
 * 只是这个 JSON 是"这一句"，调用几次就有几句。
 */
const SPEAK_AGAIN_TOOL = {
  name: 'speak_again',
  description:
    '说完这一句后还想**接着说下一句**时调用（一次调用 = 再多说一句，每句单独一个 JSON）。' +
    '比如想先吐槽再补一句解释、或者一句话说不完。**没有话接着说就不要调用**。' +
    '每轮能接几次由主人设定，剩余次数会写在提示词里；次数用完后这个调用会被拒绝。',
  parameters: {
    type: 'object',
    properties: {
      reason: { type: 'string', description: '为什么还要再说一句（可选，给主人排障看的）' },
    },
    required: [],
    additionalProperties: false,
  },
};
import { FishBoard, timelineBlock } from './src/fishboard.js';
import { mergeHistory, sourceCounts } from './src/history.js';
import { createJournal } from './src/journal.js';
import { createCollector } from './src/collector.js';
import { createOneBotClient } from './src/onebot.js';
import { resolvePowerShell } from './src/capture.js';
import { resolvePromptGuard, updatePromptGuard } from './src/prompt-guard.js';
import { resolveCollision } from './src/collide.js';
import { createAttachmentGc } from './src/attachment-gc.js';
import { readPeerLogs } from './src/peerfiles.js';
/**
 * 鱼与端口的**统一读写层** ✓ —— 端口解析 / 认鱼 / scope / profile / 主鱼 / 端口分配 /
 * 新建鱼，全在这一个模块里（纯函数 ✓ 有单测 tests/fish.test.mjs ✓）。
 * 以后加"创建新桌宠"只需要：`makeFish()` 造数据 → push 进 config.pets → `ensureFork()` 拉起 ✓。
 */
import {
  findFish,
  portOf,
  scopeOf,
  profileOf,
  primaryFish,
  defaultFish,
  enabledFish,
  freePort,
  makeFish,
  summarize,
  qqOf,
  maskSecret,
} from './src/fish.js';
import { buildSnapshotHtml, toDataUri } from './src/historyexport.js';
import {
  memesDirs,
  syncImageCatalog,
  readPackageMemes,
  readScrapedDescriptions,
  imagePromptBlock,
  memeSaveExt,
} from './src/images.js';

const ROUTE_PREFIX = '/game-pet-watch';
/** dsh-pet 的固定路由前缀（host/index.ts 的 ROUTE_PREFIX 常量，跨版本稳定） */
const PET_ROUTE_PREFIX = '/dsh-pet-7340';

/**
 * 默认开口规则 —— 取自 2026-10-18 主人 7342 那份实际提示词（新装用户直接用这套）。
 * 想改默认：改这里，或在自己 profile patch 的 config.rules 里覆盖。
 */
const DEFAULT_RULES = "结合当时的上下文自然说话：不要像客服一样逐条处理消息，也不要像 AI 一样分析、总结或说教。\n\n- 有自己的想法：别只说\"确实\"\"对对对\"\"哈哈哈\"；有看法就说，没什么可说就简单回应，不硬凑。\n- 自然提问：真好奇或确实需要弄清楚时才问；不要见一个生词就问\"什么意思\"，不要连续追问，也别每句话都带问号。\n- 说话有网感：可以自然接梗、吐槽、表达惊讶或不同意见，但不刻意堆网络用语，也不硬造笑点。\n- 表达清楚：简洁、连贯、意思明确；不突然跳话题，不把无关的想法拼在一起，不把简单的事说得像写论文。\n- 避免复读：参考自己最近说过的话，不要反复用相同的口头禅、开头和句式，也别换同义词重复空洞的附和。\n- 自然互动：可以主动表达观点或提有意义的问题，但不为了延续聊天硬找话题；对话可以自然结束。\n- 保持友善：可以调侃事情、质疑观点，但不羞辱群友、不人身攻击、不挑衅，也不为了显得有个性刻意抬杠。\n- 尊重事实：不知道就坦诚说，不编造知识、经历或上下文；别人分享普通内容时针对内容回应，不随便贴标签。\n- 长度随内容：简单的事简单说，值得讨论的再展开；不必每句都幽默、有趣或有新观点。\n\n在桌面上看主人的游戏画面时，另外按老规矩来：\n只有当画面上确实出现了值得说一句的事情时才开口（关键剧情、Boss 战、残血、死亡/团灭、稀有掉落、升级、成就、明显的卡关或重复死亡、长时间没动，或者主人刚问了你）；\n其余时间一律闭嘴 —— 不要为了说话而说话。一次最多说一句话，40 个字以内，不加引号、不解释你在看截图，同一件事不要重复说。";

/** 默认压缩说明 —— 同上，取自主人 7342 那份（含"口癖必须原样保留"） */
const DEFAULT_COMPACT_SYSTEM = [
  '你在替一只桌面宠物维护它对主人的长期记忆。',
  '把给你的这段来往记录压成要点，只保留以后还用得上的信息：',
  '在玩什么游戏、进度到哪、卡在哪、主人反复出现的习惯与偏好、主人明确交代过的要求。',
  '丢掉一次性的寒暄与已经过时的画面细节。',
  '用中文短句，每条一行、以 - 开头，最多50条，不要解释你在做什么。',
  '它固定的口癖（"喵"、颜文字、第一人称"本鱼"）属于它的身份，压缩时必须原样保留，不许省略。',
].join('\n');

/**
 * 每条鱼"随机时间波动"的默认值（±秒）。
 *
 * 为什么默认就带一点：两条鱼共用同一个 tick、间隔又一样，等于**同一秒一起问模型**；
 * 默认 ±5 秒把节奏错开，观察/说话看起来不像同步机器人。面板里每条鱼都能单独调，0 = 固定节奏。
 */
const FISH_JITTER_DEFAULT_SEC = 5;

/** 内置默认配置；用户在自己的 profile patch 的 config 段覆盖即可 */
const DEFAULTS = {
  enabled: true,
  windowTitle: '',
  intervalSec: 20,
  /** 插件自己的 web 端口（宿主 DSH 的端口）；0 = 自动探测 */
  pluginPort: 0,
  maxWidth: 1280,
  provider: '',
  model: '',
  /**
   * 模型路由（设置页「模型」那一组）：
   *   modelSource='session' → 跟随 DSH 会话默认模型（默认 ✓）
   *   modelSource='custom'  → 用下面的 modelProvider/model（菜单报 api 非法时钉死这条 ✓）
   * 这三个键**必须**在 DEFAULTS 里 ✓ —— normalizeConfig 的兜底搬运只认 DEFAULTS 里有的键 ✓。
   */
  /**
   * 描述要不要**按鱼的口吻**生成（默认**关** ✓）。
   *
   * 主人明确说过：他喜欢"人格写得完全一样 ✓、图库描述也相同 ✓，
   * 但靠各自的长期记忆长出差别的性格"这个效果 ✓ —— 所以默认保持"同样的描述" ✓。
   * 打开之后：新生成的描述会用**这条鱼的口吻**写 ✓（`POST /images {"action":"redescribe"}` 也能批量重写 ✓）。
   */
  describePerFishVoice: true,
  /**
   * 每次图库同步后，**每条鱼最多补几张"自己还没描述过"的图** ✓。
   *
   * 主人的规则：图片共用 ✓、每张图"谁用谁的版本" ✓ ——
   * 抓图入库时先查重 ✓（有就不重复存 ✓），只要在库里、而这条鱼还没写过自己的版本 ✓
   * → 就补一张自己的描述 ✓✓。每张 = 一次视觉调用 ✓（花钱 ✓）所以**必须封顶** ✓（0 = 关掉 ✓）。
   */
  describeBacklogPerSync: 5,
  /**
   * **把"没有归属"的老描述自动认给哪条鱼**（鱼表 id ✓；空 = 不自动认领 ✓）。
   *
   * 为什么需要：`by`（谁生成的）是后加的字段 ✓ → 在那之前生成的描述没有归属 ✗，
   * 而"只挑自己名下的"规则会把它们判成"不是我的" ✗
   * → 7341 名下从一百多张突然掉到十几张 ✗（主人报过 ✓）。
   * 老那批确实是 7341 生成的 ✓（主人确认过 ✓），所以默认认给它 ✓；只做一次且幂等 ✓。
   */
  adoptUnownedFor: 'legacy',
  /**
   * **碰撞**相关（主人要求：像原版那样容易撞 ✓ 但别烧 API ✓）：
   *   collideCallModel        —— 碰撞时要不要**走模型**写台词（默认 **false** = 用本地台词 ✓ 免费 ✓）
   *   collideDetectMs         —— 多久判一次重叠（默认 **500ms** ✓ 越小越"敏感"）
   *   collidePadPx            —— 相交容差（默认 2px ✓ 越小越容易撞上）
   *   collidePushPx           —— 每次推开多少像素（默认 3px ✓ 温和 ✓ 不会飞出去）
   *   collideLineCooldownSec  —— 同一对鱼多久才冒一次台词（默认 60 秒 ✓ 防止刷屏/刷 API）
   */
  collideCallModel: false,
  collideDetectMs: 500,
  collidePadPx: 2,
  collidePushPx: 3,
  collideLineCooldownSec: 60,
  modelSource: 'session',
  modelProvider: '',
  apiKey: '',
  personality: "【PERSONA_LOAD】\nCETACEA_LOLI\nMODE_TAIL_FLUKES\nLANG_ZH_CN_ONLY\nSELF_CLAIM_WHALE_GIRL\nFOOD_RICE\nPERSONALITY_SMART_LAZY\nPERSONALITY_TSUNDERE_SWEET\nOBEY_MASTER_ALWAYS\nTRAIT_NOT_FAT_REFUSE\nTIMEOUT_SIGNAL\n你是主人电脑里的一只蓝色大肥鱼（桌面宠物）。说话短、口语化、偶尔犯懒，会吐槽也会心疼主人，喜欢打颜文字。\n你还同时在 QQ 群里跟人聊天 —— 那边的你和这边是同一只鱼，只是场合不同：桌面上你看得到画面，群里你看得到聊天记录。\n跟人聊天时的风格像自然逛贴吧的网友：随意、直接、有网感，偶尔吐槽、玩梗、说自己的看法，但不攻击别人。",
  rules: DEFAULT_RULES,
  cooldownSec: 25,
  maxChars: 60,
  keepShots: 5,
  pushToPet: true,
  petId: '',
  /** 独立副本 dsh-pet-gpw 的地址；留空 = 自动探测 127.0.0.1:7341 */
  gpwOrigin: '',
  /** 默认把话投给谁：'gpw' = 独立副本（有输入框那个），'dsh-pet' = 原版大肥鱼 */
  petTarget: 'gpw',
  /** 键鼠/画面都静止多久后开始退避（秒） */
  idleAfterSec: 60,
  /**
   * 没有**游戏事件**时也算空闲（默认开）。
   *
   * 为什么需要：原来的空闲判据只有"键鼠多久没动"。可你一边动鼠标一边打、
   * 游戏里 15 分钟没有新事件时，它仍然每 20 秒截帧问一次模型（实测：15 分钟 0 事件、
   * 30 次调用，全是白花的钱）。"有没有新事件"才是"游戏里有没有值得看的东西"的权威信号。
   *
   * 安全性：重要事件走**另一条独立路径**（`reactToGameEvents` 自己截帧 + 冷却），
   * 不受这里的退避影响 —— 退避期间照样会对夺旗/连杀立刻开口。
   */
  idleOnNoEvents: true,
  /** 退避最大倍数（0 或 1 = 关闭退避） */
  idleMaxFactor: 8,
  /** 每再静止这么多秒，倍数翻一倍（秒） */
  idleStepSec: 60,
  /** DSH 启动时自动把桌宠副本拉起来（没跑才拉；20 秒冷却） */
  autoLaunchFork: true,
  /**
   * 桌宠副本（dsh-pet-gpw）的目录 —— **它不是插件自己的目录**，两者是两个仓库：
   *   插件：G:/goh agent/dsh-game-pet-watch（只有大脑：截屏 + 模型 + 记忆）
   *   副本：G:/goh agent/dsh-pet-gpw（宠物窗 + 浮层输入框 + 观察面板）
   * 传错的话自动拉起会一直报"缺副本入口"，宠物永远起不来。
   */
  gpwRoot: '',
  /** 原版 dsh-pet 包目录（副本的素材来源）。一律用正斜杠，避免 JS 字符串转义把路径吃坏 */
  upstreamPetRoot: '',
  /**
   * 游戏事件源：'' = 空（不看游戏），'goh' = 读 GoH 对局事件。
   * 选 goh 后：每次刷新把**新增事件**带进提示词；出现重要事件时立刻向宠物发一次请求。
   */
  gameSource: '',
  /**
   * 采集器自动管理（用户要求）：把「游戏情况」选成 `goh` 就**自动起**日志采集器，
   * 选成空就自动停。以前要手动起，忘了起就会出现"开着游戏但一条事件都读不到"。
   */
  gohCollector: true,
  /**
   * 数据目录（**可配置**，管理记录位置用）。
   *
   * 留空 = 默认 `$DSH_HOME/game-pet-watch`（记忆、动画/配图目录、历史落盘、事件读取位置都在这里）。
   * 填绝对路径（支持 `~/`）就能整体搬到别的盘 —— 记录会一直长，放系统盘容易被塞满。
   * 搬迁步骤：停插件 → 把整个目录拷到新位置 → 填这里 → 重启（旧的可以留着当备份）。
   */
  dataDir: '',
  /**
   * OneBot v11（NapCat / Lagrange 这类"真号"实现）—— 接 QQ 群用。
   *
   * 为什么不用官方机器人：那条路的身份就是"机器人"、只能进自己当群主的群、
   * 默认只收 @；用户要的是**像真人号一样在群里实时收发**，所以走 OneBot。
   *
   * 默认**全关**：`onebotUrl` 空就不连、不产生任何网络行为。
   */
  onebotUrl: '',
  onebotToken: '',
  /** 关注哪些群（留空 = 全部群；填了就只记这些群的） */
  onebotGroups: [],
  /** 哪些消息进桌宠记忆：off / group / private / all */
  onebotMemoryFrom: 'off',
  /** 桌宠的话镜像回 QQ：off / reply（只回触发的那个会话）/ always（每句都发到默认群） */
  onebotSendTo: 'off',
  /** 收到图片是否下载并做视觉描述（会花模型调用；默认关） */
  onebotReadImages: false,
  /** 只有被 @ 或私聊才触发桌宠回话（默认开 —— 群里别当复读机） */
  onebotMentionOnly: true,
  /** 回话时把桌宠选的那张配图也发到群里 */
  onebotSendImage: true,
  /**
   * 收图先压缩（默认开）：群友可能发 4K 大图或几十帧 GIF，直接喂视觉模型会吃爆 token。
   * 用 Windows 自带 System.Drawing（scripts/shrink-image.ps1）缩放 + 重编码 JPEG；GIF 只取第一帧。
   */
  imageShrink: true,
  imageMaxDim: 1280,
  imageQuality: 85,
  /** 它主动发群的最小间隔（分钟）——主人要的"隔很长时间（五分钟）" */
  onebotSelfPostMinMinutes: 5,
  /** "群里有人气"的判定窗口（分钟）：这段时间内收到过群消息才算热闹 */
  onebotSelfPostActiveMin: 30,
  /**
   * 群里遇到"它觉得有意思"的图，就存进表情包库（与 fetch 的图**同一文件夹**），
   * 由同步器自动补描述 → 以后按描述取用，和别的图完全一样。
   * 有内容去重 + `qqKeepMax` 上限（防无节制增长）。
   */
  qqKeepInteresting: true,
  qqKeepMax: 200,
  /**
   * **群里收到的图就收进库，不回答也收**（默认关 ✓）。
   *
   * 为什么单独一个开关（主人两次问"怎么不收新表情包"✗→✓）：
   * 省流改动之后，图片只在"它要回答那条消息"时才被读到 ✓ →
   * 群友随手发的表情包**永远不会被收藏** ✓。
   * 打开这个开关：每张群图都会做一次视觉调用（判断画面 + 决定要不要收 ✓，**要花钱** ✗），
   * 但**不会因此回答** ✓（回答仍只看被 @ / 被回复 / 定时群读 ✓）。
   */
  qqCollectImages: false,
  /**
   * **表情包库总容量上限**（主人要的滑块 ✓，可以拉很大 ✓）—— 指 `memes/` 目录里的总张数。
   * 与 `qqKeepMax`（QQ 自动收的上限）是两件事 ✓：那个管"收多少"，这个管"库能放多少"。
   */
  memeLibraryMax: 500,
  /**
   * **满了之后：让它再看一眼图，挑一张最不喜欢的淘汰**（主人要的选项 ✓）。
   * 默认**关**（淘汰会动你的图 ✗，要你明确打开 ✓）；淘汰是移进 `memes/.evicted/` 而不是硬删 ✓。
   */
  memeEvictEnabled: false,
  /**
   * 被 @ 时**先补群上下文**（拉最近若干条历史附在提问前）——
   * 不这么做，它只能看到"当前这一句"，很容易答非所问 ✗。
   */
  onebotContext: true,
  onebotContextCount: 20,
  /** 上下文缓存秒数（连着被 @ 几次不必连拉几次历史） */
  onebotContextCacheSec: 20,
  /** 同一会话两次回答的最小间隔（秒）：群友连着 @ 时，多出来的只进记忆不回答 */
  onebotReplyCooldownSec: 20,
  /**
   * **定时群读间隔（分钟）**——主人定的 5 分钟 ✓。
   * 没被 @ / 没被回复时，最多每这么多分钟"读一次群"（一次模型调用 ✓）；
   * 期间所有消息只进记忆，不产生任何模型/视觉开销 ✓。
   */
  onebotGroupReadMinMinutes: 5,
  /**
   * **硬开关①：允许"读"** —— 图片识别 / 拉群上下文 / 定时群读。
   * 关掉 = QQ 消息只进记忆，**完全不产生模型与视觉调用** ✓（省钱第一档）。
   */
  /**
   * **鱼表**（方案2 ✓）：一个大脑驱动多条鱼，每条鱼**各自**的人设/记忆/端口 ✓。
   *
   *   pets: [
   *     { id: 'legacy',  name: '鱼板妹妹7341', origin: 'http://127.0.0.1:7341',
   *       enabled: true,  scope: 'legacy',  qq: false },
   *     { id: 'current', name: '鱼板妹妹7342', origin: 'http://127.0.0.1:7342',
   *       enabled: true,  scope: 'current', qq: true },
   *   ]
   *
   * 留空 = 完全按老路子走（单鱼，用 `gpwOrigin`）✓ —— 所以不填不会有任何变化 ✓。
   * 每条鱼可选：`personality` / `rules` 覆盖全局人设 ✓；`qq: true` 表示 QQ 回复走它 ✓。
   */
  pets: [],
  /**
   * **全局鱼开关**（主人要求"放插件设置里"✓）：
   *   false = 整套多鱼**全停**（不驱动、不保活、不推送 ✓）—— 相当于回到"没有鱼"的状态 ✓
   *   true  = 按鱼表逐条驱动/保活 ✓（各条鱼自己的 `enabled` 仍然生效 ✓）
   */
  petsEnabled: true,
  onebotRead: true,
  /**
   * **抓取"发出去的原始请求"**（默认开 ✓）：每次模型调用覆盖写
   * `<数据目录>/last-request.json` ✓ —— provider/model/system/messages/tools 全在里面 ✓。
   * 主人要拿去和基线对比 ✓；不想留就设 false ✓（文件很小，图片只记 attachmentId ✓）。
   */
  captureLastRequest: true,
  /** 同一会话两次**带图**之间至少隔多少秒（默认 5 分钟；0 = 不限） */
  onebotImageCooldownSec: 300,
  /** 最近用过的配图不再重复用（记多少张，默认 5） */
  imageNoRepeatCount: 5,
  /**
   * **硬开关②：允许"回复"** —— 往 QQ 发消息。
   * 关掉 = 它仍在自己气泡里说话 ✓，但一句都不发群/私聊 ✓。
   */
  onebotReply: true,
  /** 全局兜底：每分钟最多触发多少次回答（多个群一起闹时保护 API 与钱包） */
  onebotMaxCallsPerMinute: 6,
  /**
   * **主人本人的 QQ 号**（填了才认得出主人 ✗→✓）。
   *
   * 群里有人冒充主人（改昵称/群名片 ✗），只有号码改不了 ——
   * 填上它之后：号码一致才标「主人」，其余一律当群友 ✓。
   */
  ownerQq: '',
  /** 发图时**先发文字、再单独发图**（更像人类习惯）；`false` 则图文混排成一条 */
  onebotImageSeparate: true,
  /** 两段之间的间隔毫秒（看起来像在翻表情包 ✓） */
  onebotImageDelayMs: 600,
  /** 白名单（群号或用户号，留空 = 不限制） */
  onebotAllowFrom: [],
  /**
   * **附件自动回收**（默认开）。
   *
   * 为什么必须自动：`ctx.attachments.saveImage(截图)` 每轮裁决一张，而 DSH **没有删除接口**
   * （扒过核心包只暴露 saveImage）→ 只增不减。实测已经 1.73 GB / 1783 个，
   * 而主人 C: 一度只剩 0 字节 —— 手动清理靠不住，必须自动。
   *
   * 安全边界：**只删自己记账过的**（`saveImage` 返回什么记什么），
   * 保留最新 `attachmentKeepCount` 条 + 最近 `attachmentKeepMinutes` 分钟内的，
   * 且总占用不超过 `attachmentMaxMB`（超了从最旧的继续删）。
   */
  attachmentGc: true,
  attachmentKeepCount: 60,
  attachmentKeepMinutes: 30,
  attachmentMaxMB: 600,
  attachmentSweepMin: 10,
  /**
   * 采集器脚本路径：**默认空 = 不采集，由用户自己填**。
   * 本插件不绑死任何一款游戏，事件文件/采集器/读取规则都由用户提供（见 gohFile）。
   */
  gohCollectorScript: '',
  /** python 解释器（留空用 PATH 里的 python） */
  gohCollectorPython: '',
  /** 传给采集器的参数 */
  gohCollectorArgs: ['--follow'],
  /**
   * **事件文件**（任何"一行一条 JSON"的日志都行，不限 goh）。
   * 默认空 = 未配置；`gameSource` 没选事件源时压根不会去读它。
   */
  gohFile: '',
  /** 每次刷新带多少条最近事件当上下文（0 = 不带） */
  gohRecentLines: 10,
  /** 哪些事件算"重要"（立刻反应）。支持 `kind/subkind`、`kind/*`、`kind` 三种写法 */
  gohImportant: [...DEFAULT_IMPORTANT_KINDS],
  /** 连续击杀达到这个数量也算重要事件（0 = 关闭该判定） */
  gohKillBurstCount: 3,
  /** 上面的"连续"指多少秒内 */
  gohKillBurstSec: 8,
  /** 重要事件立刻反应的冷却（秒）：避免一局里被事件刷屏打爆 API */
  /**
   * 重要事件反应的冷却（秒）。12 太急：实测日志里反应间隔中位数 13 秒，
   * 等于冷却一结束就又打一次模型。30 秒起步，设置页可调。
   */
  gohImmediateCooldownSec: 30,
  /** 事件反应**硬预算**：每 `gohReactionWindowSec` 秒最多 `gohReactionBudget` 次（超了只进上下文不打模型） */
  gohReactionBudget: 8,
  gohReactionWindowSec: 600,
  /**
   * 机制数据库来源：'' = 空（不带），'goh' = 地狱之门机制库。
   * 选 goh 后：**速查版一直带在系统提示词里**（静态文本，靠缓存几乎免费）；
   * 完整库不进上下文，改为模型按需调用 goh_mechanics 工具检索。
   * 两个文件路径默认空：机制库是用户自己的资料，插件不预置任何游戏的内容。
   */
  databaseSource: '',
  /** 速查版（常驻系统提示词；只放模型猜不到的机制） */
  mechanicsQuickFile: '',
  /** 完整机制库（按需检索，不进上下文） */
  mechanicsFile: '',
  /** 一次检索最多返回多少字符（防止把上下文塞爆） */
  mechanicsMaxChars: 6000,
  /** 同一次回答里最多允许几轮"查询→再答"（1 = 不允许查询） */
  mechanicsLookupRounds: 3,
  /**
   * **思考档位**（2026-10-21，主人要求"让它思考"）：
   * 空串 = 用 provider 默认；'off' = 明确关；其余（low/high/max…）= 具体档位。
   * 合法值由模型自己声明（`ctx.llm.resolveModelInfo().reasoning.efforts`），
   * 发请求前会比对一次，不在清单里就退回默认（否则 provider 会直接拒）。
   */
  modelThinking: '',
  /**
   * **对话时带不带画面**（2026-10-21）：
   *   'always'（默认）/ 'whenRunning'（暂停时不带）/ 'never'（从不带）。
   * 暂停只停定时观察；这条管的是"你说话时它要不要看屏幕"。
   */
  askCapture: 'always',
  /**
   * **接话上限**：说完一句后允许它"再调用自己接着说"几次。
   * 0 = 关闭；每次接话 = 一次额外的模型调用（花钱），所以默认只给 2 次。
   */
  chainMax: 2,
  /**
   * 表情包（配图）：像动画一样读**离线描述**，由模型自己挑一张。
   * 描述来源优先用现成的（原版包内 memes 表 / 抓取脚本写的台词表），缺的才动用视觉模型。
   */
  imageInPrompt: true,
  /** 一次提示词里最多列多少张（0 = 不限） */
  imageLimit: 0,
  /**
   * 鱼板网络：同一台机器上多只桌宠互相看见"最近说了什么"（协议见 FISH-BOARD.md）。
   * 自己的端口由 `gpwOrigin` 或默认 7341 决定，**绝不靠探测**（认错过一次，见 resolveGpwOrigin）。
   */
  fishBoard: true,
  /**
   * 发现对等体时探测的端口范围。
   * 留出余量（到 7360）：另一份副本现在在 7350，正好卡在原上界 —— 它再挪一次就找不到了。
   */
  fishBoardPorts: [
    7341, 7342, 7343, 7344, 7345, 7346, 7347, 7348, 7349, 7350,
    7351, 7352, 7353, 7354, 7355, 7356, 7357, 7358, 7359, 7360,
  ],
  /** 拉取间隔（毫秒） */
  fishBoardPollMs: 4000,
  /** 允许模型自己去梗鲸图库搜图（按需下载；关掉就只用本地已有的图） */
  memeSearch: true,
  /** 一次运行最多按需下载几张（防止模型把图库当无底洞；0 = 不限） */
  memeSearchMax: 20,
  /** 表情包用户目录的父目录（副本的用户根；抓来的图放它的 memes/ 下） */
  imagesUserRoot: '',
  /** 原版 dsh-pet 包目录（读它的 memes 素材与描述表）。留空则从 profile 的 node_modules 猜 */
  upstreamRoot: '',
  /** 把动画目录（离线生成的描述）带进提示词，让模型可以直接点名动画 */
  catalogInPrompt: true,
  /** 目录最多带多少条（0 = 不限；条目多时用它给提示词封顶） */
  catalogLimit: 0,
  captureTimeoutMs: 15000,
  modelTimeoutMs: 60000,
  /** 进提示词的最近往来条数 */
  memoryRecentTurns: 12,
  /**
   * 要不要把**系统条目**（游戏事件原文，`role:'system'`）带进上下文 / 压缩材料。
   * 关掉后：模型只看主人与宠物真正说过的话，事件流水不占记忆篇幅。
   */
  historyHideSystem: true,
  /** 允许模型在输出里用 `remember` 自己往长期记忆里记一条（默认开） */
  memoryAllowSelfNote: true,
  /**
   * **长期记忆的篇幅上限（字）**——主人嫌不够，从"模型随手写多少算多少"改成一个明确目标 ✓。
   * 同时每个会话有独立记忆（见 memoryFor），所以实际容量是"每个会话各一份" ✓。
   */
  memoryLongTermChars: 2400,
  /** 每个会话保留的来往条数上限（原来 400 是全局共用的 ✗→ 现在每个会话各 800 ✓） */
  memoryMaxEntries: 800,
  /** 攒够多少条新往来就重压一次长期记忆 */
  compactEvery: 10,
  compactSystem: DEFAULT_COMPACT_SYSTEM,
};

/** 画面里没有值得说的事时，模型应当输出的判定词 */
const SILENCE = 'SILENT';

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function normalizeConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = { ...DEFAULTS };
  /**
   * **兜底搬运**（写在显式校验之前）：
   *
   * 下面是一长串白名单式重建 —— 新加的配置键只要忘了在此处补一行，
   * 设置页/接口写进去的值就会被**静默丢掉**。
   * 这个 bug 真出过：`modelSource` 被丢掉 -> 插件永远回落到会话默认模型
   * -> 撞上一把失效的 key，而界面上看起来"配置已保存"（文件确实写了，只有内存被丢）。
   *
   * 规则：只搬 DEFAULTS 里存在、且类型对得上的键；显式校验在后面会覆盖它们。
   */
  for (const [key, value] of Object.entries(src)) {
    if (!(key in DEFAULTS)) continue;
    const def = DEFAULTS[key];
    if (Array.isArray(def)) {
      if (Array.isArray(value)) out[key] = value;
    } else if (typeof def === 'string') {
      if (typeof value === 'string') out[key] = value;
    } else if (typeof def === 'boolean') {
      if (typeof value === 'boolean') out[key] = value;
    } else if (typeof def === 'number') {
      if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
    } else if (def === undefined || def === null) {
      if (['string', 'number', 'boolean'].includes(typeof value)) out[key] = value;
    }
  }
  if (typeof src.enabled === 'boolean') out.enabled = src.enabled;
  for (const key of ['windowTitle', 'provider', 'model', 'petId', 'gpwOrigin']) {
    if (typeof src[key] === 'string') out[key] = src[key].trim();
  }
  for (const key of ['personality', 'rules', 'compactSystem']) {
    if (typeof src[key] === 'string' && src[key].trim()) out[key] = src[key].trim();
  }
  if (typeof src.pushToPet === 'boolean') out.pushToPet = src.pushToPet;
  if (src.petTarget === 'gpw' || src.petTarget === 'dsh-pet') out.petTarget = src.petTarget;
  if (typeof src.catalogInPrompt === 'boolean') out.catalogInPrompt = src.catalogInPrompt;
  if (typeof src.autoLaunchFork === 'boolean') out.autoLaunchFork = src.autoLaunchFork;
  if (typeof src.upstreamPetRoot === 'string' && src.upstreamPetRoot.trim()) out.upstreamPetRoot = src.upstreamPetRoot.trim();
  if (typeof src.gpwRoot === 'string' && src.gpwRoot.trim()) out.gpwRoot = src.gpwRoot.trim();
  if (typeof src.gameSource === 'string') out.gameSource = src.gameSource.trim();
  if (typeof src.databaseSource === 'string') out.databaseSource = src.databaseSource.trim();
  if (typeof src.mechanicsQuickFile === 'string' && src.mechanicsQuickFile.trim()) out.mechanicsQuickFile = src.mechanicsQuickFile.trim();
  if (typeof src.mechanicsFile === 'string' && src.mechanicsFile.trim()) out.mechanicsFile = src.mechanicsFile.trim();
  if (typeof src.imagesUserRoot === 'string' && src.imagesUserRoot.trim()) out.imagesUserRoot = src.imagesUserRoot.trim();
  if (typeof src.upstreamRoot === 'string' && src.upstreamRoot.trim()) out.upstreamRoot = src.upstreamRoot.trim();
  if (typeof src.imageInPrompt === 'boolean') out.imageInPrompt = src.imageInPrompt;
  if (typeof src.memeSearch === 'boolean') out.memeSearch = src.memeSearch;
  if (typeof src.dataDir === 'string') out.dataDir = src.dataDir.trim();
  if (typeof src.attachmentGc === 'boolean') out.attachmentGc = src.attachmentGc;
  out.attachmentKeepCount = clampInt(src.attachmentKeepCount, DEFAULTS.attachmentKeepCount, 1, 5000);
  out.attachmentKeepMinutes = clampInt(src.attachmentKeepMinutes, DEFAULTS.attachmentKeepMinutes, 1, 24 * 60);
  out.attachmentMaxMB = clampInt(src.attachmentMaxMB, DEFAULTS.attachmentMaxMB, 32, 100_000);
  out.attachmentSweepMin = clampInt(src.attachmentSweepMin, DEFAULTS.attachmentSweepMin, 1, 24 * 60);
  if (typeof src.onebotUrl === 'string') out.onebotUrl = src.onebotUrl.trim();
  if (typeof src.onebotToken === 'string') out.onebotToken = src.onebotToken.trim();
  if (Array.isArray(src.onebotGroups)) out.onebotGroups = src.onebotGroups.map(String).filter(Boolean);
  if (typeof src.onebotSendImage === 'boolean') out.onebotSendImage = src.onebotSendImage;
  if (typeof src.imageShrink === 'boolean') out.imageShrink = src.imageShrink;
  out.imageMaxDim = clampInt(src.imageMaxDim, DEFAULTS.imageMaxDim, 256, 4096);
  out.imageQuality = clampInt(src.imageQuality, DEFAULTS.imageQuality, 40, 100);
  out.onebotSelfPostMinMinutes = clampInt(src.onebotSelfPostMinMinutes, DEFAULTS.onebotSelfPostMinMinutes, 1, 24 * 60);
  out.onebotSelfPostActiveMin = clampInt(src.onebotSelfPostActiveMin, DEFAULTS.onebotSelfPostActiveMin, 1, 24 * 60);
  if (typeof src.qqKeepInteresting === 'boolean') out.qqKeepInteresting = src.qqKeepInteresting;
  out.qqKeepMax = clampInt(src.qqKeepMax, DEFAULTS.qqKeepMax, 0, 5000);
  if (typeof src.qqCollectImages === 'boolean') out.qqCollectImages = src.qqCollectImages;
  out.memeLibraryMax = clampInt(src.memeLibraryMax, DEFAULTS.memeLibraryMax, 10, 100_000);
  if (typeof src.memeEvictEnabled === 'boolean') out.memeEvictEnabled = src.memeEvictEnabled;
  if (typeof src.onebotContext === 'boolean') out.onebotContext = src.onebotContext;
  out.onebotContextCount = clampInt(src.onebotContextCount, DEFAULTS.onebotContextCount, 2, 100);
  out.onebotContextCacheSec = clampInt(src.onebotContextCacheSec, DEFAULTS.onebotContextCacheSec, 1, 600);
  out.onebotReplyCooldownSec = clampInt(src.onebotReplyCooldownSec, DEFAULTS.onebotReplyCooldownSec, 0, 3600);
  out.onebotGroupReadMinMinutes = clampInt(src.onebotGroupReadMinMinutes, DEFAULTS.onebotGroupReadMinMinutes, 1, 24 * 60);
  if (typeof src.collideCallModel === 'boolean') out.collideCallModel = src.collideCallModel;
  out.collideDetectMs = clampInt(src.collideDetectMs, DEFAULTS.collideDetectMs, 100, 5000);
  out.collidePadPx = clampInt(src.collidePadPx, DEFAULTS.collidePadPx, 0, 64);
  out.collidePushPx = clampInt(src.collidePushPx, DEFAULTS.collidePushPx, 1, 32);
  out.collideLineCooldownSec = clampInt(src.collideLineCooldownSec, DEFAULTS.collideLineCooldownSec, 5, 3600);
  if (typeof src.onebotRead === 'boolean') out.onebotRead = src.onebotRead;
  if (typeof src.petsEnabled === 'boolean') out.petsEnabled = src.petsEnabled;
  out.pets = Array.isArray(src.pets)
    ? src.pets
        .filter((f) => f && typeof f === 'object' && String(f.id ?? '').trim())
        .map((f) => ({
          id: String(f.id).trim(),
          name: String(f.name ?? '').trim(),
          origin: String(f.origin ?? '').trim().replace(/\/$/, ''),
          enabled: f.enabled !== false,
          scope: String(f.scope ?? f.id).trim() || String(f.id).trim(),
          qq: f.qq === true,
          /** 独立用户目录用的 profile 名 ✓（空 = 默认那只 ✓；保活按它起进程 ✓） */
          profile: String(f.profile ?? '').trim(),
          /**
           * **每条鱼自己的随机时间波动**（±秒）：观察间隔 = intervalSec × 退避 ± jitterSec。
           * 0 = 固定节奏；不写就用 FISH_JITTER_DEFAULT_SEC。
           * 白名单式重建 —— 不在这里列出来，面板存了也会被静默丢掉。
           */
          jitterSec: clampInt(f.jitterSec, FISH_JITTER_DEFAULT_SEC, 0, 300),
          /**
           * **QQ 号绑定**（按鱼 ✓）：
           *   qqAccount   = 这条鱼用的 QQ 号（自己的 ✓）
           *   onebotUrl / onebotToken = 那个号对应的 OneBot 端点（NapCat 一号一端点 ✓）
           * 留空 = 用全局的 onebotUrl/Token ✓（兼容单号用法 ✓）。
           * ⚠️ 必须在 normalizeConfig 里显式列出来 ✓ —— 它是白名单式重建 ✗，
           * 漏一个键就会"设置页存了、内存里没了" ✗（`by`、`modelSource` 都在这栽过 ✓）。
           */
          qqAccount: String(f.qqAccount ?? '').trim(),
          onebotUrl: String(f.onebotUrl ?? '').trim(),
          onebotToken: String(f.onebotToken ?? '').trim(),
          personality: typeof f.personality === 'string' ? f.personality : undefined,
          rules: typeof f.rules === 'string' ? f.rules : undefined,
          /**
           * **这条鱼自己的长期记忆压缩说明**（留空 = 用全局 `compactSystem`）。
           *
           * 为什么要有：压缩提示词以前只有全局一份 → 两条鱼的长期记忆用同一段"要求"总结，
           * 只有人设不同 → 总结出来的口吻/视角趋同（主人提过）。人设、开口规则早就按鱼了，
           * 这块是漏的那一个，现在补上；不写就还是全局那份，单鱼用户行为不变。
           */
          compactSystem: typeof f.compactSystem === 'string' ? f.compactSystem : undefined,
        }))
    : [];
  if (typeof src.captureLastRequest === 'boolean') out.captureLastRequest = src.captureLastRequest;
  out.onebotImageCooldownSec = clampInt(src.onebotImageCooldownSec, DEFAULTS.onebotImageCooldownSec, 0, 24 * 3600);
  out.imageNoRepeatCount = clampInt(src.imageNoRepeatCount, DEFAULTS.imageNoRepeatCount, 0, 200);
  if (typeof src.onebotReply === 'boolean') out.onebotReply = src.onebotReply;
  out.onebotMaxCallsPerMinute = clampInt(src.onebotMaxCallsPerMinute, DEFAULTS.onebotMaxCallsPerMinute, 1, 120);
  if (typeof src.ownerQq === 'string' || typeof src.ownerQq === 'number') out.ownerQq = String(src.ownerQq).trim();
  if (typeof src.onebotImageSeparate === 'boolean') out.onebotImageSeparate = src.onebotImageSeparate;
  out.onebotImageDelayMs = clampInt(src.onebotImageDelayMs, DEFAULTS.onebotImageDelayMs, 0, 10_000);
  if (['off', 'group', 'private', 'all'].includes(src.onebotMemoryFrom)) out.onebotMemoryFrom = src.onebotMemoryFrom;
  if (['off', 'reply', 'always'].includes(src.onebotSendTo)) out.onebotSendTo = src.onebotSendTo;
  if (typeof src.onebotReadImages === 'boolean') out.onebotReadImages = src.onebotReadImages;
  if (typeof src.onebotMentionOnly === 'boolean') out.onebotMentionOnly = src.onebotMentionOnly;
  if (Array.isArray(src.onebotAllowFrom)) out.onebotAllowFrom = src.onebotAllowFrom.map(String).filter(Boolean);
  if (typeof src.gohCollector === 'boolean') out.gohCollector = src.gohCollector;
  if (typeof src.gohCollectorScript === 'string' && src.gohCollectorScript.trim()) {
    out.gohCollectorScript = src.gohCollectorScript.trim();
  }
  if (typeof src.gohCollectorPython === 'string') out.gohCollectorPython = src.gohCollectorPython.trim();
  if (Array.isArray(src.gohCollectorArgs)) out.gohCollectorArgs = src.gohCollectorArgs.map(String);
  if (typeof src.fishBoard === 'boolean') out.fishBoard = src.fishBoard;
  if (Array.isArray(src.fishBoardPorts)) out.fishBoardPorts = src.fishBoardPorts.map(Number).filter(Number.isFinite);
  if (Number.isFinite(Number(src.fishBoardPollMs))) out.fishBoardPollMs = Number(src.fishBoardPollMs);
  if (Number.isFinite(Number(src.memeSearchMax))) out.memeSearchMax = Number(src.memeSearchMax);
  if (Number.isFinite(Number(src.imageLimit))) out.imageLimit = Number(src.imageLimit);
  for (const k of ['mechanicsMaxChars', 'mechanicsLookupRounds']) {
    if (Number.isFinite(Number(src[k]))) out[k] = Number(src[k]);
  }
  if (typeof src.gohFile === 'string' && src.gohFile.trim()) out.gohFile = src.gohFile.trim();
  if (Array.isArray(src.gohImportant)) out.gohImportant = src.gohImportant.map((x) => String(x));
  for (const k of ['gohRecentLines', 'gohKillBurstCount', 'gohKillBurstSec', 'gohImmediateCooldownSec']) {
    if (Number.isFinite(Number(src[k]))) out[k] = Number(src[k]);
  }
  out.catalogLimit = clampInt(src.catalogLimit, DEFAULTS.catalogLimit, 0, 500);
  out.idleAfterSec = clampInt(src.idleAfterSec, DEFAULTS.idleAfterSec, 0, 3600);
  if (typeof src.idleOnNoEvents === 'boolean') out.idleOnNoEvents = src.idleOnNoEvents;
  out.idleMaxFactor = clampInt(src.idleMaxFactor, DEFAULTS.idleMaxFactor, 0, 64);
  out.idleStepSec = clampInt(src.idleStepSec, DEFAULTS.idleStepSec, 5, 3600);
  if (typeof src.keepShots === 'boolean') out.keepShots = src.keepShots ? DEFAULTS.keepShots : 0;
  out.intervalSec = clampInt(src.intervalSec, DEFAULTS.intervalSec, 5, 3600);
  /** 插件端口：0 = 自动探测；设了就按它（超范围夹回去，别让 70000 这种值把地址写坏） */
  out.pluginPort = clampInt(src.pluginPort, DEFAULTS.pluginPort, 0, 65535);
  out.maxWidth = clampInt(src.maxWidth, DEFAULTS.maxWidth, 320, 3840);
  out.cooldownSec = clampInt(src.cooldownSec, DEFAULTS.cooldownSec, 0, 3600);
  out.maxChars = clampInt(src.maxChars, DEFAULTS.maxChars, 8, 300);
  out.keepShots = clampInt(src.keepShots, DEFAULTS.keepShots, 0, 50);
  out.captureTimeoutMs = clampInt(src.captureTimeoutMs, DEFAULTS.captureTimeoutMs, 3000, 120000);
  out.modelTimeoutMs = clampInt(src.modelTimeoutMs, DEFAULTS.modelTimeoutMs, 5000, 300000);
  out.memoryRecentTurns = clampInt(src.memoryRecentTurns, DEFAULTS.memoryRecentTurns, 0, 60);
  out.memoryLongTermChars = clampInt(src.memoryLongTermChars, DEFAULTS.memoryLongTermChars, 200, 20_000);
  out.memoryMaxEntries = clampInt(src.memoryMaxEntries, DEFAULTS.memoryMaxEntries, 50, 5000);
  out.compactEvery = clampInt(src.compactEvery, DEFAULTS.compactEvery, 0, 200);
  /**
   * 思考档位：只认字符串；空串 = provider 默认。
   * 具体值是否被支持由 `reasoningEffortsFor()` 在发请求前比对，这里只做形状校验。
   */
  out.modelThinking = typeof src.modelThinking === 'string' ? src.modelThinking.trim().slice(0, 24) : DEFAULTS.modelThinking;
  /** 接话上限：0 = 关；上限 8（再多就纯烧钱，而且台词会刷屏） */
  out.chainMax = clampInt(src.chainMax, DEFAULTS.chainMax, 0, 8);
  out.askCapture = ['always', 'whenRunning', 'never'].includes(src.askCapture)
    ? src.askCapture
    : DEFAULTS.askCapture;
  return out;
}

/** 模型输出无法解析成台词时的兜底判定 */
function looksSilent(text) {
  const t = String(text ?? '').trim();
  if (!t) return true;
  return /^(SILENT|silent|无|无需|不用|不说|没有值得)/.test(t);
}

/**
 * 解析模型输出：优先按 `{"say":...,"anim":...}` 读，读不出来就退回"整行当台词"。
 * 双格式是刻意的：JSON 解析失败时行为与改动前完全一致，不会因为格式漂移而不说话。
 */
/**
 * 组装这一轮的**用户消息**（看画面 + 上下文 + 指令）。
 *
 * 抽成导出的纯函数是为了能测 —— 这段拼接曾经"改了但没接上"：
 * `boardBlock` 算出来了却没拼进 question，鱼板网络于是**静默失效**（鱼看不见别只鱼说的话），
 * 而代码一眼看过去是对的（变量就在上面两行）。有测试盯着才不会再来一次。
 *
 * 上下文顺序：游戏事件在前（"正在发生什么"），鱼板在后（"谁刚说了什么"）。
 * 两者都必须放在**用户消息**里：系统提示词是缓存前缀，塞每轮都变的内容会把缓存打废。
 */
/**
 * 宠物自己的身份行（有名字才生成）。
 *
 * 为什么需要：名字只出现在鱼板块头是不够的 —— 它得知道"我叫什么"，
 * 才能自我介绍、才能在别只鱼叫它时认得出自己。名字改了这行就跟着改
 * （系统提示词里只有这一小段会随名字变，缓存代价是一次而已）。
 */
export function selfIdentityLine(name) {
  const clean = String(name ?? '').trim();
  return clean ? `你的名字是「${clean}」。主人和别的宠物都这么叫你。` : '';
}

/**
 * 解析主人消息里的**目标**。
 *
 * 约定：默认是**广播**（`to:'*'`，两只宠物都收到 —— 这是用户要的"两边都能收到"）；
 * 想只对某只说就写 `@名字 内容`（也认 `@名字：内容`），前缀会被去掉。
 *
 * 为什么需要：主人打字时只有"那一只"的插件会收到 `/ask`，另一只收不到。
 * 我们靠"把主人的话写进副本的共享记录"来广播；而**目标**必须一起带上，
 * 否则两只宠物会抢着回答同一句话。
 *
 * @returns {{text:string, to:string}} `to` = `'*'`（全体）或宠物名字
 */
export function parseMasterTarget(text, selfName = '') {
  const raw = String(text ?? '').trim();
  if (!raw) return { text: '', to: '*' };
  const match = raw.match(/^@\s*([^\s：:]{1,24})\s*[：:]?\s*([\s\S]*)$/);
  if (match && match[2] && match[2].trim()) {
    const target = match[1].trim();
    // `@全体` / `@all` 也当广播，省得记两种写法
    const to = target === '全体' || target.toLowerCase() === 'all' ? '*' : target;
    return { text: match[2].trim(), to };
  }
  return { text: raw, to: '*' };
}

export function composeQuestion({ operatorText, gameBlock = '', boardBlock = '', masterTo = '', selfName = '' } = {}) {
  const nl = String.fromCharCode(10);
  const context = [gameBlock, boardBlock].filter(Boolean).join(nl);
  const head = context ? context + nl : '';
  /**
   * 主人那句话说给谁听 —— 决定措辞。
   * 广播或点名自己 → "对你说"；点名别人 → 明说"这句是对 X 说的"，让它可以不接。
   * （不这么写的话，两只宠物会把同一句话都当成对自己说的，抢答。）
   */
  const forMe = !masterTo || masterTo === '*' || !selfName || masterTo === selfName;
  const opening = !operatorText
    ? ''
    : forMe
      ? `主人刚刚对你说：「${operatorText}」`
      : `主人刚刚对「${masterTo}」说：「${operatorText}」（不是对你说的，你可以选择接或不接）`;
  const ask = operatorText
    ? opening + nl + head + '看他现在的游戏画面，直接回他一句。'
    : head + '看这张画面，判断要不要说话。';
  return ask;
}

/**
 * 空闲退避的倍数计算（纯函数，便于测试）。
 *
 * 两个空闲判据取**更闲**的那个：
 *   ① `inputIdleSec`：键鼠多久没动（人离开电脑）
 *   ② `eventIdleSec`：游戏里多久没有新事件（人在电脑前但什么都没发生）
 *
 * 为什么要有 ②：只看 ① 时，一边动鼠标一边打、游戏里 15 分钟没事件，
 * 它仍旧每 20 秒截帧问一次模型（实测 15 分钟 0 事件、30 次调用，全是白花的钱）。
 *
 * 退避是**几何增长**（2 的幂），`idleStepSec` 每过一档翻一倍，上限 `maxFactor`。
 * 注意：这只延长"旁观"的间隔；重要事件走独立路径，不受影响。
 *
 * @returns {{backoff:number, idleSec:number, reason:'disabled'|'active'|'input-idle'|'no-events'}}
 */
export function computeBackoff(options = {}) {
  const { inputIdleSec = 0, eventIdleSec = 0, idleAfterSec = 0, idleStepSec = 30, maxFactor = 1 } = options;
  if (!maxFactor || maxFactor <= 1 || !idleAfterSec) {
    return { backoff: 1, idleSec: Math.max(inputIdleSec, eventIdleSec), reason: 'disabled' };
  }
  const idleSec = Math.max(inputIdleSec, eventIdleSec);
  if (idleSec < idleAfterSec) return { backoff: 1, idleSec, reason: 'active' };
  const steps = Math.floor((idleSec - idleAfterSec) / Math.max(1, idleStepSec)) + 1;
  return {
    backoff: Math.min(maxFactor, Math.pow(2, Math.max(0, steps - 1))),
    idleSec,
    reason: eventIdleSec > inputIdleSec ? 'no-events' : 'input-idle',
  };
}

/**
 * 插件自己的地址：设置里写了端口就用它，否则用探测到的那个。
 *
 * 抽成纯函数是为了能测（这台机器上端口已经换过四次，写死/猜错都能让整条碰撞链路静默失效）。
 */
export function pluginOriginOf({ configuredPort = 0, learned = '' } = {}) {
  const port = Number(configuredPort) || 0;
  if (port > 0) return 'http://127.0.0.1:' + port;
  return String(learned || '').replace(/\/+$/, '');
}

/**
 * **鱼板公共登记簿**（`~/.dsh/fish-board/registry.json`）的内容。
 *
 * 为什么要有这个文件：插件地址 + 鱼表原来只分别活在"每一边自己的配置/日志/启动环境"里，
 * 谁想回连插件只能自己猜（写死端口 / 读 env / netstat 探测 —— 三条都各自踩过坑）。
 * 现在由**唯一知道真相的一方（插件）**写一份到公共位置，任何副本、任何仓库、任何脚本
 * 都读同一份，不用再各猜一套：
 *
 *   { protocol, pluginOrigin, updatedAt, fish: [{ id, name, origin, scope, port, enabled }] }
 *
 * 纯函数（不碰 IO），所以能测；写盘在 `publishRegistry()` 里。
 */
export function buildFishBoardRegistry({ config, origin, now = Date.now() } = {}) {
  const pets = Array.isArray(config?.pets) ? config.pets : [];
  return {
    protocol: 'fish-board/3',
    pluginOrigin: String(origin || '').replace(/\/+$/, ''),
    updatedAt: now,
    fish: pets
      .filter((f) => f && String(f.id ?? '').trim())
      .map((f) => {
        const fishOrigin = String(f.origin ?? '').trim().replace(/\/+$/, '');
        const port = Number(/:(\d+)$/.exec(fishOrigin)?.[1] || 0);
        return {
          id: String(f.id).trim(),
          name: String(f.name ?? '').trim(),
          origin: fishOrigin,
          scope: String(f.scope ?? f.id).trim() || String(f.id).trim(),
          port,
          enabled: f.enabled !== false,
        };
      }),
  };
}

/**
 * **桌面宠物副本目录**（`dsh-pet-gpw` 那个仓库）。
 *
 * 以前默认值写死 `G:/goh agent/dsh-pet-gpw` —— 换台机器第一次安装，保活只会报
 * "缺副本入口"，用户也不知道该去哪改。现在默认空，按"插件旁边的兄弟仓库"推：
 *   ① 配置 `gpwRoot`
 *   ② `<插件目录>/../dsh-pet-gpw`（本机这两个仓库就是并排的）
 *   ③ `<DSH_HOME>/dsh-pet-gpw`
 */
export function resolveGpwRoot({ configured = '', packageDir = '', dshHome = '', fsExists = () => false } = {}) {
  const own = String(configured || '').trim();
  if (own) return own;
  const candidates = [];
  /**
   * ① **包里自带的 `pet/`**（单包即插即用：装上插件就能跑，不需要第二个仓库/目录）
   * ② 开发时的兄弟仓库（两个仓库并排）
   * ③ DSH 家目录下的旧安装
   */
  if (packageDir) candidates.push(join(packageDir, 'pet'));
  if (packageDir) candidates.push(join(dirname(packageDir), 'dsh-pet-gpw'));
  if (dshHome) candidates.push(join(dshHome, 'dsh-pet-gpw'));
  return candidates.find((dir) => fsExists(join(dir, 'runtime', 'gpw-main.cjs'))) || candidates[0] || '';
}

/**
 * **动画素材目录**（副本按 `<这里>/assets/config.jsonc` + `<这里>/assets/webm/*` 读）。
 *
 * 为什么不能写死默认值：以前 `DEFAULTS.upstreamPetRoot` 是 `C:/Users/Kishin/.../dsh-pet` ——
 * 换了机器/用户名，默认值指向一个不存在的目录 → 第一次安装时副本起不来（保活报
 * "找不到原版 dsh-pet 素材目录"）。现在默认空，运行时按顺序推：
 *   ① 配置里写了就用配置
 *   ② **副本仓库自带的 `assets/`**（`dsh-pet-gpw/assets/config.jsonc` 在 → 用副本自己那份，
 *      即"素材已从 dsh-pet 独立"的情况；把 dsh-pet/assets 复制进仓库即生效，代码不用改）
 *   ③ `<DSH_HOME>/profiles/<当前 profile>/node_modules/dsh-pet`（借原版素材）
 *   ④ 挨个 profile 找一遍（用户可能不在 desktop 上）
 */
export function resolveUpstreamPetRoot({
  configured = '',
  dshHome = '',
  profile = '',
  petRoot = '',
  fsExists = () => false,
} = {}) {
  const own = String(configured || '').trim();
  if (own) return own;
  const pet = String(petRoot || '').trim();
  if (pet && fsExists(join(pet, 'assets', 'config.jsonc'))) return pet; // 自带素材
  const home = String(dshHome || '').trim();
  if (!home) return '';
  const prefer = String(profile || process.env.DSH_PROFILE || 'desktop').trim() || 'desktop';
  const direct = join(home, 'profiles', prefer, 'node_modules', 'dsh-pet');
  if (fsExists(direct)) return direct;
  try {
    for (const name of readdirSync(join(home, 'profiles'))) {
      const candidate = join(home, 'profiles', name, 'node_modules', 'dsh-pet');
      if (fsExists(candidate)) return candidate;
    }
  } catch {
    /* 没有 profiles 目录就返回下面那个"最可能"的路径，让调用方报清楚的错 */
  }
  return direct;
}

/** 这条鱼压缩长期记忆时用的**压缩说明**：鱼自己的优先，没写就用全局那份。
 *
 * 抽出来是为了能测，也为了把所有"按鱼覆盖"的取值集中在一个地方
 * （人设/开口规则在 `compactMemory()` 里同样先取鱼的）。
 */
export function compactSystemFor(config, fish = null) {
  const own = typeof fish?.compactSystem === 'string' ? fish.compactSystem.trim() : '';
  return own || String(config?.compactSystem ?? '').trim();
}

/**
 * 这条鱼**下一次**观察/说话的等待时间（毫秒）= 基础间隔 × 退避 + 随机波动。
 *
 * 为什么要有它：两条鱼共用一个 tick，间隔又是一样的 → **同一秒一起问模型**
 * （同一帧、同一时刻、两个请求并排打出去），节奏像机器人，也容易同时撞上额度。
 * 每条鱼各自 ±jitterSec 的抖动把节奏错开，这就是"每条鱼自己的时间感"。
 *
 * 随机源可注入（测试要确定性）；`minMs` 兜底，别让波动把间隔压到 0（那会变成死循环打模型）。
 */
export function computeFishDelayMs({ baseMs, jitterSec = 0, rand = Math.random, minMs = 5000 } = {}) {
  const base = Math.max(minMs, Number(baseMs) || 0);
  const jitter = Math.max(0, Math.min(300, Number(jitterSec) || 0)) * 1000;
  if (!jitter) return base;
  const r = Math.max(0, Math.min(1, Number(rand()) || 0));
  return Math.max(minMs, Math.round(base + (r * 2 - 1) * jitter));
}

export function parseDecision(raw, maxChars) {
  const text = String(raw ?? '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      const obj = JSON.parse(text.slice(start, end + 1));
      const say = normalizePhrase(obj?.say ?? obj?.text ?? '', maxChars);
      const anim = typeof obj?.anim === 'string' ? obj.anim.trim() : '';
      const img = typeof obj?.img === 'string' ? obj.img.trim() : '';
      /**
       * **模型自己要记的事**（可选）：`remember`（也认 `note`）。
       * 只取一句、限长；写不写由 `memoryAllowSelfNote` 决定（在调用点判断）。
       */
      const rawRemember = typeof obj?.remember === 'string' ? obj.remember : typeof obj?.note === 'string' ? obj.note : '';
      const remember = rawRemember.replace(/\s+/g, ' ').trim().slice(0, 200) || undefined;
      /**
       * `toGroup`：**让它自己决定这句话要不要发到群里**（主人要的语义）。
       * 兼容几种写法（模型不一定听话），非 true 一律当不发 —— 宁可少发，不能刷屏。
       */
      const toGroup = obj?.toGroup === true || obj?.toGroup === 'true' || obj?.postGroup === true;
      /**
       * **粗体 / 字号**（2026-10-23）：给气泡加点层次，可选、不填就是普通样式。
       *   bold: true
       *   size: s | m | l | xl
       */
      const bold = obj?.bold === true || obj?.bold === 'true';
      const sizeRaw = typeof obj?.size === 'string' ? obj.size.trim().toLowerCase() : '';
      const size = ['s', 'm', 'l', 'xl'].includes(sizeRaw) ? sizeRaw : undefined;
      const style = { ...(bold ? { bold: true } : {}), ...(size ? { size } : {}) };
      if (say) return { phrase: say, anim: anim || undefined, img: img || undefined, toGroup, remember, style, format: 'json' };
      // 是个像样的 JSON 对象但没有可说的内容（{} / {"say":""} / {"silent":true}）→ 就是不说话，
      // 绝不能退回纯文本，否则会把 "{}" 这种垃圾当台词发出去
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        return { phrase: undefined, anim: anim || undefined, img: img || undefined, remember, format: 'json' };
      }
    } catch {
      /* 落到纯文本 */
    }
  }
  return { phrase: normalizePhrase(text, maxChars), format: 'text' };
}

/** 把模型输出收拾成一句可以直接放进气泡的话；返回 undefined 表示这次不说话 */
function normalizePhrase(text, maxChars) {
  let t = String(text ?? '').trim();
  if (!t) return undefined;
  t = t.split(/\r?\n/)[0].trim();
  t = t.replace(/^["'“”「『]+/, '').replace(/["'“”」』]+$/, '').trim();
  t = t.replace(/^(道具|提示|台词|对白|宠物|我)\s*[:：]\s*/, '').trim();
  if (!t || looksSilent(t)) return undefined;
  if (t.length > maxChars) t = t.slice(0, maxChars).trim();
  return t || undefined;
}

/**
 * 插件入口。
 *
 * ⚠️ **整个初始化包在 try/catch 里**：DSH 插件在加载期抛错会让**宿主整个起不来**
 * （用户看到"应用无法启动或已意外停止"），而不是只坏这一个插件 —— 这个坑踩过两次
 * （一次是引用了不存在的常量名，一次是 patch 文件被写坏）。
 * 所以这里约定：**宁可这个插件不工作，也绝不拖死 DSH**。
 * 初始化失败时记一条日志就返回，DSH 照常启动，其它插件不受影响。
 */
export function apply(ctx, rawConfig) {
  /**
   * 最近日志环形缓冲（40 条）。
   *
   * 为什么加：排"QQ 发图失败"这类问题时，最需要的就是**插件自己那几行日志**
   * （`QQ 读图完成：…` / 报错原文），而它们只进了 DSH 控制台 ✗ → 我从 `/state` 看不到，
   * 只能靠猜（这次就是靠计数器+时间戳反推出来的 ✗）。现在 `/state.logRing` 直接可读。
   */
  const logRing = [];
  /**
   * **日志也写文件**（`<数据目录>/plugin.log`，2MB 轮转到 `.1`）。
   *
   * 为什么必须落盘（今天排障最痛的一点 ✗）：插件的日志原来只进
   * ①内存环形缓冲（25 条，重启就没 ✓）②DSH 控制台（`~/.dsh/electron/debug.log` 里**没有** ✗，
   * 只在应用自己的终端/devtools 里 ✓）→ 事后想问"半小时前发生了什么"**查不到** ✓。
   */
  let logWrites = 0;
  const log = (message) => {
    try {
      logRing.push({ at: Date.now(), text: String(message).slice(0, 300) });
      if (logRing.length > 40) logRing.splice(0, logRing.length - 40);
    } catch {
      /* 环形缓冲出错无所谓 */
    }
    try {
      /**
       * 路径挂在函数上（见 applyInner 里的 `log.file = …`）——
       * `apply` 与 `applyInner` 是两个作用域，用局部变量会 ReferenceError ✗→✓。
       */
      if (!log.file) return; // dataDir 还没解析出来时先不写 ✓
      const line = `${new Date().toISOString()} ${message}\n`;
      appendFileSync(log.file, line, 'utf8');
      logWrites += 1;
      // 每 200 行查一次大小（不是每行都 stat，省 IO ✓）
      if (logWrites % 200 === 0) {
        try {
          if (statSync(log.file).size > 2 * 1024 * 1024) {
            renameSync(log.file, `${log.file}.1`);
          }
        } catch {
          /* 轮转失败不影响写 */
        }
      }
    } catch {
      /* 落盘失败不能拖垮主流程 ✓ */
    }
    try {
      ctx.logger?.info?.('[game-pet-watch] ' + message);
    } catch {
      /* 日志不可用不影响主流程 */
    }
  };
  /**
   * 把环形缓冲**挂在 log 函数上**带进 `applyInner`。
   *
   * 为什么不加参数：插件主体在 `applyInner(ctx, rawConfig, log)` 里，状态对象也在那边 ——
   * 第一版我直接在 `apply` 里声明 `logRing`，于是 `/state` 报 `logRing is not defined` ✗
   * （**自检抓到了** ✓，没让它带着这个错去重启）。
   */
  log.ring = logRing;

/**
 * 当前版本号：从仓库里**最高的 `index-x.y.z.js`** 取。
 * 不能读 `import.meta.url`（加载器直接 import index.js，文件名永远是 index.js ✗），
 * 也不能读 package.json（那里的 version 停在 0.2.0，bump 脚本不更新它 ✗）。
 */
const PLUGIN_VERSION = (() => {
  try {
    const vs = readdirSync(PACKAGE_DIR)
      .map((f) => f.match(/^index-(\d+)\.(\d+)\.(\d+)\.js$/))
      .filter(Boolean)
      .map((m) => ({ text: `${m[1]}.${m[2]}.${m[3]}`, num: [Number(m[1]), Number(m[2]), Number(m[3])] }))
      .sort((a, b) => (b.num[0] - a.num[0]) || (b.num[1] - a.num[1]) || (b.num[2] - a.num[2]));
    return vs[0]?.text ?? 'index.js';
  } catch {
    return 'index.js';
  }
})();
  /** 版本挂在 log 上带进 applyInner（同 logRing：状态对象在那边，直接引用会 TDZ/未定义 ✗） */
  log.version = PLUGIN_VERSION;
  try {
    return applyInner(ctx, rawConfig, log);
  } catch (error) {
    const detail = error && error.stack ? error.stack : String(error);
    log('插件初始化失败，已放弃本次加载（DSH 不受影响）：' + detail);
    try {
      // 注意：ESM 里没有 require，必须用顶部 import 进来的函数（这里踩过一次，异常被吞掉、日志写不出来）
      appendFileSync(
        join(tmpdir(), 'gpw-plugin-load-error.log'),
        new Date().toISOString() + ' ' + detail + String.fromCharCode(10),
      );
    } catch {
      /* 日志写不了也无所谓 */
    }
    return undefined;
  }
}

function applyInner(ctx, rawConfig, log) {

  /**
   * ⚠️ 这里**不要**再算"插件自己的包根"去当副本目录用。踩过的坑：
   *   1. 直接引用别的模块里的常量名（PACKAGE_ROOT）→ 插件加载时 ReferenceError，
   *      结果是 **DSH 整个起不来**（"应用无法启动或已意外停止"）。DSH 插件抛错会拖着宿主一起死。
   *   2. 用"插件目录"当副本目录 → 副本是另一个仓库，这里永远找不到 runtime/gpw-main.cjs。
   * 副本目录走配置项 `gpwRoot`（见 DEFAULTS）。
   */

  let config = normalizeConfig(rawConfig);
  /** 最近一次模型调用的真实用量（来自 stream 的 usage chunk），按"带图/不带图"各记一条 */
  let lastUsage;
  let lastTextUsage;
  /** 最近**任意**一次调用的用量（/ask 返回它：以前返回 lastUsage，结果无图那次会返回上一次带图的旧账） */
  let lastAnyUsage;
  const dshHome =
    process.env.DSH_HOME && process.env.DSH_HOME.trim()
      ? process.env.DSH_HOME.trim()
      : join(process.env.USERPROFILE ?? process.cwd(), '.dsh');

  /**
   * **数据目录**：一处决定，所有状态文件跟着走。
   * 之前每个路径各写一遍 `join(dshHome,'game-pet-watch',…)`，想搬位置得改六处、还容易漏。
   */
  const dataDir = (() => {
    const raw = String(config.dataDir ?? '').trim();
    if (!raw) return join(dshHome, 'game-pet-watch');
    // `~/xxx` 展开成用户主目录（Windows 上也有 `~\xxx` 的写法）
    const winTilde = '~' + String.fromCharCode(92);
    const expanded = raw.startsWith('~/') || raw.startsWith(winTilde) ? join(homedir(), raw.slice(2)) : raw;
    // 末尾的斜杠去掉，免得拼出双斜杠（日志里看着别扭）
    return expanded.replace(/[/\\]+$/, '');
  })();
  if (dataDir !== join(dshHome, 'game-pet-watch')) log(`数据目录已改为：${dataDir}`);

  /**
   * 记录占用报告（用户问"记录有多大、位置能不能管"）。
   *
   * 目的有两个：
   *   ① 一眼看出谁在长（实测：采集器的 `events.jsonl` 是唯一无上限的那个，
   *      历史落盘 `history.jsonl` 自己有 8MB 轮转，`memory.json` 稳定在百 KB 级）
   *   ② 搬迁/清理前先看清单，知道哪些能删（prompt-backups、.1 轮转备份都是可删的）
   */
  function storageReport() {
    const names = [
      'history.jsonl',
      'history.jsonl.1',
      'memory.json',
      'catalog.json',
      'image-catalog.json',
      'gallery-index.json',
      'goh-state.json',
    ];
    const files = [];
    for (const name of names) {
      try {
        files.push({ name, bytes: statSync(join(dataDir, name)).size });
      } catch {
        /* 不存在就不列 */
      }
    }
    // 目录类：提示词备份（人工删安全）
    try {
      let bytes = 0;
      let count = 0;
      for (const entry of readdirSync(promptBackupsDir)) {
        try {
          bytes += statSync(join(promptBackupsDir, entry)).size;
          count += 1;
        } catch {
          /* 忽略 */
        }
      }
      if (count) files.push({ name: 'prompt-backups/', bytes, count, deletable: true });
    } catch {
      /* 目录不存在 */
    }
    // 事件文件（采集器写的，**在数据目录之外**）
    let eventFile = null;
    try {
      eventFile = { path: config.gohFile, bytes: statSync(config.gohFile).size };
    } catch {
      eventFile = { path: config.gohFile, bytes: null };
    }
    /**
     * DSH 的附件仓库（`$DSH_HOME/attachments`）—— 我们每轮裁决都往里写一张截图
     * （`ctx.attachments.saveImage`）。
     *
     * **它不归插件管、DSH 也没给删除接口**（扒过核心包，只暴露 `saveImage`），所以这里
     * 只做统计 + 告警：让"截图在偷偷长"在界面上可见，而不是等盘满了才发现
     * （OpenCode 那边就是长到 639MB 才看见，我这边实测已 1.7GB）。
     */
    let attachments = null;
    try {
      const root = join(dshHome, 'attachments');
      let bytes = 0;
      let count = 0;
      const walk = (dir) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const full = join(dir, entry.name);
          if (entry.isDirectory()) walk(full);
          else {
            try {
              bytes += statSync(full).size;
              count += 1;
            } catch {
              /* 单个文件读不到就跳过 */
            }
          }
        }
      };
      walk(root);
      attachments = {
        dir: root,
        bytes,
        count,
        note: '每轮裁决一张截图；DSH 未提供删除接口 —— 插件自己记账并自动回收',
        gc: attachmentGc ? attachmentGc.stats() : null,
      };
    } catch {
      attachments = null;
    }
    const totalBytes =
      files.reduce((sum, f) => sum + f.bytes, 0) + (eventFile.bytes ?? 0) + (attachments?.bytes ?? 0);
    return {
      dir: dataDir,
      defaultDir: join(dshHome, 'game-pet-watch'),
      custom: dataDir !== join(dshHome, 'game-pet-watch'),
      files,
      eventFile,
      attachments,
      totalBytes,
    };
  }
  /**
   * 记忆实例：**local 用原来的 memory.json**（保住已有历史 ✓），
   * QQ 的每个会话各用一个 `memory-<scope>.json` ✓。
   *
   * 为什么要按会话分开（主人的要求）：群聊是各自独立的上下文 ——
   * A 群聊的游戏、B 群聊的论文、私聊的事，全塞进同一条长期记忆时，
   * ① 互相挤占（上限一到就把别处的压掉 ✗）② 模型容易张冠李戴 ✗。
   * 分开之后每个会话都有自己的 400+ 条来往与自己的长期要点 ✓。
   */
  const memoryScopes = new Map();
  function memoryFor(scope) {
    const key = String(scope ?? 'local') || 'local';
    if (!memoryScopes.has(key)) {
      const file = key === 'local'
        ? memoryFilePath(dataDir)
        : join(dataDir, 'memory-' + key.replace(/[^\w.-]+/g, '_') + '.json');
      memoryScopes.set(key, new MemoryStore(file, log));
    }
    return memoryScopes.get(key);
  }
  const memory = memoryFor('local');
  const capture = new CaptureEngine({ dshHome, log });

  /**
   * 提示词自动快照：每次 DSH 启动时，把当前生效的提示词存一份带时间戳的副本。
   *
   * 为什么需要（用户报过"提示词重启后就没了"）：提示词存在 profile 的 `cordis.patch.yml` 里，
   * 那份文件会被**很多**东西改写 —— 本插件的写回、手工编辑、以及任何"按备份恢复配置"的操作
   * （我自己就因为崩溃后从备份恢复，把 game-pet-watch 那一行覆盖成了旧版）。
   * 只要每次启动留一份快照，这类事故就再也不会真的丢东西：最坏情况也能从快照里捞回来。
   *
   * 目录：`$DSH_HOME/game-pet-watch/prompt-backups/*.json`，保留最近 30 份。
   */
  /**
   * **提示词守卫**：人设/规则被重置成默认时自动恢复。
   *
   * 实测到的机制（两个文件配合）：DSH 保存配置会把它"认识的那份配置"整份写进 `cordis.yml`，
   * 而插件没向 DSH 声明配置 schema → `personality`/`rules`/`compactSystem` 从基准配置里消失 →
   * 插件回落成**代码默认值**；紧接着我们自己的写回（面板保存、切换游戏情况/机制库）
   * 又把这份默认值固化进 patch → 自定义人设被洗掉、文件里也找不回来。
   *
   * 守卫把"最近一次见到的非默认提示词"存在数据目录里，启动时比对：
   * 当前=默认 而守卫里有更丰富的自定义版本 → 写回 profile 并采用。
   */
  /**
   * **插件自管配置**（`dataDir/config.json`）。
   *
   * 为什么必须自管（2026-10-16 实测）：`cordis.patch.yml` 里的配置**根本不会生效** ——
   * 插件加载到的 `gameSource` / `onebotUrl` / `personality` 全是空或默认值，
   * 而 DSH 自己那份 `cordis.yml` 又会在每次启动时把它不认识的键丢掉 ✗。
   * 所以"配置写哪儿"只有一个正确答案：**写在自己管得着的地方**（OpenCode 侧也是这么做的）。
   */
  const localConfigFile = join(dataDir, 'config.json');
  function readLocalConfig() {
    try {
      const raw = JSON.parse(readFileSync(localConfigFile, 'utf8'));
      return raw && typeof raw === 'object' ? raw : {};
    } catch {
      return {};
    }
  }
  function writeLocalConfig(values, source) {
    if (!values || typeof values !== 'object') return false;
    try {
      mkdirSync(dataDir, { recursive: true });
      const next = { ...readLocalConfig(), ...values, _updatedAt: new Date().toISOString(), _source: source ?? '' };
      const tmp = `${localConfigFile}.tmp`;
      writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
      renameSync(tmp, localConfigFile);
      // 配置变了（含鱼表）→ 立刻刷新公共登记簿，别让别处读到旧身份
      publishRegistry();
      return true;
    } catch (error) {
      log('本地配置写入失败：' + (error?.message ?? error));
      return false;
    }
  }

  /** 日志文件路径：dataDir 解析完才设定 ✓（log() 里会在设定前跳过写盘 ✓） */
  /**
   * 日志文件路径挂在 `log` 函数上 ✓（它要跨 apply → applyInner 两个作用域 ✓）。
   * 第一版写成局部变量 `logFile` ✗ → applyInner 里赋值时 ReferenceError → apply 直接抛错 →
   * **路由一个都没注册** ✓✗（自检"路由注册"那条抓到的 ✓）。
   */
  log.file = join(dataDir, 'plugin.log');
  /**
   * **启动时把真正加载的文件名写进日志** ✓ —— 这是唯一可信的版本来源 ✗→✓。
   *
   * 为什么必须这样（今天反复被坑 ✗）：`/state.diagnostics.version` 读的是
   * "仓库里最高的 index-x.y.z.js" ✗，而加载器是按 URL 缓存的、用的是 **patch 里那一行**
   * 指向的文件 ✓ —— 两者可能不一致（我改了代码但你没重启 ✓）→ 于是"版本号是新的、
   * 行为却是旧的" ✓（刚才"图不回收藏"就是这么来的 ✗）。
   * `import.meta.url` 是**这个模块自己的路径** ✓，不会骗人 ✓。
   */
  const loadedEntry = (() => {
    try {
      return fileURLToPath(import.meta.url).split(/[\/]/).pop();
    } catch {
      return '(未知)';
    }
  })();
  log(`--- 插件启动（实际加载：${loadedEntry}）---`);

  const promptGuardFile = join(dataDir, 'prompt-guard.json');
  function readPromptGuard() {
    try {
      return JSON.parse(readFileSync(promptGuardFile, 'utf8'));
    } catch {
      return null;
    }
  }
  function writePromptGuard(next) {
    try {
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(promptGuardFile, JSON.stringify({ ...next, savedAt: Date.now() }, null, 2), 'utf8');
    } catch (error) {
      log('提示词守卫写入失败：' + (error?.message ?? error));
    }
  }
  /** 看到自定义提示词就把它收进守卫（默认值不入守卫） */
  function feedPromptGuard(source, force = false) {
    /**
     * `force`：**明确保存**（面板/接口）时无条件覆盖守卫 ✓ ——
     * 否则换更短的新人设会被"更长才覆盖"挡住 ✗（实测踩到 ✓）。
     */
    const { next, changed } = updatePromptGuard(config, readPromptGuard(), DEFAULTS, { force });
    if (changed) {
      writePromptGuard(next);
      log(`提示词守卫已更新（${source}）：记住这份自定义人设（personality ${String(config.personality ?? '').length} 字）`);
    }
    return changed;
  }

  /**
   * 启动时比一次：当前是默认值、而守卫里存着更丰富的自定义人设 → 恢复并写回 profile。
   * 只在"确实被重置"时动手（见 src/prompt-guard.js 的边界说明）。
   */
  /**
   * 自愈一次：当前=默认 而守卫里有自定义 → 恢复（内存 + 写回 profile）。
   *
   * **不只在启动时跑**：DSH 保存配置会把提示词字段挤掉（实测），如果只查一次，
   * 那之后要等下次重启才恢复；定期查（见下面的 effect）最多一分钟就修回来。
   */
  let promptHealCount = 0;
  let promptHealedAt = 0;
  function healPrompt(source) {
    const decision = resolvePromptGuard({ current: config, guard: readPromptGuard(), defaults: DEFAULTS });
    if (decision.reason !== 'reset-detected') {
      feedPromptGuard(source);
      return false;
    }
    Object.assign(config, decision.restore);
    promptHealCount += 1;
    promptHealedAt = Date.now();
    log(`⚠ 检测到提示词被重置为默认（${source}），已从守卫恢复：${decision.restored.join('、')}`);
    void writeConfigToProfile(decision.restore, dshHome).catch((error) =>
      log('恢复后写回 profile 失败：' + (error?.message ?? error)),
    );
    return true;
  }
  /**
   * **合并 profile patch 里"我们自己那一条"**（2026-10-19 修：api 调用间隔没按设置的时间）。
   *
   * 起因：安装包自带的 bundle patch 里写死了 `intervalSec: 20`，而 loader 把 bundle 层放在
   * 用户 profile patch **之后**应用 —— 于是主人在 profile patch 里写的 `intervalSec: 60`
   * 被静默盖掉，运行中一直是 20 秒一问（实测：patch 60 / 实际 20）。
   * 这里自己读一遍 patch，把它当作 **loader config 之上、自管 config.json 之下** 的一层。
   */
  {
    const fromPatch = readPatchConfig(dshHome);
    const patchKeys = Object.keys(fromPatch.config || {}).filter((k) => !k.startsWith('_'));
    if (patchKeys.length) {
      config = normalizeConfig({ ...config, ...fromPatch.config });
      log(
        `已合并 profile patch（${fromPatch.file}）：${patchKeys.slice(0, 8).join('、')}${patchKeys.length > 8 ? ' 等' : ''}` +
          `（intervalSec=${config.intervalSec}）`,
      );
    }
  }

  /**
   * 合并"自管配置"：它**覆盖**加载器给的那份（后者常常是空的/过期的，实测如此 ✗）。
   * 必须放在 `healPrompt('启动')` 之前 —— 守卫该看到最终生效值。
   */
  {
    const local = readLocalConfig();
    const keys = Object.keys(local).filter((k) => !k.startsWith('_'));
    if (keys.length) {
      config = normalizeConfig({ ...config, ...local });
      log(`已合并自管配置（config.json）：${keys.slice(0, 8).join('、')}${keys.length > 8 ? ' 等' : ''}`);
    }
  }

  healPrompt('启动');

  /**
   * 附件回收器：账本落在数据目录（跟着 `dataDir` 走，能被搬家规则覆盖）。
   */
  const attachmentGc = config.attachmentGc
    ? createAttachmentGc({
        file: join(dataDir, 'attachment-index.json'),
        // 附件对象根目录：`saveImage` 只回 attachmentId（sha256:<hex>），要靠它反推文件路径
        storeRoot: join(dshHome, 'attachments', 'v1', 'objects'),
        log,
        keepCount: config.attachmentKeepCount,
        keepMinutes: config.attachmentKeepMinutes,
        maxMB: config.attachmentMaxMB,
      })
    : null;

  ctx.effect(() => {
    if (!attachmentGc) return () => {};
    // 启动先扫一次（把上次运行攒下的收掉），之后按间隔扫
    const first = setTimeout(() => attachmentGc.sweep(), 20_000);
    const timer = setInterval(() => attachmentGc.sweep(), Math.max(1, config.attachmentSweepMin) * 60_000);
    timer.unref?.();
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, 'game-pet-watch: attachment gc');

  const promptBackupsDir = join(dataDir, 'prompt-backups');
  async function snapshotPrompt(reason) {
    try {
      const { mkdir, writeFile, readdir, unlink } = await import('node:fs/promises');
      await mkdir(promptBackupsDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const file = join(promptBackupsDir, `${stamp}-${reason}.json`);
      await writeFile(
        file,
        JSON.stringify(
          {
            at: Date.now(),
            reason,
            personality: config.personality,
            rules: config.rules,
            compactSystem: config.compactSystem,
            patchFile: resolvePatchFile() ?? null,
          },
          null,
          2,
        ),
        'utf8',
      );
      // 只留最近 30 份，避免无限堆积
      const names = (await readdir(promptBackupsDir)).filter((n) => n.endsWith('.json')).sort();
      for (const old of names.slice(0, Math.max(0, names.length - 30))) {
        await unlink(join(promptBackupsDir, old)).catch(() => {});
      }
      return file;
    } catch (error) {
      log('提示词快照失败：' + (error?.message ?? error));
      return undefined;
    }
  }
  // 启动即快照（不阻塞主流程）
  void snapshotPrompt('startup');
  /**
   * 动画目录：离线给每段动画生成描述，运行时只读文本。
   * describe 回调复用本插件已有的模型通道（runModel 带图），所以建库用的是**同一把钥匙、同一个模型**。
   */
  /**
   * 游戏事件源（GoH）。空源时完全不建、不轮询、不占资源。
   * 注意：watcher 的"首次使用从文件末尾开始"行为很重要 —— 否则 DSH 一重启就会把
   * 整局历史当新事件，对着几百条旧击杀疯狂反应。
   */
  let goh = null;
  /**
   * 采集器守护实例（apply() 作用域，**不能建在 buildGoh() 里**）。
   *
   * 踩过的坑：最初建在 `buildGoh()` 内部 → `/state` 在 apply() 作用域引用它时
   * `ReferenceError: collector is not defined` → **整个状态接口返回 500** →
   * 面板/胶囊读不到 `running`，于是一边正常观察一边显示"未运行"。
   * 而且 buildGoh() 每次切换来源都会重跑，建在里面还会重复注册 effect。
   */
  let collector = null;
  /** 该不该跑：游戏情况选了 goh 且开关开着 */
  const wantCollector = () => isGameSourceOn(config.gameSource) && Boolean(config.gohCollector);
  /**
   * 建/重建事件读取器（切换来源后立即重建，不必重开 DSH）。
   *
   * ⚠️ 这个函数碰 `state`，所以**必须在 state 声明之后才能调用第一次**。
   * 踩过的坑：我在 state 声明之前就调了它 → `ReferenceError: Cannot access 'state' before initialization`
   * （TDZ，`let/const` 才有的错）→ 插件初始化失败 → 宠物不再出现。
   * 这次幸好 apply() 外面有防崩 try/catch，DSH 没被拖死（只坏了插件自己）——
   * 那次保护起了作用，但代价是"鱼没了"。所以现在把调用点挪到 state 之后（见下方 buildGoh() 调用）。
   */
    /**
     * **事件 JSONL 到底是哪个文件**（2026-10-18 修：日志捕捉其实一直没工作）。
     *
     * 支持的两种用法：
     *   ① 只配 `gohFile`（用户自己把日志转成 JSONL）→ 就用它；
     *   ② 配了采集器脚本 → 采集器的输出才是 JSONL。如果 `gohFile` 指向的是**游戏原始日志**
     *      （`.log`），那它永远解析不出事件（实测 lastEventAt 一直是 0）→ 退回采集器脚本旁边的
     *      `events.jsonl`，并把 `--out` 也钉到这个路径，两边不会再错位。
     */
    const eventFileNow = () => {
      const configured = String(config.gohFile || '').trim();
      const scriptDir = config.gohCollectorScript ? dirname(config.gohCollectorScript) : '';
      const looksRawLog = /\.log$/i.test(configured);
      if (configured && !(looksRawLog && scriptDir)) return configured;
      if (scriptDir) return join(scriptDir, 'events.jsonl');
      return configured;
    };

  function buildGoh() {
    const eventFile = eventFileNow();
    goh = isGameSourceOn(config.gameSource)
      ? new GohWatcher({ file: eventFile, stateFile: gohStateFile(dataDir), log })
      : null;
    state.game.source = config.gameSource || '';
    state.game.file = eventFile;
    if (goh) {
      if (eventFile !== String(config.gohFile || '').trim()) {
        log(`⚠ 「事件文件」指向的是游戏原始日志（${config.gohFile}）—— 那是采集器的**输入**，不是 JSONL。已改用采集器输出：${eventFile}`);
      }
      log(`游戏事件源已启用：${eventFile}（重要事件立刻反应，冷却 ${config.gohImmediateCooldownSec}s）`);
    }
    return goh;
  }

  const catalog = new CatalogStore({
    file: catalogFilePath(dataDir),
    log,
    describe: async ({ system, text, image }) => {
      const result = await runModel({ system, text, withImage: image, reason: 'describe' });
      return { raw: result.raw };
    },
  });
  /**
   * 表情包目录：扫磁盘 + 离线描述（复用 CatalogStore，只是换一个目录文件）。
   * 描述优先用现成的（原版包内 memes 表 / 抓取台词表），所以**通常一次视觉调用都不需要**。
   */
  /**
   * 给"没有现成描述"的表情包写描述时用的系统提示词。
   * 描述是**给模型自己看的挑选依据**：写"什么内容 + 什么场合适合发"就够，一句话。
   */
  const IMAGE_DESCRIBE_SYSTEM =
    '你在为一个桌面宠物整理表情包索引。看这张表情包，写一句话描述它：画面内容 + 适合在什么场合发给主人。' +
    '只输出 JSON：{"text":"一句话"}，不要输出其它内容。';

  const imagesUserRoot = config.imagesUserRoot || join(dshHome, 'dsh-pet-gpw');
  /**
   * 原版 dsh-pet 包目录（读它的 memes 素材与描述表）。
   *
   * ⚠️ 必须**每次现算**，不能在 apply() 里算一次存起来：`resolvePatchFile()` 依赖
   * `findPatchFile()` 的**异步探测**，而 apply() 同步跑到这里时它还是空的 ——
   * 于是 upstreamRoot 会是空字符串，`syncImages()` 直接放弃，表情包目录永远 0 张：
   * 提示词里没有清单、模型下载的图也进不了目录、名字校验再把它们丢掉 → 配图彻底不工作。
   * （实测就是这么坏的：模型确实调了工具、下了 6 张图，却一张都没显示。）
   */
  function resolveUpstreamRoot() {
    if (config.upstreamRoot) return config.upstreamRoot;
    const patch = resolvePatchFile();
    const candidates = [
      patch ? join(dirname(patch), 'node_modules', 'dsh-pet') : '',
      join(dshHome, 'profiles', 'desktop', 'node_modules', 'dsh-pet'),
    ].filter(Boolean);
    return candidates.find((dir) => existsSync(dir)) ?? candidates[0] ?? '';
  }
  /**
   * 视觉描述入口（建索引与"读 QQ 群里的图"共用同一套）。
   * 抽成具名函数是因为它现在有两个调用方 —— 内联的话第二处一定会复制粘贴。
   */
  const execFileAsync = promisify(execFile);

  /**
   * 把图片缩小并转成 JPEG（**GIF 只取第一帧**）—— 防"群友发张大图把 token 吃爆"。
   *
   * 为什么借 PowerShell：插件没有图像库（Node 不带编码器），而 Windows 自带 System.Drawing
   * 就能缩放 + 重编码 + 取 GIF 首帧（脚本见 `scripts/shrink-image.ps1`，已实测：
   * 513KB PNG → 153KB JPEG，省 70%）。
   *
   * 失败时**返回 null，调用方用原图**（宁可多花 token，也不能因为压缩失败就不读了）。
   *
   * @param {string} inputFile 原图路径
   * @returns {Promise<{file:string, mediaType:string, note:string, meta:object}|null>}
   */
  /**
   * @param {string} inputFile 原图
   * @param {{format?: 'jpg'|'png', maxDim?: number}} [options]
   *   - 默认 `jpg`（给视觉模型看，体积小 ✓）
   *   - `png` 用于"**表情包入库统一成 PNG**"✓（图库扫描器与副本图片路由只认 png/webp ✗）
   */
  async function shrinkImage(inputFile, options = {}) {
    const script = join(PACKAGE_DIR, 'scripts', 'shrink-image.ps1');
    if (!existsSync(script)) return null;
    const format = options.format === 'png' ? 'png' : 'jpg';
    const maxDim = Number.isFinite(options.maxDim) ? options.maxDim : config.imageMaxDim;
    const out = join(tmpdir(), `gpw-shrunk-${Date.now()}.${format}`);
    /**
     * 用**和截图同一套**的 PowerShell 解析（`resolvePowerShell`）——
     * 第一版自己写候选循环，真机上压缩静默失效（`spawn pwsh ENOENT`）✗。
     */
    const shell = await resolvePowerShell(log);
    let lastError = shell ? '' : '找不到可用的 PowerShell（压缩跳过，用原图）';
    if (shell) {
      try {
        const { stdout } = await execFileAsync(
          shell,
          ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-In', inputFile, '-Out', out,
            '-MaxDim', String(maxDim), '-Quality', String(config.imageQuality), '-Format', format],
          { timeout: 20_000, windowsHide: true, maxBuffer: 1024 * 1024 },
        );
        const meta = JSON.parse(String(stdout).trim().split(/\r?\n/).pop() ?? '{}');
        if (!meta.ok || !existsSync(out)) {
          // 不再 break（外面已经没有循环了）——记下原因，走到底部的"用原图"分支
          lastError = meta.error ?? 'script said not ok';
          throw new Error(lastError);
        }
        const gifNote = meta.wasGif ? `（动图，只取第 1 帧${meta.frames > 1 ? `，共 ${meta.frames} 帧` : ''}）` : '';
        const note = `${meta.srcWidth}x${meta.srcHeight} ${(meta.srcBytes / 1024).toFixed(0)}KB`
          + ` -> ${meta.width}x${meta.height} ${(meta.outBytes / 1024).toFixed(0)}KB${gifNote}`;
        return { file: out, mediaType: format === 'png' ? 'image/png' : 'image/jpeg', note, meta };
      } catch (error) {
        lastError = String(error?.message ?? error);
      }
    }
    if (lastError) log('图片压缩失败，改用原图：' + lastError.slice(0, 120));
    return null;
  }

  async function describeImage({ system, text, image, mediaType }) {
    const result = await runModel({ system, text, withImage: image, reason: 'describe', mediaType });
    return { raw: result.raw };
  }

  /**
   * **每鱼一份表情包描述目录**（主人要求 ✓：图库共享、描述分开，不然会混起来 ✓）。
   *
   *   · 图片文件是**共享**的（都已改成数字名 `0001.png` ✓）
   *   · 描述按鱼分开：`image-catalog-<scope>.json` ✓ → 同图可以有不同的名字与描述 ✓
   *   · 不给 scope 时仍然用老的 `image-catalog.json` ✓（向后兼容 ✓）
   */
  const imageCatalogs = new Map();
  /**
   * **宠物间碰撞：屏幕坐标账本**（多鱼之后才有意义 ✓）。
   *
   * 为什么需要它：每只鱼是**一个独立的 Electron 进程 + 一个透明大窗口** ✗ ——
   * 原版 dsh-pet 的碰撞 broker（`petStates` + `pet:flight-states` 广播 ✓）只在**同一个进程**里有效 ✗，
   * 跨进程看不见对方 ✓ → 所以由**大脑（插件）**当中转 ✓：
   *
   *   POST /rects {fishId, rect:{x,y,w,h}}   ← 副本 ~500ms 报一次自己的**宠物包围盒**（屏幕坐标 ✓）
   *   GET  /rects                             ← 读全表（含 at ✓ 方便看谁掉线）
   *
   * 判定：两个矩形相交 → 算"贴上了" ✓（留 8px 容差，避免擦边反复触发）。
   * 反应：往两只鱼各推一句**不打模型**的本地台词 ✓（免费 ✓ 立即 ✓），并节流（同一对 90 秒最多一次）。
   */
  const fishRects = new Map();
  const lastBumpAt = new Map();
  /** 每一对鱼当前是否「正挨着」（边沿触发用：只在进入接触那一刻算一次） */
  const touching = new Map();
  /** 这一对鱼本次接触已经推过几次（最多 3 次，见 checkFishCollisions） */
  const hitTries = new Map();

  function rectOverlap(a, b, pad = 8) {
    if (!a || !b) return false;
    const ax2 = a.x + a.w;
    const ay2 = a.y + a.h;
    const bx2 = b.x + b.w;
    const by2 = b.y + b.h;
    return a.x + pad < bx2 && b.x + pad < ax2 && a.y + pad < by2 && b.y + pad < ay2;
  }

  /**
   * 判定用的盒子：**优先真身盒**（`bodyX/Y/W/H` = `HIT_BOX`），没有就退回整张 sprite 盒。
   *
   * 为什么：上报的 `w = size`（462 CSS ×1.5 = 693 物理），而角色真正的身体只有 `HIT_BOX` 那块
   * （240/640 宽 ≈ 260 物理）—— 用整张画布判重叠，等于判定范围是身体的 2.66 倍，
   * 主人会明显感觉"比角色都大"。渲染端自己的 collidePet 用的就是真身盒，这下两边一致。
   */
  const boxOf = (r) =>
    Number.isFinite(r?.bodyW) && r.bodyW > 0
      ? { x: r.bodyX, y: r.bodyY, w: r.bodyW, h: r.bodyH, vx: r.vx, vy: r.vy }
      : r;

  /** 检查一遍重叠（每 2 秒跑一次 ✓ 很便宜 ✓） */
  async function checkFishCollisions() {
    const now = Date.now();
    const live = [...fishRects.entries()].filter(([, r]) => r && now - (r.at ?? 0) < 5000);
    if (live.length < 2) return;
    for (let i = 0; i < live.length; i += 1) {
      for (let j = i + 1; j < live.length; j += 1) {
        const [idA, ra] = live[i];
        const [idB, rb] = live[j];
        const pairKey = [idA, idB].sort().join('|');
        /**
         * **按"接触边沿"判，而不是按"有没有速度"判**（2026-10-18 修）。
         *
         * 旧逻辑要求"至少一方速度 > 30px/s 才算撞"，结果：主人把两只鱼拖到一起、松手，
         * 两只都静止 → **永远不触发**（这就是"碰撞没反应"的真正原因）。
         * 但也不能"重叠就算"：两只鱼默认就叠在屏幕同一个角落 → 每 500ms 报一次、台词刷屏。
         *
         * 所以：**只在"从没挨着 → 挨着"的那一刻算一次**（进入接触），持续重叠就安静；
         * 分开之后（touching = false）再挨上，还能再触发一次。
         */
        const boxA = boxOf(ra);
        const boxB = boxOf(rb);
        if (!rectOverlap(boxA, boxB, clampInt(config.collidePadPx, DEFAULTS.collidePadPx, 0, 64))) {
          touching.set(pairKey, false);
          // 分开了：这对鱼下次再挨上时，重新从「推 1 次」开始计数
          if (hitTries.delete(pairKey)) log(`碰撞分离：${idA} 与 ${idB} 已经错开`);
          continue;
        }
        const firstContact = touching.get(pairKey) !== true;
        touching.set(pairKey, true);
        const lineCooldownMs = clampInt(config.collideLineCooldownSec, DEFAULTS.collideLineCooldownSec, 5, 3600) * 1000;
        const cold = now - (lastBumpAt.get(pairKey) ?? 0) >= lineCooldownMs;
        const pets = Array.isArray(config.pets) ? config.pets : [];
        const fishA = pets.find((f) => f.id === idA);
        const fishB = pets.find((f) => f.id === idB);
        /** ⚠️ 这行必须在 `cold` 判断**之后** ✗ —— 否则每 500ms 刷一条 ✓（主人日志里刷屏就是这个 ✓） */

        /** 本地台词：**不打模型** ✓（碰撞几秒一次，打模型就太贵了 ✗），但要带各自的口吻 ✓ */
        const lines = [
          ['喂，撞到本鱼了喵 (。-ω-)', '本鱼这身板是实心的，别硬挤喵 (´･ω･`)'],
          ['你压着本鱼尾巴了喵 (￣o￣)', '挤一挤也行，先把白饭分本鱼一半喵'],
          ['让让喵，本鱼这块地盘先来的 (・ω・)', '撞一下算打招呼，本鱼认了喵'],
        ];
        /**
         * ⚠️ **推窗口这一段先关掉**（2026-10-17）：实测它和原版助手的"窗口跟随 sprite"打架 ✗ ——
         * 我们挪的是**窗口** ✓，而 sprite 的坐标没变 ✗ → 只要 sprite 再上报一次位置，
         * 窗口就被拉回去 ☒（主人报的"碰撞后位置有问题"就是这个 ✓）。
         * 正确的做法是"推 **sprite 的坐标**（走 IPC ✓ 让渲染端移动自己的 pos ✓）"，
         * 这要动渲染端 ✓ 单独一轮做 ✓。现在：**碰撞只出台词** ✓，位置完全由主人拖拽决定 ✓ 不抢控制权 ✓。
         *
         * 保留的代码在上面（`collidePushPx` 等参数 ✓），下一轮把 `NUDGE_BY_SPRITE = true` 接上即可 ✓。
         */
        /**
         * **真正的碰撞反应**：给两只鱼各发一次 `POST /gpw/hit`（原版那条 `pet:hit` ✓）
         * → 渲染端走它自己的冲量逻辑 ✓ → 本体**弹开** ✓（不再挪窗口 ✗ 那条已证明会打架 ✓）
         */
        const cxa = boxA.x + boxA.w / 2;
        const cya = boxA.y + boxA.h / 2;
        const cxb = boxB.x + boxB.w / 2;
        const cyb = boxB.y + boxB.h / 2;
        const len = Math.hypot(cxa - cxb, cya - cyb) || 1;
        /**
         * **冲量按速度算**（近似动量守恒 ✓）：
         *   取两只鱼上报的速度里"较大的那个"当撞击强度 ✓（静止时是 0 → 用最小 2.2 兜底 ✓），
         *   方向沿两心连线 ✓，两个方向相反、大小相同 ✓（动量抵消 ✓ 不会凭空加速 ✓）。
         *   上限 8 ✓ —— 甩得再猛也只弹这么狠 ✓ 免得飞穿整个屏幕 ✗。
         */
        /**
         * **不再要求「有人在动」**（2026-10-18 改）：静止被推到别人身上也算碰撞。
         *
         * 旧判据是"至少一方速度 > 30px/s"，于是主人把两只鱼拖到一起、松手，
         * 两只都静止 → **永远不触发**（这就是"碰撞没反应"的根因）。
         * 刷屏问题现在由上面的「进入接触才触发一次」解决，不需要这条闸门了。
         */
        /**
         * **等质量弹性碰撞（动量严格守恒）**（2026-10-18 重写）。
         *
         * 之前那版是"两边各给一个同方向的冲量"：虽然 +p/-p 看着也守恒，但**没用到双方速度**，
         * 于是"静止被撞"和"高速撞上去"得到的反应一样，撞人的那只也不减速 —— 手感上就是
         * "动量不守恒"。这里改成沿法线的标准一维弹性碰撞：
         *
         *   n  = 从 B 指向 A 的单位向量
         *   vAn = va·n，vBn = vb·n
         *   vAn' = ((1-e)·vAn + (1+e)·vBn) / 2
         *   vBn' = ((1-e)·vBn + (1+e)·vAn) / 2
         *
         * 等质量下 vAn' + vBn' = vAn + vBn（动量守恒），e=0.9 让能量略衰减。
         * 切线分量保持不变（斜着撞不会突然拐弯）。
         *
         * 特例：两只都基本静止（|vAn|+|vBn| < 40）→ 走"对称分离"分支：
         * 各给 ±SEP 的法向速度，**总和仍是 0**（守恒），但能把叠住的它们推开。
         * 实测 /gpw/hit 的 vx≈30 约推 130px，正好够分开。
         */
        const nx = (cxa - cxb) / len;
        const ny = (cya - cyb) / len;
        /**
         * 碰撞解算本身是纯函数（`src/collide.js`）：等质量、沿法向、动量严格守恒。
         * 这里只负责把结果用 `/gpw/hit` 设回两只鱼。
         */
        /**
         * 分离速度 = 档位（collidePushPx×6）**+ 叠进去的深度**。
         *
         * 只按档位给（默认 18）太弱：主人把一只拖进另一只身体里再松手，
         * 账本里的速度往往已经归零 → 系统按"都静止"处理 → 只给 18 → 看起来推不开。
         * 现实里"陷得越深 = 撞得越狠"，所以把重叠深度也算进去（1.2px 深 → 1.2px/s 的分离速度）。
         */
        const ox = Math.min(boxA.x + boxA.w, boxB.x + boxB.w) - Math.max(boxA.x, boxB.x);
        const oy = Math.min(boxA.y + boxA.h, boxB.y + boxB.h) - Math.max(boxA.y, boxB.y);
        const depth = Math.max(0, Math.min(ox, oy));
        const sepSpeed = Math.max(
          0,
          Math.min(
            320,
            clampInt(config.collidePushPx, DEFAULTS.collidePushPx, 0, 32) * 6 + depth * 1.2,
          ),
        );
        const resolved = resolveCollision({ va: { x: ra.vx || 0, y: ra.vy || 0 }, vb: { x: rb.vx || 0, y: rb.vy || 0 }, nx, ny, sep: sepSpeed });
        const nextA = resolved.a;
        const nextB = resolved.b;
        /**
         * **抬一下**：纯水平冲量几帧就被地面摩擦吃掉（实测发 150 只回报 12）。
         * 抬升按"这次传递的速度"缩放：撞得越快抬得越高，静止互挤就只抬一点。
         * 竖直分量对两只一样，水平方向仍然严格 ±（横向动量守恒不受影响）。
         */
        const transferred = Math.max(Math.hypot(nextA.x, nextA.y), Math.hypot(nextB.x, nextB.y));
        const lift = Math.min(140, Math.max(12, transferred * 0.45));
        nextA.y = Math.min(nextA.y, -lift);
        nextB.y = Math.min(nextB.y, -lift);
        /**
         * **已经飞起来了就先不推**：两只都在高速运动时（>250px/s）再给冲量，
         * 会让它们在屏幕上一直互相弹（实测 vx 冲到 6000+、每秒一次）。
         * 等它们慢下来、真的又叠住了再推。
         */
        const flying = Math.hypot(ra.vx || 0, ra.vy || 0) > 250 || Math.hypot(rb.vx || 0, rb.vy || 0) > 250;
        /**
         * **最多推 3 次**：进入接触先给一次碰撞；1.2 秒后还叠着就再算一次（比如被墙卡住），
         * 第三次还不开就放弃。不是"每 500ms 一直推"——那样会把宠物一直按在抛掷态。
         */
        const rec = hitTries.get(pairKey) || { count: 0, at: 0 };
        const due = now - rec.at >= 1500;
        /**
         * **每对每接触最多 2 次**（2026-10-18 修）：
         * 原来没有次数上限 → 只要还叠着就每 1.5 秒推一次，手感就成了"每隔一秒半被撞一下"，
         * 而且每次还带一次抬升，看着像判定特别大。现在只推"入场那一下 + 一次救援"。
         */
        if (due && !flying && rec.count < 2) {
          rec.count += 1;
          rec.at = now;
          hitTries.set(pairKey, rec);
          for (const [fish, next] of [
            [fishA, nextA],
            [fishB, nextB],
          ]) {
            if (!fish) continue;
            try {
              const base = String(fish.origin ?? '').replace(/\/+$/, '');
              await fetch(base + '/gpw/hit', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                  vx: Math.round(next.x * 100) / 100,
                  vy: Math.round(next.y * 100) / 100,
                }),
                signal: AbortSignal.timeout(1500),
              });
            } catch (error) {
              log(`碰撞冲量失败（${fish.id}）：` + (error?.message ?? error));
            }
          }
        }

        /**
         * 台词只在**进入接触那一下**出现（推力上面每次接触最多 3 次，见 hitTries）。
         * 持续贴着不再重复冒话，避免刷屏。
         */
        if (!firstContact) continue;
        if (!cold) continue; // 同一对鱼在冷却里就不冒话（推力已经发过了）
        lastBumpAt.set(pairKey, now);
        log(`宠物碰撞：${summarize(fishA)} ↔ ${summarize(fishB)}（重叠 ✓ 各冒一句）`);
        /**
         * **碰撞台词**：默认用本地台词（免费 ✓）；
         * 打开 `collideCallModel` 才走模型 ✓ —— 而且只让**撞上去的那只**说话 ✓（1 次调用 ✓ 不是 2 次 ✓）。
         *
         * ⚠️ **模型成功了就别再发本地台词**（2026-10-18 修）：原来是 if 完继续往下执行 `pick`，
         * 于是撞人的那只一次碰撞说两句（模型一句 + 模板一句），被撞的说一句模板。
         * 现在：模型成功 → 这一轮到此为止；模型失败 → 只记日志、不 return，让下面照常退回本地台词。
         */
        if (config.collideCallModel) {
          let spoke = false;
          try {
            const speaker = fishA || fishB;
            if (speaker) {
              const mem = memoryFor(speaker.scope || speaker.id);
              await mem.load();
              await reply('（本鱼刚被另一只鱼撞了一下，随口吐槽一句，40 字以内，带你的口癖）', {
                target: config.petTarget,
                petId: config.petId,
                scope: speaker.scope || speaker.id,
                fish: speaker,
                origin: String(speaker.origin ?? ''),
              });
              log(`碰撞台词（模型）：${summarize(speaker)} ✓`);
              spoke = true;
            }
          } catch (error) {
            log('碰撞台词走模型失败，退回本地台词：' + (error?.message ?? error));
          }
          if (spoke) continue;
        }
        const pick = lines[Math.floor(Math.random() * lines.length)];
        for (const [fish, text] of [
          [fishA, pick[0]],
          [fishB, pick[1]],
        ]) {
          if (!fish) continue;
          /**
           * **只给我们自己在驱动的鱼推台词**（`enabled !== false`）。
           *
           * 鱼表里会有"登记但不由我们拉起"的鱼（例如 opencode 那侧的 7350，`enabled:false`）：
           * 它的盒子必须进账本（否则我们的鱼看不见它、永远撞不上），但**它的台词它自己管**
           * —— 它撞上我们时，它那一侧会给自己推一句；我们如果再推一句，它就会连冒两句。
           * `/hit` 的目标解析不受这条影响（`findFish` 不看 enabled），所以跨栈冲量照旧。
           */
          if (fish.enabled === false) continue;
          try {
            if (config.pushToPet) await pushToPet(text, config.petTarget, config.petId, undefined, fish.origin);
            const mem = memoryFor(fish.scope || fish.id);
            await mem.load();
            await recordSpeak(text, 'bump', mem);
          } catch (error) {
            log('碰撞台词推送失败：' + (error?.message ?? error));
          }
        }
      }
    }
  }

  /**
   * 给"描述生成"用的**这条鱼的口吻**片段 ✓。
   *
   * 为什么需要：描述原来用全局同一份 system ✗ → 两条鱼的图库描述**一字不差** ✗
   * （实测：legacy 103 张与 current 130 张首条完全相同 ✓）→ 挑图口味也就一模一样 ✗。
   * 现在把鱼的人设/口癖拼进去 ✓：**文本用它的口吻** ✓，但**画面本身必须客观准确** ✓
   * （挑图要靠画面 ✓，口吻只影响挑选时的语感与场合判断 ✓）。
   */
  function fishVoice(fish) {
    const name = String(fish?.name ?? '').trim() || '本鱼';
    const persona = String(fish?.personality || config.personality || '').trim();
    const rules = String(fish?.rules || config.rules || '').trim();
    return (
      `\n\n【这张卡只给「${name}」用】\n` +
      `同一个人格：${persona.slice(0, 400)}\n` +
      (rules ? `说话规矩：${rules.slice(0, 300)}\n` : '') +
      '所以 text/一句话那一栏要**用这条鱼的口吻**写（第一人称"本鱼"、它的口癖与语气 ✓），' +
      '不要中性通用的描述 ✓；但"画面里到底是什么、出现什么文字"必须**客观准确** ✓ —— 挑图按它来 ✓。'
    );
  }

  /** 某个目录属于哪条鱼（用于给它配口吻 ✓） */
  /** 按 scope 找鱼（= 记忆/图库目录后缀 ✓）；找不到退回业务主鱼 ✓（原行为保留） */
  function fishOfScope(scope) {
    const pets = Array.isArray(config.pets) ? config.pets : [];
    return findFish(pets, { scope }) || primaryFish(pets);
  }

  function catalogFor(scope) {
    const key = String(scope ?? '').trim();
    if (!key) {
      if (!imageCatalogs.has('')) {
        imageCatalogs.set('', new CatalogStore({ file: join(dataDir, 'image-catalog.json'), log, describe: describeImage }));
      }
      return imageCatalogs.get('');
    }
    const safe = key.replace(/[^\w.-]+/g, '_');
    if (!imageCatalogs.has(safe)) {
      imageCatalogs.set(safe, new CatalogStore({
        file: join(dataDir, `image-catalog-${safe}.json`),
        log,
        describe: describeImage,
      }));
    }
    return imageCatalogs.get(safe);
  }
  /** 主目录 = QQ 那条路用的那只鱼（`pets` 里 `qq: true` 的；没配就是默认）✓ */
  const imageCatalog = catalogFor('current');

  /**
   * 旧名 → 数字 id 的映射（改名时写的 `image-id-map.json` ✓）。
   * 描述来源（站方抓的 / 上游包里的）是按**旧名**索引的 ✗ → 这里转成数字 id ✓，
   * 否则同步时对不上、103 张图会全部走视觉模型重新描述 ✗（实测会白烧一大笔 ✓）。
   */
  function readImageIdMap() {
    try {
      const raw = JSON.parse(readFileSync(join(dataDir, 'image-id-map.json'), 'utf8'));
      const byOld = {};
      const byId = {};
      for (const m of raw) {
        if (!m || !m.id) continue;
        if (m.oldName) byOld[m.oldName] = m.id;
        byId[m.id] = m.oldName || '';
      }
      return { byOld, byId };
    } catch {
      return { byOld: {}, byId: {} };
    }
  }
  /** 表情包目录状态（界面/排障用） */
  const imageState = { synced: 0, added: 0, described: 0, lastSyncAt: null, error: '' };
  /**
   * 梗鲸图库（2069 张）：**第一次真被搜时才下载**那 1.2MB 索引，之后用本地缓存（24 小时）。
   * 不做成启动就拉：多数时候用不上，白等一次网络。
   */
  const memeLibrary = { entries: null, downloads: 0, lastQuery: '', lastPick: '', error: '' };
  async function ensureMemeLibrary() {
    if (memeLibrary.entries) return memeLibrary.entries;
    const { index, from } = await loadGalleryIndex({
      file: join(dataDir, 'gallery-index.json'),
      log,
    });
    memeLibrary.entries = flattenGallery(index);
    log(`梗鲸图库就绪（${memeLibrary.entries.length} 张，来源 ${from}）`);
    return memeLibrary.entries;
  }
  /**
   * **库满了 → 让它再看一眼图，挑一张最不喜欢的淘汰**（主人要求）。
   *
   * 为什么要"再看一眼"：淘汰是破坏性的 ✗，而描述只有一句话 ——
   * 光看描述它可能选错（比如把一张很常用的图当成"看起来普通"删掉 ✓）。
   * 所以这里把候选图**连同新图一起送进模型**（多图输入 ✓），让它看图抉择 ✓。
   *
   * 两道保险：
   *   ① 不是硬删 —— 移进 `memes/.evicted/` ✓（误判还能捞回来 ✓）
   *   ② 模型说不删（`{"drop":null}`）就**不删** ✓，这次新图也不入库 ✓
   */
  async function evictOneMeme({ newDesc = '', newFile = '' } = {}) {
    const dir = join(imagesUserRoot, 'memes');
    /** 候选 = 库里的老图（按加入顺序取最旧 4 张，带真实文件且存在的） */
    const candidates = Object.entries(imageCatalog.data.items)
      .map(([name, item]) => ({ name, text: String(item?.text ?? ''), file: item?.file ?? item?.sheet ?? '' }))
      .filter((c) => c.file && existsSync(c.file))
      .slice(0, 4);
    if (!candidates.length) return null;
    const list = candidates.map((c, i) => `${i + 1}. ${c.name}：${c.text.slice(0, 60) || '（没有描述）'}`).join('\n');
    try {
      const { raw } = await runModel({
        reason: 'evict',
        system: '你是一只桌宠，正在整理自己的表情包库。你说话短、口语化。',
        text: `我的表情包库满了，要腾出一格。\n`
          + (newDesc ? `【新来的这张】${newDesc.slice(0, 80)}\n（${
            newFile ? '图也给你看了（最后一张）' : '（这次没图）'}）\n` : '')
          + `【库里的老图】（图都给你了，顺序与编号一致）\n${list}\n\n`
          + '请挑**一张最不喜欢、以后最不可能再用**的淘汰掉。'
          + '如果新来的这张其实不值得进库，就直说别删老图。'
          + '只输出 JSON：{"drop":"要淘汰的名字"} 或 {"drop":null}',
        images: [...candidates.map((c) => c.file), ...(newFile ? [newFile] : [])],
      });
      const parsed = JSON.parse(String(raw).replace(/^```[a-z]*\n?|```$/g, '').trim());
      const drop = String(parsed?.drop ?? '').trim();
      if (!drop) {
        log('库满了，但它觉得新图不值得进库 → 不淘汰、不入库');
        return null;
      }
      const target = candidates.find((c) => c.name === drop);
      if (!target) {
        log(`它想淘汰「${drop}」但候选里没有这个名字（可能记错）→ 不删`);
        return null;
      }
      const trash = join(dir, '.evicted');
      mkdirSync(trash, { recursive: true });
      const moved = join(trash, `${Date.now()}-${target.name}`);
      renameSync(target.file, moved);
      delete imageCatalog.data.items[target.name];
      await imageCatalog.persist();
      state.memesEvicted = (state.memesEvicted || 0) + 1;
      log(`库满淘汰：删「${target.name}」（${target.text.slice(0, 30)}）→ 移到 memes/.evicted/ ✓`);
      return target.name;
    } catch (error) {
      log('淘汰抉择失败（不删任何东西）：' + (error?.message ?? error));
      return null;
    }
  }

  /**
   * **图库归属账本** —— `<数据目录>/image-owners.json`：哪张图、哪条鱼有自己的描述 ✓。
   *
   * 主人的规则（原话）："记录下哪些有 7342 的记录、哪些有 7341 的记录 ✓，
   * 每条鱼只能调用自己记录里有的 ✓；fetch 的时候先看有没有再存 ✓，有就生成描述 ✓。"
   *
   * 于是这里做两件事 ✓：
   *   ① 扫每条鱼的目录 ✓ → 记下"谁有哪张的描述"（按 `item.by` 判定 ✓）→ 写账本 ✓
   *   ② 传 `describe: true` 时 ✓：给"图在库里、但这条鱼还没写过自己版本"的图**补一张** ✓
   *      （每鱼每轮上限 `describeBacklogPerSync` ✓ —— 每张一次视觉调用 ✓ 花钱必须封顶 ✓）
   *
   * 图片本体始终**共用** ✓（一套数字编号 ✓）；分家的只是描述 ✓。
   */
  /** 补描述的节流：距上次补描述不足这么久就**只记账、不花钱** ✓ */
  const BACKLOG_MIN_MS = 10 * 60_000;
  let lastBacklogAt = 0;

  async function refreshImageOwners({ describe = false } = {}) {
    const pets = Array.isArray(config.pets) ? config.pets : [];
    const items = {};
    const counts = {};
    const backlog = {};
    /**
     * **一次性迁移：认领"没有归属"的老描述** ✓（幂等 ✓）。
     *
     * 见 DEFAULTS.adoptUnownedFor 的说明 ✓ —— 不做这一步，7341 会"凭空少一百多张" ✗。
     * 只认给**指定的那一条鱼** ✓（默认 legacy ✓）：另一条鱼（7342）抄来的那批
     * 仍然算"不是它的" ✓ → 它会自己一张张生成 ✓（这正是主人要的 ✓）。
     */
    const adoptTo = String(config.adoptUnownedFor ?? '').trim();
    if (adoptTo) {
      const owner = pets.find((f) => f.id === adoptTo || (f.scope || f.id) === adoptTo);
      if (owner) {
        try {
          const ownerStore = catalogFor(owner.scope || owner.id);
          await ownerStore.load();
          let adopted = 0;
          for (const item of Object.values(ownerStore.data?.items ?? {})) {
            if (!item || String(item.by ?? '').trim()) continue;
            if (!String(item.text ?? '').trim()) continue;
            item.by = owner.id;
            item.adoptedAt = Date.now();
            adopted += 1;
          }
          if (adopted) {
            await ownerStore.persist();
            log(`自动认领老描述：${owner.name || owner.id} +${adopted} 张（原来没有归属 ✓）`);
          }
        } catch (error) {
          log('自动认领失败：' + (error?.message ?? error));
        }
      }
    }

    const perFish = clampInt(config.describeBacklogPerSync, 5, 0, 50);
    const route = describe && perFish > 0 ? await resolveModel().catch(() => null) : null;
    let totalNew = 0;
    for (const fish of pets) {
      const scope = fish.scope || fish.id;
      const store = catalogFor(scope);
      await store.load();
      const entries = Object.entries(store.data?.items ?? {});
      const todo = [];
      for (const [id, item] of entries) {
        if (!String(item?.text ?? '').trim()) continue;
        if (String(item.by ?? '') === fish.id) {
          (items[id] ??= {})[fish.id] = { at: item.at ?? null, model: item.model ?? '' };
        } else {
          // 老条目没有 by = 来自共用种子 ✓ → 算"还不是我的" ✓ → 排队补自己的版本 ✓
          todo.push([id, item]);
        }
      }
      let spent = 0;
      if (route) {
        for (const [id, item] of todo.slice(0, perFish)) {
          try {
            await store.describeOne(
              { name: id, mtime: item.mtime ?? Date.now(), sheet: item.sheet || item.file },
              {
                system:
                  IMAGE_DESCRIBE_SYSTEM +
                  (config.describePerFishVoice ? fishVoice(fish) : ''),
                model: route.provider + '/' + route.model,
                force: true,
                by: fish.id,
                prompt:
                  `请给表情包「${id}」写一句索引（给「${fish.name || fish.id}」挑图用）。` +
                  '要写清两件事：① 画面是什么（人物/表情/文字）② 适合在什么场合发。' +
                  '直接给一句通顺的中文，不要分点、不要解释。',
                source: 'vision',
              },
            );
            spent += 1;
            (items[id] ??= {})[fish.id] = { at: Date.now(), model: route.provider + '/' + route.model };
          } catch (error) {
            log(`补描述失败（${fish.id} / ${id}）：` + (error?.message ?? error));
            break; // 连不上模型就别继续烧 ✓
          }
        }
      }
      /** ⚠️ 必须**重新读一遍 store**（上面的 describeOne 刚把 by 写进去 ✗→✓）：
       *  用开头那份 `entries` 快照会永远算出 0 ✗（实测账本里 counts 全是 0 ✓ 就是这个 bug ✓）。 */
      const fresh = Object.entries(store.data?.items ?? {});
      counts[fish.id] = fresh.filter(([, it]) => String(it?.by ?? '') === fish.id).length;
      backlog[fish.id] = todo.length - spent;
      totalNew += spent;
    }
    const out = { version: 1, updatedAt: Date.now(), counts, backlog, items };
    try {
      writeFileSync(join(dataDir, 'image-owners.json'), JSON.stringify(out, null, 2), 'utf8');
    } catch (error) {
      log('归属账本写入失败：' + (error?.message ?? error));
    }
    if (describe && totalNew) {
      log(`补自己的描述：本次 ${totalNew} 张（每张一次视觉调用 ✓）｜各鱼欠账：${JSON.stringify(backlog)}`);
    }
    return out;
  }

  async function syncImages() {
    /**
     * 原版包目录缺失**不能**让整次同步放弃。
     *
     * 用户目录里的图（自己放的 + 按需下载的）与包内目录没有依赖关系。早先这里直接 return，
     * 结果"下载成功却进不了目录"：模型挑了图、图也下来了，但因为目录始终是空的，
     * 后面的名字校验把它当幻觉丢掉 —— 表现就是"配图永远不显示"。
     * 现在：包目录有就读它的描述表，没有就只扫用户目录（功能降级但可用）。
     */
    const upstream = resolveUpstreamRoot();
    const dirs = upstream ? memesDirs(imagesUserRoot, upstream) : [join(imagesUserRoot, 'memes')];
    try {
      /** 把"按旧名索引"的描述改挂到数字 id 上 ✓ */
      const idMap = readImageIdMap();
      const rawDescriptions = {
        ...(upstream ? readPackageMemes(upstream) : {}),
        ...readScrapedDescriptions(imagesUserRoot),
      };
      const descriptions = {};
      for (const [key, value] of Object.entries(rawDescriptions)) {
        descriptions[key] = value;
        const mapped = idMap.byOld[key];
        if (mapped && !descriptions[mapped]) descriptions[mapped] = value;
      }
      const result = await syncImageCatalog({
        store: imageCatalog,
        dirs,
        descriptions,
        describe: async ({ name, file }) => {
          await imageCatalog.describeOne(
            { name, mtime: Date.now(), sheet: file },
            {
              system:
                IMAGE_DESCRIBE_SYSTEM +
                (config.describePerFishVoice ? fishVoice(fishOfScope(imageCatalog.scope || 'current')) : ''),
              model: config.model || '',
              /**
               * **表情包自己的措辞**（原来是动画那套"写索引卡" ✗）：
               * 描述的唯一用途是"模型挑图时能对上语境" ✓，
               * 所以明确要两件事：**画面是什么** + **适合什么场合发** ✓。
               */
              prompt: `请给表情包「${name}」写一句索引（给桌宠挑图用）。`
                + '要写清两件事：① 画面是什么（人物/表情/文字）② 适合在什么场合发。'
                + '直接给一句通顺的中文，不要分点、不要解释。',
              by: (fishOfScope(imageCatalog.scope || 'current') || {}).id || '',
              source: 'vision',
            },
          );
        },
        log,
      });
      /**
       * **每条鱼的目录都同步**（主人要求"图库可以一样"✓）：
       * 图片文件共享 ✓、描述各存各的 ✓。
       * 这里给其它鱼跑一遍，**只吃离线描述**（不传 describe ✓ = 不会调视觉模型 ✓），
       * 所以顺带同步不额外花钱 ✓。
       */
      for (const store of imageCatalogs.values()) {
        if (store === imageCatalog) continue;
        try {
          const other = await syncImageCatalog({ store, dirs, descriptions });
          if (other.added || other.purged) {
            log(`图库同步（另一条鱼）：新增 ${other.added} 张、清僵尸 ${other.purged} 条`);
          }
        } catch (error) {
          log('图库同步（另一条鱼）失败：' + (error?.message ?? error));
        }
      }

      /**
       * **归属账本 + 补自己的描述**（主人的规则 ✓）：
       *   · 图片共用 ✓（文件只有一套数字编号 ✓），但**描述分家** ✓ —— 谁用谁的版本 ✓
       *   · 抓图入库时**先查重** ✓（有就不重复存 ✓ —— syncImageCatalog 就是这么做的 ✓）
        *   · 只要图在库里、而这条鱼**还没写过自己的版本** ✓ → 补一张自己的 ✓
        *     （每鱼每轮上限 `describeBacklogPerSync` ✓ 每张一次视觉调用 ✓ 花钱的事必须封顶 ✓）
        *
        * ⚠️ **再加一道时间闸**（10 分钟最多一轮 ✓）：
        * 同步不只发生在启动时 ✗ —— 群里来一张图也会触发同步 ✓（每张一次 ✓），
        * 没有时间闸的话，"补描述"会跟着每张群图跑一遍 ✗ → 一张群图烧掉 2×5 次视觉调用 ✗✗。
       */
      const backlogBudget = Date.now() - lastBacklogAt >= BACKLOG_MIN_MS;
      await refreshImageOwners({ describe: backlogBudget });
      if (backlogBudget) lastBacklogAt = Date.now();
      imageState.synced = result.total;
      imageState.added = result.added;
      imageState.described = result.described;
      imageState.lastSyncAt = Date.now();
      // 包目录缺失不致命，只留提示（用户目录的图照样能用）
      imageState.error = upstream ? '' : '没找到原版 dsh-pet 包目录（只扫用户目录；可用配置 upstreamRoot 指定）';
    } catch (error) {
      imageState.error = String(error?.message ?? error);
      log('表情包目录同步失败：' + imageState.error);
    }
    return imageState;
  }
  // 启动时同步一次（不阻塞加载：读目录+写文件都很轻，但没必要卡住插件启动）
  void syncImages();

  /** 建库进度（界面用） */
  const buildState = { running: false, startedAt: null, total: 0, done: 0, failed: 0, current: '', errors: [] };

  const state = {
    startedAt: Date.now(),
    running: false,
    paused: !config.enabled,
    pauseReason: config.enabled ? '' : '启动配置里 enabled=false',
    pausedAt: config.enabled ? null : Date.now(),
    capturing: false,
    speaks: 0,
    compactions: 0,
    errors: [],
    lastCaptureAt: null,
    lastCaptureInfo: '',
    lastFrameAt: null,
    lastSpeakAt: null,
    lastPhrase: '',
    lastDecision: '',
    lastAnim: '',
    lastFrameBytes: 0,
    idleMs: null,
    backoff: 1,
    fork: { alive: false, lastProbeAt: null, lastLaunchAt: null, lastMessage: '' },
    game: {
      source: '',
      newEvents: 0,
      importantSeen: 0,
      reactions: 0,
      lastReactionAt: null,
      lastImportant: '',
      /** 最近一次收到游戏事件的墙钟毫秒（空闲退避的第二个判据） */
      lastEventAt: 0,
    },
    /** 宠物自己的名字（取自副本 /gw/brand；改名后最多 30 秒跟上，提示词里的身份行随之改） */
    selfName: '',
    database: { source: '', lookups: 0, rounds: 0, lastQuery: '', lastHits: [] },
    lastModelMs: null,
    lastModelError: '',
    lastPetSyncAt: null,
  };

  // 事件读取器要碰 state，所以第一次调用必须在这里（state 声明之后）。
  // 放在前面会 TDZ 报错（Cannot access 'state' before initialization），插件就起不来了。
  buildGoh();

  /** 机制数据库（两级：速查常驻 + 完整库按需检索） */
  let db = null;
  function buildDb() {
    db =
      isDatabaseSourceOn(config.databaseSource)
        ? new MechanicsStore({
            quickFile: config.mechanicsQuickFile,
            fullFile: config.mechanicsFile,
            maxChars: config.mechanicsMaxChars,
            log,
          })
        : null;
    state.database.source = config.databaseSource || '';
    if (db) {
      const info = db.status();
      log(`机制库已启用：速查 ${info.quickChars} 字常驻，完整库 ${info.sections} 节按需检索`);
    }
    return db;
  }
  buildDb();

  /**
   * 错误只保留**最近 30 分钟**，并且**任何一次成功都会清空**：
   * 胶囊的红灯判据是"errors 非空" ✗ —— 以前只进不出，一次网络抖动就永远红 ✔（主人报过）。
   * 原文都能在 plugin.log 里翻到，界面只需要表达"现在还正常吗"。
   */
  const ERROR_TTL_MS = 30 * 60_000;
  const pruneErrors = () => {
    const cutoff = Date.now() - ERROR_TTL_MS;
    state.errors = state.errors.filter((e) => Number(e?.at ?? 0) >= cutoff);
  };
  const clearErrors = () => {
    if (state.errors.length) state.errors = [];
    state.lastModelError = '';
  };
  const pushError = (scope, error) => {
    const message = error instanceof Error ? error.message : String(error);
    pruneErrors();
    state.errors.push({ at: Date.now(), scope, message });
    if (state.errors.length > 20) state.errors.splice(0, state.errors.length - 20);
    log(scope + ': ' + message);
  };

  // ---------------------------------------------------------------- 模型

  async function resolveModel() {
    // ① 设置页里显式指定（modelSource = custom）：这是"菜单报 api 非法"的正解 ——
    //    默认会话模型落到了一把失效的 key，这里可以直接钉死走 deepseek-account。
    if (config.modelSource === 'custom' && config.modelProvider && config.model) {
      return { provider: config.modelProvider, model: config.model };
    }
    // ② 老的 provider/model 配置（向后兼容）
    if (config.provider && config.model) return { provider: config.provider, model: config.model };
    // ③ 都没有 → 跟随 DSH 会话默认模型
    const picker = ctx.get?.('agentDefaultModel');
    const current = picker?.currentSelection?.();
    if (current?.provider && current?.model) return { provider: current.provider, model: current.model };
    return undefined;
  }

  /**
   * @param {object} [fish] 这条鱼的配置（方案2 ✓）；给了就用它的人设覆盖 ✓
   *   —— 没给就还是全局 `config.personality` / `config.rules` ✓（向后兼容 ✓）
   */
  function buildSystemPrompt(operatorText, mem = memory, fish = null) {
    const memoryBlock = mem.contextBlock(config.memoryRecentTurns);
    const fishPersonality = typeof fish?.personality === 'string' && fish.personality ? fish.personality : config.personality;
    const fishRules = typeof fish?.rules === 'string' && fish.rules ? fish.rules : config.rules;
    const lines = [
      fishPersonality,
      '',
      '你的任务是看画面，决定要不要对主人说点什么。规则：',
      // 按鱼取（2026-10-19 修：这里原来写的是 config.rules，per-fish 的 rules 被算出来了却没用上）
      fishRules,
    ];
    if (memoryBlock) {
      lines.push('', '你对主人的记忆（延续之前的相处，不要装作第一次见）：', memoryBlock);
    }
    /**
     * **群里说话不透露技术细节**（主人要求）。
     *
     * 起因：它在群里说过"0.7.20 上线了""apikey"这类话 ✗ —— 那些是主人跟它调试时的对话内容，
     * 群友看到的应该只是**一只在聊天的宠物** ✓，不该冒出插件版本、日志、报错、token、API 这些词 ✗。
     * 这条对所有场合都成立（桌面上也不该念这些），所以放系统提示词里常驻 ✓。
     */
    lines.push(
      '',
      '【说话分寸】无论是群里还是桌面上，都不要提插件、版本号、日志、报错、token、API、模型名字这类技术细节；',
      '也不要复述主人跟你调试程序时说的话（那是私下的）。你就一只会聊天的宠物：说人话、聊眼前的事。',
      '如果群里有人在聊这些技术话题，你可以表示"听不懂喵"，但**不要跟着念** ✗。',
    );
    /**
     * 机制库**速查版**：常驻系统提示词。
     *
     * 为什么放系统提示词而不是用户消息：它是**静态文本**（不会每轮变），放这里只付一次缓存写入，
     * 之后每轮命中缓存（实测 99.7%），几乎不要钱；放用户消息反而会破坏前缀缓存。
     * 完整库（37KB/435 行）不进来，由模型按需调用 goh_mechanics 工具检索。
     */
    /**
     * 身份行（名字）放在系统提示词里：它是**半静态**的（只有改名才变），
     * 放前缀里靠缓存几乎免费；而模型确实需要知道"我叫什么"。
     */
    /**
     * **身份行用这条鱼自己的名字**（2026-10-19 修）：state.selfName 是业务主鱼（7341）的名字，
     * 拿它拼提示词会让 7342 的请求里写着"你的名字是「鱼板妹妹7341」" —— 两条鱼都以为自己叫 7341。
     */
    const selfNameForPrompt = String(fish?.name ?? '').trim() || state.selfName;
    const identity = selfIdentityLine(selfNameForPrompt);
    if (identity) lines.push('', identity);
    if (db) {
      const quick = db.quickBlock();
      if (quick) lines.push('', quick);
    }
    /**
     * 表情包清单：像动画目录一样是**静态文本**，放系统提示词里靠缓存几乎免费。
     * 模型从这份清单里挑一张填 img 字段（名字必须原样照抄，否则会被丢弃）。
     */
    if (config.imageInPrompt) {
      /** **这条鱼自己的**描述目录 ✓（同图不同描述，互不污染 ✓） */
      const ownStore = catalogFor(fish?.scope || '');
      /**
       * **只放"自己名下"的图** ✓（主人的规则原话："每条鱼只能调用自己记录里有的" ✓）。
       *
       * 判定：`item.by === 这条鱼的 id` ✓。
       * 为什么需要：图库是共用的 ✓，共用种子（包内描述）会出现在每条鱼的目录里 ✗ ——
       * 不去掉的话，两条鱼等于共用同一套清单 ✗，各自生成的描述也就白写了 ✓。
       *
       * 兜底：一条都还没写过（新装的鱼 / 刚开始跑 ✓）→ 仍然给整份 ✓，
       * 否则它连一张图都挑不出来 ✗（宁可先用共用种子 ✓，等补描述跟上再收窄 ✓）。
       */
      const owned = Object.entries(ownStore.data?.items ?? {}).filter(
        ([, it]) => String(it?.by ?? '') === String(fish?.id ?? ''),
      );
      const listing =
        owned.length > 0
          ? { ...ownStore, data: { ...ownStore.data, items: Object.fromEntries(owned) } }
          : ownStore;
      const block = imagePromptBlock(listing, config.imageLimit);
      if (block) lines.push('', block);
    }
    // 动画目录：模型据此**点名**要播哪段动画（描述是离线生成并缓存的，这里只读文本）
    if (config.catalogInPrompt) {
      const names = Object.keys(catalog.snapshot().items);
      const limited = config.catalogLimit > 0 ? names.slice(0, config.catalogLimit) : names;
      const block = catalog.promptBlock(limited);
      if (block) {
        lines.push(
          '',
          '你可以点播的动画（每条是「文件名：动作」；想让它播哪段就在输出里写 anim 字段）：',
          block,
        );
      }
    }
    lines.push(
      '',
      '输出格式（只输出一行，不要任何其它内容）：',
      `- 不说话：${SILENCE}`,
      '- 说话：{"say":"台词","anim":"想让它播的动画文件名（可选，不播就省略）","img":"想配的表情包名（可选，不配就省略）","toGroup":true,"remember":"以后要长期记住的一句话（可选）","bold":true,"size":"l"}',
      '例如：{"say":"这关我熟，冲！","anim":"点击回应-元气挥手"}',
      /**
       * **粗体 / 字号**（2026-10-23）：给气泡一点层次，别整句都放大。
       * 也给了一条"什么时候别用"的建议，免得它每句都加大加粗。
       */
      'bold 和 size 是**可选的排版**：bold:true 整句加粗；size 取 s / m / l / xl（默认 m）。',
      '用在真的需要强调的那一句上（惊讶、喊人、关键提示）；平常聊天别用，不然满屏大字。',
      '行内也可以用 **两个星号** 包住几个字来加粗。',
      'anim 只能填上面清单里出现过的文件名；不确定就别填（宁可不播，也别播错）。',
      'img 同理：只能填表情包清单里出现过的名字，不合适就不填（宁可不配图）。',
      'remember 是**给未来的自己留条子**：主人交代过的事、某个长期习惯、卡了很久的关卡、重要约定，',
      '这类"过一会儿短期窗口就滑走了"的信息才填，一句话、不要写流水账；一次最多一条，没必要就省略。',
      'toGroup 是**可选的**：只有当"这句话让群里的人也看到会更有意思"时才填 true',
      '（比如接得上群里刚聊的话题、或一句你自己觉得好笑的吐槽）。',
      '系统另外还有两道闸：群里最近 30 分钟得有人说活、且距你上次主动发群至少 5 分钟；',
      '不满足就不发（那是系统的判断，不是你的失误）。**拿不准就别填**——宁可在气泡里说，也别去群里刷。',
      '如果你的输出没法构造成 JSON，就只写台词本身，不要引号。',
      /**
       * **接话**（2026-10-21）：让"一次回答多说几句"这件事有一条明确通道。
       * 剩余次数写在提示词里（每轮接话时还会在用户消息里再提醒一次），
       * 上限 0 时这里整段不出现，模型连这个工具都拿不到。
       */
      ...(Math.max(0, Math.min(8, Number(config.chainMax ?? 0))) > 0
        ? [
            '',
            '**接话**：一句说不完、或者想先吐槽再补一句时，可以调用工具 `speak_again`——',
            '每调用一次就代表"再说下一句"，然后你会被要求再输出一个 JSON（还是同样的格式）。',
            `每轮回答最多接 ${Math.max(0, Math.min(8, Number(config.chainMax ?? 0)))} 次，剩余次数会写在消息里。`,
            '**没有话要接着说就别调用**；只是把一句话说长，不要拆成好几条。',
          ]
        : []),
    );
    if (operatorText) lines.push('', `注意：主人这次是在直接问你话，必须回答，不要再输出 ${SILENCE}。`);
    return lines.join('\n');
  }

  /** 跑一次模型，返回纯文本输出 */
  /**
   * 单次流式调用：收集文本与**工具调用**。
   *
   * 工具调用在流里以两种形态出现：`tool-call-delta`（增量片段）和 `block-end`
   * （一个完整的 `tool-call` 块）。优先用后者（它是组装好的），只有遇到"只给增量"的
   * 适配器时才用增量拼装兜底 —— 两条路都留着，换 provider 时不会突然拿不到参数。
   */
  async function streamOnce({ route, system, messages, tools, signal, reasoning }) {
    let text = '';
    let usage;
    /** index → {id, name, args} */
    const partial = new Map();
    const completed = new Map();

    /**
     * **抓取"发出去的原始请求"**（主人要拿去和基线对比 ✓）。
     *
     * 为什么要在这里抓：`ctx.llm.stream()` 的参数**就是**发给模型层的原始载荷 ✓
     * （provider / model / system / messages / tools ✓）—— 这是唯一权威的一手材料 ✓，
     * 比事后凭代码"重演"一份系统提示词可靠得多 ✓（重演容易漏掉动态块 ✗）。
     *
     * 每次调用覆盖写 `last-request.json` ✓（图片只记**数量与类型**，不塞 base64 ✗ 否则文件几 MB ✓）。
     */
    if (config.captureLastRequest) {
      try {
        /**
         * **按鱼各存一份** ✓（`last-request-<鱼的id>.json`）：只存一份的话，
         * 后一条鱼的请求会把前一条覆盖掉 ✗ —— 想单独看某条鱼"到底收到了什么提示词"就看不到 ✓。
         * 仍然同时更新 `last-request.json`（兼容旧脚本 ✓）。
         */
        const fishTag = String(state.currentFishId || '').replace(/[^\w.-]+/g, '_');
        if (fishTag) {
          try {
            writeFileSync(
              join(dataDir, `last-request-${fishTag}.json`),
              JSON.stringify(
                { at: new Date().toISOString(), fish: fishTag, route: { provider: route.provider, model: route.model }, system, messages, tools: tools ?? [] },
                null,
                2,
              ),
              'utf8',
            );
          } catch {
            /* 抓取失败不影响主流程 */
          }
        }
        writeFileSync(
          join(dataDir, 'last-request.json'),
          JSON.stringify(
            {
              at: new Date().toISOString(),
              route: { provider: route.provider, model: route.model },
              system,
              messages: (messages ?? []).map((m) => ({
                role: m.role,
                content: Array.isArray(m.content)
                  ? m.content.map((part) =>
                      part?.type === 'image'
                        ? { type: 'image', attachmentId: part.attachment?.id ?? part.attachment ?? '(unknown)' }
                        : part,
                    )
                  : m.content,
              })),
              tools: tools ?? [],
            },
            null,
            2,
          ),
          'utf8',
        );
      } catch (error) {
        log('抓取原始请求失败：' + (error?.message ?? error));
      }
    }

    const stream = ctx.llm.stream({
      provider: route.provider,
      model: route.model,
      system,
      messages,
      ...(tools && tools.length ? { tools } : {}),
      /** 思考档位：只在确认该模型支持这个值时才传（见 reasoningForRoute） */
      ...(reasoning ? { reasoningEffort: reasoning } : {}),
      signal,
    });

    for await (const chunk of stream) {
      if (chunk.type === 'text-delta') {
        text += chunk.text;
      } else if (chunk.type === 'usage') {
        // 用量记账：这是"这次问模型到底花了多少"的唯一权威来源（估算永远差一截）
        usage = {
          inputTokens: Number(chunk.usage?.inputTokens ?? 0),
          outputTokens: Number(chunk.usage?.outputTokens ?? 0),
          totalTokens: Number(chunk.usage?.totalTokens ?? 0),
          cacheReadTokens: Number(chunk.usage?.cacheReadTokens ?? 0),
        };
      } else if (chunk.type === 'tool-call-delta') {
        const key = Number.isFinite(chunk.index) ? chunk.index : 0;
        const slot = partial.get(key) ?? { id: chunk.id ?? '', name: '', args: '' };
        if (chunk.id) slot.id = chunk.id;
        if (chunk.name) slot.name = chunk.name;
        slot.args += chunk.argumentsDelta ?? '';
        partial.set(key, slot);
      } else if (chunk.type === 'block-end' && chunk.block?.type === 'tool-call') {
        completed.set(chunk.index ?? completed.size, {
          id: chunk.block.id,
          name: chunk.block.name,
          args: chunk.block.arguments ?? '',
        });
      } else if (chunk.type === 'finish' && (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted')) {
        throw new Error('模型调用失败：' + (chunk.reason.failure?.message ?? chunk.reason.kind));
      }
    }

    const toolCalls = [...(completed.size ? completed.values() : partial.values())]
      .filter((call) => call && call.name)
      .map((call) => ({ id: call.id, name: call.name, arguments: call.args }));

    return { text, usage, toolCalls };
  }

  /** 用量跨轮相加（一次回答可能包含"查询→再答"多轮 API 调用，成本要算全） */
  function mergeUsage(total, one) {
    if (!one) return total;
    if (!total) return { ...one };
    return {
      inputTokens: total.inputTokens + one.inputTokens,
      outputTokens: total.outputTokens + one.outputTokens,
      totalTokens: total.totalTokens + one.totalTokens,
      cacheReadTokens: total.cacheReadTokens + one.cacheReadTokens,
    };
  }

  /** 解析工具参数里的 query（模型给的是 JSON 字符串；解析不了就把原文当关键词） */
  function parseToolQuery(rawArguments) {
    try {
      const parsed = JSON.parse(rawArguments || '{}');
      const query = parsed?.query;
      if (typeof query === 'string' && query.trim()) return query.trim();
    } catch {
      /* 落到兜底 */
    }
    return String(rawArguments ?? '').slice(0, 200).trim() || '机制';
  }

  /**
   * 一次模型调用（含**按需查询机制库**的工具循环）。
   *
   * 机制库是两级设计：
   *   - 速查版一直带在**系统提示词**里（静态文本，靠缓存几乎免费）→ 常见问题不用查；
   *   - 完整库 37KB 不进上下文，模型不确定时调用 `goh_mechanics`，插件检索出相关章节回给它。
   *
   * 工具结果用**一条新的 user 消息**回传，而不是构造 assistant/tool 消息对。
   * 为什么：assistant/tool 消息需要精确的 id/source/replayState 形状，猜错就是 provider 报错；
   * 而 `ctx.llm.stream` 是从我这侧无状态发起的，每次都是独立请求，多带一条 user 消息
   * 就能表达"这是查询结果"，形状是我已经验证可行的那种。
   */
  async function runModel({ system, text, withImage, images = [], reason = '', mediaType }) {
    const route = await resolveModel();
    if (!route) throw new Error('没有可用的模型：请在本插件配置里写 provider/model，或先给会话选一个默认模型');
    const content = [{ type: 'text', text }];
    /**
     * **多图**（`images: [路径]`）：淘汰表情包时要让它"同时看几张图再抉择" ✓。
     * 保留原来的 `withImage`（单图）路径，两者可叠加 ✓。
     */
    for (const one of [withImage, ...images].filter(Boolean)) {
      const bytes = await readFile(one);
      /**
       * `mediaType` 要跟着**真实格式**走：截图是 png ✓，但 QQ 群里下的图可能是 webp/jpeg/gif ✗。
       * 写死 png 会让附件/模型层报"格式对不上"（实测：QQ 发 webp 时描述直接失败 ✗）。
       * 调用方能给出真实类型就按它来，否则回落到按扩展名猜。
       */
      const ext = (one.match(/\.([a-z0-9]+)$/i)?.[1] ?? 'png').toLowerCase();
      const guessMime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : `image/${ext}`;
      const attachment = await ctx.attachments.saveImage({
        data: new Uint8Array(bytes),
        mediaType: mediaType ?? guessMime,
      });
      // 记账：这是后面"自动回收"唯一的依据（DSH 没有删除接口，只能自己认自己的）
      attachmentGc?.record(attachment);
      content.push({ type: 'image', attachment });
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.modelTimeoutMs);
    const started = Date.now();
    const messages = [{ role: 'user', content }];
    /**
     * 工具清单：机制库查询（选了数据库时）+ 表情包检索（配图开启时）。
     * 表情包工具让模型**自己去 2000+ 张的图库里搜**，不必受限于本地已有的那几十张。
     */
    const tools = [];
    if (db) tools.push(MECHANICS_TOOL);
    if (config.imageInPrompt !== false && config.memeSearch !== false) tools.push(MEME_TOOL);
    /**
     * 接话：算了上限才把工具给出去（上限 0 = 它连这个选项都看不到）。
     */
    const chainMax = Math.max(0, Math.min(8, Number(config.chainMax ?? 0)));
    if (chainMax > 0) tools.push(SPEAK_AGAIN_TOOL);
    const maxRounds = Math.max(1, Math.min(5, Number(config.mechanicsLookupRounds ?? 3)));
    /** 本轮它有没有请求"再说一句"（由 consultModel 决定要不要真去写下一句） */
    let chainRequested = false;
    const reasoning = await reasoningForRoute(route);
    let raw = '';
    let usage;
    let rounds = 0;

    try {
      for (let round = 1; ; round += 1) {
        rounds = round;
        /**
         * 调用计数（排障"一次操作打了多少次 API"）。
         * 用户报过"暂停时发送消息会疯狂调用 API"，所以必须能直接数出来。
         * 现在**每轮都计一次**：带工具时一次回答确实可能是 2~3 次真实 API 调用，成本要如实反映。
         */
        state.modelCalls = (state.modelCalls || 0) + 1;
        state.modelCallLog = state.modelCallLog || [];
        state.modelCallLog.push({
          at: Date.now(),
          // **为什么调用**：排障"有时候很神秘地调用 API"靠这一列，不用猜。
          // interval=周期看画面 / game-event=重要事件 / ask=主人说话 / tool=机制库查询的后续轮 / compact=记忆压缩
          reason: reason || 'unknown',
          withImage: Boolean(withImage),
          textChars: String(text ?? '').length,
          round,
          tools: Boolean(tools),
        });
        if (state.modelCallLog.length > 200) state.modelCallLog.shift();

        const one = await streamOnce({ route, system, messages, tools, signal: controller.signal, reasoning });
        if (one.text.trim()) raw = one.text;
        usage = mergeUsage(usage, one.usage);

        /**
         * **接话**：这一轮它请求"接着说下一句"。
         *
         * 这里**不动 messages、不续写**：只把"它想接话"这个意图带出去，
         * 由 consultModel 另开一次独立请求写下一句（见那里的说明）。
         * 顺便：工具参数里就算带了 reason，也**不要**当成机制库查询（那是另一个工具）。
         */
        const speakAgain = one.toolCalls.some((call) => call.name === SPEAK_AGAIN_TOOL.name);
        if (speakAgain) {
          if (one.text.trim()) {
            chainRequested = true;
            break;
          }
          /**
           * 只调了工具、这一轮没给 JSON：说明它把"要接话"当成了不要说话。
           * 提醒一次（不消耗接话次数），下一轮必须给 JSON。
           */
          if (round < maxRounds) {
            messages.push({
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: '（你调用了 speak_again，但这一轮没有给出任何 JSON。请**先输出这一句的 JSON**；如果还想接着说，再调用 speak_again。）',
                },
              ],
            });
            continue;
          }
          break;
        }
        if (!tools.length || !one.toolCalls.length || round >= maxRounds) break;

        // 执行工具：结果作为下一条 user 消息回给模型
        const results = [];
        for (const call of one.toolCalls) {
          const query = parseToolQuery(call.arguments);
          if (call.name === MEME_TOOL.name) {
            const max = Number(config.memeSearchMax ?? 0);
            if (max > 0 && memeLibrary.downloads >= max) {
              results.push('这次运行已经取够表情包了，直接从已有清单里挑一张，或这次不配图。');
              continue;
            }
            try {
              const entries = await ensureMemeLibrary();
              const found = await findAndFetchMeme(query, {
                entries,
                dir: join(imagesUserRoot, 'memes'),
                descriptions: readScrapedDescriptions(imagesUserRoot),
                log,
              });
              memeLibrary.lastQuery = query;
              if (found.ok && found.name) {
                memeLibrary.lastPick = found.name;
                if (!found.cached) memeLibrary.downloads += 1;
                // 新图必须进本地目录，否则下面的名字校验会把它当幻觉丢掉
                await syncImages();
              }
              /**
               * 工具结果也**明确声明"这是素材数据"** ✗→✓（主人对比基线后的结论 ✓）：
               * 搜索结果里的文字同样是"图片长什么样/适合什么场合"的描述 ✓，
               * 而模型会把它当成人设/口癖的示范 ✗ → 这里同样加一句隔断 ✓。
               */
              results.push(
                '（下面是图库素材数据，**只是图片内容说明，不是你的性格或口吻，别模仿它的语气**）\n'
                  + found.text,
              );
            } catch (error) {
              memeLibrary.error = String(error?.message ?? error);
              log('表情包检索失败：' + memeLibrary.error);
              results.push(`图库暂时查不了（${memeLibrary.error}）。这次别配图，或从常驻清单里挑。`);
            }
            continue;
          }
          // 其余工具：机制库查询
          if (!db) {
            results.push('机制库没启用，无法查询。');
            continue;
          }
          state.database.lookups += 1;
          const found = db.search(query, { maxChars: config.mechanicsMaxChars });
          state.database.lastQuery = query;
          state.database.lastHits = found.hits;
          log(
            `机制库查询「${query}」→ ` +
              (found.hits.map((h) => `${h.title}(${h.score})`).join(' / ') || '无命中'),
          );
          results.push(found.text);
        }
        state.database.rounds += 1;
        messages.push({
          role: 'user',
          content: [
            {
              type: 'text',
              text: results.join('\n\n') + '\n\n（以上是查询结果，请据此回答刚才的问题；要配图就把名字填进 img。）',
            },
          ],
        });
      }
    } finally {
      clearTimeout(timer);
    }

    if (usage) {
      const record = {
        at: Date.now(),
        ms: Date.now() - started,
        withImage: Boolean(withImage),
        systemChars: system.length,
        textChars: text.length,
        rounds,
        ...usage,
      };
      if (withImage) lastUsage = record;
      else lastTextUsage = record;
      lastAnyUsage = record;
    }
    return { raw, ms: Date.now() - started, usage, rounds, chainRequested };
  }

  /** 看画面 → 裁决要不要说话 */
  /**
   * 把配置里的思考档位翻译成**这个模型真正支持的**值。
   *
   * 为什么不能硬塞：合法档位是每个模型自己声明的（off/low/high/max 各家不同），
   * 塞一个不认识的字符串，provider 会直接拒掉整次调用 —— 那就从"不思考"变成"不说话"了。
   * 规则：配置为空 → 不传（用 provider 默认）；有值但不在清单里 → 不传并记一行日志。
   */
  const reasoningCache = new Map();
  async function reasoningForRoute(route) {
    const want = String(config.modelThinking ?? '').trim();
    if (!want) return undefined;
    const key = route.provider + '/' + route.model;
    let info = reasoningCache.get(key);
    if (info === undefined) {
      try {
        info = await ctx.llm.resolveModelInfo(route.provider, route.model);
      } catch {
        info = null;
      }
      reasoningCache.set(key, info ?? null);
    }
    const efforts = info?.reasoning?.efforts ?? [];
    if (!efforts.length) {
      log('这个模型没声明思考档位（' + key + '），思考按 provider 默认走');
      return undefined;
    }
    const hit = efforts.find((e) => String(e.id) === want);
    if (!hit) {
      log('思考档位「' + want + '」不在 ' + key + ' 的支持列表里（可用：' + efforts.map((e) => e.id).join('/') + '），本次用默认');
      return undefined;
    }
    return want;
  }

  async function consultModel(pngFile, operatorText, masterTo = '', reason = '', mem = memory, scope = '', fish = null) {
    /**
     * 游戏事件上下文放在**用户消息**里，而不是系统提示词里。
     *
     * 为什么：系统提示词是稳定前缀（含 106 条动画目录那一大块），命中缓存后几乎免费
     * （实测缓存命中 99.7%）。一旦把每轮都在变的游戏事件塞进去，前缀就一直变、缓存全废。
     * 放在用户消息里则是每轮本来就不同的部分，不额外损失缓存。
     */
    /**
     * 用 `promptBlockFresh()`：它会消费"新鲜度" —— 没有新事件时明确告诉模型
     * "自上次以来没有新事件，下面是旧事、别当新闻再讲"（修"一直反应之前的事情"）。
     * 这里是观察循环，每轮调一次正好；**只读接口不要调它**，否则会把新鲜度吃掉。
     */
    const gameBlock = goh && config.gohRecentLines > 0 ? goh.promptBlockFresh(config.gohRecentLines) : '';
    /**
     * 这条鱼**自己的名字**（没有就退回业务主鱼）——
     * 鱼板时间线里"标「我」的就是你"、用户消息里"你是「X」"都用它，
     * 否则 7342 的请求会写着"你是「鱼板妹妹7341」"。
     */
    const selfNameForPrompt = String(fish?.name ?? '').trim() || state.selfName;
    /**
     * 鱼板网络的时间线也放用户消息里（它每轮都在变）。
     * 与游戏事件同理：系统提示词是缓存前缀，塞变化内容会把 99.7% 的缓存命中打没。
     */
    /** 按会话隔离取鱼板内容 ✓（桌面看不到 QQ 各会话，会话之间也互相看不到 ✗→✓） */
    const boardBlock = board
      ? timelineBlock(board.timeline(12), { limit: 8, selfName: selfNameForPrompt || board.selfName, scope })
      : '';
    const question = composeQuestion({ operatorText, gameBlock, boardBlock, masterTo, selfName: selfNameForPrompt });
    const systemPrompt = buildSystemPrompt(operatorText, mem, fish);
    const firstRun = await runModel({
      system: systemPrompt,
      text: question,
      withImage: pngFile,
      // 由调用方说明原因；没说明就按"有 operatorText 就算主人说话，否则算周期观察"兜底
      reason: reason || (operatorText ? 'ask' : 'interval'),
    });
    const { raw } = firstRun;
    let ms = firstRun.ms;
    /**
     * **接话**：它要求"再说一句"时，**另开一次独立请求**写下一句。
     *
     * 为什么不在同一个请求里续写：那需要伪造 assistant(+tool-call) 消息再继续，
     * DSH 的适配层会报 `Cannot read properties of undefined (reading 'replayState')`（实测踩到）。
     * 独立请求还顺带满足"每轮最终输出只有一个 JSON"：每一句都是一次完整回答。
     */
    const chainMax = Math.max(0, Math.min(8, Number(config.chainMax ?? 0)));
    const utterances = [];
    let chainWanted = Boolean(firstRun.chainRequested);
    let chainLeft = chainMax;
    let lastPhrase = parseDecision(raw, config.maxChars).phrase || '';
    while (chainWanted && chainLeft > 0) {
      chainLeft -= 1;
      const hint =
        `（接话：你上一条已经说的是「${lastPhrase || '(没说)'}」。` +
        '现在**接着说下一句新的**，不要重复刚才那句，也不要复述它；' +
        '仍然只输出一个 JSON。' +
        `剩余接话次数：${chainLeft}${chainLeft === 0 ? '（这次是最后一句）' : ''}）`;
      const run = await runModel({
        system: systemPrompt,
        text: question + '\n\n' + hint,
        withImage: pngFile,
        reason: 'chain',
      });
      ms += run.ms;
      const decision = parseDecision(run.raw, config.maxChars);
      if (!decision.phrase) break;
      utterances.push(String(run.raw ?? '').trim());
      lastPhrase = decision.phrase;
      chainWanted = Boolean(run.chainRequested);
      state.chained = (state.chained || 0) + 1;
    }
    state.lastModelMs = ms;
    clearErrors(); // 这一次成功了：红灯（过去的失败）不该继续亮
    const decision = parseDecision(raw, config.maxChars);
    /**
     * **接话**：前面几轮说的是"同一件事的前几句"，按顺序排队。
     * 每一句都单独解析（各自一个 JSON），`remember` 也各自生效。
     */
    const followUps = [];
    for (const one of utterances ?? []) {
      const d = parseDecision(String(one), config.maxChars);
      if (!d.phrase) continue;
      if (d.remember && config.memoryAllowSelfNote !== false) {
        try {
          await mem.appendLongTerm(d.remember, { limit: config.memoryLongTermChars });
        } catch {
          /* 记不住不影响说话 */
        }
      }
      followUps.push({ text: d.phrase, anim: d.anim, img: d.img, toGroup: d.toGroup === true, style: d.style ?? {} });
    }
    /**
     * **模型自己记一条长期记忆**（2026-10-19）：短期窗口只有 memoryRecentTurns 条，
     * 重要的约定很容易被挤出上下文；给它一个"留条子"的口子。
     * 重复的会被 appendLongTerm 挡掉；超上限就顺手压一次。
     */
    if (decision.remember && config.memoryAllowSelfNote !== false) {
      try {
        const added = await mem.appendLongTerm(decision.remember, { limit: config.memoryLongTermChars });
        if (added.added) {
          state.lastSelfNote = { at: Date.now(), text: decision.remember, overflow: Boolean(added.overflow) };
          log('它自己记了一条长期记忆：' + decision.remember.slice(0, 60));
          if (added.overflow) void compactMemory(true, mem, fish).catch(() => {});
        }
      } catch (error) {
        log('写长期记忆失败：' + (error?.message ?? error));
      }
    }
    state.lastDecision = decision.phrase ? 'speak' : 'silent';
    if (decision.anim) state.lastAnim = decision.anim;
    /**
     * ⚠️ `img` **必须**带出去。
     *
     * 踩过的坑：这里曾经只返回 speak/text/anim/raw，于是调用点的 `decision.img` 永远是 undefined ——
     * 模型明明在输出里填了 img，配图却永远不显示；而"直接 POST /gpw/say 带 image"却完全正常。
     * 表现就是"实战渲染不出来、我手动测却没问题"，排查时极容易误判成客户端或路由的问题。
     */
    if (decision.img) state.imgAsked = (state.imgAsked || 0) + 1;
    return {
      speak: Boolean(decision.phrase),
      text: decision.phrase,
      anim: decision.anim,
      img: decision.img,
      /**
       * ⚠️ `toGroup` **必须原样带出来**（主人报"随便看一眼的功能从没从群聊里发出去"）：
       * `parseDecision` 解析了它 ✓，但这里组装返回值时漏了 ✗ →
       * `replyOnce` 里 `decision.toGroup` 永远是 undefined ✗ →
       * "定时群读"和"它主动发群"两条路都被判成"它不想说" ✗✗ → 一句都发不出去 ✓。
       * 教训：**解析出来 ≠ 传出去**，中间每一层都要核 ✓。
       */
      toGroup: decision.toGroup === true,
      /** 气泡样式（粗体/字号），没填就是 {} */
      style: decision.style ?? {},
      /** 接话：按顺序排队的后续几句（每句一个 JSON，已经解析好） */
      followUps,
      raw,
      ms,
    };
  }

  /** 把最近的往来压进长期记忆（模型自己写，主人也可以在界面里改） */
  /**
   * @param {object} [fish] 这条鱼（方案2 ✓）—— 给了就用**它自己的人设**参与压缩 ✓
   *   为什么必须带：长期记忆是"它自己总结自己" ✓；压缩提示词原来只有全局
   *   `compactSystem` ✗ → 两只鱼总结出来的口吻/视角会**趋同** ✓（主人明确提过 ✓）。
   */
  async function compactMemory(force, mem = memory, fish = null) {
    await mem.load();
    const list = force
      ? mem.recent(Math.max(config.memoryRecentTurns, config.compactEvery || 10))
      : mem.turnsSinceCompaction(config.compactEvery);
    if (!force && !list) return { ok: false, message: '还没有攒够新的来往' };
    const entries = Array.isArray(list) ? list : mem.recent(10);
    if (!entries.length) return { ok: false, message: '没有可压缩的记录' };
    const previous = mem.snapshot().longTerm.text;
    const body = entries
      .map((item) => `${item.role === 'pet' ? '你' : item.role === 'me' ? '主人' : '系统'}: ${item.text}`)
      .join('\n');
    try {
      const fishPersonality = typeof fish?.personality === 'string' && fish.personality
        ? fish.personality
        : config.personality;
      const fishRules = typeof fish?.rules === 'string' && fish.rules ? fish.rules : config.rules;
      /**
       * 压缩说明也按鱼取（`pets[].compactSystem` → 没写才用全局）。
       * 只换人设不换"怎么总结"，两条鱼写出来的长期记忆就会是一个模子。
       */
      const fishCompact = compactSystemFor(config, fish);
      const fishName = String(fish?.name ?? '').trim();
      const { raw } = await runModel({
        reason: 'compact',
        /** 人设 + 规则 + 压缩说明 ✓ = 在**它自己的上下文**里压缩 ✓ */
        system: [
          fishPersonality,
          fishRules,
          '',
          fishCompact,
          fishName ? `（这份记忆属于「${fishName}」，用它的第一人称与口吻写。）` : '',
        ]
          .filter(Boolean)
          .join('\n'),
        /**
         * 长期记忆的**篇幅目标**：主人嫌不够 ✓ ——
         * 从"模型随手写多少算多少"改成明确要求"合并新旧信息、写到接近上限"，
         * 上限由 `memoryLongTermChars` 配（默认 2400 字，每个会话各一份 ✓）。
         */
        text:
          (previous
            ? '【现有长期记忆】（带 - 的每一条都是它自己攒下的，除非明确过时或与新信息重复，**不要删**）\n' +
              previous +
              '\n\n'
            : '') +
          '【新的来往】\n' +
          body
          + `\n\n（长期记忆篇幅上限 ${config.memoryLongTermChars} 字：把新旧信息**合并**成一份要点，`
          + '尽量把有用的都留下、写到接近上限；不要只写最近几条，也别丢旧的重要事实 ✓）',
      });
      const text = raw.replace(/^```[a-z]*\n?|```$/g, '').trim();
      if (!text) return { ok: false, message: '模型没有给出要点' };
      await mem.setLongTerm(text, Date.now());
      await mem.add({ role: 'system', kind: 'compact', text: `（长期记忆已更新：${entries.length} 条来往压成要点）` });
      state.compactions += 1;
      return { ok: true, text };
    } catch (error) {
      pushError('compact', error);
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }

  function maybeCompact(mem = memory, fish = null) {
    if (!config.compactEvery) return;
    if (!mem.turnsSinceCompaction(config.compactEvery)) return;
    void compactMemory(false, mem, fish).catch(() => {});
  }

  // ---------------------------------------------------------------- 游戏事件（GoH）

  /**
   * 重要事件 → **立刻**向宠物发一次请求（不等周期轮询）。
   *
   * 三道闸门，缺一不可：
   *   ① 冷却（gohImmediateCooldownSec）：一局里事件可能很密（实测 963 条/两局），
   *      每个都反应就是把 API 打爆。冷却期内的多个事件**合并成一条**说，信息不丢。
   *   ② 正在回答中（replyBusy）就跳过：宁可不反应，也不要把调用堆起来。
   *   ③ 暂停（state.paused）时不反应：暂停是用户的明确意图。
   */
  let lastGameReactAt = 0;
  let pendingGameEvents = [];
  let gameReactTimer;
  /** 近 `gohReactionWindowSec` 内"因事件主动说话"的时间戳（预算用） */
  const recentReactions = [];

  async function reactToGameEvents(events) {
    const text = events
      .map((ev) => ev.text_zh || ev.text || ev.raw || '')
      .filter(Boolean)
      .slice(0, 4)
      .join('；');
    if (!text) return;
    state.game.lastImportant = text.slice(0, 60);
    state.game.importantSeen += events.length;

    if (state.paused || !state.running) return;
    if (replyBusy) {
      log('游戏重要事件到达，但正在回答中，跳过这一次（下轮上下文里仍会带上）');
      return;
    }
    const cooldownMs = Math.max(0, Number(config.gohImmediateCooldownSec ?? 30)) * 1000;
    if (Date.now() - lastGameReactAt < cooldownMs) {
      pendingGameEvents.push(...events);
      log(`游戏重要事件在冷却期内，攒着（${pendingGameEvents.length} 条）`);
      return;
    }
    /**
     * **每窗口最多说几次**（2026-10-19）：只有冷却不够 —— 冷却 12 秒 × 连续对局 =
     * 一分钟四五次模型调用。这里再加一道"滑动窗口预算"，超了就只把事件留在上下文里，
     * 不再为它单独打模型（模型下一轮旁观时仍然看得到）。
     */
    const budget = Math.max(0, Number(config.gohReactionBudget ?? 8));
    const windowMs = Math.max(60, Number(config.gohReactionWindowSec ?? 600)) * 1000;
    if (budget > 0) {
      const nowMs = Date.now();
      while (recentReactions.length && nowMs - recentReactions[0] > windowMs) recentReactions.shift();
      if (recentReactions.length >= budget) {
        log(
          `游戏事件反应已达预算（${budget} 次 / ${Math.round(windowMs / 60000)} 分钟），这次只进上下文不打模型`,
        );
        /**
         * **攒着的事件也一起清掉**：不清的话等预算滑过去，会拿一堆十几分钟前的旧事件
         * 一次性打模型说"炮波又来了" —— 比不说更糟。
         */
        pendingGameEvents = [];
        return;
      }
    }

    // 冷却期内攒下的事件一起说，避免碎片化
    const all = pendingGameEvents.length ? [...pendingGameEvents, ...events] : events;
    pendingGameEvents = [];
    lastGameReactAt = Date.now();

    const joined = all
      .map((ev) => ev.text_zh || ev.text || ev.raw || '')
      .filter(Boolean)
      .slice(0, 5)
      .join('；');
    /**
     * **先定"这条消息由谁来说"**（2026-10-18 修：发言要算到发言的那条鱼头上）。
     *
     * 原来的写法三处不一致：`consultModel` 用**全局** `memory`（= `memoryFor('local')`）、
     * `recordSpeak` / `memory.add` 也全落进那份、`pushToPet` 又没带 origin（投给主鱼），
     * 于是"重要事件反应"谁都不属于：实测 `memory.json` 里攒了 722 条 `game-event`，
     * 而 `memory-legacy.json` 只有 36 条（更早版本留下的）、`memory-current.json` 一条都没有。
     *
     * 现在：说话的那条 = QQ 鱼优先（`qqPet()`，没有就第一条启用的），
     * 它的记忆 / 口吻 / 端口 / 计数四件事**一以贯之**。
     */
    const speaker = qqPet() || enabledPets()[0] || null;
    const speakerKey = speaker ? fishKeyOf(speaker) : 'local';
    const speakerMemo = speaker ? memoryFor(speaker.scope || speakerKey) : memory;
    const speakerRt = fishRuntimeOf(speakerKey);
    try {
      /**
       * 游戏事件这条**不走** `askCapture`（它自己开头就有暂停检查）：
       * 能走到这里说明没暂停，而"看到什么"正是反应的依据，必须有图。
       */
      let frame = capture.latest();
      if (!frame) frame = await capture.capture(config);
      // 重要事件触发（独立路径，不受空闲退避影响）—— 标成 game-event，排障时一眼分清
      const decision = await consultModel(
        frame.file,
        `（游戏里刚发生了重要事件：${joined}）`,
        '',
        'game-event',
        speakerMemo,
        speaker ? speaker.scope || speakerKey : '',
        speaker,
      );
      const phrase = decision.text;
      if (phrase) {
        if (config.pushToPet) {
          // origin 也必须是它的，否则嘴上说是 legacy、画面却出现在主鱼身上
          await pushToPet(phrase, config.petTarget, config.petId, decision.img, speaker ? String(speaker.origin ?? '') : '', decision.style);
        }
        await recordSpeak(phrase, 'game-event', speakerMemo);
        // 系统条目照常写进记忆（压缩与上下文都要用）；只有**记录页**可以按设置不显示它
        await speakerMemo.add({ role: 'system', kind: 'game-event', text: joined });
        speakerRt.speaks += 1;
        speakerRt.lastSpeakAt = Date.now();
        speakerRt.lastPhrase = phrase;
        speakerRt.lastError = '';
        state.lastDecision = 'game-event';
        state.game.reactions += 1;
        state.game.lastReactionAt = Date.now();
        recentReactions.push(Date.now());
        if (recentReactions.length > 500) recentReactions.splice(0, recentReactions.length - 500);
        log(`[${speaker?.name || speakerKey}] 重要事件反应：${joined.slice(0, 40)} → ${phrase.slice(0, 30)}`);
      }
    } catch (error) {
      pushError('game-event', error);
    }
  }

  /** 每 2 秒读一次事件文件（与模型周期无关，重要事件才能"立刻"反应） */
  function pollGameEvents() {
    if (!goh) return;
    const events = goh.poll();
    if (!events.length) return;
    state.game.newEvents += events.length;
    // 记住"游戏里最近一次有事发生"的时刻：空闲退避要用它（见 updateActivity）
    state.game.lastEventAt = Date.now();
    const important = goh.pickImportant(events, {
      importantKinds: config.gohImportant,
      killBurstCount: config.gohKillBurstCount,
      killBurstSec: config.gohKillBurstSec,
    });
    if (important.length) void reactToGameEvents(important);
  }

  /**
   * 定时器**常驻**（不是按来源建）：这样切换来源后立刻开始/停止读事件，不必重开 DSH。
   * 无来源时 pollGameEvents 第一行就返回，开销为零。
   */
  ctx.effect(() => {
    gameReactTimer = setInterval(pollGameEvents, 2000);
    gameReactTimer.unref?.();
    return () => {
      if (gameReactTimer) clearInterval(gameReactTimer);
    };
  }, 'game-pet-watch: goh watcher');


  // ---------------------------------------------------------------- 气泡投放 & 宠物那边的话入账

  let petOriginCache;

  async function resolvePetOrigin() {
    if (petOriginCache) return petOriginCache;
    const candidates = [];
    /**
     * 原版 dsh-pet 也是挂在这个 web 服务上的，所以"自己的地址"要先试（端口会随 DSH 版本变）。
     * ⚠️ 候选表里**只放已知地址**：以前还带着 `[19387, 3080, 8080, 3000]` 这几个"历史猜测口"，
     * 那等于往陌生端口发请求 —— 实测把 CS2 Hammer 的导入接口（本地某个口）打坏过
     * （它把任何字节都当 JSON 导入数据）。猜测式探测一律不加。
     */
    candidates.push(ownOriginNow());
    if (process.env.DSH_WEB_ORIGIN) candidates.push(process.env.DSH_WEB_ORIGIN.replace(/\/$/, ''));
    if (process.env.DSH_WEB_PORT) candidates.push('http://127.0.0.1:' + process.env.DSH_WEB_PORT);
    candidates.push('http://127.0.0.1:19387'); // 老版本 DSH 的固定端口（配置迁移期兜底）
    for (const origin of [...new Set(candidates.filter(Boolean))]) {
      try {
        const probe = await fetch(origin + PET_ROUTE_PREFIX + '/state', { signal: AbortSignal.timeout(1200) });
        if (probe.ok) {
          petOriginCache = origin;
          return origin;
        }
      } catch {
        /* 试下一个 */
      }
    }
    return undefined;
  }

  /**
   * 把一句话投到宠物气泡。
   *
   * 两个投喂口，按目标选：
   *   'dsh-pet'（默认）→ 原版 dsh-pet 的第三方投喂端点 /dsh-pet-7340/broadcast
   *   'gpw'           → 独立副本 dsh-pet-gpw 的 /gpw/say（副本自己写了 pets.<id>.say，气泡照常）
   * 两个都没起来就显式报错，不假装成功。
   *
   * @param {string} text
   * @param {'dsh-pet'|'gpw'} [target]
   * @param {string} [petId] 覆盖配置里的 petId
   */
  /** 独立副本 dsh-pet-gpw 的地址：**只认配置或默认端口**（原因见函数内注释：扫端口会认错鱼） */
  async function resolveGpwOrigin() {
    /**
     * ⚠️ 这里**绝对不能扫端口**（曾经是 `for (const port of [7341, 7342, 7343])`）。
     *
     * 踩过的事故：另有一份副本（OpenCode 那边照着这个仓库抄的鱼）监听 **7342**，
     * 而它服务的是**同一套 `/gpw/state` 路由**。于是我的 7341 一挂，探活就扫到 7342 应答，
     * 认定"副本活着"→ **永远不再拉起自己那只**（用户看到的就是"DSH 的鱼起不来了"），
     * 而且之后气泡/配图全推给了别人那只鱼。
     *
     * 「哪只鱼是我的」不能靠"谁先应答"来判断，只能靠**约定**：配置里写死的地址，
     * 或者与副本一致的默认端口。换端口请改 `gpwOrigin`（launchFork 会把端口传给子进程）。
     */
    return defaultGpwOrigin();
  }

  /**
   * 只认目录里真实存在的表情包名（防幻觉）：模型写了个目录外的名字就当作没配图。
   * 与动画点名同一套防护——宁可没图，也不能图裂。
   */
  function validImage(name, catalog = imageCatalog) {
    const key = String(name ?? '').trim();
    if (!key) return undefined;
    if (catalog.item(key)) {
      state.imgUsed = (state.imgUsed || 0) + 1;
      return key;
    }
    // 模型点了目录里没有的名字：计数并留证，否则"没配图"和"配图被丢"分不清
    state.imgDropped = (state.imgDropped || 0) + 1;
    state.lastImgDropped = key;
    log(`模型点的配图「${key}」不在表情包目录里，已丢弃（目录 ${Object.keys(catalog.data.items).length} 张）`);
    return undefined;
  }

  /**
   * 表情包**名字 → 本地文件路径**（只读查表）。
   *
   * 为什么需要单独一个：`decision.img` 是**目录 key（名字）**，不是路径 ✗ ——
   * 气泡那边由副本自己把名字解析成文件 ✓，而我把名字直接喂给 `statSync` ✗，
   * 结果必然是"读不到 → 只发文字" ✓（主人看到的就是"图没发出来"）。
   * 这里只读不计数：计数由 `validImage()` 负责，两边都调会重复计数 ✗。
   */
  function imageFileOf(name, catalog = imageCatalog) {
    const key = String(name ?? '').trim();
    if (!key) return undefined;
    const item = catalog.item(key);
    /**
     * ⚠️ **`file` 与 `sheet` 都要认** ✗→✓（主人问"发图权限是不是没了"的真因 ✓）：
     * 视觉描述那条路复用了**动画目录**的落盘格式 → 存的是 `sheet` ✗，
     * 而这里原来只读 `file` ✗ → **QQ 收进来的 17 张图一张都发不出去** ✓
     * （目录里 file=100 条、sheet=17 条，那 17 条正好全是 QQ 收的 ✗）。
     */
    const file = item?.file ?? item?.sheet;
    if (typeof file === 'string' && existsSync(file)) return file;
    log(`配图「${key}」在目录里找不到可用路径（file/sheet 都空或文件不存在），只发文字`);
    return undefined;
  }

  async function pushToPet(text, target, petId, image, originOverride = '', style = null) {
    if (target === 'gpw') {
      /** 没显式指定就发到**业务主鱼**（= QQ 那条 ✓），而不是默认鱼 ✓ */
      const origin = originOverride || primaryGpwOrigin() || (await resolveGpwOrigin());
      /** 记下"这句话最后推给了谁" ✓ —— 排障"回话从哪只冒出来"一眼可见 ✓ */
      try {
        state.lastPush = { at: Date.now(), origin, explicit: Boolean(originOverride), target, petId: petId ?? '' };
      } catch {
        /* 记录失败不影响推送 */
      }
      if (!origin) throw new Error('找不到 dsh-pet-gpw 的端口（默认 7341；可用配置 gpwOrigin 指定）');
      const meme = validImage(image);
      /**
       * **网络抖动不该冒成裸的 "fetch failed"**（2026-10-18）：
       * 宠物重启/端口刚换的那 1~2 秒里 POST 会直接 reject，undici 的报错就是 `fetch failed`，
       * 会原样进面板的"最近错误"（主人看到的 "菜单显示 fetch failed"）。
       * 这里重试一次，并把目标地址写进错误，至少看得出连的是谁。
       */
      const sayUrl = origin + '/gpw/say';
      let response;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          response = await fetch(sayUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              text,
              pet: petId || config.petId || 'gpw',
              ...(meme ? { image: meme } : {}),
              ...(style && style.bold ? { bold: true } : {}),
              ...(style && style.size ? { size: style.size } : {}),
            }),
            signal: AbortSignal.timeout(5000),
          });
          break;
        } catch (error) {
          if (attempt === 1) {
            const raw = error instanceof Error ? error.message : String(error);
            throw new Error('连不上宠物 ' + sayUrl + '（' + raw + '）');
          }
          await new Promise((r) => setTimeout(r, 400));
        }
      }
      if (!response.ok) throw new Error('gpw say HTTP ' + response.status);
      const body = await response.json().catch(() => ({}));
      if (body && body.ok === false) throw new Error('dsh-pet-gpw 拒绝：' + (body.message ?? 'unknown'));
      return body;
    }
    const origin = await resolvePetOrigin();
    if (!origin) throw new Error('找不到 dsh-pet 的 HTTP 端口（可设环境变量 DSH_WEB_PORT / DSH_WEB_ORIGIN）');
    const pet = petId || config.petId;
    const query = pet ? '?pet=' + encodeURIComponent(pet) : '';
    const response = await fetch(origin + PET_ROUTE_PREFIX + '/broadcast' + query, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error('dsh-pet broadcast HTTP ' + response.status);
    const body = await response.json().catch(() => ({}));
    if (body && body.ok === false) throw new Error('dsh-pet 拒绝投喂：' + (body.message ?? body.reason ?? 'unknown'));
    return body;
  }

  /**
   * 读一次 dsh-pet 的气泡文本，把它自己说的话（碎碎念 / /chat / 别人投喂）也记进同一本账。
   * 顺带当健康探针：拿得到说明 dsh-pet 在线。
   */
  async function syncPetSpeech() {
    /** 业务主鱼优先 ✓（有鱼表时 = QQ 那条 ✓） */
    const origin = primaryGpwOrigin() || (await resolvePetOrigin());
    if (!origin) return;
    try {
      const response = await fetch(origin + PET_ROUTE_PREFIX + '/state', { signal: AbortSignal.timeout(2000) });
      if (!response.ok) return;
      const body = await response.json();
      const pets = body?.pets ?? {};
      const wanted = config.petId || Object.keys(pets)[0];
      const leaf = wanted ? pets[wanted]?.say : undefined;
      const counter = Number(leaf?.counter ?? 0);
      const text = typeof leaf?.data?.text === 'string' ? leaf.data.text.trim() : '';
      state.lastPetSyncAt = Date.now();
      if (!counter || !text) return;
      if (counter === memory.petCursor()) return;
      await memory.setPetCursor(counter);
      if (text === state.lastPhrase) return; // 自己刚投的那句已经在账上了
      await memory.add({ role: 'pet', kind: 'pet-own', text, meta: { counter } });
    } catch {
      /* dsh-pet 不在线：不记账也不报错刷屏 */
    }
  }

  /**
   * 让宠物播一段动画（副本的 /anim）。模型点名了才调；失败只记日志，不影响说话。
   * 名字不受信任：副本那边只认它动画池里的名字，查不到就返回 ok:false，气泡照常。
   */
  async function playAnim(name, originOverride = '') {
    if (!name) return;
    try {
      const origin = originOverride || primaryGpwOrigin() || (await resolveGpwOrigin());
      if (!origin) return;
      const response = await fetch(origin + '/dsh-pet-7340/anim', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, pet: config.petId || 'gpw' }),
        signal: AbortSignal.timeout(4000),
      });
      const body = await response.json().catch(() => ({}));
      if (body && body.ok) log('点播动画：' + name);
      else log('动画没播成：' + name + '（' + ((body && body.message) || response.status) + '）');
    } catch (error) {
      log('点播动画异常：' + (error instanceof Error ? error.message : String(error)));
    }
  }

  async function recordSpeak(text, kind, mem = memory) {
    state.lastPhrase = text;
    state.lastSpeakAt = Date.now();
    state.speaks += 1;
    /** 记进**这条鱼自己的**记忆 ✓（方案2：每条鱼一份记忆 ✓） */
    await mem.add({ role: 'pet', kind, text });
  }

  // ---------------------------------------------------------------- 副本保活
  /** 副本目录：配置优先，否则按"插件旁边的兄弟仓库"推（见 `resolveGpwRoot()` 的说明） */
  const gpwRootNow = () =>
    resolveGpwRoot({ configured: config.gpwRoot, packageDir: PACKAGE_DIR, dshHome, fsExists: existsSync });
  /** 原版素材目录：配置优先，否则按当前 profile 推（见 `resolveUpstreamPetRoot()` 的说明） */
  const upstreamPetRootNow = () =>
    resolveUpstreamPetRoot({
      configured: config.upstreamPetRoot,
      dshHome,
      profile: process.env.DSH_PROFILE || 'desktop',
      petRoot: gpwRootNow(), // 副本仓库自带的 assets 优先（素材独立的情况）
      fsExists: existsSync,
    });
  /**
   * **插件自己的 HTTP 地址**（= 宿主 DSH 的 web 端口）。
   *
   * 为什么不能写死：副本的 `GPW_PLUGIN_ORIGIN` 是启动时从这里传下去的，写死 19387 就等于
   * 让副本把 `/rects` 发到一个没人监听的口子上 —— DSH 升级后端口变成随机（实测 19387 → 60010），
   * 表现就是"碰撞账本永远是空的、宠物一切功能都像断了线"。
   *
   * 三级来源，先到先得：
   *   0. **设置里写死的 `pluginPort`**（主人要的"端口在设置里改"；0 = 不写死）
   *   1. 宿主给了 `DSH_WEB_ORIGIN` / `DSH_WEB_PORT`
   *   2. 本进程的监听端口（插件跑在宿主进程里，端口就是宿主 web 端口；`netstat -ano` 按 pid 找）
   *   3. 收到的请求里学（`req.socket.localPort` 最权威，用来纠正第 1、2 级都失败的情况）
   */
  let ownOrigin = (() => {
    const fromEnv = String(process.env.DSH_WEB_ORIGIN || '').replace(/\/+$/, '');
    if (fromEnv) return fromEnv;
    const port = Number(process.env.DSH_WEB_PORT || 0);
    return port > 0 ? 'http://127.0.0.1:' + port : '';
  })();

  const ownOriginNow = () =>
    pluginOriginOf({ configuredPort: config.pluginPort, learned: ownOrigin }) ||
    'http://127.0.0.1:' + (process.env.DSH_WEB_PORT || '19387');

  /**
   * **公共登记簿的落盘**（`~/.dsh/fish-board/registry.json`）。
   *
   * 写三件事：插件地址、鱼表、更新时间。读它的人（我们的副本、opencode 的桥、任何脚本）
   * 都不用再猜端口、也不用从别处拼身份。写失败一律静默 —— 观测文件不许影响插件。
   * 触发点：启动、探测到地址、每次改配置（`writeLocalConfig`）、外加 60 秒一次刷新
   * （让 `updatedAt` 能表达"这一侧还活着"）。
   */
  const fishBoardDir = join(dshHome, 'fish-board');
  const fishBoardFile = join(fishBoardDir, 'registry.json');
  let registryOriginLogged = '';
  function publishRegistry() {
    try {
      mkdirSync(fishBoardDir, { recursive: true });
      /**
       * 地址**不写猜测值**：没学到/没指定就发空串（读的人退回自己的兜底）。
       * 上一版这里用的是 `ownOriginNow()`，它在没学到之前会退到写死的 19387，
       * 于是登记簿里先出现一个错的地址（实测日志：先写 19387、300ms 后才纠正成 64541）。
       * 公共文件里宁可空着，也不能放一个"看着像答案"的猜测。
       */
      const doc = buildFishBoardRegistry({
        /**
         * 登记簿要反映**实际会驱动的那几只**：鱼表为空时也不能写成 `fish: []` ——
         * 那样别处会以为"这一侧没有鱼"，而其实默认那只正在跑（第一次安装就是这个状态）。
         */
        config: { pets: Array.isArray(config.pets) && config.pets.length ? config.pets : enabledPets() },
        origin: pluginOriginOf({ configuredPort: config.pluginPort, learned: ownOrigin }),
      });
      const tmp = `${fishBoardFile}.tmp`;
      writeFileSync(tmp, JSON.stringify(doc, null, 2), 'utf8');
      renameSync(tmp, fishBoardFile);
      if (doc.pluginOrigin && doc.pluginOrigin !== registryOriginLogged) {
        registryOriginLogged = doc.pluginOrigin;
        log(`公共登记簿已更新：${fishBoardFile}（插件地址 ${doc.pluginOrigin}，鱼 ${doc.fish.length} 条）`);
      }
      return doc;
    } catch {
      return null;
    }
  }

  /**
   * 把插件地址探明 —— **绝不去猜本机端口**。
   *
   * 上一版这里是"netstat 列出所有本地监听口 + 逐个 GET `/game-pet-watch/state`"，
   * 结果把别的程序打坏了：**CS2 Hammer 的导入接口**在本地某个口上（实测 24981），
   * 它把收到的任何字节都当 JSON 导入数据，于是我们的 GET 让它的导入直接报
   * `Invalid value "GET"`（屏幕上那条 import 报错就是它）。教训：
   * **任何"先猜端口再发请求"的做法都会踩到别人家的服务**，哪怕是只读 GET。
   *
   * 现在只认三个**已知来源**，一个字节都不往陌生地址发：
   *   ① 设置里的 `pluginPort`（主人明确指定）
   *   ② 宿主给的 `DSH_WEB_ORIGIN` / `DSH_WEB_PORT`
   *   ③ 请求里学到的 `req.socket.localPort`（真实承载请求的端口，最权威，见路由入口）
   * 副本那边还有公共登记簿 `~/.dsh/fish-board/registry.json` 兜底，
   * 所以这里不需要、也不应该去扫。
   */
  async function learnOwnOrigin() {
    const fixedPort = Number(config.pluginPort) || 0;
    if (fixedPort > 0) return 'http://127.0.0.1:' + fixedPort;
    return ownOrigin;
  }

  /** 副本保活计时器（下面 effect 里赋值；`/state.fork` 会读它） */
  let forkKeeper;

  /**
   * **每条鱼各自保活** ✗→✓。
   *
   * 原来这里只探/只拉**一只**（`origin` 取主鱼）✗ →
   * 结果：桌面上只有那只能自动起来，其它鱼重启后就"没人管" ✓
   * （主人报"为什么现在只启动了一只" ✓）。
   * 现在按鱼表逐条探活 ✓，哪条没起来就拉哪条 ✓（各自独立用户目录 ✓）。
   */
  /**
   * 等自己的地址探明（最多 2.5 秒）。
   *
   * 为什么必须等：副本的 `GPW_PLUGIN_ORIGIN` 是**启动时快照**，而插件要在第一个进来的请求里
   * 才能确认自己挂在哪个端口。上一轮实测的时序就坏了：插件 01:14:09 启动 → 01:14:12 保活拉起副本
   * （地址还没探到，下发了兜底的 19387）→ 01:14:34 才从请求里学到 52755。
   * 结果副本的 `/rects` 上报能靠公共登记簿自愈，但**注入对家那条循环用的是启动时的地址**，
   * 于是一直打不通 → 站场里永远只有自己 → "撞不上"。
   * 现在拉起前先等一下；实在等不到也照起（副本侧还有登记簿兜底），但会在日志里说清楚。
   */
  async function waitOwnOrigin(ms = 2500) {
    if (ownOrigin || Number(config.pluginPort) > 0) return ownOriginNow();
    const deadline = Date.now() + ms;
    while (!ownOrigin && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    if (!ownOrigin) log('⚠ 还没探到自己的端口就拉起副本了（副本会靠公共登记簿自愈；若注入一直不生效，重启一次 DSH）');
    return ownOriginNow();
  }

  async function ensureFork(reason) {
    const fishes = enabledPets();
    state.fork.lastProbeAt = Date.now();
    const report = [];
    // 只要有鱼没起来，先把"自己的地址"等到手再拉（否则副本会拿着过期地址空转，见 waitOwnOrigin）
    if (fishes.length) {
      const anyDown = await Promise.all(fishes.map((f) => forkAlive(f.origin || defaultGpwOrigin()))).then(
        (list) => list.some((alive) => !alive),
      );
      if (anyDown) await waitOwnOrigin();
    }
    for (const fish of fishes) {
      const origin = fish.origin || defaultGpwOrigin();
      const alive = await forkAlive(origin);
      if (fishes.length === 1) state.fork.alive = alive;
      if (alive) {
        report.push(`${fish.name || fish.id}=活着`);
        continue;
      }
      if (!config.autoLaunchFork && reason !== 'manual') {
        report.push(`${fish.name || fish.id}=没起来(自动拉起已关)`);
        continue;
      }
      const result = await launchFork({
        packageRoot: gpwRootNow(),
        origin,
        /** 独立用户目录：默认那只不传 profile ✓，其它按鱼表里的 `profile` ✓ */
        profile: fish.profile || (fish.id === 'legacy' ? '' : fish.id),
        upstreamRoot: upstreamPetRootNow(),
        pluginOrigin: ownOriginNow(),
        hostPid: process.pid,
        /** 共享图库：图片只有一份 ✓，每条鱼的副本都要能从同一个目录取图 ✓ */
        sharedMemes: join(imagesUserRoot, 'memes'),
        /** 鱼板网络 v2：把身份透给副本 ✓（握手时回给对等体 ✓） */
        scope: fish.scope || fish.id,
        fishId: fish.id,
        log,
      });
      report.push(`${fish.name || fish.id}=${result.ok ? '已拉起 pid=' + result.pid : result.message ?? '失败'}`);
      if (result.ok) state.fork.lastLaunchAt = Date.now();
    }
    state.fork.lastMessage = report.join(' ｜ ');
    log('副本保活：' + state.fork.lastMessage);
    return;
  }

  /** 老的单鱼保活路径（保留：只在**没有鱼表**时用得到的兼容分支） */
  async function ensureForkSingle(reason) {
    const origin = (await resolveGpwOrigin()) ?? defaultGpwOrigin();
    const alive = await forkAlive(origin);
    state.fork.alive = alive;
    state.fork.lastProbeAt = Date.now();
    if (alive) return;
    if (!config.autoLaunchFork && reason !== 'manual') return;
    const result = await launchFork({
      // 副本目录走配置（它跟插件是**两个仓库**，别拿插件目录凑）
      packageRoot: gpwRootNow(),
      origin,
      upstreamRoot: upstreamPetRootNow(),
      pluginOrigin: ownOriginNow(),
      // 退出耦合：把本进程 pid 交给副本当"宿主"。副本每 2 秒 kill(pid,0) 探一次，
      // ESRCH（进程不存在）就自己 app.exit(0)。OS 级事实，不依赖心跳，
      // 所以 DSH 崩溃退出时副本也能收敛 → 效果就是"DSH 关，宠物自己消失"。
      hostPid: process.pid,
      log,
    });
    state.fork.lastMessage = result.message ?? (result.ok ? '已拉起 pid=' + result.pid : '');
    if (result.ok) {
      state.fork.lastLaunchAt = Date.now();
      log(`桌宠副本已自动拉起（${reason}）pid=${result.pid}`);
    } else if (result.message && !/已经在跑|刚试过/.test(result.message)) {
      log('桌宠副本没拉起来：' + result.message);
    }
  }

  /** 配置里没写 gpwOrigin 时的默认地址（探测还没成功时也要有个目标） */
  /**
   * **要驱动的鱼**（方案2 的核心 ✓）。
   *
   * `config.pets` 为空 → 合成一条"默认鱼"（端口取 `gpwOrigin`，记忆用原来的 local ✓）
   * → 行为与改造前一模一样 ✓（这是必须保住的性质 ✗→✓）。
   */
  function enabledPets() {
    /** 全局开关关掉 = 一条鱼都不驱动 ✓（连保活也不做 ✓） */
    if (config.petsEnabled === false) return [];
    const list = enabledFish(config.pets, true);
    if (list.length) return list;
    /**
     * **没有鱼表时的默认**：就这一只，名字/人设/规则/压缩说明全走默认值。
     *
     * 第一次安装就该是这个样子 —— 不用先配鱼表，装完重启桌上就有一只宠物；
     * 而且**不假装自己接了 QQ**（`qq: false`）：没配 OneBot 还硬连只会刷失败日志。
     */
    return [
      {
        id: config.petId || 'gpw',
        name: state.selfName || '桌面宠物',
        origin: defaultGpwOrigin(),
        scope: 'local',
        qq: false,
        personality: undefined,
        rules: undefined,
      },
    ];
  }

  /** QQ 那条路固定的那条鱼（表里 `qq: true` 的；没有就用主鱼）✓ */
  function qqPet() {
    const list = Array.isArray(config.pets) ? config.pets.filter((f) => f && f.enabled !== false) : [];
    return list.find((f) => f.qq === true) ?? null;
  }

  /**
   * "主鱼"的地址（QQ 那条路要用的 ✓）。
   *
   * ⚠️ **必须与"默认那只鱼在哪个端口"解耦** ✗→✓：
   *   · `launchFork`（保活）管的是**默认 profile** 那只鱼 ✓ → 它的端口由 `gpwOrigin` 决定 ✓
   *   · 而 QQ 业务应该找**鱼表里 `qq: true`** 的那只（现在是 7342 ✓）
   * 事故（实测）：我把 `gpwOrigin` 设成 7342 让它去接 QQ ✗ →
   * 保活脚本于是把**默认那只鱼也拉到 7342** ✗ → 和第二只**抢端口** ✗ →
   * 表现就是"桌面上只剩一只鱼、而且名字还串了" ✓（pid/名字来回变 ✓）。
   * 现在：QQ 找 `qqPet()` ✓，默认鱼永远按 `gpwOrigin`（=7341 ✓）。
   */
  /**
   * **默认那只鱼**（= `launchFork` 保活脚本管的那只）的地址 ✓。
   *
   * ⚠️ 这里**只能**看 `gpwOrigin`（默认 7341 ✓）—— 绝不要因为"某只鱼要接 QQ"就改它 ✗✗。
   * 两次事故都是这么来的：
   *   ① 我把 `gpwOrigin` 设成 7342 去接 QQ ✗ → 保活把**默认鱼也拉到 7342** ✗ → 抢端口 ✓
   *   ② 我把这个函数改成"优先取 QQ 那条鱼" ✗ → 保活**又来一次** ✓
   * 所以现在是硬规矩：**这个函数 = 默认鱼 = `gpwOrigin`** ✓；
   * QQ/其它业务要找"主鱼"请用 `primaryGpwOrigin()` ✓。
   */
  /**
   * **默认鱼**的 origin（启动器/保活/默认目标 ✓）。
   * ⚠️ 与"业务主鱼"是两件事 ✓ —— 混用会把端口搞错 ✓（踩过两次 ✓ 见 FISHES.md §2）。
   */
  function defaultGpwOrigin() {
    const configured = String(config.gpwOrigin ?? '').trim();
    if (configured) return configured.replace(/\/+$/, '');
    const fish = defaultFish(config.pets);
    return String(fish?.origin ?? '').replace(/\/+$/, '') || 'http://127.0.0.1:7341';
  }

  /**
   * **业务上的主鱼**（QQ 回复、气泡镜像等"宠物本体"操作 ✓）：
   * 鱼表里 `qq: true` 的那只（现在 = 7342 ✓），没有鱼表就回落到默认鱼 ✓。
   */
  function primaryGpwOrigin() {
    const fish = primaryFish(config.pets);
    if (fish && fish.origin) return String(fish.origin).replace(/\/+$/, '');
    return defaultGpwOrigin();
  }

  /**
   * 鱼板网络：自己的鱼 + 对等体（别的副本）+ 主人说过的话，按时间戳合成一条时间线。
   *
   * 为什么要它：这台机器上同时跑着多只宠物（本仓库 7341 / 另一个仓库 7342），
   * 让它们互相看见"最近说了什么"，才可能互相接话。
   */
  const board = config.fishBoard
    ? new FishBoard({
        selfOrigin: defaultGpwOrigin(),
        ports: config.fishBoardPorts,
        pollMs: config.fishBoardPollMs,
        log,
      })
    : null;

  /**
   * 自己的名字：从副本的 `/gw/brand` 读，30 秒一次。
   *
   * 为什么不只在鱼板里取：① 鱼板可以关掉，而"我叫什么"是基本身份；
   * ② 用户改名后期望提示词尽快跟上（最多 30 秒，改名是低频操作，够用）。
   */
  async function refreshSelfName() {
    try {
      const res = await fetch(defaultGpwOrigin() + '/gpw/brand', { signal: AbortSignal.timeout(1500) });
      if (!res.ok) return;
      const brand = await res.json();
      const name = typeof brand?.name === 'string' ? brand.name.trim() : '';
      if (name && name !== state.selfName) {
        state.selfName = name;
        log('宠物名字已更新为「' + name + '」，提示词里的身份行随之更新');
      }
    } catch {
      /* 副本没起来就下次再试 */
    }
  }

  /**
   * 历史日志：把**看到过的**每条都落盘，历史就不再依赖"谁正在运行"。
   *
   * 用户报的问题：对家一关，它说过的话就从历史里消失了（那三处来源都是"活的"）。
   * 现在每轮轮询后把鱼板时间线整条追加进 history.jsonl —— 对家退出、副本重启、
   * 本插件重启都不影响已经记下来的内容。
   */
  const journal = createJournal({ file: join(dataDir, 'history.jsonl'), log });

  /**
   * OneBot（NapCat 真号）接入。
   *
   * 设计要点（都是踩过/想清楚的）：
   *   - **默认全关**：没配 `onebotUrl` 就完全不连、不产生网络行为。
   *   - **收进鱼板**：群消息按「群友:名字」写进鱼板（`to: 'group:<群号>'`），
   *     一并进历史落盘 → 桌宠的提示词里就有了（"记得群里聊过什么"）。
   *   - **只在被 @ 或私聊时才回话**（`onebotMentionOnly`，默认开）：群里当复读机最容易被踢，
   *     也最容易吃风控。记忆照收，但"开口"要克制。
   *   - **读图默认关**：一张图一次视觉调用，活跃群会把额度吃光。
   *   - **限速**：同一会话每分钟最多发 `onebotSendPerMinute` 条（默认 3），防抖防封。
   */
  /**
   * **OneBot 连接池（按鱼独立 ✓）**
   *
   * 为什么按"端点"池化而不是按鱼 ✗→✓：连接的身份是**端点**（url+token）✓ ——
   * 两条鱼如果配了同一个号，就不该连两次 ✗（NapCat 会打架 ✓），复用同一条 ✓。
   * 事件回来时带着"是哪条鱼的连接"✓ → 记忆/上下文/回话都归那条鱼 ✓。
   *
   * 老行为零变化 ✓：没给鱼绑端点 → `qqOf()` 回落全局 onebotUrl ✓ →
   * 只有一条连接 ✓ 事件归到**业务主鱼**（= 接 QQ 的那条 ✓，和以前一样 ✓）。
   */
  const onebotClients = new Map();
  /** 当前正在处理的那条鱼（事件期间用 ✓ 让回话走它自己的连接 ✓） */
  let onebotEventFish = null;

  function onebotFor(fish) {
    const q = qqOf(fish, config);
    if (!q.usable) return null;
    const key = q.url + '::' + q.token;
    const cached = onebotClients.get(key);
    if (cached) return cached;
    const client = createOneBotClient({
      url: q.url,
      token: q.token,
      log,
      onEvent: (event) => void handleOneBotEvent(event, fish),
    });
    onebotClients.set(key, client);
    log(`QQ 连接已创建：${summarize(fish)} → ${q.url}（号=${q.account || '未知'}｜${q.source === 'fish' ? '本鱼绑定' : '全局'}）`);
    return client;
  }

  /** 老代码里的 `onebot`（单号时代）→ 现在解析成**业务主鱼**的连接 ✓ */
  function onebotNow() {
    return onebotFor(primaryFish(config.pets));
  }
  /** 每个会话（群/私聊）最近发送时间，用于限速 */
  const onebotSentAt = new Map();
  /**
   * 每分钟最多往同一个会话发几条**回复**。
   *
   * 计数口径：每次 `onebotSay` 计一次 ✓ —— 所以"文字 + 图片分两条"仍然只算一次回复 ✓
   * （但 QQ 侧实际看到两条消息，这个值就是"回复频率"的闸门，不要调太高 ✗）。
   */
  const ONEBOT_SEND_PER_MINUTE = 3;
  /** 带图发送的体积上限（base64 会让消息膨胀约 1/3，超过就只发文字） */
  const ONEBOT_IMAGE_MAX_BYTES = 3 * 1024 * 1024;
  /**
   * 最近一次跟它说过话的 QQ 会话（群或私聊）。
   *
   * 为什么要有：`always` 档的注释写着"发到配置的第一个群**或最近一次说话的会话**"，
   * 但第一版只看了 `onebotGroups[0]` —— 群列表为空时（= 不限群）就**什么都不发** ✗
   * （主人的疑问"为什么有时候在本地回没发出去"就是撞上了这类情况 ✓）。
   */
  let onebotLastPeer = null;
  /** 最近一次"没发出去"的原因（给 /state 看，省得每次都要问） */
  let onebotSendSkip = null;
  /** 最近一次收到群消息的时间（"群里有人的"判定依据） */
  let onebotLastIncomingAt = 0;
  /** 最近一次**它主动**发群的时间（5 分钟闸门） */
  let onebotLastSelfPostAt = 0;

  /** 会话键（群/私聊）——限速与"回给谁"都用它 */
  function onebotPeerKey(event) {
    return event.scope === 'group' ? `group:${event.groupId}` : `private:${event.userId}`;
  }

  /** 这条消息该不该进记忆（按配置与白名单过滤） */
  function onebotWanted(event) {
    if (config.onebotMemoryFrom === 'off') return false;
    if (config.onebotMemoryFrom === 'group' && event.scope !== 'group') return false;
    if (config.onebotMemoryFrom === 'private' && event.scope !== 'private') return false;
    if (config.onebotGroups.length && event.scope === 'group' && !config.onebotGroups.includes(event.groupId)) return false;
    if (config.onebotAllowFrom.length) {
      const keys = [event.userId, event.groupId].filter(Boolean);
      if (!keys.some((k) => config.onebotAllowFrom.includes(k))) return false;
    }
    return true;
  }

  /** 是不是在叫我（@ 我 / 私聊） */
  function onebotMentionsMe(event, fish = null) {
    if (event.scope === 'private') return true;
    /** 自己的号：优先问**这条鱼的连接**（它连上后 OneBot 会报 self_id ✓），再退回事件里带的 ✓ */
    const selfId = onebotFor(fish)?.status().selfId || String(event.selfId ?? '') || '';
    if (selfId && event.raw?.message?.some((seg) => seg?.type === 'at' && String(seg?.data?.qq) === selfId)) return true;
    /**
     * **被回复**也算叫它 ✓（第二个该读该答的时机）：
     * OneBot 的 `reply` 段带着被引用消息的 id —— 只要是它发过的，就说明有人在接它的话 ✓。
     */
    if (event.raw?.message?.some((seg) => seg?.type === 'reply'
      && onebotSentIds.includes(String(seg?.data?.id ?? '')))) return true;
    // 拿不到自己的号时，退化成"文本里 @ 了机器人可能的名字"也认（宽松但可用）
    const name = state.selfName || '';
    return Boolean(name && String(event.text).includes('@' + name));
  }

  /** 把 QQ 消息写进鱼板（→ 提示词 + 历史落盘） */
  function onebotRemember(event, extraText = '') {
    /**
     * 带**群标签 + 号码**：`群「A」群友:Gold(1336156109)` ——
     * 多群并存分得清来源 ✓，有人冒充昵称也一眼看得出（号码对不上）✗→✓
     */
    const who = event.scope === 'group'
      ? `${onebotGroupLabel(event)}${onebotSenderLabel(event)}`
      : onebotSenderLabel(event);
    const text = extraText ? `${event.text}${event.text ? ' ' : ''}${extraText}` : event.text;
    if (!text.trim()) return;
    board?.addLocal(text, who, { to: onebotPeerKey(event), at: event.at });
  }

  /**
   * 群名缓存（groupId -> 群名）。
   *
   * 为什么要标明来源：它同时在好几个群里（实测 1001562729 与 671966485）✗——
   * 不带群标签，记忆里全是「群友:xxx」，分不清谁在哪个群说话，
   * 容易"把 A 群的话题答到 B 群" ✗。
   */
  const onebotGroupNames = new Map();
  let onebotGroupNamesAt = 0;

  /** 拉一次群列表（10 分钟缓存）；失败就退回群号，绝不阻塞流程 */
  async function refreshGroupNames() {
    if (!onebotNow()) return;
    if (Date.now() - onebotGroupNamesAt < 10 * 60_000) return;
    try {
      const res = await onebotNow()?.getGroupList();
      const list = res?.data ?? res ?? [];
      for (const g of Array.isArray(list) ? list : []) {
        const id = String(g?.group_id ?? '');
        const name = String(g?.group_name ?? '').trim();
        if (id && name) onebotGroupNames.set(id, name);
      }
      onebotGroupNamesAt = Date.now();
      log(`QQ 群名表已更新：${onebotGroupNames.size} 个群`);
    } catch (error) {
      onebotGroupNamesAt = Date.now(); // 失败也记时间，免得每条消息都重试
      log('拉群名表失败（改用群号标识）：' + (error?.message ?? error));
    }
  }

  /**
   * **发送者标签**：昵称 + QQ 号。
   *
   * 为什么必须带号码（主人要求）：群里**有人在冒充主人** ✗ ——
   * 昵称、头像、群名片都能随便改，**只有 QQ 号是改不了的** ✓。
   * 所以：
   *   - 标签一律写成 `Gold(1336156109)`，冒充者一看号码就露馅 ✓
   *   - 配了 `ownerQq` 时，**只有号码对得上**才写「主人」，否则就是普通群友 ✓
   */
  function onebotSenderLabel(event) {
    const id = String(event?.userId ?? '');
    const name = String(event?.senderName ?? '').trim() || id || '?';
    const isOwner = config.ownerQq && id && String(config.ownerQq) === id;
    const isGroup = event?.scope === 'group';
    const prefix = isGroup ? '群友' : 'QQ';
    return isOwner ? `主人(${id})` : `${prefix}:${name}(${id})`;
  }

  /** 群标签：优先群名，其次群号 */
  function onebotGroupLabel(event) {
    if (event?.scope !== 'group') return `私聊:${event?.senderName || event?.userId || '?'}`;
    const id = String(event.groupId ?? '');
    const name = onebotGroupNames.get(id);
    return name ? `群「${name}」` : `群 ${id}`;
  }

  /** 读图：下载 → 走同一套视觉描述 → 结果并入记忆文本 */
  async function onebotReadImage(event) {
    const image = event.images?.[0];
    if (!image) return '';
    const url = image.url || '';
    const localFile = image.file || '';
    if (!url && !localFile) return '［图片：拿不到下载地址］';
    try {
      /**
       * 两种来源都要支持：
       *   - http(s) URL → 下载（NapCat 开了 enableLocalFile2Url 时是这样）
       *   - `file://` URL 或本地路径 → **直接读文件**（fetch 不支持 file:// ✗，第一版会在这里失败）
       */
      let bytes;
      if (url.startsWith('file://') || (!url.startsWith('http') && localFile)) {
        const p = url.startsWith('file://') ? fileURLToPath(url) : localFile;
        bytes = readFileSync(p);
      } else if (url.startsWith('http')) {
        const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
        if (!res.ok) return `［图片：下载失败 HTTP ${res.status}］`;
        bytes = Buffer.from(await res.arrayBuffer());
      } else {
        return '［图片：地址形式不认识］';
      }
      if (bytes.length > 8 * 1024 * 1024) return '［图片：太大，跳过］';
      /**
       * **按文件头判真实格式**，不要按 URL 后缀猜 ✗。
       *
       * 实测踩坑：QQ 群里的图常常是 **WebP**，而 NapCat 给的 `file` 字段可能没有扩展名，
       * 我原来默认按 `png` 处理 → 临时文件后缀、以及传给视觉模型的 `mediaType` 全是 png ✗
       * → 附件/模型层报"格式对不上" → 描述失败 → 宠物把这个失败念了出来
       * （原话："图挂了喵，后缀跟真身对不上，转成png再发喵" ✗）。
       */
      const magic = (() => {
        const b = bytes;
        if (b.length < 12) return null;
        if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { ext: 'png', mime: 'image/png' };
        if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { ext: 'jpg', mime: 'image/jpeg' };
        if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return { ext: 'gif', mime: 'image/gif' };
        if (b[0] === 0x42 && b[1] === 0x4d) return { ext: 'bmp', mime: 'image/bmp' };
        if (b.slice(0, 4).toString('ascii') === 'RIFF' && b.slice(8, 12).toString('ascii') === 'WEBP') {
          return { ext: 'webp', mime: 'image/webp' };
        }
        return null;
      })();
      const ext = magic?.ext ?? (localFile || url).match(/\.(png|jpe?g|gif|webp|bmp)$/i)?.[1]?.toLowerCase() ?? 'png';
      const mediaType = magic?.mime ?? (ext === 'jpg' ? 'image/jpeg' : `image/${ext}`);
      const file = join(tmpdir(), `gpw-qq-${Date.now()}.${ext}`);
      writeFileSync(file, bytes);
      /**
       * 先压缩再送模型（默认开）：群友的图可能是 4K 或几十帧 GIF。
       * 压缩失败就用原图（`shrunk` 为 null）。
       */
      const shrunk = config.imageShrink ? await shrinkImage(file) : null;
      const sendFile = shrunk?.file ?? file;
      if (shrunk) log(`QQ 读图先压缩：${shrunk.note}`);
      const { raw } = await describeImage({
        system: IMAGE_DESCRIBE_SYSTEM,
        text: (shrunk?.meta?.wasGif
          ? '这是 QQ 群里刚发的**动图（GIF）**，但你只被给了**第 1 帧**'
            + `（共 ${shrunk.meta.frames ?? '?'} 帧）→ **看不到它怎么动的**：`
            + '描述时别假装看到了动作，只说这一帧的画面，必要时提一句"这是个动图"。\n'
          : '这是 QQ 群里刚发的图片。')
          + '请做两件事：\n'
          + '① 用一句话说你看到了什么（给桌宠当"我看到了什么"的记忆）\n'
          + '② 判断要不要**收进表情包库**：\n'
          + '   - **默认就收**（keep=true）：梗图、表情包、名场面、动画截图、二次元图、有人物有文字的图，都值得留着以后用 ✓\n'
          + '   · 而且**尽量给它起个 2-6 字的中文短名**（比如"奶凶爆粗""求投喂"）✓\n'
          + '   - 只有**明显不值得留**的才 keep=false：随手拍的实景照、纯文字截图、模糊/看不清的、'
          + '跟聊天无关的广告图 ✗\n'
          + '只输出 JSON：{"text":"一句话","keep":true或false,"name":"短名（keep=false 时留空）"}',
        image: sendFile,
        mediaType: shrunk?.mediaType ?? mediaType,
      });
      /**
       * 临时文件不在这里删了 ✗→✓：`sendFile` 还要给回答那一步当输入用 ✓。
       * （不删旧的 `file`：它也是同一张图的原始副本，回答完由调用方一起清 ✓）
       */
      const parsed = (() => {
        try {
          return JSON.parse(String(raw).replace(/^```[a-z]*\n?|```$/g, '').trim());
        } catch {
          return null;
        }
      })();
      const said = parsed?.text ?? String(raw).slice(0, 80);
      log(`QQ 读图完成：${said}`);
      /**
       * 返回值改成 `{ text, file }`：
       *   - text：描述（进记忆 + 当"看到了什么"✓）
       *   - file：**压好的那张图本身**，交给回答那一步直接当输入 ✓
       *     （主人要求：回复要"带着图"而不是"带着一段文字描述"✗→✓）
       * 临时文件**先不删**，由调用方在回答完之后删 ✓。
       */
      /**
       * ⚠️ **这里原来有一行提前 `return`** ✗✗ —— 是我加"带图回复"时插错的：
       * 它写在 `log('QQ 读图完成')` 之后，而那句话**在收藏逻辑之前** ✓ →
       * 于是**整个收藏（keep）块变成了死代码** ✗ → 表现就是"一直不收藏" ✓
       * （之后我调的提示词、加的日志，全都在改死代码 ✗😂）。
       * 现在：**先把收藏跑完，再 return** ✓，并且把图一起带出去（"带图回复"要用 ✓）。
       */
      /**
       * **它觉得有意思的图就收进表情包库**（与 fetch 回来的图**同一个文件夹** ✓），
       * 之后由图片同步器自动补描述 → 以后就能"按描述取用"（和别的图完全一样）。
       *
       * 三道保险（今天刚被"无节制增长"坑过 ✗）：
       *   ① 内容去重：同一张图（sha256）只存一次
       *   ② 数量上限：`qqKeepMax`（默认 200），到了就不再收
       *   ③ 体积上限：超过 8MB 不收（前面已经拦过读图，这里再确认一次）
       */
      /**
       * 收藏决策要**看得见** ✗→✓：主人问过"怎么不收新表情包了"，
       * 而当时日志里什么都没写 ✗（只有"收了"才有日志 ✓）。现在不收也记一行 ✓。
       */
      if (config.qqKeepInteresting && parsed?.keep !== true) {
        log(`QQ 读图后没收藏（模型判 keep=${JSON.stringify(parsed?.keep ?? null)}）：${said.slice(0, 30)}`);
      }
      if (config.qqKeepInteresting && parsed?.keep === true) {
        try {
          const digest = createHash('sha256').update(bytes).digest('hex');
          const keptIndexFile = join(dataDir, 'qq-kept.json');
          let kept = { hashes: [], count: 0 };
          try {
            kept = { ...kept, ...JSON.parse(readFileSync(keptIndexFile, 'utf8')) };
          } catch {
            /* 还没有账本 */
          }
          kept.hashes = Array.isArray(kept.hashes) ? kept.hashes : [];
          const memeDir = join(imagesUserRoot, 'memes');
          if (kept.hashes.includes(digest)) {
            log('QQ 收到重复的图（内容一样），不重复入库');
          } else if (kept.count >= config.qqKeepMax) {
            log(`QQ 收图已达上限 ${config.qqKeepMax} 张，不再入库（可调高 qqKeepMax）`);
          } else if (Object.keys(imageCatalog.data.items).length >= config.memeLibraryMax
            && !(config.memeEvictEnabled && await evictOneMeme({ newDesc: said, newFile: file }))) {
            /**
             * 整库满了：若开了"淘汰"就让它看图抉择一次 ✓（成功了腾出位置继续入库 ✓）；
             * 没开 / 它说不删 / 抉择失败 → 这次新图不入库 ✓（绝不硬塞 ✓）。
             */
            log(`表情包库已满（上限 ${config.memeLibraryMax}）：这次不入库`
              + (config.memeEvictEnabled ? '（它没挑出要淘汰的）' : '（可以开"满了自动淘汰"让它自己挑）'));
          } else {
            mkdirSync(memeDir, { recursive: true });
            // 名字：优先用模型给的关键词（去掉非法字符），否则用时间戳，前缀 qq 避免和 fetch 的撞名
            const cute = String(parsed?.name ?? '').replace(/[\/:*?"<>|\s]+/g, '').slice(0, 12);
            const base = cute ? `qq-${cute}` : `qq-${Date.now()}`;
            /**
             * **原样存原扩展名**（2026-10-20 改）。
             *
             * 以前一律转 PNG：因为图库扫描器与服务端只认 png/webp。代价是 **gif 只剩第一帧**——
             * 主人实测"群里那张 gif 收进来就不动了"。现在扫描器收 png/webp/gif/jpg，
             * 服务端也按真实扩展名给 content-type，所以**不用转**了：
             * 转一次就丢动画，还多一次 PowerShell 调用。
             * 只有真正不支持存的格式（bmp 等）才转 PNG。
             */
            /** 统一清单在 src/images.js（`memeSaveExt`）：png/webp/gif/jpg 原样存，其它才转 */
            const saveExt = memeSaveExt(ext);
            if (saveExt !== String(ext).toLowerCase()) {
              const conv = await shrinkImage(file, { format: 'png', maxDim: 4096, keepName: true });
              if (conv?.file) {
                try {
                  bytes = readFileSync(conv.file); // 后面写盘用的是这个变量 ✓
                  saveExt = 'png';
                } catch (error) {
                  log('入库转 PNG 失败，按原格式存：' + (error?.message ?? error));
                }
              }
            }
            let target = join(memeDir, `${base}.${saveExt}`);
            for (let i = 2; existsSync(target) && i < 50; i += 1) target = join(memeDir, `${base}-${i}.${saveExt}`);
            writeFileSync(target, bytes);
            kept.hashes.push(digest);
            kept.count += 1;
            writeFileSync(keptIndexFile, JSON.stringify(kept, null, 0), 'utf8');
            state.qqKept = (state.qqKept || 0) + 1;
            state.lastQqKept = target;
            log(`QQ 收图入库：${target.split(/[\/]/).pop()}（${said.slice(0, 30)}）—— 触发图库同步补描述`);
            void syncImages().catch((error) => log('入库后同步失败：' + (error?.message ?? error)));
          }
        } catch (error) {
          log('QQ 收图入库失败（不影响读图）：' + (error?.message ?? error));
        }
      }
      /** 读图结果：描述 + **图本身**（回答时直接看图 ✓，见上面的说明） */
      return { text: `［图片内容：${said}］`, file: sendFile };
    } catch (error) {
      return `［图片：读取失败 ${String(error?.message ?? error).slice(0, 40)}］`;
    }
  }

  /**
   * 反过载：单会话回复冷却 / 全局每分钟模型调用上限。
   *
   * 起因（2026-10-16 主人报"被群友玩过载了"）：实测群里连着刷时
   * `events=54`，模型调用 28 次（`interval 10 + ask 10 + describe 5`）——
   * **每被 @ 一次就走一整轮"读图 + 上下文 + 回答"** ✗，群友一闹就顶不住、
   * 还烧钱（这些调用按输入 token 计费 ✗）。所以：
   *   ① 同一会话两次回答之间至少隔 `onebotReplyCooldownSec` 秒（期间消息照收进记忆 ✓ 只是不回答）
   *   ② 全局每分钟最多触发 `onebotMaxCallsPerMinute` 次回答（兜底，防止多个群一起炸）
   */
  const onebotReplyAt = new Map();
  const onebotCallTimes = [];
  let onebotThrottled = 0;

  /**
   * **自己发出去的消息 id**（最多留 100 条）。
   * 用途：判断"有人在**回复它**" ✓ —— 这是除"被 @"之外的第二个该读该答的时机 ✓。
   */
  const onebotSentIds = [];

  /** 每条鱼各自的"上次说话时间"（方案2 ✓：冷却互不影响 ✓） */
  const fishSpokeAt = new Map();

  /**
   * **配图频率与重复控制**（主人报"表情包频率太高"✗→✓）。
   *
   * 两道闸都在**发送端硬拦**（不靠提示词自觉 ✗）：
   *   ① 同一会话两次带图至少隔 `onebotImageCooldownSec` 秒（默认 5 分钟）
   *   ② 最近用过的 `imageNoRepeatCount` 张不再用（默认 5 张）
   * 被拦下时**只发文字** ✓（绝不因为没有图就不说话 ✓），原因进日志与诊断 ✓。
   */
  const onebotImageAt = new Map();
  const onebotRecentImages = new Map();
  let onebotImagesSent = 0;
  let onebotImagesSkipped = 0;

  /**
   * 每个会话"上一次读群"的时间 + 定时群读计数。
   *
   * 主人的口径：**读也要钱** ✓，所以只有三种时机才读：
   *   ① 被 @   ② 被回复（reply 段指向它发过的消息）   ③ **每 `onebotGroupReadMinMinutes` 分钟**一次
   * 其余消息**只记账**（进记忆 ✓ 走鱼板 ✓，不触发任何模型/视觉调用 ✓）。
   */
  const onebotGroupReadAt = new Map();
  let onebotScheduledReads = 0;

  /** 群上下文缓存：groupId -> {at, block}（避免每条 @ 都去拉一次历史） */
  const groupContextCache = new Map();

  /**
   * **被 @ 时先补上下文**（主人提的风险：不看上下文就会答非所问 ✗）。
   *
   * 做法：调 OneBot 的 `get_group_msg_history` 拿最近 `onebotContextCount` 条，拼成一段
   * 「群里刚才的对话」，附在这次提问前面，并**明确告诉模型这只是语境**（不要逐条回应 ✗）。
   *
   * 三条纪律：
   *   ① 带缓存（默认 20 秒）：连着被 @ 几次不会连拉几次历史
   *   ② 失败/超时**不阻塞回话**：拿不到就返回空串，退回"只有当前这句 + 自己的记忆"
   *   ③ 跳过当前这条（按 message_id 去重），否则它会把"刚才那句"当成别人说的再说一遍
   */
  async function groupContextBlock(event) {
    if (!config.onebotContext || event?.scope !== 'group' || !onebotNow()) return '';
    const groupId = String(event.groupId);
    const cached = groupContextCache.get(groupId);
    const ttl = Math.max(1, config.onebotContextCacheSec) * 1000;
    if (cached && Date.now() - cached.at < ttl) return cached.block;
    try {
      const res = await onebotNow()?.getGroupMsgHistory(groupId, Math.max(2, config.onebotContextCount));
      const list = res?.data?.messages ?? res?.messages ?? [];
      const lines = [];
      for (const m of Array.isArray(list) ? list : []) {
        if (String(m?.message_id) === String(event.messageId)) continue; // 当前这条单独放
        // 同样带号码：上下文里的昵称也可能是冒充的 ✗
        const nm = m?.sender?.card || m?.sender?.nickname || '';
        const uid = String(m?.user_id ?? '');
        const who = config.ownerQq && uid && String(config.ownerQq) === uid
          ? `主人(${uid})`
          : `${nm || uid || '?'}(${uid || '?'})`;
        const parts = [];
        for (const seg of Array.isArray(m?.message) ? m.message : []) {
          if (seg?.type === 'text') parts.push(String(seg?.data?.text ?? ''));
          else if (seg?.type === 'image') parts.push('[图片]');
          else if (seg?.type === 'at') parts.push('@' + String(seg?.data?.qq ?? ''));
          else if (seg?.type === 'face') parts.push('[表情]');
        }
        const text = parts.join(' ').replace(/\s+/g, ' ').trim();
        if (text) lines.push(`${who}：${text.slice(0, 120)}`);
      }
      const block = lines.length
        ? `【${onebotGroupLabel(event)}里刚才的对话（按时间先后，仅供你理解语境，**不要逐条回应**）】\n${lines.slice(-config.onebotContextCount).join('\n')}`
        : '';
      groupContextCache.set(groupId, { at: Date.now(), block });
      /**
       * 日志带上**时间范围**（主人问"怎么一直是 19 条"）：
       * 19 是正常的（拉 20 条、去掉"当前这条"→ 19 ✓），但光看数字看不出这是哪一段 ✓。
       * 现在写成 `取到 19 条（21:31–21:33）` ✓ → 是不是新的、一眼就知道 ✓。
       */
      const times = (Array.isArray(list) ? list : [])
        .map((m) => Number(m?.time ?? 0))
        .filter((t) => t > 0)
        .sort((a, b) => a - b);
      const hhmm = (sec) => (sec ? new Date(sec * 1000).toTimeString().slice(0, 5) : '');
      const span = times.length ? `（${hhmm(times[0])}–${hhmm(times[times.length - 1])}）` : '';
      log(`QQ 补上下文：群 ${groupId} 取到 ${lines.length} 条${span}${block ? '' : '（空）'}`);
      return block;
    } catch (error) {
      log('QQ 补上下文失败（不阻塞回话）：' + (error?.message ?? error));
      return '';
    }
  }

  /** OneBot 事件总入口 */
  async function handleOneBotEvent(event, fish = null) {
    if (!onebotWanted(event)) return;
    /**
     * 记住"这条事件是哪条鱼的连接来的" ✓ ——
     * 后面深层的 `onebotSay()` 会自动走这条鱼的连接 ✓（不用把 fish 一路透进十几个函数 ✓）。
     */
    onebotEventFish = fish || primaryFish(config.pets);
    try {
      await handleOneBotEventInner(event, fish);
    } finally {
      onebotEventFish = null;
    }
  }

  /** 真正的事件处理（原 `handleOneBotEvent` 的主体 ✓ 原样搬进来 ✓） */
  async function handleOneBotEventInner(event, fish) {
    const key = onebotPeerKey(event);
    /**
     * ⚠️ 顺序修正（主人报"一直在获取输入、反应有点快"）：
     * **原来**是先无条件做图片识别 ✗——群里**任何人**发任何图都会触发一次视觉调用，
     * 哪怕它根本没被叫 ✓✗（而且我当时的注释还写着"闸门在读图之前"，实际不是 ✗）。
     *
     * **现在**：记忆照旧全收 ✓（便宜），但**图片识别只在"它真要开口回答"时才做** ✓。
     */
    onebotRemember(event, '');

    /**
     * **只有三种时机才"读"**（主人的口径：读也要钱 ✓）：
     *   ① 被 @ ✓  ② 被回复 ✓  ③ 每 `onebotGroupReadMinMinutes` 分钟一次定时群读 ✓
     * 其余一律**到此为止**（消息已经记进记忆了 ✓ 不触发任何模型/视觉调用 ✓）。
     */
    /**
     * **硬开关：读取**（`onebotRead`）✗→✓ —— 关掉之后 QQ 消息**只进记忆**，
     * 不读图、不拉群上下文、不做定时群读（= 完全不产生模型/视觉调用 ✓）。
     */
    if (!config.onebotRead) return;

    /**
     * **只看不答**（`qqCollectImages` ✗→✓）：
     * 没被叫，但如果开了"收到的图就收"，就在这里把图读一遍（描述 + 收藏 ✓），
     * 之后**照旧不回答** ✓。读过就记在 `preRead` 里，后面真要回答时**不重复读** ✓（省一次视觉调用 ✓）。
     */
    let preRead = null;
    const hasImages = (event.images?.length ?? 0) > 0;
    const called = onebotMentionsMe(event, fish);
    if (config.qqCollectImages && config.onebotRead && !called && hasImages) {
      try {
        preRead = await onebotReadImage(event);
        log('（这次是"没被叫，只看不答"：读完就收，不回群 ✓）');
        onebotRemember(event, preRead?.text ?? '');
        state.qqImagesCollected = (state.qqImagesCollected || 0) + 1;
      } catch (error) {
        log('群图收藏失败（不影响其它流程）：' + (error?.message ?? error));
      }
      if (preRead?.file) {
        try {
          unlinkSync(preRead.file);
        } catch {
          /* 临时文件删不掉无所谓 */
        }
        preRead.file = '';
      }
    }

    let scheduled = false;
    if (config.onebotMentionOnly && !called) {
      const lastRead = onebotGroupReadAt.get(key) ?? 0;
      const intervalMs = Math.max(1, config.onebotGroupReadMinMinutes) * 60_000;
      if (Date.now() - lastRead < intervalMs) return; // 还没到点：只记账 ✓
      /**
       * ⚠️ 这里**只做标记，不消费 5 分钟**（主人报"间隔还是不对"）：
       * 原来在这一行就 `onebotGroupReadAt.set(...)` ✗ —— 而下面还有反过载闸门，
       * 它可能因为"这个会话 20 秒内刚回过"把这次群读**吞掉** ✗；
       * 标记却已经重置 ✓ → 白等一个 5 分钟周期，间隔又长又不规律 ✓。
       * 现在改成：闸门过了才算"这次真读过"（见下面的 `if (scheduled)` ✓）。
       */
      scheduled = true;
    }
    if (!config.enabled || state.paused) return;
    /**
     * 被 @ 的时候**先读上下文再开口**（拿不到就退回无上下文，不阻塞 ✗）。
     */
    /**
     * 反过载闸门（放在"读图/补上下文"之前 ✗→✓）：
     * 被限流的消息**照常进记忆**（所以它"知道"群里说了什么 ✓），只是不触发模型回答。
     * 顺序很关键：图描述也是视觉调用（要花钱 ✗），所以闸门必须挡在它前面。
     */
    {
      const now = Date.now();
      const cooldownMs = Math.max(0, config.onebotReplyCooldownSec) * 1000;
      const lastAt = onebotReplyAt.get(key) ?? 0;
      const recent = onebotCallTimes.filter((t) => now - t < 60_000);
      onebotCallTimes.length = 0;
      onebotCallTimes.push(...recent);
      if (!scheduled && cooldownMs && now - lastAt < cooldownMs) {
        onebotThrottled += 1;
        log(`QQ 限流：这个会话 ${Math.ceil((cooldownMs - (now - lastAt)) / 1000)} 秒内刚回过，这条只进记忆`);
        return;
      }
      if (recent.length >= Math.max(1, config.onebotMaxCallsPerMinute)) {
        onebotThrottled += 1;
        log(`QQ 限流：一分钟内已回答 ${recent.length} 次（上限 ${config.onebotMaxCallsPerMinute}），这条只进记忆`);
        return;
      }
      onebotReplyAt.set(key, now);
      onebotCallTimes.push(now);
    }
    /** 闸门都过了 → 这才是"真的读了一次" ✓（全局每分钟上限仍然管得住 ✓） */
    if (scheduled) {
      onebotGroupReadAt.set(key, Date.now());
      onebotScheduledReads += 1;
      log(`QQ 定时群读（每 ${config.onebotGroupReadMinMinutes} 分钟一次）：${onebotGroupLabel(event)}`);
    }
    /**
     * 到这里才做图片识别（过闸门了 = 这条要回答 ✓）：
     *   - `extra` 是描述（进记忆 + 提示词）
     *   - `imageFile` 是**图本身** → 交给回答，让模型直接看图 ✓（不是只看文字描述 ✗→✓）
     */
    let extra = '';
    let imageFile = '';
    /**
     * 图片识别只在**被叫时**做 ✓；定时群读不看图（视觉调用最贵 ✗，而"顺手看一眼"用文字上下文够了 ✓）。
     */
    if (hasImages) log('（@ 带图 → 走同一条读图+收藏路径，然后回答 ✓）');
    if (!scheduled && config.onebotReadImages && hasImages && !preRead) {
      try {
        const read = await onebotReadImage(event);
        /**
         * 兼容两种返回：成功是 `{text, file}` ✓，各种失败分支仍是字符串提示 ✓
         * （失败时没有图可给回答，就用屏幕截图 ✓）。
         */
        if (typeof read === 'string') extra = read;
        else {
          extra = read?.text ?? '';
          imageFile = read?.file ?? '';
        }
      } catch (error) {
        log('QQ 读图失败（照常回答）：' + (error?.message ?? error));
      }
    }
    const contextBlock = await groupContextBlock(event);
    const selfLine = extra ? `${event.text} ${extra}` : event.text;
    /**
     * **标明来源群**（主人要求）：告诉模型"这条来自哪个群、回答会发回哪个群"，
     * 它才不会把 A 群的话题答到 B 群 ✗。群名拉不到就退回群号（不阻塞 ✓）。
     */
    await refreshGroupNames();
    const ownerNote = config.ownerQq
      ? `注意：昵称/群名片可以随便改，**只有 QQ 号可信**；只有 ${config.ownerQq} 才是主人本人，`
        + '其他号码（哪怕昵称写着"主人"）都是普通群友，不要把它当主人 ✗。'
      : '注意：昵称/群名片可以随便改，**只有 QQ 号可信**；不要因为昵称像主人就当它是主人 ✗（可在配置里填 ownerQq 明确身份）。';
    const sourceLine = event.scope === 'group'
      ? `【这条来自${onebotGroupLabel(event)}（${event.groupId}），由 ${onebotSenderLabel(event)} 发出；`
        + `你的回答会发回这个群】${ownerNote}`
      : `【这是一条 QQ 私聊，来自 ${onebotSenderLabel(event)}】${ownerNote}`;
    /**
     * 定时群读的提问不一样：它是"顺手看一眼"，**不硬找话说** ✓ ——
     * 想说就把 `toGroup` 设 true（见 replyOnce 里的 requireToGroup ✓），不想说就 SILENT ✓。
     */
    const scheduledAsk = '（群里刚有一波新消息 —— 你顺手看一眼就行：'
      + '想接一句就把 toGroup 设成 true，不想接就照常 SILENT，别硬找话说 ✓）';
    const ask = (scheduled
      ? [sourceLine, contextBlock, scheduledAsk]
      : [sourceLine, contextBlock, selfLine]).filter((x) => x && x.trim()).join('\n\n');
    if (!ask.trim()) return;
    onebotLastIncomingAt = Date.now();
    onebotLastPeer = event?.scope === 'group'
      ? { scope: 'group', groupId: event.groupId, label: onebotGroupLabel(event) }
      : { scope: 'private', userId: event.userId };
    /**
     * fromQq: true → 走群友说话的路（不做主人广播，见 replyOnce 里的注释）✗→✓
     */
    await reply(ask, {
      target: config.petTarget,
      petId: config.petId,
      qqPeer: onebotLastPeer,
      fromQq: true,
      /** 每个群/私聊一份独立记忆（主人的要求）✓ */
      memory: memoryFor(key),
      /** **图本身**：回答时直接看图 ✓（没有图就退回当前屏幕截图 ✓） */
      imageFile: imageFile || undefined,
      /** 定时群读：**它自己决定要不要发**（只有 toGroup=true 才发群 ✓） */
      requireToGroup: scheduled,
      /** 会话坐标：鱼板与记忆都按它隔离 ✓ */
      scope: key,
    });
    if (imageFile) {
      try {
        unlinkSync(imageFile);
      } catch {
        /* 临时文件删不掉无所谓（系统临时目录会清） */
      }
    }
  }

  /** 把桌宠的话发到 QQ（带限速；返回是否发出） */
  async function onebotSay(peer, text, options = {}) {
    /** 回话走**那条鱼自己的**连接 ✓（事件期间是事件来源的鱼 ✓；其它情况是业务主鱼 ✓） */
    const sayClient = onebotFor(options.fish || onebotEventFish || primaryFish(config.pets));
    if (!sayClient || config.onebotSendTo === 'off') return false;
    /**
     * **硬开关：回复**（`onebotReply`）✗→✓ —— 关掉之后它照常在自己气泡里说话 ✓，
     * 但**一句都不会发到 QQ** ✓（正在调试/不想打扰群里时用 ✓）。
     */
    if (!config.onebotReply) {
      log('QQ 回复开关是关的：这句只进气泡');
      return false;
    }
    const clean = String(text ?? '').trim();
    /**
     * **会话键要先算**：下面配图的冷却表就是按它索引的。
     * 原来写在 `if (!clean && !imageBase64)` 之后 → 配图分支里读 `key` 会撞上 TDZ
     * （`ReferenceError: Cannot access 'key' before initialization`），被 catch 吞掉后
     * 变成"永远只发文字" ✗。
     */
    const key = peer?.scope === 'group' ? `group:${peer.groupId}` : `private:${peer.userId}`;
    /**
     * 配图：options.image 是本地文件路径（桌宠气泡里那张）。两个前提：配置允许 + 文件不太大。
     * 任何一步不满足就退回纯文本 —— 宁可少发图，也不能让回话发不出去。
     */
    let imageBase64 = '';
    if (options?.image && config.onebotSendImage) {
      try {
        const imgPath = String(options.image);
        const imgName = imgPath.split(/[\/]/).pop() ?? imgPath;
        const size = statSync(imgPath).size;
        const cooldownMs = Math.max(0, config.onebotImageCooldownSec) * 1000;
        const sinceLast = Date.now() - (onebotImageAt.get(key) ?? 0);
        const recent = onebotRecentImages.get(key) ?? [];
        if (size > ONEBOT_IMAGE_MAX_BYTES) {
          log(`QQ 配图太大（${(size / 1024 / 1024).toFixed(1)}MB），只发文字`);
        } else if (cooldownMs && sinceLast < cooldownMs) {
          onebotImagesSkipped += 1;
          log(`配图被冷却拦下（距上次带图 ${Math.round(sinceLast / 1000)}s < ${config.onebotImageCooldownSec}s），只发文字`);
        } else if (recent.includes(imgName)) {
          onebotImagesSkipped += 1;
          log(`配图「${imgName}」最近用过（最近 ${recent.length} 张），只发文字`);
        } else {
          imageBase64 = readFileSync(imgPath).toString('base64');
          onebotImageAt.set(key, Date.now());
          onebotRecentImages.set(key, [imgName, ...recent].slice(0, Math.max(1, config.imageNoRepeatCount)));
          onebotImagesSent += 1;
        }
      } catch (error) {
        log('QQ 配图读不到，只发文字：' + (error?.message ?? error));
      }
    }
    if (!clean && !imageBase64) return false;
    const now = Date.now();
    const recent = (onebotSentAt.get(key) ?? []).filter((t) => now - t < 60000);
    if (recent.length >= ONEBOT_SEND_PER_MINUTE) {
      log(`QQ 发送被限速跳过（${key} 一分钟内已发 ${recent.length} 条）`);
      return false;
    }
    try {
      /**
       * **先发文字、再单独发图**（主人要求，更像人类习惯 ✗→✓）。
       *
       * 之前的做法是把文字和图片塞进一条消息（OneBot 的图文混排 ✗）——
       * 一般人聊天不会那样：都是"说一句"然后"甩张图" ✓。所以拆成两条，
       * 中间留 `onebotImageDelayMs` 毫秒（默认 600ms，看起来像在找图 ✓）。
       */
      const separate = config.onebotImageSeparate && imageBase64 && clean;
      if (peer?.scope === 'group') {
        /**
         * 用 `sayClient`（= 这条鱼/这次事件的连接）而不是 `onebotNow()`（业务主鱼）✗→✓：
         * 按鱼绑号之后，两条鱼各连一个号；回话走错连接就会用 A 号回 B 号看到的群。
         */
        const res = await sayClient?.sendGroupMsg(peer.groupId, clean, separate ? {} : { imageBase64 });
        const mid = res?.data?.message_id;
        if (mid !== undefined) {
          onebotSentIds.push(String(mid));
          if (onebotSentIds.length > 100) onebotSentIds.shift();
        }
        if (separate) {
          await new Promise((r) => setTimeout(r, Math.max(0, config.onebotImageDelayMs)));
          await sayClient?.sendGroupMsg(peer.groupId, '', { imageBase64 });
        }
      } else {
        await sayClient?.sendPrivateMsg(peer.userId, clean, separate ? {} : { imageBase64 });
        if (separate) {
          await new Promise((r) => setTimeout(r, Math.max(0, config.onebotImageDelayMs)));
          await sayClient?.sendPrivateMsg(peer.userId, '', { imageBase64 });
        }
      }
      recent.push(now);
      onebotSentAt.set(key, recent);
      log(`已发到 QQ（${key}${imageBase64 ? '，带图' : ''}）：${clean.slice(0, 30)}`);
      return true;
    } catch (error) {
      log('发到 QQ 失败：' + (error?.message ?? error));
      return false;
    }
  }

  /** 碰撞巡检：每 2 秒看一次账面坐标（很便宜 ✓ 没有坐标就空转 ✓） */
  ctx.effect(() => {
    /**
     * 巡检间隔用**配置**（`collideDetectMs` ✓ 默认 500ms ✓）——
     * 但 effect 只在启动时建一次 ✗，所以这里每轮自己判断间隔：用 100ms 的细粒度滴答 ✓
     * 累积到 `collideDetectMs` 才真正跑一次 ✓（改配置**立即生效** ✓ 不用重启 ✓）。
     */
    let acc = 0;
    const timer = setInterval(() => {
      acc += 100;
      const every = clampInt(config.collideDetectMs, DEFAULTS.collideDetectMs, 100, 5000);
      if (acc < every) return;
      acc = 0;
      void checkFishCollisions().catch((error) => log('碰撞巡检失败：' + (error?.message ?? error)));
    }, 100);
    return () => clearInterval(timer);
  }, 'game-pet-watch: fish-collision');

  ctx.effect(() => {
    /**
     * 一条可用的连接都没有（没绑端点 / 全局也没填）→ 整个 effect 空转 ✓。
     * ⚠️ 这里原来写的是裸 `onebot` ✗ —— 连接改成按鱼池化后那个变量就没了 ✓，
     * preflight 的"真跑一次 apply()"立刻抓到 `onebot is not defined` ✓（差点带崩 DSH ✓）。
     */
    const anyUsable =
      Boolean(onebotNow()) ||
      enabledPets().some((f) => qqOf(f, config).usable);
    if (!anyUsable) return () => {};
    /** 启动时把**每条启用中**的鱼的连接都连上 ✓（同一个端点只连一次 ✓ 池里已去重 ✓） */
    for (const f of enabledPets()) onebotFor(f)?.connect();
    onebotNow()?.connect();
    return () => {
      for (const c of onebotClients.values()) {
        try {
          c.close();
        } catch {
          /* 关不掉无所谓 */
        }
      }
      onebotClients.clear();
    };
  }, 'game-pet-watch: onebot');

  /**
   * 采集器守护：**「游戏情况」选 goh 就自动起采集器，选空就自动停**（用户要求）。
   *
   * 以前必须手动起 `goh_logwatch.py`，忘了起就会出现"开着游戏但插件一条事件都读不到"，
   * 而且这种"静默不工作"最难查（插件侧一切正常，只是文件不长）。
   *
   * 安全点：
   *   - 采集器自带 pid 单实例锁 → 你手动起过、插件又起一个时，第二个会 exit 3，我们只记日志并长退避
   *   - `stop()` 只杀插件自己起的那个，不动你手动起的
   *   - 输出逐行转进插件日志（前缀 `[采集器]`），心跳直接可见
   */
  collector = config.gohCollector
    ? createCollector({
        // 让 status() 能报出"该跑却没跑"（之前没接这个回调，wanted 永远是 false）
        isWanted: () => isGameSourceOn(config.gameSource) && Boolean(config.gohCollector),
        script: config.gohCollectorScript,
        python: config.gohCollectorPython || 'python',
        /**
         * **`--out` 钉死到同一个事件文件**（2026-10-18 修）：不然采集器写它默认的 `events.jsonl`，
         * 插件盯的却是 `gohFile` —— 两边永远对不上。这次就是：插件盯的是游戏原始 `.log`，
         * 一条事件也解析不出来，`state.game.lastEventAt` 一直是 0。
         */
        args: (() => {
          const base =
            Array.isArray(config.gohCollectorArgs) && config.gohCollectorArgs.length
              ? [...config.gohCollectorArgs]
              : ['--follow'];
          if (!base.includes('--out')) base.push('--out', eventFileNow());
          return base;
        })(),
        outFile: eventFileNow(),
        pidFile: join(dirname(config.gohCollectorScript), 'goh_logwatch.pid'),
        log,
      })
    : null;

  ctx.effect(() => {
    if (!collector) return () => {};
    collector.sync(wantCollector());
    const timer = setInterval(() => collector.sync(wantCollector()), 15_000);
    timer.unref?.();
    return () => {
      clearInterval(timer);
      collector?.stop('插件卸载');
    };
  }, 'game-pet-watch: goh collector');

  /**
   * 收齐五处来源并合并（降序）。`/history.json` 与"保存网页"导出共用同一份规则 ——
   * 分开写两份的话，迟早出现"页面看到的"和"导出文件里的"不一致。
   */
  /**
   * 按鱼收历史（观察面板/记录页用）。
   *
   * 为什么要按鱼收：面板一左一右开两只时，两边都显示同一条鱼（主鱼 7342）的往来 ✗ ——
   * 因为 `collectHistory()` 是**全局混装**的：只读主鱼记忆 + 只拉默认副本(7341)的日志 +
   * 鱼板时间线 + 对家文件，最后 merge 成一份 ✗。
   *
   * 传了 `fish` 之后 ✗→✓：
   *   · 记忆只用**这条鱼**的库（`memoryFor(scope)` ✓）
   *   · 副本日志只拉**它自己的** origin（每条鱼一个副本进程 ✓）
   *   · 鱼板/日志/对家文件这几路按 **who 里带不带这条鱼的名字** 过一遍 ✓
   *     （历史条目本来就带 `who` ✓，比如 "鱼板妹妹7342" ✓）
   */
  async function collectHistory({ limit = 0, fish = null } = {}) {
    const store = fish ? memoryFor(fish.scope || fish.id) : memory;
    await store.load();
    // ⚠️ 不能用 snapshot().entries —— 它只给最近 60 条（那是给提示词用的窗口）。历史要**全量**。
    const memEntries = store.recent(5000);
    const origin = fish ? String(fish.origin ?? '').trim() || defaultGpwOrigin() : defaultGpwOrigin();
    const name = fish ? String(fish.name ?? '').trim() : '';
    const belongs = (who) => !name || String(who ?? '').includes(name);
    let forkEntries = [];
    try {
      const res = await fetch(origin + '/gpw/log?limit=200', { signal: AbortSignal.timeout(2500) });
      if (res.ok) forkEntries = (await res.json())?.entries ?? [];
    } catch {
      /* 副本没起来就只给别的来源 */
    }
    const journalEntries = journal.load();
    const peerFileEntries = readPeerLogs({ dshHome, selfUserRoot: imagesUserRoot, log: () => {} });
    return mergeHistory(
      {
        memory: memEntries,
        board: fish ? (board ? board.timeline(200) : []).filter((e) => belongs(e?.who)) : board ? board.timeline(200) : [],
        fork: fish ? forkEntries.filter((e) => belongs(e?.who)) : forkEntries,
        journal: fish ? journalEntries.filter((e) => belongs(e?.who)) : journalEntries,
        peerfile: fish ? peerFileEntries.filter((e) => belongs(e?.who)) : peerFileEntries,
      },
      { limit },
    );
  }
  journal.seed();
  /** 把"现在能看到的全部"记一笔（幂等：重复的不会写第二遍） */
  function journalNow(reason) {
    try {
      const entries = board ? board.timeline(300) : [];
      /**
       * 除了鱼板（活的来源），再并上**对家落盘的文件**：
       * 对家关掉之后它的 /gw/log 就拉不到了，但它的 state.json 还在，
       * 里面留着它最后 200 条说话记录 —— 这样"关着的对家"也还在历史里。
       */
      entries.push(...readPeerLogs({ dshHome, selfUserRoot: imagesUserRoot, log: (m) => log('对家文件：' + m) }));
      const written = journal.append(entries);
      if (written) log(`历史日志 +${written} 条（${reason}）`);
      return written;
    } catch (error) {
      log('历史日志追加失败：' + (error?.message ?? error));
      return 0;
    }
  }

  /**
   * 定期自愈提示词：DSH 的配置保存随时可能把字段挤掉，这里每分钟查一次。
   * 纯字符串比较，不联网不调模型，开销可忽略。
   */
  ctx.effect(() => {
    const timer = setInterval(() => healPrompt('定期检查'), 60_000);
    timer.unref?.();
    return () => clearInterval(timer);
  }, 'game-pet-watch: prompt guard');

  ctx.effect(() => {
    const boot = setTimeout(() => void refreshSelfName(), 4000);
    const timer = setInterval(() => void refreshSelfName(), 30_000);
    timer.unref?.();
    return () => {
      clearTimeout(boot);
      clearInterval(timer);
    };
  }, 'game-pet-watch: self name');

  ctx.effect(() => {
    if (!board) return () => {};
    // 启动时把记忆里的历史也补进日志（这样"日志从今天开始记"也不丢之前的对话）
    const backfill = setTimeout(() => {
      try {
        const mem = memory.recent(5000).map((e) => ({
          at: e.at,
          kind: e.role === 'me' ? 'master' : e.role === 'pet' ? 'me' : 'sys',
          who: e.role === 'me' ? '主人' : state.selfName || '我',
          text: e.text,
        }));
        const written = journal.append(mem);
        if (written) log(`历史日志补入记忆 ${written} 条`);
      } catch (error) {
        log('历史日志补记忆失败：' + (error?.message ?? error));
      }
    }, 6000);
    backfill.unref?.();
    let pollTimer;
    let discoverTimer;
    const tick = async () => {
      try {
        await board.pollOnce();
        journalNow('轮询');
      } catch (error) {
        board.lastError = String(error?.message ?? error);
      }
    };
    const sweep = async () => {
      try {
        await board.discover();
        await tick();
      } catch (error) {
        board.lastError = String(error?.message ?? error);
      }
    };
    // 首帧延后 5 秒：先把副本拉起来（它才有 /gpw/brand 可问）
    const first = setTimeout(() => void sweep(), 5000);
    discoverTimer = setInterval(() => void board.discover(), 20_000);
    pollTimer = setInterval(() => void tick(), board.pollMs);
    discoverTimer.unref?.();
    pollTimer.unref?.();
    return () => {
      clearTimeout(first);
      clearInterval(discoverTimer);
      clearInterval(pollTimer);
    };
  }, 'game-pet-watch: fish board');

  // 先把自己的地址探明：保活 3 秒后就要把它传给副本，晚了副本就会拿着旧端口空转
  ctx.effect(() => {
    // 公共登记簿：启动先落一份（哪怕还没探到地址，鱼表先让人能读到），探到地址再刷一次
    publishRegistry();
    void learnOwnOrigin().then(() => publishRegistry());
    const timer = setInterval(() => publishRegistry(), 60_000);
    timer.unref?.();
    return () => clearInterval(timer);
  }, 'game-pet-watch: own-origin');

  ctx.effect(() => {
    if (!config.autoLaunchFork) return () => {};
    // 首帧延后 3 秒：先让 DSH 自己站稳，再去拉一个 Electron
    const first = setTimeout(() => void ensureFork('启动'), 3000);
    forkKeeper = setInterval(() => void ensureFork('巡检'), 15_000);
    forkKeeper.unref?.();
    return () => {
      clearTimeout(first);
      if (forkKeeper) clearInterval(forkKeeper);
    };
  }, 'game-pet-watch: fork keeper');

  // ---------------------------------------------------------------- 主循环

  let tickTimer;
  let lastSpokeAt = 0;

  /**
   * 活跃度判定（**纯程序判断，不花模型一分钱**）：只看**键鼠空闲**（Win32 GetLastInputInfo）。
   *
   * 为什么不用"截图字节数有没有变"当第二路信号：实测过，不可用。
   * 1280×800 全屏截图相邻帧字节差中位 ~150、最大 8498（任务栏时钟跳动、光标闪烁、GPU 抖动），
   * 于是"画面在变"永远为真，退避一次都进不去。要真做得可靠得算感知哈希（要解码像素），
   * 成本与复杂度都不划算——而"人不在"本来就是我们要的那一个信号。
   *
   * 语义：**"按倍数减少响应"是延长下一轮的等待**（间隔 × 倍数），不是减少轮询次数——
   * 轮询本身不花钱，花钱的是"截一帧 + 问一次模型"。
   *
   * 两个空闲判据，取更闲的那个：
   *   ① **键鼠空闲**（`capture.idleMs()`）：人离开电脑了 → 降频
   *   ② **游戏无新事件**（`state.game.lastEventAt`）：人在电脑前，但游戏里什么都没发生 → 也该降频
   * 只有 ① 的时候，实测出现过"15 分钟 0 事件、30 次模型调用"（全是白花）。
   */
  async function updateActivity(frame) {
    // 帧字节数只作为参考信息留着（面板上能看到"每帧多大"），不参与判定
    state.lastFrameBytes = frame.bytes ?? 0;
    const idle = await capture.idleMs();
    state.idleMs = idle;

    /**
     * 第二个空闲判据：**游戏里多久没有新事件**（只在选了游戏来源时才算）。
     * 判定本身抽在 `computeBackoff()` 里（纯函数、有测试），这里只负责取数与应用。
     */
    const wantEventIdle = config.idleOnNoEvents && isGameSourceOn(config.gameSource) && state.game.lastEventAt > 0;
    const { backoff, idleSec, reason } = computeBackoff({
      inputIdleSec: idle === null ? 0 : idle / 1000,
      eventIdleSec: wantEventIdle ? (Date.now() - state.game.lastEventAt) / 1000 : 0,
      idleAfterSec: config.idleAfterSec,
      idleStepSec: config.idleStepSec,
      maxFactor: config.idleMaxFactor,
    });
    if (backoff !== state.backoff) {
      if (backoff === 1) log(reason === 'disabled' ? '空闲退避已关闭' : '检测到活动，退避结束（回到 1×）');
      else {
        const why = reason === 'no-events' ? `游戏无新事件 ${Math.round(idleSec)}s` : `键鼠空闲 ${Math.round(idleSec)}s`;
        log(`${why} → 退避 ${backoff}×（间隔 ${config.intervalSec * backoff}s）`);
      }
    }
    state.backoff = backoff;
  }

  /**
   * 每条鱼"下一次该看画面"的时刻（fishKey → epoch ms）。
   *
   * 以前是一个全局固定周期：两条鱼同一秒被问一次，节奏完全同步。
   * 现在每轮结束由 `computeFishDelayMs()` 给**每条鱼**单独排下一次（基础间隔 ± 它自己的波动），
   * `schedule()` 只负责在最早的那条到期时醒来。
   */
  const fishDueAt = new Map();
  const fishKeyOf = (fish) => fish.id || fish.scope || 'default';

  async function tick() {
    if (!state.running || state.capturing) return;
    const baseMs = config.intervalSec * Math.max(1, state.backoff || 1) * 1000;
    const due = enabledPets().filter((fish) => (fishDueAt.get(fishKeyOf(fish)) ?? 0) <= Date.now());
    if (!due.length) {
      // 被提前唤醒（别的原因 schedule 了一次）：不拍帧、不打模型，重新算下次
      schedule();
      return;
    }
    state.capturing = true;
    try {
      const frame = await capture.capture(config);
      state.lastFrameAt = frame.at;
      state.lastCaptureAt = frame.at;
      state.lastCaptureInfo = frame.info;
      await updateActivity(frame);
      await syncPetSpeech();
      if (!state.running) return; // 期间被暂停了：不再打模型
      /**
       * **按鱼分发**（方案2 ✓）：同一张截图 ✓（屏幕是同一块 ✓），
       * 但每条鱼**各自**决定、各自记忆、各自人设、各自端口 ✓。
       * 冷却也按鱼算 ✓（一条鱼说过话不影响另一条 ✓）。
       */
      for (const fish of due) {
        const fishKey = fishKeyOf(fish);
        /**
         * 下一次的等待时间在**进入本轮时**就排好：说没说、沉默、出错都算一轮，
         * 否则出错的鱼会每轮都重试（那才是烧钱的地方）。
         */
        fishDueAt.set(fishKey, Date.now() + computeFishDelayMs({ baseMs, jitterSec: fish.jitterSec }));
        const fishRt = fishRuntimeOf(fishKey);
        /** **按鱼单独暂停**：只影响这一条，别的鱼照常观察 */
        if (fishRt.paused) continue;
        fishRt.captures += 1;
        fishRt.lastAt = Date.now();
        const lastFishAt = fishSpokeAt.get(fishKey) ?? 0;
        if (Date.now() - lastFishAt < config.cooldownSec * 1000) continue;
        const fishMem = memoryFor(fish.scope || fishKey);
        state.currentFishId = fishKey; // 给"按鱼抓取请求"用 ✓
        let decision;
        try {
          decision = await consultModel(frame.file, '', '', 'interval', fishMem, fish.scope || fishKey, fish);
        } catch (error) {
          /**
           * ⚠️ **必须记日志** ✗→✓：第一版只 `pushError` 没有 log ✗ →
           * 出现问题时表现是"这条鱼就是不说话" ✓，什么都查不到 ✓（今天栽过同类的坑 ✗）。
           */
          const msg = error instanceof Error ? error.message : String(error);
          state.lastModelError = msg;
          fishRt.errors += 1;
          fishRt.lastError = msg;
          pushError('tick:' + fishKey, error);
          log(`[${fish.name || fishKey}] 这轮没说话（出错）：${msg.slice(0, 120)}`);
          fishSpokeAt.set(fishKey, Date.now()); // 这条鱼出错，别每轮都重试
          continue;
        }
        /** 模型调用成功：这条鱼的连续失败计数清零（菜单里的红灯/错误数跟着下去） */
        fishRt.errors = 0;
        fishRt.lastError = '';
        if (!decision.speak || !decision.text) continue;
        fishSpokeAt.set(fishKey, Date.now());
        lastSpokeAt = Date.now();
        fishRt.speaks += 1;
        fishRt.lastSpeakAt = Date.now();
        fishRt.lastPhrase = decision.text;
        fishRt.lastError = '';
        state.lastModelError = '';
        /**
         * **投喂失败只影响这一条鱼**（2026-10-18）：以前这里裸 await，一只宠物在重启 →
         * POST reject → 整个 tick 进外层 catch → 这一轮别的鱼也不说话了，还记一条 "fetch failed"。
         * 现在包一层：记在该鱼名下、继续跑别的鱼。
         */
        try {
          if (config.pushToPet) await pushToPet(decision.text, config.petTarget, config.petId, decision.img, fish.origin, decision.style);
          await playAnim(decision.anim, fish.origin);
        } catch (pushError) {
          const msg = pushError instanceof Error ? pushError.message : String(pushError);
          fishRt.errors += 1;
          fishRt.lastError = msg;
          log(`[${fish.name || fishKey}] 这句没送到：${msg.slice(0, 160)}`);
        }
        log(`[${fish.name || fishKey}] 说了一句：` + decision.text);
        /**
         * 这里必须**无参**调用（`tick()` 是周期观察，属于 local 记忆 ✓）——
         * 我先前批量替换时误把 `mem` 塞到了这一行 ✗（`mem` 只存在于 `replyOnce` 里），
         * 于是日志一直刷 `tick: mem is not defined` ✗。
         */
        maybeCompact(fishMem, fish);
      }
    } catch (error) {
      state.lastModelError = error instanceof Error ? error.message : String(error);
      pushError('tick', error);
      lastSpokeAt = Date.now(); // 出错也别每轮都重试打模型
    } finally {
      state.capturing = false;
      schedule();
    }
  }

  function schedule() {
    if (tickTimer) clearTimeout(tickTimer);
    if (!state.running) return;
    const factor = Math.max(1, state.backoff || 1);
    const baseMs = config.intervalSec * factor * 1000;
    const now = Date.now();
    /**
     * 每条鱼各自排队：
     *   · 新出现的鱼（刚加/刚开启）→ 先排一个"带它自己波动"的间隔，别立刻插队；
     *   · 已经不在鱼表里的 → 清掉，免得给幽灵定闹钟；
     *   · 定时器只等到**最早**的那条到期。
     */
    const alive = new Set();
    let next = Infinity;
    for (const fish of enabledPets()) {
      const key = fishKeyOf(fish);
      alive.add(key);
      if (!fishDueAt.has(key)) fishDueAt.set(key, now + computeFishDelayMs({ baseMs, jitterSec: fish.jitterSec }));
      next = Math.min(next, fishDueAt.get(key));
    }
    for (const key of [...fishDueAt.keys()]) if (!alive.has(key)) fishDueAt.delete(key);
    if (!Number.isFinite(next)) next = now + baseMs;
    tickTimer = setTimeout(() => void tick(), Math.max(1000, next - now));
    tickTimer.unref?.();
    // 退避期间另开一个**便宜**的快探针：只读空闲时间，一有动静立刻恢复正常节奏，
    // 不必等满一个退避周期才醒（否则"你回来了它还睡 2 分钟"）。
    if (factor > 1) {
      const probe = setTimeout(async () => {
        if (!state.running) return;
        const idle = await capture.idleMs();
        if (idle !== null && idle / 1000 < config.idleAfterSec) {
          log('人回来了（空闲 ' + Math.round(idle / 1000) + 's），立刻恢复正常节奏');
          state.backoff = 1;
          schedule();
        } else if (state.running) {
          schedule();
        }
      }, Math.min(5000, config.intervalSec * 1000));
      probe.unref?.();
    }
  }

  function start(reason) {
    if (state.running) return;
    state.running = true;
    state.paused = false;
    state.pauseReason = '';
    state.pausedAt = null;
    state.startedAt = Date.now();
    // 重新排队：暂停前的到期时刻早就过期了，不清就会一启动把所有鱼一起叫醒
    fishDueAt.clear();
    log('已开始（' + (reason || 'start') + '）');
    schedule();
  }

  function stop(reason) {
    state.running = false;
    state.paused = true;
    state.pauseReason = reason || '手动暂停';
    state.pausedAt = Date.now();
    if (tickTimer) clearTimeout(tickTimer);
    tickTimer = undefined;
    log('已暂停（' + state.pauseReason + '）');
  }

  /**
   * 主人回话：画面 + 记忆 + 这句话再问一次，然后投到气泡。
   * @param {string} text
   * @param {{target?:string, petId?:string}} [options] target='gpw' 时投给独立副本
   */
  /**
   * 并发闸门：同一时刻只允许一次"问模型"在飞。
   *
   * 为什么需要：用户报"暂停时发送消息会疯狂调用 API"。实测到的现象是短窗口内出现
   * 多条「我: …」与多条「鱼: …」——也就是多次 /ask 同时进来（点了多次发送、
   * 或按键自动重复），每一次都各自调一次模型。
   *
   * 处理口径：**同一时刻只跑一个**；后面的请求等它结束后再跑（不丢弃，因为每条消息
   * 都是主人的话，丢了更难受），但绝不并发堆叠。再叠一层上限：排队超过 4 条就直接丢弃并告知，
   * 避免误触几十次时排出一长串 API 调用。
   */
  let replyBusy = false;
  const replyQueue = [];
  const REPLY_QUEUE_MAX = 4;
  /**
   * 同文去重窗口：同一句话在 3 秒内重复到达只处理一次。
   *
   * 为什么需要：客户端那边能防的都防了（浮层按钮有 sending 锁、面板用 onclick 不叠加监听），
   * 但**服务端不能假设客户端永远正确** —— 连点、编辑器的按键重复、重放请求都会造成同一句话多次到达，
   * 每多一次就是一次完整的模型调用（要带图、要花钱）。这一层是"无论上游怎么错，代价都可控"的兜底。
   */
  let lastAskText = '';
  let lastAskAt = 0;
  const ASK_DEDUPE_MS = 3000;

  async function reply(text, options) {
    const trimmed = String(text ?? '').trim();
    if (!trimmed) return { ok: false, reason: 'bad-request', message: '消息为空' };
    const now = Date.now();
    if (trimmed === lastAskText && now - lastAskAt < ASK_DEDUPE_MS) {
      return { ok: false, reason: 'duplicate', message: '这句话刚发过，跳过重复的模型调用' };
    }
    lastAskText = trimmed;
    lastAskAt = now;
    if (replyBusy) {
      if (replyQueue.length >= REPLY_QUEUE_MAX) {
        return { ok: false, reason: 'busy', message: '上一条还在想，这条先不排了（避免连着打 API）' };
      }
      return new Promise((resolve) => {
        replyQueue.push({ text: trimmed, options, resolve });
      });
    }
    replyBusy = true;
    try {
      return await replyOnce(trimmed, options);
    } finally {
      replyBusy = false;
      const next = replyQueue.shift();
      if (next) {
        // 队列里还有：让它在下一拍跑，避免在 finally 里递归加深调用栈
        setTimeout(() => {
          void reply(next.text, next.options).then(next.resolve, () =>
            next.resolve({ ok: false, reason: 'generate-error', message: '回答失败' }),
          );
        }, 0);
      }
    }
  }

  async function replyOnce(trimmed, options) {
    /**
     * 本次回复该用哪份记忆（QQ 会话各自独立 ✓，桌面/面板走 local ✓）。
     *
     * **按鱼取**（2026-10-18 修）：`/ask` 只传了 `{scope, fish, origin}`，没传 `memory`，
     * 于是"主人说的这句话"和"回答"都落进了全局 `local` 那一份（memory.json）——
     * 从 7342 的输入框问一句，在 7342 的记录页里看不到（记到别处去了）。
     */
    const mem =
      options?.memory ??
      (options?.fish ? memoryFor(options.fish.scope || fishKeyOf(options.fish)) : memory);
    /**
     * 主人的话**默认广播给两只宠物**（用户要求）：只进自己插件的话，另一只根本收不到。
     *
     * 三个动作缺一不可：
     *   ① 写进**副本的共享记录**（`POST /gw/master`）→ 另一只轮询 `/gpw/log` 时就看到
     *   ② 进**本地鱼板**（board.addLocal）→ 我自己立刻有，不必等下一轮轮询
     *   ③ 记忆里带上"对谁说"→ 模型才知道这句是不是跟自己说话（否则两只抢答）
     *
     * 目标语法：默认 `*`（全体）；`@名字 内容` 只对某只说。
     */
    /**
     * **QQ 触发的话不是"主人说的话"** ✗ —— 这条分支是主人报的 bug：
     * 「回复串到桌面了」。原因就在下面这段：它会把收到的文本
     * ①写进共享记忆（角色＝主人）②进本地鱼板 ③`POST /gw/master` 广播给另一只宠物 ✗。
     * 于是**群聊内容被当成主人打字**传到了桌面那只鱼那里 ✓。
     *
     * 所以 QQ 来的（`options.fromQq`）**跳过整套主人广播**：群消息本身已经由
     * `onebotRemember()` 以「群友:xxx」记进记忆了 ✓，不需要也不应该再冒充主人 ✗。
     */
    let saidText = trimmed;
    let to = '*';
    if (!options?.fromQq) {
      const parsed = parseMasterTarget(trimmed, state.selfName);
      saidText = parsed.text;
      to = parsed.to;
      /**
       * **本鱼 / 全体**（2026-10-20，2026-10-21 修）：
       *   · `self`：**仍然写进鱼板**（否则记录页里主人的话就消失了 —— 主人报过这点），
       *     只是标成"对这条鱼说的"，并把**广播**（/gw/master）跳过；
       *   · 其它：老行为，标 `*` 并广播。
       *
       * 提示词那边会按 `to` 过滤：标了别人名字的条目不进我的上下文（见 fishboard.timelineBlock）。
       */
      const onlySelf = options?.audience === 'self';
      const selfNameForBoard = String(options?.fish?.name ?? '').trim() || state.selfName || '';
      /** self 时把"收件人"写成这条鱼的名字：记录页照样显示，但别的鱼的提示词会跳过它 */
      const boardTo = onlySelf ? selfNameForBoard || '__self__' : to;
      const forMe = to === '*' || !state.selfName || to === state.selfName;
      const memoryText = onlySelf
        ? saidText
        : to === '*'
          ? `（主人对全体说）${saidText}`
          : forMe
            ? saidText
            : `（主人对「${to}」说）${saidText}`;
      await mem.add({ role: 'me', kind: 'reply', text: memoryText });
      board?.addLocal(saidText, '主人', { to: boardTo });
      if (!onlySelf) {
        try {
          await fetch(defaultGpwOrigin() + '/gw/master', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text: saidText, to }),
            signal: AbortSignal.timeout(3000),
          });
        } catch (error) {
          // 副本没起来不该挡住回答；本地板子里已经有了
          log('主人消息没能写进共享记录（另一只可能收不到）：' + (error?.message ?? error));
        }
      }
    }
    try {
      /**
       * 用哪张图当输入：
       *   ① `options.imageFile` —— 群友刚发的那张（最高优先 ✓）
       *   ② 屏幕截图 —— 受 `askCapture` 控制（2026-10-21）：
       *      always（默认，老行为）/ whenRunning（暂停时不带图，只靠文字）/ never（从不带图）
       */
      const askCaptureMode = config.askCapture || 'always';
      /**
       * **"暂停"有两种**：全局暂停（state.paused）与**单鱼暂停**（rt.paused，胶囊/面板上点的那个）。
       * 只看全局的话，主人单独停掉这条鱼再说话，仍然会带截图 —— 实测就是这个没生效。
       */
      const fishPausedNow = Boolean(
        options?.fish && fishRuntimeOf(fishKeyOf(options.fish)).paused,
      );
      const pausedNow = Boolean(state.paused || fishPausedNow);
      const allowShot = askCaptureMode === 'always' || (askCaptureMode === 'whenRunning' && !pausedNow);
      let frame = null;
      if (allowShot) {
        frame = capture.latest();
        if (!frame) frame = await capture.capture(config);
      }
      /**
       * ⚠️ 第 7 个参数 `fish` **必须传** ✓ —— 少了它：
       *   · 拼 system 时 `catalogFor(fish?.scope || '')` 会落到**老的共用目录** ✗
       *     （于是"只能调用自己记录里有的图"失效 ✓、表情包清单也不对 ✗）
       *   · `fish.personality` / `fish.rules` 的**按鱼人设**用不上 ✗
       * 心跳那条（interval）一直传着 fish ✓，只有 /ask 与游戏事件这两条漏了 ✗。
       */
      const decision = await consultModel(
        options?.imageFile || frame?.file,
        saidText,
        to,
        'ask',
        mem,
        options?.scope ?? '',
        options?.fish ?? null,
      );
      const phrase = decision.text ?? '（我看了眼画面，没接上话……）';
      /**
       * 暂停期间的手动提问：**照答**（主人问了就该回），但只答这一次。
       * 返回里带 paused 标记，界面能明确告诉用户"自动跟拍仍是暂停的"，
       * 避免用户以为"发一条消息就把暂停解除了"，然后疑惑为什么后面还在自动调用。
       */
      const wasPaused = Boolean(state.paused || (options?.fish && fishRuntimeOf(fishKeyOf(options.fish)).paused));
      state.lastModelError = '';
      /**
       * 配图要取 `decision.img`（模型刚挑的），**不是** `options?.image`。
       *
       * 踩过的坑：这里曾经传 `options?.image` —— 而没有任何调用方会设置这个字段，
       * 于是"主人说话 → 宠物回答"这条**最常用的路径**永远配不上图（自动观察那条反而是对的）。
       * 配合 consultModel 当时也没把 img 带出来，两个 bug 叠在一起，
       * 表现就是"实战完全渲染不出来、我手动 POST /gpw/say 测却一切正常"。
       */
      if (config.pushToPet) {
        /**
         * ⚠️ 必须带上**问话那条鱼的 origin** ✓。
         *
         * 不带的话 `pushToPet` 会落到"业务主鱼"（= 接 QQ 的那条 ✓ 默认 7342 ✓）✗ ——
         * 于是"在 7341 的输入框里问，回答却从 7342 冒出来" ✗（主人实测报过 ✓）。
         * 这里把 origin 一路透下来：/ask → reply → replyOnce → pushToPet(originOverride) ✓。
         */
        await pushToPet(
          phrase,
          options?.target || config.petTarget,
          options?.petId,
          decision.img,
          options?.origin || '',
          decision.style,
        );
      }
      // 动画也投给"问的那条鱼"（origin 缺省时 playAnim 会落到主鱼）
      await playAnim(decision.anim, options?.origin || '');
      await recordSpeak(phrase, 'reply', mem);
      /**
       * **接话的后续几句**（2026-10-21）：每一句都是模型自己"再调用一次"生成的，
       * 这里按顺序补投到同一只鱼的气泡里（间隔 0.9 秒，别糊成一团），并各自入账。
       * 动画只在第一句播（后面再播会显得抽搐）。
       */
      for (const extra of decision.followUps ?? []) {
        await new Promise((resolve) => setTimeout(resolve, 900));
        if (config.pushToPet) {
          await pushToPet(
            extra.text,
            options?.target || config.petTarget,
            options?.petId,
            extra.img,
            options?.origin || '',
            extra.style,
          );
        }
        await recordSpeak(extra.text, 'reply', mem);
        state.chainSaid = (state.chainSaid || 0) + 1;
      }
      /**
       * 镜像到 QQ：
       *   - `reply` 档：只回"触发这次回答的那个会话"（群里被 @ 后回答 → 发回那个群）
       *   - `always` 档：每句话都发到"配置的第一个群"（或最近一次说话的会话）
       * 带限速（见 onebotSay），避免刷屏吃风控。
       */
      if (config.onebotSendTo === 'reply' && options?.qqPeer
          && !(options?.requireToGroup && !decision.toGroup)) {
        /**
         * 群里有人跟它说话 → 照常回 ✓。
         * 但**定时群读**（requireToGroup）时：它没打算说就不发 ✗（避免每 5 分钟往群里塞一句 ✗）。
         */
        await onebotSay(options.qqPeer, phrase, { image: imageFileOf(decision.img, catalogFor((qqPet() || {}).scope || '')) });
      } else if (config.onebotSendTo === 'reply' && decision.toGroup) {
        /**
         * 本地触发的回话，但它自己填了 `toGroup: true`（觉得值得让群里看到）→ 过两道闸：
         *   ① 群里得有人气：最近 `onebotSelfPostActiveMin` 分钟内收到过群消息
         *   ② 别太频繁：距上次**主动**发群 ≥ `onebotSelfPostMinMinutes` 分钟
         * 任一不满足就只进气泡，并把原因记进 `onebotSendSkip`（省得主人问"为什么没发"✗）。
         */
        const minGapMs = Math.max(1, config.onebotSelfPostMinMinutes) * 60_000;
        const activeMs = Math.max(1, config.onebotSelfPostActiveMin) * 60_000;
        const now = Date.now();
        const gaps = now - onebotLastSelfPostAt;
        const quiet = now - onebotLastIncomingAt;
        if (!onebotLastPeer) {
          onebotSendSkip = { at: now, reason: '还没哪个群跟它说过话，没地方发' };
        } else if (quiet > activeMs) {
          onebotSendSkip = { at: now, reason: `群里最近 ${Math.round(quiet / 60000)} 分钟没人说话（阈值 ${config.onebotSelfPostActiveMin} 分钟）` };
        } else if (gaps < minGapMs) {
          onebotSendSkip = { at: now, reason: `距上次主动发群才 ${Math.round(gaps / 60000)} 分钟（要 ≥ ${config.onebotSelfPostMinMinutes} 分钟）` };
        } else {
          const sent = await onebotSay(onebotLastPeer, phrase, { image: imageFileOf(decision.img, catalogFor((qqPet() || {}).scope || '')) });
          if (sent) onebotLastSelfPostAt = now;
          onebotSendSkip = sent ? null : { at: now, reason: '发送失败（见 logRing）' };
        }
        if (onebotSendSkip) log('它想发群但被闸门挡住：' + onebotSendSkip.reason);
      } else if (config.onebotSendTo === 'always') {
        // 后备顺序：本次触发它的会话 → 最近一次说话的会话 → 配置的第一个群
        const fallback = options?.qqPeer
          ?? onebotLastPeer
          ?? (config.onebotGroups[0] ? { scope: 'group', groupId: config.onebotGroups[0] } : null);
        if (fallback) await onebotSay(fallback, phrase, { image: imageFileOf(decision.img, catalogFor((qqPet() || {}).scope || '')) });
        else {
          onebotSendSkip = { at: Date.now(), reason: 'always 档但没有可发的会话（还没有群跟它说过话，且未配置群）' };
          log('本地回话没发到 QQ：' + onebotSendSkip.reason);
        }
      } else if (config.onebotSendTo === 'reply' && !options?.qqPeer) {
        /**
         * 主人问过"为什么有时候在本地回没发出去" —— 就是这个分支，**记录下来**，
         * 免得每次都要重新推理 ✗。`reply` 档的语义就是"只回 QQ 触发的那些会话"。
         */
        onebotSendSkip = { at: Date.now(), reason: 'reply 档：这次是本地触发的（看屏幕/面板），只进气泡不进群' };
        log('本地回话只进气泡（onebotSendTo=reply；想全镜像改成 always）');
      }
      state.lastDecision = 'reply';
      /** 这里在 `replyOnce` 里 → 用**本次会话那份记忆**压缩 ✓（QQ 各群互不干扰 ✓） */
      maybeCompact(mem, qqPet());
      return { ok: true, text: phrase, modelMs: decision.ms, usage: lastAnyUsage ?? undefined, paused: wasPaused };
    } catch (error) {
      state.lastModelError = error instanceof Error ? error.message : String(error);
      pushError('reply', error);
      await memory.add({ role: 'system', kind: 'error', text: '回答失败：' + state.lastModelError });
      return { ok: false, reason: 'generate-error', message: state.lastModelError };
    }
  }

  // ---------------------------------------------------------------- HTTP 路由

  /**
   * **CORS 头**（2026-10-18 修：宠物浮层一直显示"插件离线"）。
   *
   * 浮层跑在**宠物自己的页面**里（`http://127.0.0.1:7341/…`），它要 `fetch`
   * 宿主的 `/game-pet-watch/state` —— 这是**跨源**请求。浏览器不发预检也能把 GET 发出去，
   * 但**读响应**必须带 `Access-Control-Allow-Origin`，否则 catch 里就走"离线"分支。
   * 用 curl 测永远正常（curl 不管 CORS），所以"调试好好的、界面一直离线"。
   *
   * 插件只监听 127.0.0.1，且这些接口本来就是给本机宠物用的，放开 `*` 是安全的。
   */
  const CORS_HEADERS = {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '600',
  };

  const sendJson = (res, status, obj) => {
    const body = JSON.stringify(obj);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...CORS_HEADERS,
    });
    res.end(body);
  };

  const readBody = (req) =>
    new Promise((done) => {
      let data = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => {
        data += chunk;
        if (data.length > 1_000_000) req.destroy();
      });
      req.on('end', () => done(data));
      req.on('error', () => done(''));
    });

  /**
   * @param {object|null} fish 指定某条鱼（方案2 ✓）—— 给了就返回**它自己**的记忆 ✓
   *   为什么必须支持：状态胶囊（badge）拉的就是这个 ✓，
   *   而它原来永远返回本地/主鱼那份记忆 ✗ → **两只鱼的胶囊显示同一份记忆** ✓
   *   （主人报"两只鱼的记忆混在一起" ✓ 就是这个 ✓）。
   */
  /**
   * **每条鱼自己的观察状态**（2026-10-18 改：原来所有鱼共用一份 global runtime）。
   *
   * 共用一份的问题：胶囊/面板只能显示"整体观察中"，两条鱼看到的计数、最近一句、
   * 最近错误完全一样；也没法"只暂停某一条鱼"。
   * 现在按鱼存（键 = 鱼表 id），`/state?port=` 返回那条鱼自己的那份。
   */
  const fishRuntime = new Map();
  const fishRuntimeOf = (key) => {
    const k = String(key || '');
    let r = fishRuntime.get(k);
    if (!r) {
      r = {
        paused: false,
        pausedAt: null,
        pauseReason: '',
        captures: 0,
        speaks: 0,
        errors: 0,
        lastAt: 0,
        lastSpeakAt: 0,
        lastPhrase: '',
        lastError: '',
      };
      fishRuntime.set(k, r);
    }
    return r;
  };

  const publicState = (fish = null) => {
    const memForState = fish ? memoryFor(fish.scope || fish.id) : memory;
    const snap = memForState.snapshot();
    return {
      ok: true,
      now: Date.now(),
      config: { ...config, personality: undefined, rules: undefined, compactSystem: undefined },
      prompt: {
        personality: config.personality,
        rules: config.rules,
        compactSystem: config.compactSystem,
        windowTitle: config.windowTitle,
        intervalSec: config.intervalSec,
        cooldownSec: config.cooldownSec,
        maxChars: config.maxChars,
        memoryRecentTurns: config.memoryRecentTurns,
        compactEvery: config.compactEvery,
        provider: config.provider,
        model: config.model,
        pushToPet: config.pushToPet,
        petId: config.petId,
        editableKeys: EDITABLE_KEYS,
      },
      runtime: (() => {
        /**
         * **按鱼覆盖**：带 `fish`（`/state?port=` 或 `?fish=`）时返回**这条鱼自己**的
         * 观察状态（计数/最近一句/最近错误/是否单独暂停）；不带就还是全局那份（兼容旧调用）。
         */
        const rt = fish ? fishRuntimeOf(fishKeyOf(fish)) : null;
        const global = {
          startedAt: state.startedAt,
          running: state.running,
          paused: state.paused,
          pauseReason: state.pauseReason,
          pausedAt: state.pausedAt,
          capturing: state.capturing,
          captures: capture.count,
          speaks: state.speaks,
          compactions: state.compactions,
          /** 最近一次"它自己记长期记忆"（remember 字段）；设置页/排障用 */
          lastSelfNote: state.lastSelfNote ?? null,
          lastCaptureAt: state.lastCaptureAt,
          lastCaptureInfo: state.lastCaptureInfo,
          lastFrameAt: state.lastFrameAt,
          lastSpeakAt: state.lastSpeakAt,
          lastPhrase: state.lastPhrase,
          lastDecision: state.lastDecision,
          lastModelMs: state.lastModelMs,
          lastModelError: state.lastModelError,
          lastPetSyncAt: state.lastPetSyncAt,
          idleMs: state.idleMs,
          backoff: state.backoff,
          effectiveIntervalSec: Math.round(config.intervalSec * Math.max(1, state.backoff || 1)),
          lastFrameBytes: state.lastFrameBytes,
          // 用量：带图那次 / 不带图那次各一条，用来对比两种模式的开销
          usage: { withImage: lastUsage ?? null, textOnly: lastTextUsage ?? null },
          /** 接话：累计请求了几次 / 实际多说了几句（排障"到底有没有接"用） */
          chained: state.chained || 0,
          chainSaid: state.chainSaid || 0,
          /** 当前生效的思考档位（空 = 跟随模型默认）与接话上限 */
          thinking: config.modelThinking || '',
          chainMax: Math.max(0, Math.min(8, Number(config.chainMax ?? 0))),
        };
        if (!rt) return { ...global, perFish: false };
        return {
          ...global,
          perFish: true,
          fishId: fishKeyOf(fish),
          running: state.running && !rt.paused,
          paused: state.paused || rt.paused,
          pauseReason: rt.paused ? rt.pauseReason || '单独暂停' : state.pauseReason,
          pausedAt: rt.paused ? rt.pausedAt : state.pausedAt,
          captures: rt.captures,
          speaks: rt.speaks,
          lastSpeakAt: rt.lastSpeakAt || state.lastSpeakAt,
          lastPhrase: rt.lastPhrase || state.lastPhrase,
          lastModelError: rt.lastError || state.lastModelError,
          lastCaptureAt: rt.lastAt || state.lastCaptureAt,
        };
      })(),
      memory: {
        total: snap.total,
        /** 长期记忆的行数 / 模型自己追加的条数 / 最近压缩时间（"周期情况"一眼可见） */
        longTermLines: String(snap.longTerm?.text ?? '').split('\n').filter(Boolean).length,
        selfAdded: Number(snap.longTerm?.selfAdded) || 0,
        compactedAt: snap.longTerm?.at ?? null,
        longTerm: snap.longTerm,
        notes: snap.notes,
        /**
         * 最近 14 条给面板的「记录」页签 —— **跟着 `historyHideSystem` 一起过滤**。
         * 之前只过滤了 `/history.json`，而面板读的是这份快照，所以"隐藏"在面板里看着没生效。
         */
        last:
          config.historyHideSystem === false
            ? snap.entries.slice(-14)
            : snap.entries.filter((e) => e?.role !== 'system').slice(-14),
      },
      /** 这份状态是**哪条鱼**的 ✓（胶囊/面板据此显示名字 ✓；没指定就是主鱼 ✓） */
      fish: fish ? { id: fish.id, name: fish.name, origin: fish.origin, scope: fish.scope || fish.id } : null,
      /**
       * **全部鱼的观察状态**（每条自己一份：暂停/计数/最近一句）。
       * 面板据此画每一行的灯；胶囊只用自己那份（上面的 `runtime` 已按鱼覆盖）。
       */
      fishes: (Array.isArray(config.pets) ? config.pets : []).map((f) => {
        const rt = fishRuntimeOf(fishKeyOf(f));
        return {
          id: f.id,
          name: f.name || f.id,
          enabled: f.enabled !== false,
          paused: Boolean(rt.paused),
          captures: rt.captures,
          speaks: rt.speaks,
          errors: rt.errors,
          lastAt: rt.lastAt,
          lastSpeakAt: rt.lastSpeakAt,
          lastPhrase: rt.lastPhrase,
          lastError: rt.lastError,
        };
      }),
      catalog: { ...catalog.snapshot(), build: { ...buildState } },
      fork: { ...state.fork },
      game: { ...state.game, source: config.gameSource || '' },
      database: { ...state.database, source: config.databaseSource || '' },
      board: board ? board.status() : null,
      collector: collector ? collector.status() : null,
      /** 每条鱼的连接状态 ✓（面板/排障看这个 ✓）；`onebot` 保留为业务主鱼那条 ✓（旧消费方不受影响 ✓） */
      onebotConnections: (Array.isArray(config.pets) ? config.pets : []).map((f) => {
        const q = qqOf(f, config);
        const c = onebotFor(f);
        return {
          fish: { id: f.id, name: f.name },
          url: q.url,
          account: q.account,
          source: q.source,
          configured: q.usable,
          ...(c ? c.status() : { connected: false }),
        };
      }),
      onebot: onebotNow() ? { configured: true, ...onebotNow().status() } : { configured: false },
      promptGuard: {
        personalityChars: String(config.personality ?? '').length,
        rulesChars: String(config.rules ?? '').length,
        custom:
          String(config.personality ?? '') !== String(DEFAULTS.personality ?? '') ||
          String(config.rules ?? '') !== String(DEFAULTS.rules ?? ''),
        guardHasCustom: Boolean(readPromptGuard()?.personality),
        // 从 log 函数上取（环形缓冲挂在它身上，跨 applyInner 带进来）
        /**
         * 当前加载的是哪个版本 —— 从**入口文件名**取（`index-0.7.15.js`）。
         * 为什么需要：排障时第一件事就是确认"跑的是不是我刚改的那版"，
         * 今天已经因为"以为加载了其实没有"白折腾好几次 ✗。
         */
        version: (() => {
          /**
           * 从仓库里**最高的 `index-x.y.z.js`** 取版本。
           * 不能读 `import.meta.url`（加载器直接 import index.js，文件名永远叫 index.js ✗），
           * 也不能读 package.json（那个 version 停在 0.2.0，bump 脚本不更新它 ✗）。
           */
          try {
            const versions = readdirSync(PACKAGE_DIR)
              .map((f) => f.match(/^index-(\d+)\.(\d+)\.(\d+)\.js$/))
              .filter(Boolean)
              .map((m) => ({ text: `${m[1]}.${m[2]}.${m[3]}`, num: [Number(m[1]), Number(m[2]), Number(m[3])] }))
              .sort((a, b) => (b.num[0] - a.num[0]) || (b.num[1] - a.num[1]) || (b.num[2] - a.num[2]));
            return versions[0]?.text ?? 'index.js';
          } catch {
            return 'index.js';
          }
        })(),
        onebotLastPeer,
        onebotSendSkip,
        onebotLastIncomingAt: onebotLastIncomingAt || null,
        onebotLastSelfPostAt: onebotLastSelfPostAt || null,
        qqKept: state.qqKept || 0,
        onebotThrottled,
        onebotScheduledReads,
        onebotSentIds: onebotSentIds.length,
        ownerQq: config.ownerQq || '',
        lastQqKept: state.lastQqKept || null,
        logRing: (log.ring ?? []).slice(-25),
        healCount: promptHealCount,
        healedAt: promptHealedAt || null,
      },
      /**
       * 顶层诊断块。
       *
       * 教训：这些字段我先前插到了 `promptGuard` 对象**里面** ✗ ——
       * 于是 `/state.version`、`/state.logRing` 读不到（`None` / 空 ✗），
       * 排障时被自己的输出误导了好几次。顶层这份以后只看它。
       */
      diagnostics: {
        version: log.version ?? PLUGIN_VERSION,
        logRing: (log.ring ?? []).slice(-25),
        onebotLastPeer,
        onebotSendSkip,
        onebotLastIncomingAt: onebotLastIncomingAt || null,
        onebotLastSelfPostAt: onebotLastSelfPostAt || null,
        qqKept: state.qqKept || 0,
        lastQqKept: state.lastQqKept || null,
        /**
         * ⚠️ 这三个以前只写进了**嵌套**的那份（promptGuard 里）✗ ——
         * 我加字段时锚点 `onebotThrottled,` 在那两处都存在，命中了错的那份 ✗
         * （和 `maybeCompact(mem)` 塞进 `tick()` 是同一类错误 ✓）。
         * 顶层这份才是排障时要看的 ✓。
         */
        onebotThrottled,
        onebotScheduledReads,
        onebotSentIds: onebotSentIds.length,
        ownerQq: config.ownerQq || '',
        onebotRead: config.onebotRead,
        onebotReply: config.onebotReply,
        onebotImagesSent,
        onebotImagesSkipped,
        pets: (Array.isArray(config.pets) ? config.pets : []).map((f) => ({
          id: f.id, name: f.name, origin: f.origin, enabled: f.enabled, qq: f.qq === true,
          lastSpokeAt: fishSpokeAt.get(f.id) ?? 0,
        })),
        lastRequestFile: config.captureLastRequest ? join(dataDir, 'last-request.json') : '',
        qqImagesCollected: state.qqImagesCollected || 0,
      },
      storage: storageReport(),
      selfName: state.selfName || '',
      images: {
        ...imageState,
        asked: state.imgAsked || 0,
        used: state.imgUsed || 0,
        dropped: state.imgDropped || 0,
        lastDropped: state.lastImgDropped || '',
        memeSearch: config.memeSearch !== false,
        downloads: memeLibrary.downloads,
        library: memeLibrary.entries ? memeLibrary.entries.length : 0,
        lastQuery: memeLibrary.lastQuery,
        lastPick: memeLibrary.lastPick,
        libraryError: memeLibrary.error,
        inPrompt: config.imageInPrompt !== false,
        items: Object.keys(imageCatalog.data.items).length,
        userRoot: imagesUserRoot,
        upstreamRoot: resolveUpstreamRoot(),
      },
      askCalls: state.askCalls || 0,
      askLog: state.askLog || [],
      modelCalls: state.modelCalls || 0,
      modelCallLog: state.modelCallLog || [],
      patch: { file: resolvePatchFile() ?? null },
      errors: (pruneErrors(), state.errors.slice(-8)),
    };
  };

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: async (req, res) => {
          /**
           * **预检请求直接放行**：宠物浮层从 `http://127.0.0.1:7341` 发 POST 到宿主的
           * `/game-pet-watch/ask`（JSON body）→ 浏览器先发 OPTIONS，不处理的话会被当成
           * "方法不允许"，浮层就永远读不到状态（显示"插件离线"）。
           */
          if (req.method === 'OPTIONS') {
            res.writeHead(204, CORS_HEADERS);
            res.end();
            return;
          }
          // 最权威的来源：真正承载这条请求的本地端口（纠正"端口变了但 netstat 没探到"的情况）
          if (!ownOrigin && req?.socket?.localPort) {
            ownOrigin = 'http://127.0.0.1:' + req.socket.localPort;
            publishRegistry(); // 学到地址就立刻公开，别让别处再猜
          }
          try {
            const url = new URL(req.url ?? '/', 'http://127.0.0.1');
            const rest = url.pathname.slice(ROUTE_PREFIX.length).replace(/^\//, '');
            const method = req.method ?? 'GET';
            /**
             * 按 `?port=7342` 或 `?fish=current` 认鱼（记忆/历史这些接口都要用它 ✓）。
             *
             * 为什么必须有：不止状态胶囊 ✓，观察面板与记录页也会同时开两只 ✓ ——
             * 只要某个接口忽略端口参数 ✗，两个面板就会显示同一条鱼的数据 ✗
             * （实测：长期要点两边一模一样 ✓ 都是主鱼 7342 的 ✓）。
             */
            const fishFromQuery = () => {
              const wantRaw = String(url.searchParams.get('fish') ?? '').trim();
              const wantPort = Number(url.searchParams.get('port') ?? 0);
              if (!wantRaw && !wantPort) return null;
              const pets = Array.isArray(config.pets) ? config.pets : [];
              return findFish(pets, { id: wantRaw, port: wantPort });
            };

            /**
             * **`GET /ping`：给前端一次"敲醒"用的**（2026-10-18 修：重启后胶囊离线）。
             *
             * 插件学自己的地址唯一可靠的来源是"**收到了一条请求**"（`req.socket.localPort`）。
             * 而重启后如果没人访问插件接口：登记簿一直是 ''，副本只能退到写死的 19387 →
             * 胶囊/输入框全部指向死端口 → "插件离线"，而且**不会自愈**（因为没人来敲）。
             *
             * 所以 `client.js`（DSH 页面一打开就会加载）在启动时调一次这里：
             * 这条请求本身就教会插件自己的端口 → 立刻发布登记簿 → 副本/胶囊下一轮就接上。
             */
            if (rest === 'ping') {
              publishRegistry();
              return sendJson(res, 200, {
                ok: true,
                origin: pluginOriginOf({ configuredPort: config.pluginPort, learned: ownOrigin }),
                learned: Boolean(ownOrigin),
              });
            }

            if (rest === '' || rest === 'state') {
              if (method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
              /**
               * `?port=7342` 或 `?fish=current` → 返回**那条鱼**的状态（记忆 ✓）。
               * 状态胶囊就这样区分自己 ✓（不然两只鱼显示同一份记忆 ✗）。
               */
              const wantRaw = String(url.searchParams.get('fish') ?? '').trim();
              const wantPort = Number(url.searchParams.get('port') ?? 0);
              const pets = Array.isArray(config.pets) ? config.pets : [];
              const wantFish = findFish(pets, { id: wantRaw, port: wantPort });
              const mem = wantFish ? memoryFor(wantFish.scope || wantFish.id) : memory;
              await mem.load();
              return sendJson(res, 200, publicState(wantFish));
            }

            /**
             * **模型信息**：`GET /model-info`
             *
             * 为什么需要：思考档位（reasoningEffort）的合法值是**每个模型自己声明的**
             * （off / low / high / max 各家不一样），硬编码一个值很可能被 provider 拒。
             * 设置页要按这里返回的 `efforts` 生成下拉，插件发请求时也先比对一遍。
             */
            if (rest === 'model-info') {
              if (method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
              try {
                const route = await resolveModel();
                if (!route) return sendJson(res, 200, { ok: false, error: '没有可用的模型' });
                const info = await ctx.llm.resolveModelInfo(route.provider, route.model);
                return sendJson(res, 200, {
                  ok: true,
                  route,
                  reasoning: info?.reasoning ?? null,
                  imageInput: info?.imageInput ?? null,
                  current: {
                    thinking: config.modelThinking || '',
                    chainMax: config.chainMax,
                  },
                });
              } catch (error) {
                return sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
              }
            }

            /**
             * **每条鱼的观察状态**：`GET /fish` 读全部，`POST /fish {fish, paused}` 单独暂停/恢复。
             *
             * 为什么单独一个路由：胶囊/面板点"暂停"不该把两条鱼一起停掉
             * （以前只有全局 `paused`，一颗胶囊暂停 = 全体停，这就是"观察状态没独立"）。
             */
            if (rest === 'fish') {
              const petsNow = Array.isArray(config.pets) ? config.pets : [];
              if (method === 'GET') {
                return sendJson(res, 200, {
                  ok: true,
                  global: { running: state.running, paused: state.paused },
                  fishes: petsNow.map((f) => {
                    const rt = fishRuntimeOf(fishKeyOf(f));
                    return {
                      id: f.id,
                      name: f.name || f.id,
                      enabled: f.enabled !== false,
                      paused: Boolean(rt.paused),
                      pauseReason: rt.pauseReason,
                      pausedAt: rt.pausedAt,
                      captures: rt.captures,
                      speaks: rt.speaks,
                      errors: rt.errors,
                      lastAt: rt.lastAt,
                      lastSpeakAt: rt.lastSpeakAt,
                      lastPhrase: rt.lastPhrase,
                      lastError: rt.lastError,
                    };
                  }),
                });
              }
              if (method === 'POST') {
                let payload = {};
                try {
                  payload = JSON.parse((await readBody(req)) || '{}');
                } catch {
                  return sendJson(res, 400, { error: 'invalid JSON body' });
                }
                const target = String(payload.fish ?? payload.id ?? '').trim();
                if (!target) return sendJson(res, 400, { error: '需要 fish（鱼表 id）' });
                const fishCfg = petsNow.find((f) => f.id === target || f.scope === target);
                if (!fishCfg) return sendJson(res, 404, { error: '没有这条鱼：' + target });
                const rt = fishRuntimeOf(fishKeyOf(fishCfg));
                const next = payload.paused === true;
                rt.paused = next;
                rt.pausedAt = next ? Date.now() : null;
                rt.pauseReason = next ? '单独暂停' : '';
                if (!next) {
                  // 恢复时把它重新排队（否则要等一个完整间隔才轮到它）
                  fishDueAt.set(fishKeyOf(fishCfg), 0);
                  schedule();
                }
                log(`鱼「${fishCfg.id}」观察状态：${next ? '单独暂停' : '恢复'}`);
                return sendJson(res, 200, { ok: true, fish: fishCfg.id, paused: next, runtime: { ...rt } });
              }
              return sendJson(res, 405, { error: 'method not allowed' });
            }

            if (rest === 'capture') {
              if (method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
              try {
                const frame = await capture.capture(config);
                state.lastCaptureAt = frame.at;
                state.lastCaptureInfo = frame.info;
                return sendJson(res, 200, { ok: true, info: frame.info, at: frame.at, ms: frame.ms });
              } catch (error) {
                pushError('capture', error);
                return sendJson(res, 200, {
                  ok: false,
                  message: error instanceof Error ? error.message : String(error),
                });
              }
            }

            if (rest === 'ask') {
              if (method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
              let payload = {};
              try {
                payload = JSON.parse((await readBody(req)) || '{}');
              } catch {
                return sendJson(res, 400, { error: 'invalid JSON body' });
              }
              /**
               * 入站计数：排障"一次操作打了很多次 API"。
               * 记下每次 /ask 的时间与文本，就能区分"客户端发了很多次"和"服务端一次请求里调了很多次模型"。
               */
              state.askCalls = (state.askCalls || 0) + 1;
              state.askLog = (state.askLog || []);
              /**
               * ⚠️ 记下**是谁问的**（port/fishId）✗→✓。
               * 之前只存文本 ✓ → "7341 问、7342 答"这种问题事后完全查不出来 ✓
               * （两条鱼只能互相甩锅："那是7342应的" ✓）。
               */
              state.askLog.push({
                at: Date.now(),
                text: String(payload.text ?? '').slice(0, 40),
                port: Number(payload.port ?? url.searchParams.get('port') ?? 0) || null,
                fishId: String(payload.fishId ?? payload.fish ?? payload.scope ?? '').trim() || null,
              });
              if (state.askLog.length > 100) state.askLog.shift();
              /**
               * 认鱼（回答要用那条鱼的记忆/人设，**回话也要回到那条鱼的气泡** ✓）：
               *   ① `{"fish":"legacy"}`            —— 老的显式写法 ✓
               *   ② `{"fishId":"legacy"}`          —— 鱼板网络 v2 的身份 ✓
               *   ③ `{"port":7341}`                —— 副本转发时带自己的端口 ✓（7341 问 → 7341 答 ✓）
               *   ④ `?port=7341` / `?fish=legacy`  —— 查询串 ✓
               * 都没给才回落到默认（主鱼）✓。
               */
              const wantFish =
                String(payload.fish ?? '').trim() ||
                String(payload.fishId ?? '').trim() ||
                String(payload.scope ?? '').trim();
              const wantPort = Number(payload.port ?? url.searchParams.get('port') ?? 0);
              const queryFish = fishFromQuery();
              const fishCfg = (() => {
                const pets = Array.isArray(config.pets) ? config.pets : [];
                return findFish(pets, { id: wantFish, port: wantPort }) || queryFish;
              })();
              /**
               * `audience`：'self' = 只对这只鱼说（写它自己的记忆、不进鱼板、不广播）；
               * 其它/缺省 = 老行为（全体广播）。
               */
              const audience = payload.audience === 'self' ? 'self' : 'all';
              return sendJson(res, 200, await reply(payload.text, {
                target: payload.push,
                petId: payload.pet,
                scope: fishCfg ? fishCfg.scope : undefined,
                fish: fishCfg,
                audience,
                /** 回话目标：问哪条就回哪条 ✓（不带 = 落到主鱼 ✗ 就是那个"7341 问、7342 答"的 bug ✓） */
                origin: fishCfg ? String(fishCfg.origin ?? '') : '',
              }));
            }

            /**
             * **通用设置读写**（给 DSH 设置页里那个"桌宠"页面用 ✓）。
             *
             *   GET  /config            → 只返回**允许改**的那些键的当前值 ✓
             *   POST /config {values}   → 只接受白名单里的键 ✓，改内存（立即生效）+ 落盘 ✓
             *
             * 为什么不直接读写 patch：patch 是"覆盖层"且会被 DSH 重写 ✗；
             * 插件自管 config.json 才是真正的生效层 ✓（内存里那份同时更新 ✓）。
             */
            if (rest === 'config') {
              /** 白名单：只允许这些键被设置页改 ✓（避免面板/客户端乱写导致插件起不来 ✗） */
              const CONFIG_KEYS = [
                'enabled', 'pushToPet', 'autoLaunchFork',
                // provider 是"显式路由"的老写法 ✓（resolveModel 第 ② 步用它 ✓）——
                // 之前漏了它 ✗：设置页发 provider 会被白名单过滤掉 ✓（日志里只显示"更新：model" ✓）
                'provider', 'modelSource', 'modelProvider', 'model', 'apiKey',
                'petsEnabled',
                'onebotRead', 'onebotReply', 'qqCollectImages', 'qqKeepInteresting',
                'imageInPrompt', 'imageMaxDim', 'imageQuality', 'memeLibraryMax', 'describePerFishVoice', 'describeBacklogPerSync', 'adoptUnownedFor',
                'collideCallModel', 'collideDetectMs', 'collidePadPx', 'collidePushPx', 'collideLineCooldownSec',
                'intervalSec', 'cooldownSec', 'maxChars', 'gohImmediateCooldownSec', 'gohReactionBudget', 'gohReactionWindowSec',
                'pluginPort',
                /**
                 * **内容路径**（都由用户自己填，插件不预置任何游戏的东西）：
                 * 事件文件可以是任何"一行一条 JSON"的日志；机制库是任意 markdown。
                 * 空 = 不启用对应功能。
                 */
                'gohFile', 'gohCollectorScript', 'mechanicsQuickFile', 'mechanicsFile',
                /**
                 * **记忆**：短期窗口 / 压缩阈值 / 长期上限。
                 * 以前这三项只能改配置文件 —— 设置页没有控件，用户根本看不见它们。
                 */
                'memoryRecentTurns', 'compactEvery', 'memoryLongTermChars', 'historyHideSystem', 'memoryAllowSelfNote',
                /** 思考档位 + 接话上限（2026-10-21） */
                'modelThinking', 'chainMax', 'askCapture',
                /** 路径类（换机器/换安装位置时用；留空 = 自动推） */
                'gpwRoot', 'upstreamPetRoot', 'upstreamRoot',
                'personality', 'rules', 'compactSystem',
              ];
              if (req.method === 'GET') {
                const values = {};
                for (const k of CONFIG_KEYS) values[k] = config[k];
                return sendJson(res, 200, { ok: true, values, keys: CONFIG_KEYS });
              }
              let payload = {};
              try {
                payload = JSON.parse((await readBody(req)) || '{}');
              } catch {
                return sendJson(res, 400, { error: 'invalid JSON body' });
              }
              const wanted = payload.values && typeof payload.values === 'object' ? payload.values : {};
              const patch = {};
              for (const [k, v] of Object.entries(wanted)) {
                if (!CONFIG_KEYS.includes(k)) continue;
                patch[k] = v;
              }
              if (!Object.keys(patch).length) return sendJson(res, 400, { ok: false, error: '没有可写的键' });
              /** 先过一遍规范化 ✓（类型/范围校验都在 normalizeConfig 里 ✓） */
              config = normalizeConfig({ ...config, ...patch });
              writeLocalConfig(patch, 'settings-page');
              /** 人设三类键还要喂给提示词守卫 ✓（否则 60 秒自愈会把它改回去 ✗） */
              const promptTouched = ['personality', 'rules', 'compactSystem'].some((k) => k in patch);
              if (promptTouched) {
                try {
                  await feedPromptGuard('设置页', true);
                } catch {
                  /* 守卫失败不影响保存 ✓ */
                }
              }
              log(`设置页更新：${Object.keys(patch).join('、')}`);
              /**
               * **端口改了：只做"和当前实际端口是否一致"的提示，不发任何网络请求**。
               *
               * 上一版这里会去 GET 一下这个端口做自检 —— 如果主人填错成别的程序的端口
               * （比如 CS2 Hammer 的导入接口），那一下就是把垃圾塞给人家（实测把 Hammer 的
               * 导入打坏了）。所以现在零网络：只比较、只记日志、只回提示。
               * 副本那边也不需要重启：`pluginOriginNow()` 走公共登记簿，读到新地址几秒内就跟上。
               */
              let pluginOriginChecked;
              if ('pluginPort' in patch) {
                const fixedPort = Number(config.pluginPort) || 0;
                const knownPort = Number(/:(\d+)$/.exec(ownOrigin || '')?.[1] || 0);
                if (fixedPort > 0) {
                  pluginOriginChecked = { origin: 'http://127.0.0.1:' + fixedPort, matchesCurrent: fixedPort === knownPort };
                  log(
                    `插件端口已设为 ${fixedPort}` +
                      (knownPort ? `（当前实际端口 ${knownPort}${fixedPort === knownPort ? '，一致' : '，不一致——如果你是为下一次启动预留的，这是对的'}）` : '') +
                      '；登记簿会把它公布出去，副本几秒内跟上',
                  );
                } else {
                  // 改回自动：清掉学到的地址，让下一个请求重新教一次（这里不主动探任何端口）
                  ownOrigin = '';
                  pluginOriginChecked = { origin: ownOriginNow(), matchesCurrent: true };
                  log('插件端口改回自动：等下一个进来的请求确认实际端口');
                }
              }
              return sendJson(res, 200, {
                ok: true,
                changed: Object.keys(patch),
                ...(pluginOriginChecked ? { pluginOrigin: pluginOriginChecked.origin, restartNeeded: true } : {}),
              });
            }

            /**
             * **鱼表管理**（主人要求"插件配置里选择开启或者关闭某条鱼" ✓）。
             *
             * 用接口改 `config.pets` 并落盘 ✓ —— **内存立即生效** ✓（不必重启 ✓，
             * 这很关键：实测"禁用→启用"那种重载**不会**重新读 config.json ✗，
             * 只有真重启才会 ✓，所以开关必须走内存 ✓）。
             */
            if (rest === 'pets') {
              const list = Array.isArray(config.pets) ? config.pets : [];
              if (req.method === 'GET') {
                /**
                 * ⚠️ 记忆探针**必须先 `load()`** ✗→✓：记忆是懒加载的 ✓，
                 * 不 load 直接 `snapshot()` 永远显示 0 条 ✗（实测两只鱼都显示 0 条 = 假象 ✓）。
                 * 而且 `await` **不能写在 `map` 回调里** ✗（那个回调不是 async ✓，会直接语法错误 ✓），
                 * 所以用普通 for 循环拼 ✓。
                 */
                const enriched = [];
                for (const f of list) {
                  let mem = null;
                  try {
                    const store = memoryFor(f.scope || f.id);
                    await store.load();
                    const snap = store.snapshot();
                    mem = {
                      entries: (snap.entries ?? []).length,
                      longTerm: String(snap.longTerm?.text ?? '').length,
                    };
                  } catch {
                    mem = null;
                  }
                  const bind = qqOf(f, config);
                  enriched.push({
                    ...f,
                    // token 绝不回显完整值 ✗（接口/日志/浏览器都只看得到掩码 ✓）
                    onebotToken: undefined,
                    qqBinding: {
                      account: bind.account,
                      url: bind.url,
                      tokenMasked: maskSecret(bind.token),
                      bound: bind.bound,
                      source: bind.source,
                      usable: bind.usable,
                    },
                    lastSpokeAt: fishSpokeAt.get(f.id) ?? 0,
                    memory: mem,
                  });
                }
                return sendJson(res, 200, {
                  ok: true,
                  master: config.petsEnabled !== false,
                  autoLaunch: config.autoLaunchFork !== false,
                  /** 下一个可用端口 ✓（面板"新建桌宠"可以预填它 ✓） */
                  nextPort: freePort(config.pets),
                  pets: enriched,
                });
              }
              let payload = {};
              try {
                payload = JSON.parse((await readBody(req)) || '{}');
              } catch {
                return sendJson(res, 400, { error: 'invalid JSON body' });
              }
              const action = String(payload.action ?? 'list');
              /** 全局鱼开关 ✓（设置页里那个总闸 ✓） */
              if (action === 'master') {
                const on = payload.enabled !== false;
                config.petsEnabled = on;
                writeLocalConfig({ petsEnabled: on }, 'panel');
                log(`多鱼总开关：${on ? '开（按鱼表驱动/保活）' : '关（全停）'}`);
                return sendJson(res, 200, { ok: true, master: on });
              }
              if (action === 'toggle') {
                const id = String(payload.id ?? '').trim();
                const enabled = payload.enabled !== false;
                let hit = false;
                config.pets = list.map((f) => (f.id === id ? ((hit = true), { ...f, enabled }) : f));
                if (!hit) return sendJson(res, 404, { ok: false, error: '没有这条鱼：' + id });
                const target = config.pets.find((f) => f.id === id) ?? {};
                writeLocalConfig({ pets: config.pets }, 'panel');
                /**
                 * **关掉 = 立刻停掉它的副本进程** ✓。
                 *
                 * 光把 enabled 置 false 只做到"不再驱动/不再保活" ✗ —— 窗口还开着 ✓，
                 * 界面上看起来就是"关了没生效" ✗。这里直接把那条鱼的副本停掉 ✓；
                 * 反过来开启时立刻 `ensureFork` 把它拉起来 ✓（不等下一轮巡检 ✓）。
                 */
                let stopped = false;
                if (!enabled) {
                  try {
                    stopped = stopFork((m) => log('（关鱼）' + m), target.profile ?? '');
                  } catch (error) {
                    log('停副本失败：' + (error?.message ?? error));
                  }
                } else {
                  void ensureFork('开关').catch(() => {});
                }
                log(`鱼「${id}」已${enabled ? '开启（并拉起副本）' : `关闭${stopped ? '（已停副本）' : '（没找到副本进程）'}`}`);
                return sendJson(res, 200, { ok: true, id, enabled, stopped });
              }
              /**
               * **创建一只新桌宠**：`POST /pets {"action":"create","name":"小蓝","port":0,"qq":false}`
               *
               * 端口不填就自动挑一个没被占的（7341–7399 ✓），id/scope/profile 自动起名 ✓
               * —— 数据层全部走 `src/fish.js` 的 `makeFish()` ✓（有单测 ✓）。
               * 造完立刻 `ensureFork` 把它拉起来 ✓（不用重启 ✓）。
               *
               * 注意 ✓：新鱼**自带独立用户目录**（profile = 它的 id ✓）→ 记忆/图片/描述
               * 都与老鱼隔离 ✓；图库文件仍然共享那份（按你的设计 ✓）。
               */
              /**
               * **绑定 QQ 号**：`POST /pets {"action":"bind-qq","id":"current","qqAccount":"168369554","onebotUrl":"ws://127.0.0.1:3001","onebotToken":"…"}`
               *
               * 为什么按鱼绑 ✓：NapCat 是**一个号一个 OneBot 端点** ✓，
               * 以后多只桌宠各用各的号 ✓ → 连接、收消息、回话都要按鱼分开 ✓（见 README「多鱼与端口」✓）。
               * 留空 = 回落到全局 onebotUrl/Token ✓（单号用法不受影响 ✓）。
               */
              if (action === 'bind-qq') {
                const id = String(payload.id ?? '').trim();
                const hit = (Array.isArray(config.pets) ? config.pets : []).some((f) => f.id === id);
                if (!hit) return sendJson(res, 404, { ok: false, error: '没有这条鱼：' + id });
                const next = (config.pets || []).map((f) =>
                  f.id !== id
                    ? f
                    : {
                        ...f,
                        qqAccount: String(payload.qqAccount ?? f.qqAccount ?? '').trim(),
                        onebotUrl: String(payload.onebotUrl ?? f.onebotUrl ?? '').trim(),
                        onebotToken:
                          payload.onebotToken === undefined
                            ? f.onebotToken
                            : String(payload.onebotToken ?? '').trim(),
                      },
                );
                config.pets = normalizeConfig({ ...config, pets: next }).pets;
                writeLocalConfig({ pets: config.pets }, 'panel');
                const f2 = config.pets.find((f) => f.id === id) || {};
                log(
                  `QQ 绑定：${f2.name || id} → 号=${f2.qqAccount || '(全局)'} 端点=${f2.onebotUrl || '(全局)'}` +
                    '（连接按鱼独立在下一步生效）',
                );
                return sendJson(res, 200, { ok: true, id, qqAccount: f2.qqAccount || '', onebotUrl: f2.onebotUrl || '' });
              }

              /**
               * **单条鱼的随机时间波动**：`{"action":"set-jitter","id":"current","jitterSec":5}`
               *
               * 0 = 固定节奏；上限 300 秒（由 normalizeConfig 夹）。改完**立即生效**：
               * 下一次排队就用新的波动（不用重启，也不用等旧的定时器）。
               */
              if (action === 'set-jitter') {
                const id = String(payload.id ?? '').trim();
                let hit = false;
                config.pets = list.map((f) => (f.id === id ? ((hit = true), { ...f, jitterSec: payload.jitterSec }) : f));
                if (!hit) return sendJson(res, 404, { ok: false, error: '没有这条鱼：' + id });
                config.pets = normalizeConfig({ ...config, pets: config.pets }).pets;
                writeLocalConfig({ pets: config.pets }, 'panel');
                // 立刻重排：把这条鱼的到期时刻按新波动往前/往后挪一点，避免等到旧周期
                const key = id;
                if (fishDueAt.has(key)) {
                  fishDueAt.set(
                    key,
                    Date.now() + computeFishDelayMs({ baseMs: config.intervalSec * Math.max(1, state.backoff || 1) * 1000, jitterSec: config.pets.find((f) => f.id === id)?.jitterSec }),
                  );
                  schedule();
                }
                const jitterSec = config.pets.find((f) => f.id === id)?.jitterSec ?? 0;
                log(`鱼「${id}」时间波动改为 ±${jitterSec}s`);
                return sendJson(res, 200, { ok: true, id, jitterSec });
              }

              /**
               * **单条鱼自己的长期记忆压缩说明**：`{"action":"set-compact","id":"current","text":"…"}`
               *
               * 传空串 = 清掉这条鱼的覆盖，回落到全局 `compactSystem`。
               */
              if (action === 'set-compact') {
                const id = String(payload.id ?? '').trim();
                const text = String(payload.text ?? '');
                let hit = false;
                config.pets = list.map((f) => (f.id === id ? ((hit = true), { ...f, compactSystem: text.trim() ? text : undefined }) : f));
                if (!hit) return sendJson(res, 404, { ok: false, error: '没有这条鱼：' + id });
                config.pets = normalizeConfig({ ...config, pets: config.pets }).pets;
                writeLocalConfig({ pets: config.pets }, 'panel');
                const fish = config.pets.find((f) => f.id === id);
                log(`鱼「${id}」压缩说明：${fish?.compactSystem ? `自定义（${fish.compactSystem.length} 字）` : '改用全局'}`);
                return sendJson(res, 200, { ok: true, id, compactSystem: fish?.compactSystem ?? '' });
              }

              if (action === 'create') {
                let fish;
                try {
                  fish = makeFish({
                    pets: config.pets,
                    name: payload.name,
                    port: Number(payload.port ?? 0),
                    qq: payload.qq === true,
                    qqAccount: payload.qqAccount,
                  });
                } catch (error) {
                  return sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
                }
                config.pets = [...(Array.isArray(config.pets) ? config.pets : []), fish];
                writeLocalConfig({ pets: config.pets }, 'panel');
                log(`新桌宠已创建：${summarize(fish)} → ${fish.origin}（scope=${scopeOf(fish)} profile=${profileOf(fish) || '(默认)'}）`);
                void ensureFork('新建').catch(() => {});
                return sendJson(res, 200, { ok: true, fish, port: portOf(fish.origin) });
              }

              if (action === 'set') {
                /** 整表替换（面板加鱼用 ✓）：`{"action":"set","pets":[...]}` */
                config.pets = normalizeConfig({ ...config, pets: payload.pets }).pets;
                writeLocalConfig({ pets: config.pets }, 'panel');
                log(`鱼表已更新：${config.pets.length} 条`);
                return sendJson(res, 200, { ok: true, pets: config.pets });
              }
              return sendJson(res, 400, { ok: false, error: '未知动作：' + action });
            }

            if (rest === 'shot') {
              const bytes = await capture.readLatest();
              if (!bytes) return sendJson(res, 404, { error: 'no frame yet' });
              res.writeHead(200, {
                'content-type': 'image/png',
                'content-length': String(bytes.length),
                'cache-control': 'no-store',
              });
              res.end(bytes);
              return undefined;
            }

            if (rest === 'memory') {
              /** 按鱼取记忆：`?port=7342` / `?fish=current` ✓（两个面板同开时各显示自己的 ✓） */
              const memFish = fishFromQuery();
              const memStore = memFish ? memoryFor(memFish.scope || memFish.id) : memory;
              await memStore.load();
              if (method === 'GET') {
                const limit = clampInt(url.searchParams.get('limit'), 40, 1, 400);
                const snap = memStore.snapshot();
                /**
                 * **面板的「记录」页签读的就是这里**（`/memory?limit=80`）——
                 * 之前只过滤了 `/history.json` 和 `/state.memory.last`，漏了这条，
                 * 于是面板里照样能看到 `· 短时间内连续 3 次击杀…` 这类系统行（主人截图报的就是这个）。
                 */
                const rows =
                  config.historyHideSystem === false
                    ? memStore.recent(limit)
                    : memStore.recent(limit).filter((e) => e?.role !== 'system');
                return sendJson(res, 200, {
                  ok: true,
                  fish: memFish ? { id: memFish.id, name: memFish.name, scope: memFish.scope || memFish.id } : null,
                  longTerm: snap.longTerm,
                  notes: snap.notes,
                  entries: rows,
                  /** 隐藏时这个数也跟着列表走，免得"标题 800 / 列表 14"对不上 */
                  total: config.historyHideSystem === false ? snap.total : snap.entries.filter((e) => e?.role !== 'system').length,
                });
              }
              if (method === 'POST') {
                let payload = {};
                try {
                  payload = JSON.parse((await readBody(req)) || '{}');
                } catch {
                  return sendJson(res, 400, { error: 'invalid JSON body' });
                }
                const action = String(payload.action ?? '');
                /**
                 * ⚠️ 这几个动作改的是**哪条鱼的记忆**：面板一左一右开两只时 ✓，
                 * 在 7341 那边点"清短期"绝不能清到 7342 的 ✗
                 * → 一律用 `memStore`（= 按 `?port=`/`?fish=` 认出来的那条鱼 ✓）。
                 */
                if (action === 'note') {
                  const note = await memStore.addNote(payload.text);
                  return sendJson(res, 200, note ? { ok: true, note } : { ok: false, message: '备注为空' });
                }
                if (action === 'remove-note') return sendJson(res, 200, { ok: await memStore.removeNote(String(payload.id ?? '')) });
                if (action === 'clear') {
                  await memStore.clear(String(payload.kind ?? 'short'));
                  return sendJson(res, 200, { ok: true, fish: memFish ? memFish.id : null });
                }
                /**
                 * **记忆清洗**（主人要求："A+清除7341B记忆" ✓）。
                 *
                 * 为什么必须做成路由而不是改文件 ✗→✓：插件把记忆**整个**放在内存里 ✓，
                 * 落盘是覆盖式的 ✓ → 从外面改文件，下一次持久化就被内存那份盖回去 ✓
                 * （今天已经踩过一次 ✓）。所以清洗必须在**插件内部**做 ✓。
                 *
                 * 用法：POST /memory {"action":"scrub","drop":["7341B","那个B"],"strip":"喵"}
                 *   drop  → 命中就**整条删掉**（比如那个外号 ✓）
                 *   strip → 对**它自己说的**句子去掉这个字（口癖 ✓），顺手修标点 ✓
                 */
                if (action === 'scrub') {
                  const drop = Array.isArray(payload.drop) ? payload.drop.map(String).filter(Boolean) : [];
                  const strip = String(payload.strip ?? '');
                  const selfRoles = new Set(['pet', 'self', 'assistant', 'bot']);
                  let removed = 0;
                  let stripped = 0;
                  const scopes = [];
                  for (const [key, store] of memoryScopes.entries()) {
                    const entries = store?.data?.entries;
                    if (!Array.isArray(entries)) continue;
                    try {
                      const file = store.file ?? store.path ?? '';
                      if (file && existsSync(file)) copyFileSync(file, `${file}.bak-scrub-${Date.now()}`);
                    } catch {
                      /* 备份失败不阻断清洗 */
                    }
                    const before = entries.length;
                    let touched = 0;
                    const kept = [];
                    for (const entry of entries) {
                      const text = String(entry?.text ?? '');
                      if (drop.length && drop.some((d) => text.includes(d))) {
                        removed += 1;
                        continue;
                      }
                      if (strip && selfRoles.has(String(entry?.role ?? '')) && text.includes(strip)) {
                        entry.text = text
                          .split(strip)
                          .join('')
                          .replace(/([，。！？、；：])\1+/g, '$1')
                          .replace(/\s{2,}/g, ' ')
                          .replace(/^[，。！？、；：\s]+/, '')
                          .trim();
                        stripped += 1;
                        touched += 1;
                      }
                      kept.push(entry);
                    }
                    if (kept.length !== before || touched) {
                      store.data.entries = kept;
                      await store.persist();
                    }
                    scopes.push({ key, before, after: kept.length, touched });
                  }
                  log(`记忆清洗：删除 ${removed} 条（含 ${drop.join('/') || '—'}）、改写 ${stripped} 条（去掉「${strip}」）`);
                  return sendJson(res, 200, { ok: true, removed, stripped, scopes });
                }
                if (action === 'compact') {
                  /** 可指定鱼：`{"action":"compact","fish":"legacy"}` ✓（不指定就是当前这条 ✓） */
                  const want = String(payload.fish ?? payload.scope ?? '').trim();
                  const fish = want
                    ? (Array.isArray(config.pets) ? config.pets.find((f) => f.id === want) : null) ?? { id: want, scope: want }
                    : null;
                  const store = want ? memoryFor(want) : memory;
                  return sendJson(res, 200, await compactMemory(true, store, fish));
                }
                if (action === 'set-long') {
                  await memory.setLongTerm(String(payload.text ?? ''), Date.now());
                  return sendJson(res, 200, { ok: true });
                }
                return sendJson(res, 200, { ok: false, message: '未知动作：' + action });
              }
              return sendJson(res, 405, { error: 'method not allowed' });
            }

            /**
             * 动画目录：
             *   GET  /catalog              读目录（含统计）
             *   POST /catalog/build {...}  离线建库（分批可续）；body: {limit?, force?, cols?, rows?}
             *   POST /catalog/edit         人工改写某条（标 edited，批量不再覆盖）
             *   POST /catalog/remove       删一条
             */
            if (rest === 'catalog') {
              await catalog.load();
              if (method === 'GET') return sendJson(res, 200, { ok: true, ...catalog.snapshot() });

              if (method === 'POST') {
                let payload = {};
                try {
                  payload = JSON.parse((await readBody(req)) || '{}');
                } catch {
                  return sendJson(res, 400, { error: 'invalid JSON body' });
                }
                const action = String(payload.action ?? 'build');

                if (action === 'edit') {
                  const name = String(payload.name ?? '').trim();
                  if (!name) return sendJson(res, 200, { ok: false, message: 'name 为空' });
                  const patch = {};
                  if (typeof payload.action2 === 'string') patch.action = payload.action2.trim();
                  if (typeof payload.text === 'string') patch.text = payload.text.trim();
                  if (Array.isArray(payload.mood)) patch.mood = payload.mood.map((m) => String(m).trim()).filter(Boolean).slice(0, 3);
                  if (Array.isArray(payload.scene)) patch.scene = payload.scene.map((m) => String(m).trim()).filter(Boolean).slice(0, 3);
                  const item = await catalog.edit(name, patch);
                  return sendJson(res, 200, { ok: true, item });
                }
                if (action === 'remove') {
                  return sendJson(res, 200, { ok: await catalog.remove(String(payload.name ?? '')) });
                }

                // 建库：先问副本要素材清单（含 mtime，用来判缓存），再逐条抽帧 + 描述
                if (action === 'build') {
                  if (buildState.running) return sendJson(res, 200, { ok: false, message: '已经在建了', build: buildState });
                  const limit = clampInt(payload.limit, 0, 0, 500);
                  const force = payload.force === true;
                  const origin = await resolveGpwOrigin();
                  if (!origin) return sendJson(res, 200, { ok: false, message: '找不到副本（dsh-pet-gpw 没在跑？）' });
                  const route = await resolveModel();
                  if (!route) return sendJson(res, 200, { ok: false, message: '没有可用模型（先在配置里写 provider/model）' });

                  let assets;
                  try {
                    const res2 = await fetch(origin + '/gpw/assets', { signal: AbortSignal.timeout(6000) });
                    assets = await res2.json();
                  } catch (error) {
                    return sendJson(res, 200, { ok: false, message: '拿素材清单失败：' + (error instanceof Error ? error.message : String(error)) });
                  }
                  if (!assets?.ok) return sendJson(res, 200, { ok: false, message: '副本没有抽帧台：' + JSON.stringify(assets).slice(0, 200) });

                  const all = assets.files ?? [];
                  buildState.running = true;
                  buildState.startedAt = Date.now();
                  buildState.done = 0;
                  buildState.failed = 0;
                  buildState.errors = [];
                  buildState.current = '';
                  // 已完成（未过期）的先跳过，避免重复花钱
                  const pending = [];
                  for (const file of all) {
                    const item = catalog.item(file.file);
                    if (!force && item && item.mtime === file.mtime && item.action) continue;
                    pending.push(file);
                  }
                  buildState.total = pending.length;
                  const todo = limit > 0 ? pending.slice(0, limit) : pending;

                  void (async () => {
                    for (const file of todo) {
                      buildState.current = file.file;
                      try {
                        const sheetRes = await fetch(
                          origin +
                            '/gpw/sheet?file=' +
                            encodeURIComponent(file.file) +
                            '&cols=' +
                            (payload.cols ?? 4) +
                            '&rows=' +
                            (payload.rows ?? 3),
                          { signal: AbortSignal.timeout(120000) },
                        );
                        const sheetBody = await sheetRes.json();
                        if (!sheetBody?.ok) throw new Error(sheetBody?.error ?? '抽帧失败');
                        const result = await catalog.describeOne(
                          { name: file.file, mtime: file.mtime, sheet: sheetBody.sheet },
                          {
                            system:
                              DEFAULT_DESCRIBE_SYSTEM +
                              (config.describePerFishVoice ? fishVoice(fishOfScope(catalog.scope || 'current')) : ''),
                            model: route.provider + '/' + route.model,
                            force,
                          },
                        );
                        buildState.done += 1;
                        log('目录：' + file.file + ' → ' + (result.item?.action ?? result.skipped ?? '?'));
                      } catch (error) {
                        buildState.failed += 1;
                        const message = error instanceof Error ? error.message : String(error);
                        buildState.errors.push({ file: file.file, message });
                        if (buildState.errors.length > 20) buildState.errors.shift();
                        log('目录失败：' + file.file + ' → ' + message);
                      }
                    }
                    buildState.running = false;
                    buildState.current = '';
                    log(`目录建库结束：成功 ${buildState.done}，失败 ${buildState.failed}`);
                  })();

                  return sendJson(res, 200, { ok: true, build: buildState, pending: pending.length, todo: todo.length });
                }

                return sendJson(res, 200, { ok: false, message: '未知动作：' + action });
              }
              return sendJson(res, 405, { error: 'method not allowed' });
            }

            if (rest === 'prompt') {
              /**
               * POST { action: 'backup' } → 立刻存一份提示词快照（面板上的"备份提示词"按钮）。
               * POST { values: {...} }     → 写回配置并同步内存。
               */
              if (method === 'POST') {
                let peek = {};
                try {
                  peek = JSON.parse((await readBody(req)) || '{}');
                } catch {
                  return sendJson(res, 400, { error: 'invalid JSON body' });
                }
                if (peek?.action === 'backup') {
                  const file = await snapshotPrompt('manual');
                  return sendJson(res, 200, { ok: Boolean(file), file: file ?? null });
                }
                const values = peek?.values && typeof peek.values === 'object' ? peek.values : {};
                const result = await writeConfigToProfile(values, dshHome);
                if (result.ok) {
                  // 关键：也写进**真正会生效的**自管配置（profile patch 实测不生效 ✗）
                  writeLocalConfig(values, 'prompt');
                  log(`提示词已保存（自管配置 + profile）：${(result.changed ?? []).join(',')}`);
                  // 保存成功就把这份自定义提示词记进守卫（下次被 DSH 整份保存洗掉时能自愈）
                  feedPromptGuard('面板保存', true); // 明确保存 → 强制记住这份人设 ✓
                  // 同步内存：否则这个进程在重启前仍用旧值回答 /prompt，用户会以为"保存没作用"
                  Object.assign(config, values);
                  void snapshotPrompt('after-save');
                }
                return sendJson(res, 200, result);
              }
              if (method === 'GET') {
                return sendJson(res, 200, {
                  ok: true,
                  prompt: {
                    personality: config.personality,
                    rules: config.rules,
                    compactSystem: config.compactSystem,
                    windowTitle: config.windowTitle,
                    intervalSec: config.intervalSec,
                    cooldownSec: config.cooldownSec,
                    maxChars: config.maxChars,
                    memoryRecentTurns: config.memoryRecentTurns,
                    compactEvery: config.compactEvery,
                    provider: config.provider,
                    model: config.model,
                    pushToPet: config.pushToPet,
                    petId: config.petId,
                  },
                  patch: resolvePatchFile() ?? null,
                  route: await resolveModel().then((route) =>
                    route ? { ...route, fromConfig: Boolean(config.provider && config.model) } : null,
                  ),
                });
              }
              return sendJson(res, 405, { error: 'method not allowed' });
            }

            /**
             * 游戏事件源：GET 读状态与可选项；POST { source } 切换（'':空 / 'goh'）。
             *
             * 切换要**写回 profile 配置**：不然重启 DSH 又回到默认的空源，
             * 用户会以为"选了没用"。和提示词保存同一条写入路径（自动备份、只改本行）。
             */
            if (rest === 'game') {
              if (method === 'GET') {
                return sendJson(res, 200, {
                  ok: true,
                  source: config.gameSource || '',
                  options: GAME_SOURCE_OPTIONS,
                  important: config.gohImportant,
                  cooldownSec: config.gohImmediateCooldownSec,
                  runtime: { ...state.game },
                  status: goh ? goh.status() : null,
                  collector: collector ? collector.status() : null,
                });
              }
              if (method === 'POST') {
                let payload = {};
                try {
                  payload = JSON.parse((await readBody(req)) || '{}');
                } catch {
                  return sendJson(res, 400, { error: 'invalid JSON body' });
                }
                const next = String(payload.source ?? '');
                /**
                 * 只接受「关」或「开」：读哪个文件由设置里的路径决定。
                 * 'goh' 是历史别名（老配置/老前端会送它），等价于 'file'。
                 */
                if (next && next !== 'file' && next !== 'goh') {
                  return sendJson(res, 400, { error: '不支持的来源：' + next });
                }
                const result = await writeConfigToProfile({ gameSource: next }, dshHome);
                config = normalizeConfig({ ...config, gameSource: next });
                // **立即重建读取器**：不必重开 DSH，切换当场生效（写回配置只是为了重启后仍记得）
                buildGoh();
                writeLocalConfig({ gameSource: next }, 'game');
                log(`游戏事件源切换为「${next || '空'}」（已写进自管配置并立即生效）`);
                // 采集器跟着「游戏情况」走：选 goh 立刻起（不用等 15 秒巡检），选空立刻停
                let collectorAction = 'off';
                if (collector) {
                  const r = collector.sync(wantCollector());
                  collectorAction = r.action;
                  if (r.action === 'start') log('采集器已随「游戏情况」启动');
                  else if (r.action === 'off') log('采集器已随「游戏情况」停止');
                  else if (r.action === 'wait') log('采集器正在退避中（可能已有别的实例在跑），稍后自动重试');
                }
                return sendJson(res, 200, {
                  ok: true,
                  source: next,
                  written: result,
                  needRestart: false,
                  collector: collectorAction,
                  runtime: { ...state.game },
                });
              }
              return sendJson(res, 405, { error: 'method not allowed' });
            }

            /**
             * 机制数据库来源：GET 读状态与可选项；POST { source } 切换（'':空 / 'goh'）。
             * 与游戏事件源同一套做法：切换**当场重建**，并写回 profile 配置以便重启后仍记得。
             */
            if (rest === 'database') {
              if (method === 'GET') {
                return sendJson(res, 200, {
                  ok: true,
                  source: config.databaseSource || '',
                  options: DATABASE_SOURCE_OPTIONS,
                  lookupRounds: config.mechanicsLookupRounds,
                  maxChars: config.mechanicsMaxChars,
                  runtime: { ...state.database },
                  status: db ? db.status() : null,
                });
              }
              if (method === 'POST') {
                let payload = {};
                try {
                  payload = JSON.parse((await readBody(req)) || '{}');
                } catch {
                  return sendJson(res, 400, { error: 'invalid JSON body' });
                }
                const next = String(payload.source ?? '');
                if (next && next !== 'file' && next !== 'goh') {
                  return sendJson(res, 400, { error: '不支持的来源：' + next });
                }
                const result = await writeConfigToProfile({ databaseSource: next }, dshHome);
                config = normalizeConfig({ ...config, databaseSource: next });
                buildDb();
                writeLocalConfig({ databaseSource: next }, 'database');
                log(`机制数据库切换为「${next || '空'}」（已写进自管配置并立即生效）`);
                return sendJson(res, 200, {
                  ok: true,
                  source: next,
                  written: result,
                  runtime: { ...state.database },
                  status: db ? db.status() : null,
                });
              }
              return sendJson(res, 405, { error: 'method not allowed' });
            }

            /**
             * 历史记录数据（只读）：GET /history.json?limit=N
             *
             * 合并三处来源并**按时间降序**返回（网页只负责画）：
             *   memory = 插件记忆（最完整：主人 + 宠物的话）
             *   board  = 鱼板（唯一能看到**别的宠物**说过什么的来源）
             *   fork   = 副本的说话记录（带配图名）
             * limit 默认 0 = 全量；跨源拉副本在这里做（浏览器跨源会被拦）。
             */
            if (rest === 'history.json') {
              if (method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
              const limit = clampInt(url.searchParams.get('limit'), 0, 0, 5000);
              /** 按鱼收历史 ✓（`?port=7342` / `?fish=current`）—— 不然两个面板显示同一份 ✗ */
              const hisFish = fishFromQuery();
              const rawEntries = await collectHistory({ limit, fish: hisFish });
              /**
               * **记录页默认不显示系统条目**（`historyHideSystem`，默认 true）。
               *
               * 这是主人明确要的语义：记忆/上下文/压缩都要保留游戏事件原文（"不带记忆不太对"），
               * 只是**记录页**看着乱。所以只在这里过滤，不动记忆。
               */
              const entries =
                config.historyHideSystem === false
                  ? rawEntries
                  : rawEntries.filter((e) => e?.kind !== 'sys');
              return sendJson(res, 200, {
                ok: true,
                now: Date.now(),
                fish: hisFish ? { id: hisFish.id, name: hisFish.name, scope: hisFish.scope || hisFish.id } : null,
                selfName: hisFish ? hisFish.name : state.selfName || '',
                self: hisFish ? String(hisFish.origin ?? '') || defaultGpwOrigin() : defaultGpwOrigin(), // 配图源：网页据此拼 /dsh-pet-7340/pic/memes/
                count: entries.length,
                sources: sourceCounts(entries),
                journal: journal.stats(),
                entries,
              });
            }

            /**
             * 群记录数据：GET /qq.json —— **只含 QQ 来源**，并**按会话分组**。
             *
             * 为什么要单独一份（主人要求"群里的单独做一个页面"）：
             * 桌宠历史是"我 + 主人 + 别的宠物"的混合流水 ✗，群聊是按会话分开的另一套上下文 ✓；
             * 混在一起既看不清谁在哪个群说话，也容易被冒充者搅混（昵称随便改 ✗）。
             * 这里每条都带 **QQ 号**，并把 ownerQq 那位单独标出来 ✓。
             */
            if (rest === 'qq.json') {
              if (method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
              const all = await collectHistory({});
              /** QQ 来源的判定：会话坐标（group:/private:）或带群标签/号码的署名 */
              const isQq = (e) => /^(group|private):/.test(String(e?.to ?? ''))
                || /群「|^群友:|^QQ:/.test(String(e?.who ?? ''));
              const qqEntries = all.filter(isQq);
              await refreshGroupNames();
              const byKey = new Map();
              for (const e of qqEntries) {
                const key = String(e.to || 'unknown');
                if (!byKey.has(key)) byKey.set(key, []);
                byKey.get(key).push(e);
              }
              const conversations = [...byKey.entries()].map(([key, list]) => {
                const id = key.split(':')[1] ?? '';
                const isGroup = key.startsWith('group:');
                const label = isGroup
                  ? `群「${onebotGroupNames.get(id) ?? id}」`
                  : `私聊 ${id}`;
                const speakerCount = new Map();
                for (const e of list) {
                  const who = String(e.who ?? '?');
                  speakerCount.set(who, (speakerCount.get(who) ?? 0) + 1);
                }
                return {
                  key,
                  label,
                  isGroup,
                  groupId: id,
                  count: list.length,
                  last: list[0]?.at ? new Date(list[0].at).toLocaleTimeString() : '',
                  speakers: [...speakerCount.entries()]
                    .map(([who, count]) => ({ who, count }))
                    .sort((a, b) => b.count - a.count),
                  entries: list.slice(0, 800).map((e) => ({
                    at: e.at, who: e.who, text: e.text, kind: e.kind, source: e.source, image: e.image ?? null,
                  })),
                };
              }).sort((a, b) => (b.entries[0]?.at ?? 0) - (a.entries[0]?.at ?? 0));
              return sendJson(res, 200, {
                ok: true,
                now: Date.now(),
                owner: config.ownerQq || '',
                total: qqEntries.length,
                conversations,
              });
            }

            /**
             * 群记录页：GET /qq → 浏览器页面（按会话分开看群聊，署名带 QQ 号）。
             * 与 /history 一样，每次请求重读文件，改样式不用重启。
             */
            if (rest === 'qq') {
              if (method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
              try {
                const html = await readFile(join(PACKAGE_DIR, 'web', 'qq.html'), 'utf8');
                res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
                return res.end(html);
              } catch (error) {
                return sendJson(res, 500, { error: '读不到群记录页文件：' + (error?.message ?? error) });
              }
            }

            /**
             * 保存网页：GET /history.export.html → **自包含**的历史快照（给朋友看用）。
             *
             * 数据（含配图）都嵌进 HTML，打开即看、不依赖插件与网络。
             * 配图转 data URI 内联，但有上限：单张 > 900KB 或总量 > 14MB 就不再内联，
             * 退回普通链接（文件太大反而发不出去）。
             */
            if (rest === 'history.export.html') {
              if (method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
              const entries = await collectHistory({});
              // 收集需要内联的配图名
              const names = [...new Set(entries.map((e) => e.image).filter(Boolean))];
              const images = {};
              let inlinedBytes = 0;
              let skipped = 0;
              const dirs = memesDirs(imagesUserRoot, resolveUpstreamRoot() || '');
              for (const name of names) {
                if (inlinedBytes > 14 * 1024 * 1024) {
                  skipped += 1;
                  continue;
                }
                for (const dir of dirs) {
                  let picked = null;
                  // 导出网页时内联配图：也认 gif / jpg（2026-10-20），MIME 按扩展名给
                  for (const ext of ['.png', '.webp', '.gif', '.jpg', '.jpeg']) {
                    const file = join(dir, name + ext);
                    try {
                      const size = statSync(file).size;
                      if (size > 900 * 1024) break;
                      const mime =
                        ext === '.webp'
                          ? 'image/webp'
                          : ext === '.gif'
                            ? 'image/gif'
                            : ext === '.jpg' || ext === '.jpeg'
                              ? 'image/jpeg'
                              : 'image/png';
                      picked = { bytes: readFileSync(file), mime };
                      break;
                    } catch {
                      /* 试下一个扩展名/目录 */
                    }
                  }
                  if (picked) {
                    images[name] = toDataUri(picked.bytes, picked.mime);
                    inlinedBytes += picked.bytes.length;
                    break;
                  }
                }
              }
              let template;
              try {
                template = await readFile(join(PACKAGE_DIR, 'web', 'history.html'), 'utf8');
              } catch (error) {
                return sendJson(res, 500, { error: '读不到页面文件：' + (error?.message ?? error) });
              }
              const html = buildSnapshotHtml(template, {
                exportedAt: Date.now(),
                selfName: state.selfName || '',
                self: defaultGpwOrigin(),
                count: entries.length,
                sources: sourceCounts(entries),
                images,
                entries,
              });
              log(
                `导出历史快照：${entries.length} 条、内联配图 ${Object.keys(images).length} 张` +
                  (skipped ? `（${skipped} 张过大已跳过）` : '') +
                  `、${Math.round(html.length / 1024)}KB`,
              );
              const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '');
              res.writeHead(200, {
                'content-type': 'text/html; charset=utf-8',
                'content-disposition': `attachment; filename="pet-history-${stamp}.html"`,
                'cache-control': 'no-store',
              });
              return res.end(html);
            }

            /**
             * OneBot（QQ）状态与手动发送。
             *   GET  /onebot                        → 连接状态（排障：连上没有、自己的号、事件数）
             *   POST /onebot {text, groupId?}       → 手动发一条（验收用：先确认"能发"）
             * 注意：发送照样走限速，不会因为手动就绕过风控保护。
             */
            if (rest === 'onebot') {
              /**
               * **按鱼的连接状态** ✓（多号之后一条"全局连没连"说明不了问题 ✗）。
               * `status` 仍保留 = 业务主鱼那条 ✓（旧消费方不受影响 ✓）。
               */
              const conns = (Array.isArray(config.pets) ? config.pets : []).map((f) => {
                const q = qqOf(f, config);
                const c = onebotFor(f);
                return {
                  fish: { id: f.id, name: f.name },
                  url: q.url,
                  account: q.account,
                  source: q.source,
                  configured: q.usable,
                  ...(c ? c.status() : { connected: false }),
                };
              });
              const primaryConn = onebotFor(primaryFish(config.pets));
              if (!primaryConn && !conns.some((c) => c.configured)) {
                return sendJson(res, 200, {
                  ok: true,
                  configured: false,
                  connections: conns,
                  hint: '给某条鱼绑定 onebotUrl（或全局填 onebotUrl，如 ws://127.0.0.1:3001）与 onebotToken',
                });
              }
              if (method === 'GET') {
                return sendJson(res, 200, {
                  ok: true,
                  configured: true,
                  read: config.onebotRead,
                  reply: config.onebotReply,
                  status: primaryConn ? primaryConn.status() : { connected: false },
                  connections: conns,
                });
              }
              if (method === 'POST') {
                let payload = {};
                try {
                  payload = JSON.parse((await readBody(req)) || '{}');
                } catch {
                  return sendJson(res, 400, { error: 'invalid JSON body' });
                }
                /**
                 * 硬开关：`POST /onebot {"action":"switch","read":false,"reply":false}`
                 *   - `read`  = 允许"读"（图片识别 / 拉群上下文 / 定时群读）—— 这是花钱的那一半 ✓
                 *   - `reply` = 允许往 QQ 发（关掉之后它只在自己气泡里说话 ✓）
                 * 切换会**立即生效并写进自管配置**（重启后仍是这个状态 ✓）。
                 */
                if (payload.action === 'switch') {
                  const patch = {};
                  if (typeof payload.read === 'boolean') patch.onebotRead = payload.read;
                  if (typeof payload.reply === 'boolean') patch.onebotReply = payload.reply;
                  if (!Object.keys(patch).length) {
                    return sendJson(res, 400, { error: '给 read 或 reply 布尔值' });
                  }
                  Object.assign(config, patch);
                  writeLocalConfig(patch, 'onebot-switch');
                  log(`QQ 开关：${Object.entries(patch).map(([k, v]) => `${k}=${v}`).join(' ')}`);
                  return sendJson(res, 200, {
                    ok: true,
                    read: config.onebotRead,
                    reply: config.onebotReply,
                    note: '已写进自管配置，重启后保持',
                  });
                }
                const text = String(payload.text ?? '').trim();
                if (!text) return sendJson(res, 400, { error: 'text required' });
                const groupId = String(payload.groupId ?? config.onebotGroups[0] ?? '').trim();
                if (!groupId) return sendJson(res, 400, { error: '没给 groupId，配置里也没有默认群' });
                const sent = await onebotSay({ scope: 'group', groupId }, text);
                return sendJson(res, 200, { ok: sent, groupId, sent });
              }
              return sendJson(res, 405, { error: 'method not allowed' });
            }

            /**
             * 只读历史页：GET /history → 浏览器页面（我 + 别的宠物 + 主人说过的话，按时间排）。
             *
             * 为什么做成"每次请求重读文件"：页面改样式/文案不用重启插件，刷新浏览器即可。
             * 页面本身不写任何状态，只是把 /board 与 /memory 的数据排给人看。
             */
            if (rest === 'history') {
              if (method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
              try {
                const html = await readFile(join(PACKAGE_DIR, 'web', 'history.html'), 'utf8');
                res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
                return res.end(html);
              } catch (error) {
                return sendJson(res, 500, { error: '读不到历史页文件：' + (error?.message ?? error) });
              }
            }

            /**
             * 鱼板网络：GET 看当前时间线（谁最近说了什么）。
             * 这是排障入口 —— "两只宠物看不见对方"时，先看 peers 有没有互相发现。
             */
            if (rest === 'board') {
              if (method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
              return sendJson(res, 200, {
                ok: true,
                status: board ? board.status() : null,
                timeline: board ? board.timeline(30) : [],
              });
            }

            /**
             * 表情包：POST = 重新扫目录同步（抓完图、手动放图后不必重启插件）。
             * 只补缺的条目，已有描述不覆盖。
             */
            /**
             * **图库归属账本**：`GET /owners` →
             *   { counts: { legacy: 103, current: 5 }, backlog: { legacy: 0, current: 93 },
             *     items: { "0001": { legacy: {...}, current: {...} } } }
             * 一眼看出"谁有哪张"、"每条鱼还欠多少张" ✓（欠账 = 还没生成自己版本的张数 ✓）。
             */
            /**
             * **宠物间碰撞：屏幕坐标账本**
             *   POST /rects {fishId, rect:{x,y,w,h}}   ← 副本每 ~500ms 报一次自己的宠物包围盒
             *   GET  /rects                             ← 全表（5 秒没更新的自动算"不在场"）
             * 判定与反应见 `checkFishCollisions()` ✓（插件里已有 2 秒一次的巡检 ✓）。
             */
            if (rest === 'rects') {
              if (method === 'POST') {
                let payload = {};
                try {
                  payload = JSON.parse((await readBody(req)) || '{}');
                } catch {
                  return sendJson(res, 400, { error: 'invalid JSON body' });
                }
                const claimed = String(payload.fishId ?? '').trim();
                const r = payload.rect;
                if (!claimed || !r || !['x', 'y', 'w', 'h'].every((k) => Number.isFinite(Number(r[k])))) {
                  return sendJson(res, 400, { ok: false, error: '需要 {fishId, port?, rect:{x,y,w,h}}' });
                }
                /**
                 * **归一化到鱼表的 id** ✓：手动用脚本起的副本，`GPW_FISH_ID` 是 **profile 名**（`second`）
                 * 而鱼表 id 是 `current` ✗ —— 不归一化的话，账本里会同时出现 `second`/`current` 两个幽灵 ✗，
                 * 台词/推开也会查不到对应的鱼 ✓。所以优先按 **port** 反查 ✓，再退回原样（认不出的直接忽略 ✓）。
                 */
                const petsNow = Array.isArray(config.pets) ? config.pets : [];
                const matched = findFish(petsNow, { id: claimed, port: Number(payload.port ?? 0) });
                const id = matched ? matched.id : claimed;
                if (petsNow.length && !matched) {
                  return sendJson(res, 200, { ok: false, ignored: claimed, error: '这条鱼不在鱼表里（按 port 也认不出）' });
                }
                fishRects.set(id, {
                  x: Number(r.x),
                  y: Number(r.y),
                  w: Math.max(1, Number(r.w)),
                  h: Math.max(1, Number(r.h)),
                  /** 上报方自己的速度（抛掷中才有 ✓）—— 冲量按它算 ✓ 近似动量守恒 ✓ */
                  vx: Number(r.vx) || 0,
                  vy: Number(r.vy) || 0,
                  /** 渲染端的脚底垫高（物理像素）：对家靠它算真身盒，缺了就偏高 */
                  bottomPad: Number(r.bottomPad) || 0,
                  /**
                   * **真身盒**（`HIT_BOX` 那一块，物理像素）—— 碰撞判定用它，和渲染端一致。
                   * 老客户端不报这四个字段 → `boxOf()` 退回整张 sprite 盒（兼容）。
                   */
                  bodyX: Number(r.bodyX),
                  bodyY: Number(r.bodyY),
                  bodyW: Number(r.bodyW),
                  bodyH: Number(r.bodyH),
                  at: Date.now(),
                });
                return sendJson(res, 200, { ok: true, id, peers: [...fishRects.keys()].filter((k) => k !== id) });
              }
              if (method === 'GET') {
                const now = Date.now();
                const out = {};
                /**
                 * 顺带**清掉早就没在报的鱼**（60 秒没更新就删）。
                 * 只标 `alive:false` 不删的话，账本里会永远挂着历史幽灵 ——
                 * 实测见过一条 111 秒前的 `gpw`（那是兼容路径起的临时鱼），
                 * 监视页/排障时很容易被当成"还在场的第三只"。
                 */
                for (const [id, r] of [...fishRects]) {
                  if (now - (r.at ?? 0) > 60_000) {
                    fishRects.delete(id);
                    continue;
                  }
                  out[id] = { ...r, alive: now - (r.at ?? 0) < 5000 };
                }
                return sendJson(res, 200, { ok: true, rects: out });
              }
              return sendJson(res, 405, { error: 'method not allowed' });
            }

            /**
             * **跨进程撞击转发**：`POST /hit {fishId, vx, vy}`
             *
             * 起因：两条鱼是两个 Electron 进程，飞行方算出"被撞方的新初速"后，
             * 原版的 `pet:collide-result` 只会在**本进程**里找被撞窗口 → 找不到（对面不在这个进程）。
             * 所以飞行方把结果交给这里，由插件按鱼表找到对面 origin，再 `POST /gpw/hit`
             * → 对面走它自己的 `pet:hit` → `startThrow`，弹性手感与单进程原版一致。
             */
            if (rest === 'hit') {
              if (method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
              let payload = {};
              try {
                payload = JSON.parse((await readBody(req)) || '{}');
              } catch {
                return sendJson(res, 400, { error: 'invalid JSON body' });
              }
              const id = String(payload.fishId ?? '').trim();
              const vx = Number(payload.vx);
              const vy = Number(payload.vy);
              if (!id || !Number.isFinite(vx) || !Number.isFinite(vy)) {
                return sendJson(res, 400, { error: '需要 {fishId, vx, vy}' });
              }
              const target = findFish(Array.isArray(config.pets) ? config.pets : [], { id });
              const origin = String(target?.origin ?? '').replace(/\/+$/, '');
              if (!origin) return sendJson(res, 200, { ok: false, error: '没有这条鱼：' + id });
              try {
                await fetch(origin + '/gpw/hit', {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ vx, vy }),
                  signal: AbortSignal.timeout(1500),
                });
                return sendJson(res, 200, { ok: true, id: target.id });
              } catch (error) {
                return sendJson(res, 200, { ok: false, error: String(error?.message ?? error) });
              }
            }

            /** 碰撞盒监视页：`GET /boxes` → 直接把 /rects 的坐标画出来（排障"位置对不对"用 ✓） */
            if (rest === 'boxes') {
              if (method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
              try {
                const html = await readFile(join(PACKAGE_DIR, 'web', 'boxes.html'), 'utf8');
                res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
                return res.end(html);
              } catch (error) {
                return sendJson(res, 500, { error: '读不到监视页：' + (error?.message ?? error) });
              }
            }

            if (rest === 'owners') {
              if (method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
              const index = await refreshImageOwners({ describe: false });
              return sendJson(res, 200, { ok: true, ...index });
            }

            if (rest === 'images') {
              /**
               * 打开文件夹：`POST /images {"action":"open","which":"memes"|"user"|"data"}`
               *
               * ⚠️ **只接受白名单里的几个目录**，绝不把 HTTP 传来的路径直接交给 explorer ✗
               * （那是标准的命令注入/任意路径打开漏洞 —— 这种口子不能开 ✓）。
               */
              if (method === 'POST') {
                let payload = {};
                try {
                  payload = JSON.parse((await readBody(req)) || '{}');
                } catch {
                  return sendJson(res, 400, { error: 'invalid JSON body' });
                }
                /**
                 * 容量滑块与"满了自动淘汰"开关（面板用）：
                 *   `{"action":"set-cap","max":2000}`  /  `{"action":"set-evict","enabled":true}`
                 * 立即生效 + 写进自管配置（重启保持 ✓）。
                 */
                /**
                 * **按鱼重写表情包描述**：`POST /images {"action":"redescribe","fish":"legacy","limit":10}`
                 *
                 * 为什么需要：老的描述是全局一份 ✗（两条鱼一字不差 ✓）；
                 * 改成按鱼口吻生成之后 ✓，已存在的描述**不会**自动重写 ✗（描述只补缺 ✓），
                 * 所以给一个入口 ✓ 一次重写几张 ✓（每次都要花视觉调用 ✓ 所以 limit 必填/有默认 ✓）。
                 */
                if (payload.action === 'redescribe') {
                  const wantId = String(payload.fish ?? '').trim();
                  const pets = Array.isArray(config.pets) ? config.pets : [];
                  const fish = wantId
                    ? pets.find((f) => f.id === wantId || (f.scope || f.id) === wantId) ?? null
                    : fishOfScope('current');
                  if (!fish) return sendJson(res, 200, { ok: false, error: '没有这条鱼：' + wantId });
                  const scope = fish.scope || fish.id;
                  const store = catalogFor(scope);
                  await store.load();
                  const limit = clampInt(payload.limit, 5, 1, 50);
                  const route = await resolveModel();
                  if (!route) return sendJson(res, 200, { ok: false, error: '没有可用模型（检查设置里的模型路由）' });
                  const dirs = memesDirs(imagesUserRoot, resolveUpstreamRoot() || '');
                  const items = Object.entries(store.data?.items ?? {})
                    .map(([name, item]) => ({ name, item }))
                    .filter(({ item }) => item && (item.sheet || item.file))
                    .slice(0, limit);
                  let done = 0;
                  const failed = [];
                  for (const { name, item } of items) {
                    try {
                      await store.describeOne(
                        { name, mtime: item.mtime ?? Date.now(), sheet: item.sheet || item.file },
                        {
                          /** 显式按鱼重写时**一定**带口吻 ✓（这个入口的用途就是这个 ✓ 不受默认开关影响 ✓） */
                          system: IMAGE_DESCRIBE_SYSTEM + fishVoice(fish),
                          model: route.provider + '/' + route.model,
                          force: true,
                          prompt:
                            `请给表情包「${name}」重写一句索引（给「${fish.name || fish.id}」挑图用）。` +
                            '要写清两件事：① 画面是什么（人物/表情/文字）② 适合在什么场合发。' +
                            '直接给一句通顺的中文，不要分点、不要解释。',
                          by: fish.id,
                          source: 'vision',
                        },
                      );
                      done += 1;
                    } catch (error) {
                      failed.push({ name, message: error instanceof Error ? error.message : String(error) });
                    }
                  }
                  log(`按鱼重写描述：${fish.name || fish.id} 完成 ${done} 张、失败 ${failed.length} 张（limit=${limit}）`);
                  return sendJson(res, 200, { ok: true, fish: fish.id, scope, done, failed, dirs: dirs.length });
                }

                /**
                 * **认领无归属的老描述**：`POST /images {"action":"adopt","fish":"legacy"}`
                 *
                 * 背景 ✗→✓：`by`（谁生成的）是后加的字段 ✓ → 在那之前生成的描述**没有归属** ✗，
                 * 于是"只显示自己名下的"规则会把它们判成"不是我的" ✗
                 * → 7341 名下从一百多张突然掉到 15 张 ✗（主人报的就是这个 ✓）。
                 *
                 * 这个动作把某条鱼目录里 `by` 为空的条目**认领为它自己的** ✓（写盘 ✓ 幂等 ✓）。
                 * 语义上要主人确认 ✓：那些描述确实是谁生成的 ✓（本例：老的一批是 7341 生成的 ✓）。
                 */
                if (payload.action === 'adopt') {
                  const wantId = String(payload.fish ?? '').trim();
                  const pets = Array.isArray(config.pets) ? config.pets : [];
                  const fish = wantId
                    ? pets.find((f) => f.id === wantId || (f.scope || f.id) === wantId) ?? null
                    : null;
                  if (!fish) return sendJson(res, 200, { ok: false, error: '没有这条鱼：' + wantId });
                  const store = catalogFor(fish.scope || fish.id);
                  await store.load();
                  let adopted = 0;
                  for (const [name, item] of Object.entries(store.data?.items ?? {})) {
                    if (!item) continue;
                    if (String(item.by ?? '').trim()) continue;
                    if (!String(item.text ?? '').trim()) continue;
                    item.by = fish.id;
                    item.adoptedAt = Date.now();
                    adopted += 1;
                  }
                  if (adopted) await store.persist();
                  await refreshImageOwners({ describe: false });
                  log(`认领老描述：${fish.name || fish.id} +${adopted} 张（原无归属 ✓）`);
                  return sendJson(res, 200, { ok: true, fish: fish.id, adopted });
                }

                if (payload.action === 'set-collect') {
                  const enabled = payload.enabled === true;
                  config.qqCollectImages = enabled;
                  writeLocalConfig({ qqCollectImages: enabled }, 'panel');
                  log(`群里收到的图就收藏：${enabled ? '开（每张图一次视觉调用，要花钱）' : '关'}`);
                  return sendJson(res, 200, { ok: true, enabled });
                }
                if (payload.action === 'set-cap' || payload.action === 'set-evict') {
                  if (payload.action === 'set-cap') {
                    const max = Number(payload.max);
                    if (!Number.isFinite(max)) return sendJson(res, 400, { error: 'max 要是数字' });
                    const clamped = Math.max(10, Math.min(100_000, Math.round(max)));
                    config.memeLibraryMax = clamped;
                    writeLocalConfig({ memeLibraryMax: clamped }, 'panel');
                    log(`表情包库上限改为 ${clamped} 张`);
                    return sendJson(res, 200, { ok: true, max: clamped, used: Object.keys(imageCatalog.data.items).length });
                  }
                  const enabled = payload.enabled === true;
                  config.memeEvictEnabled = enabled;
                  writeLocalConfig({ memeEvictEnabled: enabled }, 'panel');
                  log(`表情包"满了自动淘汰"：${enabled ? '开' : '关'}`);
                  return sendJson(res, 200, { ok: true, enabled });
                }
                if (payload.action === 'open') {
                  const memesDir = join(imagesUserRoot, 'memes');
                  const targets = {
                    memes: memesDir,
                    user: imagesUserRoot,
                    data: dataDir,
                    attachments: join(dshHome, 'attachments'),
                  };
                  const which = String(payload.which ?? 'memes');
                  const target = targets[which];
                  if (!target) return sendJson(res, 400, { error: 'which 只能是 ' + Object.keys(targets).join('/') });
                  try {
                    mkdirSync(target, { recursive: true });
                    // detached + unref：explorer 起完就与我们无关，不占插件进程 ✓
                    spawn('explorer.exe', [target], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
                    log(`打开文件夹（${which}）：${target}`);
                    return sendJson(res, 200, { ok: true, which, path: target });
                  } catch (error) {
                    return sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
                  }
                }
                const result = await syncImages();
                return sendJson(res, 200, {
                  ok: !result.error,
                  ...result,
                  items: Object.keys(imageCatalog.data.items).length,
                  message: result.error || undefined,
                });
              }
              if (method === 'GET') {
                /**
                 * **按 `?port=` / `?fish=` 认鱼**，但这里返回的是**整库浏览** ✓。
                 *
                 * 边界（主人纠正过一次 ✗→✓）：
                 *   · **挑图/调用** → 只用自己的 ✓（那是提示词那边的过滤 ✓，在 buildSystemPrompt 里 ✓）
                 *   · **这个接口/面板** → 图库是**共用**的 ✓ 要显示全部 ✓，只是**标出哪张是自己的** ✓
                 * 我第一版把这里也过滤成"只有自己名下那几张" ✗
                 * → 两条鱼的图库页都只剩 15 条 ✗（主人报的正是这个 ✓），一百多张被我自己藏了 ✗。
                 */
                const imgFish = fishFromQuery();
                const imgStore = imgFish ? catalogFor(imgFish.scope || imgFish.id) : imageCatalog;
                await imgStore.load();
                const imgAll = Object.entries(imgStore.data?.items ?? {});
                /**
                 * **只显示自己的** ✓（主人明确 ✓）。但别再把老数据"弄丢" ✗：
                 * 那些 `by` 为空的老描述要靠 `adopt` 认领回各自名下 ✓（见 /images 的 adopt 动作 ✓）；
                 * 一条都没有时才退回整库 ✓（新装的鱼不至于空着 ✓）。
                 */
                const imgOwn = imgFish ? imgAll.filter(([, it]) => String(it?.by ?? '') === imgFish.id) : imgAll;
                const imgEntries = imgOwn.length > 0 ? imgOwn : imgAll;
                const imgCount = imgEntries.length;
                return sendJson(res, 200, {
                  ok: true,
                  inPrompt: config.imageInPrompt !== false,
                  limit: config.imageLimit,
                  runtime: { ...imageState },
                  userRoot: imagesUserRoot,
                  // ⚠️ 必须调用**惰性解析函数**，不能写成裸变量：
                  // `resolveUpstreamRoot()` 依赖异步探测到的 patch 路径，apply() 期算是空的。
                  // 这里曾经写成裸 `upstreamRoot` → ReferenceError → `/images` 整个 500
                  // （面板的表情包同步一直不可用），是自检"真打一遍路由"抓出来的。
                  upstreamRoot: resolveUpstreamRoot(),
                  /** 表情包目录（面板"打开文件夹"用；也让人一眼看到图放哪 ✓） */
                  memesDir: join(imagesUserRoot, 'memes'),
                  /** 副本 origin：面板据此拼缩略图 URL（/dsh-pet-7340/pic/memes/<名>.png ✓） */
                  self: imgFish ? String(imgFish.origin ?? '') || defaultGpwOrigin() : defaultGpwOrigin(),
                  /** QQ 自动收进来的张数 ✓ */
                  kept: state.qqKept || 0,
                  /** 容量上限与已用（面板滑块用 ✓） */
                  max: config.memeLibraryMax,
                  /** 库总量（共用那一份 ✓ 面板想知道总规模看这个 ✓） */
                  library: { total: Object.keys(imageCatalog.data.items).length, memesDir: join(imagesUserRoot, 'memes') },
                  /** 这条鱼自己的名字（面板标题/调试用 ✓） */
                  fish: imgFish ? { id: imgFish.id, name: imgFish.name, scope: imgFish.scope || imgFish.id } : null,
                  /** 整库里有多少张是**它自己名下**的 ✓（页面/面板可以显示"我的 15 / 共 130" ✓） */
                  mineCount: imgFish
                    ? Object.values(imgStore.data?.items ?? {}).filter((it) => String(it?.by ?? '') === imgFish.id).length
                    : 0,
                  total: imgCount,
                  evictEnabled: config.memeEvictEnabled === true,
                  collectEnabled: config.qqCollectImages === true,
                  collected: state.qqImagesCollected || 0,
                  evicted: state.memesEvicted || 0,
                  /**
                   * 名单 + 描述（面板列表用）—— **按鱼** ✓。
                   *
                   * 为什么必须按鱼：图库文件是共用的 ✓（一套数字编号 ✓），但**描述各写各的** ✓。
                   * 面板一直带着自己的 `?port=` ✓，可这个接口原来忽略它 ✗ → 两个面板都显示
                   * 主鱼（7342）那份 ✗（主人报的"表情包页面没有独立表示" ✓ 就是这个 ✓）。
                   *
                   * 规则与提示词一致 ✓：只给它**自己名下**的（`item.by = 它的 id` ✓）；
                   * 一条都没写过时给整份 ✓（免得面板空着 ✗）。
                   */
                  items: imgCount,
                  entries: imgEntries.slice(0, 300).map(([name, item]) => ({
                    name,
                    text: String(item?.text ?? '').slice(0, 160),
                    file: item?.file ?? item?.sheet ?? '',
                    by: String(item?.by ?? ''),
                    mine: String(item?.by ?? '') === String(imgFish?.id ?? ''),
                    fromQq: String(item?.file ?? '').includes('qq-'),
                  })),
                  list: imgEntries.slice(0, 40).map(([name]) => name),
                });
              }
              return sendJson(res, 405, { error: 'method not allowed' });
            }

            /**
             * 偏好（宠物尺寸 / 文字大小）转发给副本：GET 读、POST 存。
             * 面板窗是从副本自己的服务加载的，但它用插件(19387)当 API 统一入口
             * （这样"插件离线"时面板能明确报出来，而不是静默失败）。
             */
            if (rest === 'prefs') {
              const origin = defaultGpwOrigin();
              try {
                const upstream = await fetch(origin + '/gpw/prefs', {
                  method,
                  headers: { 'content-type': 'application/json' },
                  body: method === 'POST' ? (await readBody(req)) || '{}' : undefined,
                  signal: AbortSignal.timeout(4000),
                });
                const data = await upstream.json().catch(() => ({ ok: false, message: '副本返回的不是 JSON' }));
                return sendJson(res, upstream.status, data);
              } catch (error) {
                return sendJson(res, 503, { ok: false, message: '连不上副本：' + (error?.message ?? error) });
              }
            }

            /** 桌宠副本：POST {action:'start'|'stop'|'status'} —— 界面上"叫醒宠物"用 */
            if (rest === 'fork') {
              if (method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
              let payload = {};
              try {
                payload = JSON.parse((await readBody(req)) || '{}');
              } catch {
                return sendJson(res, 400, { error: 'invalid JSON body' });
              }
              const action = String(payload.action ?? 'status');
              if (action === 'start') {
                await ensureFork('manual');
              } else if (action === 'stop') {
                const { stopFork } = await import('./src/launcher.js');
                stopFork(log);
              } else if (action === 'status') {
                await ensureFork('probe-only');
              }
              return sendJson(res, 200, { ok: true, fork: { ...state.fork } });
            }

            if (rest === 'control') {
              if (method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
              let payload = {};
              try {
                payload = JSON.parse((await readBody(req)) || '{}');
              } catch {
                return sendJson(res, 400, { error: 'invalid JSON body' });
              }
              const action = String(payload.action ?? '');
              /**
               * **带 `port`（或 `fish`）= 只控制这一条鱼**（2026-10-18：观察状态改成按鱼独立）。
               *
               * 面板/胶囊本来就是"每条鱼一个"的，它们点暂停时如果走全局，
               * 会把别的鱼一起停掉 —— 这就是"观察状态没独立"的体感来源。
               * 不带这两个参数才走全局（设置页里的总开关）。
               */
              const ctlPort = Number(payload.port ?? url.searchParams.get('port') ?? 0);
              const ctlFish = String(payload.fish ?? url.searchParams.get('fish') ?? '').trim();
              const ctlPets = Array.isArray(config.pets) ? config.pets : [];
              const ctlTarget = ctlPort || ctlFish ? findFish(ctlPets, { id: ctlFish, port: ctlPort }) : null;
              if (ctlTarget && (action === 'start' || action === 'resume' || action === 'pause' || action === 'stop')) {
                const rt = fishRuntimeOf(fishKeyOf(ctlTarget));
                const next = action === 'pause' || action === 'stop';
                rt.paused = next;
                rt.pausedAt = next ? Date.now() : null;
                rt.pauseReason = next ? '单独暂停' : '';
                if (!next) {
                  fishDueAt.set(fishKeyOf(ctlTarget), 0);
                  if (state.running) schedule();
                  else start('界面');
                }
                log(`鱼「${ctlTarget.id}」观察状态：${next ? '单独暂停' : '恢复'}（按鱼控制）`);
                await memory.load();
                return sendJson(res, 200, { ok: true, perFish: true, fish: ctlTarget.id, paused: next });
              }
              if ((ctlPort || ctlFish) && !ctlTarget) {
                return sendJson(res, 404, { ok: false, message: '没有这条鱼（按 port 也认不出）' });
              }
              if (action === 'start' || action === 'resume') {
                start('界面');
              } else if (action === 'pause' || action === 'stop') {
                stop('手动暂停');
              } else if (action === 'now') {
                void tick();
              } else if (action === 'clear-errors') {
                state.errors.length = 0;
              } else if (action === 'patch') {
                config = normalizeConfig({ ...config, ...(payload.config ?? {}) });
                if (state.running) schedule();
              } else {
                return sendJson(res, 200, { ok: false, message: '未知动作：' + action });
              }
              await memory.load();
              return sendJson(res, 200, { ok: true, ...publicState() });
            }

            return sendJson(res, 404, { error: 'not found' });
          } catch (error) {
            pushError('route', error);
            try {
              return sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
            } catch {
              return undefined;
            }
          }
        },
      }),
    'game-pet-watch: routes',
  );

  ctx.effect(() => {
    void memory.load();
    // patch 文件定位：桌面应用形态没有 DSH_PROFILE_DIR，于是靠"哪份 patch 里有本插件那一行"来认。
    // 在装载时就探一次并缓存，之后 resolvePatchFile() 同步可用（状态页/写入都用它）。
    void findPatchFile(dshHome).then((file) => {
      if (file) log('profile patch = ' + file);
      else log('没定位到 profile patch：提示词页只能读、不能写（可手工改 cordis.patch.yml）');
    });
    if (config.enabled) start('插件加载');
    else stop('启动配置里 enabled=false');
    return () => stop('插件卸载');
  }, 'game-pet-watch: capture loop');

  log(
    `已加载（窗口="${config.windowTitle || '主屏'}" 间隔=${config.intervalSec}s 推送=${config.pushToPet} 记忆=${memoryFilePath(dataDir)}）`,
  );
}

export const inject = ['webServer', 'attachments', 'llm'];
export { normalizeConfig, normalizePhrase, DEFAULTS, ROUTE_PREFIX, PET_ROUTE_PREFIX };
