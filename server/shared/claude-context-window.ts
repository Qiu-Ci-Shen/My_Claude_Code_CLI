import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Resolves the Claude context window from `~/.claude/settings.json`'s `model`
 * field. Needed because API proxies rewrite model ids (e.g. "sonnet[1m]" ->
 * "ox-alpha-free"), so transcripts may not carry the `[1m]`/`[200k]` suffix
 * that marks a non-default window.
 *
 * Returns 0 when nothing recognizable is configured, letting callers fall
 * through to their own defaults.
 */
export function readClaudeSettingsContextWindow(
  settingsPath: string = path.join(os.homedir(), '.claude', 'settings.json'),
): number {
  let content: string;
  try {
    content = fs.readFileSync(settingsPath, 'utf8');
  } catch {
    return 0;
  }

  try {
    const settings = JSON.parse(content) as {
      model?: unknown;
      env?: Record<string, unknown>;
    };
    const model = typeof settings.model === 'string' ? settings.model : '';
    const fromModel = modelSuffixContextWindow(model);
    if (fromModel > 0) {
      return fromModel;
    }

    // 代理用户常把带窗口后缀的模型名写进 env 的模型槽位映射里（如
    // ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-sonnet-4-6[1M]"）。取所有槽位
    // 中最大的窗口——主线程模型决定上下文占用，子代理槽位只会更小。
    const env = settings.env && typeof settings.env === 'object' ? settings.env : {};
    let best = 0;
    for (const [key, value] of Object.entries(env)) {
      if (typeof value !== 'string' || !/MODEL/i.test(key)) continue;
      const window = modelSuffixContextWindow(value);
      if (window > best) best = window;
    }
    return best;
  } catch {
    return 0;
  }
}

function modelSuffixContextWindow(model: string): number {
  const millionMatch = /\[([0-9]+)m\]/i.exec(model);
  if (millionMatch) {
    return parseInt(millionMatch[1], 10) * 1_000_000;
  }
  const kiloMatch = /\[([0-9]+)k\]/i.exec(model);
  if (kiloMatch) {
    return parseInt(kiloMatch[1], 10) * 1_000;
  }
  return 0;
}
