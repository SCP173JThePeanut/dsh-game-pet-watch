/**
 * dsh-pet desktop helper —— Electron 主进程
 *
 * 职责：为**每只桌面宠物**开一个独立的局部小窗口（透明、置顶、不可激活），
 * 窗口 = 宠物包围盒 + 四周外扩余量（renderer 的 WINDOW_MARGIN_RATIO，为气泡/弹窗预留空间），
 * 宠物移动时 renderer 逐帧上报 bounds，本进程 setContentBounds 让窗口跟随宠物。
 *
 * 为什么是「局部小窗口」而不是「全屏透明画布」：全屏透明置顶窗会触发 Windows DWM 视频合成黑屏
 * （播放中的视频画面变黑、声音继续）。触发与窗口**绝对尺寸无关**，需四项齐备：透明置顶 + 非点击穿透
 * + 可聚焦且已聚焦 + **完整盖住视频窗**（98% 覆盖即安全；一个仅占屏幕 26% 的小窗同样能触发，issue #60
 * 的单变量实测矩阵）。本进程恰好会凑齐前三项——悬停宠物即整窗翻成可交互、show() 出去的窗口本就是
 * 聚焦的——而全屏画布又把第四项白送（必然完整遮挡非全屏播放的视频），故"不做全屏画布"的结论不变，
 * 只是理由换成这套条件；现有形态靠**默认整窗穿透 + 小窗几乎不可能完整遮挡视频窗**规避。
 * （旧注释写作"窗口不全屏就不黑"，那是把 0.1.x 的「全屏画布 → 每宠小窗」与输入模型改造这两件
 * 同时发生的事，混成了一个自变量。）
 * 输入：窗口默认**整窗点击穿透**（setIgnoreMouseEvents(true,{forward:true})），渲染端在光标
 * 进/出宠物身体命中区时经 pet:set-interactive 翻转可交互——透明像素不挡下层应用，
 * 与浏览器 overlay（仅 .dsh-pet-hit 可交互）严格对齐。
 *
 * 数据通道（bridge 模式，DSH_PET_BRIDGE=1 由宿主注入）：
 * 渲染端不再直连宿主 WebServer（DSH Desktop 2.0.3+ 的浏览器访问闸门会拦无令牌裸 HTTP）——
 * 本进程注册自定义 scheme `dsh-pet-bridge://`，protocol.handle 收到渲染端请求后
 * 经 stdin/stdout JSON 行协议转发宿主（helper-process.ts 的 BridgeHandler），
 * 宿主用与 HTTP 路由同一份 handlePetRoute 应答；素材应答带文件绝对路径，本进程读盘返回。
 * 无 DSH_PET_BRIDGE（手动 start-desktop / 开发流）时保持旧路径：渲染端直接 HTTP 访问宿主。
 *
 * 进程存亡（issue #56）：本进程的 stdout/stderr 是宿主给的管道，宿主一退出读端就消失（下一次写
 * 就是 EPIPE，而 Electron 默认处理器只会弹框且不退出）。故有「宿主存活」一节：管道守卫 +
 * 宿主 PID 探测，宿主没了就自己退——见那里的注释。
 *
 * 启动模式（issue #63）：若被以「纯 Node 模式」拉起（宿主透传了 ELECTRON_RUN_AS_NODE），内置
 * electron 模块不会注册，下面的 require 会失败——报一句能定位原因的话再退出，别只留 MODULE_NOT_FOUND。
 */
let electronApi;
try {
  electronApi = require('electron');
} catch (error) {
  process.stderr.write(
    '[dsh-pet helper] 启动失败：本进程被以「纯 Node 模式」拉起（ELECTRON_RUN_AS_NODE=' +
      JSON.stringify(process.env.ELECTRON_RUN_AS_NODE ?? null) +
      '）。该变量必须在 spawn 前删除（见 src/host/helper-process.ts 的 helperSpawnEnv），' +
      '运行期再删无效，设成空串会让 Electron 直接 abort。原始错误：' +
      (error instanceof Error ? error.message.split('\n')[0] : String(error)) +
      '\n',
  );
  process.exit(3);
}
const { app, BrowserWindow, ipcMain, screen, shell, protocol } = electronApi;
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { readFileSync, writeFileSync } = require('node:fs');
const fsPromises = require('node:fs/promises');
// 点击穿透兜底通道的纯判定（不依赖 Electron 的 forward 鼠标钩子；见文件头注释）
const { decideWindowIgnore } = require('./pointer-target.js');
// 宿主存活判定（issue #56：宿主退出 → 管道断开 → 自己退，绝不弹框、绝不留僵尸）
const { HOST_POLL_MS, hostIsGone, isBrokenPipeError, parseHostPid } = require('./host-liveness.js');

// 允许无用户手势直接播放（余额动画等）
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// 显式定名：Helper 是被 `electron.exe <main.js>` 直接拉起的，Electron 取不到 app 名会回落成
// "Electron"，userData 便落到 %APPDATA%\Electron —— 那是所有这么跑的 Electron 脚本的公共目录，
// 我们的 DPI 缓存与 Chromium profile 都会和别人混在一起。必须赶在任何 getPath('userData') 之前设。
app.setName('dsh-pet-gpw-helper');

/** DPI 探测子进程模式：不建窗口，只把主屏 scaleFactor 打到 stdout 就退出（见 probePrimaryScale） */
const DPI_PROBE = process.env.DSH_PET_DPI_PROBE === '1';
/** 探测进程的输出标记（父进程按它抓值） */
const DPI_MARK = 'dsh-pet-primary-scale:';

// ---------- 宿主存活（issue #56）：管道断开 / 父进程消失 → 自己退出 ----------
//
// 【为什么必须自己退】宿主退出后，它在 helper 的 stdout/stderr 上握着的管道读端一起关闭；helper
// 下一次写（bridge 协议行 —— 渲染端每秒至少一条 /state 轮询）拿到 EPIPE。未处理的 'error'
// 事件 = 未捕获异常，而 Electron 主进程自带的处理器只弹一个模态框、**且不退出**
// （lib/browser/init.ts 原文注释："Don't quit on fatal error"）—— 桌宠就此卡死、进程赖着不走。
// 真机实测（宿主存活、只切断 stdout 管道）：那次写之后主线程彻底停住，14 秒里一次心跳都没有，
// 进程也一直没有退出。
//
// 两条路都要有，缺一不可：
//   ① 管道守卫：任何一次写失败都不许变成异常；管道断开本身就是"宿主已死"的铁证 → 立刻退。
//      它只在**上层真的写**的时候才触发；
//   ② 宿主探测：每 HOST_POLL_MS 用 kill(pid, 0) 问一次宿主还在不在，ESRCH 即退。
//      渲染端崩了/根本没起来时一次写都不会发生，只有 ② 能收敛。
// 两条路都只经 exitForDeadHost()，且只退一次。
let hostGone = false;
/** 宿主没了 → 立刻退出。这里**不能**再打日志：管道已经断了，写只会再踩一次同一个错误 */
function exitForDeadHost() {
  if (hostGone) return;
  hostGone = true;
  app.exit(0); // 宿主消失是"环境要求我退"，不是自身崩溃，退出码 0
}

// ① 管道守卫：必须赶在**任何一次写**之前装上（probePrimaryScale 失败就会往 stderr 写）
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (error) => {
    if (isBrokenPipeError(error)) exitForDeadHost();
    // 其余流错误同样吞掉：Electron 的默认处理是弹模态框，任何流错误都不值得拿桌宠去换一个框
  });
}

// ② 宿主探测：DSH_PET_HOST_PID 由宿主 spawn 时注入；未注入/非法 → parseHostPid 给 0 → 不探测（不误退）。
// DPI 探测实例是一次性短命进程（它的父进程是 helper 而不是宿主），不参与这套机制。
const HOST_PID = parseHostPid(process.env.DSH_PET_HOST_PID);
if (!DPI_PROBE && HOST_PID > 0) {
  setInterval(() => {
    if (hostIsGone(HOST_PID)) exitForDeadHost();
  }, HOST_POLL_MS).unref?.();
}

// Windows 透明分层窗口（WS_EX_LAYERED）在 DWM 硬件加速合成下存在多处缺陷：
//   - 拖拽移动时窗口四周出现黑色边框（#37）
//   - 大透明窗移动覆盖小透明窗时，被覆盖窗口内容丢失（显示"消失"）
// 本进程只渲染轻量宠物动画（640×360），改走软件合成以规避上述缺陷，
// 不影响浏览器形态与主 DSH（独立进程）；非 Windows（macOS/Linux）合成路径不同，保留硬件加速。
if (process.platform === 'win32') {
  app.disableHardwareAcceleration();
}

