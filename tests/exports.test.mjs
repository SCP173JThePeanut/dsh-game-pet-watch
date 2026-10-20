/**
 * **插件导出面的回归测试**（纯函数 + 常量，秒级，不碰网络/文件系统）。
 *
 *   node tests/exports.test.mjs
 *
 * 为什么要这份：`preflight.mjs` 只验"这五个导出还在、apply 跑得起来"，
 * 而导出面一改（改名、少一个、默认值被顺手调掉、normalizeConfig 的夹取范围变了）
 * 宿主侧不会报错，只会**静默表现成"配置没生效"** —— 这个坑真踩过：
 * 新加的配置键忘了进白名单，设置页存了、内存里没了，看起来一切正常。
 * 所以这里对**导出面本身**做断言：多一个少一个都要显式更新这份测试。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as plugin from '../index.js';

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

let pass = 0;
const fails = [];
function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) pass += 1;
  else fails.push(`${label}: got ${a} want ${b}`);
}
function ok(cond, label) {
  if (cond) pass += 1;
  else fails.push(`${label}: expected truthy`);
}
function has(haystack, needle, label) {
  ok(String(haystack).includes(needle), `${label}（缺少「${needle}」）`);
}

// ── 1. 导出面：名字与类型 ──
const NAMED = [
  'apply', 'inject', 'DEFAULTS', 'normalizeConfig', 'normalizePhrase', 'Config', 'name',
  'parseDecision', 'selfIdentityLine', 'parseMasterTarget', 'composeQuestion', 'computeBackoff',
  'computeFishDelayMs', 'compactSystemFor', 'pluginOriginOf', 'buildFishBoardRegistry',
  'ROUTE_PREFIX', 'PET_ROUTE_PREFIX',
];
for (const key of NAMED) ok(key in plugin, `导出 ${key} 存在`);

for (const fn of ['apply', 'normalizeConfig', 'normalizePhrase', 'parseDecision', 'selfIdentityLine', 'parseMasterTarget', 'composeQuestion', 'computeBackoff', 'computeFishDelayMs', 'compactSystemFor', 'pluginOriginOf']) {
  eq(typeof plugin[fn], 'function', `导出 ${fn} 是函数`);
}
// 宿主靠 inject 声明依赖；改了名字/顺序都要显式改这里
eq(plugin.inject, ['webServer', 'attachments', 'llm'], 'inject 依赖声明');
eq(plugin.ROUTE_PREFIX, '/game-pet-watch', 'ROUTE_PREFIX');
eq(plugin.PET_ROUTE_PREFIX, '/dsh-pet-7340', 'PET_ROUTE_PREFIX');
eq(plugin.name, 'dsh-game-pet-watch', 'name 与包名一致');
eq(plugin.name, JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')).name, 'name 与 package.json 一致');

// Config 是给宿主看的 schema（schemastery 的 schema 函数，带 type / dict），不是普通对象。
// 宿主按它渲染设置页，所以这里既验形状，也验几个关键键真的被声明了。
eq(typeof plugin.Config, 'function', 'Config 是 schema 构造器');
eq(plugin.Config.type, 'object', 'Config.type');
ok(plugin.Config.dict && typeof plugin.Config.dict === 'object', 'Config.dict 存在');
// 注意：`pets` 故意不在 schema 里 —— 鱼表是面板/`/pets` 接口维护的数据，不是设置页的标量项
for (const key of ['enabled', 'intervalSec', 'cooldownSec', 'collideDetectMs', 'collidePadPx']) {
  ok(key in plugin.Config.dict, `Config.dict 声明了 ${key}`);
}

// ── 2. DEFAULTS：形状与关键默认值 ──
ok(plugin.DEFAULTS && typeof plugin.DEFAULTS === 'object', 'DEFAULTS 是对象');
for (const [key, value] of Object.entries(plugin.DEFAULTS)) {
  ok(value !== undefined, `DEFAULTS.${key} 不是 undefined`);
}
eq(plugin.DEFAULTS.enabled, true, 'DEFAULTS.enabled');
eq(plugin.DEFAULTS.pushToPet, true, 'DEFAULTS.pushToPet');
eq(plugin.DEFAULTS.intervalSec, 20, 'DEFAULTS.intervalSec');
eq(plugin.DEFAULTS.maxChars, 60, 'DEFAULTS.maxChars');
eq(plugin.DEFAULTS.autoLaunchFork, true, 'DEFAULTS.autoLaunchFork');
// 碰撞那组（多鱼之后才有的；默认"容易撞但不烧 API"）
eq(plugin.DEFAULTS.collideCallModel, false, 'DEFAULTS.collideCallModel');
eq(plugin.DEFAULTS.collideDetectMs, 500, 'DEFAULTS.collideDetectMs');
eq(plugin.DEFAULTS.collidePadPx, 2, 'DEFAULTS.collidePadPx');
eq(plugin.DEFAULTS.collidePushPx, 3, 'DEFAULTS.collidePushPx');
eq(plugin.DEFAULTS.collideLineCooldownSec, 60, 'DEFAULTS.collideLineCooldownSec');

// ── 3. normalizeConfig：补默认值 / 夹取 / 丢未知键 / 归一化鱼表 ──
const empty = plugin.normalizeConfig({});
eq(empty.intervalSec, plugin.DEFAULTS.intervalSec, 'normalizeConfig 空输入补默认值');
eq(empty.pets, [], 'normalizeConfig 空输入 pets 为空数组');
eq(plugin.normalizeConfig(null).intervalSec, plugin.DEFAULTS.intervalSec, 'normalizeConfig(null) 不抛错');
eq(plugin.normalizeConfig(undefined).maxChars, plugin.DEFAULTS.maxChars, 'normalizeConfig(undefined) 不抛错');

// 夹取边界（改 schema 的 min/max 时这里会红，提醒同步面板与测试）
eq(plugin.normalizeConfig({ collideDetectMs: 1 }).collideDetectMs, 100, 'collideDetectMs 下界');
eq(plugin.normalizeConfig({ collideDetectMs: 99999 }).collideDetectMs, 5000, 'collideDetectMs 上界');
eq(plugin.normalizeConfig({ collideDetectMs: 'abc' }).collideDetectMs, 500, 'collideDetectMs 非数字回落');
eq(plugin.normalizeConfig({ collidePadPx: -5 }).collidePadPx, 0, 'collidePadPx 下界');
eq(plugin.normalizeConfig({ collidePushPx: 999 }).collidePushPx, 32, 'collidePushPx 上界');
eq(plugin.normalizeConfig({ collideLineCooldownSec: 0 }).collideLineCooldownSec, 5, 'collideLineCooldownSec 下界');
eq(plugin.normalizeConfig({ collideCallModel: true }).collideCallModel, true, 'collideCallModel 透传');

// 白名单：不在 DEFAULTS 里的键必须被丢掉（漏加白名单 = 静默丢配置）
ok(!('__nope' in plugin.normalizeConfig({ __nope: 1 })), '未知键被丢弃');

// 鱼表归一化：去空格、去尾斜杠、scope 缺省=id、enabled 缺省=true、无 id 的鱼被过滤
const one = plugin.normalizeConfig({
  pets: [{ id: ' current ', name: ' 鱼板妹妹7342 ', origin: 'http://127.0.0.1:7342/', qq: true }],
}).pets[0];
eq(one.id, 'current', 'pets[].id 去空格');
eq(one.name, '鱼板妹妹7342', 'pets[].name 去空格');
eq(one.origin, 'http://127.0.0.1:7342', 'pets[].origin 去尾斜杠');
eq(one.scope, 'current', 'pets[].scope 缺省等于 id');
eq(one.enabled, true, 'pets[].enabled 缺省 true');
eq(one.qq, true, 'pets[].qq 透传');
eq(plugin.normalizeConfig({ pets: [{ origin: 'http://127.0.0.1:7399' }] }).pets, [], '没有 id 的鱼被过滤');
eq(plugin.normalizeConfig({ pets: 'not-an-array' }).pets, [], 'pets 非数组时回落空表');

// ── 4. parseDecision：模型输出 → 一句话 ──
eq(plugin.parseDecision('{"say":"撞到本鱼了喵"}', 60), { phrase: '撞到本鱼了喵', anim: undefined, img: undefined, toGroup: false, format: 'json' }, 'parseDecision 纯 JSON');
eq(plugin.parseDecision('```json\n{"say":"喵"}\n```', 60).phrase, '喵', 'parseDecision 代码块包裹');
eq(plugin.parseDecision('{"text":"喵"}', 60).phrase, '喵', 'parseDecision 兼容 text 字段');
eq(plugin.parseDecision('{"say":"喵","anim":" 跳 "}', 60).anim, '跳', 'parseDecision anim 去空格');
eq(plugin.parseDecision('{"say":"喵","toGroup":true}', 60).toGroup, true, 'parseDecision toGroup');
eq(plugin.parseDecision('{"say":"喵","toGroup":"true"}', 60).toGroup, true, 'parseDecision toGroup 字符串 true');
eq(plugin.parseDecision('{"say":"喵"}', 60).toGroup, false, 'parseDecision toGroup 缺省 false');
eq(plugin.parseDecision('{}', 60).phrase, undefined, 'parseDecision 空对象不说话');
eq(plugin.parseDecision('{}', 60).format, 'json', 'parseDecision 空对象仍记 json');
eq(plugin.parseDecision('{"say":""}', 60).phrase, undefined, 'parseDecision 空台词不说话');
eq(plugin.parseDecision('就一句普通的话', 60), { phrase: '就一句普通的话', format: 'text' }, 'parseDecision 纯文本');
eq(plugin.parseDecision('第一行\n第二行', 60).phrase, '第一行', 'parseDecision 只取第一行');
eq(plugin.parseDecision('这是一句很长很长的话', 5).phrase, '这是一句很', 'parseDecision 按 maxChars 截断');
eq(plugin.parseDecision('"喵"', 60).phrase, '喵', 'parseDecision 去掉包裹引号');
eq(plugin.parseDecision('台词：喵', 60).phrase, '喵', 'parseDecision 去掉「台词：」前缀');
eq(plugin.parseDecision('SILENT', 60).phrase, undefined, 'parseDecision SILENT 不说话');
eq(plugin.parseDecision('', 60).phrase, undefined, 'parseDecision 空输入');
eq(plugin.parseDecision(null, 60).phrase, undefined, 'parseDecision null 不抛错');

// normalizePhrase：parseDecision 的底层，单独也测一遍
eq(plugin.normalizePhrase('  喵  ', 60), '喵', 'normalizePhrase 去空白');
eq(plugin.normalizePhrase('', 60), undefined, 'normalizePhrase 空串');
eq(plugin.normalizePhrase('abcdef', 3), 'abc', 'normalizePhrase 截断');
eq(plugin.normalizePhrase('无', 60), undefined, 'normalizePhrase 「无」视为沉默');

// ── 5. 提示词拼装（曾经"算出来了却没拼进去"，所以必须有测试盯着） ──
has(plugin.selfIdentityLine('鱼板妹妹7341'), '鱼板妹妹7341', 'selfIdentityLine 带名字');
eq(plugin.selfIdentityLine(''), '', 'selfIdentityLine 空名字返回空串');
eq(plugin.selfIdentityLine(null), '', 'selfIdentityLine null 返回空串');

eq(plugin.parseMasterTarget('@小鱼 在吗'), { text: '在吗', to: '小鱼' }, 'parseMasterTarget 空格分隔');
eq(plugin.parseMasterTarget('@小鱼：在吗'), { text: '在吗', to: '小鱼' }, 'parseMasterTarget 全角冒号');
eq(plugin.parseMasterTarget('@全体 大家好'), { text: '大家好', to: '*' }, 'parseMasterTarget @全体 是广播');
eq(plugin.parseMasterTarget('@all hi'), { text: 'hi', to: '*' }, 'parseMasterTarget @all 是广播');
eq(plugin.parseMasterTarget('普通一句'), { text: '普通一句', to: '*' }, 'parseMasterTarget 默认广播');
eq(plugin.parseMasterTarget(''), { text: '', to: '*' }, 'parseMasterTarget 空输入');
eq(plugin.parseMasterTarget('@小鱼'), { text: '@小鱼', to: '*' }, 'parseMasterTarget 只有 @ 名字时原样广播');

const q1 = plugin.composeQuestion({ operatorText: '在吗' });
has(q1, '主人刚刚对你说：「在吗」', 'composeQuestion 广播/点名自己');
has(q1, '直接回他一句。', 'composeQuestion 要求回一句');
const q2 = plugin.composeQuestion({ operatorText: '在吗', masterTo: '小鱼', selfName: '大肥鱼' });
has(q2, '不是对你说的', 'composeQuestion 点名别人时明说');
const q3 = plugin.composeQuestion({ gameBlock: '【游戏】残血', boardBlock: '【鱼板】B 说了话' });
has(q3, '【游戏】残血', 'composeQuestion 带游戏块');
has(q3, '【鱼板】B 说了话', 'composeQuestion 带鱼板块');
ok(q3.indexOf('【游戏】残血') < q3.indexOf('【鱼板】B 说了话'), 'composeQuestion 游戏块在鱼板之前');
has(plugin.composeQuestion({}), '判断要不要说话', 'composeQuestion 无主人发言时的措辞');

// ── 6. 每条鱼的随机时间波动（可注入随机源，所以能断言确定性结果） ──
const delay = plugin.computeFishDelayMs;
eq(delay({ baseMs: 20000, jitterSec: 0, rand: () => 0.5 }), 20000, '波动 0 = 基础间隔');
eq(delay({ baseMs: 20000, jitterSec: 5, rand: () => 0 }), 15000, '波动下界 = 基础 - jitter');
eq(delay({ baseMs: 20000, jitterSec: 5, rand: () => 1 }), 25000, '波动上界 = 基础 + jitter');
eq(delay({ baseMs: 20000, jitterSec: 5, rand: () => 0.5 }), 20000, '波动中点 = 基础');
eq(delay({ baseMs: 20000, jitterSec: 999, rand: () => 0 }), 5000, 'jitter 夹到 300s 后仍受 minMs 兜底');
eq(delay({ baseMs: 1000, jitterSec: 0 }), 5000, '基础间隔低于 minMs 时抬到 minMs');
eq(delay({ baseMs: 20000, jitterSec: 'abc' }), 20000, 'jitter 非数字按 0 处理');
eq(delay({ baseMs: 20000, jitterSec: -5 }), 20000, '负 jitter 按 0 处理');

// normalizeConfig 里 jitterSec 是白名单字段（漏了就会"面板存了、内存里没了"）
eq(plugin.normalizeConfig({ pets: [{ id: 'a' }] }).pets[0].jitterSec, 5, 'pets[].jitterSec 默认 5');
eq(plugin.normalizeConfig({ pets: [{ id: 'a', jitterSec: 0 }] }).pets[0].jitterSec, 0, 'pets[].jitterSec 0 保留');
eq(plugin.normalizeConfig({ pets: [{ id: 'a', jitterSec: -3 }] }).pets[0].jitterSec, 0, 'pets[].jitterSec 下界 0');
eq(plugin.normalizeConfig({ pets: [{ id: 'a', jitterSec: 9999 }] }).pets[0].jitterSec, 300, 'pets[].jitterSec 上界 300');
eq(plugin.normalizeConfig({ pets: [{ id: 'a', jitterSec: '7' }] }).pets[0].jitterSec, 7, 'pets[].jitterSec 字符串数字');

// ── 7. 长期记忆压缩说明：按鱼覆盖，留空回落全局 ──
const compactOf = plugin.compactSystemFor;
eq(compactOf({ compactSystem: 'G' }, { compactSystem: 'F' }), 'F', '鱼自己的压缩说明优先');
eq(compactOf({ compactSystem: 'G' }, { compactSystem: '   ' }), 'G', '鱼的说明空白 → 回落全局');
eq(compactOf({ compactSystem: 'G' }, {}), 'G', '鱼没写 → 用全局');
eq(compactOf({ compactSystem: 'G' }, null), 'G', '没有鱼 → 用全局');
eq(compactOf({}, null), '', '两边都没写 → 空串');
eq(compactOf({ compactSystem: '  G  ' }, { compactSystem: 'F' }), 'F', '两边都去空白后取值');
// 白名单：不列进来，面板存了也会被丢掉
eq(plugin.normalizeConfig({ pets: [{ id: 'a', compactSystem: ' 我的总结  ' }] }).pets[0].compactSystem, ' 我的总结  ', 'pets[].compactSystem 保留');
eq(plugin.normalizeConfig({ pets: [{ id: 'a' }] }).pets[0].compactSystem, undefined, 'pets[].compactSystem 缺省 undefined');

// ── 8. 插件端口：设置里写死优先，否则用探测值 ──
const originOf = plugin.pluginOriginOf;
eq(originOf({ configuredPort: 64541, learned: 'http://127.0.0.1:3082' }), 'http://127.0.0.1:64541', '设置里的端口优先');
eq(originOf({ configuredPort: 0, learned: 'http://127.0.0.1:3082/' }), 'http://127.0.0.1:3082', '0 = 用探测值（去尾斜杠）');
eq(originOf({}), '', '都没有 → 空串（调用方再兜底）');
eq(originOf({ configuredPort: '8080' }), 'http://127.0.0.1:8080', '字符串端口也能用');
eq(plugin.normalizeConfig({ pluginPort: 64541 }).pluginPort, 64541, 'pluginPort 透传');
eq(plugin.normalizeConfig({}).pluginPort, 0, 'pluginPort 默认 0（自动）');
eq(plugin.normalizeConfig({ pluginPort: -1 }).pluginPort, 0, 'pluginPort 下界 0');
eq(plugin.normalizeConfig({ pluginPort: 70000 }).pluginPort, 65535, 'pluginPort 上界 65535');
eq(plugin.normalizeConfig({ pluginPort: 'abc' }).pluginPort, 0, 'pluginPort 非数字回落 0');
ok('pluginPort' in plugin.Config.dict, 'Config.dict 声明了 pluginPort');

// ── 8b. 素材目录的解析顺序：配置 → 副本自带 assets → profile 里的 dsh-pet ──
const upOf = plugin.resolveUpstreamPetRoot;
// 用 join 生成期望值：Windows 下解析结果带反斜杠，比字符串会把平台差异当失败
const PET_ROOT = join('G:', 'repo', 'dsh-pet-gpw');
const DSH_HOME = join('C:', 'Users', 'x', '.dsh');
const PROFILE_PET = join(DSH_HOME, 'profiles', 'desktop', 'node_modules', 'dsh-pet');
const OWN_ASSETS = join(PET_ROOT, 'assets', 'config.jsonc');
const existsIn = (set) => (p) => set.some((s) => String(p).toLowerCase() === String(s).toLowerCase());
eq(upOf({ configured: join('D:', 'mine', 'dsh-pet'), petRoot: PET_ROOT, dshHome: DSH_HOME, fsExists: () => true }), join('D:', 'mine', 'dsh-pet'), '配置优先于一切');
eq(
  upOf({ petRoot: PET_ROOT, dshHome: DSH_HOME, fsExists: existsIn([OWN_ASSETS, PROFILE_PET]) }),
  PET_ROOT,
  '副本自带 assets 时用它（素材已独立）',
);
eq(
  upOf({ petRoot: PET_ROOT, dshHome: DSH_HOME, fsExists: existsIn([PROFILE_PET]) }),
  PROFILE_PET,
  '没有自带 assets → 借 profile 里的 dsh-pet',
);
eq(upOf({ petRoot: PET_ROOT, dshHome: '' }), '', '既没配置也没 DSH_HOME → 空串（调用方再兜底）');

// ── 9. 公共登记簿（~/.dsh/fish-board/registry.json 的内容） ──
const reg = plugin.buildFishBoardRegistry({
  config: {
    pets: [
      { id: 'legacy', name: '鱼板妹妹7341', origin: 'http://127.0.0.1:7341/', scope: 'legacy', enabled: true },
      { id: 'opencode', name: '鱼板妹妹7350号', origin: 'http://127.0.0.1:7350', scope: 'opencode', enabled: false },
      { id: '', name: '空 id 要被丢掉', origin: 'http://127.0.0.1:7399' },
    ],
  },
  origin: 'http://127.0.0.1:64541/',
  now: 1792000000000,
});
eq(reg.protocol, 'fish-board/3', '登记簿协议名');
eq(reg.pluginOrigin, 'http://127.0.0.1:64541', '登记簿带插件地址（去尾斜杠）');
eq(reg.updatedAt, 1792000000000, '登记簿带时间戳');
eq(reg.fish.length, 2, '空 id 的鱼不进登记簿');
eq(reg.fish[0], { id: 'legacy', name: '鱼板妹妹7341', origin: 'http://127.0.0.1:7341', scope: 'legacy', port: 7341, enabled: true }, '登记簿里鱼的形状');
eq(reg.fish[1].enabled, false, 'enabled:false 的鱼也登记（账本要认它）');
eq(reg.fish[1].port, 7350, '从 origin 里取端口');
eq(plugin.buildFishBoardRegistry({ config: { pets: [] }, origin: '' }).fish, [], '没有鱼 → 空表');
eq(plugin.buildFishBoardRegistry({}).pluginOrigin, '', '没有地址 → 空串');
eq(plugin.buildFishBoardRegistry({}).protocol, 'fish-board/3', '缺参数也不抛错');

// ── 9c. 记录页系统条目开关（只影响记录页，不影响记忆/上下文） ──
eq(plugin.DEFAULTS.historyHideSystem, true, '记录页默认隐藏系统条目');
eq(plugin.normalizeConfig({ historyHideSystem: false }).historyHideSystem, false, '能让它显示出来');
eq(plugin.normalizeConfig({ historyHideSystem: true }).historyHideSystem, true, '默认值也能显式写');

/**
 * ── 9d. 提示词守卫：默认值 == 用户当前值时，被清空也要补回来 ──
 *
 * 复现过的事故：默认人设/规则换成主人现用的那套之后，守卫里存的"等于默认"→
 * `saved === def` 直接跳过 → DSH 把 rules 挤成空串时没人补，运行中的提示词里"规则："后面空了。
 */
{
  const { resolvePromptGuard } = await import('../src/prompt-guard.js');
  const same = 'XRULE';
  const wiped = resolvePromptGuard({
    current: { rules: '' },
    guard: { rules: same },
    defaults: { rules: same },
  });
  eq(wiped.reason, 'reset-detected', '被清空 + 守卫等于默认 → 仍然算重置');
  eq(wiped.restore.rules, same, '并且补回规则原文');
  const intact = resolvePromptGuard({
    current: { rules: same },
    guard: { rules: same },
    defaults: { rules: same },
  });
  eq(intact.reason, 'ok', '没被清空就不折腾');
  eq(plugin.DEFAULTS.rules.length > 100, true, '默认开口规则不是一句话空壳');
}

