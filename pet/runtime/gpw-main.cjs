/**
 * dsh-pet-gpw —— 独立副本的启动器（CommonJS，Electron 主进程入口）。
 *
 * 分工（这样才不会重造轮子踩坑）：
 *   1. 本文件先起**副本自己的宠物 API 服务**（gpw-server.cjs：/config、/state、素材、/gpw/say）
 *   2. 再用 `DSH_PET_CONFIG_URL` / `DSH_PET_PETS` 把地址喂给**原版助手的窗口代码**
 *      （runtime/electron-helper-copy/main.js —— 与 dsh-pet 逐字节相同，只改了 app 名与浮层注入）
 *      窗口创建、点击穿透翻转、拖拽/抛掷物理、显示器几何全用它，一行不重写
 *   3. 页面加载完成后注入 gpw-overlay.js（悬停输入框 / 状态胶囊 / 右键开面板）
 *
 * 与原版 dsh-pet 的隔离：app 名不同 → userData 目录不同；端口不同（7341 vs 宿主 WebServer）；
 * 它的进程、配置、路由、素材目录我们只读不写。
 */
'use strict';

const { app, ipcMain, BrowserWindow, screen } = require('electron');
const { join, dirname } = require('node:path');
const { existsSync, readFileSync, mkdirSync } = require('node:fs');
const { startPetServer } = require('./gpw-server.cjs');

const { createPrefs } = require('./gpw-prefs.cjs');

/**
 * 未捕获异常**绝不弹模态框**。
 *
 * Electron 的默认行为是弹一个 "A JavaScript error occurred in the main process" 对话框，
 * 而那个框是**模态的、阻塞主进程的** —— 于是任何一个小异常都会表现成"整个副本卡死"：
 * 宠物 API 不通、胶囊显示"插件离线"、连不上一切。
 * 我们踩过一次（setPosition 收到 NaN）。这里改成写日志 + 继续跑：
 * 桌宠这种陪伴进程，掉一帧无所谓，卡死才是灾难。
 */
process.on('uncaughtException', (error) => {
  try {
    require('node:fs').appendFileSync(
      require('node:path').join(require('node:os').tmpdir(), 'gpw-uncaught.log'),
      new Date().toISOString() + ' ' + String(error && error.stack ? error.stack : error) + String.fromCharCode(10),
    );
  } catch {
    /* 日志失败也不能让它冒出去 */
  }
});
process.on('unhandledRejection', () => {
  /* 同理：一律吞掉，避免任何弹框 */
});
/**
 * 诊断开关（默认关）：GPW_INSPECT=1 时给窗口开 DevTools 调试口。
 * 排查"交互失效"这类问题时必需——能从外部读到渲染端的 interactive/inputBusy/menuOpen，
 * 也能读到主进程的 windowIgnore，才能判断是哪个参与者在把开关翻错。
 * 用命令行开关而不是启动参数：插件自动拉起时也能带上（app.relaunch 也会继承）。
 */
if (process.env.GPW_INSPECT === '1') {
  app.commandLine.appendSwitch('remote-debugging-port', process.env.GPW_DEBUG_PORT || '9222');
}
const RUNTIME = __dirname;
const PACKAGE_ROOT = dirname(RUNTIME);
const HELPER_COPY = join(RUNTIME, 'electron-helper-copy');
const OVERLAY_FILE = join(RUNTIME, 'electron-helper', 'gpw-overlay.js');

/** 用户数据目录：配置 + 状态（与原版 dsh-pet 的 $DSH_HOME/dsh-pet 分开） */
const USER_ROOT =
  process.env.GPW_USER_ROOT || join(app.getPath('home'), '.dsh', 'dsh-pet-gpw');
const CONFIG_FILE = join(USER_ROOT, 'pet-config.json');
const STATE_FILE = join(USER_ROOT, 'state.json');
/**
 * 动画素材目录（副本按 `<这里>/assets/config.jsonc` + `<这里>/assets/webm/*` 读）。
 *
 * 顺序：插件下发的 `GPW_UPSTREAM_ROOT` → **仓库自带的 assets/**（素材已从 dsh-pet 独立时）
 * → 本机 `~/.dsh/profiles/<profile>/node_modules/dsh-pet`（借原版素材）。
 * 默认值**不能写死用户名**：插件正常会下发，手动启动时这里按本机推。
 */
const UPSTREAM_ROOT = (() => {
  if (process.env.GPW_UPSTREAM_ROOT) return process.env.GPW_UPSTREAM_ROOT;
  const repoRoot = join(__dirname, '..');
  if (existsSync(join(repoRoot, 'assets', 'config.jsonc'))) return repoRoot; // 自带素材
  const home = app.getPath('home');
  const candidates = [
    join(home, '.dsh', 'profiles', String(process.env.DSH_PROFILE || 'desktop'), 'node_modules', 'dsh-pet'),
    join(home, '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-pet'),
  ];
  return candidates.find((dir) => existsSync(dir)) || candidates[0];
})();
const PLUGIN_ORIGIN = process.env.GPW_PLUGIN_ORIGIN || 'http://127.0.0.1:19387';

/**
 * 本进程回连插件的地址：**公共登记簿优先**，env 兜底（实现在 electron-helper-copy 里，
 * 那边才是真正发 `/rects` 的人，两边必须用同一个答案，否则"自报的"和"实际用的"会对不上）。
 */
const pluginOriginNow = () => {
  try {
    const helper = require(join(HELPER_COPY, 'main.js'));
    if (typeof helper.pluginOriginNow === 'function') return helper.pluginOriginNow();
  } catch {
    /* helper 还没加载完（极早期调用）：退回 env */
  }
  return PLUGIN_ORIGIN.replace(/\/+$/, '');
};
const PORT = Number(process.env.GPW_PORT || 7341);
const PET_ID = process.env.GPW_PET_ID || 'gpw';
const log = (message) => process.stdout.write(`[dsh-pet-gpw] ${message}\n`);

const DEFAULT_CONFIG = {
  pets: [
    {
      id: PET_ID,
      name: '大肥鱼（副本）',
      size: 340,
      balanceEnabled: false,
      whisperEnabled: false,
      workStatusEnabled: false,
      // 副本是"陪伴 + 对话入口"，不漫游：固定就位，免得满屏乱跑还找不着
      fixedEnabled: true,
      display: 'desktop',
      position: { corner: 'bottom-right', marginX: 16, marginY: 16 },
    },
  ],
  physics: { gravity: 1400, restitution: 0.78, groundFriction: 1.3, ceilingBounce: true, throwPower: 1, petCollision: false },
  confineToScreen: true,
  notificationsEnabled: false,
  whisperImageEnabled: false,
  chatImageEnabled: false,
  chatMemoryRounds: 0,
  chatImageLimit: 0,
  eventsRefreshSec: { balance: 1800, whisper: 300 },
};