// ---------- 全局 DPI 线性化（多显示器异构缩放的根因修复） ----------
//
// Windows 上 Chromium 的 DIP↔物理 换算是**逐显示器**的仿射变换，而且
// ScreenWin::DIPToScreenRect(hwnd, rect) 用的是「hwnd 当前归属屏」的那一组参数：
//   physical = (dip − D.dipOrigin) × D.scale + D.pixelOrigin
// 归属由 MonitorFromWindow(MONITOR_DEFAULTTONEAREST) 按面积占比决定，窗口骑缝时会反复翻转。
// 两屏缩放不同时，同一个 DIP 值在翻转前后落到不同物理位置、算出不同物理尺寸
// （实测 1.5/1.75 双屏：位置差 110px、924 DIP 宽的窗口尺寸差 231px），
// 于是 setContentBounds 每帧的落点在两套坐标系之间横跳 —— 这就是拖过屏缝时的「分身闪烁」，
// 也是两屏缩放一致时同样骑缝却毫无问题的原因。
//
// --force-device-scale-factor 让 Chromium 的 GetMonitorScaleFactors() 对所有显示器
// 直接返回同一个值，全部屏塌缩成**同一个**仿射变换 ⇒ DIPToScreenRect 的结果与窗口归属无关。
//
// 取值必须是 **1**，不能取主屏的 scaleFactor。实测（tools/probe-dpi.cjs，1.5 + 1.75 双屏）：
//   forced=1.5 → display.bounds 被二次缩放（主屏物理 3840 宽报成 1706 = 3840/1.5/1.5，
//                而同一块屏的 workArea 报 2560 = 3840/1.5，两者自相矛盾）。
//                DIPToScreenPoint 用 bounds.origin() 当 dipOrigin，于是
//                pixelOrigin(3840) ≠ dipOrigin(1706)×1.5，副屏多出 1281px 的**恒定**偏移——
//                比不加 switch 时的 75px 还糟。
//   forced=1   → bounds 与 workArea 一致，每块屏都满足 pixelOrigin == dipOrigin×scale，
//                DIP 与物理像素成为恒等映射，探针的 DELTA 全 0（尺寸差 231×151 也一并归零）。
// 所以这里锁死 1：坐标系 = Windows 物理像素，跨屏几何再无换算与舍入。
//
// 代价：宠物尺寸的单位从 DIP 变成物理像素，不补偿的话在 150% 的屏上会小 1/1.5。
// 用探测到的**真实主屏 scaleFactor** 乘进渲染端的 CONFIG.scale 抵掉（见 petScale()）——
// 主屏上的观感与修复前逐像素相同；其余屏改按主屏缩放渲染宠物（同尺寸同分辨率的两块屏上
// 物理大小反而一致了）。探测失败就整个不启用，退回修复前行为，不做没有补偿的缩放。
//
// 环境变量 DSH_PET_FORCE_DSF：'0' = 关闭本机制；其它正数 = 强制该值（排障用，会踩上面的 bug）。
//
// 取值时机是个麻烦：switch 必须在 app ready 之前设，而那时 screen 模块还不可用。
// 所以首次启动 spawn 一个自己的探测子进程（DSH_PET_DPI_PROBE=1，只打印 scaleFactor 就退出，
// ~0.5s）并把结果落盘；之后每次启动直接读缓存，零开销。

/** 主屏缩放缓存文件（userData 在 ready 前即可用） */
function dpiCacheFile() {
  return path.join(app.getPath('userData'), 'primary-scale.json');
}

function readCachedPrimaryScale() {
  try {
    const v = Number(JSON.parse(readFileSync(dpiCacheFile(), 'utf8')).scaleFactor);
    return Number.isFinite(v) && v > 0 ? v : 0;
  } catch {
    return 0; // 首次启动/文件损坏：当作无缓存，重新探测
  }
}

function writeCachedPrimaryScale(value) {
  try {
    writeFileSync(dpiCacheFile(), JSON.stringify({ scaleFactor: value }), 'utf8');
  } catch (e) {
    console.error('[dsh-pet-desktop-helper] write dpi cache failed:', String(e && e.message ? e.message : e));
  }
}

/** 从探测子进程的输出里抓 scaleFactor（0 = 没抓到） */
function parseProbeOutput(text) {
  const m = new RegExp(DPI_MARK + '([0-9.]+)').exec(String(text || ''));
  const v = m ? Number(m[1]) : 0;
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/** 拉起探测子进程读主屏 scaleFactor（同一个 electron + 同一个 main.js，走 DPI_PROBE 分支） */
function probePrimaryScale() {
  const opts = {
    env: { ...process.env, DSH_PET_DPI_PROBE: '1', DSH_PET_BRIDGE: '0', DSH_PET_SMOKE: '0' },
    timeout: 20000,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  };
  let out = '';
  try {
    out = execFileSync(process.execPath, [__filename, '--dsh-pet-dpi-probe'], opts);
  } catch (e) {
    // 只认 stdout，不认退出码：一个不开窗口的 Electron 进程调 app.exit() 在 Windows 上
    // 偶发 0xC0000005（退出期访问违例），但那时值早就写出来了，丢掉它纯属浪费一次冷启动。
    out = e && e.stdout ? String(e.stdout) : '';
    if (!parseProbeOutput(out)) {
      const detail = [
        e && e.status !== undefined ? 'status=' + e.status : '',
        e && e.stderr ? 'stderr=' + String(e.stderr).trim().slice(0, 300) : '',
      ]
        .filter(Boolean)
        .join(' ');
      console.error(
        '[dsh-pet-desktop-helper] dpi probe failed:',
        String(e && e.message ? e.message : e).split('\n')[0],
        detail,
      );
      return 0; // 探测失败：不加 switch，退回修复前行为（多屏异构 DPI 会闪，但不影响可用性）
    }
  }
  const v = parseProbeOutput(out);
  if (v > 0) writeCachedPrimaryScale(v);
  return v;
}

/** 真实主屏 scaleFactor（探测所得；0 = 未知）。开启线性化后 screen API 只会报 1，只能靠它。 */
let PRIMARY_SCALE = 0;
/** 实际生效的强制缩放（0 = 未启用，坐标系维持修复前的逐屏 DIP） */
let FORCED_SCALE = 0;
if (!DPI_PROBE && process.env.DSH_PET_FORCE_DSF !== '0') {
  PRIMARY_SCALE = readCachedPrimaryScale() || probePrimaryScale();
  const override = Number(process.env.DSH_PET_FORCE_DSF);
  const forced = Number.isFinite(override) && override > 0 ? override : PRIMARY_SCALE > 0 ? 1 : 0;
  if (forced > 0) {
    app.commandLine.appendSwitch('force-device-scale-factor', String(forced));
    FORCED_SCALE = forced;
  }
}

/**
 * 渲染端的 CONFIG.scale：宿主给的基准 × 物理像素补偿。
 * 线性化开启后 1 逻辑像素 = 1 物理像素，宠物按主屏缩放放大回原来的观感。
 */
function petScale() {
  const base = Number(process.env.DSH_PET_SCALE || '1') || 1;
  return FORCED_SCALE > 0 && PRIMARY_SCALE > 0 ? base * (PRIMARY_SCALE / FORCED_SCALE) : base;
}

/** bridge 模式：DSH_PET_BRIDGE=1（宿主注入）。开启时注册 dsh-pet-bridge scheme + 管道转发 */
const BRIDGE = process.env.DSH_PET_BRIDGE === '1';
/** 协议行前缀（与 helper-process.ts 的 BRIDGE_PREFIX 一致） */
const BRIDGE_PREFIX = 'dsh-pet-bridge:';

if (BRIDGE) {
  // 自定义 scheme：standard（可解析 URL）+ secure（按 https 对待）+ supportFetchAPI（fetch 可用）
  // + stream（视频流）+ corsEnabled（让 CORS 规则生效，配合响应里的 ACAO 头放行 file:// 源页面）
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'dsh-pet-bridge',
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        bypassCSP: true,
        corsEnabled: true,
      },
    },
  ]);
}

/** 窗口表：petId -> BrowserWindow */
const windows = new Map();

/** win.id -> 上一次**请求**的内容区矩形（"x,y,w,h"）：pet:set-bounds 的去重基准，见那里的注释 */
const lastRequestedBounds = new Map();

/**
 * 宠物间碰撞 broker 状态：petId -> { x, y, vx, vy, size, bottomPad }。
 * 来源：pet:set-bounds（位置+尺寸+速度，随漫游/拖拽/静止保真上报，每帧一次）+
 *       pet:report-flight（飞行中每 ~30ms 高频补充速度）。
 * 任何更新都广播全量给所有窗口——每窗飞行方用它做跨窗碰撞检测（滞后 ≤ 1 帧，可接受）。
 */
const petStates = new Map();

/** 把当前全量宠物状态广播给所有窗口（碰撞检测的共享站场） */
/**
 * **把站场快照落盘**（自证用 ✓ 只读观测 ✓ 不改行为 ✓）
 * 写 `~/.dsh/dsh-pet-gpw[-<profile>]/collide-state.json` ✓ → 外部 curl/cat 就能看到
 * "站场里到底有谁、坐标多少" ✓ —— 这是判断"对家有没有进去"的唯一可靠依据 ✓。
 */
let lastStateDump = 0;
function dumpPetStates() {
  const now = Date.now();
  if (now - lastStateDump < 500) return;
  lastStateDump = now;
  try {
    const fs = require('node:fs');
    const path = require('node:path');
    const root = process.env.GPW_USER_ROOT || require('node:path').join(require('node:os').homedir(), '.dsh', 'dsh-pet-gpw');
    const out = {};
    for (const [pid, st] of petStates) out[pid] = { x: st.x, y: st.y, vx: st.vx, vy: st.vy, size: st.size, bottomPad: st.bottomPad };
    fs.writeFileSync(path.join(root, 'collide-state.json'), JSON.stringify({ at: now, states: out }, null, 2), 'utf8');
  } catch {
    /* 观测失败不影响运行 ✓ */
  }
}

/**
 * 把自己的**真实 body 盒**报给插件 `/rects`（跨进程碰撞判定的数据源）。
 *
 * 只能用渲染端上报的 `boxX/boxY/size`：它们与渲染端 `collidePet` 是同一套（物理像素）坐标。
 * 主进程侧用 `win.getBounds()` 算出来的是 DIP，本机差 1.5 倍 → 对家的盒子永远对不上 → 撞不着。
 * 80ms 节流，失败静默，不改任何行为（宠物物理完全不受影响）。
 */
let lastRectPostAt = 0;
/** fishId -> { rect, at }：静止时靠它续命，见下面的心跳 */
const lastRectByPet = new Map();

