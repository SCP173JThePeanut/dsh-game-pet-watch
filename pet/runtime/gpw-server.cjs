/**
 * dsh-pet-gpw —— 独立副本自己的宠物 API 服务（CommonJS，跑在 Electron 主进程里）。
 *
 * 为什么需要它：桌面宠物渲染端只认一个 HTTP 契约（原版由 dsh-pet 的宿主 WebServer 提供）：
 *   GET  /dsh-pet-7340/config          成品配置（renderer 拍平成宠物列表）
 *   GET  /dsh-pet-7340/state           统一状态 S（1s 轮询的**唯一**数据源；说话/动画叶子都在这）
 *   GET  /dsh-pet-7340/thumb/<根>/<名>.webm   动画素材
 *   GET  /dsh-pet-7340/font/<名>.ttf          气泡字体
 *   GET  /dsh-pet-7340/pic/<名>.png           光标等图片
 *
 * 素材从**原版 dsh-pet** 的包目录读（不复制 61MB）；配置从副本自己的目录读。
 * 另加两个副本专有端点，供我的插件（dsh-game-pet-watch）推话与读回话：
 *   POST /gpw/say   { text }      写 pets.<id>.say → 宠物气泡 10s + 说话动画
 *   GET  /gpw/log                 最近的说话记录（面板历史用）
 */
'use strict';

const http = require('node:http');
const { readFile, writeFile, mkdir } = require('node:fs/promises');
const { existsSync, createReadStream, statSync, readFileSync } = require('node:fs');
const { join, extname, normalize } = require('node:path');
const { readMergedConfig } = require('./gpw-config.cjs');

const PET_PREFIX = '/dsh-pet-7340';
const MIME = {
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
};

/** 状态文件：面板/插件都能读的说话记录与当前气泡 */
function createStateStore(file) {
    const state = {
    v: 1,
    sections: {},
    pets: {},
    log: [],
    cursors: { say: 0, anim: 0, sections: {} },
  };
  let timer;
  let dirty = false;

  async function load() {
    try {
      const raw = JSON.parse(await readFile(file, 'utf8'));
      if (raw && typeof raw === 'object') {
        state.sections = raw.sections && typeof raw.sections === 'object' ? raw.sections : {};
        state.pets = raw.pets && typeof raw.pets === 'object' ? raw.pets : {};
        state.log = Array.isArray(raw.log) ? raw.log.slice(-200) : [];
        state.cursors = raw.cursors && typeof raw.cursors === 'object' ? raw.cursors : state.cursors;
      }
    } catch {
      /* 首次运行没有文件：用内存里的空状态 */
    }
  }

  function schedule() {
    dirty = true;
    if (timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (!dirty) return;
      dirty = false;
      void flush();
    }, 400);
  }

  async function flush() {
    try {
      await mkdir(join(file, '..'), { recursive: true });
      await writeFile(file, JSON.stringify(state, null, 2), 'utf8');
    } catch {
      /* 落盘失败不影响运行 */
    }
  }

  return {
    state,
    load,
    /** 写一只宠物的一个叶子（counter 自增 → 渲染端据此触发） */
    writePet(petId, leaf, data) {
      const entry = (state.pets[petId] = state.pets[petId] || {});
      const counter = Number(entry[leaf]?.counter ?? 0) + 1;
      entry[leaf] = { counter, data: data ?? null };
      if (leaf === 'say' && data && typeof data.text === 'string') {
        /**
         * 说话记录（鱼板网络的数据源之一）：
         *   - 带 `image`：配图名一起同步，对端复制这条时能连图一起复现
         *   - 记录本身随 state.json 持久化（state.log 就是它的一部分，不用另开文件）
         */
        const entry = {
          at: Date.now(),
          petId,
          text: data.text,
          ...(typeof data.image === 'string' && data.image ? { image: data.image } : {}),
        };
        state.log.push(entry);
        if (state.log.length > 200) state.log.splice(0, state.log.length - 200);
      }
      schedule();
      return counter;
    },
    writeSection(name, data) {
      const counter = Number(state.sections[name]?.counter ?? 0) + 1;
      state.sections[name] = { counter, data: data ?? null };
      schedule();
      return counter;
    },
    /**
     * 往**共享说话记录**里追加一条非宠物来源的消息（主人 / 系统）。
     *
     * 为什么需要：主人打字时，那只宠物的插件会收到 `/ask`，但**另一只收不到** ——
     * 它们之间唯一的共享通道就是这份 log（每只插件都在轮询各端口的 `/gpw/log`）。
     * 所以「主人 → 目标」的消息必须写进这里，两边才都能看见。
     *
     * `who` 明确写「主人」：接收端**必须认这条字段**（不能按"来源端口"推断说话者，
     * 否则主人的话会被当成宠物自己说的 —— 那正是我们踩过的坑）。
     * `to` 是目标：`'*'` 表示全体，具体名字表示只对某只说。
     */
    appendLog(entry) {
      if (!entry || typeof entry.text !== 'string' || !entry.text.trim()) return 0;
      const record = {
        at: Number.isFinite(entry.at) ? entry.at : Date.now(),
        who: typeof entry.who === 'string' && entry.who.trim() ? entry.who.trim() : '主人',
        text: entry.text.trim(),
        ...(typeof entry.to === 'string' && entry.to ? { to: entry.to } : {}),
        ...(typeof entry.image === 'string' && entry.image ? { image: entry.image } : {}),
      };
      state.log.push(record);
      if (state.log.length > 200) state.log.splice(0, state.log.length - 200);
      schedule();
      return 1;
    },
    snapshot() {
      return { sections: state.sections, pets: state.pets };
    },
    log: (limit) => state.log.slice(-(limit || 20)),
  };
}

