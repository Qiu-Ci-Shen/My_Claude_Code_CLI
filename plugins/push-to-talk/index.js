/* ClaudeCodeUI 插件：长按 Alt 键说话（push-to-talk）
 *
 * 标准 ESM 插件：必须 export mount/unmount，PluginTabContent 通过动态 import
 * 加载后调用 mod.mount(container)。键盘监听挂在 window（capture 阶段），首次
 * mount 时绑定并用全局标志防重复；unmount 时刻意不移除监听——离开本标签页后
 * 在聊天界面长按 Alt 依然生效。彻底关闭 = 刷新页面。
 */

const HOLD_MS = 250;
const TA_SELECTOR = 'textarea[data-slot="prompt-input-textarea"]';
const COLORS = { rec: '#ef4444', busy: '#f59e0b', ok: '#22c55e', err: '#ef4444' };

// 跨模块实例的全局状态：标签页反复切换会产生新的模块实例，
// 只有挂到 window 上的状态才能在实例之间延续。
if (!window.__ccuiPtt) {
  window.__ccuiPtt = {
    listenersBound: false,
    holding: false,
    pressTimer: null,
    recording: false,
    transcribing: false,
    recorder: null,
    mediaStream: null,
    chunks: [],
    cancelled: false,
    bar: null,
    barDot: null,
    barLabel: null,
    noticeTimer: null,
  };
}
const S = window.__ccuiPtt;

// ---------- 角落提示条 ----------
function buildIndicator() {
  if (S.bar && S.bar.isConnected) return;
  const bar = document.createElement('div');
  bar.style.cssText =
    'position:fixed;z-index:2147483647;right:18px;bottom:18px;display:none;' +
    'align-items:center;gap:8px;padding:8px 14px;border-radius:10px;' +
    'background:#18181b;color:#fafafa;font:13px/1.4 system-ui,sans-serif;' +
    'box-shadow:0 6px 18px rgba(0,0,0,.35)';
  const dot = document.createElement('span');
  dot.style.cssText =
    'width:10px;height:10px;border-radius:50%;background:#22c55e;flex:none';
  const label = document.createElement('span');
  bar.append(dot, label);
  document.body.appendChild(bar);
  S.bar = bar;
  S.barDot = dot;
  S.barLabel = label;
}

function show(text, mode) {
  buildIndicator();
  clearTimeout(S.noticeTimer);
  S.barDot.style.background = COLORS[mode] || COLORS.ok;
  S.barLabel.textContent = text;
  S.bar.style.display = 'flex';
}
function hide() {
  clearTimeout(S.noticeTimer);
  if (S.bar) S.bar.style.display = 'none';
}
function flash(text, mode, ms) {
  buildIndicator();
  show(text, mode);
  clearTimeout(S.noticeTimer);
  S.noticeTimer = setTimeout(hide, ms || 4000);
}

// ---------- 录音与转写 ----------
const MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
  'audio/ogg;codecs=opus',
  'audio/ogg',
];
function pickMime() {
  for (const t of MIME_CANDIDATES) {
    try {
      if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(t)) return t;
    } catch { /* some iOS versions throw */ }
  }
  return '';
}

