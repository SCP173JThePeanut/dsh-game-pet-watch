/**
 * dsh-pet-gpw 面板页 —— 纯 DOM（无框架），与宠物窗同一个 Electron 进程。
 *
 * 数据来源：
 *   - dsh-game-pet-watch（我的插件）：/game-pet-watch/*  → 状态、记录、提示词、截图、回话
 *   - 本进程的宠物服务：/gpw/log                        → 宠物说过的历史
 *
 * 三页签：状态 / 记录 / 提示词。默认输出仍然走宠物气泡，这里只是"看得见、改得动"的地方。
 */
'use strict';

const _q = new URLSearchParams(location.search);
const PORT = _q.get('port') || '7341';
/** 插件地址每次现问（DSH 重启换端口后，面板会一直显示旧端口的错误） */
let PLUGIN = _q.get('plugin') || 'http://127.0.0.1:19387';
let API = PLUGIN + '/game-pet-watch';
const PET_API = 'http://127.0.0.1:' + PORT;
async function refreshPluginOrigin() {
  try {
    const res = await fetch(PET_API + '/gpw/brand', { cache: 'no-store', signal: AbortSignal.timeout(2000) });
    if (!res.ok) return;
    const data = await res.json();
    const next = typeof data?.pluginOrigin === 'string' ? data.pluginOrigin.replace(/\/$/, '') : '';
    if (next && next !== PLUGIN) { PLUGIN = next; API = PLUGIN + '/game-pet-watch'; }
  } catch { /* 保持原样 */ }
}
void refreshPluginOrigin();
setInterval(() => void refreshPluginOrigin(), 10000);
const THEME = {
  bg: '#1b1b1f',
  panel: '#232329',
  line: '#33333c',
  text: '#e8e8ee',
  dim: '#9a9aa8',
  brand: '#4d8dff',
  warn: '#e0a53c',
  err: '#e2564a',
  ok: '#3fbf7f',
};

let tab = 'status';
let snapshot = null;
let memory = null;
let prompt = null;
let promptDirty = false;
let catalog = null;
let catalogEdit = null;   // 正在编辑的动画名
let prefs = null;         // 副本偏好：宠物尺寸 / 文字大小
let game = null;          // 游戏事件源状态（空 / goh）
let database = null;      // 机制数据库状态（空 / goh）
let onebot = null;        // QQ（OneBot）连接与两个硬开关的状态
let images = null;        // 表情包图库（名单 + 描述 + 目录）
let prefsEditing = false; // 正在拖滑块：期间不重绘，否则滑块会被轮询打断

const el = (id) => document.getElementById(id);
const fmt = (ts) => {
  if (!ts) return '—';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/**
 * 面板的所有请求都**带上本条鱼的端口** ✓（`?port=`）。
 * 为什么：插件侧多个接口默认返回"主鱼"的数据 ✗ → 第二只鱼的面板会显示第一只的信息 ✓
 * （主人报"两只鱼记忆混在一起" ✓）。带上端口后插件能按端口认出是哪条鱼 ✓。
 */
function withPort(path) {
  if (!PORT) return path;
  return path + (path.includes('?') ? '&' : '?') + 'port=' + encodeURIComponent(PORT);
}

async function api(path, options) {
  const res = await fetch(API + withPort(path), options);
  return res.json().catch(() => ({}));
}

async function post(path, payload) {
  return api(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload ?? {}),
  });
}

