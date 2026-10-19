/**
 * 离屏抽帧台（跑在副本的 Electron 里，经典 script）。
 *
 * 任务：把一段 webm 的若干帧拼成一张**带序号与时间标签**的九宫格，供主进程 capturePage 取回。
 * 为什么不找 ffmpeg：这台机器没有；Chromium 解 webm/VP9-alpha 本来就是它的本职，
 * 副本进程现成，零新依赖、零下载。
 *
 * 取帧方式：**播放中按时间间隔抓**（配合 requestVideoFrameCallback）。
 * 曾经用 `currentTime = t` + 等 `seeked`——对 VP9-alpha 的 webm 不可靠：
 * 实测前 3 帧能 seek、第 4 帧就永远等不到事件（状态卡在 step=seek:3）。边播边抓则每帧都真到手。
 *
 * 状态挂在 window.__frames，主进程按它判断成败（失败时带 step，便于定位卡在哪一步）：
 *   { ok: true, cols, rows, sheetW, sheetH, frames: [{ t }] }
 *   { ok: false, error, step }
 */
(function () {
  'use strict';

  var params = new URLSearchParams(location.search);
  var FILE = params.get('file') || '';
  var COLS = Number(params.get('cols') || 4);
  var ROWS = Number(params.get('rows') || 3);
  var TILE_W = Number(params.get('tileW') || 320);
  var LABEL_H = 16;
  var CAPTURE_MS = 420; // 抓帧间隔：十秒动画按 12 帧算约每 0.8s 一张，够看清动作变化

  var video = document.getElementById('src');
  var canvas = document.getElementById('sheet');
  var ctx = canvas.getContext('2d');

  window.__frames = { ok: false, error: '还没开始', step: 'init' };

  // 离屏窗没有可见控制台，页面异常只能这样带出来
  window.addEventListener('error', function (e) {
    window.__frames = { ok: false, error: '页面异常：' + (e.message || e.type), step: window.__frames.step };
  });
  window.addEventListener('unhandledrejection', function (e) {
    var reason = e.reason && e.reason.message ? e.reason.message : String(e.reason);
    window.__frames = { ok: false, error: '未处理的 rejection：' + reason, step: window.__frames.step };
  });

  function fail(message, step) {
    window.__frames = { ok: false, error: String(message), step: step || window.__frames.step };
    if (window.frameHost && typeof window.frameHost.fail === 'function') {
      window.frameHost.fail(message, window.__frames.step);
    }
  }

  function waitEvent(el, type, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        el.removeEventListener(type, handler);
        reject(new Error('等 ' + type + ' 超时（' + timeoutMs + 'ms）'));
      }, timeoutMs);
      function handler() {
        clearTimeout(timer);
        el.removeEventListener(type, handler);
        resolve();
      }
      el.addEventListener(type, handler);
    });
  }

  async function run() {
    window.__frames.step = 'run:enter';
    if (!FILE) return fail('缺少 file 参数');

    video.src = FILE;
    window.__frames.step = 'video:loading';
    try {
      await waitEvent(video, 'loadedmetadata', 8000);
    } catch (error) {
      return fail('载入失败：' + error.message, 'video:loading');
    }
    window.__frames.step = 'video:loaded';
    if (!video.videoWidth || !video.videoHeight) return fail('视频尺寸为 0，解码不了', 'video:loaded');

    var duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
    var total = COLS * ROWS;
    var tileH = Math.round((TILE_W * video.videoHeight) / video.videoWidth);
    var sheetW = TILE_W * COLS;
    var sheetH = (tileH + LABEL_H) * ROWS;
    canvas.width = sheetW;
    canvas.height = sheetH;
    ctx.fillStyle = '#101014';
    ctx.fillRect(0, 0, sheetW, sheetH);

    var frames = [];
    function grab() {
      var index = frames.length;
      if (index >= total) return false;
      var col = index % COLS;
      var row = Math.floor(index / COLS);
      var x = col * TILE_W;
      var y = row * (tileH + LABEL_H) + LABEL_H;
      var t = video.currentTime;
      try {
        ctx.drawImage(video, x, y, TILE_W, tileH);
      } catch (error) {
        return false;
      }
      ctx.fillStyle = 'rgba(0,0,0,0.72)';
      ctx.fillRect(x, row * (tileH + LABEL_H), TILE_W, LABEL_H);
      ctx.fillStyle = '#e8e8ee';
      ctx.font = '12px "Microsoft YaHei UI", sans-serif';
      ctx.fillText('#' + (index + 1) + '  ' + t.toFixed(2) + 's', x + 6, row * (tileH + LABEL_H) + 12);
      frames.push({ t: Number(t.toFixed(2)) });
      return true;
    }

    window.__frames.step = 'play:start';
    try {
      video.currentTime = 0;
      await video.play();
    } catch (error) {
      return fail('无法播放：' + error.message, 'play:start');
    }

    // 三条路都留着：定时抓、视频帧回调配合、保险丝超时
    await new Promise(function (resolve) {
      var done = false;
      function finish() {
        if (done) return;
        done = true;
        clearInterval(timer);
        resolve();
      }
      var timer = setInterval(function () {
        if (!grab()) finish();
      }, CAPTURE_MS);

      var lastFrameAt = 0;
      if (typeof video.requestVideoFrameCallback === 'function') {
        var onFrame = function (now) {
          if (done) return;
          if (now - lastFrameAt >= CAPTURE_MS) {
            lastFrameAt = now;
            grab();
          }
          if (!done) video.requestVideoFrameCallback(onFrame);
        };
        video.requestVideoFrameCallback(onFrame);
      }

      // 保险丝：整段时长 + 6 秒还没抓满就收工（动画是循环的，抓满 12 帧绰绰有余）
      setTimeout(finish, Math.max(4000, (duration || 10) * 1000 + 6000));
      video.addEventListener('ended', finish, { once: true });
    });
    try {
      video.pause();
    } catch {
      /* 已经停了 */
    }

    if (!frames.length) return fail('一帧都没抓到', 'play:none');
    window.__frames = {
      ok: true,
      cols: COLS,
      rows: ROWS,
      sheetW: sheetW,
      sheetH: sheetH,
      duration: Number((duration || video.currentTime || 0).toFixed(2)),
      source: { w: video.videoWidth, h: video.videoHeight },
      frames: frames,
      step: 'done',
    };
    // 主动回传：主进程在 contextIsolation 下读不到主世界变量，只能由页面推给它
    if (window.frameHost && typeof window.frameHost.done === 'function') window.frameHost.done(window.__frames);
    console.log('[frames] 拼图完成 ' + frames.length + ' 帧 ' + sheetW + 'x' + sheetH);
  }

  void run();
})();
