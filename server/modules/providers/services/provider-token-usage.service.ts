import fsSync, { type Dirent } from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

import { sessionsDb } from '@/modules/database/index.js';
import type { AnyRecord } from '@/shared/types.js';
import { AppError, getOpenCodeDatabasePath } from '@/shared/utils.js';
import { readClaudeSettingsContextWindow } from '@/shared/claude-context-window.js';

type SessionRow = NonNullable<ReturnType<typeof sessionsDb.getSessionById>>;

type ProviderTokenUsageServiceDependencies = {
  getSessionById: (sessionId: string) => SessionRow | null | undefined;
  getHomeDirectory: () => string;
  getOpenCodeDatabasePath: () => string;
  fileExists: (filePath: string) => boolean;
  readDirectory: (directoryPath: string) => Promise<Dirent[]>;
  readTextFile: (filePath: string) => Promise<string>;
  /**
   * Reads a usage-scan window from a file: the last `tailBytes` plus the first
   * `headBytes`. `truncated` is false when the file fits in the tail window,
   * in which case `tail`/`head` are the whole content. Transcripts grow to
   * multi-MB while only the tail carries current usage; scanning the window
   * avoids reading+ splitting the whole file on every session open.
   */
  readTextFileWindow: (
    filePath: string,
    tailBytes: number,
    headBytes: number,
  ) => Promise<{ tail: string; head: string; truncated: boolean }>;
  getClaudeContextWindow: () => string | undefined;
};

type TokenUsageResult = {
  used: number;
  total?: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  cacheTokens?: number;
  breakdown: {
    input: number;
    output: number;
  };
  unsupported?: boolean;
  message?: string;
};

type OpenCodeTokenRow = {
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
};

// 使用量扫描窗口：最后一条 usage（以及压缩边界与其之前的 usage）总在尾窗内；
// 头窗只用于读首个 model 标记（上下文窗口判定），64KB 足够覆盖任何真实转录。
const CLAUDE_USAGE_TAIL_BYTES = 512 * 1024;
const CLAUDE_USAGE_HEAD_BYTES = 64 * 1024;

const defaultDependencies: ProviderTokenUsageServiceDependencies = {
  getSessionById: (sessionId) => sessionsDb.getSessionById(sessionId),
  getHomeDirectory: () => os.homedir(),
  getOpenCodeDatabasePath,
  fileExists: (filePath) => fsSync.existsSync(filePath),
  readDirectory: (directoryPath) => fsp.readdir(directoryPath, { withFileTypes: true }),
  readTextFile: (filePath) => fsp.readFile(filePath, 'utf8'),
  readTextFileWindow: async (filePath, tailBytes, headBytes) => {
    const fileStat = await fsp.stat(filePath);
    if (fileStat.size <= tailBytes) {
      const content = await fsp.readFile(filePath, 'utf8');
      return { tail: content, head: content, truncated: false };
    }

    const handle = await fsp.open(filePath, 'r');
    try {
      const tailSize = Math.min(tailBytes, fileStat.size);
      const headSize = Math.min(headBytes, fileStat.size);
      const tailBuffer = Buffer.alloc(tailSize);
      await handle.read(tailBuffer, 0, tailSize, fileStat.size - tailSize);
      const headBuffer = Buffer.alloc(headSize);
      await handle.read(headBuffer, 0, headSize, 0);
      // 尾窗从中间截断：首行可能是半截行，扫描端的 JSON.parse 容错会跳过它。
      return { tail: tailBuffer.toString('utf8'), head: headBuffer.toString('utf8'), truncated: true };
    } finally {
      await handle.close();
    }
  },
  getClaudeContextWindow: () => process.env.CONTEXT_WINDOW,
};

function readUsageNumber(value: unknown): number {
  const parsedValue = Number(value);
  return Number.isFinite(parsedValue) ? parsedValue : 0;
}