function render() {
  const root = el('body');
  /**
   * 滚动位置保持（关键）：
   *
   * 这个面板每 2 秒轮询一次并**整体重绘**（`root.innerHTML = ...`），而 innerHTML 会把
   * `#page` 节点本身也销毁重建 —— 新节点 scrollTop 恒为 0，于是用户看到"往下滑一下马上弹回顶部"，
   * 且表现为"像有个计时器在归零"（其实就是那 2 秒轮询）。
   *
   * 正解是**复用同一个 #page 节点**：
   *   ① 重绘前先把旧节点从 DOM 上摘下来（不摘的话，innerHTML 一执行它就被销毁了，
   *      事后 insertBefore 插进去的只是游离节点 —— 这一版就踩过这个坑，实测 sameNode=false）；
   *   ② innerHTML 重建外壳（外壳里**不含** #page，避免重复 id）；
   *   ③ 把还活着的旧节点插回页脚之前。
   * 节点没变，浏览器自己维持滚动位置：不跳变、不闪烁，也不需要"记住再还原"那套
   * （那套在这里是无效代码：innerHTML 一换，读到的 prevScroll 已经是 0）。
   */
  const pageKeep = el('page');
  if (pageKeep) pageKeep.remove();
  const runtime = snapshot?.runtime ?? {};
  /**
   * 先判"这个快照是不是正常的状态结构"，别拿坏响应当"未运行"。
   *
   * 踩过的坑：插件接口写错时 `/state` 会返回 **200 + `{error:"collector is not defined"}`**；
   * 面板拿到 200、`runtime` 是 undefined → `running=false` → 显示"未运行 / 开始"，
   * 可宠物明明在跑（而且点"开始"还会打到一个坏接口）。**界面撒谎比不显示更糟。**
   */
  const healthy = typeof runtime.running === 'boolean';
  const running = healthy && Boolean(runtime.running);
  const paused = healthy && Boolean(runtime.paused);
  const errors = snapshot?.errors ?? [];
  const dot = !healthy ? THEME.err : errors.length ? THEME.err : paused && !running ? THEME.warn : running ? THEME.ok : THEME.dim;

  root.innerHTML = `
    <div class="head">
      <span class="dot" style="background:${dot}"></span>
      <span class="title">游戏观察 · ${esc(snapshot?.prompt?.windowTitle || '主屏')}</span>
      ${!healthy ? `<span class="badge" style="border-color:${THEME.err};color:${THEME.err}">状态异常：${esc(String(snapshot?.error ?? '接口没返回 runtime'))}</span>` : ''}
      ${paused && !running ? '<span class="badge">已暂停</span>' : ''}
      <button class="btn" id="toggle" ${healthy ? '' : 'disabled'}>${running ? '暂停' : '开始'}</button>
      <button class="btn" id="shot" ${running ? '' : 'disabled'}>看一帧</button>
      <button class="btn" id="close">×</button>
    </div>
    <div class="tabs">
      <button class="tab ${tab === 'status' ? 'on' : ''}" data-tab="status">状态</button>
      <button class="tab ${tab === 'memory' ? 'on' : ''}" data-tab="memory">记录 ${snapshot?.memory?.total ?? 0}</button>
      <button class="tab ${tab === 'prompt' ? 'on' : ''}" data-tab="prompt">提示词</button>
      <button class="tab ${tab === 'catalog' ? 'on' : ''}" data-tab="catalog">动画 ${catalog?.stats?.total ?? 0}</button>
      <button class="tab ${tab === 'images' ? 'on' : ''}" data-tab="images">表情包 ${images?.items ?? 0}</button>
    </div>
    <div class="foot">
      <a id="shots" href="${API}/shot" target="_blank">看最新截图</a>
      <button class="btn" id="clear-errors">清错误</button>
      <span class="dim" id="hint"></span>
    </div>
  `;

  el('toggle').onclick = async () => {
    // **按鱼**：带上自己的端口，只暂停/恢复这一条（不带 port 就是全局，会误伤别的鱼）
    snapshot = await post('/control', { action: running ? 'pause' : 'start', port: PORT });
    render();
  };
  el('shot').onclick = async () => {
    const r = await post('/capture', {});
    hint(r.ok ? '已截一帧：' + r.info : '截图失败：' + (r.message || ''));
  };
  el('close').onclick = () => window.close();
  /**
   * QQ 两个硬开关：点一下切一次，走插件的 `/onebot {action:'switch'}` ✓
   * （插件会**立即生效并写进自管配置** ✓，所以重启后状态保持 ✓）。
   * 切换后的返回值里没有 status ✗ → 用展开合并保住连接信息 ✓。
   */
  for (const button of document.querySelectorAll('.tab')) {
    button.onclick = () => {
      tab = button.dataset.tab;
      if (tab === 'memory') void loadMemory();
      if (tab === 'prompt') void loadPrompt();
      if (tab === 'catalog') void loadCatalog();
      if (tab === 'images') void loadImages();
      if (tab === 'status') {
        void loadPrefs();
        void loadGame();
        void loadDatabase();
        void loadOnebot();
      }
      render();
    };
  }

  /**
   * 关键一步：**复用上一轮的 #page 节点**，而不是让 innerHTML 生成一个新节点。
   *
   * 为什么：面板整体重绘走的是 root.innerHTML = ...，它会把 #page 节点本身也换成新的，
   * 新节点 scrollTop 恒为 0 —— 所以"先记下滚动位置、重绘后再还原"这条路走不通
   * （实测：重绘时读到的 prevScroll 已经是 0，且 clientHeight 会在 447 与 1047 之间跳）。
   * 直接复用同一个节点，浏览器自己维持滚动位置：不跳变、不闪烁，也不依赖还原逻辑。
   * 节点不存在时（首次渲染）才新建一个。
   */
  let page = pageKeep;
  if (!page) {
    // 首次渲染（或节点被外部清掉）：新建一个
    page = document.createElement('div');
    page.className = 'body';
    page.id = 'page';
  }
  const footEl = document.querySelector('.foot');
  if (footEl && page.nextElementSibling !== footEl) footEl.parentNode.insertBefore(page, footEl);
  else if (!footEl && !document.contains(page)) document.getElementById('body').appendChild(page);
  /**
   * 重设页面内容时**必须自己保存/还原滚动位置**。
   *
   * 复用节点本身不够：`page.innerHTML = ...` 作用在**已存在的节点**上时，浏览器同样会把它的
   * scrollTop 归零（内容整体被替换）。这正是用户看到的"像有个计时器在归零"——那个计时器就是
   * 每 2 秒一次的轮询重绘。所以这里在写 innerHTML 前后显式夹住滚动位置。
   */
  const keepScroll = page.scrollTop;
  if (tab === 'status') page.innerHTML = statusHtml(runtime, errors);
  else if (tab === 'memory') page.innerHTML = memoryHtml();
  else if (tab === 'catalog') page.innerHTML = catalogHtml();
  else if (tab === 'images') page.innerHTML = imagesHtml();
  else page.innerHTML = promptHtml();
  if (keepScroll > 0) {
    // 内容变短时按实际最大可滚值夹取，别设成超出范围的值
    page.scrollTop = Math.min(keepScroll, Math.max(0, page.scrollHeight - page.clientHeight));
  }
  wirePage();
}

