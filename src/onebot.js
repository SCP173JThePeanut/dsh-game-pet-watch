/**
 * OneBot v11 客户端（面向 NapCat / Lagrange 这类"真人号"实现）。
 *
 * 为什么不用 dsh-bridge 的 QQ：那条路走的是**官方机器人开放平台**，机器人身份可见、
 * 只能收 @ / 私聊、群能力要群主开权限 —— 与用户要的"像人类账户一样在群里实时收发、
 * 能读图"不符。OneBot 跑的是**真实 QQ 客户端**（NapCat 注入 QQNT），
 * 所以：身份就是普通群成员 ✓ 群里全部消息实时到 ✓ 图片视频都能拿到 ✓
 *
 * 设计要点：
 *   - **零依赖**：客户端用 Node 24 自带的全局 `WebSocket`（转发 WS），
 *     不需要 `ws` 包（测试里的假服务器才用它，从宿主 node_modules 借）。
 *   - **认证走 URL 参数**：`?access_token=…`。WHATWG WebSocket 不支持自定义请求头，
 *     而 OneBot v11 的标准做法本来就有 `access_token` 查询参数。
 *   - **连接与调用分离**：事件是服务端主动推的 JSON（无 `echo`），
 *     API 响应带 `echo` 回执。所以调用用一个 `echo` → Promise 的表来配对。
 *   - **自动重连 + 退避**：NapCat 会重启、QQ 会掉线，客户端必须自己回来。
 */
const DEFAULT_TIMEOUT_MS = 10000;
const RECONNECT_MIN_MS = 3000;
const RECONNECT_MAX_MS = 60000;

/** 把 OneBot 的 message 段数组摊平成"文本 + 图片列表" */
export function parseSegments(message) {
  const parts = [];
  const images = [];
  const list = Array.isArray(message) ? message : [];
  for (const seg of list) {
    const type = String(seg?.type ?? '');
    const data = seg?.data ?? {};
    if (type === 'text') parts.push(String(data.text ?? ''));
    else if (type === 'at') parts.push(data.qq === 'all' ? '@全体' : `@${data.name || data.qq || ''}`);
    else if (type === 'image') {
      images.push({
        url: typeof data.url === 'string' ? data.url : '',
        file: typeof data.file === 'string' ? data.file : '',
        ...(data.summary ? { summary: String(data.summary) } : {}),
      });
      parts.push('［图片］');
    } else if (type === 'face') parts.push('［表情］');
    else if (type === 'reply') parts.push('');
    else if (type === 'record') parts.push('［语音］');
    else if (type === 'video') parts.push('［视频］');
    else if (type === 'file') parts.push(`［文件：${data.name || data.file || ''}］`);
    else if (type === 'json' || type === 'xml') parts.push('［卡片］');
    // 其它类型不塞占位，避免把提示词搞得全是方括号
  }
  return { text: parts.join('').trim(), images };
}

/**
 * 归一化一条 OneBot 事件。只关心消息类；其它类型返回 null。
 * @returns {{kind:'message', scope:'group'|'private', groupId:string, userId:string,
 *            senderName:string, text:string, images:Array, at:number, messageId:string, raw:object}|null}
 */
export function normalizeEvent(raw) {
  if (!raw || raw.post_type !== 'message') return null;
  const scope = raw.message_type === 'group' ? 'group' : 'private';
  const { text, images } = parseSegments(raw.message);
  const at = Number.isFinite(raw.time) ? Number(raw.time) * 1000 : Date.now();
  const sender = raw.sender ?? {};
  return {
    kind: 'message',
    scope,
    groupId: scope === 'group' ? String(raw.group_id ?? '') : '',
    userId: String(raw.user_id ?? ''),
    senderName: String(sender.card || sender.nickname || raw.user_id || '').trim(),
    text,
    images,
    at,
    messageId: String(raw.message_id ?? ''),
    raw,
  };
}

/**
 * 建客户端。
 * @param {{url:string, token?:string, log?:(m:string)=>void, onEvent?:(e:object)=>void,
 *          WebSocketImpl?:any, timeoutMs?:number, reconnectMinMs?:number}} options
 */
/**
 * 组装 OneBot 消息段。空文案 + 无图 → 返回空数组（调用方据此跳过发送，别发空消息）。
 * @param {string} text
 * @param {{imageBase64?: string}} [options]
 */
export function buildMessage(text, options = {}) {
  const segments = [];
  const clean = String(text ?? '').trim();
  if (clean) segments.push({ type: 'text', data: { text: clean } });
  if (options?.imageBase64) segments.push({ type: 'image', data: { file: 'base64://' + options.imageBase64 } });
  return segments;
}

