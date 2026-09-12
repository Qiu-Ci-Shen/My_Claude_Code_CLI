/**
 * 工具结果内容拆分单测（tsx --test，随 npm test 运行）
 *
 * 背景：qiu-browser 截图工具以标准 MCP image 块回传截图；工具结果在服务端
 * 归一化时必须把文本与图片分开——文本进 content（拼接而非 JSON 化），图片
 * 提取为 data URL 交给聊天前端渲染。测试锁死两种块形状与各类边界。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { extractToolResultImages, toolResultText } from '../claude-sessions.provider.js';

test('字符串内容原样返回', () => {
  assert.equal(toolResultText('hello'), 'hello');
});

test('文本块数组 → 换行拼接', () => {
  assert.equal(
    toolResultText([
      { type: 'text', text: '第一段' },
      { type: 'text', text: '第二段' },
    ]),
    '第一段\n第二段',
  );
});

test('含图片块的数组 → 文本拼接,图片不进文本', () => {
  const content = [
    { type: 'text', text: '截图已保存' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
  ];
  assert.equal(toolResultText(content), '截图已保存');
});

test('无文本块的数组 → JSON 兜底(不丢数据)', () => {
  const content = [{ type: 'resource', uri: 'file://x' }];
  assert.equal(toolResultText(content), JSON.stringify(content));
});

test('非数组非字符串 → JSON 序列化', () => {
  assert.equal(toolResultText({ ok: true }), '{"ok":true}');
});

test('字符串/空数组 → 无图片', () => {
  assert.equal(extractToolResultImages('plain text'), undefined);
  assert.equal(extractToolResultImages([]), undefined);
  assert.equal(extractToolResultImages(undefined), undefined);
});

test('嵌套 source 形状(base64) → 提取为 data URL', () => {
  const images = extractToolResultImages([
    { type: 'text', text: 'look' },
    { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'QUJD' } },
  ]);
  assert.deepEqual(images, [{ data: 'data:image/jpeg;base64,QUJD' }]);
});

test('嵌套形状缺 media_type → 回退 image/png', () => {
  const images = extractToolResultImages([
    { type: 'image', source: { type: 'base64', data: 'QUJD' } },
  ]);
  assert.deepEqual(images, [{ data: 'data:image/png;base64,QUJD' }]);
});

test('扁平形状({type,data,mimeType}) → 同样提取', () => {
  const images = extractToolResultImages([
    { type: 'image', data: 'QUJD', mimeType: 'image/webp' },
  ]);
  assert.deepEqual(images, [{ data: 'data:image/webp;base64,QUJD' }]);
});

test('多张图片按顺序提取', () => {
  const images = extractToolResultImages([
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A' } },
    { type: 'text', text: '之间' },
    { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'B' } },
  ]);
  assert.deepEqual(images, [
    { data: 'data:image/png;base64,A' },
    { data: 'data:image/jpeg;base64,B' },
  ]);
});

test('畸形图片块(无 data / source 非 base64) → 安全跳过', () => {
  const images = extractToolResultImages([
    { type: 'image' },
    { type: 'image', source: { type: 'url', url: 'https://x/y.png' } },
    { type: 'image', source: { type: 'base64' } },
    null,
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'OK' } },
  ]);
  assert.deepEqual(images, [{ data: 'data:image/png;base64,OK' }]);
});
