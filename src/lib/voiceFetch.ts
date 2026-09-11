// 语音转写请求的超时与重试（纯传输层，不依赖应用模块，便于 Node 单测）。
// 免费 STT 后端（如硅基流动 SenseVoiceSmall）在高负载下会偶发「挂着不响应」
// 或瞬时 429/5xx；没有这层保护时，一次挂起 = 界面永久停在「识别中」，且没有
// 任何取消路径（2026-09-10 实测事故）。重试节奏与旧 push-to-talk 插件对齐：
// 429/5xx 重试两次，0.8s / 2s 退避。
// 单次超时取 45s：2026-09-10 实测硅基流动 SenseVoiceSmall 成功一次要 ~37s，
// 15s 会把它「慢但能成功」的请求提前掐死；45s 覆盖慢后端，界面仍可随时取消。
export const TRANSCRIBE_TIMEOUT_MS = 45000;
export const TRANSCRIBE_RETRY_DELAYS_MS = [800, 2000];

const isTransientStatus = (status: number): boolean => status === 429 || status >= 500;

function makeAbortError(): DOMException {
  return new DOMException('aborted', 'AbortError');
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(makeAbortError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(makeAbortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function fetchOnce(
  url: string,
  init: RequestInit,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<Response> {
  if (signal?.aborted) throw makeAbortError();
  const controller = new AbortController();
  let timedOut = false;
  const onOuterAbort = () => controller.abort();
  signal?.addEventListener('abort', onOuterAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (timedOut) throw new Error(`no response in ${Math.round(timeoutMs / 1000)}s`);
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onOuterAbort);
  }
}

export type VoiceFetchOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
  retryDelaysMs?: readonly number[];
  fetchImpl?: typeof fetch;
};

/** 带超时与瞬时错误重试的 fetch。取消（signal 中止）立即生效，绝不重试。 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  options: VoiceFetchOptions = {},
): Promise<Response> {
  const {
    signal,
    timeoutMs = TRANSCRIBE_TIMEOUT_MS,
    retryDelaysMs = TRANSCRIBE_RETRY_DELAYS_MS,
    fetchImpl = fetch,
  } = options;

  for (let attempt = 0; ; attempt += 1) {
    let response: Response | undefined;
    let failure: unknown = new Error('voice request failed');
    try {
      response = await fetchOnce(url, init, signal, timeoutMs, fetchImpl);
    } catch (error) {
      if (signal?.aborted) throw error; // 主动取消：不重试、不掩盖
      failure = error;
    }
    if (response && !isTransientStatus(response.status)) return response;
    if (attempt >= retryDelaysMs.length) {
      if (response) return response; // 重试耗尽仍是 429/5xx：交回调用方展示状态
      throw failure;
    }
    await sleep(retryDelaysMs[attempt], signal);
  }
}