/**
 * 插件账本给这条鱼归一化后的 id（`POST /rects` 的响应带回来）。
 *
 * 为什么要它：env 里的 `GPW_FISH_ID` 不一定等于账本 id —— 实测 7341 那只的 env 是 `gpw`，
 * 而插件按端口归一成鱼表里的 `legacy`。不校正的话，`gpw-main` 注入对家时会把自己也注进去
 * （站场里出现一个跟自己同坐标的影子，飞行时会被它"撞"一下）。
 */
let selfRectId = '';
module.exports.getSelfRectId = () => selfRectId;

/**
 * **公共登记簿**：`~/.dsh/fish-board/registry.json`（插件写，任何副本都能读）。
 *
 * 里面同时有 `pluginOrigin`（插件自己的地址）和鱼表，是"要回连的地址"的**唯一公共来源**。
 * 以前这里是 `process.env.GPW_PLUGIN_ORIGIN || 'http://127.0.0.1:19387'`：env 是启动时快照、
 * 19387 更是写死的常量 —— DSH 换端口（19387 → 60010 → …）之后副本就把 `/rects` 发进空气里，
 * 而且必须重启副本才能恢复。现在**登记簿优先、env 兜底**，2 秒缓存 + 上报失败即失效，
 * 所以换端口后最迟几秒就自己跟上了，不用重启。
 */
const ORIGIN_CACHE_MS = 2000;
let originCache = { at: 0, value: '' };

function registryFile() {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim()
    ? process.env.DSH_HOME.trim()
    : require('node:path').join(require('node:os').homedir(), '.dsh');
  return require('node:path').join(home, 'fish-board', 'registry.json');
}

function registryOrigin() {
  try {
    const doc = JSON.parse(require('node:fs').readFileSync(registryFile(), 'utf8'));
    const origin = String(doc?.pluginOrigin ?? '').replace(/\/+$/, '');
    return /^https?:\/\//.test(origin) ? origin : '';
  } catch {
    return '';
  }
}

/** 本进程回连插件用的地址（登记簿 → env → 老默认值）；给 `/gpw/brand` 自报用的也是它 */
function pluginOriginNow() {
  const now = Date.now();
  if (now - originCache.at < ORIGIN_CACHE_MS && originCache.value) return originCache.value;
  const value =
    registryOrigin() ||
    String(process.env.GPW_PLUGIN_ORIGIN || '').replace(/\/+$/, '') ||
    'http://127.0.0.1:19387';
  originCache = { at: now, value };
  return value;
}
module.exports.pluginOriginNow = pluginOriginNow;

function postRect(fishId, rect) {
  const origin = pluginOriginNow();
  void fetch(origin + '/game-pet-watch/rects', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fishId, port: Number(process.env.GPW_PORT) || 0, rect }),
    signal: AbortSignal.timeout(1500),
  })
    .then((res) => res.json())
    .then((body) => {
      if (body && body.id) selfRectId = String(body.id);
    })
    .catch(() => {
      // 发不出去 → 下一条立刻重新读登记簿（插件可能刚换了端口）
      originCache = { at: 0, value: '' };
    });
}

/** `HIT_BOX`（与渲染端 `shared-core.js` 同源）：640×360 设计盒里"真有身体"的那一块 */
const HIT_BOX = { x0: 200, y0: 50, x1: 440, y1: 335, refW: 640, refH: 360 };

/** 由整张 sprite 盒推出**真身盒**（物理像素）：插件判定用它，和渲染端 collidePet 一致 */
function bodyRectOf(boxX, boxY, size, bottomPad) {
  const h = (size * 9) / 16;
  return {
    x: Math.round(boxX + (HIT_BOX.x0 / HIT_BOX.refW) * size),
    y: Math.round(boxY + bottomPad + (HIT_BOX.y0 / HIT_BOX.refH) * h),
    w: Math.round(((HIT_BOX.x1 - HIT_BOX.x0) / HIT_BOX.refW) * size),
    h: Math.round(((HIT_BOX.y1 - HIT_BOX.y0) / HIT_BOX.refH) * h),
  };
}

function reportOwnRect(petId, bounds) {
  const x = Number(bounds?.boxX);
  const y = Number(bounds?.boxY);
  const size = Number(bounds?.size);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !(size > 0)) return;
  const fishId = String(process.env.GPW_FISH_ID || petId);
  const bottomPad = Number(bounds?.bottomPad) || 0;
  const body = bodyRectOf(x, y, size, bottomPad);
  const rect = {
    x,
    y,
    w: size,
    h: Math.round((size * 9) / 16),
    /** 真身盒（见 bodyRectOf）；老插件不认识这几个字段，忽略即可 */
    bodyX: body.x,
    bodyY: body.y,
    bodyW: body.w,
    bodyH: body.h,
    vx: Number(bounds?.vx) || 0,
    vy: Number(bounds?.vy) || 0,
    bottomPad: Number(bounds?.bottomPad) || 0,
  };
  lastRectByPet.set(fishId, { rect, at: Date.now() });
  const now = Date.now();
  if (now - lastRectPostAt < 80) return;
  lastRectPostAt = now;
  postRect(fishId, rect);
}

/** 静止多久之后认为"上报里的速度已经过期"（毫秒） */
const RECT_VELOCITY_TTL_MS = 250;

/**
 * 心跳：`pet:set-bounds` 只在移动时触发，宠物静止时插件那边 5 秒就判"掉线"
 * （对家的重叠判定和历史台词都会看不到它）。这里每 900ms 把**最近一次真身盒**重发一遍，
 * 坐标仍是渲染端的值，没有任何换算。
 *
 * 速度要**按时间作废**：渲染端落定后不再上报，最后一次飞行速度（实测 59px/s）会被当成
 * "还在飞"永远留在账本里 —— 插件那边的速度闸就永远放行（静止叠着也判碰撞），
 * 对家注入的速度也是错的（vrel 算反，真撞上反而不触发）。过期一律按 0 发。
 */
setInterval(() => {
  const now = Date.now();
  for (const [fishId, entry] of lastRectByPet) {
    const stale = now - entry.at > RECT_VELOCITY_TTL_MS;
    postRect(fishId, stale ? { ...entry.rect, vx: 0, vy: 0 } : entry.rect);
  }
}, 900).unref?.();

function broadcastPetStates() {
  dumpPetStates();
  const states = {};
  for (const [pid, s] of petStates) {
    states[pid] = { x: s.x, y: s.y, vx: s.vx, vy: s.vy, size: s.size, bottomPad: s.bottomPad };
  }
  for (const win of windows.values()) {
    if (!win.isDestroyed()) win.webContents.send('pet:flight-states', states);
  }
}

/** 记录/更新一只宠物的状态并广播 */
function updatePetState(petId, partial) {
  const prev = petStates.get(petId) || { x: 0, y: 0, vx: 0, vy: 0, size: 0, bottomPad: 0 };
  petStates.set(petId, Object.assign({}, prev, partial));
  broadcastPetStates();
}

/**
 * 每窗口当前穿透状态（true = 整窗点击穿透）。所有 setIgnoreMouseEvents 只经本文件
 * （创建时初始化 + pet:set-interactive 翻转 + 光标兜底轮询），这里镜像真实状态，供冒烟断言/排查使用
 * （Electron 无 isIgnoringMouseEvents 取值 API）。
 */
const windowIgnore = new Map();

/** 翻转整窗穿透的**唯一出口**：状态与 windowIgnore 镜像永远一起更新（穿透期间保留 forward） */
/**
 * 【副本改动】渲染端上报的"额外可交互区域"（屏幕坐标，DIP）。
 *
 * 为什么要这个：原版 decideWindowIgnore 只认**宠物身体**命中区。副本在宠物旁边多画了
 * 悬停输入框、状态胶囊（含 📌 交互锁定按钮），它们落在"窗口余量区"——那里的规则是
 * "保持当前状态"。于是只要中断发生在没跨过身体边界的时候（菜单刚关、光标停在原地、
 * 拖拽残留 pointer capture 导致 onMouseMove 不再触发），窗口就会停在"穿透"那一侧：
 * 输入框、图钉、菜单全部点不动；而**右键是唯一无条件强制可交互的路径**，所以只有右键能救回来
 * —— 这正是用户报的"菜单有时候交互失效，右键 pet 才能重新交互"。
 *
 * 现在渲染端把这些区域按屏幕坐标报上来，兜底判定把它们也算作"宠物身上"，
 * 就不再依赖"必须跨过身体边界"这个脆弱前提。
 */
let extraHitRegions = [];
/**
 * 浮层就地坐标（**窗口内 CSS px**）上报的可交互控件矩形。
 *
 * ⚠️ 必须声明在**模块层**：它被 60ms 的兜底轮询读取，而 ipcMain 那几行注册在 createPetWindows 里。
 * 这一版我曾把它声明在函数内部，结果兜底轮询每次抛 `localHitRects is not defined`，
 * 整个穿透翻转静默停摆 —— 表现就是"交互偶尔失效、只有右键能救"。
 */
let localHitRects = [];

function setWindowIgnore(win, ignore) {
  // 【副本追加】镜像到 global，供 bootstrap 的排障探测读取（它是 setIgnoreMouseEvents 的唯一出口）
  global.__gwIgnoreMirror = windowIgnore;
  global.__gwExtraRegions = extraHitRegions;
  win.setIgnoreMouseEvents(ignore, { forward: true });
  windowIgnore.set(win.id, ignore);
}

/** 兜底通道的光标轮询间隔（ms，与 issue #55 报告者实测值一致） */
const POINTER_POLL_MS = 60;
/** 冒烟期间暂停兜底轮询：它按**真实光标**翻转 windowIgnore，会干扰冒烟对渲染端通道的断言 */
let pointerFallbackPaused = false;

