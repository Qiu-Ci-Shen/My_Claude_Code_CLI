import type { EditMessageAttachment } from '../../../lib/rewindRpc';

/**
 * 编辑重发时恢复原消息附件。
 *
 * 带存储路径的描述符直接透传（服务端只放行上传存储目录内的路径）；Claude
 * 转录把图片存成 base64，历史消息里的图片只剩 `data`——重发前还原成 File
 * 重新上传换取存储路径。
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

export const resolveEditResendAttachments = async (
  attachments: EditMessageAttachment[],
  uploadFiles: (files: File[]) => Promise<unknown[]>,
): Promise<unknown[]> => {
  const direct: EditMessageAttachment[] = [];
  const pendingUploads: File[] = [];

  attachments.forEach((attachment, index) => {
    if (attachment.path) {
      direct.push(attachment);
      return;
    }
    const file = dataUrlToFile(attachment, index);
    if (file) {
      pendingUploads.push(file);
    } else {
      console.warn('[EditResend] Unrecoverable attachment dropped:', attachment.name || index);
    }
  });

  const uploaded = pendingUploads.length > 0 ? await uploadFiles(pendingUploads) : [];
  return [...direct, ...uploaded];
};