function statusHtml(runtime, errors) {
  return `
    ${runtime.paused ? `<div class="box warn">⏸ 已暂停：${esc(runtime.pauseReason || '手动暂停')}（${fmt(runtime.pausedAt)}）不再截屏、不再调模型</div>` : ''}
    <div class="meta">
      <span>截取 ${runtime.captures ?? 0}</span><span>开口 ${runtime.speaks ?? 0}</span>
      <span>压缩 ${runtime.compactions ?? 0}</span><span>模型 ${runtime.lastModelMs ? runtime.lastModelMs + 'ms' : '—'}</span>
    </div>
    <div class="meta">
      <span>上一帧 ${fmt(runtime.lastFrameAt)}</span><span>${esc(runtime.lastCaptureInfo || '—')}</span>
    </div>
    <div class="say">${runtime.lastPhrase ? '🐟 ' + esc(runtime.lastPhrase) : '（还没说话）'}</div>
    ${runtime.lastModelError ? `<div class="box err">⚠ 模型：${esc(runtime.lastModelError)}</div>` : ''}
    ${errors.length ? `<div class="box err">⚠ ${esc(errors[errors.length - 1].message)}</div>` : ''}
    <label class="label">跟鱼说一句（Enter 发送）</label>
    <div class="row">
      <textarea class="input" id="ask" placeholder="例如：这关怎么打？"></textarea>
      <button class="primary" id="ask-btn">发送</button>
    </div>
    <label class="label">QQ（读 / 回复）</label>
    <div class="sec">
      <div class="row">
        <button class="tab ${onebot?.read ? 'on' : ''}" id="qq-read">读：${onebot?.read ? '开' : '关'}</button>
        <button class="tab ${onebot?.reply ? 'on' : ''}" id="qq-reply">回复：${onebot?.reply ? '开' : '关'}</button>
        <span class="dim" style="font-size:11px">
          ${onebot ? (onebot.status?.connected ? '已连 ' + esc(onebot.status.selfId || '') : '未连接') : '（插件没起来？）'}
        </span>
      </div>
      <div class="dim" style="font-size:11px">
        关「读」= 群消息只进记忆，不读图、不拉上下文、不做定时群读（<b>不花钱</b>）；<br />
        关「回复」= 它仍在自己气泡里说话，但一句都不发 QQ。
      </div>
    </div>
    <label class="label">游戏情况</label>
    <div class="sec">
      <div class="row">
        <span class="who">事件源</span>
        <select class="input" id="game-source" style="flex:1 1 auto">
          ${(game?.options || [{ value: '', label: '空' }, { value: 'goh', label: 'goh' }])
            .map((o) => `<option value="${esc(o.value)}"${(game?.source || '') === o.value ? ' selected' : ''}>${esc(o.label)}</option>`)
            .join('')}
        </select>
      </div>
      ${game && game.source === 'goh'
        ? `<div class="meta">
             <span>新事件 ${game.runtime?.newEvents ?? 0}</span>
             <span>重要 ${game.runtime?.importantSeen ?? 0}</span>
             <span>已反应 ${game.runtime?.reactions ?? 0}</span>
             <span>冷却 ${game.cooldownSec ?? '—'}s</span>
           </div>
           <div class="dim" style="font-size:11px">最近一条：${esc(game.status?.last || '（还没读到）')}</div>`
        : '<div class="dim" style="font-size:11px">选 goh 后会读 GoH 对局事件：每次刷新把新增事件带进上下文；出现夺旗/失旗/增援波次/脚本播报等重要事件时立刻向宠物发一次请求。</div>'}
      <div class="dim" style="font-size:11px">切换立即生效（读取器会当场重建），并写回配置以便重启后仍记得。</div>
    </div>
    <label class="label">机制数据库</label>
    <div class="sec">
      <div class="row">
        <span class="who">数据库</span>
        <select class="input" id="db-source" style="flex:1 1 auto">
          ${(database?.options || [{ value: '', label: '空' }, { value: 'goh', label: 'goh' }])
            .map((o) => `<option value="${esc(o.value)}"${(database?.source || '') === o.value ? ' selected' : ''}>${esc(o.label)}</option>`)
            .join('')}
        </select>
      </div>
      ${database && database.source === 'goh'
        ? `<div class="meta">
             <span>速查 ${database.status?.quickChars ?? 0} 字常驻</span>
             <span>完整库 ${database.status?.sections ?? 0} 节</span>
             <span>已查询 ${database.runtime?.lookups ?? 0} 次</span>
           </div>
           <div class="dim" style="font-size:11px">最近查询：${esc(database.status?.lastQuery || '（还没查过）')}${
             database.status?.lastHits?.length ? ' → ' + esc(database.status.lastHits.map((h) => `${h.title}(${h.score})`).join(' / ')) : ''
           }</div>`
        : '<div class="dim" style="font-size:11px">选 goh 后：机制**速查版常驻上下文**（静态、靠缓存几乎免费），完整机制库不占用上下文，模型不确定时**调用工具按需查询**并把相关章节取回来。</div>'}
      <div class="dim" style="font-size:11px">切换立即生效，并写回配置以便重启后仍记得。</div>
    </div>
    <label class="label">外观</label>
    <div class="sec">
      <div class="row">
        <span class="who">名字</span>
        <input class="input" id="pref-name" style="flex:1 1 auto" maxlength="12"
               placeholder="给这只起个名字（区分多只宠物）" value="${esc(prefs?.petName || '')}" ${prefs ? '' : 'disabled'} />
      </div>
      <div class="dim" style="font-size:11px">名字显示在状态胶囊上，用于区分同时跑的多只宠物（如「小蓝 · 观察中 · 350」）。</div>
      <div class="range-row">
        <span class="who">桌宠大小</span>
        <input class="range" type="range" id="pref-size" min="200" max="900" step="10"
               value="${prefs ? prefs.petSize : 462}" ${prefs ? '' : 'disabled'} />
        <span class="val" id="pref-size-val">${prefs ? prefs.petSize : '—'}</span>
      </div>
      <div class="range-row">
        <span class="who">文字大小</span>
        <input class="range" type="range" id="pref-text" min="0.7" max="2" step="0.05"
               value="${prefs ? prefs.textScale : 1}" ${prefs ? '' : 'disabled'} />
        <span class="val" id="pref-text-val">${prefs ? Math.round(prefs.textScale * 100) + '%' : '—'}</span>
      </div>
      <div class="dim" style="font-size:11px">桌宠大小改动后会重建宠物窗（约 2 秒，位置会回到默认角落）；文字大小立即生效。</div>
    </div>
    <label class="label">宠物那边说过的话（副本自己的记录）</label>
    <div class="list" id="petlog"></div>
  `;
}

function memoryHtml() {
  if (!memory) return '<div class="dim">正在读取…</div>';
  const notes = memory.notes ?? [];
  return `
    <div class="sec">
      <div class="row between"><b>长期要点</b><span class="dim">更新于 ${fmt(memory.longTerm?.at)}</span>
        <button class="btn" id="compact">重压</button></div>
      <textarea class="input tall" id="long">${esc(memory.longTerm?.text || '')}</textarea>
      <div class="dim">离开输入框即保存（手改也可以）</div>
    </div>
    <div class="sec">
      <div class="row between"><b>主人备注（${notes.length}）</b></div>
      <div class="list">
        ${notes.map((n) => `<div class="row between"><span>${esc(n.text)}</span><button class="btn" data-del="${esc(n.id)}">删</button></div>`).join('') || '<div class="dim">（还没有备注）</div>'}
      </div>
      <div class="row"><input class="input" id="note" placeholder="提醒它记住的事" /><button class="btn" id="note-add">加</button></div>
    </div>
    <div class="sec">
      <div class="row between"><b>往来记录（${memory.total ?? 0}）</b>
        <button class="btn" id="clear-short">清短期</button><button class="btn" id="clear-all">全清</button></div>
      <div class="list">
        ${(memory.entries ?? [])
          .slice()
          .reverse()
          .map(
            (e) =>
              `<div class="row"><span class="dim">${fmt(e.at)}</span><span class="who">${e.role === 'pet' ? '鱼' : e.role === 'me' ? '我' : '·'}</span><span>${esc(e.text)}</span></div>`,
          )
          .join('') || '<div class="dim">（还没有记录）</div>'}
      </div>
    </div>
  `;
}