/**
 * ── 9e. profile patch 解析 ──
 *
 * 必须有：bundle 层里写死了 intervalSec: 20，而 loader 把它应用在用户 patch 之后，
 * 于是主人写 60 不生效（实测运行中一直 20）。插件自己读 patch 才能按设置来。
 */
{
  const { parsePatchConfig } = await import('../src/config-store.js');
  const sample = [
    '- id: other',
    '  config:',
    '    intervalSec: 5',
    '- id: game-pet-watch',
    "  name: 'dsh-game-pet-watch/index-9.9.9.js'",
    '  config:',
    '    enabled: true',
    '    intervalSec: 60',
    '    rules: |-',
    '      第一行',
    '      第二行',
    '    onebotGroups: []',
  ].join('\n');
  const parsed = parsePatchConfig(sample);
  eq(parsed.intervalSec, 60, '读到本条的 intervalSec（不是别的条目）');
  eq(parsed.rules, '第一行\n第二行', '块字符串按行还原');
  eq(Array.isArray(parsed.onebotGroups), true, '内联空数组');
  eq(parsed.enabled, true, '布尔值');

  /** 没有本插件那条时给空对象，别抛（有些 profile 根本没装） */
  eq(Object.keys(parsePatchConfig('- id: other\n  config:\n    a: 1')).length, 0, '找不到本条 → 空对象');
}