function readVoiceConfig() {
  try {
    const raw = localStorage.getItem('voiceConfig');
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

// 把上游返回的错误体拼进异常消息，避免只看到干巴巴的 "HTTP 503"
async function httpError(res) {
  let detail = '';
  try {
    const text = await res.text();
    try {
      const parsed = JSON.parse(text);
      detail = (parsed && (parsed.error || parsed.message)) || text;
    } catch {
      detail = text;
    }
  } catch {
    // 无响应体
  }
  detail = String(detail || '').replace(/\s+/g, ' ').trim().slice(0, 160);
  const err = new Error('HTTP ' + res.status + (detail ? ' - ' + detail : ''));
  err.status = res.status;
  return err;
}

async function transcribeOnce(blob, ext) {
  const cfg = readVoiceConfig();
  const baseUrl = typeof cfg.baseUrl === 'string' ? cfg.baseUrl.trim() : '';
  const filename = 'recording.' + ext;

  if (baseUrl) {
    const fd = new FormData();
    fd.append('file', blob, filename);
    fd.append('model', cfg.sttModel || 'whisper-1');
    const res = await fetch(baseUrl.replace(/\/$/, '') + '/audio/transcriptions', {
      method: 'POST',
      headers: cfg.apiKey ? { Authorization: 'Bearer ' + cfg.apiKey } : {},
      body: fd,
    });
    if (!res.ok) throw await httpError(res);
    const data = await res.json();
    return String((data && data.text) || '').trim();
  }

  const fd = new FormData();
  fd.append('audio', blob, filename);
  const headers = {};
  const token = localStorage.getItem('auth-token');
  if (token) headers.Authorization = 'Bearer ' + token;
  if (cfg.apiKey) headers['x-voice-api-key'] = cfg.apiKey;
  if (cfg.sttModel) headers['x-voice-stt-model'] = cfg.sttModel;
  const res = await fetch('/api/voice/transcribe', { method: 'POST', headers, body: fd });
  if (!res.ok) throw await httpError(res);
  const data = await res.json();
  return String((data && data.text) || '').trim();
}

async function transcribe(blob, ext) {
  // 429/5xx 基本都是识别服务瞬时过载，静默重试两次再报错
  const delays = [800, 2000];
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    if (attempt > 0) {
      show('识别服务繁忙，自动重试 ' + attempt + '/' + delays.length + '…', 'busy');
      await new Promise((resolve) => setTimeout(resolve, delays[attempt - 1]));
    }
    try {
      return await transcribeOnce(blob, ext);
    } catch (err) {
      const status = err && err.status;
      const retryable = status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
      if (!retryable || attempt === delays.length) throw err;
    }
  }
  throw new Error('unreachable');
}

function insertText(el, text) {
  el.focus();
  const start = el.selectionStart == null ? el.value.length : el.selectionStart;
  const end = el.selectionEnd == null ? el.value.length : el.selectionEnd;
  let done = false;
  try {
    el.setSelectionRange(start, end);
    done = document.execCommand('insertText', false, text);
  } catch {
    done = false;
  }
  if (!done) {
    const desc = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      'value'
    );
    if (desc && desc.set) {
      desc.set.call(el, el.value.slice(0, start) + text + el.value.slice(end));
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.setSelectionRange(start + text.length, start + text.length);
    }
  }
}

async function startRecording() {
  if (S.recording || S.transcribing) return;
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
    });
  } catch (err) {
    const name = err && err.name;
    if (name === 'NotAllowedError') flash('麦克风权限被拒绝', 'err');
    else if (name === 'NotFoundError') flash('未找到麦克风', 'err');
    else flash('麦克风错误: ' + ((err && err.message) || name || err), 'err');
    return;
  }
  const mime = pickMime();
  const rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
  S.mediaStream = stream;
  S.recorder = rec;
  S.chunks = [];
  S.cancelled = false;
  rec.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) S.chunks.push(e.data);
  };
  rec.onstop = onRecordStopped;
  rec.start();
  S.recording = true;
  show('正在录制… 松开左 Alt 结束，Esc 取消', 'rec');
}

function stopRecording(cancel) {
  if (!S.recorder || S.recorder.state === 'inactive') return;
  S.cancelled = Boolean(cancel);
  try {
    S.recorder.stop();
  } catch { /* already inactive */ }
}

async function onRecordStopped() {
  S.recording = false;
  if (S.mediaStream) {
    S.mediaStream.getTracks().forEach((t) => t.stop());
    S.mediaStream = null;
  }
  const rec = S.recorder;
  S.recorder = null;
  if (S.cancelled) {
    S.chunks = [];
    hide();
    return;
  }
  const type = (rec && rec.mimeType) || 'audio/webm';
  const blob = new Blob(S.chunks, { type });
  S.chunks = [];
  if (blob.size < 800) {
    flash('录音太短，没听清', 'err');
    return;
  }
  S.transcribing = true;
  show('识别中…', 'busy');
  const ext = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm';
  try {
    const text = await transcribe(blob, ext);
    if (!text) {
      flash('没有识别到语音', 'err');
      return;
    }
    const el = document.querySelector(TA_SELECTOR);
    if (!el) {
      flash('找不到聊天输入框', 'err');
      return;
    }
    insertText(el, text);
    hide();
  } catch (err) {
    flash('识别失败: ' + ((err && err.message) || err), 'err');
  } finally {
    S.transcribing = false;
  }
}

// ---------- 键盘处理 ----------
function activeTextarea() {
  const el = window.document.activeElement;
  return el && el.matches && el.matches(TA_SELECTOR) ? el : null;
}