function promptHtml() {
  if (!prompt) return '<div class="dim">正在读取…</div>';
  const f = (label, key, opts) => `
    <label class="label">${label}</label>
    ${opts?.multi
      ? `<textarea class="input ${opts.tall ? 'tall' : ''}" data-key="${key}">${esc(prompt[key] ?? '')}</textarea>`
      : `<input class="input" data-key="${key}" ${opts?.num ? 'type="number"' : ''} value="${esc(prompt[key] ?? '')}" />`}
  `;
  return `
    <div class="dim">改完点「写入配置」→ 落到 profile 的 cordis.patch.yml（自动备份），重开 DSH 生效。</div>
    ${f('人设（system 第一段）', 'personality', { multi: true, tall: true })}
    ${f('开口规则', 'rules', { multi: true, tall: true })}
    ${f('长期记忆压缩提示词', 'compactSystem', { multi: true, tall: true })}
    <div class="grid">
      ${f('看窗口', 'windowTitle')}
      ${f('间隔秒', 'intervalSec', { num: true })}
      ${f('冷却秒', 'cooldownSec', { num: true })}
      ${f('单句字数', 'maxChars', { num: true })}
      ${f('记忆条数', 'memoryRecentTurns', { num: true })}
      ${f('压缩阈值', 'compactEvery', { num: true })}
    </div>
    <label class="label">投喂气泡</label>
    <select class="input" data-key="pushToPet">
      <option value="true"${prompt.pushToPet ? ' selected' : ''}>开</option>
      <option value="false"${!prompt.pushToPet ? ' selected' : ''}>关</option>
    </select>
    <div class="row" style="margin-top:8px">
      <button class="primary" id="save-prompt" ${promptDirty ? '' : 'disabled'}>写入配置</button>
      <button class="btn" id="drop-prompt" ${promptDirty ? '' : 'disabled'}>放弃改动</button>
      <button class="btn" id="backup-prompt">备份提示词</button>
    </div>
    <div class="dim" id="patch-path">${esc(snapshot?.patch?.file || '（还没定位到 patch 文件）')}</div>
    <div class="dim" style="font-size:11px">保存会写进上面这个 patch 文件（自动留 .bak 备份），并**立即对当前进程生效**。每次 DSH 启动也会自动存一份快照到 $DSH_HOME/game-pet-watch/prompt-backups/，最多留 30 份——万一配置被别的操作覆盖，从这里能捞回来。</div>
  `;
}

/**
 * 动画目录页：离线生成的描述清单 + 建库控制 + 人工改写。
 * 这里只是"看得见、改得动"的地方；真正花钱的建库在宿主后台跑（分批可续）。
 */
/**
 * 「表情包」页：图库概览 + 名单（带缩略图与描述）+ 打开文件夹 / 刷新。
 *
 * 为什么单独一页：表情包是**描述驱动**的 ✓ —— 模型挑图时看的是描述而不是图 ✗，
 * 所以"哪些图有描述、描述写了什么、图放在哪"是需要经常看的东西 ✓；
 * 而"打开文件夹"是最常要做的手工动作（丢新图进去、删掉不想要的 ✓）。
 */
function imagesHtml() {
  if (!images) return '<div class="box">图库还没加载（插件没起来？）</div>';
  const entries = images.entries || [];
  const self = images.self || '';
  const thumb = (name) => (self ? `${self}/dsh-pet-7340/pic/memes/${encodeURIComponent(name)}.png` : '');
  return `
    <div class="meta">
      <span>共 ${images.items ?? 0} 张</span>
      <span>QQ 自动收 ${images.kept ?? 0} 张</span>
      <span>同步于 ${fmt(images.runtime?.lastSyncAt)}</span>
    </div>
    <div class="dim" style="font-size:11px;word-break:break-all">图库目录：${esc(images.memesDir || '')}</div>
    <div class="row">
      <button class="primary" id="imgs-open">打开文件夹</button>
      <button class="tab" id="imgs-open-user">用户根目录</button>
      <button class="tab" id="imgs-sync">刷新图库</button>
    </div>
    <div class="dim" style="font-size:11px">
      ${images.runtime?.error ? '<b>' + esc(images.runtime.error) + '</b><br />' : ''}
      描述就是模型挑图的依据：写好描述，它才会在该用的时候挑中这张。
    </div>
    <label class="label">库容量上限（可以拉很大）</label>
    <div class="row" style="align-items:center;gap:8px">
      <input type="range" id="imgs-cap" min="50" max="20000" step="50" value="${images.max ?? 500}" style="flex:1 1 auto" />
      <span id="imgs-cap-num" style="font-variant-numeric:tabular-nums;min-width:52px;text-align:right">${images.max ?? 500}</span>
      <span class="dim" style="font-size:11px">已用 ${images.total ?? 0}</span>
    </div>
    <label class="row" style="gap:6px;align-items:center;margin-top:4px">
      <input type="checkbox" id="imgs-evict" ${images.evictEnabled ? 'checked' : ''} />
      <span style="font-size:12px">满了就让它<b>再看一眼图</b>，挑一张最不喜欢的淘汰（移进 <code>memes/.evicted/</code>，不是硬删）</span>
    </label>
    <label class="row" style="gap:6px;align-items:center;margin-top:4px">
      <input type="checkbox" id="imgs-collect" ${images.collectEnabled ? 'checked' : ''} />
      <span style="font-size:12px">群里收到的图<b>都收进库</b>（不叫它也收；每张图一次视觉调用，<b>要花钱</b>）</span>
    </label>
    <div class="dim" style="font-size:11px">已淘汰 ${images.evicted ?? 0} 张 · 已自动收藏 ${images.collected ?? 0} 张 · 开关都会立即生效并写进自管配置</div>
    <div class="sec" style="margin-top:8px">
      ${entries.map((e) => `
        <div class="row" style="gap:8px;align-items:flex-start;border-bottom:1px solid rgba(255,255,255,.05);padding:6px 0">
          <img src="${thumb(e.name)}" style="width:64px;height:64px;object-fit:contain;flex:none;border-radius:6px;background:rgba(255,255,255,.04)" onerror="this.style.opacity=.2" />
          <div style="flex:1;min-width:0">
            <div><b>${esc(e.name)}</b>${e.fromQq ? ' <span class="badge" style="font-size:10px">QQ 收的</span>' : ''}</div>
            <div class="dim" style="font-size:11px">${esc(e.text || '（还没有描述）')}</div>
          </div>
        </div>`).join('') || '<div class="dim">图库是空的</div>'}
    </div>`;
}

