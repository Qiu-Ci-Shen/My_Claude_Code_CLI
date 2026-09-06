import { useCallback, useEffect, useRef, useState } from 'react';

import { useTheme } from '../../../contexts/ThemeContext';
import { authenticatedFetch } from '../../../utils/api';
import { setNotificationSoundEnabled } from '../../../utils/notificationSound';
import { useProviderAuthStatus } from '../../provider-auth/hooks/useProviderAuthStatus';
import {
  DEFAULT_CODE_EDITOR_SETTINGS,
  DEFAULT_CURSOR_PERMISSIONS,
} from '../constants/constants';
import type {
  AgentProvider,
  ClaudePermissionsState,
  CodeEditorSettingsState,
  CodexPermissionMode,
  CursorPermissionsState,
  NotificationPreferencesState,
  ProjectSortOrder,
  SettingsMainTab,
} from '../types/types';

type ThemeContextValue = {
  isDarkMode: boolean;
  toggleDarkMode: () => void;
};

type UseSettingsControllerArgs = {
  isOpen: boolean;
  initialTab: string;
};

type ClaudeSettingsStorage = {
  allowedTools?: string[];
  disallowedTools?: string[];
  skipPermissions?: boolean;
  projectSortOrder?: ProjectSortOrder;
};

type CursorSettingsStorage = {
  allowedCommands?: string[];
  disallowedCommands?: string[];
  skipPermissions?: boolean;
};

type CodexSettingsStorage = {
  permissionMode?: CodexPermissionMode;
};

type NotificationPreferencesResponse = {
  success?: boolean;
  preferences?: NotificationPreferencesState;
};

type ActiveLoginProvider = AgentProvider | '';

const KNOWN_MAIN_TABS: SettingsMainTab[] = ['agents', 'appearance', 'git', 'api', 'tasks', 'browser', 'notifications', 'plugins', 'mobileAccess'];

const normalizeMainTab = (tab: string): SettingsMainTab => {
  // Keep backwards compatibility with older callers that still pass "tools".
  if (tab === 'tools') {
    return 'agents';
  }

  return KNOWN_MAIN_TABS.includes(tab as SettingsMainTab) ? (tab as SettingsMainTab) : 'agents';
};

const parseJson = <T>(value: string | null, fallback: T): T => {
  if (!value) {
    return fallback;
  }

  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};

const toCodexPermissionMode = (value: unknown): CodexPermissionMode => {
  if (value === 'acceptEdits' || value === 'bypassPermissions') {
    return value;
  }

  return 'default';
};

const readCodeEditorSettings = (): CodeEditorSettingsState => ({
  wordWrap: localStorage.getItem('codeEditorWordWrap') === 'true',
  showMinimap: localStorage.getItem('codeEditorShowMinimap') !== 'false',
  lineNumbers: localStorage.getItem('codeEditorLineNumbers') !== 'false',
  fontSize: localStorage.getItem('codeEditorFontSize') ?? DEFAULT_CODE_EDITOR_SETTINGS.fontSize,
});

const toResponseJson = async <T>(response: Response): Promise<T> => response.json() as Promise<T>;

const createEmptyClaudePermissions = (): ClaudePermissionsState => ({
  allowedTools: [],
  disallowedTools: [],
  skipPermissions: false,
});

const createEmptyCursorPermissions = (): CursorPermissionsState => ({
  ...DEFAULT_CURSOR_PERMISSIONS,
});

const createDefaultNotificationPreferences = (): NotificationPreferencesState => ({
  channels: {
    inApp: true,
    webPush: false,
    desktop: false,
    sound: true,
  },
  events: {
    actionRequired: true,
    stop: true,
    error: true,
  },
});

const normalizeNotificationPreferences = (
  preferences?: Partial<NotificationPreferencesState> | null,
): NotificationPreferencesState => {
  const defaults = createDefaultNotificationPreferences();

  return {
    channels: {
      inApp: preferences?.channels?.inApp ?? defaults.channels.inApp,
      webPush: preferences?.channels?.webPush ?? defaults.channels.webPush,
      desktop: preferences?.channels?.desktop ?? defaults.channels.desktop,
      sound: preferences?.channels?.sound ?? defaults.channels.sound,
    },
    events: {
      actionRequired: preferences?.events?.actionRequired ?? defaults.events.actionRequired,
      stop: preferences?.events?.stop ?? defaults.events.stop,
      error: preferences?.events?.error ?? defaults.events.error,
    },
  };
};

