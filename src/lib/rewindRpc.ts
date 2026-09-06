import { authenticatedFetch } from '../utils/api';

/**
 * 内置 Rewind 的 API 封装（原 claude-rewind 插件 RPC 的原生等价物）。
 *
 * 截断会话与恢复代码文件的能力都在服务端 rewind 模块（locate 定位消息 uuid →
 * execute 截断转录 + 可选恢复 checkpoint 文件，自带原子备份），这里只做
 * 带认证的 HTTP 调用。编辑重发与用户消息回退按钮共用此客户端。
 */
const RPC_BASE = '/api/rewind';

/** 从当前路由（/session/<id>）提取会话 id；新会话（根路径）为 null。 */
export function currentSessionIdFromPath(): string | null {
  const match = window.location.pathname.match(/\/session\/([^/?#]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

async function rpc<T>(path: string, body: unknown): Promise<T> {
  const token = localStorage.getItem('auth-token');
  const response = await authenticatedFetch(`${RPC_BASE}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    // 宿主/插件返回的 error 字段是可直接展示的中文文案（如"会话仍在生成中"）
    const detail = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(detail?.error || `rewind RPC ${path} failed: ${response.status}`);
  }
  return (await response.json()) as T;
}

export type RewindLocateResult = { found: boolean; uuid?: string };

export function rewindLocate(
  sessionId: string | null,
  // 转录里的时间戳原样透传（ISO 字符串/数字均可），由服务端归一后做容差匹配；
  // 这里绝不能 Number() 转换——ISO 字符串会变 NaN→null 导致定位永远失败。
  timestamp: string | number | Date | null | undefined,
  textPrefix: string,
): Promise<RewindLocateResult> {
  return rpc<RewindLocateResult>('/locate', { sessionId, timestamp, textPrefix });
}

export function rewindExecute(
  sessionId: string | null,
  targetUuid: string,
  restoreFiles: boolean,
): Promise<{ ok: boolean; error?: string }> {
  return rpc<{ ok: boolean; error?: string }>('/execute', {
    sessionId,
    targetUuid,
    restoreFiles,
  });
}

/** 编辑重发暂存键：截断成功后写入，页面刷新后由 composer 消费并自动发送。 */
export const PENDING_EDIT_RESEND_KEY = 'qiu:pending-edit-resend';

/** 编辑模式目标：✎ 选中的那条消息（ZCode 同款底部输入框编辑） */
export type EditMessageTarget = {
  sessionId: string | null;
  timestamp: string | number | Date | null | undefined;
  /** 消息完整原文，载入输入框 */
  content: string;
};