async function findCodexSessionFile(
  directoryPath: string,
  providerSessionId: string,
  dependencies: ProviderTokenUsageServiceDependencies,
): Promise<string | null> {
  let entries: Dirent[];
  try {
    entries = await dependencies.readDirectory(directoryPath);
  } catch {
    // Codex session folders are date-partitioned and can disappear while a
    // cleanup is running. An unreadable branch is simply not a match.
    return null;
  }

  for (const entry of entries) {
    const entryPath = path.join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      const nestedMatch = await findCodexSessionFile(entryPath, providerSessionId, dependencies);
      if (nestedMatch) {
        return nestedMatch;
      }
      continue;
    }

    if (entry.name.includes(providerSessionId) && entry.name.endsWith('.jsonl')) {
      return entryPath;
    }
  }

  return null;
}

function readCodexTokenUsage(fileContent: string): TokenUsageResult {
  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  let contextWindow = 200_000;
  const lines = fileContent.trim().split('\n');

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const entry = JSON.parse(lines[index]) as AnyRecord;
      const tokenInfo = entry.type === 'event_msg' && entry.payload?.type === 'token_count'
        ? entry.payload.info
        : null;
      if (!tokenInfo) {
        continue;
      }

      if (tokenInfo.total_token_usage) {
        inputTokens = readUsageNumber(tokenInfo.total_token_usage.input_tokens);
        outputTokens = readUsageNumber(tokenInfo.total_token_usage.output_tokens);
        totalTokens = readUsageNumber(tokenInfo.total_token_usage.total_tokens)
          || inputTokens + outputTokens;
      }
      contextWindow = readUsageNumber(tokenInfo.model_context_window) || contextWindow;
      break;
    } catch {
      // A provider may be writing the last JSONL line while this read happens.
    }
  }

  return {
    used: totalTokens,
    total: contextWindow,
    inputTokens,
    outputTokens,
    breakdown: { input: inputTokens, output: outputTokens },
  };
}

function resolveClaudeContextWindow(
  fileContent: string,
  configuredContextWindow: string | undefined,
): number {
  // Mirror the runtime provider: prefer the model id suffix recorded in the
  // transcript (e.g. "sonnet[1m]" -> 1M) before falling back to the env value.
  const modelMatch = /"model":"([^"]+)"/.exec(fileContent);
  const modelName = modelMatch?.[1] ?? '';
  const millionMatch = /\[([0-9]+)m\]/i.exec(modelName);
  if (millionMatch) {
    return parseInt(millionMatch[1], 10) * 1_000_000;
  }
  const kiloMatch = /\[([0-9]+)k\]/i.exec(modelName);
  if (kiloMatch) {
    return parseInt(kiloMatch[1], 10) * 1_000;
  }
  // Proxies rewrite model ids, so the transcript suffix may be missing while
  // settings.json still records what the user actually selected.
  const settingsWindow = readClaudeSettingsContextWindow();
  if (settingsWindow > 0) {
    return settingsWindow;
  }
  const parsedContextWindow = Number.parseInt(configuredContextWindow ?? '', 10);
  return Number.isFinite(parsedContextWindow) ? parsedContextWindow : 160_000;
}

