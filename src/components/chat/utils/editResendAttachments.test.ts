import assert from 'node:assert/strict';
import test from 'node:test';

import { dataUrlToFile, restoreEditAttachmentsToFiles } from './editResendAttachments';

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

test('base64 图片直接解码，不触发下载', async () => {
  let downloadCalls = 0;
  const files = await restoreEditAttachmentsToFiles(
    [{ data: `data:image/png;base64,${PNG_BASE64}`, name: 'shot.png' }],
    async () => {
      downloadCalls += 1;
      return null;
    },
  );
  assert.equal(downloadCalls, 0);
  assert.equal(files.length, 1);
  assert.equal(files[0].name, 'shot.png');
  assert.equal(files[0].type, 'image/png');
});

test('带存储路径的附件经下载还原为 File，保持原顺序', async () => {
  const downloaded: string[] = [];
  const files = await restoreEditAttachmentsToFiles(
    [
      { path: 'C:/assets/1-a.png', name: 'a.png', mimeType: 'image/png' },
      { path: 'C:/assets/2-b.docx', name: 'b.docx' },
    ],
    async (attachment) => {
      downloaded.push(attachment.path as string);
      return new File(['x'], attachment.name as string, { type: attachment.mimeType || 'application/octet-stream' });
    },
  );
  assert.deepEqual(downloaded, ['C:/assets/1-a.png', 'C:/assets/2-b.docx']);
  assert.deepEqual(files.map((file) => file.name), ['a.png', 'b.docx']);
  assert.equal(files[0].type, 'image/png');
  assert.equal(files[1].type, 'application/octet-stream');
});

test('下载失败或不可用的附件被丢弃，其余保留', async () => {
  const files = await restoreEditAttachmentsToFiles(
    [
      { path: 'C:/assets/gone.pdf', name: 'gone.pdf' },
      { path: 'C:/assets/boom.pdf', name: 'boom.pdf' },
      { data: `data:image/png;base64,${PNG_BASE64}`, name: 'ok.png' },
    ],
    async (attachment) => {
      if (attachment.name === 'boom.pdf') {
        throw new Error('network down');
      }
      return null;
    },
  );
  assert.deepEqual(files.map((file) => file.name), ['ok.png']);
});

test('既无路径也非可解析 data 的附件被丢弃，不触发下载', async () => {
  let downloadCalls = 0;
  const files = await restoreEditAttachmentsToFiles([{ name: 'broken.png' }], async () => {
    downloadCalls += 1;
    return null;
  });
  assert.equal(downloadCalls, 0);
  assert.deepEqual(files, []);
});