/**
 * 每窗口「渲染端正拿着鼠标输入」标记（win.id → true/false），由渲染端经 `pet:input-busy` 上报。
 *
 * 为什么必须由渲染端说了算：兜底通道判定的是"光标与**窗口矩形**"的关系，而窗口矩形比宠物身体大
 * 一圈（四周各半只宠物的余量）。拖拽时宠物由 rAF 弹簧追赶光标、**滞后**于光标；甩得快时滞后量
 * 超过那一圈余量，光标就落在矩形外 → 判成"窗外" → 翻回穿透 → 渲染端正在拖拽的 window 级
 * pointermove/pointerup 全断（鼠标还按着，宠物却按旧速度"飞"出去，连松手都没人报）。
 *
 * 主进程**无法自行判断**这件事（光看光标位置和窗口位移分不清"拖拽跟手"与"漫游/抛掷"），
 * 而渲染端知道（拖拽中 / 菜单开着 / 对话弹窗开着）。所以只由它上报，busy 期间本进程绝不翻回穿透。
 */
const inputBusy = new Map();

/**
 * 桌面宠物列表（[{id,size}]）：宿主经 DSH_PET_PETS 透传（每只宠物一个窗口）。
 * 解析失败/未透传（手动 start-desktop）时回落到单个默认宠物窗口；renderer 首帧发来的
 * set-bounds 会按真实配置自校正尺寸与位置。
 */
function petsFromEnv() {
  try {
    const raw = process.env.DSH_PET_PETS || '';
    const arr = JSON.parse(raw);
    if (Array.isArray(arr) && arr.length > 0) {
      return arr.map((p, i) => ({
        id: String(p?.id ?? `pet-${i}`),
        size: Number(p?.size) > 0 ? Number(p.size) : 462,
        index: i,
      }));
    }
  } catch {
    /* fallthrough */
  }
  return [{ id: 'main', size: 462, index: 0 }];
}

/** 窗口初始尺寸 = 宠物包围盒 + 四周外扩余量（4×0.5×size，与 renderer 的 WINDOW_MARGIN_RATIO 一致；
 *  renderer 首帧 set-bounds 会按真实配置精确覆盖，这里只是避免启动瞬间的尺寸跳变）。 */
function petWindowSize(size) {
  const height = (size * 9) / 16;
  const bottomPad = (size * (9 / 16) * (360 - 330)) / 360;
  const m = Math.round(size * 0.5);
  return { width: Math.round(size) + m * 2, height: Math.round(height + bottomPad) + m * 2 };
}

/**
 * 桌面几何：**逐显示器的工作区列表** + 它们的外接矩形 + 主屏下标。
 *
 * 外接矩形（hull）仍然是渲染端视口 VIEW 的来源——它只用作坐标系原点与比例换算基准。
 * 但所有边界判定（漫游落点 / 抛掷反弹 / 角落定位 / 菜单夹取）必须走 areas 的**并集**：
 * 显示器摆放不规则时 hull 里会有大片不属于任何屏的空洞，以 hull 为边界会把宠物放进去
 * （实测右倒 T 型双屏：hull 的 23.7% 是空洞，宠物飞进去就彻底看不见了）。
 */
function deskGeometry() {
  const displays = screen.getAllDisplays();
  const areas = displays.map((d) => ({
    x: d.workArea.x,
    y: d.workArea.y,
    width: d.workArea.width,
    height: d.workArea.height,
  }));
  // 每块屏的**完整面板**（含任务栏区）：抛掷的「越界侧有没有邻屏」探测用它，否则任务栏
  // 在接缝处挖出的工作区条带会被当成墙，宠物穿不过上下叠放的屏（见 shared/physics.ts）
  const panels = displays.map((d) => ({
    x: d.bounds.x,
    y: d.bounds.y,
    width: d.bounds.width,
    height: d.bounds.height,
  }));
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const a of areas) {
    x0 = Math.min(x0, a.x);
    y0 = Math.min(y0, a.y);
    x1 = Math.max(x1, a.x + a.width);
    y1 = Math.max(y1, a.y + a.height);
  }
  const primaryId = screen.getPrimaryDisplay().id;
  const primaryIndex = Math.max(
    0,
    displays.findIndex((d) => d.id === primaryId),
  );
  return { hull: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, areas, panels, primaryIndex };
}

