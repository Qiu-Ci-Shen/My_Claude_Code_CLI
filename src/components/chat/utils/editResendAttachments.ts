import type { EditMessageAttachment } from '../../../lib/rewindRpc';

/**
 * 编辑回填时把原消息附件还原成可在输入框里继续编辑的 File。
 *
 * Claude 转录把图片存成 base64，历史消息里的图片只剩 `data`——直接解码；
 * 其余附件带存储路径（`~/.cloudcli/assets` 内），由调用方提供的下载回调取回
 * 内容。两条路都还原成真实 File，输入框的预览/删除/再发送全部复用普通流程。
 */

/** 把内联 data URL 还原成可上传的 File；解析失败返回 null。 */
export const dataUrlToFile = (attachment: EditMessageAttachment, index: number): File | null => {
  const data = attachment.data;
  if (!data || !data.startsWith('data:')) {
    return null;
  }
  const commaIndex = data.indexOf(',');
  if (commaIndex < 0) {
    return null;
  }

  try {
    const mimeType = data.slice(5, commaIndex).split(';')[0] || attachment.mimeType || 'image/png';
    const bytes = Uint8Array.from(atob(data.slice(commaIndex + 1)), (char) => char.charCodeAt(0));
    const extension = mimeType.split('/')[1]?.replace('jpeg', 'jpg') || 'png';
    return new File([bytes], attachment.name || `edited-image-${index + 1}.${extension}`, { type: mimeType });
  } catch {
    return null;
  }
};

export const restoreEditAttachmentsToFiles = async (
  attachments: EditMessageAttachment[],
  downloadAttachment: (attachment: EditMessageAttachment) => Promise<File | null>,
): Promise<File[]> => {
  const restored = await Promise.all(
    attachments.map(async (attachment, index) => {
      if (attachment.data) {
        const file = dataUrlToFile(attachment, index);
        if (!file) {
          console.warn('[EditRestore] Unrecoverable inline attachment dropped:', attachment.name || index);
        }
        return file;
      }
      if (attachment.path) {
        try {
          const file = await downloadAttachment(attachment);
          if (!file) {
            console.warn('[EditRestore] Attachment unavailable, dropped:', attachment.name || attachment.path);
          }
          return file;
        } catch (error) {
          console.warn('[EditRestore] Attachment download failed:', attachment.name || attachment.path, error);
          return null;
        }
      }
      console.warn('[EditRestore] Attachment has neither data nor path, dropped:', attachment.name || index);
      return null;
    }),
  );

  return restored.filter((file): file is File => file !== null);
};
