import { useCallback, useEffect, useRef, useState } from 'react';

import { transcribeVoice } from '../../../lib/voiceApi';

// Mobile-safe recording: iOS Safari 18.4+ supports webm/opus; older iOS needs mp4.
const MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
  'audio/ogg;codecs=opus',
  'audio/ogg',
];

function pickMime(): string {
  for (const t of MIME_CANDIDATES) {
    try {
      if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(t)) return t;
    } catch {
      /* isTypeSupported can throw on some iOS versions */
    }
  }
  return '';
}

export type VoiceInputState = 'idle' | 'recording' | 'transcribing';

/**
 * Push-to-talk dictation. Records the mic, uploads to /api/voice/transcribe
 * (an OpenAI-compatible speech-to-text backend via the Express proxy), and
 * returns the transcript through onTranscript.
 */
export function useVoiceInput(
  onTranscript: (text: string, send?: boolean) => void,
  onError?: (msg: string) => void,
) {
  const [state, setState] = useState<VoiceInputState>('idle');
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const cancelledRef = useRef(false);
  const startingRef = useRef(false);
  const discardRef = useRef(false);
  // Whether the in-progress stop should auto-send the transcript (vs just fill the box).
  const sendRef = useRef(false);

  const stopTracks = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  };

  // 在途转写请求与取消标记；sessionRef 标识「这一次录音」，防止迟到的
  // onstop/finally 回调覆写新一次录音的状态。
  const abortRef = useRef<AbortController | null>(null);
  const abortedRef = useRef(false);
  const sessionRef = useRef(0);
  // 麦克风就绪（getUserMedia 返回）之前按键已松开/取消：标记本次手势作废，
  // 就绪后直接释放麦克风，防止「按住即放」这次录音无人停止、麦克风永久占用。
  const pendingStopRef = useRef(false);

  // Stop the mic if the component unmounts mid-recording.
  useEffect(() => {
    cancelledRef.current = false;
    return () => {
      cancelledRef.current = true;
      startingRef.current = false;
      abortRef.current?.abort();
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      recorderRef.current = null;
    };
  }, []);

  const start = useCallback(async () => {
    if (startingRef.current || (recorderRef.current && recorderRef.current.state !== 'inactive')) return;
    startingRef.current = true;
    abortedRef.current = false;
    pendingStopRef.current = false;
    const session = sessionRef.current + 1;
    sessionRef.current = session;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      if (cancelledRef.current) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      // 就绪前按键已松开或取消：这次手势作废（不开启录音器），麦克风立即释放。
      // 同一同步块内不会再有事件插入，查这一次就够。
      if (pendingStopRef.current) {
        pendingStopRef.current = false;
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      streamRef.current = stream;
      const mimeType = pickMime();
      const rec = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      recorderRef.current = rec;
      chunksRef.current = [];

      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      rec.onstop = async () => {
        stopTracks();
        if (cancelledRef.current || session !== sessionRef.current) return;
        // Capture and clear the stop intents for this stop before any async work.
        const shouldSend = sendRef.current;
        sendRef.current = false;
        const shouldDiscard = discardRef.current;
        discardRef.current = false;
        const type = rec.mimeType || 'audio/webm';
        const blob = new Blob(chunksRef.current, { type });
        chunksRef.current = [];
        if (shouldDiscard) {
          setState('idle');
          return;
        }
        // 松开按键后、onstop 到达前被 Esc/点击取消：丢弃本次转写
        if (abortedRef.current) {
          abortedRef.current = false;
          setState('idle');
          return;
        }
        if (blob.size < 800) {
          setState('idle');
          onError?.('Recording too short');
          return;
        }
        const abortController = new AbortController();
        abortRef.current = abortController;
        setState('transcribing');
        try {
          const ext = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm';
          const res = await transcribeVoice(blob, `recording.${ext}`, abortController.signal);
          if (cancelledRef.current || abortedRef.current || session !== sessionRef.current) return;
          if (!res.ok) throw new Error(`transcribe ${res.status}`);
          const data = await res.json();
          if (cancelledRef.current || abortedRef.current || session !== sessionRef.current) return;
          const text = String(data?.text || '').trim();
          if (text) onTranscript(text, shouldSend);
          else onError?.('No speech detected');
        } catch (e) {
          if (!cancelledRef.current && !abortedRef.current && session === sessionRef.current) {
            onError?.(`Transcription failed: ${e instanceof Error ? e.message : String(e)}`);
          }
        } finally {
          if (abortRef.current === abortController) abortRef.current = null;
          if (!cancelledRef.current && session === sessionRef.current) setState('idle');
        }
      };

      rec.start();
      setState('recording');
    } catch (e) {
      recorderRef.current = null;
      stopTracks();
      if (cancelledRef.current) return;
      const err = e as { name?: string; message?: string };
      let msg = `Mic error: ${err?.message || e}`;
      if (err?.name === 'NotAllowedError') msg = 'Microphone access denied.';
      else if (err?.name === 'NotFoundError') msg = 'No microphone found.';
      onError?.(msg);
      setState('idle');
    } finally {
      startingRef.current = false;
    }
  }, [onTranscript, onError]);

  // Stop recording. Pass { send: true } to auto-send the transcript once it's ready,
  // or { cancel: true } to discard the recording entirely (push-to-talk Esc/blur).
  // Guard on the recorder's own state (not React state) so a double tap, or the mic
  // and Send buttons both firing, can't call stop() on an already-inactive recorder.
  // 取消还覆盖「录音器已停但 onstop 未到」与「转写请求在途」两个窗口——那里
  // recorder.stop() 已无效，改为标记中止并掐掉在途 fetch。
  const stop = useCallback((opts?: { send?: boolean; cancel?: boolean }) => {
    const rec = recorderRef.current;
    if (rec && rec.state !== 'inactive') {
      sendRef.current = opts?.send ?? false;
      discardRef.current = opts?.cancel ?? false;
      rec.stop();
      return;
    }
    if (startingRef.current) {
      // getUserMedia 还没返回：本次手势作废（就绪后直接释放麦克风）
      pendingStopRef.current = true;
      return;
    }
    if (opts?.cancel) {
      abortedRef.current = true;
      abortRef.current?.abort();
      // 取消立即生效：不等在途请求 settle。转写请求进入响应体阶段后挂住时，
      // 只靠 abort 回调置 idle 会让界面一直停在「识别中」（2026-09-12）
      setState('idle');
    }
  }, []);

  const toggle = useCallback(() => {
    if (state === 'recording') stop();
    else if (state === 'transcribing') stop({ cancel: true });
    else start();
  }, [state, start, stop]);

  return { state, start, toggle, stop };
}