function createPetWindows() {
  const geo = deskGeometry();
  const area = geo.hull;
  const configUrl = process.env.DSH_PET_CONFIG_URL || 'http://127.0.0.1:3080/dsh-pet-7340/config';
  const pets = petsFromEnv();
  const scale = petScale();
  for (const pet of pets) {
    // 初始窗口尺寸也要吃缩放补偿，否则启动瞬间会有一次可见的尺寸跳变
    const { width, height } = petWindowSize(pet.size * scale);
    const win = new BrowserWindow({
      width,
      height,
      x: area.x, // 初始左上角；renderer 首帧按配置角落/位置校正
      y: area.y,
      show: false,
      useContentSize: true,
      transparent: true,
      frame: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      hasShadow: false,
      // 可聚焦：对话输入框/菜单需要窗口焦点才能打字（focusable:false 会让输入框永远无法聚焦）。
      // 别把这里当成黑屏的无关项：可聚焦 + 已聚焦本身就是 DWM 视频黑屏的四项触发条件之一（见文件头），
      // 而 show() 出来就是聚焦状态——真正在挡的是「默认整窗穿透」+「小窗几乎不可能完整遮挡视频窗」
      focusable: true,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        paintWhenInitiallyHidden: false,
        spellcheck: false,
      },
    });
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    // 窗口被其他窗口（另一只宠物）完全遮挡时，Chromium 默认会暂停本窗口渲染，
    // 导致大宠物移动盖过小宠物时小宠物显示为"消失"。关闭后台节流，让被遮挡
    // 窗口持续渲染，移开遮挡后立刻恢复显示。
    win.webContents.setBackgroundThrottling(false);
    // 屏蔽 Electron 默认右键菜单：右键菜单由渲染端统一自绘组件弹出（两端一致），绝无双菜单
    win.webContents.on('context-menu', (event) => event.preventDefault());
    // 页面级缩放 = petScale()（渲染端 CONFIG.scale 的同一来源）：整窗内容统一放大，渲染端坐标系
    // 回到 CSS 像素——右键菜单/积分弹窗/聊天框等固定 px UI 随之恢复 DIP 观感，不再逐处补偿
    // （见 DESIGN.md §3.5；跨进程交换仍走物理像素，由渲染端 toScreen/toLocal 收口）。
    // webPreferences.zoomFactor 对 show:false 的窗口不生效（实测），须在加载完成后设置。
    win.webContents.on('did-finish-load', () => {
      win.webContents.setZoomFactor(scale);
    });
    // 默认整窗点击穿透（renderer 在光标进/出身体命中区时经 IPC 翻转可交互）；
    // forward:true 保证穿透期间 mousemove 仍转发进渲染端做命中判定。
    setWindowIgnore(win, true);
    win.once('ready-to-show', () => win.show());
    // [#55 兜底显示] paintWhenInitiallyHidden:false 时渲染器可能不产出首帧，ready-to-show 便永不触发
    // （Electron 文档原文：ready-to-show "will never fire if you use paintWhenInitiallyHidden: false"），
    // 而 show() 只挂在它上面 → 窗口永远隐藏（进程活着、宠物逻辑照跑，桌面上什么都没有）。
    // 页面加载完成后强制兜底一次；zoomFactor 的设置在更早注册的 did-finish-load 里，顺序不受影响。
    win.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        if (!win.isDestroyed() && !win.isVisible()) win.show();
      }, 400);
    });
    // [#55 兜底交互] 上面的翻转链路只有「Electron forward 鼠标钩子 → 渲染端命中判定」一个入口，
    // 该钩子在 Windows 上可能静默失效（回调超时被系统摘掉 / 被别的软件钩子干扰）→ 光标悬浮无反应、
    // 拖不动、点击与右键全废。这里由主进程按**真实光标位置**独立判定，不依赖那条转发链路：
    // 与 renderer 那条通道并存且判定区域一致（状态未变不翻转），转发正常的环境行为完全不变。
    //
    // 唯一不可自行决定的事：**渲染端正拿着鼠标输入时不得翻回穿透**（见 inputBusy）。
    // 本进程无从判断这件事——光看光标位置与窗口位移分不清"拖拽跟手"和"漫游/抛掷"，所以由渲染端上报。
    const pointerTimer = setInterval(() => {
      // ⚠️ 整个循环体包一层 try/catch，并把异常打出来。
      // 教训：这一版里我曾经引用了**没有定义**的 `st`，于是这个 60ms 定时器每次都抛
      // ReferenceError 并静默中断 —— 兜底穿透判定等于完全没在跑，窗口永久停在初始的"穿透"状态，
      // 输入框/图钉/菜单全部点不动，只有右键（走渲染端那条无条件强制可交互的路径）能救回来。
      // 一个"看不见的异常"就这样伪装成了"交互偶尔失效"的灵异 bug。
      try {
      if (pointerFallbackPaused || win.isDestroyed()) return;
      const b = win.getBounds();
      if (b.width < 8 || b.height < 8) return; // 尺寸还没落定（renderer 首帧上报前）
      const ignoring = windowIgnore.get(win.id) !== false;
      const petId = [...windows.keys()].find((id) => windows.get(id) === win);
      const st = petId ? petStates.get(petId) : undefined;
      global.__gwPetStatesDump = st ? { x: st.x, y: st.y, size: st.size, stageX: st.stageX, stageY: st.stageY } : null;
      /**
       * 【副本改动 · 关键】坐标空间必须与判定矩形一致。
       *
       * 实测事实（本机）：
       *   getBounds()            = 1386x1115 @1497,768   （DIP）
       *   页面视口 innerWidth/H   = 924x743              （= 1386 ÷ 1.5）
       *   渲染端上报的 boxX/boxY  = 1229,743             （乘过 scale；1229+160 = 1389 ≈ 窗口 x）
       * 也就是说渲染端上报的命中矩形与窗口矩形在**同一套（已乘 scale）坐标系**里，
       * 而 getCursorScreenPoint() 给的是**未乘 scale 的 DIP**。
       * 原版直接拿 DIP 光标去比那套矩形 → 光标明明在宠物身上，判定却算出"不在窗口内"
       * → 翻回穿透 → 宠物/输入框/图钉全都点不动（用户报的正是这个）。
       *
       * 这里把光标按**显示器的缩放系数**换算到同一空间（scaleFactor 是全局比例，不依赖窗口尺寸）。
       */
      const raw = screen.getCursorScreenPoint();
      /**
       * ⚠️ 坐标：**不要做任何换算**。
       *
       * 我先后试过两种"修复"（乘 screen.scaleFactor、乘页面 devicePixelRatio），**都是错的**。
       * 实测证据（%TEMP%\gpw-pointer.log）把话说死了：
       *   raw 光标 = 2266,1361（GetCursorPos 确认过）
       *   宠物框   = 1997,1200 sz540    → 2266 正好落在框内
       *   窗口     = 1727,930 1080x869  → 2266 也在窗口内
       * 也就是 `getCursorScreenPoint()` 与**渲染端上报的宠物框**本来就在同一套坐标里；
       * 乘 1.5 会把它推到 3399 → 跑出窗口 → 永远判"在宠物外" → 穿透 → 宠物点不动。
       *
       * 真正坏掉的从来不是坐标，而是**这条兜底轮询本身在抛异常**
       * （`localHitRects is not defined`，见文件里那处 try/catch 的注释）——
       * 异常被静默吃掉，等于这条通道根本没在跑，窗口就永久停在"穿透"那一侧。
       */
      const point = raw;
      global.__gwPointDump = { raw, scale: 1 };
      let next = decideWindowIgnore(b, point, ignoring, inputBusy.get(win.id) === true);
      /**
       * 【副本改动】唯一保留的补充：渲染端最近说过"要可交互"就维持一小段宽限。
       *
       * 为什么需要：原版只在"光标跨过宠物身体边界"时才翻转。而副本在宠物旁边多画了
       * 悬停输入框与状态胶囊（含 📌 按钮），光标从宠物移到这些控件上时**不跨身体边界**，
       * 那一刻若正好翻回穿透，输入框就点不动了（用户报过这个）。
       * 渲染端那边已经把"宠物 ∪ 可见控件"作为悬停判定目标，落在控件上时会持续上报这个脉冲；
       * 这里按时间维持，不依赖任何坐标换算 —— 本机的坐标换算实测不可靠（见上文注释），
       * 所以凡是"按矩形猜位置"的兜底都删掉了，只留这条不带坐标的信号。
       */
      const GRACE_MS = 1500;
      if (next === true && Date.now() - (global.__gwInteractiveAt || 0) < GRACE_MS) next = false;
      if (next !== ignoring) setWindowIgnore(win, next);
      /**
       * 【副本改动】穿透判定的滚动日志（默认开，写 %TEMP%\gpw-pointer.log，只留最近 200 行）。
       *
       * 为什么常开：用户报的"宠物附近点不了"必须在**悬停的那一刻**看读数才能定论，
       * 而我不能远程操纵真实鼠标。有了这份日志，让用户把鼠标停在宠物上几秒，
       * 我就能看到"光标坐标 / 判定矩形 / 最终是否穿透"，不用再猜。
       * 代价：每 60ms 一行，可忽略；不需要时设 GPW_POINTER_LOG=0。
       */
      if (process.env.GPW_POINTER_LOG !== '0') {
        const NL = String.fromCharCode(10);
        const line =
          new Date().toISOString().slice(11, 23) +
          ' cursor=' + Math.round(point.x) + ',' + Math.round(point.y) +
          ' raw=' + Math.round(raw.x) + ',' + Math.round(raw.y) +
          ' scale=' + scale +
          ' win=' + b.x + ',' + b.y + ' ' + b.width + 'x' + b.height +
          ' pet=' + (st && st.size > 0 ? Math.round(st.x) + ',' + Math.round(st.y) + ' sz' + Math.round(st.size) : 'none') +
          ' decide=' + (next === true ? 'PASS' : 'HIT') +
          ' ignoring=' + (windowIgnore.get(win.id) !== false) +
          ' busy=' + (inputBusy.get(win.id) === true) +
          NL;
        try {
          const fsLog = require('node:fs');
          const logPath = require('node:path').join(require('node:os').tmpdir(), 'gpw-pointer.log');
          fsLog.appendFileSync(logPath, line);
          if (fsLog.statSync(logPath).size > 60000) {
            const keep = fsLog.readFileSync(logPath, 'utf8').split(NL).slice(-200).join(NL);
            fsLog.writeFileSync(logPath, keep);
          }
        } catch {
          /* 日志失败不影响判定 */
        }
      }
      } catch (error) {
        // 兜底判定自己出错时**绝不静默**：否则它会让整个穿透翻转停摆，表现成"交互偶尔失效"
        global.__gwFallbackError = String(error && error.stack ? error.stack : error);
        if (!global.__gwFallbackLogged) {
          global.__gwFallbackLogged = true;
          require('node:fs').appendFileSync(
            require('node:path').join(require('node:os').tmpdir(), 'gpw-fallback-error.log'),
            new Date().toISOString() + ' ' + global.__gwFallbackError + '\n',
          );
        }
      }
    }, POINTER_POLL_MS);
    win.on('closed', () => {
      clearInterval(pointerTimer);
      windows.delete(pet.id);
      lastRequestedBounds.delete(win.id);
      windowIgnore.delete(win.id);
      inputBusy.delete(win.id);
    });
    win
      .loadFile('electron-helper-copy/index-gpw.html', {
        query: {
          configUrl,
          plugin: pluginOriginNow(),
          port: process.env.GPW_PORT || '7341',
          bridge: BRIDGE ? '1' : '0',
          scale: String(scale),
          petIndex: String(pet.index),
          workAreaW: String(area.width),
          workAreaH: String(area.height),
          workAreaX: String(area.x),
          workAreaY: String(area.y),
          // 逐屏工作区（屏幕坐标）+ 主屏下标：渲染端所有边界判定走它们的并集，不走外接矩形。
          // 首帧就要用（position() 定角落），所以走 query；运行期变化再经 pet:displays 推送。
          areas: JSON.stringify(geo.areas),
          // 逐屏完整面板（含任务栏区）：抛掷越界侧探测用（任务栏条带不当墙，见 shared/physics.ts）
          panels: JSON.stringify(geo.panels),
          primaryIndex: String(geo.primaryIndex),
        },
      })
      .catch((error) => {
        console.error(`[dsh-pet-desktop-helper] page load failed (${pet.id}):`, error);
        win.destroy();
      });
    windows.set(pet.id, win);
  }
}

// ---------- bridge 协议（渲染端 custom scheme → 本进程 → 宿主 stdout JSON 行 + 本地回调） ----------
// 渲染端的每个 fetch 都落到 dsh-pet-bridge://，protocol.handle 把请求以一行 JSON 写 stdout 转发宿主。
// 宿主应答**不走近 0 号管道**：Electron 主进程在 Windows 上收不到 piped stdin（electron#4218），
// 所以本进程开一个 127.0.0.1 随机端口 HTTP 回调（DSH 闸门只拦 DSH WebServer 路由，管不到这里）；
// 请求行携带回调 URL，宿主处理完 POST 应答回来，按 id 唤醒等待中的请求。
// 素材（webm/字体/光标）：宿主只回文件绝对路径，本进程自行读盘应答（二进制不过管道）。
// 协议行统一前缀 BRIDGE_PREFIX，宿主侧按前缀区分协议与日志（console 输出也走 stdout）。

let bridgeSeq = 0;
/** id -> {resolve, reject}：一个请求对应宿主的一次回调应答 */
const bridgePending = new Map();
let bridgeCallbackUrl = '';

/** 渲染端请求 → 宿主（请求行带回调 URL）；返回宿主应答（{status, contentType?, body?, file?}），超时抛错 */
function bridgeRequest(method, url, body) {
  return new Promise((resolve, reject) => {
    const id = ++bridgeSeq;
    bridgePending.set(id, { resolve, reject });
    process.stdout.write(BRIDGE_PREFIX + JSON.stringify({ id, method, url, body, cb: bridgeCallbackUrl }) + '\n');
    // 宿主若长期不应答（进程退出/宿主动作挂起）不无限挂起：45s 兜底（LLM 生成最长 30-60s）
    setTimeout(() => {
      const p = bridgePending.get(id);
      if (!p) return;
      bridgePending.delete(id);
      p.reject(new Error('bridge request timeout'));
    }, 45000).unref?.();
  });
}

/** 把宿主回调应答（{id, status, ...}）派发给对应请求 */
function bridgeResolve(resp) {
  const p = resp && bridgePending.get(resp.id);
  if (!p) return;
  bridgePending.delete(resp.id);
  p.resolve(resp);
}