function readClaudeTokenUsage(
  scanContent: string,
  configuredContextWindow: string | undefined,
  windowHeadContent: string,
): { result: TokenUsageResult; foundUsage: boolean } {
  let foundUsage = false;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  let compactPostTokens = 0;
  const lines = scanContent.trim().split('\n');

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const entry = JSON.parse(lines[index]) as AnyRecord;

      // 压缩边界若比最后一条 usage 更晚，上下文占用以它的 postTokens 为准；
      // 否则压缩完成后（下一回合之前）这里读到的仍是压缩前的高值。记录后
      // 继续向前找最后一条 usage——缓存三桶沿用它的值仅供命中率展示。
      if (entry.type === 'system' && entry.subtype === 'compact_boundary') {
        if (compactPostTokens === 0) {
          const metadata = (entry.compactMetadata ?? entry.compact_metadata) as AnyRecord | undefined;
          compactPostTokens = readUsageNumber(metadata?.postTokens ?? metadata?.post_tokens);
        }
        continue;
      }

      const usage = entry.type === 'assistant' ? entry.message?.usage : null;
      if (!usage) {
        continue;
      }

      const directInputTokens = readUsageNumber(usage.input_tokens ?? usage.inputTokens);
      cacheReadTokens = readUsageNumber(
        usage.cache_read_input_tokens ?? usage.cacheReadInputTokens ?? usage.cacheReadTokens,
      );
      cacheCreationTokens = readUsageNumber(
        usage.cache_creation_input_tokens
          ?? usage.cacheCreationInputTokens
          ?? usage.cacheCreationTokens,
      );
      inputTokens = directInputTokens + cacheReadTokens + cacheCreationTokens;
      outputTokens = readUsageNumber(usage.output_tokens ?? usage.outputTokens);
      foundUsage = true;
      break;
    } catch {
      // Skip malformed lines without discarding usage from earlier messages.
    }
  }

  const contextWindow = resolveClaudeContextWindow(windowHeadContent, configuredContextWindow);
  const cacheTokens = cacheReadTokens + cacheCreationTokens;

  if (compactPostTokens > 0) {
    // post_tokens 即压缩后的上下文占用（不含固定前缀，与运行时读法一致）；
    // 缓存三桶沿用最后一条 usage 的值，仅供命中率展示。
    return {
      foundUsage,
      result: {
        used: compactPostTokens,
        total: contextWindow,
        inputTokens: compactPostTokens,
        outputTokens: 0,
        cacheReadTokens,
        cacheCreationTokens,
        cacheTokens,
        breakdown: { input: compactPostTokens, output: 0 },
      },
    };
  }

  return {
    foundUsage,
    result: {
      used: inputTokens + outputTokens,
      total: contextWindow,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens,
      cacheTokens,
      breakdown: { input: inputTokens, output: outputTokens },
    },
  };
}

function readOpenCodeTokenUsage(databasePath: string, providerSessionId: string): TokenUsageResult {
  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const columns = database.prepare('PRAGMA table_info(session)').all() as Array<{ name: string }>;
    const columnNames = new Set(columns.map((column) => column.name));
    const requiredColumns = [
      'tokens_input',
      'tokens_output',
      'tokens_reasoning',
      'tokens_cache_read',
      'tokens_cache_write',
    ];

    if (!requiredColumns.every((column) => columnNames.has(column))) {
      return {
        used: 0,
        inputTokens: 0,
        outputTokens: 0,
        breakdown: { input: 0, output: 0 },
        unsupported: true,
        message: 'Token usage tracking is not available in this OpenCode database schema',
      };
    }

    const row = database.prepare(`
      SELECT
        tokens_input AS inputTokens,
        tokens_output AS outputTokens,
        tokens_reasoning AS reasoningTokens,
        tokens_cache_read AS cacheReadTokens,
        tokens_cache_write AS cacheWriteTokens
      FROM session
      WHERE id = ?
    `).get(providerSessionId) as OpenCodeTokenRow | undefined;

    if (!row) {
      throw new AppError('OpenCode session was not found.', {
        code: 'OPENCODE_SESSION_NOT_FOUND',
        statusCode: 404,
      });
    }

    const inputTokens = readUsageNumber(row.inputTokens) + readUsageNumber(row.cacheReadTokens);
    const outputTokens = readUsageNumber(row.outputTokens);
    const used = readUsageNumber(row.inputTokens)
      + outputTokens
      + readUsageNumber(row.reasoningTokens)
      + readUsageNumber(row.cacheReadTokens)
      + readUsageNumber(row.cacheWriteTokens);

    return {
      used,
      inputTokens,
      outputTokens,
      breakdown: { input: inputTokens, output: outputTokens },
    };
  } finally {
    database.close();
  }
}

/**
 * Creates the provider token-usage service used by the provider routes. The
 * provider test suite supplies isolated filesystem and session dependencies so
 * every calculator can be exercised without touching a developer's real data.
 */
