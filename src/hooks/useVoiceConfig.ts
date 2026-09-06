import { useEffect, useState } from 'react';

/** 按住说话（push-to-talk）键位 */
export type PttKey = 'alt' | 'space' | 'ctrlm';

export const PTT_KEYS: PttKey[] = ['alt', 'space', 'ctrlm'];

export type VoiceConfig = {
  baseUrl: string;
  apiKey: string;
  sttModel: string;
  ttsModel: string;
  ttsVoice: string;
  ttsFormat: string;
  /** 按住说话开关（默认开，与原 push-to-talk 插件行为一致） */
  pttEnabled: boolean;
  /** 按住说话键位（默认左 Alt 全局） */
  pttKey: PttKey;
};

const STORAGE_KEY = 'voiceConfig';
export const VOICE_CONFIG_SYNC_EVENT = 'voice-config:sync';
const DEFAULTS: VoiceConfig = {
  baseUrl: '',
  apiKey: '',
  sttModel: '',
  ttsModel: '',
  ttsVoice: '',
  ttsFormat: '',
  pttEnabled: true,
  pttKey: 'alt',
};

export function readVoiceConfig(): VoiceConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ...DEFAULTS };
    const config = { ...DEFAULTS };
    for (const key of Object.keys(DEFAULTS) as (keyof VoiceConfig)[]) {
      const value = parsed[key];
      if (key === 'pttEnabled') {
        if (typeof value === 'boolean') config.pttEnabled = value;
      } else if (key === 'pttKey') {
        if (typeof value === 'string' && PTT_KEYS.includes(value as PttKey)) config.pttKey = value as PttKey;
      } else if (typeof value === 'string') {
        config[key] = value;
      }
    }
    return config;
  } catch {
    return { ...DEFAULTS };
  }
}

// Headers the voice proxy reads to target a per-user OpenAI-compatible backend.
// Empty fields are omitted so the server's env defaults apply.
export function voiceConfigHeaders(): Record<string, string> {
  if (typeof window === 'undefined') return {};
  const c = readVoiceConfig();
  const h: Record<string, string> = {};
  if (c.apiKey) h['x-voice-api-key'] = c.apiKey;
  if (c.sttModel) h['x-voice-stt-model'] = c.sttModel;
  if (c.ttsModel) h['x-voice-tts-model'] = c.ttsModel;
  if (c.ttsVoice) h['x-voice-tts-voice'] = c.ttsVoice;
  if (c.ttsFormat.trim()) h['x-voice-tts-format'] = c.ttsFormat.trim();
  return h;
}

export function useVoiceConfig() {
  const [config, setConfig] = useState<VoiceConfig>(() =>
    typeof window === 'undefined' ? { ...DEFAULTS } : readVoiceConfig(),
  );

  // 设置页（或任何消费方）更新后，其他挂载中的实例跟随刷新。
  useEffect(() => {
    const sync = () => setConfig(readVoiceConfig());
    window.addEventListener(VOICE_CONFIG_SYNC_EVENT, sync);
    return () => window.removeEventListener(VOICE_CONFIG_SYNC_EVENT, sync);
  }, []);

  const update = (patch: Partial<VoiceConfig>) => {
    setConfig((prev) => {
      const next = { ...prev, ...patch };
      try {
        const stored: Partial<VoiceConfig> = { ...next };
        if (next.ttsFormat.trim()) stored.ttsFormat = next.ttsFormat.trim();
        else delete stored.ttsFormat;
        localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
        window.dispatchEvent(new Event(VOICE_CONFIG_SYNC_EVENT));
      } catch {
        /* ignore persistence errors */
      }
      return next;
    });
  };

  return { config, update };
}
