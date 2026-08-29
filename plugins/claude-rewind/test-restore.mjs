// 端到端验证 buildRestorePlan：用真实测试会话（021d0693，bbb.txt/ccc.txt）
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const Database = require('D:/Claude_Tools/claudecodeui/node_modules/better-sqlite3');

// 从 server.js 提取 buildRestorePlan（它是内部函数，直接 import 拿不到——复制同逻辑验证）
// 为避免双份逻辑漂移，这里用正则从源码里抠出函数体 eval 执行。
const src = fs.readFileSync('C:/Users/qiushenyuan/.claude-code-ui/plugins/claude-rewind/server.js', 'utf8');
const lines = src.split('\n');
const startIdx = lines.findIndex((l) => l.startsWith('function buildRestorePlan'));
const nextFnIdx = lines.findIndex((l, i) => i > startIdx && /^async function |^function /.test(l));
if (startIdx < 0 || nextFnIdx < 0) { console.log('FAIL extract'); process.exit(1); }
// 函数体到下一个顶层声明前，去掉尾部空行后以 '}' 收尾
let endIdx = nextFnIdx - 1;
while (lines[endIdx].trim() === '') endIdx--;
if (lines[endIdx] !== '}') { console.log('FAIL: unexpected end'); process.exit(1); }
const fnSrc = lines.slice(startIdx, endIdx + 1).join('\n');
const buildRestorePlan = new Function('entries', 'targetUuid', 'checkpointDir', 'body', 'path', `${fnSrc}; return buildRestorePlan(entries, targetUuid, checkpointDir, body, path);`);

const db = new Database(os.homedir() + '/.cloudcli/auth.db', { readonly: true });
const row = db.prepare("SELECT provider_session_id, jsonl_path FROM sessions WHERE provider_session_id LIKE '021d0693%'").get();
const entries = fs.readFileSync(row.jsonl_path, 'utf8').trim()
  .split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const checkpointDir = path.join(os.homedir(), '.claude', 'file-history', row.provider_session_id);
const users = entries.filter((e) => e.type === 'user' && !e.isSidechain);

let pass = 0, fail = 0;
const check = (name, ok) => { console.log(ok ? 'PASS' : 'FAIL', name); ok ? pass++ : fail++; };

// 场景1：回退到第一条（创建 bbb.txt）之前 → bbb.txt 应被删除
const p1 = buildRestorePlan(entries, users[0].uuid, checkpointDir, {}, path);
check('S1: bbb.txt in remove list (created after target)',
  p1.remove.some((r) => r.filePath.endsWith('bbb.txt')));
check('S1: nothing to restore', p1.restore.length === 0);

// 场景2：回退到第二条（建 ccc.txt）之前 → bbb.txt 恢复自备份、ccc.txt 删除
const p2 = buildRestorePlan(entries, users[1].uuid, checkpointDir, {}, path);
check('S2: bbb.txt restored from @v2 backup',
  p2.restore.some((r) => r.backupPath.includes('fddee49fcd68c361@v2') && r.filePath.endsWith('bbb.txt')));
check('S2: ccc.txt in remove list',
  p2.remove.some((r) => r.filePath.endsWith('ccc.txt')));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