export function createProviderTokenUsageService(
  dependencyOverrides: Partial<ProviderTokenUsageServiceDependencies> = {},
) {
  const dependencies = { ...defaultDependencies, ...dependencyOverrides };

  return {
    /**
     * Resolves all provider-specific storage details from one app-facing
     * session id, then returns the latest usage snapshot for that provider.
     */
    async getSessionTokenUsage(sessionId: string): Promise<TokenUsageResult> {
      const session = dependencies.getSessionById(sessionId);
      if (!session) {
        throw new AppError(`Session "${sessionId}" was not found.`, {
          code: 'SESSION_NOT_FOUND',
          statusCode: 404,
        });
      }

      const providerSessionId = session.provider_session_id || sessionId;

      if (session.provider === 'cursor') {
        return {
          used: 0,
          total: 0,
          inputTokens: 0,
          outputTokens: 0,
          breakdown: { input: 0, output: 0 },
          unsupported: true,
          message: 'Token usage tracking not available for Cursor sessions',
        };
      }

      if (session.provider === 'opencode') {
        const databasePath = dependencies.getOpenCodeDatabasePath();
        if (!dependencies.fileExists(databasePath)) {
          throw new AppError('OpenCode database was not found.', {
            code: 'OPENCODE_DATABASE_NOT_FOUND',
            statusCode: 404,
          });
        }

        return readOpenCodeTokenUsage(databasePath, providerSessionId);
      }

      if (session.provider === 'codex') {
        const indexedFilePath = session.jsonl_path && dependencies.fileExists(session.jsonl_path)
          ? session.jsonl_path
          : null;
        const sessionFilePath = indexedFilePath ?? await findCodexSessionFile(
          path.join(dependencies.getHomeDirectory(), '.codex', 'sessions'),
          providerSessionId,
          dependencies,
        );

        if (!sessionFilePath) {
          throw new AppError(`Codex session file for "${sessionId}" was not found.`, {
            code: 'CODEX_SESSION_FILE_NOT_FOUND',
            statusCode: 404,
          });
        }

        const fileContent = await dependencies.readTextFile(sessionFilePath);
        return readCodexTokenUsage(fileContent);
      }

      let sessionFilePath = session.jsonl_path;
      if (!sessionFilePath) {
        if (!session.project_path) {
          throw new AppError(`Session file for "${sessionId}" was not found.`, {
            code: 'SESSION_FILE_NOT_FOUND',
            statusCode: 404,
          });
        }

        const encodedProjectPath = session.project_path.replace(/[^a-zA-Z0-9-]/g, '-');
        const projectDirectory = path.join(
          dependencies.getHomeDirectory(),
          '.claude',
          'projects',
          encodedProjectPath,
        );
        sessionFilePath = path.join(projectDirectory, `${providerSessionId}.jsonl`);

        const relativePath = path.relative(path.resolve(projectDirectory), path.resolve(sessionFilePath));
        if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
          throw new AppError('Resolved session path is invalid.', {
            code: 'INVALID_SESSION_PATH',
            statusCode: 400,
          });
        }
      }

      if (!dependencies.fileExists(sessionFilePath)) {
        throw new AppError(`Session file for "${sessionId}" was not found.`, {
          code: 'SESSION_FILE_NOT_FOUND',
          statusCode: 404,
        });
      }

      const window = await dependencies.readTextFileWindow(
        sessionFilePath,
        CLAUDE_USAGE_TAIL_BYTES,
        CLAUDE_USAGE_HEAD_BYTES,
      );
      const scanned = readClaudeTokenUsage(
        window.tail,
        dependencies.getClaudeContextWindow(),
        window.head,
      );
      if (!window.truncated || scanned.foundUsage) {
        return scanned.result;
      }

      // 尾窗被截断且未扫到 usage（如末尾被超长工具结果行占据）：全量读取保正确性。
      const fileContent = await dependencies.readTextFile(sessionFilePath);
      return readClaudeTokenUsage(fileContent, dependencies.getClaudeContextWindow(), fileContent).result;
    },
  };
}

/**
 * Used by the provider routes to serve token usage from only an app session id.
 */
export const providerTokenUsageService = createProviderTokenUsageService();