// ── 9f. 事件反应限流（冷却默认 30s、预算 8 次 / 10 分钟）──
eq(plugin.DEFAULTS.gohImmediateCooldownSec, 30, '重要事件冷却默认 30 秒');
eq(plugin.DEFAULTS.gohReactionBudget, 8, '十分钟最多 8 次');
eq(plugin.normalizeConfig({ gohImmediateCooldownSec: 5 }).gohImmediateCooldownSec, 5, '能调到 5 秒');
eq(plugin.normalizeConfig({ gohReactionBudget: 0 }).gohReactionBudget, 0, '0 = 不限');

// ── 9g. 历史去重：跨来源 90 秒内算一条；同来源不算 ──
{
  const { mergeHistory } = await import('../src/history.js');
  const base = 1_800_000_000_000;
  const cross = mergeHistory({
    memory: [{ at: base + 86_000, role: 'pet', text: '同一句话', kind: 'pet' }],
    board: [{ at: base, kind: 'peer', who: 'X', text: '同一句话' }],
  });
  eq(cross.length, 1, '跨来源相差 86 秒 → 合并成一条（历史页不再成对出现）');

  const far = mergeHistory({
    memory: [{ at: base + 200_000, role: 'pet', text: '旧话', kind: 'pet' }],
    board: [{ at: base, kind: 'peer', who: 'X', text: '旧话' }],
  });
  eq(far.length, 2, '相差 200 秒 → 还是两条');

  const same = mergeHistory({
    board: [
      { at: base, kind: 'peer', who: 'X', text: '重复台词' },
      { at: base + 10_000, kind: 'peer', who: 'X', text: '重复台词' },
    ],
  });
  eq(same.length, 2, '同一来源 10 秒内重复 → 保留两条（真的说了两遍）');
}