function catalogHtml() {
  if (!catalog) return '<div class="dim">正在读取动画目录…</div>';
  const stats = catalog.stats ?? {};
  const build = catalog.build ?? {};
  const items = Object.entries(catalog.items ?? {});
  const progress = build.running
    ? `<div class="box warn">建库中 ${build.done}/${build.total}（失败 ${build.failed}）当前：${esc(build.current || '')}</div>`
    : build.total
      ? `<div class="dim">上次建库：成功 ${build.done}，失败 ${build.failed}</div>`
      : '';
  return `
    <div class="meta">
      <span>已描述 ${stats.described ?? 0}</span><span>总条目 ${stats.total ?? 0}</span>
      <span>人工改过 ${stats.edited ?? 0}</span><span>提示词占 ${stats.chars ?? 0} 字</span>
    </div>
    <div class="row">
      <button class="primary" id="cat-build" ${build.running ? 'disabled' : ''}>建库（补未完成的）</button>
      <label class="dim"><input type="checkbox" id="cat-force" /> 强制重跑</label>
      <button class="btn" id="cat-refresh">刷新</button>
    </div>
    ${progress}
    ${(build.errors ?? []).length ? `<div class="box err">最近失败：${esc(build.errors[build.errors.length - 1].file)} → ${esc(build.errors[build.errors.length - 1].message)}</div>` : ''}
    <div class="dim">模型运行时只读这些描述（不再看视频），所以描述写准了它就选得准；手改过的条目不会被批量覆盖。</div>
    <div class="list">
      ${items
        .map(([name, item]) => {
          const editing = catalogEdit === name;
          const mood = (item.mood ?? []).join('/');
          const scene = (item.scene ?? []).join('/');
          return `
          <div class="row between" style="border-bottom:1px solid #2a2a33;padding:4px 0;align-items:flex-start">
            <div style="flex:1;min-width:0">
              <div class="who">${esc(name)}${item.edited ? ' · 手改' : ''}</div>
              ${
                editing
                  ? `<textarea class="input tall" id="cat-action">${esc(item.action ?? '')}</textarea>
                     <input class="input" id="cat-mood" value="${esc(mood)}" placeholder="情绪标签，用 / 分隔" />
                     <input class="input" id="cat-scene" value="${esc(scene)}" placeholder="场合标签，用 / 分隔" />`
                  : `<div>${esc(item.action || '（还没描述）')}</div>
                     <div class="dim">${mood ? '情绪：' + esc(mood) : ''} ${scene ? '｜场合：' + esc(scene) : ''}</div>`
              }
            </div>
            ${
              editing
                ? `<button class="btn" data-save="${esc(name)}">保存</button><button class="btn" data-cancel="1">取消</button>`
                : `<button class="btn" data-edit="${esc(name)}">改</button><button class="btn" data-drop="${esc(name)}">删</button>`
            }
          </div>`;
        })
        .join('') || '<div class="dim">（目录是空的：点上面的「建库」，它会逐段抽帧、让模型写一句描述）</div>'}
    </div>
  `;
}

async function loadCatalog() {
  const data = await api('/catalog');
  if (data?.ok) catalog = data;
}

/**
 * 两个滑块的接线。
 *
 * 关键点：拖动期间（prefsEditing=true）面板**不重绘** —— 面板每 2 秒整体重绘一次，
 * 重绘会把正在拖的滑块换成新节点，手感变成"拖一下就断"。松手（change）后才恢复重绘。
 * 滑块的 POST 也做了去抖：input 事件很密，每个都发一次请求既没必要也容易乱序。
 */
function wirePrefs() {
  const size = el('pref-size');
  const text = el('pref-text');
  if (!size && !text) return;

  let timer = null;
  const push = (payload, label) => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const r = await post('/prefs', payload);
      if (r?.ok) {
        prefs = r.prefs;
        hint(r.rebuilding ? `${label} 已保存，正在重建宠物窗…` : `${label} 已保存`);
      } else {
        hint(`${label} 保存失败：${r?.message || '未知错误'}`);
      }
      prefsEditing = false;
    }, 350);
  };

  const name = el('pref-name');
  if (name) {
    const save = async () => {
      const r = await post('/prefs', { petName: name.value });
      if (r?.ok) {
        prefs = r.prefs;
        name.value = prefs.petName || '';
        hint(prefs.petName ? `名字已改为「${prefs.petName}」` : '名字已清空');
      } else {
        hint('名字保存失败：' + (r?.message || '未知错误'));
      }
    };
    name.addEventListener('change', () => void save());
    name.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') name.blur();
    });
  }

  if (size) {
    size.oninput = () => {
      prefsEditing = true;
      el('pref-size-val').textContent = size.value;
    };
    size.onchange = () => {
      el('pref-size-val').textContent = size.value;
      push({ petSize: Number(size.value), rebuild: true }, '桌宠大小');
    };
  }
  if (text) {
    text.oninput = () => {
      prefsEditing = true;
      el('pref-text-val').textContent = Math.round(Number(text.value) * 100) + '%';
    };
    text.onchange = () => {
      el('pref-text-val').textContent = Math.round(Number(text.value) * 100) + '%';
      push({ textScale: Number(text.value) }, '文字大小');
    };
  }
}

