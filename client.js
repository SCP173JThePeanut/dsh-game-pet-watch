/**
 * dsh-game-pet-watch —— 浏览器半侧（贴着宠物的对话面板）
 *
 * 三个页签，都是宿主状态的视图，自己不藏业务逻辑：
 *   状态   循环开关 / 暂停原因 / 计数 / 最近一句 / 回话输入框
 *   记录   长期要点（可手改）+ 主人备注 + 短期往来（可滚动、可清）
 *   提示词 人设、开口规则、压缩提示词、节奏数值 → 写回 profile 的 patch 层
 *
 * 面板默认**贴在大肥鱼身上**：每 250ms 读 .dsh-pet-hit 的位置，把面板挂在宠物旁边；
 * 鱼在屏幕上溜达、被拖走都跟着走，越界自动翻边并夹回视口内。找不到宠物（dsh-pet 没装 /
 * 该形态没显示）时退回右下角固定位，也可以拖到任意位置（拖一下自动切「固定」）。
 *
 * 只取别人的定位矩形（getBoundingClientRect），不读它的样式、不改它的 DOM。
 * 样式只用宿主主题 token（--dsw-alias-*），浅色/深色自动跟随。
 */
window.__ModuleLoader__.load({
  id: 'dsh-game-pet-watch',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useMemo, useRef, useState } = React;

    const API = '/game-pet-watch';
    const POLL_MS = 1500;
    const ANCHOR_MS = 250;
    const CARD_ID = 'game-pet-watch-card';
    const PET_HIT_SELECTOR = '.dsh-pet-hit';
    const PANEL_W = 330;

    /**
     * **一加载就敲一下插件**（2026-10-18 修：DSH 重启后胶囊一直"插件离线"）。
     *
     * 插件学自己地址的唯一可靠来源是"**收到一条请求**"（`req.socket.localPort`）。
     * 重启后如果没人访问插件接口：登记簿一直是空，副本只能退到写死的 19387 →
     * 胶囊/输入框全指向死端口，而且不会自愈（因为没人来敲）。
     *
     * 这个文件是 DSH 页面打开就会加载的（`dsh.client.immediately`），所以在这里发一次
     * **相对路径**请求：它一定命中当前端口的插件，插件随即学会自己的地址并发布登记簿。
     * 之后每 30 秒再敲一次，防止"登记簿被别的进程覆盖/清空"。
     */
    const pingPlugin = () => {
      try {
        void fetch(API + '/ping', { cache: 'no-store' }).catch(() => {});
      } catch {
        /* 页面还没就绪就算了 */
      }
    };
    pingPlugin();
    setInterval(pingPlugin, 30000);

    const CSS = `
.gpw-card {
  position: fixed;
  width: ${PANEL_W}px;
  display: flex;
  flex-direction: column;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 12px;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.28);
  font-size: 12px;
  line-height: 1.6;
  overflow: hidden;
  z-index: 1000;
}
.gpw-card.is-paused { border-color: var(--dsw-alias-state-warn-primary); }
.gpw-head {
  display: flex; align-items: center; gap: 6px;
  padding: 6px 8px; background: var(--dsw-alias-bg-layer-2);
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  cursor: grab; user-select: none;
}
.gpw-head:active { cursor: grabbing; }
.gpw-title { flex: 1; min-width: 0; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.gpw-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
.gpw-badge {
  flex: none; padding: 0 5px; border-radius: 5px; font-size: 10px;
  border: 1px solid var(--dsw-alias-state-warn-primary);
  color: var(--dsw-alias-state-warn-primary);
}
.gpw-btn {
  border: 1px solid var(--dsw-alias-border-l1); background: transparent;
  color: var(--dsw-alias-label-secondary); border-radius: 6px;
  padding: 1px 6px; font-size: 11px; cursor: pointer; white-space: nowrap;
}
.gpw-btn:hover { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-border-l2); }
.gpw-btn[disabled] { opacity: .5; cursor: default; }
.gpw-btn.is-on { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); }
.gpw-tabs { display: flex; gap: 2px; padding: 4px 6px 0; background: var(--dsw-alias-bg-layer-2); }
.gpw-tab {
  border: none; background: transparent; color: var(--dsw-alias-label-secondary);
  padding: 3px 8px; border-radius: 6px 6px 0 0; cursor: pointer; font: inherit;
}
.gpw-tab.is-active { background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font-weight: 600; }
.gpw-body { padding: 8px; overflow-y: auto; max-height: 52vh; display: flex; flex-direction: column; gap: 7px; }
.gpw-meta { color: var(--dsw-alias-label-secondary); display: flex; flex-wrap: wrap; gap: 3px 10px; }
.gpw-say {
  padding: 7px 9px; border-radius: 8px; background: var(--dsw-alias-bg-overlay);
  border: 1px solid var(--dsw-alias-border-l1); min-height: 32px; word-break: break-word;
}
.gpw-pause {
  padding: 5px 8px; border-radius: 8px; word-break: break-word;
  border: 1px solid var(--dsw-alias-state-warn-primary); color: var(--dsw-alias-state-warn-primary);
}
.gpw-sec { border-top: 1px solid var(--dsw-alias-border-l1); padding-top: 6px; }
.gpw-secHead { display: flex; align-items: center; gap: 6px; margin-bottom: 3px; }
.gpw-secTitle { flex: 1; font-weight: 600; }
.gpw-log { display: flex; flex-direction: column; gap: 3px; }
.gpw-row { display: flex; gap: 6px; }
.gpw-role { flex: none; color: var(--dsw-alias-label-secondary); }
.gpw-text { word-break: break-word; flex: 1; min-width: 0; }
.gpw-time { flex: none; color: var(--dsw-alias-label-secondary); font-size: 10px; }
.gpw-err { color: var(--dsw-alias-state-error-primary); word-break: break-word; }
.gpw-form { display: flex; gap: 6px; }
.gpw-input, .gpw-area {
  width: 100%; box-sizing: border-box; padding: 5px 7px; border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary); font: inherit;
}
.gpw-input { flex: 1; min-width: 0; resize: none; height: 30px; max-height: 90px; }
.gpw-area { resize: vertical; min-height: 54px; line-height: 1.5; }
.gpw-input:focus, .gpw-area:focus { outline: none; border-color: var(--dsw-alias-brand-primary); }
.gpw-send {
  flex: none; border-radius: 8px; border: 1px solid var(--dsw-alias-brand-primary);
  background: var(--dsw-alias-brand-primary); color: #fff; padding: 0 10px; cursor: pointer; font: inherit;
}
.gpw-send[disabled] { opacity: .5; cursor: default; }
.gpw-field { display: flex; flex-direction: column; gap: 2px; }
.gpw-label { color: var(--dsw-alias-label-secondary); }
.gpw-num { width: 66px; }
.gpw-note { color: var(--dsw-alias-label-secondary); }
.gpw-link { color: var(--dsw-alias-brand-primary); }
.gpw-quote { color: var(--dsw-alias-label-secondary); white-space: pre-wrap; word-break: break-word; }
`;

    const fmtTime = (ts) => {
      if (!ts) return '—';
      const d = new Date(ts);
      const pad = (n) => String(n).padStart(2, '0');
      return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    };

    const dotColor = (running, paused, errorCount) => {
      if (errorCount) return 'var(--dsw-alias-state-error-primary)';
      if (paused && !running) return 'var(--dsw-alias-state-warn-primary)';
      if (running) return 'var(--dsw-alias-state-success-primary)';
      return 'var(--dsw-alias-state-idle-primary)';
    };

    async function post(path, payload) {
      const response = await fetch(API + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload ?? {}),
      });
      return response.json().catch(() => ({}));
    }

    /** 宠物身体命中区的位置（找不到就 undefined） */
    function readPetRect() {
      const nodes = document.querySelectorAll(PET_HIT_SELECTOR);
      if (!nodes.length) return undefined;
      let best;
      for (const node of nodes) {
        const rect = node.getBoundingClientRect();
        if (rect.width < 8 || rect.height < 8) continue;
        if (!best || rect.width * rect.height > best.width * best.height) best = rect;
      }
      return best;
    }

    function Panel() {
      const [visible, setVisible] = useState(true);
      const [tab, setTab] = useState('status');
      const [snapshot, setSnapshot] = useState(null);
      const [error, setError] = useState('');
      const [notice, setNotice] = useState('');
      const [draft, setDraft] = useState('');
      const [busy, setBusy] = useState(false);
      const [log, setLog] = useState([]);
      const [manualPos, setManualPos] = useState(null);
      const [anchored, setAnchored] = useState(true);
      const [petRect, setPetRect] = useState(null);
      const [memory, setMemory] = useState(null);
      const [prompt, setPrompt] = useState(null);
      const [promptDirty, setPromptDirty] = useState(false);
      const [noteDraft, setNoteDraft] = useState('');
      const cardRef = useRef(null);
      const dragRef = useRef(null);

      // ---- 宿主状态轮询（页面不可见时停）
      useEffect(() => {
        let alive = true;
        let timer;
        const poll = async () => {
          try {
            const response = await fetch(API + '/state', { cache: 'no-store' });
            const data = await response.json();
            if (alive && data && data.ok) setSnapshot(data);
          } catch {
            /* 宿主还没起来，下一轮再试 */
          }
          if (alive) timer = setTimeout(poll, POLL_MS);
        };
        const onVisibility = () => {
          if (document.visibilityState === 'visible') {
            clearTimeout(timer);
            void poll();
          }
        };
        void poll();
        document.addEventListener('visibilitychange', onVisibility);
        return () => {
          alive = false;
          clearTimeout(timer);
          document.removeEventListener('visibilitychange', onVisibility);
        };
      }, []);

      // ---- 跟着宠物走
      useEffect(() => {
        if (!anchored || !visible) return undefined;
        const tick = () => setPetRect(readPetRect() ?? null);
        tick();
        const timer = setInterval(tick, ANCHOR_MS);
        return () => clearInterval(timer);
      }, [anchored, visible]);

      // ---- 记录页签：按需拉取并小步刷新
      useEffect(() => {
        if (tab !== 'memory' || !visible) return undefined;
        let alive = true;
        const load = async () => {
          try {
            const response = await fetch(API + '/memory?limit=60', { cache: 'no-store' });
            const data = await response.json();
            if (alive && data?.ok) setMemory(data);
          } catch {
            /* 忽略 */
          }
        };
        void load();
        const timer = setInterval(load, 4000);
        return () => {
          alive = false;
          clearInterval(timer);
        };
      }, [tab, visible, snapshot?.memory?.total]);


      // ---- 提示词页签：拉一次（有未保存改动就不覆盖）
      useEffect(() => {
        if (tab !== 'prompt' || !visible || promptDirty) return undefined;
        let alive = true;
        const load = async () => {
          try {
            const response = await fetch(API + '/prompt', { cache: 'no-store' });
            const data = await response.json();
            if (alive && data?.ok) setPrompt(data.prompt);
          } catch {
            /* 忽略 */
          }
        };
        void load();
        return () => {
          alive = false;
        };
      }, [tab, visible, promptDirty]);

      const onPointerDown = useCallback((event) => {
        const rect = cardRef.current?.getBoundingClientRect();
        if (!rect) return;
        dragRef.current = { dx: event.clientX - rect.left, dy: event.clientY - rect.top };
        event.currentTarget.setPointerCapture?.(event.pointerId);
      }, []);
      const onPointerMove = useCallback((event) => {
        const drag = dragRef.current;
        if (!drag) return;
        setAnchored(false);
        const width = cardRef.current?.offsetWidth ?? PANEL_W;
        const x = Math.max(4, Math.min(window.innerWidth - width - 4, event.clientX - drag.dx));
        const y = Math.max(4, Math.min(window.innerHeight - 40, event.clientY - drag.dy));
        setManualPos({ x, y });
      }, []);
      const onPointerUp = useCallback((event) => {
        dragRef.current = null;
        event.currentTarget.releasePointerCapture?.(event.pointerId);
      }, []);

      const runtime = snapshot?.runtime;
      const running = Boolean(runtime?.running);
      const paused = Boolean(runtime?.paused);
      const errors = snapshot?.errors ?? [];

      const style = useMemo(() => {
        const height = cardRef.current?.offsetHeight ?? 380;
        if (anchored && petRect) {
          let left = petRect.left - PANEL_W - 8;
          if (left < 6) left = Math.min(petRect.right + 8, window.innerWidth - PANEL_W - 6);
          left = Math.max(6, Math.min(window.innerWidth - PANEL_W - 6, left));
          let top = petRect.top - height - 6;
          if (top < 6) top = Math.max(6, Math.min(window.innerHeight - 60, petRect.bottom - height * 0.5));
          return { left, top };
        }
        if (manualPos) return { left: manualPos.x, top: manualPos.y };
        return { right: 18, bottom: 18 };
      }, [anchored, petRect, manualPos]);

      const control = async (action, extra) => {
        setBusy(true);
        try {
          const data = await post('/control', { action, ...(extra ?? {}) });
          if (data && data.runtime) setSnapshot((prev) => ({ ...(prev ?? {}), ...data }));
          if (action === 'pause' || action === 'stop') setNotice('已暂停：不再截屏、不再调模型。点「开始」恢复。');
          else setNotice('');
        } catch (e) {
          setError(String(e?.message ?? e));
        } finally {
          setBusy(false);
        }
      };

      const send = async () => {
        const text = draft.trim();
        if (!text || busy) return;
        setBusy(true);
        setError('');
        setLog((prev) => [...prev.slice(-8), { role: '我', text }]);
        setDraft('');
        try {
          const data = await post('/ask', { text });
          if (data?.ok) setLog((prev) => [...prev.slice(-8), { role: '鱼', text: data.text ?? '' }]);
          else {
            setError(String(data?.message ?? '发送失败'));
            setLog((prev) => [...prev.slice(-8), { role: '鱼', text: '（没接上话）', bad: true }]);
          }
        } catch (e) {
          setError(String(e?.message ?? e));
        } finally {
          setBusy(false);
        }
      };

      const refreshMemory = async () => {
        try {
          const response = await fetch(API + '/memory?limit=60', { cache: 'no-store' });
          const fresh = await response.json();
          if (fresh?.ok) setMemory(fresh);
        } catch {
          /* 忽略 */
        }
      };

      const memoryAction = async (action, payload) => {
        setBusy(true);
        setError('');
        try {
          const data = await post('/memory', { action, ...(payload ?? {}) });
          if (data?.ok === false) setError(String(data.message ?? '操作失败'));
          if (action === 'compact' && data?.ok) setNotice('长期记忆已重压');
          await refreshMemory();
        } catch (e) {
          setError(String(e?.message ?? e));
        } finally {
          setBusy(false);
        }
      };

      const savePrompt = async () => {
        if (!prompt) return;
        setBusy(true);
        setError('');
        try {
          const data = await post('/prompt', { values: prompt });
          if (data?.ok) {
            setPromptDirty(false);
            const backupName = data.backup ? String(data.backup).split(/[\\/]/).pop() : '';
            setNotice(`已写入 ${data.file}${backupName ? '（备份 ' + backupName + '）' : ''} —— 重开 DSH 后生效`);
          } else {
            setError(String(data?.message ?? '写入失败'));
          }
        } catch (e) {
          setError(String(e?.message ?? e));
        } finally {
          setBusy(false);
        }
      };

      if (!visible) {
        return h(
          'button',
          {
            id: CARD_ID + '-chip',
            className: 'gpw-btn' + (paused ? '' : ' is-on'),
            style: {
              position: 'fixed',
              right: 18,
              bottom: 18,
              zIndex: 1000,
              padding: '4px 10px',
              background: 'var(--dsw-alias-bg-layer-1)',
              boxShadow: '0 6px 18px rgba(0,0,0,.22)',
            },
            onClick: () => setVisible(true),
            title: '打开游戏观察面板',
          },
          (paused ? '⏸ ' : '🎮 ') + '游戏观察',
        );
      }

      const statusTab = h(
        React.Fragment,
        null,
        paused
          ? h(
              'div',
              { className: 'gpw-pause' },
              `⏸ 已暂停：${runtime?.pauseReason || '手动暂停'}（${fmtTime(runtime?.pausedAt)}）不再截屏、不再调模型`,
            )
          : null,
        h(
          'div',
          { className: 'gpw-meta' },
          h('span', null, `截取 ${runtime?.captures ?? 0}`),
          h('span', null, `开口 ${runtime?.speaks ?? 0}`),
          h('span', null, `压缩 ${runtime?.compactions ?? 0}`),
          h('span', null, `模型 ${runtime?.lastModelMs ? runtime.lastModelMs + 'ms' : '—'}`),
        ),
        h(
          'div',
          { className: 'gpw-meta' },
          h('span', null, `上一帧 ${fmtTime(runtime?.lastFrameAt)}`),
          h('span', null, runtime?.lastCaptureInfo || '—'),
          h('span', null, `鱼同步 ${fmtTime(runtime?.lastPetSyncAt)}`),
        ),
        h(
          'div',
          { className: 'gpw-say' },
          runtime?.lastPhrase ? `🐟 ${runtime.lastPhrase}` : '（还没说话。点「看一帧」，或直接在下面回话）',
        ),
        log.length
          ? h(
              'div',
              { className: 'gpw-log' },
              log.map((item, index) =>
                h(
                  'div',
                  { className: 'gpw-row', key: index },
                  h('span', { className: 'gpw-role' }, item.role + '：'),
                  h('span', { className: item.bad ? 'gpw-err' : 'gpw-text' }, item.text),
                ),
              ),
            )
          : null,
        runtime?.lastModelError ? h('div', { className: 'gpw-err' }, '⚠ 模型：' + runtime.lastModelError) : null,
        errors.length ? h('div', { className: 'gpw-err' }, '⚠ ' + errors[errors.length - 1].message) : null,
        error ? h('div', { className: 'gpw-err' }, '⚠ ' + error) : null,
        h(
          'div',
          { className: 'gpw-form' },
          h('textarea', {
            className: 'gpw-input',
            value: draft,
            placeholder: '跟鱼说一句（Enter 发送，Shift+Enter 换行）',
            onChange: (event) => setDraft(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void send();
              }
            },
          }),
          h(
            'button',
            { className: 'gpw-send', disabled: busy || !draft.trim(), onClick: () => void send() },
            busy ? '…' : '发送',
          ),
        ),
      );

      const memoryTab = h(
        React.Fragment,
        null,
        h(
          'div',
          { className: 'gpw-sec' },
          h(
            'div',
            { className: 'gpw-secHead' },
            h('span', { className: 'gpw-secTitle' }, '长期要点'),
            h('span', { className: 'gpw-note' }, `更新于 ${fmtTime(memory?.longTerm?.at)}`),
            h('button', { className: 'gpw-btn', disabled: busy, onClick: () => void memoryAction('compact') }, '重压'),
          ),
          h(
            'textarea',
            {
              className: 'gpw-area',
              value: memory?.longTerm?.text ?? '',
              placeholder: '（还没有长期要点：攒够来往会自动压一次，也可以点「重压」；这里也能手改）',
              onChange: (event) => setMemory((prev) => ({ ...(prev ?? {}), longTerm: { ...(prev?.longTerm ?? {}), text: event.target.value } })),
              onBlur: () => void memoryAction('set-long', { text: memory?.longTerm?.text ?? '' }),
            },
          ),
        ),
        h(
          'div',
          { className: 'gpw-sec' },
          h(
            'div',
            { className: 'gpw-secHead' },
            h('span', { className: 'gpw-secTitle' }, `主人备注（${memory?.notes?.length ?? 0}）`),
          ),
          memory?.notes?.length
            ? h(
                'div',
                { className: 'gpw-log' },
                memory.notes.map((note) =>
                  h(
                    'div',
                    { className: 'gpw-row', key: note.id },
                    h('span', { className: 'gpw-role' }, '·'),
                    h('span', { className: 'gpw-text' }, note.text),
                    h(
                      'button',
                      {
                        className: 'gpw-btn',
                        disabled: busy,
                        onClick: () => void memoryAction('remove-note', { id: note.id }),
                      },
                      '删',
                    ),
                  ),
                ),
              )
            : h('div', { className: 'gpw-note' }, '（提醒它记住的事，会一直带进提示词）'),
          h(
            'div',
            { className: 'gpw-form', style: { marginTop: 4 } },
            h('input', {
              className: 'gpw-input',
              style: { height: 26 },
              value: noteDraft,
              placeholder: '例如：别再吐槽我的操作',
              onChange: (event) => setNoteDraft(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter' && noteDraft.trim()) {
                  void memoryAction('note', { text: noteDraft.trim() });
                  setNoteDraft('');
                }
              },
            }),
            h(
              'button',
              {
                className: 'gpw-btn',
                disabled: busy || !noteDraft.trim(),
                onClick: () => {
                  void memoryAction('note', { text: noteDraft.trim() });
                  setNoteDraft('');
                },
              },
              '加',
            ),
          ),
        ),
        h(
          'div',
          { className: 'gpw-sec' },
          h(
            'div',
            { className: 'gpw-secHead' },
            h('span', { className: 'gpw-secTitle' }, `往来记录（${memory?.total ?? snapshot?.memory?.total ?? 0}）`),
            h(
              'button',
              { className: 'gpw-btn', disabled: busy, onClick: () => void memoryAction('clear', { kind: 'short' }) },
              '清短期',
            ),
            h(
              'button',
              { className: 'gpw-btn', disabled: busy, onClick: () => void memoryAction('clear', { kind: 'all' }) },
              '全清',
            ),
          ),
          h(
            'div',
            { className: 'gpw-log' },
            (memory?.entries ?? snapshot?.memory?.last ?? [])
              .slice()
              .reverse()
              .map((item, index) =>
                h(
                  'div',
                  { className: 'gpw-row', key: item.id ?? index },
                  h('span', { className: 'gpw-time' }, fmtTime(item.at)),
                  h('span', { className: 'gpw-role' }, item.role === 'pet' ? '鱼' : item.role === 'me' ? '我' : '·'),
                  h('span', { className: 'gpw-text' }, item.text),
                ),
              ),
          ),
        ),
        error ? h('div', { className: 'gpw-err' }, '⚠ ' + error) : null,
      );

      const field = (label, key, options) => {
        const value = prompt?.[key] ?? '';
        const onChange = (next) => {
          setPrompt((prev) => ({ ...(prev ?? {}), [key]: next }));
          setPromptDirty(true);
        };
        return h(
          'label',
          { className: 'gpw-field', key },
          h('span', { className: 'gpw-label' }, label),
          options?.multiline
            ? h('textarea', { className: 'gpw-area', value, onChange: (event) => onChange(event.target.value) })
            : options?.number
              ? h('input', {
                  className: 'gpw-input gpw-num',
                  type: 'number',
                  value,
                  onChange: (event) => onChange(Number(event.target.value)),
                })
              : h('input', { className: 'gpw-input', value, onChange: (event) => onChange(event.target.value) }),
        );
      };

      const promptTab = h(
        React.Fragment,
        null,
        h('div', { className: 'gpw-note' }, '改完点「写入配置」→ 落到 profile 的 patch 层，重开 DSH 生效；写前自动留备份。'),
        prompt
          ? h(
              React.Fragment,
              null,
              field('人设（system 第一段）', 'personality', { multiline: true }),
              field('开口规则', 'rules', { multiline: true }),
              field('长期记忆压缩提示词', 'compactSystem', { multiline: true }),
              h(
                'div',
                { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
                field('看窗口', 'windowTitle'),
                field('间隔秒', 'intervalSec', { number: true }),
                field('冷却秒', 'cooldownSec', { number: true }),
                field('单句字数', 'maxChars', { number: true }),
                field('记忆条数', 'memoryRecentTurns', { number: true }),
                field('压缩阈值', 'compactEvery', { number: true }),
              ),
              h(
                'label',
                { className: 'gpw-field' },
                h('span', { className: 'gpw-label' }, '投喂气泡'),
                h(
                  'select',
                  {
                    className: 'gpw-input',
                    value: String(prompt.pushToPet ?? true),
                    onChange: (event) => {
                      setPrompt((prev) => ({ ...(prev ?? {}), pushToPet: event.target.value === 'true' }));
                      setPromptDirty(true);
                    },
                  },
                  h('option', { value: 'true' }, '开（说给大肥鱼听）'),
                  h('option', { value: 'false' }, '关（只在面板里显示）'),
                ),
              ),
            )
          : h('div', { className: 'gpw-note' }, '正在读取配置…'),
        promptDirty ? h('div', { className: 'gpw-err' }, '有未写入的改动') : null,
        h(
          'div',
          { className: 'gpw-form' },
          h('button', { className: 'gpw-btn', disabled: busy || !promptDirty, onClick: () => void savePrompt() }, '写入配置'),
          h(
            'button',
            {
              className: 'gpw-btn',
              disabled: busy || !promptDirty,
              onClick: () => {
                setPromptDirty(false);
                setNotice('已放弃未写入的改动');
              },
            },
            '放弃改动',
          ),
        ),
        snapshot?.patch?.file ? h('div', { className: 'gpw-note' }, '写入位置：' + snapshot.patch.file) : null,
        error ? h('div', { className: 'gpw-err' }, '⚠ ' + error) : null,
      );

      return h(
        'div',
        { id: CARD_ID, className: 'gpw-card' + (paused ? ' is-paused' : ''), style, ref: cardRef },
        h(
          'div',
          { className: 'gpw-head', onPointerDown, onPointerMove, onPointerUp },
          h('span', { className: 'gpw-dot', style: { background: dotColor(running, paused, errors.length) } }),
          h(
            'span',
            { className: 'gpw-title' },
            (paused ? '游戏观察（已暂停）' : '游戏观察') + ' · ' + (snapshot?.prompt?.windowTitle || '主屏'),
          ),
          paused && !running ? h('span', { className: 'gpw-badge' }, 'PAUSED') : null,
          h(
            'button',
            {
              className: 'gpw-btn' + (running ? ' is-on' : ''),
              disabled: busy,
              onClick: () => void control(running ? 'pause' : 'start'),
            },
            running ? '暂停' : '开始',
          ),
          h('button', { className: 'gpw-btn', disabled: busy || !running, onClick: () => void control('now') }, '看一帧'),
          h(
            'button',
            {
              className: 'gpw-btn' + (anchored ? ' is-on' : ''),
              title: '贴在大肥鱼身上 / 固定位置（拖一下即固定）',
              onClick: () => {
                setAnchored((value) => !value);
                setManualPos(
                  (prev) =>
                    prev ?? {
                      x: Math.max(6, window.innerWidth - PANEL_W - 18),
                      y: Math.max(6, window.innerHeight - 420),
                    },
                );
              },
            },
            anchored ? '贴鱼' : '固定',
          ),
          h('button', { className: 'gpw-btn', onClick: () => setVisible(false), title: '收起' }, '—'),
        ),
        h(
          'div',
          { className: 'gpw-tabs' },
          h('button', { className: 'gpw-tab' + (tab === 'status' ? ' is-active' : ''), onClick: () => setTab('status') }, '状态'),
          h(
            'button',
            { className: 'gpw-tab' + (tab === 'memory' ? ' is-active' : ''), onClick: () => setTab('memory') },
            `记录 ${snapshot?.memory?.total ?? 0}`,
          ),
          h(
            'button',
            { className: 'gpw-tab' + (tab === 'prompt' ? ' is-active' : ''), onClick: () => setTab('prompt') },
            '提示词',
          ),
        ),
        h(
          'div',
          { className: 'gpw-body' },
          tab === 'status' ? statusTab : tab === 'memory' ? memoryTab : promptTab,
          notice ? h('div', { className: 'gpw-note' }, notice) : null,
          h(
            'div',
            { className: 'gpw-meta' },
            h('a', { href: API + '/shot', target: '_blank', rel: 'noreferrer', className: 'gpw-link' }, '看最新截图'),
            h('button', { className: 'gpw-btn', disabled: busy, onClick: () => void control('clear-errors') }, '清错误'),
            errors.length ? h('span', null, `${errors.length} 条错误`) : null,
          ),
        ),
      );
    }


    /**
     * 设置页的内联 CSS —— **照抄 dsh-pet 的 settings.ts** ✓（卡片 / 网格 / 字段 / 复选行 /
     * 输入框 / ? 提示气泡 ✓），类名前缀从 `dsh-pet-cfg` 换成 `gpw-cfg` ✓（不撞它的类名 ✓）。
     * 颜色全用宿主主题 token（--dsw-alias-*）✓ → 浅色/深色自动跟随 ✓。
     */
    const GPW_CFG_CSS = [
      '.gpw-cfg{display:flex;flex-direction:column;gap:12px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}',
      '.gpw-cfg .note{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
      '.gpw-cfg__title{display:flex;align-items:center;gap:6px;margin:0;font-size:16px;font-weight:500;line-height:24px}',
      '.gpw-cfg__card{display:flex;flex-direction:column;gap:10px;padding:12px 14px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px}',
      '.gpw-cfg__cardHead{display:flex;align-items:center;gap:6px;min-height:20px}',
      '.gpw-cfg__cardTitle{font-size:13px;font-weight:500;color:var(--dsw-alias-label-primary)}',
      '.gpw-cfg__grid2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px 16px;align-items:end}',
      '.gpw-cfg__grid3{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px 16px;align-items:end}',
      '.gpw-cfg__field{display:flex;flex-direction:column;gap:4px;min-width:0}',
      '.gpw-cfg__flabel{display:inline-flex;align-items:center;gap:5px;font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.gpw-cfg__inp{box-sizing:border-box;width:100%;min-height:28px;padding:4px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;outline:none}',
      '.gpw-cfg__inp:focus{border-color:var(--dsw-alias-state-business-primary)}',
      '.gpw-cfg__inp:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}',
      '.gpw-cfg__toggle{display:flex;align-items:center;gap:6px;min-width:0;font-size:13px;color:var(--dsw-alias-label-primary)}',
      '.gpw-cfg__toggle>label{display:inline-flex;align-items:center;gap:6px;cursor:pointer;min-width:0}',
      '.gpw-cfg__toggle>label>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.gpw-cfg__toggle input[type=checkbox]{flex:none;width:16px;height:16px;margin:0;accent-color:var(--dsw-alias-state-business-primary);cursor:pointer}',
      '.gpw-cfg__q{position:relative;display:inline-flex;align-items:center;justify-content:center;flex:none;width:14px;height:14px;border:1px solid var(--dsw-alias-label-tertiary);border-radius:50%;color:var(--dsw-alias-label-tertiary);font-size:10px;font-style:normal;line-height:1;cursor:help;user-select:none}',
      '.gpw-cfg__q::after{content:attr(data-tip);position:absolute;left:-4px;bottom:calc(100% + 8px);width:max-content;max-width:260px;padding:6px 10px;border-radius:8px;background:var(--dsw-alias-tooltip-bg);color:#fff;font-size:12px;font-style:normal;font-weight:400;line-height:18px;text-align:left;white-space:normal;opacity:0;visibility:hidden;pointer-events:none;transition:opacity .12s ease;box-shadow:0 6px 20px rgba(0,0,0,.22);z-index:2147483000}',
      '.gpw-cfg__q:hover::after{opacity:1;visibility:visible}',
      '.gpw-cfg textarea.gpw-cfg__inp{min-height:76px;resize:vertical;line-height:19px}',
      '.gpw-cfg input[type=range].gpw-cfg__inp{padding:0;border:none;background:transparent;accent-color:var(--dsw-alias-state-business-primary)}',
    ].join('');

    function StyleTag() {
      return h('style', { 'data-gpw': 'style' }, CSS + GPW_CFG_CSS);
    }

    /**
     * DSH 设置页里的「桌宠」页面（挂在 slot `settings.section` 上 ✓）。
     *
     * ⚠️ 规矩（2026-10-17 在这里崩过一次 ✗）：
     *   · hooks **只能在组件函数体内、且无条件调用** ✓ —— 上次我把 useCallback 写进了
     *     导入期执行的代码里 ✗，`React` 那时还是 null ✓ → 整个 DSH 起不来 ✗✗。
     *   · 所以这里只有一个普通函数组件 ✓，所有 hook 都在它顶层 ✓。
     *
     * 读写都走插件自己的 HTTP 接口 `/game-pet-watch/config` ✓（白名单键 ✓ 立即生效 ✓）。
     */
    /**
     * DSH 设置页里的「桌宠」页面（挂在 slot `settings.section` 上 ✓）。
     *
     * 排版与 CSS **照抄 dsh-pet 的 settings.ts** ✓（卡片 / 网格 / 字段 / 复选行 / ? 提示气泡 ✓），
     * 只把类名前缀从 `dsh-pet-cfg` 换成 `gpw-cfg` ✓（免得和它撞 ✓）。
     *
     * ⚠️ 规矩（2026-10-17 在这里崩过一次 ✗）：
     *   · hooks **只能在组件函数体内、无条件调用** ✓ —— 上次把 useCallback 写进了导入期
     *     执行的代码里 ✗，`React` 那时还是 null ✓ → 整个 DSH 起不来 ✗✗。
     *   · 所以这里只有一个普通函数组件 ✓，所有 hook 都在它顶层 ✓。
     *
     * 读写都走插件自己的 HTTP 接口 `/game-pet-watch/config` ✓（白名单键 ✓ 立即生效 ✓）。
     */
    function PetSettings() {
      const [cfg, setCfg] = useState(null);
      const loadedRef = useRef(null);
      const [note, setNote] = useState('');
      const [busy, setBusy] = useState(false);
      const [pets, setPets] = useState(null);

      /** 鱼表（含每条鱼的记忆条数）—— 设置页里给每条鱼一个**独立开关** */
      const loadPets = useCallback(async () => {
        try {
          const res = await fetch(API + '/pets', { cache: 'no-store' });
          setPets(await res.json());
        } catch {
          setPets(null);
        }
      }, []);

      const petAction = useCallback(
        async (body) => {
          setBusy(true);
          try {
            const res = await fetch(API + '/pets', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body),
            });
            const d = await res.json().catch(() => ({}));
            setNote(d?.ok ? '已保存（立即生效）' : '保存失败：' + (d?.error ?? res.status));
          } catch (error) {
            setNote('保存失败：' + (error?.message ?? error));
          } finally {
            setBusy(false);
            void loadPets();
          }
        },
        [loadPets],
      );

      useEffect(() => {
        void loadPets();
      }, [loadPets]);

      useEffect(() => {
        let alive = true;
        fetch(API + '/config', { cache: 'no-store' })
          .then((r) => r.json())
          .then((d) => {
            if (!alive) return;
            const values = d?.values ?? {};
            loadedRef.current = values;
            setCfg(values);
            // 自查：'custom' 但 provider 为空 = 会静默回落到会话默认（坏 key ✗）→ 就地提示 ✓
            if (values.modelSource === 'custom' && !String(values.modelProvider ?? '').trim()) {
              setNote('注意：模型路由选了「自定义」但 provider 是空的 → 会回落到会话默认模型。请填 provider（如 deepseek-account）。');
            }
          })
          .catch((error) => {
            if (alive) setNote('读取失败：' + (error?.message ?? error));
          });
        return () => {
          alive = false;
        };
      }, []);

      const loaded = loadedRef.current;

      const save = useCallback(async (values) => {
        setBusy(true);
        try {
          const res = await fetch(API + '/config', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ values }),
          });
          const d = await res.json().catch(() => ({}));
          setNote(d?.ok ? '已保存（立即生效）' : '保存失败：' + (d?.error ?? res.status));
        } catch (error) {
          setNote('保存失败：' + (error?.message ?? error));
        } finally {
          setBusy(false);
        }
      }, []);

      const set = useCallback(
        (key, value) => {
          setCfg((prev) => ({ ...(prev ?? {}), [key]: value }));
          void save({ [key]: value });
        },
        [save],
      );

      if (!cfg) {
        return h('div', { className: 'gpw-cfg' }, h(StyleTag, null), h('div', { className: 'note' }, note || '读取中…'));
      }

      /** 卡片（与 dsh-pet 同款 ✓） */
      const card = (title, children) =>
        h(
          'section',
          { className: 'gpw-cfg__card' },
          h('header', { className: 'gpw-cfg__cardHead' }, h('span', { className: 'gpw-cfg__cardTitle' }, title)),
          children,
        );

      /** 一个复选开关（左对齐 ✓ 16px ✓ accent 用主题色 ✓） */
      const toggle = (key, label, tip) =>
        h(
          'div',
          { className: 'gpw-cfg__toggle', key },
          h(
            'label',
            null,
            h('input', {
              type: 'checkbox',
              checked: cfg[key] !== false,
              disabled: busy,
              onChange: (event) => set(key, event.target.checked),
            }),
            h('span', null, label),
            tip ? h('i', { className: 'gpw-cfg__q', 'data-tip': tip }, '?') : null,
          ),
        );

      /** 文本字段 */
      const field = (key, label, tip, placeholder) =>
        h(
          'label',
          { className: 'gpw-cfg__field', key },
          h('span', { className: 'gpw-cfg__flabel' }, label, tip ? h('i', { className: 'gpw-cfg__q', 'data-tip': tip }, '?') : null),
          h('input', {
            className: 'gpw-cfg__inp',
            value: cfg[key] ?? '',
            disabled: busy,
            placeholder: placeholder ?? '',
            onChange: (event) => setCfg((prev) => ({ ...(prev ?? {}), [key]: event.target.value })),
            // 只在**值真的变了**时保存：否则点进去再点出来会把原值写成空串 ✗（这是真出过的 bug ✓）
            onBlur: (event) => {
              if (String(event.target.value) !== String(loaded?.[key] ?? '')) void save({ [key]: event.target.value });
            },
          }),
        );

      /** 下拉（dsh-pet 同款：套 __inp 样式 ✓） */
      const select = (key, label, options) =>
        h(
          'label',
          { className: 'gpw-cfg__field', key },
          h('span', { className: 'gpw-cfg__flabel' }, label),
          h(
            'select',
            {
              className: 'gpw-cfg__inp',
              value: cfg[key] ?? options[0][0],
              disabled: busy,
              onChange: (event) => set(key, event.target.value),
            },
            options.map(([v, text]) => h('option', { key: v, value: v }, text)),
          ),
        );

      /** 滑块（值显示在 label 里 ✓） */
      const range = (key, label, min, max, step) =>
        h(
          'label',
          { className: 'gpw-cfg__field', key },
          h('span', { className: 'gpw-cfg__flabel' }, label + '：' + (cfg[key] ?? min)),
          h('input', {
            className: 'gpw-cfg__inp',
            type: 'range',
            min,
            max,
            step,
            value: Number(cfg[key] ?? min),
            disabled: busy,
            onChange: (event) => setCfg((prev) => ({ ...(prev ?? {}), [key]: Number(event.target.value) })),
            onMouseUp: (event) => void save({ [key]: Number(event.target.value) }),
            onKeyUp: (event) => void save({ [key]: Number(event.target.value) }),
          }),
        );

      /** 多行文本（人设用 ✓） */
      const area = (key, label) =>
        h(
          'label',
          { className: 'gpw-cfg__field', key },
          h('span', { className: 'gpw-cfg__flabel' }, label),
          h('textarea', {
            className: 'gpw-cfg__inp',
            rows: 4,
            value: cfg[key] ?? '',
            disabled: busy,
            onChange: (event) => setCfg((prev) => ({ ...(prev ?? {}), [key]: event.target.value })),
            onBlur: (event) => {
              if (String(event.target.value) !== String(loaded?.[key] ?? '')) void save({ [key]: event.target.value });
            },
          }),
        );

      return h(
        'div',
        { className: 'gpw-cfg' },
        h(StyleTag, null),
        h('h3', { className: 'gpw-cfg__title' }, '桌宠（dsh-game-pet-watch）'),
        h(
          'div',
          { className: 'note' },
          '这里的改动**立即生效**（走插件自己的接口，不用重启）。',
          note ? h('div', { style: { marginTop: 4 } }, note) : null,
        ),

        card(
          '总开关',
          h(
            'div',
            { className: 'gpw-cfg__grid3' },
            toggle('enabled', '启用桌宠', '关掉后它不再看画面、不回话'),
            toggle('pushToPet', '推给桌面气泡', '关掉它照样裁决，只是台词不出现在气泡里'),
            toggle('autoLaunchFork', '保活拉起', 'DSH 开着时自动把桌宠进程拉起来'),
          ),
        ),

        card(
          '每条鱼独立开关',
          pets
            ? h(
                React.Fragment,
                null,
                h(
                  'div',
                  { className: 'gpw-cfg__toggle' },
                  h(
                    'label',
                    null,
                    h('input', {
                      type: 'checkbox',
                      checked: pets.master !== false,
                      disabled: busy,
                      onChange: (event) => void petAction({ action: 'master', enabled: event.target.checked }),
                    }),
                    h('span', null, '多鱼总闸（全停 / 全开）'),
                    h('i', { className: 'gpw-cfg__q', 'data-tip': '关掉 = 所有鱼都不驱动、不保活；单条鱼开关在下面' }, '?'),
                  ),
                ),
                h(
                  'div',
                  { className: 'gpw-cfg__grid2' },
                  (pets.pets ?? []).map((f) =>
                    h(
                      'div',
                      { className: 'gpw-cfg__field', key: f.id },
                      h(
                        'div',
                        { className: 'gpw-cfg__toggle' },
                        h(
                          'label',
                          null,
                          h('input', {
                            type: 'checkbox',
                            checked: f.enabled !== false,
                            disabled: busy,
                            onChange: (event) =>
                              void petAction({ action: 'toggle', id: f.id, enabled: event.target.checked }),
                          }),
                          h('span', null, f.name || f.id),
                          f.qq ? h('i', { className: 'gpw-cfg__q', 'data-tip': '这条鱼接 QQ（群消息/图片走它）' }, 'Q') : null,
                        ),
                      ),
                      h(
                        'span',
                        { className: 'gpw-cfg__flabel' },
                        (f.origin || '（自动探测）') +
                          ' · 记忆 ' +
                          (f.memory?.entries ?? '?') +
                          ' 条 · 长期 ' +
                          (f.memory?.longTerm ?? '?') +
                          ' 字',
                      ),
                      /**
                       * **时间波动**（按鱼）：观察间隔 = 全局间隔 × 退避 ± jitterSec。
                       * 两条鱼共用一次 tick，波动让它们不要同一秒一起问模型（也各有自己的节奏感）。
                       */
                      h(
                        'div',
                        { className: 'gpw-cfg__field', style: { marginTop: 4 } },
                        h('span', { className: 'gpw-cfg__flabel' }, '时间波动 ±秒（0 = 固定节奏）'),
                        h('input', {
                          className: 'gpw-cfg__inp',
                          type: 'number',
                          min: 0,
                          max: 300,
                          step: 1,
                          defaultValue: f.jitterSec ?? 5,
                          disabled: busy,
                          placeholder: '5',
                          onBlur: (event) => {
                            const v = Math.max(0, Math.min(300, Math.round(Number(event.target.value) || 0)));
                            if (v !== Number(f.jitterSec ?? 5)) void petAction({ action: 'set-jitter', id: f.id, jitterSec: v });
                          },
                        }),
                      ),
                      /**
                       * **这条鱼自己的压缩说明**（留空 = 用全局那份）。
                       * 只换人设不换"怎么总结"，两条鱼的长期记忆就会是一个模子。
                       */
                      h(
                        'div',
                        { className: 'gpw-cfg__field', style: { marginTop: 4 } },
                        h('span', { className: 'gpw-cfg__flabel' }, '长期记忆压缩说明（留空 = 用全局）'),
                        h('textarea', {
                          className: 'gpw-cfg__inp',
                          rows: 2,
                          defaultValue: f.compactSystem || '',
                          disabled: busy,
                          placeholder: '只对这一条鱼生效；留空则沿用「人设」卡片里那份全局压缩提示词',
                          onBlur: (event) => {
                            const v = String(event.target.value || '');
                            if (v.trim() !== String(f.compactSystem || '').trim()) void petAction({ action: 'set-compact', id: f.id, text: v });
                          },
                        }),
                        h(
                          'span',
                          { className: 'gpw-cfg__flabel' },
                          f.compactSystem ? '（本鱼自有，不会和别的鱼共用）' : '（当前沿用全局）',
                        ),
                      ),
                      /**
                       * **QQ 号绑定**（按鱼 ✓）：NapCat 一个号一个 OneBot 端点 ✓。
                       * 留空 = 用全局 onebotUrl/Token ✓（单号用法不受影响 ✓）。
                       * token 只显示掩码 ✓（接口从不回显完整值 ✓）。
                       */
                      h(
                        'div',
                        { className: 'gpw-cfg__field', style: { marginTop: 4 } },
                        h('span', { className: 'gpw-cfg__flabel' }, 'QQ 号绑定（留空 = 用全局）'),
                        h(
                          'div',
                          { style: { display: 'flex', gap: 6, alignItems: 'center' } },
                          h('input', {
                            className: 'gpw-cfg__inp',
                            placeholder: 'QQ 号（如 168369554）',
                            defaultValue: f.qqAccount || '',
                            disabled: busy,
                            onBlur: (event) => {
                              const v = String(event.target.value || '').trim();
                              if (v !== String(f.qqAccount || '')) void petAction({ action: 'bind-qq', id: f.id, qqAccount: v });
                            },
                          }),
                          h('input', {
                            className: 'gpw-cfg__inp',
                            placeholder: 'OneBot 端点（ws://127.0.0.1:3001）',
                            defaultValue: f.onebotUrl || '',
                            disabled: busy,
                            onBlur: (event) => {
                              const v = String(event.target.value || '').trim();
                              if (v !== String(f.onebotUrl || '')) void petAction({ action: 'bind-qq', id: f.id, onebotUrl: v });
                            },
                          }),
                        ),
                        h(
                          'span',
                          { className: 'gpw-cfg__flabel' },
                          f.qqBinding
                            ? `当前：号=${f.qqBinding.account || '(全局)'} · 端点=${f.qqBinding.url || '(未配置)'} · token=${
                                f.qqBinding.tokenMasked || '(空)'
                              } · ${f.qqBinding.bound ? '本鱼自有' : '沿用全局'}`
                            : '',
                        ),
                      ),
                    ),
                  ),
                ),
                h('div', { className: 'note' }, '每条鱼独立：关掉某条只影响它自己；改动立即生效（不用重启）。'),
              )
            : h('div', { className: 'note' }, '读取鱼表…'),
        ),

        card(
          '模型',
          h(
            React.Fragment,
            null,
            h(
              'div',
              { className: 'gpw-cfg__grid2' },
              select('modelSource', '模型路由', [
                ['session', '跟随 DSH 会话默认模型'],
                ['custom', '用下面指定的 provider/model'],
              ]),
              field('apiKey', 'API Key', '留空则用 DSH 里已有的凭证/登录账户'),
            ),
            h(
              'div',
              { className: 'gpw-cfg__grid2' },
              field('modelProvider', 'provider', '例如 deepseek-account', 'deepseek-account'),
              field('model', 'model', '例如 deepseek-flash', 'deepseek-flash'),
            ),
            h(
              'div',
              { className: 'note' },
              '菜单里若报「api 非法」，把模型路由选成「用下面指定的 provider/model」并填 deepseek-account / deepseek-flash。',
            ),
          ),
        ),

        card(
          '多鱼与 QQ',
          h(
            React.Fragment,
            null,
            toggle('petsEnabled', '多鱼总开关', '关掉 = 所有鱼都不驱动、不保活'),
            h(
              'div',
              { className: 'gpw-cfg__grid2' },
              toggle('onebotRead', '允许读 QQ', '图识别 / 群上下文 / 定时群读 —— 这一半要花钱'),
              toggle('onebotReply', '允许发 QQ', '关掉它只在自己气泡里说话'),
              toggle('qqCollectImages', '群图都读都收', '不叫它也收；每张图一次视觉调用'),
              toggle('qqKeepInteresting', '收进表情包库', '它觉得有意思的图留下来以后用'),
            ),
          ),
        ),

        card(
          '图像与图库',
          h(
            React.Fragment,
            null,
            toggle('imageInPrompt', '表情包清单进提示词', '关掉它就不能配图了'),
            h(
              'div',
              { className: 'gpw-cfg__grid3' },
              range('imageMaxDim', '送模型最长边', 320, 3840, 64),
              range('imageQuality', 'JPEG 质量', 50, 100, 5),
              range('memeLibraryMax', '图库上限（张）', 50, 20000, 50),
            ),
          ),
        ),

        card(
          '节奏',
          h(
            React.Fragment,
            null,
            h(
              'div',
              { className: 'gpw-cfg__grid3' },
              range('intervalSec', '看画面间隔（秒）', 5, 3600, 5),
              range('cooldownSec', '开口冷却（秒）', 0, 3600, 5),
              range('maxChars', '单句字数上限', 10, 400, 10),
            /**
             * **游戏事件反应限流**（2026-10-19）：冷却 + 十分钟预算。
             * 只影响"因为事件主动说话"，旁观节奏仍是上面的 intervalSec。
             */
            range('gohImmediateCooldownSec', '重要事件冷却（秒）', 0, 300, 5),
            range('gohReactionBudget', '每十分钟最多反应次数', 0, 60, 1),
            ),
            /**
             * **记忆**：短期窗口就是"每次对话带多少条最近的往来"。
             * 太小会显得没记性，太大则每轮都把上下文撑长（费 token），所以给个滑块自己调。
             * 0 = 不带短期记忆（只靠长期要点）。
             */
            h(
              'div',
              { className: 'gpw-cfg__grid3' },
              range('memoryRecentTurns', '短期记忆上限（条）', 0, 60, 1),
              range('compactEvery', '压缩阈值（条）', 0, 200, 5),
              range('memoryLongTermChars', '长期记忆上限（字）', 200, 8000, 200),
            ),
            h('div', { className: 'note' }, '短期记忆 = 每次对话带多少条最近的往来；压缩阈值 = 攒够多少条就压进长期记忆；0 表示关掉对应的那一项。'),
            h(
              'div',
              { className: 'gpw-cfg__grid3' },
              toggle('historyHideSystem', '记录页隐藏系统条目（游戏事件原文）', '只影响记录页显示；记忆、上下文、压缩都不受影响'),
              toggle('memoryAllowSelfNote', '允许它自己往长期记忆里记一条', '它觉得重要的事（约定、长期习惯、卡住的关卡）可以用 remember 字段留条子，不会被挤出上下文'),
            ),
            /**
             * **插件自己的端口**（= 宿主 DSH 的 web 端口；0 = 自动探测）。
             * 副本拿它回连插件发 `/rects`，写错了碰撞/输入框回话会静默失效，
             * 所以保存时会当场探一下，结果写在插件日志里。
             */
            field(
              'pluginPort',
              '插件端口（0 = 自动探测）',
              '填宿主 DSH 的 web 端口；改完要重启 DSH 才作用于已拉起的副本',
              '0',
            ),
          ),
        ),

        /**
         * **内容路径**：插件不绑定任何一款游戏，事件文件/采集器/机制库都由用户自己填。
         * 空 = 不启用对应功能（默认就是空）。
         */
        card(
          '事件源与机制库（自己填）',
          h(
            React.Fragment,
            null,
            h(
              'div',
              { className: 'note' },
              '插件不预置任何游戏的内容：事件文件可以是任何"一行一条 JSON"的日志；机制库是任意 markdown。留空 = 不用。',
            ),
            field('gohFile', '事件文件路径', '例如 events.jsonl；留空 = 不读事件', ''),
            field('gohCollectorScript', '事件采集脚本（可选）', '可留空；填了才会启动它', ''),
            field('mechanicsQuickFile', '机制速查版（常驻提示词）', '留空 = 不带', ''),
            field('mechanicsFile', '机制完整库（按需检索）', '留空 = 不带', ''),
          ),
        ),

        card(
          '人设',
          h(
            React.Fragment,
            null,
            h('div', { className: 'note' }, '留空则用默认；改这里会同步写进 patch 与提示词守卫。'),
            area('personality', '人设（system 第一段）'),
            area('rules', '开口规则'),
          ),
        ),
      );
    }

    function Root() {
      return h(React.Fragment, null, h(StyleTag, null), h(Panel, null));
    }

    return {
      name: 'game-pet-watch',
      inject: ['slots'],
      apply(ctx) {
        // 面板已搬到独立副本 dsh-pet-gpw 的桌面窗口（右键宠物打开）。
        // 这里只做一件事：把「桌宠」页面挂进 DSH 的设置对话框（slot settings.section ✓）。
        // 写法与 dsh-pet 的 lib/client.js **完全一致** ✓（生成器 effect + yield 注册 ✓），
        // 座位也同一个（它 id=pet-config order=30；我 id=game-pet-watch order=50 ✓）。
        try {
          ctx.slots.inject('settings.section', function* registerPetSettings() {
            yield ctx.slots.register(
              { name: 'settings.section', id: 'game-pet-watch', order: 50, label: () => '桌宠' },
              PetSettings,
            );
          });
        } catch (error) {
          // 注册失败不影响插件本体 ✓（也绝不让它把宿主带崩 ✗）
          console.error('[dsh-game-pet-watch] 设置页注册失败：' + (error?.message ?? error));
        }
        void Root;
      },
    };
  },
});