// ── 9h. 模型自己写长期记忆（remember 字段）+ 配置开关 ──
{
  const { MemoryStore } = await import('../src/memory.js');
  const os = await import('node:os');
  const path = await import('node:path');
  const fs = await import('node:fs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpw-longterm-'));
  const store = new MemoryStore(path.join(dir, 'memory.json'), () => {});
  await store.load();
  const first = await store.appendLongTerm('主人说周五上线新战役', { limit: 2400 });
  eq(first.added, true, '第一条能加进去');
  const dup = await store.appendLongTerm('主人说周五上线新战役', { limit: 2400 });
  eq(dup.added, false, '同一句不重复加');
  const second = await store.appendLongTerm('卡在第三关的桥头', { limit: 2400 });
  eq(second.added, true, '第二条能加');
  const snap = store.snapshot();
  eq(String(snap.longTerm.text).split('\n').length, 2, '长期记忆变成两行');
  eq(Boolean(snap.longTerm.selfAdded >= 2), true, '记了 selfAdded 计数');
  const over = await store.appendLongTerm('x'.repeat(400), { limit: 210 });
  eq(over.overflow, true, '超上限会标 overflow（调用方去压缩）');
  fs.rmSync(dir, { recursive: true, force: true });

  eq(plugin.DEFAULTS.memoryAllowSelfNote, true, '默认允许模型自己记');
  eq(plugin.normalizeConfig({ memoryAllowSelfNote: false }).memoryAllowSelfNote, false, '能关掉');
  eq(plugin.parseDecision('{"say":"hi","remember":"记住这句"}').remember, '记住这句', 'parseDecision 解析 remember');
  eq(plugin.parseDecision('{"remember":"只在心里记"}').phrase, undefined, '不说话也能记');
}