/**
 * 起服务。
 * @param {{port:number, petAssetsRoot:string, configFile:string, stateFile:string,
 *          memeDirs?:string[], log?:(m:string)=>void}} options
 */
async function startPetServer(options) {
  const store = createStateStore(options.stateFile);
  await store.load();

  /**
   * **CORS**（2026-10-18 修：浮层一直显示"插件离线"）。
   *
   * 浮层页面是 `win.loadFile(...)` 加载的 —— 也就是 **file:// 源**。它要跨源读两样东西：
   *   1. 宠物自己的 `/gpw/brand`（拿"当前插件地址"）；
   *   2. 宿主的 `/game-pet-watch/state`（插件那边已经加了 CORS）。
   * 没有 `Access-Control-Allow-Origin` 时浏览器**会发出请求但不给读响应** → catch → 判离线。
   * 只监听 127.0.0.1、纯本机用途，放开 `*` 没问题。
   */
  const CORS = {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '600',
  };

  const sendJson = (res, status, obj) => {
    const body = JSON.stringify(obj);
    try {
      res.writeHead(status, { 'content-type': MIME['.json'], 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store', ...CORS });
      res.end(body);
    } catch (error) {
      // 客户端中途断开（例如测的人提前关了管道）：不能让它把上层逻辑掀翻
      options.log?.('sendJson: 客户端已断开（' + (error && error.code ? error.code : error) + '）');
    }
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

  /** 只允许读素材根内的文件（防 ../ 逃逸） */
  const safeJoin = (root, rel) => {
    const full = normalize(join(root, rel));
    return full.startsWith(normalize(root)) ? full : undefined;
  };

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      const path = decodeURIComponent(url.pathname);
      const method = req.method || 'GET';
      if (process.env.GPW_HTTP_LOG === '1') options.log?.(`HTTP ${method} ${path}`);

      /** CORS 预检（浮层是 file:// 页面，POST 前会先发 OPTIONS） */
      if (method === 'OPTIONS') {
        res.writeHead(204, CORS);
        res.end();
        return;
      }

      // ---- 副本专有：插件推话 / 读记录
      /**
       * POST /gpw/master  { text, to? }  → 把「主人的话」写进共享记录（**不显示成宠物的气泡**）。
       *
       * 这是"两边都能收到主人消息"的通道：插件收到主人打字后调这里，
       * 另一只宠物的插件轮询本端口 `/gpw/log` 时就会看到（`who:'主人'`、`to:'*'|名字`）。
       */
      if (path === '/gpw/master') {
        try {
          const body = JSON.parse((await readBody(req)) || '{}');
          const text = typeof body.text === 'string' ? body.text.trim() : '';
          if (!text) return sendJson(res, 400, { error: 'text required' });
          const to = typeof body.to === 'string' && body.to.trim() ? body.to.trim() : '*';
          const written = store.appendLog({ who: '主人', text, to });
          // 用 options.log：这个文件里没有裸 `log` 作用域（写成裸的会在请求时 ReferenceError，
          // 冒烟检查就是抓这个的 —— 这正是刚发生的事）
          options.log?.(`主人 → ${to === '*' ? '全体' : to}：${text.slice(0, 40)}`);
          return sendJson(res, 200, { ok: true, written, to });
        } catch (error) {
          return sendJson(res, 400, { error: String(error?.message ?? error) });
        }
      }

      if (path === '/gpw/say') {
        if (method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
        let payload = {};
        try {
          payload = JSON.parse((await readBody(req)) || '{}');
        } catch {
          return sendJson(res, 400, { error: 'invalid JSON body' });
        }
        const text = typeof payload.text === 'string' ? payload.text.trim() : '';
        if (!text) return sendJson(res, 200, { ok: false, message: 'text 为空' });
        const petId = String(payload.pet || options.petId || 'main');
        // image = 表情包名（客户端拼成 /pic/memes/<名>.png 渲染在气泡文字上方）。
        // 只透传字符串；模型选的名字由插件侧对目录校验过（防幻觉出目录外的名字）。
        const image = typeof payload.image === 'string' && payload.image.trim() ? payload.image.trim() : undefined;
        const counter = store.writePet(petId, 'say', image ? { text, image } : { text });
        return sendJson(res, 200, { ok: true, petId, counter, image: image ?? null });
      }
      /**
       * 鱼板网络握手：`GET /gpw/brand` → 这只宠物的身份。
       *
       * 为什么需要它：发现对等体时**必须能区分"这是我"和"那是别人"**。
       * 光探测 /gpw/state 会认错（我们刚踩过：插件扫端口时认领了另一只鱼）。
       * 这里给出 name/port/pid，配合"自己的端口必须由配置/默认值确定"这条规则，
       * 就不会再出现认错的情况。
       */
      /**
       * **碰撞推开**：`POST /gpw/nudge {dx, dy}` → 把宠物窗按方向**挪几个像素**。
       *
       * 为什么需要：多鱼之后两只鱼在**两个独立进程**里，各自的主进程碰撞 broker 只看得见自己 ✗。
       * 由大脑（插件）当裁判 ✓：它比对两只鱼的屏幕包围盒 ✓，重叠就各推一点（方向相反）✓。
       * 这里只做"挪窗口"这一个动作 ✓ —— 不碰渲染、不碰 sprite ✓，所以风险极低 ✓，
       * 而且 `dx/dy` 由调用方给（插件），副本不需要知道任何碰撞规则 ✓。
       *
       * 实现交给 `options.nudge`（gpw-main 里拿到宠物窗 ✓ 并做屏幕内夹取 ✓）。
       */
      if (path === '/gpw/nudge') {
        if (method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
        if (typeof options.nudge !== 'function') return sendJson(res, 501, { error: '副本没装推开通道' });
        let payload = {};
        try {
          payload = JSON.parse((await readBody(req)) || '{}');
        } catch {
          return sendJson(res, 400, { error: 'invalid JSON body' });
        }
        const dx = Math.max(-64, Math.min(64, Number(payload.dx) || 0));
        const dy = Math.max(-64, Math.min(64, Number(payload.dy) || 0));
        if (!dx && !dy) return sendJson(res, 400, { ok: false, error: 'dx/dy 不能都是 0' });
        const result = options.nudge({ dx, dy });
        return sendJson(res, 200, { ok: true, dx, dy, ...(result || {}) });
      }

      /**
       * **触发碰撞反应**（把原版那条冲量消息从外面发一次）：
       * `POST /gpw/hit {vx, vy}` → 主进程 `win.webContents.send('pet:hit', {vx,vy})` ✓
       * 渲染端本来就在监听 `pet:hit` ✓（原版撞击后也是发这条 ✓）→ 于是本体真的会弹开 ✓。
       */
      /** 只读诊断：碰撞站场里现在有谁、自己那只的真实盒子、petCollision 开没开 */
      if (path === '/gpw/collide-debug') {
        return sendJson(res, 200, { ok: true, ...(typeof options.collideDebug === 'function' ? options.collideDebug() : {}) });
      }

      if (path === '/gpw/hit') {
        if (method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
        if (typeof options.hit !== 'function') return sendJson(res, 501, { error: '副本没装撞击通道' });
        let payload = {};
        try {
          payload = JSON.parse((await readBody(req)) || '{}');
        } catch {
          return sendJson(res, 400, { error: 'invalid JSON body' });
        }
        /**
         * **冲量上限从 ±12 放到 ±120**（2026-10-18 修）。
         *
         * ±12 是原版单进程时期拍的"安全值"，但多鱼是跨进程、由插件当裁判：
         * 插件算出来的分离速度（默认 18，档位最高 192）全被这个 12 削平 →
         * 撞上去纹丝不动（"撞不开另一方"就是这个）。现在只挡离谱值，正常力度都放行。
         */
        const LIMIT = 400;
        const vx = Math.max(-LIMIT, Math.min(LIMIT, Number(payload.vx) || 0));
        const vy = Math.max(-LIMIT, Math.min(LIMIT, Number(payload.vy) || 0));
        if (!vx && !vy) return sendJson(res, 400, { ok: false, error: 'vx/vy 不能都是 0' });
        return sendJson(res, 200, { ok: true, vx, vy, ...(options.hit({ vx, vy }) || {}) });
      }

      if (path === '/gpw/brand') {
        /**
         * fish-board/2：多了两个**身份字段**（scope / fishId）。
         *
         * 为什么需要：上了多鱼之后，"name + port"理论上够用，但 name 是主人可改的显示名，
         * 两只鱼取同名时对等体就分不清了 ✗；而插件侧的记忆/历史是按 **scope** 存的
         * （memory-<scope>.json、image-catalog-<scope>.json）。把 scope 放进握手，
         * 对等体就能直接按"这是哪条鱼"归属内容，不用猜 ✗→✓。
         *
         * 来源：启动 env（GPW_FISH_SCOPE / GPW_FISH_ID，由插件的 launcher 注入 ✓）。
         * 老版本不认这两个字段也不影响 ✓（新字段是加法 ✓，version 不同只影响"要不要当对等体"）。
         */
        return sendJson(res, 200, {
          ok: true,
          protocol: 'fish-board/2',
          name: (options.prefs && options.prefs.get && options.prefs.get().petName) || '',
          petId: options.petId || 'gpw',
          scope: String(process.env.GPW_FISH_SCOPE || ''),
          fishId: String(process.env.GPW_FISH_ID || options.petId || 'gpw'),
          port: options.port,
          pid: process.pid,
          version: 'dsh-pet-gpw',
          /**
           * **我们这条鱼回连插件用的地址**（对端要推 `/rects` / `/hit` 时用它，别猜端口）。
           *
           * 取值顺序和本进程实际用的保持一致：`options.pluginOrigin()`（它会先看公共登记簿、
           * 再看 env，见 gpw-main.cjs 的同名函数）→ 老版本没有这个函数时退回 env。
           * 这是给 Fish Board 对端（opencode 那侧的跨栈桥）用的加法字段，老对端忽略即可。
           */
          pluginOrigin: String(
            (typeof options.pluginOrigin === 'function' ? options.pluginOrigin() : process.env.GPW_PLUGIN_ORIGIN) || '',
          ).replace(/\/+$/, ''),
          uptimeMs: Math.round(process.uptime() * 1000),
        });
      }
      if (path === '/gpw/log') {
        return sendJson(res, 200, { ok: true, entries: store.log(Number(url.searchParams.get('limit') || 20)) });
      }
      /**
       * 偏好（尺寸/文字大小）：GET 读 / POST 存。
       *
       * 为什么放在副本自己的服务里：这两项是**副本窗口自己的呈现参数**，与插件那套（截屏/模型）
       * 无关；存成 ~/.dsh/dsh-pet-gpw/prefs.json，重启副本时由 gpw-main 读取并生效。
       *
       * 注意 petSize 的生效方式：宠物尺寸在窗口建立时就固定了（sprite 的 --pet-size 与窗口尺寸
       * 都由 pet.size 推出），改它必须**重建宠物窗**——所以 POST 里带 applyNow 时调
       * options.prefs.apply()（gpw-main 实现为"自己重新拉起 + 退出"）。
       */
      if (path === '/gpw/prefs') {
        if (!options.prefs) return sendJson(res, 501, { error: '副本没装偏好存储' });
        if (method === 'GET') return sendJson(res, 200, { ok: true, prefs: options.prefs.get() });
        if (method === 'POST') {
          let payload = {};
          try {
            payload = JSON.parse((await readBody(req)) || '{}');
          } catch {
            return sendJson(res, 400, { error: 'invalid JSON body' });
          }
          const next = options.prefs.set(payload);
          const needRebuild = next.rebuild === true;
          if (needRebuild && typeof options.prefs.apply === 'function') {
            // 先回响应再重建：重建会结束本进程，回了响应面板才不会当成失败
            sendJson(res, 200, { ok: true, prefs: next.prefs, rebuilding: true });
            setTimeout(() => options.prefs.apply(), 400);
            return undefined;
          }
          return sendJson(res, 200, { ok: true, prefs: next.prefs, rebuilding: false });
        }
        return sendJson(res, 405, { error: 'method not allowed' });
      }
      /**
       * 置顶固定开关：GET 读状态 / POST { pinned: boolean } 切换。
       * 实际生效在 gpw-main.cjs 的置顶管理器（它每 2 秒重申一次，防止被别的置顶窗盖住）。
       */
      if (path === '/gpw/pin') {
        if (!options.pin) return sendJson(res, 501, { error: '副本没装置顶管理器' });
        if (method === 'GET') return sendJson(res, 200, { ok: true, pinned: options.pin.get() });
        if (method === 'POST') {
          let payload = {};
          try {
            payload = JSON.parse((await readBody(req)) || '{}');
          } catch {
            return sendJson(res, 400, { error: 'invalid JSON body' });
          }
          const next = options.pin.set(payload.pinned === true);
          return sendJson(res, 200, { ok: true, pinned: next });
        }
        return sendJson(res, 405, { error: 'method not allowed' });
      }
      /**
       * 抽帧拼图：/gpw/sheet?file=<动画文件名>&cols=&rows=&tileW=
       *
       * 把一段 webm 的若干帧拼成一张**带时间标签**的九宫格 PNG，落到磁盘并返回路径 + 元数据。
       * 解码交给主进程开一个离屏窗（Chromium 自己解，不需要 ffmpeg）。
       * 结果按「文件名 + 源文件 mtime」缓存：素材没换就直接复用，不重复解码。
       */
      if (path === '/gpw/sheet') {
        if (method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
        const file = String(url.searchParams.get('file') || '').trim();
        if (!file) return sendJson(res, 400, { error: '缺少 file 参数' });
        if (!options.buildSheet) return sendJson(res, 501, { error: '副本没装抽帧台（buildSheet 未注入）' });
        const assetDir = join(options.petAssetsRoot, 'assets', 'webm');
        const source = safeJoin(assetDir, file);
        if (!source || !existsSync(source)) return sendJson(res, 404, { error: '找不到动画：' + file });
        try {
          options.log?.('sheet: 开始 ' + file);
          const result = await options.buildSheet({
            file,
            source,
            cols: Number(url.searchParams.get('cols') || 4),
            rows: Number(url.searchParams.get('rows') || 3),
            tileW: Number(url.searchParams.get('tileW') || 320),
          });
          options.log?.('sheet: 完成 ' + file);
          return sendJson(res, 200, { ok: true, ...result });
        } catch (error) {
          options.log?.('sheet: 失败 ' + file + ' → ' + (error && error.stack ? error.stack.split('\n').slice(0, 4).join(' | ') : error));
          return sendJson(res, 500, { error: error && error.message ? error.message : String(error) });
        }
      }
      /** 素材清单：建库时先问它有哪些动画、多大、什么时候改的 */
      if (path === '/gpw/assets') {
        try {
          const assetDir = join(options.petAssetsRoot, 'assets', 'webm');
          const files = require('node:fs')
            .readdirSync(assetDir)
            .filter((name) => name.toLowerCase().endsWith('.webm'))
            .map((name) => {
              const full = join(assetDir, name);
              const stat = require('node:fs').statSync(full);
              return { file: name, bytes: stat.size, mtime: Math.round(stat.mtimeMs) };
            });
          return sendJson(res, 200, { ok: true, dir: assetDir, count: files.length, files });
        } catch (error) {
          return sendJson(res, 500, { error: error && error.message ? error.message : String(error) });
        }
      }
      // 兼容别名：原版 dsh-pet 的「第三方投喂」端点是 /dsh-pet-7340/broadcast。
      // 插件（或任何别的调用方）按老习惯往这里投话也能落到同一颗气泡里——
      // 于是"换投喂目标"这件事不需要调用方改代码。
      if (path === PET_PREFIX + '/broadcast') {
        if (method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
        let payload = {};
        try {
          payload = JSON.parse((await readBody(req)) || '{}');
        } catch {
          return sendJson(res, 400, { error: 'invalid JSON body' });
        }
        const text = typeof payload.text === 'string' ? payload.text.trim() : '';
        if (!text) return sendJson(res, 200, { ok: false, reason: 'bad-request', message: 'text 为空' });
        const petId = String(url.searchParams.get('pet') || options.petId || 'main');
        const counter = store.writePet(petId, 'say', { text });
        return sendJson(res, 200, { ok: true, petId, counter });
      }
      if (path === '/gpw/state') {
        return sendJson(res, 200, { ok: true, ...store.snapshot(), log: store.log(30) });
      }

      // ---- 原版契约
      if (path === PET_PREFIX + '/config') {
        try {
          // 每次读盘：改了 pet-config.json 刷新页面即可生效（与原版"改配置刷新"同手感）
          const merged = readMergedConfig({
            configFile: options.configFile,
            upstreamConfigFile: options.upstreamConfigFile,
            /**
             * 面板上的"桌宠大小"从**这里**注入。
             *
             * 为什么必须在这里：渲染端是用 `pet.size`（= 这份配置的 pets[0].size）决定动画显示大小的
             * （sprite.js: `this.size = pet.size`，再写成 --pet-size 给 .pet-stage / video 用）。
             * 之前只改了 prefs.json 与 DSH_PET_PETS，**没并进这份配置**，于是滑块只改了窗口大小，
             * 动画显示尺寸一直锁在 pet-config.json 的值上（实测停在 320px）——用户报的"几乎不影响动画显示"。
             */
            petSize: options.prefs ? options.prefs.get().petSize : undefined,
          });
          const body = JSON.stringify(merged);
          res.writeHead(200, { 'content-type': MIME['.json'], 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' });
          res.end(body);
        } catch (error) {
          sendJson(res, 500, { error: `副本配置读不到/解析失败：${options.configFile}（${error && error.message}）` });
        }
        return;
      }
      if (path === PET_PREFIX + '/state') {
        return sendJson(res, 200, store.snapshot());
      }
      if (path === PET_PREFIX + '/balance') {
        // 副本不查余额：回 ok 但不写数据（渲染端读到 data=null 就不弹气泡）
        return sendJson(res, 200, { ok: true });
      }
      if (path === PET_PREFIX + '/whisper') {
        return sendJson(res, 200, { ok: false, reason: 'not-supported', message: '副本不自己生成碎碎念（由 dsh-game-pet-watch 投喂）' });
      }
      if (path === PET_PREFIX + '/anim') {
        if (method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
        let payload = {};
        try {
          payload = JSON.parse((await readBody(req)) || '{}');
        } catch {
          return sendJson(res, 400, { error: 'invalid JSON body' });
        }
        const name = typeof payload.name === 'string' ? payload.name.trim() : '';
        if (!name) return sendJson(res, 200, { ok: false, message: 'name 为空' });
        const petId = String(payload.pet || options.petId || 'main');
        const counter = store.writePet(petId, 'anim', { name });
        return sendJson(res, 200, { ok: true, petId, counter });
      }
      if (path === PET_PREFIX + '/chat') {
        // 副本不自带模型：转发给 dsh-game-pet-watch，由它带着游戏画面与记忆回答。
        // 回答由插件经 /gpw/say 推回来 → 宠物气泡（渲染端零改动）。
        if (method === 'GET') {
          return sendJson(res, 200, { ok: true, messages: store.log(Number(url.searchParams.get('rounds') || 6)).map((e) => ({ role: 'assistant', text: e.text })), rounds: 0 });
        }
        if (method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
        let payload = {};
        try {
          payload = JSON.parse((await readBody(req)) || '{}');
        } catch {
          return sendJson(res, 400, { error: 'invalid JSON body' });
        }
        const text = typeof payload.text === 'string' ? payload.text.trim() : '';
        if (!text) return sendJson(res, 200, { ok: false, reason: 'bad-request', message: '消息为空' });
        try {
          const answer = await options.ask(text);
          return sendJson(res, 200, answer ?? { ok: true });
        } catch (error) {
          return sendJson(res, 200, { ok: false, reason: 'generate-error', message: error && error.message ? error.message : String(error) });
        }
      }

      /**
       * 表情包：/dsh-pet-7340/pic/memes/<名>.png
       *
       * 必须在通用 /pic/ 之前处理：通用规则只会去 assets/pic 找，找不到表情包（表情包在
       * 用户目录与 assets/memes）。目录链与后端的语义一致：**用户目录优先，回落包内**。
       * 客户端把 URL 硬编码成 `<名>.png`（见 shared-core 的 memeImageUrl），所以不认其它扩展名 ——
       * 抓来的图必须转成 PNG 存进这里。
       */
      if (path.startsWith(PET_PREFIX + '/pic/memes/')) {
        const raw = decodeURIComponent(path.slice((PET_PREFIX + '/pic/memes/').length));
        // 支持 <名>.png 与 <素材根>/<名>.png 两种形态（后者只取最后一段：副本只有一个素材根）
        const rel = raw.split('/').filter(Boolean).pop() ?? '';
        if (!rel || rel.includes('..') || !/\.png$/i.test(rel)) {
          return sendJson(res, 400, { error: 'invalid meme name' });
        }
        /**
         * 客户端把 URL 硬编码成 `<名>.png`，但站上抓来的图只有 webp（Node 没有图像库，
         * 转格式就得拉 Python）。所以这里把 `<名>.png` **回落到 `<名>.webp`**：
         * 磁盘上如实存 webp，路由负责对上客户端的名字。按真实扩展名给 content-type。
         */
        const stem = rel.slice(0, -4);
        const candidates = [`${stem}.png`, `${stem}.webp`];
        // 目录链由调用方传入（与后端"链怎么算由调用方唯一决定"同一套语义）：
        // 用户目录优先，回落原版包内目录。这里曾经写 join(options.userRoot,...) —— 那个字段不存在，
        // 于是 path 收到 undefined、整条路由 500（连 404 都走不到）。
        const dirs = options.memeDirs ?? [join(options.petAssetsRoot, 'assets', 'memes')];
        for (const dir of dirs) {
          for (const candidate of candidates) {
            const file = safeJoin(dir, candidate);
            if (!file || !existsSync(file)) continue;
            const type = candidate.toLowerCase().endsWith('.webp') ? 'image/webp' : 'image/png';
            res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache' });
            return res.end(readFileSync(file));
          }
        }
        return sendJson(res, 404, { error: 'meme not found: ' + rel });
      }

      // ---- 素材（从原版 dsh-pet 的包目录直接读，不复制）
      const assetRoots = [
        { prefix: PET_PREFIX + '/thumb/', dir: join(options.petAssetsRoot, 'assets') },
        { prefix: PET_PREFIX + '/font/', dir: join(options.petAssetsRoot, 'assets', 'fonts') },
        { prefix: PET_PREFIX + '/pic/', dir: join(options.petAssetsRoot, 'assets', 'pic') },
        { prefix: '/gpw/local/', dir: options.localRoot },
      ];
      for (const root of assetRoots) {
        if (!path.startsWith(root.prefix)) continue;
        // thumb 是 <前缀>/<素材根>/<文件>：素材根那一段是子目录（包内素材按 webm/ 分目录）
        let rel = path.slice(root.prefix.length);
        let file = safeJoin(root.dir, rel);
        if (!file) return sendJson(res, 400, { error: 'invalid asset path' });
        if (!existsSync(file) && root.prefix === PET_PREFIX + '/thumb/') {
          // 详情：包内动画在 assets/webm/<名>.webm，URL 里没有 webm 这一段
          const parts = rel.split('/');
          if (parts.length >= 2) file = safeJoin(root.dir, join('webm', parts[parts.length - 1]));
        }
        if (!file || !existsSync(file) || !statSync(file).isFile()) {
          return sendJson(res, 404, { error: 'asset not found: ' + rel });
        }
        const ext = extname(file).toLowerCase();
        res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream', 'cache-control': 'no-cache' });
        createReadStream(file).pipe(res);
        return;
      }

      return sendJson(res, 404, { error: 'not found: ' + path });
    } catch (error) {
      try {
        sendJson(res, 500, { error: error && error.message ? error.message : String(error) });
      } catch {
        /* 响应已经发出 */
      }
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, '127.0.0.1', () => resolve());
  });
  const actual = server.address().port;
  options.log?.(`宠物 API 已就绪 http://127.0.0.1:${actual}${PET_PREFIX}/`);
  return { server, port: actual, store };
}

module.exports = { startPetServer, PET_PREFIX };