/** 本地回调服务器：宿主把应答 POST 到这里（127.0.0.1 随机端口，绕开 stdin/DSH 闸门） */
function startBridgeCallback() {
  const http = require('node:http');
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/respond') {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('dsh-pet: not found');
      return;
    }
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      try {
        bridgeResolve(JSON.parse(raw));
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('ok');
      } catch {
        res.writeHead(400, { 'content-type': 'text/plain' });
        res.end('dsh-pet: bad payload');
      }
    });
    req.on('error', () => {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('dsh-pet: bad payload');
    });
  });
  server.on('error', (e) => {
    console.error('[dsh-pet-desktop-helper] bridge callback server error:', String(e && e.message ? e.message : e));
  });
  server.listen(0, '127.0.0.1', () => {
    const addr = server.address();
    bridgeCallbackUrl = 'http://127.0.0.1:' + (addr && typeof addr === 'object' ? addr.port : 0) + '/respond';
    console.error('[dsh-pet-desktop-helper] bridge callback: ' + bridgeCallbackUrl);
  });
  return server;
}

/** 处理一个渲染端请求：拼宿主请求行 → 等应答 → 组装 Response（素材读盘） */
async function handleBridgeRequest(request) {
  const url = new URL(request.url); // dsh-pet-bridge://dsh-pet/dsh-pet-7340/...
  const method = request.method || 'GET';
  let body;
  if (method === 'POST' || method === 'PUT') {
    body = await request.text();
  }
  const resp = await bridgeRequest(method, url.pathname + url.search, body);
  const headers = { 'access-control-allow-origin': '*' }; // 渲染端页面是 file:// 源，scheme 跨源需 CORS
  if (resp.contentType) headers['content-type'] = resp.contentType;
  if (resp.file) {
    // 素材：直接读盘返回（宿主已解析好绝对路径；带 range 让视频能拖动进度条）
    try {
      const data = await fsPromises.readFile(resp.file);
      return new Response(new Uint8Array(data), { status: resp.status || 200, headers });
    } catch (e) {
      console.error('[dsh-pet-desktop-helper] bridge file read failed:', resp.file, e);
      return new Response('dsh-pet: asset read failed', { status: 500, headers });
    }
  }
  return new Response(resp.body ?? '', { status: resp.status || 200, headers });
}