// ── 9i. 单包布局：桌宠就在 <插件>/pet ──
{
  const { resolveGpwRoot } = plugin;
  const fake = (...parts) => parts.join('/');
  const root = resolveGpwRoot({
    packageDir: '/x/node_modules/dsh-game-pet-watch',
    fsExists: (p) => p === fake('/x/node_modules/dsh-game-pet-watch/pet', 'runtime', 'gpw-main.cjs'),
  });
  eq(String(root).endsWith('pet'), true, '默认就用包里的 pet/（装上即用，不需要第二个仓库）');
  eq(resolveGpwRoot({ configured: 'D:/mine', packageDir: '/x', fsExists: () => true }), 'D:/mine', '配置优先');
}

// ── 9j. 表情包扩展名单一来源（扫描/入库/导出共用）──
{
  const { MEME_EXTS, memeSaveExt } = await import('../src/images.js');
  eq(MEME_EXTS.join(','), '.png,.webp,.gif,.jpg,.jpeg', '支持的扩展名清单');
  eq(memeSaveExt('gif'), 'gif', 'gif 原样存（不转 png，动画不丢）');
  eq(memeSaveExt('.GIF'), 'gif', '大小写/点号都容忍');
  eq(memeSaveExt('jpeg'), 'jpg', 'jpeg 归一成 jpg');
  eq(memeSaveExt('bmp'), 'png', '不支持的才转 png');
  eq(memeSaveExt(''), 'png', '空值也回退 png');
}

