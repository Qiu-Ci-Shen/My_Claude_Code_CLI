import type { InputHTMLAttributes } from 'react';
import { useTranslation } from 'react-i18next';

import SettingsSection from '../SettingsSection';
import SettingsToggle from '../SettingsToggle';
import { useUiPreferences } from '../../../../hooks/useUiPreferences';
import { useVoiceConfig } from '../../../../hooks/useVoiceConfig';

const inputClass =
  'w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring';

function Field({ label, ...props }: { label: string } & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="block space-y-1">
      <span className="text-sm font-medium text-foreground">{label}</span>
      <input className={inputClass} {...props} />
    </label>
  );
}

export default function VoiceSettingsTab() {
  const { t } = useTranslation('settings');
  const { preferences, setPreference } = useUiPreferences();
  const { config, update } = useVoiceConfig();
  const voiceEnabled = preferences.voiceEnabled;

  return (
    <div className="space-y-8">
      <SettingsSection title={t('voiceSettings.title')} description={t('voiceSettings.description')}>
        <div className="flex items-center justify-between rounded-lg border border-border p-3">
          <div className="pr-3">
            <div className="text-sm font-medium text-foreground">{t('voiceSettings.enable')}</div>
            <div className="text-xs text-muted-foreground">{t('voiceSettings.enableDescription')}</div>
          </div>
          <SettingsToggle
            checked={voiceEnabled}
            onChange={(v) => setPreference('voiceEnabled', v)}
            ariaLabel={t('voiceSettings.enable')}
          />
        </div>
      </SettingsSection>

      {voiceEnabled && (
        <SettingsSection title={t('voiceSettings.backendTitle')} description={t('voiceSettings.backendDescription')}>
          <div className="space-y-4">
            <Field
              label={t('voiceSettings.baseUrl')}
              placeholder="https://api.openai.com/v1"
              value={config.baseUrl}
              onChange={(e) => update({ baseUrl: e.target.value })}
            />
            <Field
              label={t('voiceSettings.apiKey')}
              type="password"
              autoComplete="off"
              placeholder="sk-…"
              value={config.apiKey}
              onChange={(e) => update({ apiKey: e.target.value })}
            />
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
              <Field
                label={t('voiceSettings.sttModel')}
                placeholder="whisper-1"
                value={config.sttModel}
                onChange={(e) => update({ sttModel: e.target.value })}
              />
              <Field
                label={t('voiceSettings.ttsModel')}
                placeholder="tts-1"
                value={config.ttsModel}
                onChange={(e) => update({ ttsModel: e.target.value })}
              />
              <Field
                label={t('voiceSettings.voice')}
                placeholder="alloy"
                value={config.ttsVoice}
                onChange={(e) => update({ ttsVoice: e.target.value })}
              />
              <Field
                label={t('voiceSettings.format')}
                placeholder="mp3"
                value={config.ttsFormat}
                onChange={(e) => update({ ttsFormat: e.target.value })}
              />
            </div>
            <p className="text-xs text-muted-foreground">{t('voiceSettings.note')}</p>
          </div>
        </SettingsSection>
      )}

      {voiceEnabled && (
        <SettingsSection
          title={t('voiceSettings.pttTitle', { defaultValue: '按住说话 (Push-to-Talk)' })}
          description={t('voiceSettings.pttDescription', { defaultValue: '按住快捷键说话，松开自动识别并填入输入框；Esc 取消本次录音。' })}
        >
          <div className="space-y-4">
            <div className="flex items-center justify-between rounded-lg border border-border p-3">
              <div className="pr-3">
                <div className="text-sm font-medium text-foreground">
                  {t('voiceSettings.pttEnable', { defaultValue: '启用按住说话' })}
                </div>
                <div className="text-xs text-muted-foreground">
                  {t('voiceSettings.pttEnableDescription', { defaultValue: '默认键位为左 Alt（全局），输入框未聚焦时先唤起输入框' })}
                </div>
              </div>
              <SettingsToggle
                checked={config.pttEnabled}
                onChange={(v) => update({ pttEnabled: v })}
                ariaLabel={t('voiceSettings.pttEnable', { defaultValue: '启用按住说话' })}
              />
            </div>

            {config.pttEnabled && (
              <div className="space-y-2">
                <div className="text-sm font-medium text-foreground">
                  {t('voiceSettings.pttKey', { defaultValue: '触发键位' })}
                </div>
                <div className="flex flex-wrap gap-2">
                  {([
                    ['alt', '左 Alt（全局）'],
                    ['space', '空格长按（输入框内）'],
                    ['ctrlm', 'Ctrl+M（全局）'],
                  ] as const).map(([key, label]) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => update({ pttKey: key })}
                      className={`rounded-lg border px-3 py-1.5 text-sm transition-colors ${
                        config.pttKey === key
                          ? 'border-primary bg-primary/10 text-foreground'
                          : 'border-border text-muted-foreground hover:bg-accent hover:text-accent-foreground'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </SettingsSection>
      )}
    </div>
  );
}