export function createOneBotClient(options) {
  const log = options.log ?? (() => {});
  const token = String(options.token ?? '');
  const WS = options.WebSocketImpl ?? globalThis.WebSocket;
  const timeoutMs = Math.max(1000, Number(options.timeoutMs ?? DEFAULT_TIMEOUT_MS));
  const onEvent = options.onEvent ?? (() => {});
  const baseUrl = (() => {
    const raw = String(options.url ?? '').trim();
    if (!raw) return '';
    // 允许只填 `127.0.0.1:3001` 这种写法
    const withScheme = /^wss?:\/\//.test(raw) ? raw : `ws://${raw}`;
    if (!token) return withScheme;
    return withScheme + (withScheme.includes('?') ? '&' : '?') + 'access_token=' + encodeURIComponent(token);
  })();

  let socket = null;
  let connected = false;
  // 重连退避：初值取配置（测试要能把它调小）；**别写成只用常量**——
  // 第一版就是声明了 reconnectMinMs 选项却没读，测试里"掉线重连"直接超时才发现。
  const reconnectMinMs = Math.max(100, Number(options.reconnectMinMs ?? RECONNECT_MIN_MS));
  const reconnectMaxMs = Math.max(reconnectMinMs, Number(options.reconnectMaxMs ?? RECONNECT_MAX_MS));
  let reconnectDelay = reconnectMinMs;
  let reconnectTimer = null;
  let closedByUs = false;
  let echoSeq = 0;
  const pending = new Map(); // echo → {resolve, reject, timer}
  let stats = { connects: 0, events: 0, calls: 0, errors: 0, lastError: '', lastEventAt: 0, selfId: '' };

  function resolvePending(echo, payload) {
    const slot = pending.get(echo);
    if (!slot) return;
    pending.delete(echo);
    clearTimeout(slot.timer);
    if (payload && payload.status === 'failed') {
      slot.reject(new Error(`${payload.retcode ?? 'failed'} ${payload.message ?? payload.wording ?? ''}`.trim()));
    } else {
      slot.resolve(payload);
    }
  }

  function handleMessage(text) {
    let payload = null;
    try {
      payload = JSON.parse(text);
    } catch {
      return;
    }
    // API 响应带 echo；事件不带
    if (payload && payload.echo !== undefined && pending.has(payload.echo)) {
      resolvePending(payload.echo, payload);
      return;
    }
    // 心跳/生命周期（OneBot 的 meta_event）
    if (payload?.post_type === 'meta_event') {
      if (payload.meta_event_type === 'lifecycle' && payload.self_id) stats.selfId = String(payload.self_id);
      return;
    }
    stats.events += 1;
    stats.lastEventAt = Date.now();
    const event = normalizeEvent(payload);
    if (event) {
      if (!event.senderName && payload?.self_id) event.selfId = String(payload.self_id);
      try {
        onEvent(event);
      } catch (error) {
        log('OneBot 事件处理出错：' + (error?.message ?? error));
      }
    }
  }

  function scheduleReconnect() {
    if (closedByUs || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, reconnectDelay);
    reconnectTimer.unref?.();
    log(`OneBot ${Math.round(reconnectDelay / 1000)}s 后重连`);
    reconnectDelay = Math.min(reconnectDelay * 2, reconnectMaxMs);
  }

  function connect() {
    if (!baseUrl) return false;
    if (!WS) {
      log('OneBot：当前运行时没有 WebSocket 实现（需要 Node 22+ 或注入 WebSocketImpl）');
      return false;
    }
    try {
      socket = new WS(baseUrl);
    } catch (error) {
      stats.errors += 1;
      stats.lastError = String(error?.message ?? error);
      log('OneBot 连接失败：' + stats.lastError);
      scheduleReconnect();
      return false;
    }
    socket.addEventListener?.('open', () => {
      connected = true;
      reconnectDelay = reconnectMinMs;
      stats.connects += 1;
      stats.lastError = '';
      log('OneBot 已连接：' + String(options.url ?? ''));
    });
    socket.addEventListener?.('message', (event) => handleMessage(typeof event?.data === 'string' ? event.data : String(event?.data ?? '')));
    socket.addEventListener?.('close', () => {
      const wasConnected = connected;
      connected = false;
      socket = null;
      if (wasConnected) log('OneBot 连接断开');
      scheduleReconnect();
    });
    socket.addEventListener?.('error', (event) => {
      stats.errors += 1;
      stats.lastError = String(event?.message ?? 'socket error');
      // 具体错误通常紧跟一次 close，这里不重复记日志刷屏
    });
    return true;
  }

  /** 调一个 OneBot API（默认走同一条 WS） */
  function call(action, params = {}) {
    if (!socket || !connected) return Promise.reject(new Error('OneBot 未连接'));
    stats.calls += 1;
    echoSeq += 1;
    const echo = `dsh-${echoSeq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(echo);
        reject(new Error(`OneBot 调用超时：${action}`));
      }, timeoutMs);
      pending.set(echo, { resolve, reject, timer });
      try {
        socket.send(JSON.stringify({ action, params, echo }));
      } catch (error) {
        clearTimeout(timer);
        pending.delete(echo);
        reject(error);
      }
    });
  }

  return {
    connect,
    close() {
      closedByUs = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      try {
        socket?.close();
      } catch {
        /* 忽略 */
      }
      socket = null;
      connected = false;
    },
    call,
    /**
     * 群里发消息（OneBot v11；NapCat 支持同一接口）。
     *
     * `options.imageBase64` 有值时**文案 + 图片一起发**（桌宠回话时把它选的那张表情包也带上）。
     * 用 base64 而不是 `file://` 路径：路径在 NapCat 侧要满足 `enableLocalFile2Url` 等开关，
     * base64 没有这些问题（代价是消息大一点，所以调用方会先压一遍并限长）。
     */
    sendGroupMsg(groupId, text, options = {}) {
      return call('send_group_msg', { group_id: Number(groupId), message: buildMessage(text, options) });
    },
    sendPrivateMsg(userId, text, options = {}) {
      return call('send_private_msg', { user_id: Number(userId), message: buildMessage(text, options) });
    },
    /** 取历史消息（进群先补一段上下文用；count 上限各实现不同，NapCat 一般 ≤ 100） */
    getGroupMsgHistory(groupId, count = 20) {
      return call('get_group_msg_history', { group_id: Number(groupId), count });
    },
    getGroupList() {
      return call('get_group_list', {});
    },
    status() {
      return {
        url: String(options.url ?? ''),
        connected,
        selfId: stats.selfId,
        connects: stats.connects,
        events: stats.events,
        calls: stats.calls,
        errors: stats.errors,
        lastError: stats.lastError,
        lastEventAt: stats.lastEventAt || null,
        pending: pending.size,
      };
    },
  };
}