async function ensureConfigFile() {
  const fs = require('node:fs/promises');
  mkdirSync(USER_ROOT, { recursive: true });
  if (existsSync(CONFIG_FILE)) return;
  await fs.writeFile(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf8');
  log('已写出默认宠物配置：' + CONFIG_FILE + '（改它可调大小/位置）');
}

// 先把服务起起来：窗口代码在 app.whenReady 里立刻拉 /config，必须先监听
const serverReady = (async () => {
  if (!existsSync(UPSTREAM_ROOT)) {
    throw new Error('找不到原版 dsh-pet 包目录（动画池与素材来源）：' + UPSTREAM_ROOT);
  }
  await ensureConfigFile();
  const { port } = await startPetServer({
    port: PORT,
    petId: PET_ID,
    /**
     * 我们这条鱼回连插件的地址（`/gpw/brand` 会把它报给对端）。
     * 同一份解析也用于本进程自己的 `/rects` 上报（见 electron-helper-copy/main.js 的
     * `pluginOrigin()`），所以这里只做透传，保证"自报的"和"实际用的"是同一个值。
     */
    pluginOrigin: () => pluginOriginNow(),
    petAssetsRoot: UPSTREAM_ROOT,
    // 表情包目录链（用户目录优先，回落原版包内）：/pic/memes/<名>.png 按这个顺序找
    /**
     * 表情包目录链（用户目录优先 → **共享图库** → 原版包内）。
     *
     * 为什么要有"共享图库"这一环：多鱼之后**图片只有一份**（插件的 imagesUserRoot ✓，
     * 默认落在 ~/.dsh/dsh-pet-gpw/memes ✓），而每条鱼的副本只从**自己的** USER_ROOT 取图 ✗
     * → 第二只鱼（--profile second）取任何图都 404 ✗（实测：7342 /pic/memes/0001.png = 404 ✓）。
     * 这里把共享目录加进链里 ✓ —— 不复制文件 ✓ 只多找一个地方 ✓。
     */
    memeDirs: [
      join(USER_ROOT, 'memes'),
      String(process.env.GPW_SHARED_MEMES || '').trim(),
      join(UPSTREAM_ROOT, 'assets', 'memes'),
    ].filter(Boolean),
    configFile: CONFIG_FILE,
    upstreamConfigFile: join(UPSTREAM_ROOT, 'assets', 'config.jsonc'),
    stateFile: STATE_FILE,
    localRoot: join(RUNTIME, 'electron-helper'),
    // 鱼板网络握手（/gpw/brand）要宠物名字；说话记录本来就随 state.json 持久化，不用另传路径
    prefs,
    log,
    /**
     * **碰撞推开**（插件当裁判 ✓ 见 gpw-server 的 /gpw/nudge ✓）：
     * 把宠物窗按 (dx,dy) 挪一点，并夹在屏幕工作区内 ✓ —— 只动窗口位置，不碰渲染 ✓。
     */
    nudge: ({ dx, dy }) => {
      const moved = [];
      for (const win of petWindows()) {
        if (win.isDestroyed()) continue;
        const b = win.getBounds();
        let area;
        try {
          area = screen.getPrimaryDisplay().workArea;
        } catch {
          area = null;
        }
        let x = b.x + dx;
        let y = b.y + dy;
        if (area) {
          x = Math.max(area.x, Math.min(x, area.x + area.width - b.width));
          y = Math.max(area.y, Math.min(y, area.y + area.height - b.height));
        }
        if (x !== b.x || y !== b.y) win.setBounds({ x, y, width: b.width, height: b.height });
        moved.push({ from: { x: b.x, y: b.y }, to: { x, y } });
      }
      return { moved: moved.length, at: Date.now() };
    },
    /**
     * **碰撞反应**：把 (vx,vy) 用原版那条 `pet:hit` 发给宠物窗 ✓
     * 渲染端已有监听 ✓ → 会走它自己的冲量/抛掷逻辑 ✓ → 本体真的弹开 ✓。
     */
    hit: ({ vx, vy }) => {
      let sent = 0;
      for (const win of petWindows()) {
        if (win.isDestroyed()) continue;
        win.webContents.send('pet:hit', { vx, vy });
        sent += 1;
      }
      return { sent };
    },
    collideDebug: () => ({
      fishId: String(process.env.GPW_FISH_ID || PET_ID || ''),
      note: '对家现在直接以 pet:flight-states 广播给渲染端；本端点只做基本自检',
      windows: petWindows().length,
    }),
    // 宠物页的 /chat（如果走到这条）与副本的 /gpw/say 之外，插件回话由插件自己推
    ask: async (text) => {
      /**
       * ⚠️ 转发时必须带上**自己的身份**（端口 / scope / fishId）。
       *
       * 不带的话插件认不出是谁在问 -> 回话会推到"业务主鱼"（= 接 QQ 那条 7342），
       * 主人就会看到"在 7341 的输入框里问，回答从 7342 冒出来"（实测报过）。
       * port 一定带上（插件按它反查鱼表，不依赖 env）。
       */
      const payload = {
        text,
        push: 'gpw',
        pet: PET_ID,
        port: PORT,
        fishId: String(process.env.GPW_FISH_ID || ''),
        scope: String(process.env.GPW_FISH_SCOPE || ''),
      };
      const res = await fetch(pluginOriginNow() + '/game-pet-watch/ask', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => ({}));
      if (!body || body.ok !== true) {
        return { ok: false, reason: body?.reason || 'generate-error', message: body?.message || `HTTP ${res.status}` };
      }
      return { ok: true };
    },
    buildSheet: (request) => buildSheet(request),
    // 置顶固定：状态与执行都在主进程（见文件末尾的置顶管理器）
    pin: {
      get: () => pinned,
      set: (next) => setPinned(next),
    },
    // 偏好（宠物尺寸 / 文字大小）。apply 由文件末尾注入为"重建自己"
    prefs,
  });
  return port;
})();

/**
 * 抽帧拼图（离屏窗 + Chromium 解码 + 磁盘缓存）。
 *
 * 为什么不开 ffmpeg：本机没有，而 Chromium 解 webm/VP9-alpha 是本职；副本进程现成，零依赖零下载。
 * 缓存键 = 源文件 mtime + 拼图参数：素材没换就不重复解码。
 *
 * @param {{file:string, source:string, cols:number, rows:number, tileW:number}} request
 * @returns {Promise<{file:string, sheet:string, meta:object, cached:boolean}>}
 */
async function buildSheet(request) {
  const fsPromises = require('node:fs/promises');
  const fsSync = require('node:fs');
  const { createHash } = require('node:crypto');
  const sheetsDir = join(USER_ROOT, 'sheets');
  fsSync.mkdirSync(sheetsDir, { recursive: true });
  const stat = fsSync.statSync(request.source);
  const key = createHash('sha1')
    .update(
      [request.file, stat.mtimeMs, stat.size, request.cols, request.rows, request.tileW].join('|'),
    )
    .digest('hex')
    .slice(0, 16);
  const pngPath = join(sheetsDir, key + '.png');
  const metaPath = join(sheetsDir, key + '.json');
  if (fsSync.existsSync(pngPath) && fsSync.existsSync(metaPath)) {
    return {
      file: request.file,
      sheet: pngPath,
      meta: JSON.parse(fsSync.readFileSync(metaPath, 'utf8')),
      cached: true,
    };
  }

  const url = new URL('http://127.0.0.1:' + PORT + '/dsh-pet-7340/thumb/gpw/' + encodeURIComponent(request.file));
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    show: false,
    frame: false,
    backgroundColor: '#101014',
    webPreferences: {
      // 离屏窗不加载任何远端内容；用 preload 给页面一条回传通道，
      // 而不是让主进程去读主世界的 window.__frames（contextIsolation 下读不到，会读到假状态）
      preload: join(RUNTIME, 'electron-helper', 'frames-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      offscreen: false,
    },
  });
  try {
    const statePromise = new Promise((resolve) => {
      const channel = 'gpw:frames-done';
      const onDone = (event, payload) => {
        if (event.sender !== win.webContents) return;
        ipcMain.removeListener(channel, onDone);
        resolve(payload);
      };
      ipcMain.on(channel, onDone);
      setTimeout(() => {
        ipcMain.removeListener(channel, onDone);
        resolve({ ok: false, error: '抽帧超时（75s）', step: 'timeout' });
      }, 75000).unref?.();
    });
    await win.loadFile(join(RUNTIME, 'electron-helper', 'frames.html'), {
      query: {
        file: url.toString(),
        cols: String(request.cols || 4),
        rows: String(request.rows || 3),
        tileW: String(request.tileW || 320),
      },
    });
    const state = await statePromise;
    if (!state || state.ok !== true) {
      throw new Error(
        '抽帧失败：' +
          ((state && state.error) || '超时') +
          '（step=' + ((state && state.step) || 'unknown') + '）',
      );
    }
    // 窗口尺寸对齐拼图本身：capturePage 会把窗口内容区整块拍下来，
    // 窗口比画布大就会在 PNG 周围留一圈黑边（模型看得懂，但白费 token）
    if (state.sheetW > 0 && state.sheetH > 0) {
      win.setContentSize(Math.round(state.sheetW), Math.round(state.sheetH));
      await new Promise((r) => setTimeout(r, 150));
    }
    const image = await win.webContents.capturePage();
    await fsPromises.writeFile(pngPath, image.toPNG());
    await fsPromises.writeFile(metaPath, JSON.stringify(state, null, 2), 'utf8');
    log(`拼图完成 ${request.file} → ${pngPath}（${state.frames.length} 帧 ${state.sheetW}x${state.sheetH}）`);
    return { file: request.file, sheet: pngPath, meta: state, cached: false };
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

serverReady.catch((error) => {
  log('宠物服务启动失败：' + (error && error.stack ? error.stack : String(error)));
  app.exit(1);
});

// 把窗口代码要的环境变量准备好，再交给原版助手代码（它读 DSH_PET_* 这一套）
process.env.DSH_PET_CONFIG_URL = `http://127.0.0.1:${PORT}/dsh-pet-7340/config`;
// 偏好（宠物尺寸 / 文字大小）在服务启动前读出来，尺寸直接决定窗口大小与 sprite 的 --pet-size
const prefs = createPrefs(USER_ROOT, log);
const prefsNow = prefs.get();
process.env.DSH_PET_PETS = JSON.stringify([{ id: PET_ID, size: prefsNow.petSize }]);
process.env.DSH_PET_BRIDGE = '0';
process.env.DSH_PET_GPW_OVERLAY = OVERLAY_FILE;
/**
 * 【退出耦合】**保留** DSH_PET_HOST_PID，让副本跟随 DSH 退出。
 *
 * 这里以前是 `delete process.env.DSH_PET_HOST_PID`（"副本不认宿主存活那套，免得助手自杀"）——
 * 那是"让宠物独立于 DSH 存活"的设计留下的。现在取舍反过来了：
 *   宠物必须跟着 DSH 一起退（没接入大脑的宠物没有价值，还会占住 7341 端口，
 *   导致下次 DSH 启动时端口冲突）。
 *
 * 机制在 electron-helper-copy：每 2 秒 `kill(hostPid, 0)` 探一次，ESRCH 就 app.exit(0)。
 * 这是 OS 级事实，**不依赖心跳或 IPC**，所以 DSH 崩溃退出时副本也能收敛。
 *
 * 注意：插件没注入这个变量时（比如手工 `node scripts/gpw-start.mjs` 调试），
 * 助手那边 parseHostPid 会得到 0 → 不探测 → 副本正常独立运行。调试行为不受影响。
 */
if (process.env.DSH_PET_HOST_PID) {
  log(`跟随宿主 pid=${process.env.DSH_PET_HOST_PID}（它退出时副本也退）`);
}

// ---- 浮层注入：**已停用** ----
/**
 * 以前这里把 gpw-overlay.js 注入宠物页面，用来画状态胶囊 + 悬停输入框。
 *
 * 现在**不再注入**：那些控件已经搬到「观察中」独立小窗（见 createBadgeWindow）。
 * 原因：它们画在宠物窗里时，"随时能点到"要求窗口可交互，而宠物窗的点击穿透由副本
 * 自动判定控制 —— 两个需求冲突，硬凑的结果是和自动判定打架、还会整块挡住桌面。
 *
 * 宠物页面因此**完全回到原版**（只剩宠物本体），穿透只有一个控制器。
 * 保留这个函数体是为了留痕：将来若有人想把浮层加回宠物页面，先读上面这段。
 */
function installOverlay() {
  log('浮层注入已停用（状态胶囊/输入框已独立为小窗）');
}

/**
 * 窗口位置：不做任何外部摆位。
 *
 * 历史上这里有过两版"位置纠正"，都实测有害，别再加回来：
 *   1. 每 2 秒重申一次 → 拖拽中途被拉回角落；
 *   2. 只在启动纠一次 → 窗口被挪了而渲染端不知道，重启后第一次移动就跳到别的位置。
 */
function logWindowMode() {
  app.on('browser-window-created', (_event, win) => {
    win.webContents.once('did-finish-load', () => {
      if (!win.webContents.getURL().includes('index-gpw')) return;
      const b = win.getBounds();
      log(`宠物窗 ${b.width}x${b.height} @ ${b.x},${b.y}（铺满模式；位置交给渲染端）`);
    });
  });
}
logWindowMode();

// （重复的 installOverlay 定义已删：浮层改为独立小窗，见上方 installOverlay 与她上面的说明）

/**
 * 窗口位置：**不做任何外部摆位**（此函数已按实测结论删除，别再写回来）。
 *
 * 铺满屏幕 + 视口=窗口内容区（见 electron-helper-copy/main.js 的 createPetWindows）之后，
 * 坐标系只剩一套，宠物自己按配置落在右下角，`pet:set-bounds` 上报的矩形恒等于窗口，
 * 主进程那次 setContentBounds 成为空操作。
 *
 * 两版"纠正"都实测有害：
 *   1. 每 2 秒重申 → 拖拽中途被拉回角落（"拖着拖着自己弹回去"）；
 *   2. 仅启动纠一次 → 窗口被挪而渲染端不知道，重启后第一次移动跳位。
 */


// ---- 面板窗：宠物浮层里的右键/胶囊点击走 IPC 到这里 ----
let panelWindow = null;
function openPanel() {
  if (panelWindow && !panelWindow.isDestroyed()) {
    panelWindow.show();
    panelWindow.focus();
    return;
  }
  panelWindow = new BrowserWindow({
    width: 470,
    height: 660,
    minWidth: 380,
    minHeight: 420,
    frame: false,
    resizable: true,
    alwaysOnTop: true,
    show: false,
    backgroundColor: '#1b1b1f',
    title: '游戏观察 · dsh-pet-gpw',
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  panelWindow.setAlwaysOnTop(true, 'floating');
  void panelWindow.loadFile(join(RUNTIME, 'electron-helper', 'panel.html'), {
    query: { plugin: pluginOriginNow(), port: String(PORT) },
  });
  panelWindow.once('ready-to-show', () => panelWindow.show());
  panelWindow.on('closed', () => {
    panelWindow = null;
  });
}

// 浮层用 preload 里的 gpwHost 通道；这里同时兼容"直接发 IPC"的写法
ipcMain.on('gpw:open-panel', () => openPanel());

/**
 * 「观察中」小窗：把状态胶囊 + 悬停输入框从宠物那个大透明窗里**独立出来**。
 *
 * 为什么必须独立（用户提的方案，方向是对的）：
 *   原来它们画在宠物窗里（1080x869）。宠物窗的点击穿透由副本自动判定控制，而"随时能点到
 *   胶囊/输入框"又要求窗口可交互 —— 两个需求直接冲突，之前的"交互锁定"就是硬凑这个，
 *   结果和自动判定打架，还会整块 1080x869 挡住桌面。
 *   独立成小窗后：这个窗**永远可交互**（控件永远点得到），而且**收起时只有胶囊那么大**
 *   （约 150x26），遮挡面积极小；宠物窗则完全回到原版行为，穿透只有一个控制器。
 *
 * 位置：贴在宠物包围盒的右上角。宠物框由副本上报（global.__gwPetStatesDump），
 * 那是与屏幕同坐标系的实测自洽值（见副本 main.js 里关于坐标的注释）。
 */
/**
 * 两个小窗的尺寸（都很小，因为它们是**永远可交互**的，面积越小遮挡越少）：
 *   - 胶囊窗：只放「观察中 · N 📌」，贴在宠物**右上角**，一直显示；
 *   - 输入框窗：只放输入框，贴在宠物**脚底下方**，**平时隐藏**（hide()，连点击都不拦）。
 * 拆两个窗的原因：两者分处宠物上/下两侧，合一个窗就得让那个窗横跨宠物全身，可交互面积大很多。
 */
/**
 * 两个小窗的尺寸（都刻意很小：它们是**永远可交互**的，面积越小遮挡越少）：
 *   - 胶囊窗：只放「观察中 · N 📌」，贴宠物**右上角**，一直显示（168x28）；
 *   - 输入框窗：只放输入框，贴宠物**脚底下方**，**平时隐藏**（hide()，隐藏时连点击都不拦）。
 * 拆两个窗的原因：两者分处宠物上/下两侧，合一个窗就得让那个窗横跨宠物全身，可交互面积大很多。
 */
const BADGE_SIZE = { width: 196, height: 28 };
/**
 * 胶囊窗**实际宽度**（页面按内容上报，见 ipcMain 'gpw:badge-width'）。
 *
 * 为什么宽度要自适应：宠物名字长度不定（"小蓝" / "大肥鱼一号"），写死宽度会把名字截掉。
 * 而**宽度不像高度那样受 Windows 最小值限制**（高度那次踩过死循环：期望 28、系统给 56、
 * 每 80ms 比一次就永远不等），所以宽度可以安全地按内容调。
 */
let badgeWidth = BADGE_SIZE.width;
/**
 * 输入框小窗尺寸。
 *
 * 2026-10-20：加了「本鱼 / 全体」按钮（约 56px 含间距），336 宽会把输入框挤到只有几十像素，
 * 所以整体加宽到 400 —— 高度不变（高度受 Windows 最小值限制，别乱动）。
 */
const INPUT_SIZE = { width: 400, height: 40 };
/** 输入框隐藏的宽限：从宠物身上移到输入框要跨过一段"两边都不在"的缝隙，给它时间 */
const INPUT_HIDE_GRACE_MS = 700;

let badgeWindow;
let inputWindow;
let lastPetHover = false; // 光标在宠物身上（宠物窗渲染端上报，见 pet:set-interactive）
let inputHover = false; // 光标在输入框窗上（它自己上报）
let inputVisible = false;
let lastWantInputAt = 0;

let lastPetSpot = null;
let hiddenForMove = false;
let stillSince = 0;
const MOVE_EPS = 3;
const STILL_MS = 350;

/**
 * 宠物身上的参考点。
 *
 * `feet` 是**脚底**而不是包围盒下缘：包围盒 = sprite 宽，而角色只占画布的一部分，
 * 下缘比脚底低约 100px（实测包围盒下缘 1740、脚底约 1482）。
 * 输入框要贴在脚底下方，就必须用脚底，否则会算到屏幕外面去（之前就是这么错的）。
 * 画布 640x360，角色脚底在画布 y≈335/360 处。
 */
function petAnchor() {
  const st = global.__gwPetStatesDump;
  if (!st || !(Number(st.size) > 0)) return null;
  const size = Number(st.size);
  const x = Number(st.x);
  const y = Number(st.y);
  /**
   * x/y 也必须校验。这里曾经只校验 size，而 `Number(undefined)` 是 NaN ——
   * NaN 一路传到 `setPosition(NaN, NaN)` 就抛
   * "Error processing argument at index 0, conversion failure"，
   * 未捕获 → Electron 弹**模态错误框** → 主进程被那个框阻塞 → 7341 API 全断、
   * 胶囊显示"插件离线"，看起来就像"卡死"（其实是被错误框顶住了）。
   */
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(size)) return null;
  return {
    x,
    y,
    size,
    top: y,
    right: x + size,
    feet: y + size * (360 / 640) * (335 / 360),
  };
}

const FALLBACK_POS = { x: 40, y: 40 };

function clampToWorkArea(b) {
  // 先把所有输入过一遍有限性检查：任何一个 NaN 都会让 setPosition/setBounds 抛错，
  // 而那个错会弹模态框把主进程顶死（见 petAnchor 的注释）
  const finite = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback);
  const width = finite(b.width, 0);
  const height = finite(b.height, 0);
  let x = finite(b.x, FALLBACK_POS.x);
  let y = finite(b.y, FALLBACK_POS.y);
  try {
    const wa = screen.getPrimaryDisplay().workArea;
    const wx = finite(wa.x, 0);
    const wy = finite(wa.y, 0);
    const ww = finite(wa.width, 0);
    const wh = finite(wa.height, 0);
    if (ww > 0 && wh > 0) {
      x = Math.max(wx, Math.min(x, wx + ww - width));
      y = Math.max(wy, Math.min(y, wy + wh - height));
    }
  } catch {
    /* 屏幕不可用就用上面的兜底值 */
  }
  return { x: Math.round(x), y: Math.round(y), width, height };
}

/** 胶囊位置：右缘对齐宠物右缘，底边在宠物框上缘稍上（即宠物右上角） */
function badgeBounds() {
  const a = petAnchor();
  if (a) {
    return clampToWorkArea({
      x: a.right - badgeWidth,
      y: a.top - 4 - BADGE_SIZE.height,
      width: badgeWidth,
      height: BADGE_SIZE.height,
    });
  }
  try {
    const wa = screen.getPrimaryDisplay().workArea;
    return { x: wa.x + wa.width - badgeWidth - 20, y: wa.y + 40, width: badgeWidth, height: BADGE_SIZE.height };
  } catch {
    return { x: 40, y: 40, width: badgeWidth, height: BADGE_SIZE.height };
  }
}

/**
 * 输入框位置：**宠物下方水平居中**（用户指定），顶边在宠物**脚底**下方。
 *
 * 脚底而不是包围盒下缘：包围盒含画布余量，下缘比脚底低约 100px（实测 1740 vs 1483），
 * 用下缘算会算到屏幕外。
 */
function inputBounds() {
  const a = petAnchor();
  if (a) {
    return clampToWorkArea({
      x: a.x + a.size / 2 - INPUT_SIZE.width / 2,
      y: a.feet + 4,
      width: INPUT_SIZE.width,
      height: INPUT_SIZE.height,
    });
  }
  try {
    const wa = screen.getPrimaryDisplay().workArea;
    return { x: wa.x + wa.width - INPUT_SIZE.width - 20, y: wa.y + wa.height - INPUT_SIZE.height - 20, width: INPUT_SIZE.width, height: INPUT_SIZE.height };
  } catch {
    return { x: 40, y: 200, width: INPUT_SIZE.width, height: INPUT_SIZE.height };
  }
}

/** 建一个"小、透明、永远可交互"的窗（两个小窗共用这套参数） */
function createTinyWindow({ bounds, file, preload, show }) {
  const win = new BrowserWindow({
    ...bounds,
    frame: false,
    transparent: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    show: false,
    // 必须可聚焦：输入框要能打字
    focusable: true,
    webPreferences: {
      preload: join(RUNTIME, 'electron-helper', preload),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  // **永远不穿透**：这正是独立成小窗的意义 —— 控件随时可点，且只占一小块
  win.setIgnoreMouseEvents(false);
  /**
   * 与宠物窗**同一级别**（screen-saver），而不是 floating。
   * 小窗要的是"永远压在别的程序之上"（用户看不到输入框就没法回话），
   * 而 floating 在这台机器上会被其它置顶窗压下去 —— 见 reassertTopmost 的说明。
   */
  win.setAlwaysOnTop(true, 'screen-saver');
  void win.loadFile(join(RUNTIME, 'electron-helper', file), {
    query: { plugin: pluginOriginNow(), port: String(PORT) },
  });
  if (show) win.once('ready-to-show', () => win.show());
  return win;
}

function createBadgeWindow() {
  if (badgeWindow && !badgeWindow.isDestroyed()) return badgeWindow;
  badgeWindow = createTinyWindow({
    bounds: badgeBounds(),
    file: 'badge.html',
    preload: 'badge-preload.cjs',
    show: true,
  });
  badgeWindow.on('closed', () => {
    badgeWindow = undefined;
  });
  log('「观察中」胶囊窗已建立（永远可交互，' + BADGE_SIZE.width + 'x' + BADGE_SIZE.height + '）');
  return badgeWindow;
}

function createInputWindow() {
  if (inputWindow && !inputWindow.isDestroyed()) return inputWindow;
  inputWindow = createTinyWindow({
    bounds: inputBounds(),
    file: 'input.html',
    preload: 'input-preload.cjs',
    show: false,
  });
  inputWindow.on('closed', () => {
    inputWindow = undefined;
    inputVisible = false;
  });
  log('悬浮输入框窗已建立（贴宠物脚底下方，平时隐藏，' + INPUT_SIZE.width + 'x' + INPUT_SIZE.height + '）');
  return inputWindow;
}

/** 光标在宠物身上（渲染端上报）→ 驱动输入框显示 */
ipcMain.on('pet:set-interactive', (_event, interactive) => {
  lastPetHover = interactive === true;
  if (lastPetHover) lastWantInputAt = Date.now();
});

/** 光标在输入框窗上（它自己上报） */
ipcMain.on('gpw:input-hover', (_event, on) => {
  inputHover = on === true;
  if (inputHover) lastWantInputAt = Date.now();
});

/**
 * 输入框可见性：**光标在宠物上 或 在输入框上** → 显示；都不是 → 宽限 700ms 后隐藏。
 *
 * 为什么宽限：从宠物身上把鼠标移到输入框，中间要跨过宠物的脚那一带，
 * 那一瞬间两个条件都是假，没有宽限的话输入框会在半路消失（够不到）。
 * 为什么隐藏用 hide() 而不是透明：透明窗**仍然拦点击**，而隐藏的窗完全不参与输入。
 */
function updateInputVisibility() {
  if (!inputWindow || inputWindow.isDestroyed()) return;
  const want = (lastPetHover || inputHover) && !hiddenForMove;
  if (want) {
    lastWantInputAt = Date.now();
    if (!inputVisible) {
      // 只挪位置，不设尺寸（尺寸建窗时已定；见循环里那段"别比尺寸"的注释）
      const ib = inputBounds();
      inputWindow.setPosition(ib.x, ib.y);
      // 显示这一刻就重申置顶：否则要等最多 2 秒的重申循环，期间可能被别的窗口压着
      inputWindow.setAlwaysOnTop(true, 'screen-saver');
      inputWindow.showInactive?.();
      inputVisible = true;
      inputWindow.webContents.send('gpw:input-shown');
    }
    return;
  }
  if (inputVisible && Date.now() - lastWantInputAt > INPUT_HIDE_GRACE_MS) {
    inputWindow.hide();
    inputVisible = false;
  }
}

/**
 * 主循环（80ms）：跟随宠物 + 移动时隐藏 + 输入框可见性。
 *
 * 移动时隐藏（用户提的方案，比"一直跟着"好）：
 *   ① 拖动/漫游时窗口位置逐帧变化，跟着走必然是"一跳一跳"，参数怎么调都难顺眼；
 *   ② 一块东西跟着宠物晃，视觉上比宠物自己动更烦；
 *   ③ 隐藏期间不占任何点击面积。
 * 判定不需要新信号：位置在变就是"在动"；3px 阈值滤掉待机动画自带的 1px 抖动。
 * 例外：**你正在用输入框时绝不隐藏**（inputHover），否则打到一半的输入会被抽走。
 */
setInterval(() => {
  try {
  const st = global.__gwPetStatesDump;
  const spot =
    st && Number.isFinite(Number(st.size)) && Number(st.size) > 0 && Number.isFinite(Number(st.x)) && Number.isFinite(Number(st.y))
      ? { x: Number(st.x), y: Number(st.y) }
      : null;
  const now = Date.now();

  if (spot) {
    const moved =
      lastPetSpot && (Math.abs(spot.x - lastPetSpot.x) > MOVE_EPS || Math.abs(spot.y - lastPetSpot.y) > MOVE_EPS);
    if (moved) {
      stillSince = 0;
      if (!inputHover && !hiddenForMove) {
        hiddenForMove = true;
        if (badgeWindow && !badgeWindow.isDestroyed()) badgeWindow.hide();
      }
    } else if (!stillSince) {
      stillSince = now;
    }
    lastPetSpot = spot;

    if (hiddenForMove && stillSince && now - stillSince > STILL_MS && !inputHover) {
      hiddenForMove = false;
      if (badgeWindow && !badgeWindow.isDestroyed()) badgeWindow.showInactive?.();
    }
  }

  /**
   * 跟随只挪位置，**绝不在这里比尺寸**。
   *
   * 踩过的坑（直接把主进程拖死）：Windows 对窗口高度有最小值（本机约 56px），
   * 我期望 28/40，于是 `getBounds().height` 永远返回 56 —— 写成
   * `if (cur.height !== b.height) setBounds(b)` 就变成"每 80ms 重设一次尺寸、
   * 被系统夹回、下一轮又不相等"的死循环。表现是整个副本主进程卡死、
   * 宠物 API 不通、胶囊显示"插件离线"（网络栈在主进程里）。
   *
   * 尺寸在**建窗时**定就好；运行期只需要 setPosition。
   */
  if (badgeWindow && !badgeWindow.isDestroyed()) {
    const b = badgeBounds();
    const cur = badgeWindow.getBounds();
    if (cur.x !== b.x || cur.y !== b.y) badgeWindow.setPosition(b.x, b.y);
  }

  if (inputWindow && !inputWindow.isDestroyed() && inputVisible) {
    const b = inputBounds();
    const cur = inputWindow.getBounds();
    if (cur.x !== b.x || cur.y !== b.y) inputWindow.setPosition(b.x, b.y);
  }

  updateInputVisibility();
  } catch (error) {
    // 单帧出错绝不能让循环停摆，更不能让它冒到顶层（顶层=模态框=看起来卡死）
    if (!global.__gwTickErrLogged) {
      global.__gwTickErrLogged = true;
      log('小窗循环出错（已吞掉，不影响宠物本体）：' + (error && error.message ? error.message : String(error)));
      try {
        require('node:fs').appendFileSync(
          require('node:path').join(require('node:os').tmpdir(), 'gpw-tick-error.log'),
          new Date().toISOString() + ' ' + String(error && error.stack ? error.stack : error) + String.fromCharCode(10),
        );
      } catch {
        /* 日志失败不影响运行 */
      }
    }
  }
}, 80).unref?.();

app.whenReady().then(() => setTimeout(() => {
  createBadgeWindow();
  createInputWindow();
}, 1500));
/**
 * 排障：把渲染端上报的"要不要可交互"记在 bootstrap 侧（同一进程，但注册在**另一个** ipcMain 上）。
 * 两个模块各注册一个监听、互不覆盖，正好用来确认消息有没有送达主进程。
 */
let interactCalls = 0;
let interactLast = null;
ipcMain.on('gpw:set-interactive', (_event, on) => {
  interactCalls += 1;
  interactLast = on === true;
});

/**
 * 屏幕↔页面倍率标定（浮层用）：把光标挪到给定页面坐标，读回真实屏幕坐标，比值即倍率。
 * 本机显示缩放 4×、Chromium 却报 dpr=1，靠这个量出来才能把悬停/命中判定对齐。
 * 标定后**还原光标**，别把用户的鼠标留在原地。
 */
ipcMain.handle('gpw:calibrate', (_event, pageX, pageY) => {
  try {
    const before = screen.getCursorScreenPoint();
    screen.setCursorScreenPoint(Math.round(pageX), Math.round(pageY));
    const after = screen.getCursorScreenPoint();
    screen.setCursorScreenPoint(before.x, before.y);
    if (Math.abs(pageX) < 1) return null;
    const factor = after.x / pageX;
    if (!Number.isFinite(factor) || factor <= 0.05 || factor > 20) return null;
    return { factor, sent: { x: pageX, y: pageY }, got: after };
  } catch (error) {
    return { error: String(error && error.message ? error.message : error) };
  }
});

ipcMain.handle('gpw:probe-window', () => ({
  pid: process.pid,
  // 排障：光标、真实屏幕、页面缩放。用三组读数反推各坐标系之间的倍率
  cursor: (() => { try { return screen.getCursorScreenPoint(); } catch { return null; } })(),
  // 排障：主进程眼里的宠物矩形（来自渲染端上报的 boxX/boxY/size）与每个窗口的穿透状态
  // 命中判定实时状态由 electron-helper-copy/main.js 写在 global 上（同一进程，跨模块共享）
  hit: global.__gpwHitDebug ?? null,
  /** 每个窗口当前是否穿透（true = 收不到鼠标输入）。排障"交互不灵"的直接读数 */
  windowIgnore: global.__gwIgnoreMirror ? Object.fromEntries(global.__gwIgnoreMirror) : null,
  /** 兜底判定有没有抛过异常（有的话说明它没在正常跑） */
  fallbackError: global.__gwFallbackError ?? null,
  /** 兜底判定用的光标空间（原始 DIP / 换算后 / 倍率），排障坐标不匹配用 */
  pointDump: global.__gwPointDump ?? null,
  /** 显示器缩放（Electron 视角） */
  primaryScaleFactor: (() => { try { return screen.getPrimaryDisplay().scaleFactor; } catch { return null; } })(),
  /** 副本兜底判定用的"额外可交互区"（输入框/胶囊/菜单），排障用 */
  extraRegions: global.__gwExtraRegions ?? null,
  /** 副本兜底判定手里的关键量：宠物框、窗口内锚点、光标、窗口矩形（排障交互卡死用） */
  ipcDiag: (() => {
    const ws = BrowserWindow.getAllWindows();
    const out = {};
    for (const w of ws) {
      const b = w.getBounds();
      out[w.id] = { bounds: { x: b.x, y: b.y, width: b.width, height: b.height } };
    }
    return { petStates: global.__gwPetStatesDump ?? null, extraRegions: global.__gwExtraRegions ?? null, localRects: global.__gwLocalRects ?? null, wins: out };
  })(),
  interact: { calls: interactCalls, last: interactLast, copy: global.__gpwIpcLast ?? null, copyCalls: global.__gpwIpcCalls ?? null },
  display: (() => { try { const d = screen.getPrimaryDisplay(); return { bounds: d.bounds, workArea: d.workArea, scale: d.scaleFactor }; } catch { return null; } })(),
  userRoot: USER_ROOT,
  port: PORT,
  windows: BrowserWindow.getAllWindows().map((win) => ({
    title: win.getTitle(),
    visible: win.isVisible(),
    bounds: win.getBounds(),
    // 关键读数：这窗口现在收不收鼠标输入（穿透=收不到 → 拖不动/点不了）。
    // windowIgnore 由副本自己的 setWindowIgnore 维护（它是唯一出口），镜像到 global 供这里读。
    ignoring: global.__gwIgnoreMirror ? global.__gwIgnoreMirror.get(win.id) : undefined,
  })),
}));

/**
 * 光标推送：每 120ms 把光标屏幕坐标发给宠物窗的浮层。
 *
 * 为什么必须由主进程推（而不是页面监听 mousemove）：窗口默认整窗点击穿透，
 * Windows 上 Electron 的 forward 鼠标事件并不可靠（原版 dsh-pet 就为这件事专门写了主进程兜底轮询）。
 * 悬停要不要浮出输入框，是这套 UI 的入口，不能赌渲染端收得到。
 */
setInterval(() => {
  try {
    const point = screen.getCursorScreenPoint();
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      if (!win.webContents.getURL().includes('index-gpw')) continue;
      // 连窗口外框一起发：渲染端用 (光标 - 窗口原点) 得到窗口内坐标，
      // 不靠 window.screenX（多屏/缩放场景下它和物理像素不是一套）
      win.webContents.send('gpw:cursor', { x: point.x, y: point.y, bounds: win.getBounds() });
    }
  } catch {
    /* 屏幕不可用（注销/锁屏）时忽略这一拍 */
  }
}, 60);

/**
 * ⚠️ 这里**刻意没有**任何"窗口位置纠正"逻辑，别加回来。
 *
 * 曾经的错误做法：启动后按"页面报告的屏幕尺寸 ÷ 缩放"把窗口挪到右下角，还每 2 秒重申一次。
 * 两个后果都实测到了：
 *   1. 拖拽中途被按回角落（"拖着拖着隔一会儿自己弹回中间"）——渲染端逐帧上报位置、主进程跟着移动，
 *      任何外部 setBounds 都会把这一轮拖拽打断；
 *   2. **重启后第一次移动会跳到别的位置**——纠正把窗口挪了，而渲染端不知道，仍按旧坐标系算拖拽偏移，
 *      于是第一次交互的落点整体偏掉，之后就"看起来正常"了。
 * 窗口位置本来由原版助手按桌面几何算好（实测 640×515 @ 504,679，宠物就在屏内右下角），
 * 不需要我们插手。真要调位置，请改副本自己的 pet-config.json 里的 position。
 */

// ---- 最后：让原版助手的窗口代码接管（它自带 app.whenReady、窗口创建、点击穿透、物理）----
require(join(HELPER_COPY, 'main.js'));

// 置顶管理要在窗口建好之后跑（原版代码的 whenReady 会建窗，这里排它后面）
app.whenReady().then(() => setTimeout(startPinWatch, 1200));

/**
 * 置顶固定（小钉按钮）——为什么需要"管理器"而不是设一次就算：
 *
 * 原版只在建窗时 `setAlwaysOnTop(true, 'screen-saver')` 一次，之后再也不管。
 * Windows 上"置顶"是一条**共享的 topmost 带**：任何同样置顶的窗口之后设一次（或被激活）
 * 就会插到它前面——表现就是"置顶不稳定，有时候被盖住"。实测场景：我自己的观察面板窗
 * （floating 级）打开一次就盖住了宠物。
 *
 * 所以这里做两件事：
 *   1. 定时**重申**（2 秒一次）——重申会把窗口顶回 topmost 带的最前，成本一次系统调用
 *   2. 状态**持久化**到 USER_ROOT/pin.json，按钮点一次就一直有效；关掉则彻底不置顶
 */
const PIN_FILE = join(USER_ROOT, 'pin.json');
/**
 * 交互锁定状态，**默认 false**（= 不锁定 = 窗口穿透，正常用电脑）。
 * 为什么默认必须是 false：锁定开着时这个铺满屏幕的透明窗会收鼠标输入，
 * 表现就是"别的窗口点不动"——这正是最不能出现的回归。要碰宠物时点状态胶囊上的 📌。
 */
let pinned = false;

function loadPin() {
  try {
    const raw = JSON.parse(readFileSync(PIN_FILE, 'utf8'));
    if (typeof raw?.pinned === 'boolean') pinned = raw.pinned;
  } catch {
    /* 首次运行：不锁定 */
  }
}

function savePin() {
  try {
    require('node:fs').writeFileSync(PIN_FILE, JSON.stringify({ pinned }, null, 2), 'utf8');
  } catch {
    /* 落盘失败不影响本次运行 */
  }
}

function petWindows() {
  return BrowserWindow.getAllWindows().filter(
    (win) => !win.isDestroyed() && win.webContents.getURL().includes('index-gpw'),
  );
}

function applyPinTo(win) {
  if (win.isDestroyed()) return;
  win.setAlwaysOnTop(true, 'screen-saver');
  /**
   * ⚠️ 这里**不要**再碰点击穿透（历史教训，别加回来）。
   *
   * 曾经这里在 pinned 时调 `win.setIgnoreMouseEvents(false, { forward: true })`，本意是
   * "交互锁定"（宠物点不动时用图钉强制可交互）。但它和副本里那条**每 60ms 的自动穿透判定**
   * 在同一个窗口上互相打架：这条每 2 秒设"可交互"，那条每 60ms 按光标位置设回"穿透"。
   * 后果有两层：
   *   ① 锁看起来"按了没效果"（60ms 那条几乎总是后发制人）；
   *   ② 每 2 秒有一瞬间窗口真的变成可交互，而这是个 1080x869 的**大透明窗**，
   *      那一瞬间就挡住底下所有程序 —— 用户报的"图钉能点、底下窗口点不了"。
   *
   * 结论：穿透只能有一个控制器（副本的自动判定，原版设计）。
   * 想"随时能点到宠物旁边的控件"，正确做法是把那些控件放进**独立的小窗**
   * （永远可交互、只占一小块），而不是让大窗整体变成可交互。
   */
  if (pinned) win.setVisibleOnAllWorkspaces?.(true, { visibleOnFullScreen: true });
}

/**
 * 交互锁定：把宠物窗强制设为"可交互"（不再点击穿透）。
 *
 * 为什么需要它：点击穿透的自动判定依赖"屏幕坐标 ↔ 页面坐标"的换算，而这台机器上
 * 那套换算有 4 倍量级的偏差（Chromium 报 dpr=1，实际显示缩放 4×），
 * 自动判定因此时对时错；错在"该交互时不交互"时，宠物就完全点不到、也拖不动。
 * 这个开关是**兜底通道**：需要碰宠物（拖动它、在输入框打字）时打开，用完关掉。
 */
function setPinned(next) {
  pinned = next === true;
  savePin();
  for (const win of petWindows()) applyPinTo(win);
  log('交互锁定 = ' + (pinned ? '开（窗口可交互）' : '关（恢复自动穿透）'));
  return pinned;
}

/**
 * 把"我们自己所有该在最前面的窗"重申一遍置顶。
 *
 * 为什么输入框/胶囊也要重申（用户报"下面的对话框有时候会被别的窗口盖过去"）：
 *   Windows 上"置顶"是**一条共享的 topmost 带** —— 任何之后被激活/重申的置顶窗口都会
 *   插到这条带的最前面。宠物窗因为每 2 秒重申一次，所以一直可见；而两个小窗当初只设了
 *   一次 `floating`，之后再没人管，于是会被别的置顶窗口（游戏、别的工具）压下去。
 *   现在它们跟宠物窗同属一个重申循环，且**排在宠物窗之后**（小窗在大窗之上，不会被宠物压住）。
 *
 * 只用 setAlwaysOnTop 重申：它**不会**激活窗口、不抢焦点（打字时不会被抢走）。
 */
function reassertTopmost() {
  for (const win of petWindows()) applyPinTo(win);
  for (const win of [badgeWindow, inputWindow]) {
    if (win && !win.isDestroyed()) win.setAlwaysOnTop(true, 'screen-saver');
  }
}

function startPinWatch() {
  loadPin();
  const tick = () => reassertTopmost();
  tick();
  log('置顶重申已启动：宠物窗 + 状态胶囊 + 悬浮输入框（每 2 秒一次）');
  // 面板窗永远 floating 就好（它是管理窗，不需要压过宠物）；宠物窗与两个小窗走同一条重申
  setInterval(tick, 2000).unref?.();
  app.on('browser-window-created', (_event, win) => {
    win.webContents.once('did-finish-load', () => {
      if (win.webContents.getURL().includes('index-gpw')) applyPinTo(win);
    });
  });
}

/**
 * 胶囊按内容上报宽度：只在**真的变了**时设一次窗口尺寸。
 *
 * 高度取**当前实际值**（getBounds().height）而不是期望值 —— Windows 会把高度夹到最小值，
 * 拿期望值去设就会变成"每次都不同、每次都重设"的死循环（那是把整个副本拖死过的 bug）。
 */
ipcMain.on('gpw:badge-width', (_event, width) => {
  const next = Math.round(Number(width));
  if (!Number.isFinite(next) || next < 120 || next > 620) return;
  if (next === badgeWidth) return;
  badgeWidth = next;
  const win = badgeWindow;
  if (!win || win.isDestroyed()) return;
  const cur = win.getBounds();
  const target = badgeBounds();
  win.setBounds({ x: target.x, y: target.y, width: badgeWidth, height: cur.height });
});

ipcMain.on('gpw:set-pin', (_event, next) => {
  setPinned(next);
});
ipcMain.handle('gpw:get-pin', () => pinned);

/**
 * 宠物尺寸改动后的"重建自己"。
 *
 * 为什么必须重建：sprite 的 `--pet-size` 与宠物窗尺寸都在窗口建立时由 `pet.size` 推出
 * （原版设计如此），运行期改不了——只能按新尺寸重开。
 *
 * 为什么用 app.relaunch()：它会用**当前进程的原始参数与环境**重开，所以
 *   - 插件拉起时带的 `--remote-debugging-port`（如果设了 GPW_DEBUG_PORT）会保留；
 *   - GPW_UPSTREAM_ROOT / GPW_PORT / GPW_USER_ROOT 等一路继承；
 * 比我自己拼一套 spawn 更不容易漏参数。relaunch + exit 之后新进程会重读 prefs.json，
 * 于是新尺寸立即生效。
 */
prefs.apply = () => {
  try {
    log(`宠物尺寸改为 ${prefs.get().petSize}px，重建窗口…`);
    app.relaunch();
    app.exit(0);
  } catch (error) {
    log('重建失败：' + (error?.message ?? error));
  }
};

/**
 * 重建后把宠物窗夹回屏幕内（**只在启动时做一次**）。
 *
 * 为什么需要：尺寸改大后窗口跟着变大（700px 时实测 1400x1127），而原版是按"角落 + 边距"算锚点的，
 * 窗口变大就可能顶出屏幕（实测 @645,-29，上边缘在屏外，宠物被切）。
 *
 * 为什么只做一次、且必须在渲染端上报之前：窗口位置在渲染端是有状态的（它按窗口坐标算拖拽偏移）。
 * 运行期持续纠正会导致"拖到一半被拉回"和"重启后第一次移动跳位"——这两个 bug 都实测到过
 * （见 gpw-main 里被删掉的那两版纠正的注释）。这里只在建窗瞬间摆一次，渲染端首帧读到的就是最终位置。
 */
app.on('browser-window-created', (_event, win) => {
  win.webContents.once('did-finish-load', () => {
    if (!win.webContents.getURL().includes('index-gpw')) return;
    const b = win.getBounds();
    let area;
    try {
      area = screen.getPrimaryDisplay().workArea;
    } catch {
      return;
    }
    const x = Math.max(area.x, Math.min(b.x, area.x + area.width - b.width));
    const y = Math.max(area.y, Math.min(b.y, area.y + area.height - b.height));
    if (x !== b.x || y !== b.y) {
      win.setBounds({ x, y, width: b.width, height: b.height });
      log(`宠物窗夹回屏内 ${x},${y}（原 ${b.x},${b.y}，窗口 ${b.width}x${b.height}）`);
    }
  });
});

/**
 * **宠物间碰撞：坐标上报**（多鱼之后才有意义）
 *
 * 每只鱼是独立进程 + 透明大窗口，原版的碰撞 broker 只在同一进程内有效，
 * 跨进程看不见对方。这里只做**上报**：把宠物的屏幕包围盒每 500ms 发给大脑（插件），
 * 由插件当裁判（`/game-pet-watch/rects`）—— 它知道所有鱼，判定重叠后往两边各推一句本地台词。
 *
 * 为什么只上报、不自己判：判定/反应只写一处（插件），两边不会各写一套逻辑走偏；
 * 而且这里完全不动窗口位置（宠物固定在画布右下角），**零渲染风险**。
 *
 * 包围盒怎么算：宠物钉在画布**右下角**（见 gpw-preload.cjs 的说明），
 * 所以取窗口右下角一个 `petSize` 见方的方块即可（略去 sprite 的内外边距，判碰撞足够）。
 */
app.on('browser-window-created', (_event, win) => {
  win.webContents.once('did-finish-load', () => {
    if (!win.webContents.getURL().includes('index-gpw')) return;
    const fishId = String(process.env.GPW_FISH_ID || process.env.GPW_PET_ID || PET_ID || '').trim();
    if (!fishId) {
      log('碰撞上报：没有 fishId，跳过');
      return;
    }
    /**
     * ⚠️ **每次现算，不能只算一次**（2026-10-18 实测）：这里原来把 endpoint 冻在
     * `did-finish-load` 那一刻，而那一刻插件**很可能还没学到自己的端口**（registry 里是上一次的
     * 旧端口 / env 还没更新）→ 冻成一个死地址 → **注入循环永远失败**；而 `reportOwnRect` 每次
     * 都重算 origin 所以坐标上报正常 → 表现就是"账本对、站场里永远只有自己"（线上复现）。
     */
    const endpointOf = () => pluginOriginNow() + '/game-pet-watch/rects';
    /** 与 pet:set-bounds 同进程同模块实例（gpw-main 早先已经 require 过 copy 版） */
    const bridge = require(join(HELPER_COPY, 'main.js'));
    let logged = false;
    /**
     * 这里**只做一件事**：把插件 `/rects` 里登记的对家喂进本进程的碰撞站场。
     *
     * 自己的盒子由 `electron-helper-copy/main.js` 在 `pet:set-bounds` 里直接上报（渲染端的
     * 真身盒，物理像素）；这里绝不能再按 `win.getBounds()` 报一次 —— 那是 DIP，180 会盖掉 540。
     * 也不再 `require('./electron-helper/main.js')`：那份没人加载，require 会把它**重新执行**一遍
     * 并抛 `disableHardwareAcceleration` 错（曾经"完全没有判定"就死在这）。
     */
    /**
     * 已经喂进站场的对家 id。用来在"对家关掉"时把它**删掉** ——
     * 只增不删的话，那只鱼关了、插件账本也清了，渲染端还留着它的旧包围盒，
     * 站在那个位置照样会被撞（主人报的"鱼关了碰撞体积还在"）。
     */
    const injected = new Set();
    const timer = setInterval(async () => {
      if (win.isDestroyed()) {
        clearInterval(timer);
        return;
      }
      try {
        const listRes = await fetch(endpointOf(), { signal: AbortSignal.timeout(2000) });
        const list = await listRes.json().catch(() => ({}));
        const inject = bridge.setExternalPetState;
        if (typeof inject !== 'function') return;
        // 自己的账本 id 以插件归一化的结果为准（env 里的 fishId 可能不是鱼表 id）
        const selfId = (typeof bridge.getSelfRectId === 'function' && bridge.getSelfRectId()) || fishId;
        const seen = new Set();
        for (const [pid, r] of Object.entries((list && list.rects) || {})) {
          if (!r || pid === selfId || pid === fishId) continue;
          if (r.alive === false) continue; // 5 秒没上报 = 已经关了/掉了，交给下面的清理删掉
          /**
           * **自己再判一次"多久没上报"**（不依赖插件的 alive 字段）：
           * 存活的对家每 900ms 报一次，超过 3 秒没更新 = 已经关了/崩了。
           * 这样"鱼关了、体积还在"最多 3 秒就消失，不用等插件的 5 秒判定或 60 秒清理。
           */
          if (Date.now() - (Number(r.at) || 0) > 3000) continue;
          // size 用上报的 rect.w（真值 540 级），坐标原样用，不做任何窗口换算
          inject(pid, {
            x: r.x,
            y: r.y,
            vx: Number(r.vx) || 0,
            vy: Number(r.vy) || 0,
            size: Number(r.w) || 0,
            bottomPad: Number(r.bottomPad) || 0,
          });
          seen.add(pid);
        }
        // 清掉"上次在、这次不在"的对家（关掉的鱼 / 插件重启后账本清空 / 被鱼表移除）
        const remove = bridge.removeExternalPetState;
        if (typeof remove === 'function') {
          for (const pid of [...injected]) {
            if (seen.has(pid)) continue;
            try {
              remove(pid);
            } catch {
              /* 删失败就算了，下次还会再试 */
            }
            injected.delete(pid);
            log(`碰撞对家已离场，删掉它的包围盒：${pid}`);
          }
        }
        for (const pid of seen) injected.add(pid);
        if (seen.size && !logged) {
          logged = true;
          log(`碰撞对家已注入站场：${seen.size} 个（本鱼 ${fishId}）`);
        }
      } catch {
        /* 注入失败不影响宠物 */
      }
    }, 120);
    win.on('closed', () => clearInterval(timer));
  });
});