function wireCatalog() {
  const buildBtn = el('cat-build');
  if (buildBtn) {
    buildBtn.onclick = async () => {
      const force = el('cat-force')?.checked === true;
      // 不传 limit：一次建到头（分批在服务端是逐条落盘的，中断了再点也只会接着跑）
      const result = await post('/catalog', { action: 'build', force });
      if (!result?.ok) hint('建库没起来：' + (result?.message || ''));
      else hint(`已开始建库：待处理 ${result.todo} 段（共 ${result.pending} 段未完成）`);
      void loadCatalog().then(render);
    };
  }
  const refresh = el('cat-refresh');
  if (refresh) refresh.onclick = () => void loadCatalog().then(render);

  for (const button of document.querySelectorAll('[data-edit]')) {
    button.onclick = () => {
      catalogEdit = button.dataset.edit;
      render();
    };
  }
  for (const button of document.querySelectorAll('[data-cancel]')) {
    button.onclick = () => {
      catalogEdit = null;
      render();
    };
  }
  for (const button of document.querySelectorAll('[data-drop]')) {
    button.onclick = async () => {
      await post('/catalog', { action: 'remove', name: button.dataset.drop });
      void loadCatalog().then(render);
    };
  }
  for (const button of document.querySelectorAll('[data-save]')) {
    button.onclick = async () => {
      const name = button.dataset.save;
      const split = (value) => String(value || '').split(/[、,，/]/).map((s) => s.trim()).filter(Boolean).slice(0, 3);
      const result = await post('/catalog', {
        action: 'edit',
        name,
        action2: el('cat-action')?.value ?? '',
        mood: split(el('cat-mood')?.value),
        scene: split(el('cat-scene')?.value),
      });
      catalogEdit = null;
      hint(result?.ok ? '已保存（标为手改，批量不再覆盖）' : '保存失败');
      void loadCatalog().then(render);
    };
  }
}

