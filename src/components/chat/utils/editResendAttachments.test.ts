import assert from 'node:assert/strict';
import test from 'node:test';

import { dataUrlToFile, resolveEditResendAttachments } from './editResendAttachments';

// 1x1 透明 PNG
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

test('dataUrlToFile 把 base64 图片还原为可上传的 File', () => {
  const file = dataUrlToFile({ data: `data:image/png;base64,${PNG_BASE64}` }, 0);
  assert.ok(file);
  assert.equal(file.type, 'image/png');
  assert.equal(file.name, 'edited-image-1.png');
  assert.ok(file.size > 0);
});

test('dataUrlToFile 保留原文件名，并按 mime 推导扩展名', () => {
  const named = dataUrlToFile({ data: `data:image/jpeg;base64,${PNG_BASE64}`, name: 'photo.jpg' }, 3);
  assert.ok(named);
  assert.equal(named.name, 'photo.jpg');
  assert.equal(named.type, 'image/jpeg');

  const unnamed = dataUrlToFile({ data: `data:image/jpeg;base64,${PNG_BASE64}` }, 3);
  assert.ok(unnamed);
  assert.equal(unnamed.name, 'edited-image-4.jpg');
});

test('dataUrlToFile 无法解析时返回 null 而不是抛错', () => {
  assert.equal(dataUrlToFile({}, 0), null);
  assert.equal(dataUrlToFile({ data: 'not-a-data-url' }, 0), null);
  assert.equal(dataUrlToFile({ data: 'data:image/png;base64' }, 0), null);
});

test('带存储路径的附件直接透传，不触发上传', async () => {
  const attachments = [
    { path: 'C:/assets/a.png', name: 'a.png', mimeType: 'image/png' },
    { path: 'C:/assets/b.pdf', name: 'b.pdf' },
  ];
  let uploadCalls = 0;
  const resolved = await resolveEditResendAttachments(attachments, async (files) => {
    uploadCalls += 1;
    return files;
  });
  assert.deepEqual(resolved, attachments);
  assert.equal(uploadCalls, 0);
});

test('仅剩 base64 的图片经重新上传换回存储路径', async () => {
  const uploaded: File[][] = [];
  const resolved = await resolveEditResendAttachments(
    [
      { path: 'C:/assets/keep.pdf', name: 'keep.pdf' },
      { data: `data:image/png;base64,${PNG_BASE64}` },
    ],
    async (files) => {
      uploaded.push(files);
      return files.map((file) => ({ path: `C:/assets/${file.name}`, name: file.name }));
    },
  );
  assert.equal(uploaded.length, 1);
  assert.equal(uploaded[0].length, 1);
  assert.equal(uploaded[0][0].type, 'image/png');
  assert.deepEqual(resolved, [
    { path: 'C:/assets/keep.pdf', name: 'keep.pdf' },
    { path: 'C:/assets/edited-image-2.png', name: 'edited-image-2.png' },
  ]);
});

test('既无路径也非可解析 data 的附件被丢弃', async () => {
  const resolved = await resolveEditResendAttachments([{ name: 'broken.png' }], async () => {
    throw new Error('should not upload');
  });
  assert.deepEqual(resolved, []);
});
