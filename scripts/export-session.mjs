/**
 * DSH 会话导出器：把某个会话的 JSONL（zstd 多帧）导成干净的 markdown 记录。
 *
 * 用法：
 *   node scripts/export-session.mjs list                     # 列出所有会话，看哪份是哪个
 *   node scripts/export-session.mjs dump <文件>              # 打印事件结构（排障用）
 *   node scripts/export-session.mjs export <文件> <输出.md> [--max-result 400]
 *
 * 为什么需要它：会话存成 `session.v4.jsonl.zstd`，而且**每追加一次写一帧**，
 * Node 的 zstd API（同步与流式）都只解第一帧 —— 所以这里按魔数切帧后逐帧解压。
 *
 * 导出策略（给"换个 Agent 继续干"用）：
 *   - 用户消息、助手文本：原样保留（这是上下文的主体）
 *   - 工具调用：一行摘要（工具名 + 关键参数截断）
 *   - 工具结果：截断到 --max-result 字符（结果动辄几十 KB，全带上只会淹没重点）
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** 按 zstd 魔数切帧并逐帧解压 */
export function readZstdFrames(file) {
  const buf = readFileSync(file);
  const starts = [];
  let at = buf.indexOf(MAGIC);
  while (at !== -1) {
    starts.push(at);
    at = buf.indexOf(MAGIC, at + 4);
  }
  const parts = [];
  let failed = 0;
  for (let i = 0; i < starts.length; i += 1) {
    let done = false;
    // 正常情况：一帧到下一帧；魔数出现在压缩数据内部时会切歪，于是往后并到能解开为止
    for (let j = i + 1; j <= starts.length && !done; j += 1) {
      const end = j < starts.length ? starts[j] : buf.length;
      try {
        parts.push(zstdDecompressSync(buf.subarray(starts[i], end)).toString('utf8'));
        i = j - 1;
        done = true;
      } catch {
        /* 继续往后并 */
      }
    }
    if (!done) failed += 1;
  }
  return { text: parts.join(''), frames: starts.length, failed };
}

function sessionLines(file) {
  return readZstdFrames(file)
    .text.split('\n')
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

/** 从事件里抽出 (角色, 文本, 工具调用) —— 结构随 DSH 版本变，这里做保守兼容 */
function describe(event) {
  const data = event?.data ?? event;
  const type = String(event?.type ?? '');
  const out = [];

  // 用户消息：可能是 user/message 或消息对象里 role=user
  const asMessage = data?.message ?? data;
  const role = asMessage?.role;
  const content = asMessage?.content;
  if (Array.isArray(content)) {
    const texts = content.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text);
    const calls = content.filter((b) => b?.type === 'tool-call');
    const images = content.filter((b) => b?.type === 'image').length;
    if (texts.length || calls.length) {
      out.push({ role: role ?? type, text: texts.join('\n'), calls, images });
    }
  } else if (typeof asMessage?.text === 'string') {
    out.push({ role: role ?? type, text: asMessage.text, calls: [], images: 0 });
  }
  return out;
}

function oneLine(value, max = 160) {
  const s = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max) + '…' : flat;
}