// 焦点在别的可输入控件（搜索框、设置输入框等）时不抢焦点，
// 否则按住左 Alt 全局唤起聊天框。
function focusBlocked() {
  const el = window.document.activeElement;
  if (!el || el === document.body) return false;
  const tag = (el.tagName || '').toLowerCase();
  return tag === 'input' || tag === 'textarea' || el.isContentEditable;
}

function onKeyDown(e) {
  // 组合键保护：Alt 计时期间又按了别的键（Alt+Tab 切走 / Alt+C 等），
  // 放弃本次录音判定，让组合键正常工作。
  if (S.holding && S.pressTimer && e.code !== 'AltLeft') {
    clearTimeout(S.pressTimer);
    S.pressTimer = null;
    S.holding = false;
    return;
  }

  if (e.code !== 'AltLeft') return; // 只认左侧 Alt，右 Alt 不受影响
  if (e.isComposing || e.keyCode === 229) return;

  // 全局唤起：焦点不在聊天框且不在其他输入控件时，先聚焦聊天框再继续判定
  let target = activeTextarea();
  if (!target) {
    if (focusBlocked()) return;
    target = document.querySelector(TA_SELECTOR);
    if (!target) return;
    target.focus();
  }

  // 我们的按键还按着：吞掉 OS 自动重复，避免重复触发
  if (S.holding) {
    e.preventDefault();
    e.stopPropagation();
    return;
  }
  if (S.recording || S.transcribing) {
    e.preventDefault();
    e.stopPropagation();
    return;
  }
  if (e.repeat) return;

  S.holding = true;
  e.preventDefault();
  e.stopPropagation();
  clearTimeout(S.pressTimer);
  S.pressTimer = setTimeout(() => {
    S.pressTimer = null;
    startRecording();
  }, HOLD_MS);
}

function onKeyUp(e) {
  if (e.code !== 'AltLeft') return;
  if (!S.holding) return;
  S.holding = false;
  if (S.pressTimer) {
    // 未到阈值就松开 = 轻点了一下 Alt，无字符效果，直接忽略
    clearTimeout(S.pressTimer);
    S.pressTimer = null;
    return;
  }
  if (S.recording) stopRecording(false);
}

function onKeyDownEscape(e) {
  if (e.key === 'Escape' && S.recording) {
    S.holding = false;
    clearTimeout(S.pressTimer);
    S.pressTimer = null;
    stopRecording(true);
    flash('已取消', 'ok', 1500);
  }
}

function onBlurWindow() {
  if (S.pressTimer) {
    clearTimeout(S.pressTimer);
    S.pressTimer = null;
  }
  S.holding = false;
  if (S.recording) stopRecording(true);
}

function ensureGlobalListeners() {
  if (S.listenersBound) return;
  S.listenersBound = true;
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('keyup', onKeyUp, true);
  window.addEventListener('keydown', onKeyDownEscape, true);
  window.addEventListener('blur', onBlurWindow);
}

// ---------- 插件生命周期（claudecodeui 调用约定：export mount/unmount）----------
export async function mount(container) {
  ensureGlobalListeners();
  if (container) {
    container.innerHTML =
      '<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;' +
      'height:100%;gap:14px;font-family:system-ui,sans-serif;color:#a1a1aa;padding:24px;text-align:center">' +
      '<div style="font-size:42px">🎙️</div>' +
      '<div style="font-size:18px;font-weight:600;color:#e4e4e7">长按 Alt 键说话 已开启</div>' +
      '<div style="font-size:13.5px;line-height:2;max-width:520px">' +
      '到聊天界面：<b style="color:#e4e4e7">按住左侧 Alt</b> 开始说话 → <b style="color:#e4e4e7">松开</b> 自动识别填入<br>' +
      '无需先点输入框，任何位置按住左 Alt 都会自动聚焦聊天框（其他输入框内除外）<br>' +
      '轻点一下左 Alt 无任何效果 · 录音中按 Esc 取消<br>' +
      '切走本页后功能依然生效；彻底关闭请刷新页面' +
      '</div></div>';
  }
  buildIndicator();
  flash('长按 Alt 键说话 已开启', 'ok', 2500);
}

export function unmount(container) {
  // 监听器刻意保留：离开标签页后聊天界面的长按 Alt 继续可用。
  if (S.pressTimer) {
    clearTimeout(S.pressTimer);
    S.pressTimer = null;
  }
  S.holding = false;
  if (S.bar) {
    S.bar.remove();
    S.bar = null;
    S.barDot = null;
    S.barLabel = null;
  }
}
