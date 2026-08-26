import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Copy, ExternalLink, Globe, Loader2, RefreshCw, Smartphone, Wifi } from 'lucide-react';

import SettingsSection from '../SettingsSection';
import { Button } from '../../../../shared/view/ui';

type MobileAccessStatus = {
  uiPort: number | null;
  lanUrl: string | null;
  lanQr: string | null;
  lanCandidates: string[];
  lanIpOverride: string;
  tunnelRunning: boolean;
  tunnelUrl: string | null;
  tunnelQr: string | null;
  tunnelState: { phase: string; detail: string; startedAt: number | null };
  pin: string;
};

const authHeaders = (): Record<string, string> => {
  const token = localStorage.getItem('auth-token');
  return token ? { Authorization: `Bearer ${token}` } : {};
};

const inputClass =
  'w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring';

export default function MobileAccessTab() {
  const { t } = useTranslation('settings');
  const [status, setStatus] = useState<MobileAccessStatus | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ipInput, setIpInput] = useState('');
  const [pinInput, setPinInput] = useState('');
  const [pinSaving, setPinSaving] = useState(false);
  const [pinCopied, setPinCopied] = useState(false);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/mobile-access/status', { headers: authHeaders() });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data?.success && data.status) {
        setStatus(data.status);
        setError(null);
      }
    } catch (err) {
      setError((err as Error)?.message ?? String(err));
    }
  }, []);

  useEffect(() => {
    void fetchStatus();
    // Poll while the tab is open so tunnel phase transitions show up live.
    const timer = window.setInterval(() => void fetchStatus(), 3000);
    return () => window.clearInterval(timer);
  }, [fetchStatus]);

  // Hydrate the inputs only when the SERVER value actually changes — depending
  // on the whole `status` object would re-fire every 3s poll (new reference)
  // and clobber whatever the user is typing.
  const serverLanIpOverride = status?.lanIpOverride;
  const serverPin = status?.pin;
  useEffect(() => {
    setIpInput(serverLanIpOverride || '');
  }, [serverLanIpOverride]);
  useEffect(() => {
    setPinInput(serverPin || '');
  }, [serverPin]);

  const startTunnel = async () => {
    setStarting(true);
    setError(null);
    try {
      const res = await fetch('/api/mobile-access/tunnel/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(data?.error?.message ?? `HTTP ${res.status}`);
      }
      if (data?.status) setStatus(data.status);
    } catch (err) {
      setError((err as Error)?.message ?? String(err));
    } finally {
      setStarting(false);
    }
  };

  const stopTunnel = async () => {
    try {
      await fetch('/api/mobile-access/tunnel/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
      });
      await fetchStatus();
    } catch (err) {
      setError((err as Error)?.message ?? String(err));
    }
  };

  const saveIpOverride = async () => {
    try {
      const res = await fetch('/api/mobile-access/lan-ip-override', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ ip: ipInput }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error?.message ?? `HTTP ${res.status}`);
      await fetchStatus();
    } catch (err) {
      setError((err as Error)?.message ?? String(err));
    }
  };

  const savePin = async () => {
    if (!/^\d{6}$/.test(pinInput)) {
      setError(t('mobileAccess.pinInvalid'));
      return;
    }
    setPinSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/mobile-access/pin', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ pin: pinInput }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error?.message ?? `HTTP ${res.status}`);
      await fetchStatus();
    } catch (err) {
      setError((err as Error)?.message ?? String(err));
    } finally {
      setPinSaving(false);
    }
  };

  const regeneratePin = async () => {
    setPinSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/mobile-access/pin/regenerate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error?.message ?? `HTTP ${res.status}`);
      if (data?.pin) setPinInput(data.pin);
      await fetchStatus();
    } catch (err) {
      setError((err as Error)?.message ?? String(err));
    } finally {
      setPinSaving(false);
    }
  };

  const copyPin = async () => {
    if (!status?.pin) return;
    try {
      await navigator.clipboard.writeText(status.pin);
      setPinCopied(true);
      window.setTimeout(() => setPinCopied(false), 1500);
    } catch {
      // Clipboard API may be unavailable in insecure contexts — ignore.
    }
  };

  const tunnelBusy = starting || ['downloading', 'starting', 'registering'].includes(status?.tunnelState.phase ?? '');

  return (
    <div className="space-y-8">
      {/* LAN section */}
      <SettingsSection
        title={t('mobileAccess.lanTitle')}
        description={t('mobileAccess.lanDescription')}
      >
        {status?.lanUrl ? (
          <div className="flex flex-col items-start gap-4 rounded-lg border border-border p-4 sm:flex-row sm:items-center">
            {status.lanQr && (
              <img
                src={status.lanQr}
                alt={t('mobileAccess.lanQrAlt')}
                className="h-[176px] w-[176px] flex-shrink-0 rounded-md border border-border bg-white p-1"
              />
            )}
            <div className="min-w-0 space-y-3">
              <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                <Wifi className="h-4 w-4 flex-shrink-0" />
                {t('mobileAccess.scanHint')}
              </div>
              <div className="break-all font-mono text-xs text-muted-foreground">{status.lanUrl}</div>
              <a
                href={status.lanUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-sm text-blue-600 hover:underline dark:text-blue-400"
              >
                {t('mobileAccess.openInBrowser')}
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
            </div>
          </div>
        ) : (
          <div className="rounded-lg border border-border p-4 text-sm text-muted-foreground">
            {t('mobileAccess.lanUnavailable')}
          </div>
        )}

        <div className="space-y-2 rounded-lg border border-border p-4">
          <label htmlFor="lan-ip-override" className="text-sm font-medium text-foreground">
            {t('mobileAccess.lanIpLabel')}
          </label>
          <div className="flex gap-2">
            <select
              aria-label={t('mobileAccess.lanIpLabel')}
              className={inputClass}
              value={ipInput}
              onChange={(e) => setIpInput(e.target.value)}
            >
              <option value="">{t('mobileAccess.autoDetect')}</option>
              {(status?.lanCandidates ?? []).map((ip) => (
                <option key={ip} value={ip}>{ip}</option>
              ))}
              {ipInput && !(status?.lanCandidates ?? []).includes(ipInput) && (
                <option value={ipInput}>{ipInput}</option>
              )}
            </select>
            <Button variant="outline" size="sm" onClick={() => void saveIpOverride()}>
              {t('mobileAccess.save')}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">{t('mobileAccess.lanIpHint')}</p>
        </div>
      </SettingsSection>

      {/* PIN section — the 6-digit code phone users enter after scanning either QR */}
      <SettingsSection
        title={t('mobileAccess.pinTitle')}
        description={t('mobileAccess.pinDescription')}
      >
        <div className="space-y-3 rounded-lg border border-border p-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <div className="flex flex-1 items-center gap-2">
              <input
                aria-label={t('mobileAccess.pinLabel')}
                type="text"
                inputMode="numeric"
                maxLength={6}
                className={`${inputClass} font-mono text-lg tracking-[0.4em]`}
                value={pinInput}
                onChange={(e) => setPinInput(e.target.value.replace(/\D/g, '').slice(0, 6))}
              />
              <Button
                variant="outline"
                size="sm"
                onClick={() => void copyPin()}
                disabled={!status?.pin}
                title={t('mobileAccess.pinCopy')}
              >
                <Copy className="h-4 w-4" />
                {pinCopied ? t('mobileAccess.pinCopied') : t('mobileAccess.pinCopy')}
              </Button>
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => void regeneratePin()}
                disabled={pinSaving}
              >
                {pinSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                {t('mobileAccess.pinRegenerate')}
              </Button>
              <Button
                size="sm"
                onClick={() => void savePin()}
                disabled={pinSaving || !/^\d{6}$/.test(pinInput) || pinInput === status?.pin}
              >
                {t('mobileAccess.pinSave')}
              </Button>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">{t('mobileAccess.pinHint')}</p>
        </div>
      </SettingsSection>

      {/* Public tunnel section */}
      <SettingsSection
        title={t('mobileAccess.tunnelTitle')}
        description={t('mobileAccess.tunnelDescription')}
      >
        <div className="rounded-lg border border-border p-4">
          {status?.tunnelRunning && status.tunnelUrl ? (
            <div className="flex flex-col items-start gap-4 sm:flex-row sm:items-center">
              {status.tunnelQr && (
                <img
                  src={status.tunnelQr}
                  alt={t('mobileAccess.tunnelQrAlt')}
                  className="h-[176px] w-[176px] flex-shrink-0 rounded-md border border-border bg-white p-1"
                />
              )}
              <div className="min-w-0 space-y-3">
                <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                  <Globe className="h-4 w-4 flex-shrink-0" />
                  {t('mobileAccess.tunnelActive')}
                </div>
                <div className="break-all font-mono text-xs text-muted-foreground">{status.tunnelUrl}</div>
                <a
                  href={status.tunnelUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-sm text-blue-600 hover:underline dark:text-blue-400"
                >
                  {t('mobileAccess.openInBrowser')}
                  <ExternalLink className="h-3.5 w-3.5" />
                </a>
                <div>
                  <Button variant="destructive" size="sm" onClick={() => void stopTunnel()}>
                    {t('mobileAccess.stopTunnel')}
                  </Button>
                </div>
              </div>
            </div>
          ) : status && tunnelBusy ? (
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-sm text-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                {status.tunnelState.detail || t('mobileAccess.tunnelStarting')}
              </div>
              <p className="text-xs text-muted-foreground">{t('mobileAccess.tunnelStartingHint')}</p>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Smartphone className="h-4 w-4" />
                {t('mobileAccess.tunnelIdle')}
              </div>
              <Button size="sm" onClick={() => void startTunnel()} disabled={!status}>
                <Globe className="mr-2 h-4 w-4" />
                {t('mobileAccess.startTunnel')}
              </Button>
            </div>
          )}
        </div>

        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-xs leading-relaxed text-foreground">
          <p className="font-medium">{t('mobileAccess.securityTitle')}</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-4 text-muted-foreground">
            <li>{t('mobileAccess.securityItem1')}</li>
            <li>{t('mobileAccess.securityItem2')}</li>
            <li>{t('mobileAccess.securityItem3')}</li>
          </ul>
        </div>

        {status?.tunnelState.phase === 'error' && status.tunnelState.detail && !error && (
          <p className="text-sm text-red-600 dark:text-red-400">{status.tunnelState.detail}</p>
        )}
      </SettingsSection>

      {error && (
        <div className="flex items-start justify-between gap-3 rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-sm text-foreground">
          <span>{error}</span>
          <button
            type="button"
            aria-label={t('mobileAccess.retry')}
            onClick={() => { setError(null); void fetchStatus(); }}
            className="text-muted-foreground hover:text-foreground"
          >
            <RefreshCw className="h-4 w-4" />
          </button>
        </div>
      )}
    </div>
  );
}