app.whenReady().then(() => {
  // 探测子进程：此时没有 force-device-scale-factor，读到的是 Windows 的真实主屏缩放。
  // 退出推迟一拍——在 ready 回调里直接 app.exit() 会赶在 stdout 落盘前拆掉进程
  if (DPI_PROBE) {
    process.stdout.write(DPI_MARK + screen.getPrimaryDisplay().scaleFactor + '\n');
    setTimeout(() => app.exit(0), 0);
    return;
  }
  console.error(
    '[dsh-pet-desktop-helper] displays: ' +
      JSON.stringify(deskGeometry()) +
      ' forcedScaleFactor=' +
      (FORCED_SCALE || 'off') +
      ' primaryScale=' +
      (PRIMARY_SCALE || 'unknown') +
      ' petScale=' +
      petScale(),
  );

  if (BRIDGE) {
    // 自定义 scheme 接住渲染端全部请求（配置/余额/碎碎念/广播/素材）
    protocol.handle('dsh-pet-bridge', (request) =>
      handleBridgeRequest(request).catch((e) => {
        console.error('[dsh-pet-desktop-helper] bridge handler error:', String(e && e.message ? e.message : e));
        return new Response('dsh-pet: bridge error', {
          status: 502,
          headers: { 'access-control-allow-origin': '*' },
        });
      }),
    );
    startBridgeCallback(); // 宿主应答回调服务器（stdin 在 Electron 主进程不可用，改走本地 HTTP）
  }

  createPetWindows();

  /**
   * **把"对家（另一条鱼）"注入碰撞站场** ✓ —— 这是原版撞击判定能生效的关键一步。
   *
   * 原版所有宠物在**同一进程** ✓ → petStates 里天然有彼此 ✓。
   * 我们两只鱼在**两个进程** ✗ → 对家永远不在站场里 ✗ → `collidePet` 永远不触发 ✗。
   * 这里暴露一个入口 ✓，由 `gpw-main.cjs` 用插件 `/rects` 拿到的对家 body 盒调进来 ✓。
   *
   * ⚠️ 必须加在 `electron-helper-copy/main.js` 里 ✗→✓（另一份 `electron-helper/main.js`
   * **没有任何代码在加载** ✓ 改那份等于白改 ✓ —— 这个坑今天烧掉了整整一轮 ✓）。
   */
  function setExternalPetState(id, state) {
    const key = String(id || '').trim();
    if (!key || !state || typeof state !== 'object') return false;
    updatePetState(key, {
      x: Number(state.x) || 0,
      y: Number(state.y) || 0,
      vx: Number(state.vx) || 0,
      vy: Number(state.vy) || 0,
      size: Number(state.size) || 0,
      bottomPad: Number(state.bottomPad) || 0,
    });
    broadcastPetStates();
    return true;
  }
  /**
   * **删掉一只对家的状态**（2026-10-18 修 bug：鱼关了、碰撞体积还在）。
   *
   * 之前只有"写入"、没有"删除"：对家关掉后插件账本里它 5 秒后变 `alive:false`、60 秒后被清掉，
   * 但**本进程的 `petStates` 里那条永远留着** → 每次广播都带上它 → 渲染端 `this.others`
   * 里一直有那只幽灵 → 站到它原来的位置还会被撞（主人报的"鱼关了碰撞体积还在"就是这个）。
   * 现在主循环发现"账本里没了 / alive:false"就调这里；广播是全量 map、渲染端整体替换，所以会跟着消失。
   */
  function removeExternalPetState(id) {
    const key = String(id || '').trim();
    if (!key) return false;
    const had = petStates.delete(key);
    if (had) {
      /**
       * 强制重新落盘：`dumpPetStates()` 有 500ms 节流（防止每帧写盘），
       * 而"删掉一只对家"之后可能再没有任何广播了 —— 于是内存里已经没了、
       * 观测文件 `collide-state.json` 却永远留着那只幽灵（实测就卡在这里：
       * 渲染端早就正确了，但看文件以为"碰撞体积还在"）。
       */
      lastStateDump = 0;
      broadcastPetStates();
    }
    return had;
  }
  module.exports.setExternalPetState = setExternalPetState;
  module.exports.removeExternalPetState = removeExternalPetState;
  module.exports.getPetStates = function () {
    const out = {};
    for (const [pid, st] of petStates) out[pid] = { ...st };
    return out;
  };


  // 宠物窗口跟随：renderer 逐帧上报窗口内容区位置/尺寸
  ipcMain.on('pet:set-bounds', (event, bounds) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return;
    const x = Number(bounds?.x);
    const y = Number(bounds?.y);
    const width = Number(bounds?.width);
    const height = Number(bounds?.height);
    if (![x, y, width, height].every(Number.isFinite)) return;
    // 去重必须比较**我们上一次请求的值**，绝不能拿 win.getContentBounds() 回读值来比：
    // 跨缩放屏的 DIP↔物理 往返有 ScaleToEnclosingRect（向外取整）与 origin 舍入，
    // 读回值与设定值永远不相等，去重永远不生效，反而变成每帧强制重设窗口位置。
    const rect = { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
    const key = rect.x + ',' + rect.y + ',' + rect.width + ',' + rect.height;
    if (lastRequestedBounds.get(win.id) !== key) {
      lastRequestedBounds.set(win.id, key);
      win.setContentBounds(rect, false);
    }
    // 碰撞站场：位置必须用**包围盒左上角**（renderer 显式上报 boxX/boxY）——
    // 窗口坐标 = 包围盒 − margin（半只宠物宽），直接拿窗口坐标会让跨窗检测整体错位
    const petId = [...windows.keys()].find((id) => windows.get(id) === win);
    if (petId) {
      const bx = Number(bounds?.boxX);
      const by = Number(bounds?.boxY);
      const size = Number(bounds?.size);
      const bottomPad = Number(bounds?.bottomPad);
      const vx = Number(bounds?.vx);
      const vy = Number(bounds?.vy);
      // 位置 + 尺寸 + 速度一并登记：set-bounds 是每次位置变化都会触发的全量上报
      // （此前只更新 x/y，静止宠物 size 永远为 0，跨窗碰撞检测 `!o.size` 直接跳过它）；
      // 速度取渲染端上报值（飞行中实时、静止/拖拽 = 0），落地后不再残留旧飞行速度。
      // 渲染端上报的"宠物在窗口内的位置"（CSS px）：浮层控件换算的锚点，见兜底判定处
      const stageX = Number(bounds?.stageX);
      const stageY = Number(bounds?.stageY);
      // 页面 devicePixelRatio：穿透判定的坐标换算基准（见 sprite.js 处的说明：
      // Electron 的 screen.scaleFactor 在本机返回 1，靠它会把判定算错）
      const pageDpr = Number(bounds?.pageDpr);
      updatePetState(petId, {
        x: Number.isFinite(bx) ? bx : x,
        y: Number.isFinite(by) ? by : y,
        stageX: Number.isFinite(stageX) ? stageX : petStates.get(petId)?.stageX || 0,
        stageY: Number.isFinite(stageY) ? stageY : petStates.get(petId)?.stageY || 0,
        pageDpr: Number.isFinite(pageDpr) && pageDpr > 0 ? pageDpr : petStates.get(petId)?.pageDpr || 1,
        size: Number.isFinite(size) && size > 0 ? size : petStates.get(petId)?.size || 0,
        bottomPad: Number.isFinite(bottomPad) && bottomPad > 0 ? bottomPad : petStates.get(petId)?.bottomPad || 0,
        vx: Number.isFinite(vx) ? vx : 0,
        vy: Number.isFinite(vy) ? vy : 0,
      });
      // 同一帧把自己的真身盒报给插件（节流 80ms，静默失败）
      reportOwnRect(petId, bounds);
    }
  });

  // 飞行状态上报（碰撞站场）：renderer 飞行中每 ~30ms 上报一次自己的位置/速度/尺寸
  ipcMain.on('pet:report-flight', (event, state) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return;
    const petId = [...windows.keys()].find((id) => windows.get(id) === win);
    if (!petId) return;
    const s = state || {};
    const x = Number(s.x);
    const y = Number(s.y);
    const vx = Number(s.vx);
    const vy = Number(s.vy);
    const size = Number(s.size);
    const bottomPad = Number(s.bottomPad);
    if (![x, y, vx, vy, size, bottomPad].every(Number.isFinite)) return;
    updatePetState(petId, { x, y, vx, vy, size, bottomPad });
  });

  // 碰撞结果转发：飞行方窗口检测到撞到 targetId → 把动量结果（目标新初速）转发给目标窗口
  ipcMain.on('pet:collide-result', (event, payload) => {
    const targetId = payload && typeof payload === 'object' ? String(payload.targetId || '') : '';
    const vx = Number(payload?.vx);
    const vy = Number(payload?.vy);
    if (!targetId || !Number.isFinite(vx) || !Number.isFinite(vy)) return;
    const targetWin = windows.get(targetId);
    if (targetWin && !targetWin.isDestroyed()) {
      targetWin.webContents.send('pet:hit', { vx, vy });
      return;
    }
    /**
     * 对家在**另一个进程**里（多鱼隔离）→ 本进程没有它的窗口，`pet:hit` 发不出去。
     * 交给插件转一手：插件知道每条鱼的 origin，那边收到 /gpw/hit 后走它自己的同一条
     * `pet:hit` → startThrow 路径，所以被撞方弹开的手感与单进程原版一致。
     * 250ms 去抖，防止同一帧反复碰撞把对面推成"抖"。
     */
    const now = Date.now();
    if (now - (global.__lastPeerHitAt || 0) < 250) return;
    global.__lastPeerHitAt = now;
    const origin = pluginOriginNow();
    void fetch(origin + '/game-pet-watch/hit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fishId: targetId, vx, vy }),
      signal: AbortSignal.timeout(1500),
    }).catch(() => {
      originCache = { at: 0, value: '' };
    });
  });

  // 点击穿透翻转：renderer 在光标进/出身体命中区时上报；穿透期间仍保留 forward（mousemove 继续转发）。
  // 兜底轮询（见 createPetWindows）也走同一个出口 setWindowIgnore，两条通道共享同一份镜像状态。
  /**
   * 【副本改动】渲染端最近一次说"要可交互"的时刻（时间兜底用）。
   *
   * 为什么用时间而不是坐标：本机页面坐标 ↔ 屏幕坐标的换算不可靠（实测按倍率算出的输入框位置
   * x≈436，而宠物实际在 x≈1839），任何"按矩形判断"的兜底都会时对时错。
   * 而"渲染端刚说过要可交互"这个事实不含坐标，绝对可靠。
   */
  ipcMain.on('gpw:interactive-pulse', () => {
    global.__gwInteractiveAt = Date.now();
  });

  /**
   * 浮层就地上报的可交互控件矩形（**CSS px，窗口内坐标**）。
   *
   * 为什么要"就地"：本机页面↔屏幕换算不可靠（按倍率算出的输入框位置与实际差一倍多），
   * 而"窗口内坐标"这条链路是**实测自洽**的：
   *   渲染端上报的窗口矩形 = getBounds()（窗口内 160,160 ↔ boxX 1229 → 1229+160 = 1389 = 窗口 x）。
   * 所以输入框位置用 boxX/boxY + 就地偏移来算，不做任何跨坐标系换算。
   */
  ipcMain.on('gpw:local-hit-rects', (event, rects) => {
    if (!Array.isArray(rects)) return;
    global.__gwLocalRects = rects;
    localHitRects = rects
      .filter((r) => r && [r.left, r.top, r.right, r.bottom].every((v) => Number.isFinite(Number(v))))
      .map((r) => ({ left: Number(r.left), top: Number(r.top), right: Number(r.right), bottom: Number(r.bottom) }));
  });

  /** 【副本改动】渲染端上报"这些屏幕矩形也要算可交互"（输入框/胶囊/菜单） */
  ipcMain.on('pet:set-hit-regions', (event, regions) => {
    if (!Array.isArray(regions)) return;
    extraHitRegions = regions
      .filter((r) => r && [r.left, r.top, r.right, r.bottom].every((v) => Number.isFinite(Number(v))))
      .map((r) => ({ left: Number(r.left), top: Number(r.top), right: Number(r.right), bottom: Number(r.bottom) }));
  });

  ipcMain.on('pet:set-interactive', (event, interactive) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return;
    setWindowIgnore(win, !interactive);
  });

  // 渲染端正拿着鼠标输入（拖拽中 / 菜单开着 / 对话弹窗开着）：兜底轮询据此绝不翻回穿透。
  // 只存标记、不直接翻转窗口——**唯一出口**仍是 setWindowIgnore（在兜底轮询里按完整规则判定），
  // 否则会出现"两条通道抢着翻同一个窗口"的竞态。
  ipcMain.on('pet:input-busy', (event, busy) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return;
    inputBusy.set(win.id, !!busy);
  });

  // 右键菜单「打开网站」：交给**系统默认浏览器**打开（等效于网页里 Ctrl+点击链接新标签页），
  // 不建专属窗口——宠物窗口机制是透明小窗，不该承载常规网页浏览。URL 由渲染端从
  // configUrl 推导 = DSH webServer 端口，端口变化自动跟随
  ipcMain.on('pet:open-site', (event, payload) => {
    const url = payload && typeof payload === 'object' ? String(payload.url || '') : '';
    if (!/^https?:[/][/]/.test(url)) return;
    shell.openExternal(url).catch((error) => {
      console.error('[dsh-pet-desktop-helper] openExternal failed:', error);
    });
  });

  // 显示器热更新：分辨率/缩放变化、插拔屏、旋转都会让桌面几何失效。原先几何只在
  // createPetWindows() 算一次并经 URL query 注入，渲染端 VIEW 是模块顶层常量，运行期永不更新——
  // 表现为「改了分辨率后可移动范围还是旧的」。这里重算并推给所有窗口，渲染端就地重挂。
  let displaysTimer = null;
  const pushDisplays = () => {
    const geo = deskGeometry();
    lastRequestedBounds.clear(); // 坐标系变了，去重缓存作废，下一帧必须真的重设一次
    for (const win of windows.values()) {
      if (!win.isDestroyed()) win.webContents.send('pet:displays', geo);
    }
    console.error('[dsh-pet-desktop-helper] displays changed: ' + JSON.stringify(geo));
    // 主屏缩放可能一起变了（它决定宠物的尺寸补偿）。线性化生效期间 screen API 只报被强制的值，
    // 真实值只能靠探测子进程拿；不一致就刷新缓存，下次启动自动用上。
    if (FORCED_SCALE > 0) {
      setTimeout(() => {
        const real = probePrimaryScale();
        if (real > 0 && Math.abs(real - PRIMARY_SCALE) > 1e-6) {
          console.error(
            '[dsh-pet-desktop-helper] primary scaleFactor changed ' +
              PRIMARY_SCALE +
              ' -> ' +
              real +
              '; restart the desktop pet to resize',
          );
        }
      }, 1000).unref?.();
    }
  };
  /** 显示器事件会连发（一次改动能来好几条），去抖后只重算一次 */
  const scheduleDisplays = () => {
    if (displaysTimer) clearTimeout(displaysTimer);
    displaysTimer = setTimeout(() => {
      displaysTimer = null;
      pushDisplays();
    }, 300);
  };
  screen.on('display-metrics-changed', scheduleDisplays);
  screen.on('display-added', scheduleDisplays);
  screen.on('display-removed', scheduleDisplays);

  // 冒烟自检模式（默认关闭）：DSH_PET_SMOKE=1 时延时截图到 DSH_PET_SMOKE_OUT 后退出，
  // 用于验证窗口/渲染/动画链路（如 CI 或本地验证）。
  if (process.env.DSH_PET_SMOKE === '1') {
    const smokeOut = process.env.DSH_PET_SMOKE_OUT || path.join(app.getPath('temp'), 'dsh-pet-smoke.png');
    const afterMs = Number(process.env.DSH_PET_SMOKE_AFTER_MS || 9000);
    const target = windows.values().next().value;
    if (target) {
      // 转发渲染端 console（定位动画/余额/错误问题）
      target.webContents.on('console-message', (event) => {
        console.log(`[renderer:${event.level}] ${event.message}`);
      });
    }
    setTimeout(async () => {
      try {
        const first = windows.values().next().value;
        if (first && !first.isDestroyed()) {
          const dump = await first.webContents.executeJavaScript(`(async () => ({
            hasBridge: typeof window.petBridge !== 'undefined',
            hasSetInteractive: typeof window.petBridge?.setInteractive === 'function',
            viewport: window.innerWidth + 'x' + window.innerHeight,
            dpr: window.devicePixelRatio,
            debug: window.__dshPetDebug || null,
            sprites: document.querySelectorAll('.pet-sprite').length,
            errorVisible: document.getElementById('pet-error').classList.contains('visible'),
            errorText: document.getElementById('pet-error').textContent,
            firstBubble: (document.querySelector('.pet-bubble.is-on') || { textContent: '' }).textContent.slice(0, 120),
            hitCursor: (function () {
              var hit = document.querySelector('.pet-hit');
              return hit ? getComputedStyle(hit).cursor : '';
            })(),
            dragTransform: (function () {
              var hit = document.querySelector('.pet-hit');
              var stage = document.querySelector('.pet-stage');
              if (!hit || !stage) return 'no-sprite';
              var out = { idle: stage.style.transform };
              hit.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 120, clientY: 120, screenX: 120, screenY: 120, pointerId: 91 }));
              out.duringClick = stage.style.transform;
              hit.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: 120, clientY: 120, screenX: 120, screenY: 120, pointerId: 91 }));
              out.afterClick = stage.style.transform;
              hit.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 200, clientY: 200, screenX: 200, screenY: 200, pointerId: 92 }));
              hit.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 280, clientY: 240, screenX: 280, screenY: 240, pointerId: 92 }));
              out.duringDrag = stage.style.transform;
              window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: 280, clientY: 240, screenX: 280, screenY: 240, pointerId: 92 }));
              out.afterDrag = stage.style.transform;
              return out;
            })(),
            releaseKeptPosition: await (async function () {
              // 独立不变量：把宠物先拖到工作区内的固定安全点（600,300），松手后窗口位置必须原地不动。
              // 拖拽抛掷物理（弹簧跟手+甩抛）下：指针长距跳跃后弹簧需要 ~0.3s 收敛，
              // 松手前停留超过 RELEASE_STALE_MS(150ms) 判为「温柔放下」（估速 null，不抛掷）——
              // 所以先等弹簧到位、再停留才松手，只测"释放瞬间是否位移"。
              var d = window.__dshPetDebug;
              var hit = document.querySelector('.pet-hit');
              if (!d || !d.dragPos || !hit) return null;
              var P = { x: d.dragPos.x, y: d.dragPos.y };
              var T = { x: 600, y: 300 }; // 目标窗口左上角（1708×1020 工作区内，远离四边）
              var upX = 1000 + (T.x - P.x);
              var upY = 600 + (T.y - P.y);
              var sleep = function (ms) {
                return new Promise(function (r) {
                  setTimeout(r, ms);
                });
              };
              hit.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 1000, clientY: 600, screenX: 1000, screenY: 600, pointerId: 93 }));
              hit.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: upX, clientY: upY, screenX: upX, screenY: upY, pointerId: 93 }));
              await sleep(400); // 弹簧跟随收敛
              var during = { x: d.dragPos.x, y: d.dragPos.y };
              await sleep(200); // 轨迹过期 → 估速 null → 温柔放下（不抛掷）
              window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: upX, clientY: upY, screenX: upX, screenY: upY, pointerId: 93 }));
              await sleep(80); // 释放处理完成
              var released = d.lastDragRelease ? { x: d.lastDragRelease.x, y: d.lastDragRelease.y } : null;
              return {
                during: during,
                released: released,
                kept: !!(released && Math.abs(released.x - during.x) <= 1 && Math.abs(released.y - during.y) <= 1),
              };
            })(),
            interactiveFlip: (function () {
              // 点击穿透命中判定：光标在命中区内→可交互；移出→穿透；拖拽中（pointer 已捕获）→强制可交互。
              // hitRect 是 sprite 坐标，mousemove 用窗口坐标——测试事件需加上窗口外扩余量 winMargin。
              var d = window.__dshPetDebug;
              var hit = document.querySelector('.pet-hit');
              if (!d || !d.hitRect || !d.winMargin || !hit) return null;
              var r = d.hitRect;
              var m = d.winMargin;
              var xIn = m.l + r.x + r.w / 2;
              var yIn = m.t + r.y + r.h / 2;
              var xOut = Math.max(0, m.l + r.x - 20);
              var yOut = Math.max(0, m.t + r.y - 20);
              var out = {};
              window.dispatchEvent(new MouseEvent('mousemove', { clientX: xIn, clientY: yIn, screenX: xIn, screenY: yIn }));
              out.inside = d.interactive === true;
              window.dispatchEvent(new MouseEvent('mousemove', { clientX: xOut, clientY: yOut, screenX: xOut, screenY: yOut }));
              out.outside = d.interactive === false;
              hit.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: xIn, clientY: yIn, screenX: xIn, screenY: yIn, pointerId: 94 }));
              window.dispatchEvent(new MouseEvent('mousemove', { clientX: xOut, clientY: yOut, screenX: xOut, screenY: yOut }));
              out.duringDragForced = d.interactive === true;
              window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: xOut, clientY: yOut, screenX: xOut, screenY: yOut, pointerId: 94 }));
              return out;
            })(),
            videoSrcA: (document.querySelectorAll('.pet-sprite video')[0] || { src: '' }).src,
            videoSrcB: (document.querySelectorAll('.pet-sprite video')[1] || { src: '' }).src,
            // 右键菜单自检：在命中区派发 contextmenu → 校验菜单挂载/根文案/子面板/运行错误
            menuSmoke: await (async function () {
              // 前面 drag/release/interactive 测试刚拖过宠：justDragged 100ms 内屏蔽右键，
              // 真实用户不会拖完立刻右键——先等 250ms 消除该时序影响
              await new Promise(function (resolve) {
                setTimeout(resolve, 250);
              });
              var hit = document.querySelector('.pet-hit');
              var d = window.__dshPetDebug;
              if (!hit || !d) return null;
              var errsBefore = (d.errors || []).length;
              try {
                hit.dispatchEvent(
                  new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 400, clientY: 260, screenX: 400, screenY: 260 }),
                );
              } catch (err) {
                return { threw: String(err), menuMounted: false };
              }
              var menu = document.querySelector('.dsh-pet-menu');
              var out = {
                threw: null,
                menuMounted: !!menu,
                menuOpen: d.menuOpen === true,
                rootText: menu ? menu.textContent.slice(0, 60) : '',
                errsNew: (d.errors || []).length - errsBefore,
              };
              if (menu) {
                var branch = menu.querySelector('.dsh-pet-menu-branch');
                if (branch) {
                  branch.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false, relatedTarget: menu }));
                  var panels = Array.prototype.slice.call(
                    menu.querySelectorAll('.dsh-pet-menu-column'),
                  );
                  var visible = function () {
                    return panels.filter(function (p) {
                      return p.style.display !== 'none';
                    });
                  };
                  out.panelCount = panels.length;
                  out.lvl2AfterHoverRoot = visible().length;
                  // 二级：悬停「动作」下的第一个分类 → 打开三级面板（具体动画）
                  var panel1 = visible().filter(function (p) {
                    return p !== panels[0];
                  })[0];
                  if (panel1) {
                    var cat = panel1.querySelector('.dsh-pet-menu-branch');
                    if (cat) {
                      cat.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false, relatedTarget: panel1 }));
                      await new Promise(function (resolve) {
                        setTimeout(resolve, 50);
                      });
                      out.lvl3AfterHoverCat = visible().length;
                      // 重放用户路径：鼠标从分类项移向三级面板（先离开分类项进入 4px 缝隙，
                      // 再进入三级面板）——缝隙里 mouseleave 会排 160ms 关闭定时器
                      cat.dispatchEvent(
                        new MouseEvent('mouseleave', { bubbles: false, relatedTarget: document.body }),
                      );
                      await new Promise(function (resolve) {
                        setTimeout(resolve, 60);
                      });
                      var panel2 = visible()[visible().length - 1];
                      if (panel2) {
                        panel2.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
                      }
                      await new Promise(function (resolve) {
                        setTimeout(resolve, 220);
                      });
                      out.lvl3SurvivedAfterReenter = visible().length;
                      // 极端情况：缝隙停留超过关闭延时（鼠标犹豫）
                      cat.dispatchEvent(
                        new MouseEvent('mouseleave', { bubbles: false, relatedTarget: document.body }),
                      );
                      await new Promise(function (resolve) {
                        setTimeout(resolve, 260);
                      });
                      out.lvl3AfterGapHover = visible().length;
                    }
                  }
                }
              }
              return out;
            })(),
          }))()`);
          console.log(
            '[dsh-pet-desktop-helper] smoke dump: windows=' +
              windows.size +
              ' ids=' +
              JSON.stringify([...windows.keys()]) +
              ' => ' +
              JSON.stringify(dump),
          );
          console.log('[dsh-pet-desktop-helper] smoke bounds:', JSON.stringify(first.getContentBounds()));
          // 点击穿透 round-trip：setInteractive(true)→窗口捕获输入（忽略鼠标=false）；
          // setInteractive(false)→恢复整窗穿透（忽略鼠标=true）。状态取自主进程镜像 windowIgnore。
          // 期间暂停兜底轮询：它按真实光标位置翻转，冒烟时鼠标不在宠物身上会覆盖本断言的状态。
          pointerFallbackPaused = true;
          await first.webContents.executeJavaScript('window.petBridge.setInteractive(true); true;');
          await new Promise((r) => setTimeout(r, 80));
          const interactiveIgnoring = windowIgnore.get(first.id);
          await first.webContents.executeJavaScript('window.petBridge.setInteractive(false); true;');
          await new Promise((r) => setTimeout(r, 80));
          const passthroughIgnoring = windowIgnore.get(first.id);
          pointerFallbackPaused = false;
          console.log(
            '[dsh-pet-desktop-helper] smoke interactive round-trip:',
            JSON.stringify({ interactiveIgnoring, passthroughIgnoring }),
          );
          const image = await first.webContents.capturePage();
          writeFileSync(smokeOut, image.toPNG());
          console.log('[dsh-pet-desktop-helper] smoke capture:', smokeOut);
        }
      } catch (error) {
        console.error('[dsh-pet-desktop-helper] smoke capture failed:', error);
      }
      setTimeout(() => app.quit(), 500);
    }, afterMs);
  }
});

app.on('window-all-closed', () => {
  app.quit();
});
