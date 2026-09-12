#!/usr/bin/env node
// The MCP executable must load the root environment bootstrap before reading configuration.
// eslint-disable-next-line boundaries/no-unknown
import '../../load-env.js';

type JsonRpcRequest = {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
};

type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

const textResponse = (text: string) => ({
  content: [{ type: 'text', text }],
});

const jsonResponse = (value: unknown) => textResponse(JSON.stringify(value, null, 2));

const SCREENSHOT_DATA_URL_RE = /^data:(image\/[\w.+-]+);base64,(.+)$/s;

/**
 * Builds an MCP result for a Browser session payload. The screenshot data URL
 * is lifted out of the JSON text into a standard `image` content block so
 * clients can render the actual picture; leaving it inside the text JSON would
 * force every consumer to carry a multi-hundred-KB base64 blob as a string.
 *
 * @param options.captionOnly - Replaces the JSON metadata dump with a one-line
 *   human-readable caption and drops the visible page text. Screenshots answer
 *   "what does the page look like" — the raw session JSON and 25KB of page
 *   prose are `browser_snapshot`'s job, and in a chat card they just bury the
 *   picture.
 */
function imageResponse(value: unknown, options: { captionOnly?: boolean } = {}) {
  const root: Record<string, unknown> = typeof value === 'object' && value !== null
    ? { ...(value as Record<string, unknown>) }
    : {};

  let screenshotDataUrl: string | undefined;
  const takeScreenshot = (holder: Record<string, unknown>) => {
    if (typeof holder.screenshotDataUrl === 'string') {
      screenshotDataUrl = holder.screenshotDataUrl;
      delete holder.screenshotDataUrl;
    }
  };
  takeScreenshot(root);
  if (typeof root.session === 'object' && root.session !== null) {
    root.session = { ...(root.session as Record<string, unknown>) };
    takeScreenshot(root.session as Record<string, unknown>);
  }

  let summary: string;
  if (options.captionOnly) {
    delete root.text;
    const session = (typeof root.session === 'object' && root.session !== null
      ? root.session
      : root) as Record<string, unknown>;
    const url = typeof session.url === 'string' ? session.url : '';
    const title = typeof session.title === 'string' ? session.title.trim() : '';
    const clippedTitle = title.length > 100 ? `${title.slice(0, 100)}…` : title;
    summary = clippedTitle
      ? `Screenshot of "${clippedTitle}"${url ? ` — ${url}` : ''}`
      : url
        ? `Screenshot of ${url}`
        : 'Screenshot captured.';
  } else {
    summary = JSON.stringify(root, null, 2);
  }

  const content: Array<Record<string, unknown>> = [
    { type: 'text', text: summary },
  ];
  const match = screenshotDataUrl ? SCREENSHOT_DATA_URL_RE.exec(screenshotDataUrl) : null;
  if (match) {
    content.push({ type: 'image', data: match[2], mimeType: match[1] });
  }
  return { content };
}

const readString = (value: unknown, name: string): string => {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} is required.`);
  }
  return value.trim();
};

const readOptionalString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

const readNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const apiUrl = (process.env.QIU_BROWSER_USE_API_URL || 'http://127.0.0.1:3001/api/browser-use-mcp').replace(/\/$/, '');
const apiToken = process.env.QIU_BROWSER_USE_MCP_TOKEN || '';
const API_TIMEOUT_MS = Number.parseInt(process.env.QIU_BROWSER_USE_API_TIMEOUT_MS || '60000', 10);

async function callBrowserUseApi(toolName: string, input: Record<string, unknown>) {
  if (!apiToken) {
    throw new Error('QIU_BROWSER_USE_MCP_TOKEN is not configured.');
  }

  const response = await fetch(`${apiUrl}/tools/${encodeURIComponent(toolName)}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  const data = await response.json() as { success?: boolean; data?: unknown; error?: string };
  if (!response.ok || data.success === false) {
    throw new Error(data.error || `Browser API request failed (${response.status})`);
  }
  return data.data;
}

const sessionIdSchema = {
  type: 'object',
  properties: {
    sessionId: { type: 'string', description: 'Browser session id.' },
  },
  required: ['sessionId'],
};