function wirePage() {
  wireCatalog();
  wirePrefs();
  const ask = el('ask');
  if (ask) {
    /**
     * 发送必须防重 —— **这里是"暂停后调用多次 API"的真正来源**。
     *
     * 之前没有任何锁：一按 Enter 就立刻 `ask.value = ''` 清空输入框，用户看着框空了、
     * 以为已经处理完，等不及回复又按一次；每按一次就是一次完整模型调用（带图、要花钱）。
     * 模型慢（数秒）时很容易叠出"相隔几秒的好几条"。浮层那个输入框有 sending 锁，这里没有，
     * 所以这个现象只在面板上出现。
     *
     * 锁必须在 await 之前**同步**置位：JS 单线程，"检查 + 置位"之间不会被打断，连按两次也不会双通过。
     */
    let sending = false;
    const send = async () => {
      if (sending) return;
      const text = ask.value.trim();
      if (!text) return;
      sending = true;
      const btn = el('ask-btn');
      if (btn) {
        btn.disabled = true;
        btn.textContent = '等待…';
      }
      ask.value = '';
      hint('已发送，等鱼回答…');
      try {
        const r = await post('/ask', { text, push: 'gpw', pet: 'gpw' });
        if (r.ok) {
          // 暂停期间的手动提问：照答一次，但明确告知"自动跟拍仍是暂停的"，避免误以为暂停被解除
          hint((r.paused ? '（自动跟拍仍暂停）鱼：' : '鱼：') + r.text);
        } else {
          hint('失败：' + (r.message || ''));
        }
        void refresh();
      } finally {
        sending = false;
        if (btn) {
          btn.disabled = false;
          btn.textContent = '发送';
        }
      }
    };
    el('ask-btn').onclick = send;
    ask.onkeydown = (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        void send();
      }
    };
    void loadPetLog();
  }
  const long = el('long');
  if (long) {
    long.onblur = async () => {
      await post('/memory', { action: 'set-long', text: long.value });
      hint('长期要点已保存');
    };
  }
  const compact = el('compact');
  if (compact) {
    compact.onclick = async () => {
      const r = await post('/memory', { action: 'compact' });
      hint(r.ok ? '已重压长期记忆' : '重压失败：' + (r.message || ''));
      void loadMemory().then(render);
    };
  }
  /**
   * 表情包页：容量滑块 + 淘汰开关。
   * 滑块**拖动时不发请求**（每像素一次会把插件打爆 ✗），松手（change）才发 ✓。
   */
  const capSlider = el('imgs-cap');
  if (capSlider) {
    capSlider.oninput = () => {
      const num = el('imgs-cap-num');
      if (num) num.textContent = capSlider.value;
    };
    capSlider.onchange = async () => {
      const r = await post('/images', { action: 'set-cap', max: Number(capSlider.value) });
      hint(r.ok ? `库上限已设为 ${r.max} 张（已用 ${r.used}）` : '设置失败：' + (r.error || ''));
      await loadImages();
    };
  }
  const collectBox = el('imgs-collect');
  if (collectBox) {
    collectBox.onchange = async () => {
      const r = await post('/images', { action: 'set-collect', enabled: collectBox.checked });
      hint(r.ok ? ('群里收到的图就收藏：' + (r.enabled ? '开' : '关')) : '设置失败：' + (r.error || ''));
      await loadImages();
    };
  }
  const evictBox = el('imgs-evict');
  if (evictBox) {
    evictBox.onchange = async () => {
      const r = await post('/images', { action: 'set-evict', enabled: evictBox.checked });
      hint(r.ok ? ('满了自动淘汰：' + (r.enabled ? '开' : '关')) : '设置失败：' + (r.error || ''));
    };
  }
  /** 表情包页：打开文件夹 / 刷新图库 */
  const imgsOpen = el('imgs-open');
  if (imgsOpen) {
    imgsOpen.onclick = async () => {
      const r = await post('/images', { action: 'open', which: 'memes' });
      hint(r.ok ? '已打开：' + r.path : '打开失败：' + (r.error || ''));
    };
  }
  const imgsOpenUser = el('imgs-open-user');
  if (imgsOpenUser) {
    imgsOpenUser.onclick = async () => {
      const r = await post('/images', { action: 'open', which: 'user' });
      hint(r.ok ? '已打开：' + r.path : '打开失败：' + (r.error || ''));
    };
  }
  const imgsSync = el('imgs-sync');
  if (imgsSync) {
    imgsSync.onclick = async () => {
      hint('正在刷新图库（新图会补描述，慢一点）…');
      const r = await post('/images', {});
      await loadImages();
      hint(r.ok ? `图库已刷新：共 ${r.total ?? '?'} 张，新增 ${r.added ?? 0}` : '刷新失败：' + (r.error || ''));
      render();
    };
  }
  const qqRead = el('qq-read');
  if (qqRead) {
    qqRead.onclick = async () => {
      const r = await post('/onebot', { action: 'switch', read: !onebot?.read });
      onebot = { ...onebot, ...r };
      hint('QQ 读取已' + (r.read ? '打开' : '关闭'));
      render();
    };
  }
  const qqReply = el('qq-reply');
  if (qqReply) {
    qqReply.onclick = async () => {
      const r = await post('/onebot', { action: 'switch', reply: !onebot?.reply });
      onebot = { ...onebot, ...r };
      hint('QQ 回复已' + (r.reply ? '打开' : '关闭'));
      render();
    };
  }
  el('clear-errors').onclick = async () => {
    snapshot = await post('/control', { action: 'clear-errors' });
    render();
  };
  const noteAdd = el('note-add');
  if (noteAdd) {
    noteAdd.onclick = async () => {
      const input = el('note');
      if (!input.value.trim()) return;
      await post('/memory', { action: 'note', text: input.value.trim() });
      input.value = '';
      void loadMemory().then(render);
    };
  }
  for (const button of document.querySelectorAll('[data-del]')) {
    button.onclick = async () => {
      await post('/memory', { action: 'remove-note', id: button.dataset.del });
      void loadMemory().then(render);
    };
  }
  const clearShort = el('clear-short');
  if (clearShort) {
    clearShort.onclick = async () => {
      await post('/memory', { action: 'clear', kind: 'short' });
      void loadMemory().then(render);
    };
  }
  const clearAll = el('clear-all');
  if (clearAll) {
    clearAll.onclick = async () => {
      await post('/memory', { action: 'clear', kind: 'all' });
      void loadMemory().then(render);
    };
  }
  for (const field of document.querySelectorAll('[data-key]')) {
    field.oninput = () => {
      const key = field.dataset.key;
      let value = field.value;
      if (key === 'pushToPet') value = value === 'true';
      else if (['intervalSec', 'cooldownSec', 'maxChars', 'memoryRecentTurns', 'compactEvery'].includes(key)) value = Number(value);
      prompt[key] = value;
      promptDirty = true;
      const save = el('save-prompt');
      if (save) save.disabled = false;
      const drop = el('drop-prompt');
      if (drop) drop.disabled = false;
    };
  }
  const src = el('game-source');
  if (src) {
    src.onchange = async () => {
      const next = src.value;
      const r = await post('/game', { source: next });
      if (r?.ok) {
        hint(next === 'goh' ? '已切到 goh —— 开始读对局事件' : '已切到「空」—— 不看游戏事件');
        await loadGame();
        render();
      } else {
        hint('切换失败：' + (r?.error || r?.message || '未知错误'));
      }
    };
  }
  const dbsrc = el('db-source');
  if (dbsrc) {
    dbsrc.onchange = async () => {
      const next = dbsrc.value;
      const r = await post('/database', { source: next });
      if (r?.ok) {
        hint(next === 'goh' ? '已启用机制库（速查常驻 + 工具按需查询）' : '已关闭机制库');
        await loadDatabase();
        render();
      } else {
        hint('切换失败：' + (r?.error || r?.message || '未知错误'));
      }
    };
  }
  const backup = el('backup-prompt');
  if (backup) {
    backup.onclick = async () => {
      const r = await post('/prompt', { action: 'backup' });
      const short = r?.file ? String(r.file).split(/[\\/]/).slice(-2).join('/') : '';
      hint(r?.ok ? '已备份到：' + short : '备份失败');
    };
  }
  const save = el('save-prompt');
  if (save) {
    save.onclick = async () => {
      const r = await post('/prompt', { values: prompt });
      if (r.ok) {
        promptDirty = false;
        hint('已写入 ' + r.file + (r.backup ? '（备份 ' + r.backup.split('\\').pop() + '）' : '') + ' —— 重开 DSH 生效');
        render();
      } else {
        hint('写入失败：' + (r.message || ''));
      }
    };
  }
  const drop = el('drop-prompt');
  if (drop) {
    drop.onclick = async () => {
      promptDirty = false;
      await loadPrompt();
      render();
    };
  }
}

let hintTimer;
function hint(text) {
  const node = el('hint');
  if (!node) return;
  node.textContent = text;
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => {
    if (node) node.textContent = '';
  }, 6000);
}

async function loadPetLog() {
  try {
    const res = await fetch('http://127.0.0.1:' + (new URLSearchParams(location.search).get('port') || '7341') + '/gpw/log?limit=12');
    const data = await res.json();
    const node = el('petlog');
    if (!node) return;
    node.innerHTML =
      (data.entries ?? [])
        .slice()
        .reverse()
        .map((e) => `<div class="row"><span class="dim">${fmt(e.at)}</span><span>${esc(e.text)}</span></div>`)
        .join('') || '<div class="dim">（还没有）</div>';
  } catch {
    /* 宠物服务没起来也不影响面板其它部分 */
  }
}

async function loadMemory() {
  memory = await api('/memory?limit=80');
}

async function loadPrompt() {
  const data = await api('/prompt');
  if (data?.ok) prompt = data.prompt;
}

/** 读副本偏好（尺寸 / 文字大小） */
async function loadPrefs() {
  try {
    const data = await api('/prefs');
    if (data?.ok) prefs = data.prefs;
  } catch {
    /* 副本没起来 */
  }
}

/** 读游戏事件源状态（空 / goh） */
async function loadGame() {
  try {
    const data = await api('/game');
    if (data?.ok) game = data;
  } catch {
    /* 插件没起来 */
  }
}