/**
 * 自动保存签名：列出 saveSettings 的全部输入，任一变化才触发落盘。
 */
function buildAutoSaveSignature(values: {
  allowedTools: string[];
  disallowedTools: string[];
  skipPermissions: boolean;
  projectSortOrder: ProjectSortOrder;
  cursorAllowed: string[];
  cursorDisallowed: string[];
  cursorSkip: boolean;
  codexMode: CodexPermissionMode;
  notificationPreferences: NotificationPreferencesState;
}): string {
  return JSON.stringify([
    values.allowedTools,
    values.disallowedTools,
    values.skipPermissions,
    values.projectSortOrder,
    values.cursorAllowed,
    values.cursorDisallowed,
    values.cursorSkip,
    values.codexMode,
    values.notificationPreferences,
  ]);
}

export function useSettingsController({ isOpen, initialTab }: UseSettingsControllerArgs) {
  const { isDarkMode, toggleDarkMode } = useTheme() as ThemeContextValue;
  const closeTimerRef = useRef<number | null>(null);

  const [activeTab, setActiveTab] = useState<SettingsMainTab>(() => normalizeMainTab(initialTab));
  const [saveStatus, setSaveStatus] = useState<'success' | 'error' | null>(null);
  const [projectSortOrder, setProjectSortOrder] = useState<ProjectSortOrder>('name');
  const [codeEditorSettings, setCodeEditorSettings] = useState<CodeEditorSettingsState>(() => (
    readCodeEditorSettings()
  ));

  const [claudePermissions, setClaudePermissions] = useState<ClaudePermissionsState>(() => (
    createEmptyClaudePermissions()
  ));
  const [cursorPermissions, setCursorPermissions] = useState<CursorPermissionsState>(() => (
    createEmptyCursorPermissions()
  ));
  const [notificationPreferences, setNotificationPreferences] = useState<NotificationPreferencesState>(() => (
    createDefaultNotificationPreferences()
  ));
  const [codexPermissionMode, setCodexPermissionMode] = useState<CodexPermissionMode>('default');
  // 自动保存签名：loadSettings 完成时登记，其后与签名不同的状态才触发保存
  const [loadedAutoSaveSignature, setLoadedAutoSaveSignature] = useState<string | null>(null);

  const [showLoginModal, setShowLoginModal] = useState(false);
  const [loginProvider, setLoginProvider] = useState<ActiveLoginProvider>('');
  const {
    providerAuthStatus,
    checkProviderAuthStatus,
    refreshProviderAuthStatuses,
  } = useProviderAuthStatus();

  const loadSettings = useCallback(async () => {
    const loaded = {
      allowedTools: [] as string[],
      disallowedTools: [] as string[],
      skipPermissions: false,
      projectSortOrder: 'name' as ProjectSortOrder,
      cursorAllowed: [] as string[],
      cursorDisallowed: [] as string[],
      cursorSkip: false,
      codexMode: 'default' as CodexPermissionMode,
      notificationPreferences: createDefaultNotificationPreferences(),
    };
    try {
      const savedClaudeSettings = parseJson<ClaudeSettingsStorage>(
        localStorage.getItem('claude-settings'),
        {},
      );
      loaded.allowedTools = savedClaudeSettings.allowedTools || [];
      loaded.disallowedTools = savedClaudeSettings.disallowedTools || [];
      loaded.skipPermissions = Boolean(savedClaudeSettings.skipPermissions);
      setClaudePermissions({
        allowedTools: loaded.allowedTools,
        disallowedTools: loaded.disallowedTools,
        skipPermissions: loaded.skipPermissions,
      });
      loaded.projectSortOrder = savedClaudeSettings.projectSortOrder === 'date' ? 'date' : 'name';
      setProjectSortOrder(loaded.projectSortOrder);

      const savedCursorSettings = parseJson<CursorSettingsStorage>(
        localStorage.getItem('cursor-tools-settings'),
        {},
      );
      loaded.cursorAllowed = savedCursorSettings.allowedCommands || [];
      loaded.cursorDisallowed = savedCursorSettings.disallowedCommands || [];
      loaded.cursorSkip = Boolean(savedCursorSettings.skipPermissions);
      setCursorPermissions({
        allowedCommands: loaded.cursorAllowed,
        disallowedCommands: loaded.cursorDisallowed,
        skipPermissions: loaded.cursorSkip,
      });

      const savedCodexSettings = parseJson<CodexSettingsStorage>(
        localStorage.getItem('codex-settings'),
        {},
      );
      loaded.codexMode = toCodexPermissionMode(savedCodexSettings.permissionMode);
      setCodexPermissionMode(loaded.codexMode);

      try {
        const notificationResponse = await authenticatedFetch('/api/settings/notification-preferences');
        // GET 失败/非 200：保留默认值并登记其签名——自动保存据此跳过，
        // 绝不把默认偏好回写覆盖服务端存储的真实偏好。
        if (notificationResponse.ok) {
          const notificationData = await toResponseJson<NotificationPreferencesResponse>(notificationResponse);
          if (notificationData.success && notificationData.preferences) {
            loaded.notificationPreferences = normalizeNotificationPreferences(notificationData.preferences);
          }
        }
        setNotificationPreferences(loaded.notificationPreferences);
      } catch {
        setNotificationPreferences(loaded.notificationPreferences);
      }

    } catch (error) {
      console.error('Error loading settings:', error);
      setClaudePermissions(createEmptyClaudePermissions());
      setCursorPermissions(createEmptyCursorPermissions());
      setNotificationPreferences(loaded.notificationPreferences);
      setCodexPermissionMode('default');
      setProjectSortOrder('name');
    }
    setLoadedAutoSaveSignature(buildAutoSaveSignature({
      allowedTools: loaded.allowedTools,
      disallowedTools: loaded.disallowedTools,
      skipPermissions: loaded.skipPermissions,
      projectSortOrder: loaded.projectSortOrder,
      cursorAllowed: loaded.cursorAllowed,
      cursorDisallowed: loaded.cursorDisallowed,
      cursorSkip: loaded.cursorSkip,
      codexMode: loaded.codexMode,
      notificationPreferences: loaded.notificationPreferences,
    }));
  }, []);

  const openLoginForProvider = useCallback((provider: AgentProvider) => {
    setLoginProvider(provider);
    setShowLoginModal(true);
  }, []);

  const handleLoginComplete = useCallback((exitCode: number) => {
    if (!loginProvider) {
      return;
    }

    void (async () => {
      const authStatus = await checkProviderAuthStatus(loginProvider);

      if (exitCode !== 0) {
        console.warn(`Login process exited with code ${exitCode}; refreshing auth status before setting save status.`);
      }

      setSaveStatus(authStatus.authenticated ? 'success' : 'error');
    })();
  }, [checkProviderAuthStatus, loginProvider]);

  const saveSettings = useCallback(async () => {
    setSaveStatus(null);

    try {
      const now = new Date().toISOString();
      localStorage.setItem('claude-settings', JSON.stringify({
        allowedTools: claudePermissions.allowedTools,
        disallowedTools: claudePermissions.disallowedTools,
        skipPermissions: claudePermissions.skipPermissions,
        projectSortOrder,
        lastUpdated: now,
      }));

      localStorage.setItem('cursor-tools-settings', JSON.stringify({
        allowedCommands: cursorPermissions.allowedCommands,
        disallowedCommands: cursorPermissions.disallowedCommands,
        skipPermissions: cursorPermissions.skipPermissions,
        lastUpdated: now,
      }));

      localStorage.setItem('codex-settings', JSON.stringify({
        permissionMode: codexPermissionMode,
        lastUpdated: now,
      }));

      const notificationResponse = await authenticatedFetch('/api/settings/notification-preferences', {
        method: 'PUT',
        body: JSON.stringify(notificationPreferences),
      });
      if (!notificationResponse.ok) {
        throw new Error('Failed to save notification preferences');
      }

      setSaveStatus('success');
    } catch (error) {
      console.error('Error saving settings:', error);
      setSaveStatus('error');
    }
  }, [
    claudePermissions.allowedTools,
    claudePermissions.disallowedTools,
    claudePermissions.skipPermissions,
    codexPermissionMode,
    cursorPermissions.allowedCommands,
    cursorPermissions.disallowedCommands,
    cursorPermissions.skipPermissions,
    notificationPreferences,
    projectSortOrder,
  ]);

  const updateCodeEditorSetting = useCallback(
    <K extends keyof CodeEditorSettingsState>(key: K, value: CodeEditorSettingsState[K]) => {
      setCodeEditorSettings((prev) => ({ ...prev, [key]: value }));
    },
    [],
  );

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    setActiveTab(normalizeMainTab(initialTab));
    void loadSettings();
    void refreshProviderAuthStatuses();
  }, [initialTab, isOpen, loadSettings, refreshProviderAuthStatuses]);

  useEffect(() => {
    setNotificationSoundEnabled(notificationPreferences.channels.sound);
  }, [notificationPreferences.channels.sound]);

  useEffect(() => {
    localStorage.setItem('codeEditorWordWrap', String(codeEditorSettings.wordWrap));
    localStorage.setItem('codeEditorShowMinimap', String(codeEditorSettings.showMinimap));
    localStorage.setItem('codeEditorLineNumbers', String(codeEditorSettings.lineNumbers));
    localStorage.setItem('codeEditorFontSize', codeEditorSettings.fontSize);
    window.dispatchEvent(new Event('codeEditorSettingsChanged'));
  }, [codeEditorSettings]);

  // Auto-save permissions and sort order with debounce.
  // 签名门控：loadSettings 完成前不保存；与已加载签名一致的渲染（含加载本身
  // 触发的渲染）跳过——修掉「初始守卫被首个 saveSettings 消耗」的伪保存。
  const autoSaveTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (loadedAutoSaveSignature === null) {
      return;
    }

    const currentSignature = buildAutoSaveSignature({
      allowedTools: claudePermissions.allowedTools,
      disallowedTools: claudePermissions.disallowedTools,
      skipPermissions: claudePermissions.skipPermissions,
      projectSortOrder,
      cursorAllowed: cursorPermissions.allowedCommands,
      cursorDisallowed: cursorPermissions.disallowedCommands,
      cursorSkip: cursorPermissions.skipPermissions,
      codexMode: codexPermissionMode,
      notificationPreferences,
    });
    if (currentSignature === loadedAutoSaveSignature) {
      return;
    }

    if (autoSaveTimerRef.current !== null) {
      window.clearTimeout(autoSaveTimerRef.current);
    }

    autoSaveTimerRef.current = window.setTimeout(() => {
      saveSettings();
    }, 500);

    return () => {
      if (autoSaveTimerRef.current !== null) {
        window.clearTimeout(autoSaveTimerRef.current);
      }
    };
  }, [
    loadedAutoSaveSignature,
    saveSettings,
    claudePermissions.allowedTools,
    claudePermissions.disallowedTools,
    claudePermissions.skipPermissions,
    projectSortOrder,
    cursorPermissions.allowedCommands,
    cursorPermissions.disallowedCommands,
    cursorPermissions.skipPermissions,
    codexPermissionMode,
    notificationPreferences,
  ]);

  const saveSettingsRef = useRef(saveSettings);
  saveSettingsRef.current = saveSettings;

  // Clear save status after 2 seconds
  useEffect(() => {
    if (saveStatus === null) {
      return;
    }

    const timer = window.setTimeout(() => setSaveStatus(null), 2000);
    return () => window.clearTimeout(timer);
  }, [saveStatus]);

  // 关闭设置对话框：待保存的防抖定时器立即冲刷（否则 500ms 内关窗丢最后一笔修改）
  useEffect(() => () => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    if (autoSaveTimerRef.current !== null) {
      window.clearTimeout(autoSaveTimerRef.current);
      autoSaveTimerRef.current = null;
      void saveSettingsRef.current();
    }
  }, []);

  return {
    activeTab,
    setActiveTab,
    isDarkMode,
    toggleDarkMode,
    saveStatus,
    projectSortOrder,
    setProjectSortOrder,
    codeEditorSettings,
    updateCodeEditorSetting,
    claudePermissions,
    setClaudePermissions,
    cursorPermissions,
    setCursorPermissions,
    notificationPreferences,
    setNotificationPreferences,
    codexPermissionMode,
    setCodexPermissionMode,
    providerAuthStatus,
    openLoginForProvider,
    showLoginModal,
    setShowLoginModal,
    loginProvider,
    handleLoginComplete,
  };
}
