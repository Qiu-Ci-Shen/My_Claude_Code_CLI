// 回归测试 locateTargetMessage：自包含合成转录，覆盖前端各时间戳/内容形态
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const { locateTargetMessage, toEpochMs } = await import(
  pathToFileURL(path.join(here, 'server.js')).href
);

let pass = 0, fail = 0;
const check = (name, ok) => { console.log(ok ? 'PASS' : 'FAIL', name); ok ? pass++ : fail++; };

// 合成转录：user(字符串 content) → assistant → user(数组 content) → assistant
const ISO1 = '2026-08-29T08:15:23.456Z';
const ISO2 = '2026-08-29T08:16:10.000Z';
const entries = [
  { type: 'user', uuid: 'u1', parentUuid: null, timestamp: ISO1, message: { role: 'user', content: '帮我写一个 **排序** 函数' } },
  { type: 'assistant', uuid: 'a1', parentUuid: 'u1', timestamp: '2026-08-29T08:15:25.000Z', message: { role: 'assistant', content: '好的' } },
  { type: 'user', uuid: 'u2', parentUuid: 'a1', timestamp: ISO2, message: { role: 'user', content: [{ type: 'text', text: '第二条消息，带 <files>标注</files> 的原文' }] } },
  { type: 'assistant', uuid: 'a2', parentUuid: 'u2', timestamp: '2026-08-29T08:16:12.000Z', message: { role: 'assistant', content: '完成' } },
];

// 1. ISO 字符串时间戳 + 原文前缀（老路径：字符串 content）
check('ISO string + string content',
  locateTargetMessage(entries, { timestamp: ISO1, textPrefix: '帮我写一个' })?.uuid === 'u1');

// 2. 毫秒纪元数字 + 数组 content（前端 Date/数字时间戳形态）
check('epoch ms + array content',
  locateTargetMessage(entries, { timestamp: Date.parse(ISO2), textPrefix: '第二条消息' })?.uuid === 'u2');

// 3. ±2s 容差：前端时间戳被截断/取整后仍命中
check('timestamp within 2s tolerance',
  locateTargetMessage(entries, { timestamp: Date.parse(ISO2) + 1500, textPrefix: '第二条消息' })?.uuid === 'u2');
check('timestamp beyond tolerance misses level 1-2, prefix fallback hits',
  locateTargetMessage(entries, { timestamp: Date.parse(ISO2) + 30000, textPrefix: '第二条消息' })?.uuid === 'u2');

// 4. NaN→null（老版 bug 形态）+ 前缀 → 第三级兜底命中
check('null timestamp + prefix fallback',
  locateTargetMessage(entries, { timestamp: null, textPrefix: '帮我写一个' })?.uuid === 'u1');

// 5. <files> 包裹：UI 文本剥离标签后仍能对上转录原文
check('<files> tag stripped on match',
  locateTargetMessage(entries, { timestamp: ISO2, textPrefix: '第二条消息，带 标注 的原文' })?.uuid === 'u2');

// 6. markdown 归一化：转录 **排序** vs UI 渲染后 排序
check('markdown normalized prefix',
  locateTargetMessage(entries, { timestamp: ISO1, textPrefix: '帮我写一个 排序 函数' })?.uuid === 'u1');

// 7. 完全不存在的时间戳 + 乱写前缀 → null
check('nonexistent timestamp + garbage prefix → null',
  locateTargetMessage(entries, { timestamp: '1999-01-01T00:00:00.000Z', textPrefix: 'zzz完全无关xyz' }) === null);

// 8. toEpochMs 边界
check('toEpochMs ISO', toEpochMs(ISO1) === Date.parse(ISO1));
check('toEpochMs seconds', toEpochMs(1.75e9) === 1.75e12);
check('toEpochMs NaN string', toEpochMs('not-a-date') === null);
check('toEpochMs NaN number', toEpochMs(NaN) === null);
check('toEpochMs null', toEpochMs(null) === null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
