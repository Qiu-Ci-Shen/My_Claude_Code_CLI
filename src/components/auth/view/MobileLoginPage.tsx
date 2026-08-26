import { useCallback, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Smartphone } from 'lucide-react';

import AuthErrorAlert from './AuthErrorAlert';
import AuthScreenLayout from './AuthScreenLayout';

const PIN_LENGTH = 6;

/**
 * 6-digit PIN login page, reached by scanning the LAN/tunnel QR code from the
 * Mobile Access settings tab. Skips username/password entry — the QR URL
 * already authenticates "I have physical access to the desktop screen", the
 * PIN proves "I am the owner, not a random internet scanner".
 *
 * On success the issued JWT is written to the same localStorage key the
 * regular login uses, and the page hard-redirects to '/' so the AuthContext
 * picks it up on a fresh mount.
 */
export default function MobileLoginPage() {
  const { t } = useTranslation('auth');
  const [pin, setPin] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setErrorMessage('');
      if (pin.length !== PIN_LENGTH) {
        setErrorMessage(t('mobileLogin.errors.pinLength', { length: PIN_LENGTH }));
        return;
      }
      setIsSubmitting(true);
      try {
        const res = await fetch('/api/mobile-access/pin-login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pin }),
        });
        const data = await res.json().catch(() => null);
        if (!res.ok) {
          const serverMessage = data?.error?.message;
          setErrorMessage(serverMessage || t('mobileLogin.errors.invalid'));
          setIsSubmitting(false);
          return;
        }
        if (data?.token) {
          localStorage.setItem('auth-token', data.token);
          // Hard navigation so AuthContext re-mounts and picks up the token.
          window.location.replace('/');
          return;
        }
        setErrorMessage(t('mobileLogin.errors.invalid'));
        setIsSubmitting(false);
      } catch {
        setErrorMessage(t('mobileLogin.errors.network'));
        setIsSubmitting(false);
      }
    },
    [pin, t],
  );

  return (
    <AuthScreenLayout
      title={t('mobileLogin.title')}
      description={t('mobileLogin.description')}
      footerText={t('mobileLogin.footer')}
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label htmlFor="mobile-pin" className="sr-only">
            {t('mobileLogin.pinLabel')}
          </label>
          <div className="relative">
            <Smartphone className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              id="mobile-pin"
              type="password"
              inputMode="numeric"
              pattern="\d{6}"
              maxLength={PIN_LENGTH}
              autoComplete="one-time-code"
              autoFocus
              disabled={isSubmitting}
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, PIN_LENGTH))}
              placeholder="••••••"
              className="w-full rounded-xl border border-border bg-background py-3 pl-10 pr-4 text-center font-mono text-2xl tracking-[0.5em] text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:opacity-60"
            />
          </div>
          <p className="mt-2 text-center text-xs text-muted-foreground">
            {t('mobileLogin.hint')}
          </p>
        </div>

        <AuthErrorAlert errorMessage={errorMessage} />

        <button
          type="submit"
          disabled={isSubmitting || pin.length !== PIN_LENGTH}
          className="flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2.5 font-medium text-primary-foreground shadow-lg shadow-primary/25 transition-all duration-200 hover:brightness-110 hover:shadow-primary/30 focus:outline-none focus:ring-2 focus:ring-primary/40 focus:ring-offset-2 focus:ring-offset-card active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isSubmitting ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              {t('mobileLogin.loading')}
            </>
          ) : (
            t('mobileLogin.submit')
          )}
        </button>
      </form>
    </AuthScreenLayout>
  );
}
