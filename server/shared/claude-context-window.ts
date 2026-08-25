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
    const settings = JSON.parse(content) as { model?: unknown };
    const model = typeof settings.model === 'string' ? settings.model : '';
    return modelSuffixContextWindow(model);
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
