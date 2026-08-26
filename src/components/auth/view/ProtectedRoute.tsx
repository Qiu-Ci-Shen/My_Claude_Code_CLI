import type { ReactNode } from 'react';

import { IS_PLATFORM } from '../../../shared/utils';
import { useAuth } from '../context/AuthContext';
import Onboarding from '../../onboarding/view/Onboarding';

import AuthLoadingScreen from './AuthLoadingScreen';
import LoginForm from './LoginForm';
import MobileLoginPage from './MobileLoginPage';
import SetupForm from './SetupForm';

type ProtectedRouteProps = {
  children: ReactNode;
};

/**
 * True when the current URL is the phone-login landing page. Read directly
 * from window.location because ProtectedRoute is mounted OUTSIDE the React
 * Router tree (it wraps <Router>), so useLocation() is not available here.
 * Tolerates a router basename prefix via endsWith.
 */
function isMobileLoginPath(): boolean {
  if (typeof window === 'undefined') return false;
  const path = window.location.pathname.replace(/\/+$/, '');
  return path === '/mobile-login' || path.endsWith('/mobile-login');
}

export default function ProtectedRoute({ children }: ProtectedRouteProps) {
  const { user, isLoading, needsSetup, hasCompletedOnboarding, refreshOnboardingStatus } = useAuth();

  // /mobile-login is a standalone page: it handles "already logged in" by
  // bouncing to '/', and "not logged in" by showing the PIN pad. It bypasses
  // the setup/onboarding branches on purpose — the desktop has to be set up
  // already for the QR code to exist.
  if (isMobileLoginPath()) {
    if (isLoading) {
      return <AuthLoadingScreen />;
    }
    if (user) {
      window.location.replace('/');
      return <AuthLoadingScreen />;
    }
    return <MobileLoginPage />;
  }

  if (isLoading) {
    return <AuthLoadingScreen />;
  }

  if (IS_PLATFORM) {
    if (!hasCompletedOnboarding) {
      return <Onboarding onComplete={refreshOnboardingStatus} />;
    }

    return <>{children}</>;
  }

  if (needsSetup) {
    return <SetupForm />;
  }

  if (!user) {
    return <LoginForm />;
  }

  if (!hasCompletedOnboarding) {
    return <Onboarding onComplete={refreshOnboardingStatus} />;
  }

  return <>{children}</>;
}