/** 读机制数据库状态（空 / goh） */
/**
 * 拉 QQ 状态：连接情况 + 两个硬开关（读 / 回复）。
 * 插件没起来时静默失败 —— 面板其余部分照常能用 ✓。
 */
/**
 * 拉表情包图库：名单 + 描述 + 目录 + QQ 收了几张。
 * 用于"表情包"页的列表与"打开文件夹"按钮 ✓。
 */
async function loadImages() {
  try {
    const data = await api('/images');
    if (data?.ok && JSON.stringify(data.entries ?? []) !== JSON.stringify(images?.entries ?? [])) {
      images = data;
      render(); // 数据变了就立刻重绘（不然要等 2 秒轮询，甚至永远不重绘 ✗）
    } else if (data?.ok) {
      images = data;
    }
  } catch {
    /* 插件没起来 */
  }
}

async function loadOnebot() {
  try {
    const data = await api('/onebot');
    if (!data?.ok) return;
    const changed = !onebot || onebot.read !== data.read || onebot.reply !== data.reply
      || onebot.status?.connected !== data.status?.connected || onebot.status?.events !== data.status?.events;
    onebot = data;
    if (changed) render(); // 同上：开关状态一变就立刻重绘 ✓
  } catch {
    /* 插件没起来 */
  }
}

async function loadDatabase() {
  try {
    const data = await api('/database');
    if (data?.ok) database = data;
  } catch {
    /* 插件没起来 */
  }
}

async function refresh() {
  try {
    const data = await api('/state');
    if (data?.ok) snapshot = data;
  } catch {
    /* 宿主没起来 */
  }
}

/**
 * 当前页面的"内容指纹"：变了才值得重绘。
 *
 * 只覆盖会显示在页面里的数据（截取/开口/压缩/最近一句/错误数、记忆条数、目录条数、
 * 当前标签页）。故意不包含时间戳类的高频字段——那些走 updateLiveBits() 就地更新，
 * 不值得为它们重建 DOM 并让滚动位置归零。
 */
function pageSignature() {
  const r = snapshot?.runtime ?? {};
  return JSON.stringify([
    tab,
    r.captures ?? 0,
    r.speaks ?? 0,
    r.compactions ?? 0,
    r.running === true,
    r.paused === true,
    r.lastPhrase ?? '',
    r.lastModelError ?? '',
    (snapshot?.errors ?? []).length,
    snapshot?.memory?.total ?? 0,
    (snapshot?.memory?.notes ?? []).length,
    catalog?.stats?.total ?? 0,
    prefs ? [prefs.petSize, prefs.textScale] : null,
    promptDirty === true,
    /**
     * 新增数据也必须进指纹 ✗→✓：
     * 没有这两行时，`onebot`/`images` 拉回来之后**永远不会重绘** ✗
     * —— 表现就是"QQ 开关看着是关的、点了没反应""表情包页一直说没加载" ✓。
     */
    onebot ? [onebot.read, onebot.reply, onebot.status?.connected, onebot.status?.events ?? 0] : null,
    images ? [images.items ?? 0, images.kept ?? 0, (images.entries ?? []).length, images.max ?? 0, images.evictEnabled === true, images.total ?? 0, images.evicted ?? 0, images.collectEnabled === true, images.collected ?? 0] : null,
  ]);
}

/** 内容没变时，只就地更新那几个"会变的小字"（状态灯、标签页计数、脚注时间） */
function updateLiveBits() {
  const r = snapshot?.runtime ?? {};
  const dot = document.querySelector('.dot');
  if (dot) {
    dot.style.background = (snapshot?.errors ?? []).length
      ? THEME.err
      : r.paused && !r.running
        ? THEME.warn
        : r.running
          ? THEME.ok
          : THEME.dim;
  }
  const tabs = document.querySelectorAll('.tab');
  if (tabs[1] && snapshot?.memory) tabs[1].textContent = `记录 ${snapshot.memory.total ?? 0}`;
  if (tabs[3] && catalog?.stats) tabs[3].textContent = `动画 ${catalog.stats.total ?? 0}`;
}

async function main() {
  await refresh();
  await loadPrompt();
  await loadPrefs();
  await loadGame();
  await loadDatabase();
  /** 首次打开就要看到 QQ 开关的真实状态（不然会显示成"关"✗） */
  await loadOnebot();
  render();
  let lastSignature = pageSignature();
  setInterval(async () => {
    await refresh();
    /**
     * **这两个页签的数据要跟着轮询刷新**（不然开关状态/图库张数会停在打开那一刻 ✓，
     * 甚至因为指纹里没有它们而**永远不重绘** ✗ —— 就是"点了没反应"的根因 ✓）。
     * 只在这两个页签可见时才拉，别的页签不多花请求 ✓。
     */
    if (tab === 'status') await loadOnebot();
    if (tab === 'images') await loadImages();
    if (tab === 'catalog') {
      await loadCatalog();
      if (!catalogEdit) {
        const sig = pageSignature();
        if (sig !== lastSignature) {
          lastSignature = sig;
          render();
        }
      }
      return;
    }
    // prefsEditing：正在拖滑块 → 不重绘（否则滑块节点被换掉，拖动会断）
    if (prefsEditing) return;
    /**
     * **内容没变就不重绘** —— 这是"滚动位置每 2 秒被归零"的根本解法。
     *
     * 之前每 2 秒无脑 `render()`，而 render 会重写页面内容；浏览器在内容被替换时会把滚动位置
     * 归零（用户描述得非常准："像有个计时器"——那个计时器就是这 2 秒轮询）。
     * 现在先算一个内容指纹：变了才重绘，没变连 DOM 都不碰，滚动自然稳如泰山。
     * 提示词页/记忆页的内容是按需加载的，指纹只覆盖当前显示的东西，不会误判。
     */
    const sig = pageSignature();
    if (sig !== lastSignature) {
      lastSignature = sig;
      render();
      return;
    }
    // 内容没变：只把"会变的那几个小字"就地更新，不动结构
    updateLiveBits();
  }, 2000);
}

void main();
