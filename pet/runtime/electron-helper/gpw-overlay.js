/**
 * dsh-pet-gpw 浮层（跑在宠物窗里，经典 script，纯 DOM）。
 *
 * 三件事：
 *   1) 悬停输入框：鼠标扫到宠物/输入框时浮出来，回车把话发给 dsh-game-pet-watch，
 *      回答仍走宠物气泡（渲染端读取 /gpw/say 写入的 pets.<id>.say）
 *   2) 状态胶囊：显示观察循环是跑着还是暂停着，点它开面板
 *   3) 临时提示：错误/结果一句话
 *
 * 与主进程的两条 IPC：gpw:hit-rect（让主进程知道哪里该可交互）、gpw:input-busy（别在打字时翻回穿透）
 * 以及 gpw:open-panel（右键菜单 / 胶囊点击）。
 */
(function () {
  'use strict';

  var inputWrap = document.getElementById('gpw-input');
  var inputEl = inputWrap.querySelector('input');
  var sendBtn = inputWrap.querySelector('button');
  var toastEl = document.getElementById('gpw-toast');
  var badge = document.getElementById('gpw-badge');
  var badgeDot = badge.querySelector('.dot');
  var badgeLabel = badge.querySelector('.label');

  var PLUGIN = new URLSearchParams(location.search).get('plugin') || 'http://127.0.0.1:19387';
  var API = PLUGIN + '/game-pet-watch';
  var PET_ID = 'gpw';
  var SENDING = false;
  var HIDE_DELAY = 1200;
  var hideTimer = null;
  var toastTimer = null;
  var lastSnapshot = null;

  function bridge() {
    return window.petBridge || null;
  }
  function report(ignore) {
    // 主进程只认这条通道：它由 gpw-main.js 实现
    if (window.gpwHost && typeof window.gpwHost.setIgnore === 'function') {
      window.gpwHost.setIgnore(!!ignore);
    }
  }
  // gpw-main 通过 preload 注入（可选）：没有就只靠主进程的光标兜底轮询
  function setBusy(busy) {
    if (window.gpwHost && typeof window.gpwHost.setInputBusy === 'function') window.gpwHost.setInputBusy(!!busy);
    else if (bridge() && typeof bridge().setInputBusy === 'function') bridge().setInputBusy(!!busy);
  }
  function openPanel() {
    if (window.gpwHost && typeof window.gpwHost.openPanel === 'function') window.gpwHost.openPanel();
  }

  // ---------------- 布局：所有浮层跟着宠物身体走 ----------------
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
    var wrapW = inputWrap.classList.contains('on') ? inputWrap.offsetWidth || 360 : 360;
    var wrapH = inputWrap.offsetHeight || 34;

    // 输入框：宠物下方，水平居中；贴到窗口下缘就改到上方
    var left = Math.round(rect.left + rect.width / 2 - wrapW / 2);
    left = Math.max(6, Math.min(window.innerWidth - wrapW - 6, left));
    var top = Math.round(rect.bottom + 6);
    if (top + wrapH > window.innerHeight - 4) top = Math.max(4, Math.round(rect.top - wrapH - 6));
    inputWrap.style.left = left + 'px';
    inputWrap.style.top = top + 'px';

    // 状态胶囊：宠物右上角外一点
    var badgeTop = Math.max(2, Math.round(rect.top - 20));
    var badgeLeft = Math.min(window.innerWidth - 96, Math.round(rect.right - 88));
    badge.style.left = Math.max(2, badgeLeft) + 'px';
    badge.style.top = badgeTop + 'px';

    // 提示：输入框同层，压在它上方
    toastEl.style.left = left + 'px';
    toastEl.style.top = Math.max(4, top - 40) + 'px';
  }

  function reportHitRect() {
    var rect = stageRect();
    var hit = null;
    if (rect) {
      // 命中区 = 宠物身体 + 当前可见的浮层（主进程据此决定是否可交互）
      var x0 = rect.left;
      var y0 = rect.top;
      var x1 = rect.right;
      var y1 = rect.bottom;
      if (inputWrap.classList.contains('on')) {
        var ir = inputWrap.getBoundingClientRect();
        x0 = Math.min(x0, ir.left);
        y0 = Math.min(y0, ir.top);
        x1 = Math.max(x1, ir.right);
        y1 = Math.max(y1, ir.bottom);
      }
      hit = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
    }
    if (window.gpwHost && typeof window.gpwHost.setHitRect === 'function') window.gpwHost.setHitRect(hit);
  }

  // ---------------- 显示 / 隐藏 ----------------
  function showInput(focus) {
    if (!inputWrap.classList.contains('on')) {
      inputWrap.classList.add('on');
      layout();
    }
    if (focus) {
      inputEl.focus();
      setBusy(true);
    }
    clearTimeout(hideTimer);
    hideTimer = setTimeout(function () {
      if (document.activeElement === inputEl || SENDING) return;
      hideInput();
    }, HIDE_DELAY);
  }

  function hideInput() {
    inputWrap.classList.remove('on');
    setBusy(false);
    reportHitRect();
  }

  function toast(text, ms) {
    toastEl.textContent = text;
    toastEl.classList.add('on');
    layout();
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toastEl.classList.remove('on');
    }, ms || 6000);
  }

  // ---------------- 悬停检测 ----------------
  // 窗口默认整窗**点击穿透**，所以这里收不到 mousemove 时也正常；主进程开启 forward 后
  // 转发事件仍会到达，用它判断"鼠标离宠物多近"（够近就把输入框浮出来）。
  function nearPet(event) {
    var rect = stageRect();
    if (!rect) return false;
    if (inputWrap.classList.contains('on')) {
      var ir = inputWrap.getBoundingClientRect();
      if (
        event.clientX >= ir.left - 8 &&
        event.clientX <= ir.right + 8 &&
        event.clientY >= ir.top - 8 &&
        event.clientY <= ir.bottom + 8
      ) {
        return true;
      }
    }
    var pad = 24;
    return (
      event.clientX >= rect.left - pad &&
      event.clientX <= rect.right + pad &&
      event.clientY >= rect.top - pad &&
      event.clientY <= rect.bottom + pad
    );
  }

  document.addEventListener('mousemove', function (event) {
    if (nearPet(event)) showInput(false);
  });

  // 右键宠物：开管理面板（sprite 自己的右键菜单照常弹，这里只是多一条入口）
  document.addEventListener('contextmenu', function (event) {
    if (!nearPet(event)) return;
    openPanel();
  });

  inputEl.addEventListener('focus', function () {
    setBusy(true);
    clearTimeout(hideTimer);
    reportHitRect();
  });
  inputEl.addEventListener('blur', function () {
    setBusy(false);
  });
  inputEl.addEventListener('keydown', function (event) {
    if (event.key === 'Enter') {
      event.preventDefault();
      void send();
    } else if (event.key === 'Escape') {
      inputEl.value = '';
      hideInput();
    }
  });
  sendBtn.addEventListener('click', function () {
    void send();
  });
  badge.addEventListener('click', function () {
    openPanel();
  });

  async function send() {
    var text = inputEl.value.trim();
    if (!text || SENDING) return;
    SENDING = true;
    sendBtn.disabled = true;
    setBusy(true);
    try {
      var res = await fetch(API + '/ask', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: text, push: 'gpw', pet: PET_ID }),
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
      SENDING = false;
      sendBtn.disabled = false;
      setBusy(document.activeElement === inputEl);
      reportHitRect();
    }
  }

  // ---------------- 状态胶囊：跟着观察循环跑/停 ----------------
  async function poll() {
    try {
      var res = await fetch(API + '/state', { cache: 'no-store' });
      var data = await res.json();
      if (!data || !data.ok) return;
      lastSnapshot = data;
      var running = !!(data.runtime && data.runtime.running);
      var paused = !!(data.runtime && data.runtime.paused);
      var errs = (data.errors || []).length;
      badgeDot.style.background = errs ? '#e2564a' : paused && !running ? '#e0a53c' : running ? '#3fbf7f' : '#9a9aa8';
      badgeLabel.textContent = (running ? '观察中' : '已暂停') + (data.runtime && data.runtime.captures ? ' · ' + data.runtime.captures : '');
      badge.classList.add('on');
      if (errs && !toastEl.classList.contains('on')) {
        var last = data.errors[data.errors.length - 1];
        toast('⚠ ' + last.message, 8000);
      }
      layout();
    } catch (error) {
      badgeDot.style.background = '#9a9aa8';
      badgeLabel.textContent = '插件离线';
      badge.classList.add('on');
    }
  }

  // 逐帧对齐（宠物会漫游/被拖动，浮层必须跟着走）
  function frame() {
    layout();
    reportHitRect();
    requestAnimationFrame(frame);
  }

  window.addEventListener('resize', layout);
  setInterval(poll, 2000);
  void poll();
  requestAnimationFrame(frame);
})();