// ── 9b. 记忆三件套：短期窗口 / 压缩阈值 / 长期上限（设置页滑块就是这三个键） ──
eq(plugin.normalizeConfig({}).memoryRecentTurns, 12, '短期记忆默认 12 条');
eq(plugin.normalizeConfig({ memoryRecentTurns: 0 }).memoryRecentTurns, 0, '短期记忆 0 = 不带');
eq(plugin.normalizeConfig({ memoryRecentTurns: 999 }).memoryRecentTurns, 60, '短期记忆上界 60');
eq(plugin.normalizeConfig({ memoryRecentTurns: -5 }).memoryRecentTurns, 0, '短期记忆下界 0');
eq(plugin.normalizeConfig({ compactEvery: 999 }).compactEvery, 200, '压缩阈值上界 200');
eq(plugin.normalizeConfig({ memoryLongTermChars: 10 }).memoryLongTermChars, 200, '长期上限下界 200');
eq(plugin.normalizeConfig({ memoryLongTermChars: 999999 }).memoryLongTermChars, 20000, '长期上限上界 20000');

// ── 10. 空闲退避（纯函数，改策略会红） ──
eq(plugin.computeBackoff({}), { backoff: 1, idleSec: 0, reason: 'disabled' }, 'computeBackoff 未配置时关闭');
eq(plugin.computeBackoff({ inputIdleSec: 10, idleAfterSec: 60, maxFactor: 8 }).reason, 'active', 'computeBackoff 未到阈值');
eq(
  plugin.computeBackoff({ inputIdleSec: 200, eventIdleSec: 0, idleAfterSec: 60, idleStepSec: 30, maxFactor: 8 }),
  { backoff: 8, idleSec: 200, reason: 'input-idle' },
  'computeBackoff 键鼠空闲封顶',
);
eq(
  plugin.computeBackoff({ inputIdleSec: 0, eventIdleSec: 100, idleAfterSec: 60, idleStepSec: 30, maxFactor: 32 }),
  { backoff: 2, idleSec: 100, reason: 'no-events' },
  'computeBackoff 无事件一档',
);
eq(
  plugin.computeBackoff({ inputIdleSec: 50, eventIdleSec: 90, idleAfterSec: 60, idleStepSec: 30, maxFactor: 4 }).reason,
  'no-events',
  'computeBackoff 两个判据取更闲的那个',
);

console.log(`exports.test: ${pass} passed, ${fails.length} failed`);
for (const f of fails) console.log('  FAIL ' + f);
if (fails.length) process.exit(1);
