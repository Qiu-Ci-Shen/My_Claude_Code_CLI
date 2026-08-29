// 回归测试 locateTargetMessage：用真实转录 + 模拟前端渲染文本
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';

const require = createRequire(import.meta.url);
const { locateTargetMessage } = await import('file:///C:/Users/qiushenyuan/.claude-code-ui/plugins/claude-rewind/server.js');
const Database = require('D:/Claude_Tools/claudecodeui/node_modules/better-sqlite3');

const db = new Database(os.homedir() + '/.cloudcli/auth.db', { readonly: true });
const row = db.prepare('SELECT jsonl_path FROM sessions ORDER BY updated_at DESC LIMIT 1').get();
const entries = fs.readFileSync(row.jsonl_path, 'utf8').trim()
  .split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

let pass = 0, fail = 0;
const check = (name, ok) => { console.log(ok ? 'PASS' : 'FAIL', name); ok ? pass++ : fail++; };

// 1. markdown 用户消息：前端渲染后符号消失 → 归一化匹配应命中
for (const e of entries) {
  if (e.type !== 'user' || !e.uuid || e.isSidechain) continue;
  const c = typeof e.message?.content === 'string' ? e.message.content : '';
  if (/[*`#[\]]/.test(c) && c.length > 30) {
    const rendered = c.replace(/[*_`~[\]()#>| -]+/g, ' ').replace(/\s+/g, ' ').trim();
    const r = locateTargetMessage(entries, { timestamp: e.timestamp, textPrefix: rendered.slice(0, 50) });
    check('markdown rendered prefix', Boolean(r));
    break;
  }
}

// 2. 纯文本消息：原样前缀应命中
for (const e of entries) {
  if (e.type !== 'user' || !e.uuid || e.isSidechain) continue;
  const c = typeof e.message?.content === 'string' ? e.message.content : '';
  if (c.length > 30 && !/[*`#[\]_*~]/.test(c)) {
    const r = locateTargetMessage(entries, { timestamp: e.timestamp, textPrefix: c.slice(0, 50) });
    check('plain prefix', Boolean(r));
    // 3. 前缀完全乱写 → 时间戳兜底仍命中（同时间戳只有这条时）
    const r2 = locateTargetMessage(entries, { timestamp: e.timestamp, textPrefix: 'zzz完全无关xyz' });
    check('timestamp-only fallback', Boolean(r2) && r2.uuid === e.uuid);
    break;
  }
}

// 4. 不存在的时间戳 → 应返回 null
const ghost = locateTargetMessage(entries, { timestamp: '1999-01-01T00:00:00.000Z', textPrefix: 'x' });
check('nonexistent timestamp → null', ghost === null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
