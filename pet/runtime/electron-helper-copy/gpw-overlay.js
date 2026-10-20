/**
 * dsh-pet-gpw 浮层（注入到原版助手页面的**主世界**里跑）。
 *
 * 三样东西，都跟在宠物身上：
 *   1) 悬停输入框：鼠标扫到宠物附近浮出来，回车把话发给 dsh-game-pet-watch；
 *      回答由插件投给副本的 /gpw/say → 写 pets.<id>.say → 宠物气泡（渲染端零改动）
 *   2) 状态胶囊：观察循环是跑着还是暂停着，点它开面板
 *   3) 提示条：错误 / 结果一句话
 *
 * 可交互性交给**原版那套**（petBridge.setInteractive + setInputBusy）：
 * 主进程按光标是否在 .pet-hit 里翻转点击穿透；输入框浮出来时我们主动要交互，
 * 打字/发送期间报告 inputBusy，主进程就不会把窗口翻回穿透。
 */
(function () {
  'use strict';

  if (window.__gpwOverlayInstalled) return;
  window.__gpwOverlayInstalled = true;

  var PLUGIN = new URLSearchParams(location.search).get('plugin') || 'http://127.0.0.1:19387';
  var API = PLUGIN + '/game-pet-watch';
  /**
   * 宠物自己的服务地址必须用**绝对 URL**（从窗口 URL 的 `?port=` 拿）。
   *
   * 这个页面是 `win.loadFile(...)` 打开的 —— **file:// 源**：相对路径 `/gpw/brand`
   * 会被解析成 `file:///gpw/brand`，永远失败（这就是上一版"自动刷新插件地址"没生效的原因）。
   */
  var PET_PORT = new URLSearchParams(location.search).get('port') || '7341';
  var PET_API = 'http://127.0.0.1:' + PET_PORT;
  var PIN_API = PET_API + '/gpw/pin';
  var PET_ID = 'gpw';
  var HIDE_DELAY = 1400;

  /**
   * **插件地址不能只在加载时取一次**（2026-10-18 修：胶囊一直显示"插件离线"其实在线）。
   *
   * 窗口 URL 里的 `?plugin=` 是**打开那一刻**的快照；DSH 每次重启端口都会变，
   * 之后这个快照就指向一个死端口 → `/state` 永远失败 → 胶囊判"离线"。
   * 这页本身是宠物自己的服务提供的，所以 `fetch('/gpw/brand')`（同源、相对路径）
   * 拿到的 `pluginOrigin` 就是**当前**该回连的地址；每 10 秒刷一次，失败时也会立刻刷。
   */
  function refreshPluginOrigin() {
    return fetch(PET_API + '/gpw/brand', { cache: 'no-store' })
      .then(function (r) {
        return r.json();
      })
      .then(function (b) {
        var o = b && b.pluginOrigin ? String(b.pluginOrigin).replace(/\/+$/, '') : '';
        if (o && o !== PLUGIN) {
          PLUGIN = o;
          API = PLUGIN + '/game-pet-watch';
        }
      })
      .catch(function () {
        /* 宠物服务自己不可用时就算了 */
      });
  }
  refreshPluginOrigin();
  setInterval(refreshPluginOrigin, 10000);

  function bridge() {
    return window.petBridge || null;
  }
  function interactive(on) {
    var b = bridge();
    if (b && typeof b.setInteractive === 'function') b.setInteractive(!!on);
  }
  function inputBusy(on) {
    var b = bridge();
    if (b && typeof b.setInputBusy === 'function') b.setInputBusy(!!on);
  }
  function openPanel() {
    if (window.gpwHost && typeof window.gpwHost.openPanel === 'function') window.gpwHost.openPanel();
  }

  // ---------- DOM ----------
  var wrap = document.createElement('div');
  wrap.id = 'gpw-input';
  var inputEl = document.createElement('input');
  inputEl.type = 'text';
  inputEl.placeholder = '跟鱼说一句，回车发送';
  var sendBtn = document.createElement('button');
  sendBtn.type = 'button';
  sendBtn.textContent = '发送';
  /**
   * **本鱼 / 全体**：决定这句话是"只对这只鱼说"还是"广播给所有鱼"。
   * 默认本鱼（你站在谁面前就是跟谁说话）；选项记在 localStorage，下次还是这个。
   */
  var scopeBtn = document.createElement('button');
  scopeBtn.type = 'button';
  scopeBtn.id = 'gpw-scope';
  var audience = localStorage.getItem('gpw-audience') === 'all' ? 'all' : 'self';
  function paintScope() {
    scopeBtn.textContent = audience === 'all' ? '全体' : '本鱼';
    scopeBtn.title =
      audience === 'all'
        ? '现在：全体（所有鱼都能看到这句话）— 点一下改为只对本鱼'
        : '现在：本鱼（只记这条鱼，不广播）— 点一下改为全体';
    scopeBtn.classList.toggle('all', audience === 'all');
  }
  paintScope();
  scopeBtn.addEventListener('click', function (event) {
    event.preventDefault();
    audience = audience === 'all' ? 'self' : 'all';
    localStorage.setItem('gpw-audience', audience);
    paintScope();
    inputEl.focus();
  });
  wrap.appendChild(scopeBtn);
  wrap.appendChild(inputEl);
  wrap.appendChild(sendBtn);

  var toastEl = document.createElement('div');
  toastEl.id = 'gpw-toast';

  var badge = document.createElement('div');
  badge.id = 'gpw-badge';
  badge.title = '右键宠物或点这里打开观察面板';
  var badgeDot = document.createElement('span');
  badgeDot.className = 'dot';
  var badgeLabel = document.createElement('span');
  badgeLabel.className = 'label';
  badgeLabel.textContent = '游戏观察';
  badge.appendChild(badgeDot);
  badge.appendChild(badgeLabel);
  // 置顶固定：宠物被别的置顶窗盖住时点它（状态持久化在副本的 pin.json）
  var pinBtn = document.createElement('span');
  pinBtn.className = 'pin';
  pinBtn.title = '交互锁定：开着时窗口收鼠标输入（点宠物/打字用），关掉恢复穿透';
  pinBtn.style.cssText = 'margin-left:4px;padding:0 3px;border-radius:4px;opacity:.9;cursor:pointer';
  pinBtn.textContent = '📌';
  badge.appendChild(pinBtn);
  var pinned = true;
  async function refreshPin() {
    try {
      var res = await fetch(PIN_API, { cache: 'no-store' });
      var data = await res.json();
      if (data && data.ok) {
        pinned = data.pinned === true;
        pinBtn.style.opacity = pinned ? '1' : '.35';
        pinBtn.style.background = pinned ? 'rgba(77,141,255,.35)' : 'transparent';
        pinBtn.title = pinned ? '交互锁定已开（点一下恢复穿透）' : '点击锁定：让窗口可交互（点宠物/打字）';
      }
    } catch (error) {
      /* 副本没装管理器就保持默认外观 */
    }
  }
  pinBtn.addEventListener('click', async function (event) {
    event.stopPropagation();
    try {
      var res = await fetch(PIN_API, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pinned: !pinned }),
      });
      var data = await res.json();
      if (data && data.ok) {
        pinned = data.pinned === true;
        toast(
          pinned
            ? '交互锁定已开：现在能点宠物、能在输入框打字（用完再点一下恢复穿透）'
            : '交互锁定已关：恢复自动穿透（正常用电脑）',
          5000,
        );
      }
    } catch (error) {
      toast('切换失败：' + (error && error.message ? error.message : String(error)), 4000);
    }
    await refreshPin();
  });

  function mount() {
    var root = document.getElementById('root') || document.body;
    if (!wrap.isConnected) root.appendChild(wrap);
    if (!toastEl.isConnected) root.appendChild(toastEl);
    if (!badge.isConnected) root.appendChild(badge);
  }
  mount();

  // ---------- 布局：跟着宠物身体走 ----------
  /** 两个矩形求并集（任一为 null 时返回另一个） */
  function unionRect(a, b) {
    if (!a) return b;
    if (!b) return a;
    return {
      left: Math.min(a.left, b.left), top: Math.min(a.top, b.top),
      right: Math.max(a.right, b.right), bottom: Math.max(a.bottom, b.bottom),
      width: Math.max(a.right, b.right) - Math.min(a.left, b.left),
      height: Math.max(a.bottom, b.bottom) - Math.min(a.top, b.top),
    };
  }

  /** 当前可见的浮层控件矩形并集（都没显示时返回 null） */
  function visibleOverlayControls() {
    var out = null;
    for (const id of ['gpw-input', 'gpw-badge']) {
      var node = document.getElementById(id);
      if (!node) continue;
      var cs = getComputedStyle(node);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      var r = node.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) continue;
      out = unionRect(out, r);
    }
    return out;
  }

  /** 宠物 sprite 的矩形（left/top 是渲染端真正用来摆放宠物的那两个值） */
  function spriteRect() {
    var sprite = document.querySelector('.pet-sprite');
    if (!sprite) return null;
    var rect = sprite.getBoundingClientRect();
    if (rect.width < 8 || rect.height < 8) return null;
    return rect;
  }

  function stageRect() {
    var stage = document.querySelector('.pet-stage');
    if (!stage) return null;
    var rect = stage.getBoundingClientRect();
    if (rect.width < 8 || rect.height < 8) return null;
    return rect;
  }

  function layout() {
    var rect = stageRect();
    if (!rect) return;
    var wrapW = wrap.classList.contains('on') ? wrap.offsetWidth || 320 : 320;
    var wrapH = wrap.offsetHeight || 34;
    var left = Math.round(rect.left + rect.width / 2 - wrapW / 2);
    left = Math.max(6, Math.min(window.innerWidth - wrapW - 6, left));
    var top = Math.round(rect.bottom + 4);
    if (top + wrapH > window.innerHeight - 4) top = Math.max(4, window.innerHeight - wrapH - 4);
    wrap.style.left = left + 'px';
    wrap.style.top = top + 'px';
    toastEl.style.left = left + 'px';
    toastEl.style.top = Math.max(4, top - 44) + 'px';
    badge.style.left = Math.max(2, Math.min(window.innerWidth - 96, Math.round(rect.right - 88))) + 'px';
    badge.style.top = Math.max(2, Math.round(rect.top - 22)) + 'px';
  }

  function isOverRect(rect, cursor) {
    if (!rect || !cursor) return false;
    var pad = 12;
    return (
      cursor.x >= rect.left - pad &&
      cursor.x <= rect.right + pad &&
      cursor.y >= rect.top - pad &&
      cursor.y <= rect.bottom + pad
    );
  }

  var hideTimer = null;
  function showInput() {
    if (!wrap.classList.contains('on')) {
      wrap.classList.add('on');
      layout();
    }
    interactive(true);
    clearTimeout(hideTimer);
    hideTimer = setTimeout(function () {
      if (document.activeElement === inputEl) return;
      var cursor = window.__gpwLastCursor;
      var ir = wrap.getBoundingClientRect();
      var nearInput =
        cursor && cursor.x >= ir.left - 10 && cursor.x <= ir.right + 10 && cursor.y >= ir.top - 10 && cursor.y <= ir.bottom + 10;
      if (!nearInput && !isOverRect(stageRect(), cursor)) {
        wrap.classList.remove('on');
        interactive(false);
      }
    }, HIDE_DELAY);
  }

  function toast(text, ms) {
    toastEl.textContent = text;
    toastEl.classList.add('on');
    layout();
    clearTimeout(toast._t);
    toast._t = setTimeout(function () {
      toastEl.classList.remove('on');
    }, ms || 6000);
  }

  // ---------- 悬停检测 ----------
  // 窗口默认整窗穿透，但主进程开了 forward：鼠标事件仍会到达，用它判断"离宠物多近"。
  /**
   * 光标来自**主进程**（gpwHost.onCursor，120ms 一拍，屏幕坐标）：
   * 窗口整窗点击穿透时渲染端收不到可靠的 mousemove，悬停入口不能赌它。
   * 收到的是屏幕坐标 → 换算成窗口内坐标再判定。
   */
  /**
   * 屏幕坐标（主进程 getCursorScreenPoint）→ 页面坐标。
   *
   * 本机的坑：显示缩放是 **4 倍**（GameViewer 虚拟显示器），而 Chromium 里 `devicePixelRatio = 1`、
   * `innerWidth` 直接就是 2560 —— 也就是说页面用它自己的坐标系画宠物（宠物在 160,160），
   * 而 `SetCursorPos`/`getCursorScreenPoint` 用的是 4 倍那套（同一位置报 640,640）。
   * 之前按 dpr 除（=1）等于没换算，于是判定永远错位。
   *
   * 倍率不能硬编码：**实测得出**——启动后把光标放到宠物 DOM 中心，
   * 读回屏幕坐标，比值就是倍率（`window.__gpwFitScale`）。拿不到就退回 dpr。
   */
  function fitScale() {
    var s = Number(window.__gpwFitScale);
    if (s > 0.05 && s < 20) return s;
    return window.devicePixelRatio || 1;
  }

  function cursorInWindow(payload) {
    if (!payload || !payload.bounds) return null;
    var k = fitScale();
    return { x: payload.x / k - payload.bounds.x, y: payload.y / k - payload.bounds.y };
  }

  if (window.gpwHost && typeof window.gpwHost.onCursor === 'function') {
    window.__gpwCursorHits = 0;
    window.gpwHost.onCursor(function (payload) {
      window.__gpwCursorHits++;
      window.__gpwLastPayload = payload;
      var local = cursorInWindow(payload);
      window.__gpwLastCursor = local;
      /**
       * 【副本改动】点击穿透由**渲染端**决定，判据与"悬停出输入框"完全同源。
       *
       * 为什么不让主进程判：主进程那套兜底轮询按"窗口 = 宠物 + 四周余量"反推命中区；
       * 副本铺满窗口后它算出来的是整个屏幕（整屏拦点击），而本机（笔记本屏 + 虚拟屏）的
       * 页面坐标与屏幕坐标又对不上，于是实测光标压在宠物上仍判 over=false（宠物点不动）。
       *
       * 这里用的是 .pet-sprite / .pet-stage 的 DOM 矩形与输入框同一套判定：
       * 宠物动到哪，判定就跟到哪，和窗口多大无关。
       */
      /**
       * 判定目标 = 宠物 sprite ∪ 可见的浮层控件（输入框/胶囊）。
       *
       * 为什么要把控件并进来：输入框在宠物**下方**，光标从宠物移到输入框时会离开身体命中区。
       * 原版那一刻会把窗口翻回"穿透" → 输入框立刻点不动（用户报的"输入框和图钉无法交互，
       * 右键 pet 才能恢复"就是这个）。并进来之后，只要光标还在控件上，窗口就保持可交互。
       */
      var target = unionRect(spriteRect() || stageRect(), visibleOverlayControls());
      var over = isOverRect(target, local);
      /**
       * 心跳：每次判定为"在宠物上"就报一次（不带坐标）。
       * 主进程据此在 GRACE_MS 内保持"不穿透"——这样即使光标停在原地、
       * 或拖拽残留 pointer capture 让渲染端的 pointermove 不再触发，
       * 控件也不会因为"没跨过身体边界"而永久点不动。
       */
      if (over && window.gpwHost && typeof window.gpwHost.interactivePulse === 'function') {
        window.gpwHost.interactivePulse();
      }
      window.__gpwTargetRect = target;
      window.__gpwOverPet = over;
      if (window.gpwHost && typeof window.gpwHost.setInteractive === 'function') {
        window.__gpwSetCalls = (window.__gpwSetCalls || 0) + 1;
        window.__gpwSetLast = over;
        window.gpwHost.setInteractive(over);
      } else {
        window.__gpwNoApi = true;
      }
      if (over) showInput();
    });
  } else {
    // 兜底：没有主进程通道时退回 mousemove
    document.addEventListener(
      'mousemove',
      function (event) {
        window.__gpwLastCursor = { x: event.clientX, y: event.clientY };
        if (isOverRect(stageRect(), window.__gpwLastCursor)) showInput();
      },
      true,
    );
  }

  document.addEventListener('mouseleave', function () {
    if (document.activeElement !== inputEl) {
      wrap.classList.remove('on');
      interactive(false);
    }
  });

  // 右键宠物 → 开面板（原版自己的右键菜单照常弹，这里只是多一个入口）
  document.addEventListener('contextmenu', function (event) {
    if (isOverRect(stageRect(), { x: event.clientX, y: event.clientY })) openPanel();
  });

  inputEl.addEventListener('focus', function () {
    interactive(true);
    inputBusy(true);
    clearTimeout(hideTimer);
  });
  inputEl.addEventListener('blur', function () {
    inputBusy(false);
  });
  inputEl.addEventListener('keydown', function (event) {
    if (event.key === 'Enter') {
      event.preventDefault();
      void send();
    } else if (event.key === 'Escape') {
      inputEl.value = '';
      inputEl.blur();
      wrap.classList.remove('on');
    }
  });
  sendBtn.addEventListener('click', function () {
    void send();
  });
  badge.addEventListener('click', function () {
    openPanel();
  });

  var sending = false;
  async function send() {
    var text = inputEl.value.trim();
    if (!text || sending) return;
    sending = true;
    sendBtn.disabled = true;
    inputBusy(true);
    try {
      var res = await fetch(API + '/ask', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        /**
         * `port` 让插件认出**是哪条鱼**（不带就会落到空 scope：表情包清单/按鱼记忆全丢）；
         * `audience` 由上面那个「本鱼 / 全体」按钮决定。
         */
        body: JSON.stringify({ text: text, push: 'gpw', pet: PET_ID, port: PET_PORT, audience: audience }),
      });
      var body = await res.json().catch(function () {
        return {};
      });
      inputEl.value = '';
      if (body && body.ok) toast('鱼：' + (body.text || '（没说话）'), 6000);
      else toast('发送失败：' + ((body && body.message) || '未知错误'), 6000);
    } catch (error) {
      toast('发送失败：' + (error && error.message ? error.message : String(error)), 6000);
    } finally {
      sending = false;
      sendBtn.disabled = false;
      inputBusy(document.activeElement === inputEl);
    }
  }

  // ---------- 状态胶囊 ----------
  async function poll() {
    try {
      var res = await fetch(API + '/state', { cache: 'no-store' });
      var data = await res.json();
      if (!data || !data.ok) return;
      var running = !!(data.runtime && data.runtime.running);
      var paused = !!(data.runtime && data.runtime.paused);
      var errs = (data.errors || []).length;
      badgeDot.style.background = errs ? '#e2564a' : paused && !running ? '#e0a53c' : running ? '#3fbf7f' : '#9a9aa8';
      badgeLabel.textContent =
        (running ? '观察中' : '已暂停') + (data.runtime && data.runtime.captures ? ' · ' + data.runtime.captures : '');
      badge.classList.add('on');
      layout();
      if (errs && !toastEl.classList.contains('on')) {
        var last = data.errors[data.errors.length - 1];
        toast('⚠ ' + last.message, 8000);
      }
    } catch (error) {
      badgeDot.style.background = '#9a9aa8';
      badgeLabel.textContent = '插件离线';
      badge.classList.add('on');
      // 失败时立刻重问一次"现在的插件地址"（DSH 重启换端口后，下一次就恢复成"观察中"）
      refreshPluginOrigin();
    }
  }

  /**
   * 启动标定：拿宠物身体中心当靶子，问主进程"这个页面坐标对应的真实屏幕坐标是多少"，
   * 比值即为倍率。标定完点击穿透与悬停判定就都对得上了。
   */
  async function calibrate() {
    if (!window.gpwHost || typeof window.gpwHost.calibrate !== 'function') return;
    var rect = stageRect() || spriteRect();
    if (!rect) return;
    var r = await window.gpwHost.calibrate(rect.left + rect.width / 2, rect.top + rect.height / 2);
    if (r && r.factor) {
      window.__gpwFitScale = r.factor;
      console.log('[dsh-pet-gpw] 坐标倍率标定 = ' + r.factor.toFixed(3) + '（页面→屏幕）');
    }
  }

  /**
   * 文字大小：从副本偏好读 textScale，套到浮层三件套（输入框/提示条/状态胶囊）上。
   * 用 CSS 变量而不是逐个改 fontSize：原样式表里写的是 12px/11px，改变量最省事也最好回退。
   */
  /**
   * 把浮层控件的屏幕矩形报给主进程，让点击穿透的兜底判定把它们算作"可交互"。
   *
   * 坐标换算：页面坐标 × 倍率 = 屏幕坐标（倍率由 calibrate() 实测，见 fitScale）。
   * 只报**当前可见**的控件；都不可见时上报空数组，避免无谓地让整窗保持可交互。
   */
  /**
   * 上报浮层控件的矩形，**窗口内坐标（CSS px）**——不做任何跨坐标系换算。
   *
   * 主进程拿到后会用"渲染端上报的宠物框"当锚点换算成屏幕坐标（见副本 main.js 的兜底判定）：
   * 那条链路是实测自洽的（窗口内 160,160 ↔ boxX 1229 → 1229+160 = 1389 = 窗口 x），
   * 而"页面 × 倍率 → 屏幕"在本机差了一倍多，不能用。
   */
  function reportHitRegions() {
    if (!window.gpwHost || typeof window.gpwHost.setLocalHitRects !== 'function') return;
    var rects = [];
    var add = function (id, pad) {
      var node = document.getElementById(id);
      if (!node) return;
      var cs = getComputedStyle(node);
      if (cs.display === 'none' || cs.visibility === 'hidden') return;
      var r = node.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) return;
      var p = pad || 4;
      rects.push({ left: r.left - p, top: r.top - p, right: r.right + p, bottom: r.bottom + p });
    };
    add('gpw-input', 6);
    add('gpw-badge', 6);
    window.gpwHost.setLocalHitRects(rects);
  }

  async function applyTextScale() {
    try {
      var port = (location.search.match(/[?&]port=([^&]+)/) || [])[1] || '7341';
      var res = await fetch('http://127.0.0.1:' + port + '/gpw/prefs');
      var data = await res.json();
      var scale = Number(data && data.prefs && data.prefs.textScale) || 1;
      window.__gpwTextScale = scale;
      var style = document.getElementById('gpw-text-scale');
      if (!style) {
        style = document.createElement('style');
        style.id = 'gpw-text-scale';
        document.head.appendChild(style);
      }
      // 只作用于浮层自己的三件套，不碰宠物气泡（气泡字号是原版按 --pet-size 算的，别动）
      style.textContent =
        '#gpw-input #gpw-scope{border:1px solid rgba(255,255,255,.28);background:rgba(20,22,28,.82);color:#dfe3ea;border-radius:999px;padding:0 8px;height:26px;font-size:11px;line-height:24px;cursor:pointer;margin-right:6px;white-space:nowrap;pointer-events:auto}' +
  '#gpw-input #gpw-scope.all{border-color:rgba(120,180,255,.7);color:#bfe0ff}' +
  '#gpw-input #gpw-scope:hover{background:rgba(40,46,60,.92)}' +
  '#gpw-input{font-size:' + (12 * scale).toFixed(1) + 'px}' +
        '#gpw-toast{font-size:' + (12 * scale).toFixed(1) + 'px}' +
        '#gpw-badge{font-size:' + (11 * scale).toFixed(1) + 'px}';
    } catch (error) {
      /* 副本没起来就用默认字号 */
    }
  }

  window.addEventListener('resize', layout);
  setInterval(function () {
    mount();
    layout();
  }, 500);
  setInterval(poll, 2000);
  setInterval(refreshPin, 8000);
  void poll();
  void refreshPin();
  setTimeout(function () {
    void calibrate();
    void applyTextScale();
  }, 1500);
  // 偏好可能被面板改过：定时轻量重读（1 次/10 秒，代价可忽略）
  setInterval(function () {
    void applyTextScale();
  }, 10000);
  // 浮层控件位置会随宠物移动/输入框显隐变化：定时重报（1 次/500ms，开销可忽略）
  setInterval(reportHitRegions, 500);
  reportHitRegions();
  layout();
  console.log('[dsh-pet-gpw] 浮层已就绪（悬停宠物出输入框，右键宠物开面板）');
})();
