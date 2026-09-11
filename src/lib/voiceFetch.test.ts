import assert from 'node:assert/strict';
import test from 'node:test';

import { fetchWithRetry } from './voiceFetch';

const jsonResponse = (status: number): Response => new Response('{}', { status });

const abortError = (): DOMException => new DOMException('aborted', 'AbortError');

// 模拟 fetch 的中止语义：signal 触发时以 AbortError 拒绝，否则永远挂起
const hangingFetch =
  (onCall: () => void): typeof fetch =>
  (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      onCall();
      const signal = init?.signal;
      if (!signal) return;
      if (signal.aborted) {
        reject(abortError());
        return;
      }
      signal.addEventListener('abort', () => reject(abortError()), { once: true });
    });

test('returns a successful response without retrying', async () => {
  let calls = 0;
  const res = await fetchWithRetry('/voice', {}, {
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse(200);
    },
  });
  assert.equal(res.status, 200);
  assert.equal(calls, 1);
});

test('does not retry non-transient statuses', async () => {
  let calls = 0;
  const res = await fetchWithRetry('/voice', {}, {
    retryDelaysMs: [1, 1],
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse(400);
    },
  });
  assert.equal(res.status, 400);
  assert.equal(calls, 1);
});

test('retries a transient 503 before succeeding', async () => {
  let calls = 0;
  const res = await fetchWithRetry('/voice', {}, {
    retryDelaysMs: [1, 1],
    fetchImpl: async () => {
      calls += 1;
      return calls < 3 ? jsonResponse(503) : jsonResponse(200);
    },
  });
  assert.equal(res.status, 200);
  assert.equal(calls, 3);
});

test('returns the last transient response after retries are exhausted', async () => {
  let calls = 0;
  const res = await fetchWithRetry('/voice', {}, {
    retryDelaysMs: [1],
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse(500);
    },
  });
  assert.equal(res.status, 500);
  assert.equal(calls, 2);
});

test('times out a hanging request and surfaces an error after retries', async () => {
  let calls = 0;
  await assert.rejects(
    fetchWithRetry('/voice', {}, {
      timeoutMs: 20,
      retryDelaysMs: [1],
      fetchImpl: hangingFetch(() => {
        calls += 1;
      }),
    }),
    /no response in/,
  );
  assert.equal(calls, 2);
});

test('aborting a hanging request rejects immediately without retrying', async () => {
  const controller = new AbortController();
  let calls = 0;
  const promise = fetchWithRetry('/voice', {}, {
    signal: controller.signal,
    timeoutMs: 10_000,
    retryDelaysMs: [1, 1],
    fetchImpl: hangingFetch(() => {
      calls += 1;
    }),
  });
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(promise, (e: unknown) => (e as DOMException).name === 'AbortError');
  assert.equal(calls, 1);
});

test('aborting during retry backoff rejects without another call', async () => {
  const controller = new AbortController();
  let calls = 0;
  const promise = fetchWithRetry('/voice', {}, {
    signal: controller.signal,
    retryDelaysMs: [5000],
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse(503);
    },
  });
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(promise, (e: unknown) => (e as DOMException).name === 'AbortError');
  assert.equal(calls, 1);
});