const tools: ToolDefinition[] = [
  {
    name: 'browser_create_session',
    description: 'Create a temporary Browser session that the agent can control. Optionally provide a background profileName to reuse cookies and storage.',
    inputSchema: {
      type: 'object',
      properties: {
        profileName: { type: 'string', description: 'Optional background profile name for persistent browser storage.' },
      },
    },
  },
  {
    name: 'browser_list_sessions',
    description: 'List Browser sessions currently available to agents.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'browser_snapshot',
    description: 'Capture current page metadata, screenshot data URL, and visible body text for a Browser session.',
    inputSchema: sessionIdSchema,
  },
  {
    name: 'browser_take_screenshot',
    description: 'Capture the latest screenshot for a Browser session and return it as an image (no page text; use browser_snapshot when you also need the text).',
    inputSchema: sessionIdSchema,
  },
  {
    name: 'browser_navigate',
    description: 'Navigate a Browser session to an HTTP or HTTPS URL.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        url: { type: 'string' },
      },
      required: ['sessionId', 'url'],
    },
  },
  {
    name: 'browser_click',
    description: 'Click an element by CSS selector, visible text, or x/y coordinates.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        selector: { type: 'string' },
        text: { type: 'string' },
        x: { type: 'number' },
        y: { type: 'number' },
      },
      required: ['sessionId'],
    },
  },
  {
    name: 'browser_type',
    description: 'Type text into the focused page or fill a CSS selector. Set submit to press Enter after typing.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        selector: { type: 'string' },
        text: { type: 'string' },
        submit: { type: 'boolean' },
      },
      required: ['sessionId', 'text'],
    },
  },
  {
    name: 'browser_fill_form',
    description: 'Fill multiple form fields using CSS selectors.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        fields: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              selector: { type: 'string' },
              value: { type: 'string' },
            },
            required: ['selector', 'value'],
          },
        },
      },
      required: ['sessionId', 'fields'],
    },
  },
  {
    name: 'browser_press_key',
    description: 'Press a keyboard key, for example Enter, Escape, Tab, or Control+A.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        key: { type: 'string' },
      },
      required: ['sessionId', 'key'],
    },
  },
  {
    name: 'browser_select_option',
    description: 'Select option values in a select element found by CSS selector.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        selector: { type: 'string' },
        values: { type: 'array', items: { type: 'string' } },
      },
      required: ['sessionId', 'selector', 'values'],
    },
  },
  {
    name: 'browser_wait_for',
    description: 'Wait for visible text, a URL pattern, or a short timeout.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        text: { type: 'string' },
        url: { type: 'string' },
        timeoutMs: { type: 'number' },
      },
      required: ['sessionId'],
    },
  },
  {
    name: 'browser_tabs',
    description: 'List, open, select, or close tabs in a Browser session.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        action: { type: 'string', enum: ['list', 'new', 'select', 'close'] },
        index: { type: 'number' },
        url: { type: 'string' },
      },
      required: ['sessionId'],
    },
  },
  {
    name: 'browser_close_session',
    description: 'Stop a Browser session controlled by agents.',
    inputSchema: sessionIdSchema,
  },
];

