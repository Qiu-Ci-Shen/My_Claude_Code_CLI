import test from 'node:test';
import assert from 'node:assert/strict';

import { markSessionSeen, readSessionLastSeen } from './utils';

const installStorage = (): Map<string, string> => {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, String(value));
      },
    },
  });
  return store;
};

test('readSessionLastSeen returns 0 when nothing has been stored', () => {
  installStorage();
  assert.equal(readSessionLastSeen('session-1'), 0);
});

test('markSessionSeen records a watermark per session without clobbering others', () => {
  installStorage();
  markSessionSeen('session-1', 1000);
  markSessionSeen('session-2', 2000);
  markSessionSeen('session-1', 3000);

  assert.equal(readSessionLastSeen('session-1'), 3000);
  assert.equal(readSessionLastSeen('session-2'), 2000);
  assert.equal(readSessionLastSeen('session-3'), 0);
});

test('corrupt stored payload degrades to 0 and self-heals on next mark', () => {
  const store = installStorage();
  store.set('claude-session-last-seen', '{not json');
  assert.equal(readSessionLastSeen('session-1'), 0);

  markSessionSeen('session-1', 42);
  assert.equal(readSessionLastSeen('session-1'), 42);
});

test('non-numeric stored watermarks are ignored', () => {
  const store = installStorage();
  store.set('claude-session-last-seen', JSON.stringify({ a: 'oops', b: null, c: 12 }));
  assert.equal(readSessionLastSeen('a'), 0);
  assert.equal(readSessionLastSeen('b'), 0);
  assert.equal(readSessionLastSeen('c'), 12);
});