function truncate(text, max) {
  const s = String(text ?? '').trim();
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n…[截断，原长 ${s.length} 字符]`;
}

function cmdList() {
  const root = 'C:/Users/Kishin/.dsh/sessions';
  for (const ws of readdirSync(root)) {
    const dir = join(root, ws);
    let names = [];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const file = join(dir, name, 'session.v4.jsonl.zstd');
      let info;
      try {
        info = statSync(file);
      } catch {
        continue;
      }
      const events = sessionLines(file);
      let first = '';
      let last = '';
      let userCount = 0;
      for (const e of events) {
        for (const m of describe(e)) {
          if (m.role !== 'user') continue;
          userCount += 1;
          if (m.text) {
            if (!first) first = m.text;
            last = m.text;
          }
        }
      }
      console.log(
        `${ws} / ${name.slice(0, 12)} | 事件 ${events.length} | 用户消息 ${userCount} | 改于 ${info.mtime.toLocaleString('sv')}`,
      );
      console.log(`    首: ${oneLine(first, 70)}`);
      console.log(`    末: ${oneLine(last, 70)}`);
    }
  }
}

function cmdDump(file, limit = 12) {
  const events = sessionLines(file);
  console.log(`事件 ${events.length}`);
  for (const e of events.slice(0, limit)) {
    console.log('  type=' + (e.type ?? '?') + ' keys=' + Object.keys(e.data ?? e).join(','));
  }
}

function cmdExport(file, out, maxResult, compact = false) {
  const events = sessionLines(file);
  const lines = [];
  let userTurns = 0;
  let assistantTurns = 0;
  let toolCalls = 0;

  for (const event of events) {
    const type = String(event?.type ?? '');
    // 工具结果：紧凑模式直接丢掉（它们占了全文九成体积，需要时再回原文件 grep）
    if (/tool\/result|tool-result/.test(type) || event?.data?.message?.role === 'tool') {
      if (compact) continue;
      const data = event?.data?.message ?? event?.data ?? event;
      const text = Array.isArray(data?.content)
        ? data.content.filter((b) => typeof b?.text === 'string').map((b) => b.text).join('\n')
        : typeof data?.text === 'string'
          ? data.text
          : '';
      if (text) lines.push('```\n[工具结果] ' + truncate(text, maxResult) + '\n```\n');
      continue;
    }
    for (const m of describe(event)) {
      const who = String(m.role);
      if (who === 'user') {
        userTurns += 1;
        lines.push(`\n---\n\n## 👤 用户\n\n${m.text || '（附件）'}\n`);
      } else if (who === 'assistant' || /assistant/.test(type)) {
        assistantTurns += 1;
        if (m.text) lines.push(`\n### 🤖 助手\n\n${m.text}\n`);
        for (const call of m.calls) {
          toolCalls += 1;
          lines.push(`> 🔧 调用 \`${call.name}\`：${oneLine(call.arguments)}\n`);
        }
      }
    }
  }

  const header = [
    '# DSH 会话导出',
    '',
    `- 来源：\`${file}\``,
    `- 导出时间：${new Date().toLocaleString('sv')}`,
    `- 事件 ${events.length} 个 | 用户消息 ${userTurns} | 助手消息 ${assistantTurns} | 工具调用 ${toolCalls}`,
    compact
      ? '- **紧凑模式**：工具结果正文已省略（只留调用摘要）；用户消息与助手文本未删改。'
      : `- 工具结果已截断到 ${maxResult} 字符（原文动辄几十 KB）；助手文本与用户消息未删改。`,
    '',
  ].join('\n');

  writeFileSync(out, header + lines.join('\n'), 'utf8');
  console.log(`已导出 ${out}（用户 ${userTurns} / 助手 ${assistantTurns} / 工具 ${toolCalls}）`);
}

/** 只要用户消息（当"任务线索"用；很短，适合直接塞进任何上下文） */
function cmdUserOnly(file, out) {
  const events = sessionLines(file);
  const lines = [];
  let n = 0;
  for (const event of events) {
    for (const m of describe(event)) {
      if (m.role !== 'user' || !m.text) continue;
      n += 1;
      lines.push(`### ${n}. ${oneLine(m.text, 120)}`);
      if (m.text.length > 120) lines.push('```\n' + truncate(m.text, 1200) + '\n```');
    }
  }
  writeFileSync(out, `# 用户消息（${n} 条）\n\n` + lines.join('\n') + '\n', 'utf8');
  console.log(`已导出 ${out}（${n} 条用户消息）`);
}

const [cmd, a, b, ...rest] = process.argv.slice(2);
if (cmd === 'list') cmdList();
else if (cmd === 'dump') cmdDump(a);
else if (cmd === 'user-only') cmdUserOnly(a, b);
else if (cmd === 'export') {
  const maxResult = Number((rest.find((x) => x.startsWith('--max-result=')) ?? '--max-result=400').split('=')[1]);
  cmdExport(a, b, maxResult, rest.includes('--compact'));
} else {
  console.log('用法： list | dump <文件> | user-only <文件> <输出.md> | export <文件> <输出.md> [--max-result=400] [--compact]');
}
