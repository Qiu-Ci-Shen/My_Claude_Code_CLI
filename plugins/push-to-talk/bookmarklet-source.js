
(() => {
'use strict';
const w = window;
if (w.__ccuiPtt) {
w.__ccuiPtt.destroy();
return;
}
const HOLD_MS = 250;
const TA_SELECTOR = 'textarea[data-slot="prompt-input-textarea"]';
let pressTimer = null;   // hold-detection timer
let holding = false;     // space physically down (our logic)
let recording = false;
let transcribing = false;
let recorder = null;
let mediaStream = null;
let chunks = [];
let cancelled = false;
let noticeTimer = null;
const bar = document.createElement('div');
bar.style.cssText =
'position:fixed;z-index:2147483647;right:18px;bottom:18px;display:none;' +
'align-items:center;gap:8px;padding:8px 14px;border-radius:10px;' +
'background:#18181b;color:#fafafa;font:13px/1.4 system-ui,sans-serif;' +
'box-shadow:0 6px 18px rgba(0,0,0,.35)';
const dot = document.createElement('span');
dot.style.cssText = 'width:10px;height:10px;border-radius:50%;background:#22c55e;flex:none';
const label = document.createElement('span');
bar.append(dot, label);
document.body.appendChild(bar);
const COLORS = { rec: '#ef4444', busy: '#f59e0b', ok: '#22c55e', err: '#ef4444' };
function show(text, mode) {
clearTimeout(noticeTimer);
dot.style.background = COLORS[mode] || COLORS.ok;
label.textContent = text;
bar.style.display = 'flex';
}
function hide() {
clearTimeout(noticeTimer);
bar.style.display = 'none';
}
function flash(text, mode, ms) {
show(text, mode);
clearTimeout(noticeTimer);
noticeTimer = setTimeout(hide, ms || 4000);
}
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
} catch {  }
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
async function transcribe(blob, ext) {
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
if (!res.ok) throw new Error('HTTP ' + res.status);
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
if (!res.ok) throw new Error('HTTP ' + res.status);
const data = await res.json();
return String((data && data.text) || '').trim();
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
w.HTMLTextAreaElement.prototype,
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
if (recording || transcribing) return;
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
mediaStream = stream;
recorder = rec;
chunks = [];
cancelled = false;
rec.ondataavailable = (e) => {
if (e.data && e.data.size > 0) chunks.push(e.data);
};
rec.onstop = onRecordStopped;
rec.start();
recording = true;
show('录音中… 松开空格结束，Esc 取消', 'rec');
}
function stopRecording(cancel) {
if (!recorder || recorder.state === 'inactive') return;
cancelled = Boolean(cancel);
try {
recorder.stop();
} catch {  }
}
async function onRecordStopped() {
recording = false;
if (mediaStream) {
mediaStream.getTracks().forEach((t) => t.stop());
mediaStream = null;
}
const rec = recorder;
recorder = null;
if (cancelled) {
chunks = [];
hide();
return;
}
const type = (rec && rec.mimeType) || 'audio/webm';
const blob = new Blob(chunks, { type });
chunks = [];
if (blob.size < 800) {
flash('录音太短，没听清', 'err');
return;
}
transcribing = true;
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
transcribing = false;
}
}
function activeTextarea() {
const el = w.document.activeElement;
return el && el.matches && el.matches(TA_SELECTOR) ? el : null;
}
function onKeyDown(e) {
if (e.key !== ' ' && e.code !== 'Space') return;
if (e.isComposing || e.keyCode === 229) return; // IME candidate selection
if (!activeTextarea()) return;                  // chat box focus only
if (recording) {
e.preventDefault();
e.stopPropagation();
return;
}
if (transcribing) {
if (holding) e.preventDefault();
return;
}
if (e.repeat) return;
holding = true;
e.preventDefault();
e.stopPropagation();
clearTimeout(pressTimer);
pressTimer = setTimeout(() => {
pressTimer = null;
startRecording();
}, HOLD_MS);
}
function onKeyUp(e) {
if (e.key !== ' ' && e.code !== 'Space') return;
if (!holding) return;
holding = false;
if (pressTimer) {
clearTimeout(pressTimer);
pressTimer = null;
const el = activeTextarea();
if (el) insertText(el, ' ');
return;
}
if (recording) stopRecording(false);
}
function onKeyDownEscape(e) {
if (e.key === 'Escape' && recording) {
holding = false;
clearTimeout(pressTimer);
pressTimer = null;
stopRecording(true);
flash('已取消', 'ok', 1500);
}
}
function onBlurWindow() {
if (pressTimer) {
clearTimeout(pressTimer);
pressTimer = null;
}
holding = false;
if (recording) stopRecording(true);
}
function destroy() {
clearTimeout(pressTimer);
pressTimer = null;
if (recording) stopRecording(true);
if (mediaStream) {
mediaStream.getTracks().forEach((t) => t.stop());
mediaStream = null;
}
recorder = null;
w.removeEventListener('keydown', onKeyDown, true);
w.removeEventListener('keyup', onKeyUp, true);
w.removeEventListener('keydown', onKeyDownEscape, true);
w.removeEventListener('blur', onBlurWindow);
bar.remove();
delete w.__ccuiPtt;
}
w.addEventListener('keydown', onKeyDown, true);
w.addEventListener('keyup', onKeyUp, true);
w.addEventListener('keydown', onKeyDownEscape, true);
w.addEventListener('blur', onBlurWindow);
w.__ccuiPtt = { destroy };
flash('长按空格说话 已开启（再点书签关闭）', 'ok', 3000);
})();