async function callTool(name: string, args: Record<string, unknown>) {
  switch (name) {
    case 'browser_create_session':
      return jsonResponse(await callBrowserUseApi(name, {
        profileName: readOptionalString(args.profileName),
      }));
    case 'browser_list_sessions':
      return jsonResponse(await callBrowserUseApi(name, {}));
    case 'browser_snapshot':
      return imageResponse(await callBrowserUseApi(name, { sessionId: readString(args.sessionId, 'sessionId') }));
    case 'browser_take_screenshot': {
      return imageResponse(
        await callBrowserUseApi(name, { sessionId: readString(args.sessionId, 'sessionId') }),
        { captionOnly: true },
      );
    }
    case 'browser_navigate':
      return jsonResponse(await callBrowserUseApi(name, {
        sessionId: readString(args.sessionId, 'sessionId'),
        url: readString(args.url, 'url'),
      }));
    case 'browser_click':
      return jsonResponse(await callBrowserUseApi(name, {
        sessionId: readString(args.sessionId, 'sessionId'),
        selector: readOptionalString(args.selector),
        text: readOptionalString(args.text),
        x: readNumber(args.x),
        y: readNumber(args.y),
      }));
    case 'browser_type':
      return jsonResponse(await callBrowserUseApi(name, {
        sessionId: readString(args.sessionId, 'sessionId'),
        selector: readOptionalString(args.selector),
        text: readString(args.text, 'text'),
        submit: args.submit === true,
      }));
    case 'browser_fill_form': {
      const fields = Array.isArray(args.fields)
        ? args.fields.map((field) => {
          const record = field as Record<string, unknown>;
          return {
            selector: readString(record.selector, 'field.selector'),
            value: readString(record.value, 'field.value'),
          };
        })
        : [];
      return jsonResponse(await callBrowserUseApi(name, {
        sessionId: readString(args.sessionId, 'sessionId'),
        fields,
      }));
    }
    case 'browser_press_key':
      return jsonResponse(await callBrowserUseApi(name, {
        sessionId: readString(args.sessionId, 'sessionId'),
        key: readString(args.key, 'key'),
      }));
    case 'browser_select_option':
      return jsonResponse(await callBrowserUseApi(name, {
        sessionId: readString(args.sessionId, 'sessionId'),
        selector: readString(args.selector, 'selector'),
        values: Array.isArray(args.values) ? args.values.filter((value): value is string => typeof value === 'string') : [],
      }));
    case 'browser_wait_for':
      return jsonResponse(await callBrowserUseApi(name, {
        sessionId: readString(args.sessionId, 'sessionId'),
        text: readOptionalString(args.text),
        url: readOptionalString(args.url),
        timeoutMs: readNumber(args.timeoutMs),
      }));
    case 'browser_tabs':
      return jsonResponse(await callBrowserUseApi(name, {
        sessionId: readString(args.sessionId, 'sessionId'),
        action: args.action === 'new' || args.action === 'select' || args.action === 'close' || args.action === 'list'
          ? args.action
          : undefined,
        index: readNumber(args.index),
        url: readOptionalString(args.url),
      }));
    case 'browser_close_session':
      return jsonResponse(await callBrowserUseApi(name, { sessionId: readString(args.sessionId, 'sessionId') }));
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function handleMessage(message: JsonRpcRequest) {
  if (message.method === 'initialize') {
    return {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'qiu-browser', version: '1.0.0' },
    };
  }

  if (message.method === 'tools/list') {
    return { tools };
  }

  if (message.method === 'tools/call') {
    const params = message.params || {};
    const name = readString(params.name, 'name');
    const args = (params.arguments && typeof params.arguments === 'object'
      ? params.arguments
      : {}) as Record<string, unknown>;
    return callTool(name, args);
  }

  if (message.method.startsWith('notifications/')) {
    return undefined;
  }

  throw new Error(`Unsupported method: ${message.method}`);
}

function writeMessage(message: Record<string, unknown>) {
  // MCP stdio transport uses newline-delimited JSON (one JSON-RPC message per line,
  // no embedded newlines). This is NOT the LSP Content-Length framing.
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendResult(id: string | number | null | undefined, result: unknown) {
  if (id === undefined) {
    return;
  }
  writeMessage({ jsonrpc: '2.0', id, result });
}

function sendError(id: string | number | null | undefined, error: unknown) {
  if (id === undefined) {
    return;
  }
  writeMessage({
    jsonrpc: '2.0',
    id,
    error: {
      code: -32000,
      message: error instanceof Error ? error.message : String(error),
    },
  });
}

let buffer = '';

process.stdin.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let newlineIndex: number;
  while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
    const rawMessage = buffer.slice(0, newlineIndex).trim();
    buffer = buffer.slice(newlineIndex + 1);
    if (!rawMessage) {
      continue;
    }

    void (async () => {
      let request: JsonRpcRequest;
      try {
        request = JSON.parse(rawMessage) as JsonRpcRequest;
      } catch (error) {
        sendError(null, error);
        return;
      }
      try {
        const result = await handleMessage(request);
        sendResult(request.id, result);
      } catch (error) {
        sendError(request.id, error);
      }
    })();
  }
});
