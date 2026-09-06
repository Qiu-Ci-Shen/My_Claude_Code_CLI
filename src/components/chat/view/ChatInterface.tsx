import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowDownIcon } from 'lucide-react';

import { useTasksSettings } from '../../../contexts/TasksSettingsContext';
import { useWebSocket } from '../../../contexts/WebSocketContext';
import PermissionContext from '../../../contexts/PermissionContext';
import type { ChatInterfaceProps, ChatMessage, PermissionMode, Provider  } from '../types/types';
import { useChatProviderState } from '../hooks/useChatProviderState';
import { useChatSessionState } from '../hooks/useChatSessionState';
import { useChatRealtimeHandlers } from '../hooks/useChatRealtimeHandlers';
import { isSessionAbortSuppressed } from '../hooks/abort-suppression';
import { useChatComposerState } from '../hooks/useChatComposerState';
import { useSessionStore } from '../../../stores/useSessionStore';
import { rewindExecute, type EditMessageTarget } from '../../../lib/rewindRpc';

import ChatMessagesPane from './subcomponents/ChatMessagesPane';
import ChatMessageRail from './subcomponents/ChatMessageRail';
import ChatComposer from './subcomponents/ChatComposer';
import ContextUsageBar from './subcomponents/ContextUsageBar';
import CommandResultModal from './subcomponents/CommandResultModal';

function ChatInterface({
  isActive,
  selectedProject,
  selectedSession,
  ws,
  sendMessage,
  onFileOpen,
  onInputFocusChange,
  onSessionProcessing,
  onSessionIdle,
  processingSessions,
  onNavigateToSession,
  onSessionEstablished,
  onShowSettings,
  showRawParameters,
  showThinking,
  sendByCtrlEnter,
  externalMessageUpdate,
  newSessionTrigger,
  onShowAllTasks,
}: ChatInterfaceProps) {
  const { tasksEnabled, isTaskMasterInstalled } = useTasksSettings();
  const { subscribe } = useWebSocket();
  const { t } = useTranslation('chat');

  const sessionStore = useSessionStore();
  const streamTimerRef = useRef<number | null>(null);
  const accumulatedStreamRef = useRef('');
  // When each session's `chat.subscribe` was last sent; idle acks older than
  // a later local request are discarded as stale.
  const statusCheckSentAtRef = useRef(new Map<string, number>());
  // Highest live `seq` observed per session. Written by the realtime handler
  // on every sequenced frame, read whenever a `chat.subscribe` is sent so the
  // server replays only the events this client actually missed.
  const lastSeqRef = useRef(new Map<string, number>());

  const resetStreamingState = useCallback(() => {
    if (streamTimerRef.current) {
      clearTimeout(streamTimerRef.current);
      streamTimerRef.current = null;
    }
    accumulatedStreamRef.current = '';
  }, []);

  const {
    provider,
    setProvider,
    cursorModel,
    setCursorModel,
    claudeModel,
    setClaudeModel,
    codexModel,
    setCodexModel,
    currentProviderEffort,
    currentProviderEffortOptions,
    currentProviderModel,
    currentProviderModelOptions,
    opencodeModel,
    setOpenCodeModel,
    permissionMode,
    pendingPermissionRequests,
    setPendingPermissionRequests,
    availablePermissionModes,
    selectPermissionMode,
    cyclePermissionMode,
    providerModelCatalog,
    providerModelsLoading,
    providerModelActions,
    selectProviderModel,
    selectProviderEffort,
    resolvePermissionModeForProvider,
  } = useChatProviderState({
    selectedSession,
    selectedProject,
  });

  // 编辑模式（ZCode 同款）：✎ 选中的消息载入底部输入框，回车=截断重发
  const [editTarget, setEditTarget] = useState<EditMessageTarget | null>(null);

  const {
    chatMessages,
    addMessage,
    sessionActivity,
    isProcessing,
    canAbortSession,
    currentSessionId,
    setCurrentSessionId,
    isLoadingSessionMessages,
    isLoadingMoreMessages,
    hasMoreMessages,
    totalMessages,
    isUserScrolledUp,
    setIsUserScrolledUp,
    tokenBudget,
    setTokenBudget,
    visibleMessageCount,
    visibleMessages,
    loadEarlierMessages,
    loadAllMessages,
    allMessagesLoaded,
    isLoadingAllMessages,
    loadAllJustFinished,
    showLoadAllOverlay,
    createDiff,
    scrollContainerRef,
    scrollToBottom,
    scrollToBottomAndReset,
    handleScroll,
    requestLatestMessages,
  } = useChatSessionState({
    isActive,
    selectedProject,
    selectedSession,
    ws,
    sendMessage,
    externalMessageUpdate,
    newSessionTrigger,
    processingSessions,
    onSessionIdle,
    resetStreamingState,
    statusCheckSentAtRef,
    lastSeqRef,
    sessionStore,
  });

  // Brand-new conversation: the composer allocated a stable session id via
  // the session gateway before the first send. Record it locally and put it
  // in the URL — this id never changes again, so there is no later handoff.
  const handleSessionEstablished = useCallback<NonNullable<ChatInterfaceProps['onSessionEstablished']>>((sessionId, context) => {
    setCurrentSessionId(sessionId);
    onSessionEstablished?.(sessionId, context);
    onNavigateToSession?.(sessionId);
  }, [setCurrentSessionId, onSessionEstablished, onNavigateToSession]);

  const {
    input,
    setInput,
    textareaRef,
    inputHighlightRef,
    isTextareaExpanded,
    slashCommandsCount,
    filteredCommands,
    frequentCommands,
    commandQuery,
    showCommandMenu,
    selectedCommandIndex,
    resetCommandMenuState,
    handleCommandSelect,
    handleToggleCommandMenu,
    showFileDropdown,
    filteredFiles,
    selectedFileIndex,
    renderInputWithMentions,
    selectFile,
    attachedFiles,
    setAttachedFiles,
    uploadingFiles,
    fileErrors,
    getRootProps,
    getInputProps,
    isDragActive,
    openAttachmentPicker,
    handleSubmit,
    queuedDraft,
    editQueuedDraft,
    deleteQueuedDraft,
    handleVoiceTranscript,
    handleInputChange,
    handleKeyDown,
    handlePaste,
    handleTextareaClick,
    handleTextareaInput,
    syncInputOverlayScroll,
    handleClearInput,
    handleAbortSession,
    handlePermissionDecision,
    handleGrantToolPermission,
    handleInputFocusChange,
    isInputFocused,
    commandModalPayload,
    closeCommandModal,
  } = useChatComposerState({
    selectedProject,
    selectedSession,
    currentSessionId,
    provider,
    permissionMode,
    cyclePermissionMode,
    currentProviderModel,
    currentProviderEffort,
    isLoading: isProcessing,
    onTruncateCompleted: (sid) => {
      // 编辑重发截断后：清槽重建视图，更早轮次从服务端静默回填
      sessionStore.resetSlot(sid);
      void requestLatestMessages(sid, true);
    },
    processingSessions,
    canAbortSession,
    tokenBudget,
    sendMessage,
    sendByCtrlEnter,
    onSessionProcessing,
    onSessionEstablished: handleSessionEstablished,
    onInputFocusChange,
    onFileOpen,
    onShowSettings,
    scrollToBottom,
    editTarget,
    onClearEditTarget: useCallback(() => setEditTarget(null), []),
    addMessage,
    setIsUserScrolledUp,
    setPendingPermissionRequests,
    resolvePermissionModeForProvider,
  });

  // On WebSocket reconnect, request a bounded persisted-tail sync (deferred
  // while Chat is hidden), then re-subscribe — the
  // `chat_subscribed` ack restores or clears the activity indicator, replays
  // missed live events, and re-attaches a still-running stream to this socket.
  const handleWebSocketReconnect = useCallback(async () => {
    if (!selectedProject || !selectedSession) return;
    // Post-abort suppression: skip the transcript tail sync (the interrupted
    // turn was flushed to disk in full and must not resurface), but keep
    // subscribing so live events still flow after the reconnect.
    if (!isSessionAbortSuppressed(selectedSession.id)) {
      await requestLatestMessages(selectedSession.id, isActive);
    }
    statusCheckSentAtRef.current.set(selectedSession.id, Date.now());
    sendMessage({
      type: 'chat.subscribe',
      sessions: [{
        sessionId: selectedSession.id,
        lastSeq: lastSeqRef.current.get(selectedSession.id) ?? 0,
      }],
    });
  }, [isActive, requestLatestMessages, selectedProject, selectedSession, sendMessage]);

  useChatRealtimeHandlers({
    isActive,
    subscribe,
    provider,
    selectedSession,
    currentSessionId,
    setTokenBudget,
    pendingPermissionRequests,
    setPendingPermissionRequests,
    streamTimerRef,
    accumulatedStreamRef,
    lastSeqRef,
    statusCheckSentAtRef,
    onSessionProcessing,
    onSessionIdle,
    onWebSocketReconnect: handleWebSocketReconnect,
    requestLatestMessages,
    sessionStore,
  });

  useEffect(() => {
    if (!canAbortSession && !editTarget) {
      return;
    }

    const handleGlobalEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.repeat || event.defaultPrevented) {
        return;
      }

      event.preventDefault();
      // 生成中优先打断；空闲时 Esc 退出编辑模式
      if (canAbortSession) {
        handleAbortSession();
      } else {
        setEditTarget(null);
      }
    };

    document.addEventListener('keydown', handleGlobalEscape, { capture: true });
    return () => {
      document.removeEventListener('keydown', handleGlobalEscape, { capture: true });
    };
  }, [canAbortSession, handleAbortSession, editTarget]);

  // ── Rewind（⟲ 回退到此消息之前）─────────────────────────────────────
  const [rewindTarget, setRewindTarget] = useState<ChatMessage | null>(null);
  const [rewindRunning, setRewindRunning] = useState(false);
  const [rewindNotice, setRewindNotice] = useState<{ text: string; isError: boolean } | null>(null);
  const rewindNoticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showRewindNotice = useCallback((text: string, isError = false) => {
    setRewindNotice({ text, isError });
    if (rewindNoticeTimerRef.current) clearTimeout(rewindNoticeTimerRef.current);
    rewindNoticeTimerRef.current = setTimeout(() => setRewindNotice(null), 4000);
  }, []);
  useEffect(() => () => {
    if (rewindNoticeTimerRef.current) clearTimeout(rewindNoticeTimerRef.current);
  }, []);

  const handleRewindMessage = useCallback((message: ChatMessage) => {
    if (!(currentSessionId || selectedSession?.id)) {
      showRewindNotice('当前是新会话，还没有可回退的历史。', true);
      return;
    }
    setRewindTarget(message);
  }, [currentSessionId, selectedSession?.id, showRewindNotice]);

  const handleRewindConfirm = useCallback(async () => {
    const message = rewindTarget;
    if (!message || rewindRunning) return;
    const sessionId = currentSessionId || selectedSession?.id || null;
    if (!sessionId) return;

    setRewindRunning(true);
    try {
      showRewindNotice('正在回退…');
      // 单次请求完成「定位（含时间戳兜底：消息未落盘时按时刻清残留）+ 回退」
      const result = await rewindExecute(sessionId, undefined, true, {
        timestamp: message.timestamp,
        textPrefix: String(message.content || '').trim().slice(0, 50),
      });
      if (!result.ok) throw new Error(result.error || 'rewind failed');

      const parts = [`已丢弃 ${result.truncated?.dropped ?? 0} 条记录`];
      if (result.files?.restored.length) parts.push(`恢复 ${result.files.restored.length} 个文件`);
      if (result.files?.removed.length) parts.push(`移除 ${result.files.removed.length} 个新建文件`);
      if (result.files?.errors.length) parts.push(`错误 ${result.files.errors.length} 个`);
      showRewindNotice(`回退完成：${parts.join('，')}`);

      setRewindTarget(null);
      // 转录已被截断：缓存页与实时行整体作废，清槽后从服务端权威转录重取
      sessionStore.resetSlot(sessionId);
      await requestLatestMessages(sessionId);
    } catch (err) {
      showRewindNotice(`回退失败：${err instanceof Error ? err.message : String(err)}`, true);
    } finally {
      setRewindRunning(false);
    }
  }, [rewindTarget, rewindRunning, currentSessionId, selectedSession?.id, sessionStore, requestLatestMessages, showRewindNotice]);

  // Esc 关闭回退确认框（录音/运行中不关）
  useEffect(() => {
    if (!rewindTarget) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !rewindRunning) setRewindTarget(null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [rewindTarget, rewindRunning]);

  useEffect(() => {
    return () => {
      resetStreamingState();
    };
  }, [resetStreamingState]);

  const permissionContextValue = useMemo(() => ({
    pendingPermissionRequests,
    handlePermissionDecision,
  }), [pendingPermissionRequests, handlePermissionDecision]);

  // A composer pick becomes the default for new chats and, when a session is
  // open, is recorded against that session so reopening it restores this model.
  const handleSelectComposerModel = useCallback(async (model: string) => {
    try {
      await selectProviderModel(provider, model, currentSessionId || selectedSession?.id || null);
    } catch (error) {
      console.error('Error changing the active session model:', error);
    }
  }, [currentSessionId, provider, selectProviderModel, selectedSession?.id]);

  const handleSelectComposerEffort = useCallback(async (effort: string) => {
    try {
      await selectProviderEffort(provider, effort, currentSessionId || selectedSession?.id || null);
    } catch (error) {
      console.error('Error changing the active session reasoning effort:', error);
    }
  }, [currentSessionId, provider, selectProviderEffort, selectedSession?.id]);

  // Mirrors ChatComposer's own visibility check so the message pane can
  // reserve enough bottom space to keep the floating status tab from
  // overlapping the last message.
  const hasActivityIndicator = Boolean(sessionActivity && pendingPermissionRequests.length === 0);

  const selectedProviderLabel =
    provider === 'cursor'
      ? t('messageTypes.cursor')
      : provider === 'codex'
        ? t('messageTypes.codex')
        : provider === 'opencode'
            ? t('messageTypes.opencode', { defaultValue: 'OpenCode' })
          : t('messageTypes.claude');

  if (!selectedProject) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center text-muted-foreground">
          <p className="text-sm">
            {t('projectSelection.startChatWithProvider', {
              provider: selectedProviderLabel,
              defaultValue: 'Select a project to start chatting with {{provider}}',
            })}
          </p>
        </div>
      </div>
    );
  }

  return (
    <PermissionContext.Provider value={permissionContextValue}>
      <div className="flex h-full min-h-0 flex-col">
        <div className="relative flex min-h-0 flex-1 flex-col">
          <ChatMessagesPane
          scrollContainerRef={scrollContainerRef}
          onWheel={handleScroll}
          onTouchMove={handleScroll}
          isLoadingSessionMessages={isLoadingSessionMessages}
          isProcessing={isProcessing}
          hasActivityIndicator={hasActivityIndicator}
          chatMessages={chatMessages}
          selectedSession={selectedSession}
          currentSessionId={currentSessionId}
          provider={provider}
          setProvider={(nextProvider) => setProvider(nextProvider as Provider)}
          textareaRef={textareaRef}
          claudeModel={claudeModel}
          setClaudeModel={setClaudeModel}
          cursorModel={cursorModel}
          setCursorModel={setCursorModel}
          codexModel={codexModel}
          setCodexModel={setCodexModel}
          opencodeModel={opencodeModel}
          setOpenCodeModel={setOpenCodeModel}
          providerModelCatalog={providerModelCatalog}
          providerModelActions={providerModelActions}
          providerModelsLoading={providerModelsLoading}
          tasksEnabled={tasksEnabled}
          isTaskMasterInstalled={isTaskMasterInstalled}
          onShowAllTasks={onShowAllTasks}
          setInput={setInput}
          isLoadingMoreMessages={isLoadingMoreMessages}
          hasMoreMessages={hasMoreMessages}
          totalMessages={totalMessages}
          sessionMessagesCount={chatMessages.length}
          visibleMessageCount={visibleMessageCount}
          visibleMessages={visibleMessages}
          loadEarlierMessages={loadEarlierMessages}
          loadAllMessages={loadAllMessages}
          allMessagesLoaded={allMessagesLoaded}
          isLoadingAllMessages={isLoadingAllMessages}
          loadAllJustFinished={loadAllJustFinished}
          showLoadAllOverlay={showLoadAllOverlay}
          createDiff={createDiff}
          onFileOpen={onFileOpen}
          onShowSettings={onShowSettings}
          onGrantToolPermission={handleGrantToolPermission}
          showRawParameters={showRawParameters}
          showThinking={showThinking}
          selectedProject={selectedProject}
          onEditMessage={(message) => setEditTarget({
            sessionId: currentSessionId || selectedSession?.id || null,
            timestamp: message.timestamp,
            content: String(message.content || ''),
          })}
          onRewindMessage={handleRewindMessage}
        />
          <ChatMessageRail containerRef={scrollContainerRef} messages={visibleMessages} />
          {/* 编辑模式指示：聊天界面顶部居中的浮动胶囊 */}
          {editTarget && (
            <div className="pointer-events-none absolute left-1/2 top-2 z-30 -translate-x-1/2">
              <div className="flex items-center gap-2 rounded-full border border-primary/40 bg-popover px-3 py-1 text-xs text-foreground shadow-md">
                <span>正在编辑消息，Esc 取消</span>
                <button
                  type="button"
                  onClick={() => setEditTarget(null)}
                  aria-label="取消编辑"
                  className="pointer-events-auto rounded px-1 text-muted-foreground transition-colors hover:text-foreground"
                >
                  ✕
                </button>
              </div>
            </div>
          )}

          {/* ⟲ 回退确认对话框 */}
          {rewindTarget && (
            <div
              className="fixed inset-0 z-[100] flex items-center justify-center bg-black/45 backdrop-blur-[2px]"
              onClick={() => { if (!rewindRunning) setRewindTarget(null); }}
            >
              <div
                className="w-[min(420px,90vw)] rounded-2xl border border-border bg-popover p-6 text-popover-foreground shadow-2xl"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="mb-3 text-[15.5px] font-semibold text-foreground">回退到此消息之前？</div>
                <ul className="mb-5 list-disc space-y-1 pl-5 text-[13px] leading-relaxed text-muted-foreground">
                  <li>此消息及之后的所有对话将被删除</li>
                  <li>代码/文件将恢复到该消息执行前的状态（如有快照）</li>
                </ul>
                <div className="flex justify-end gap-2.5">
                  <button
                    type="button"
                    disabled={rewindRunning}
                    onClick={() => setRewindTarget(null)}
                    className="rounded-lg border border-border px-4 py-1.5 text-[13px] text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    disabled={rewindRunning}
                    onClick={handleRewindConfirm}
                    className="rounded-lg bg-primary px-4 py-1.5 text-[13px] text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
                  >
                    {rewindRunning ? '回退中…' : '确定回退'}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* 回退结果通知 */}
          {rewindNotice && (
            <div
              className={`fixed left-1/2 top-4 z-[101] -translate-x-1/2 rounded-xl px-4 py-2.5 text-[13px] shadow-lg ${
                rewindNotice.isError
                  ? 'bg-destructive text-destructive-foreground'
                  : 'border border-border bg-popover text-popover-foreground'
              }`}
            >
              {rewindNotice.text}
            </div>
          )}
        </div>

        <div className="relative flex-shrink-0">
          {isUserScrolledUp && chatMessages.length > 0 && (
            <div className="pointer-events-none absolute -top-11 left-0 right-0 z-20 flex justify-center">
              <button
                type="button"
                onClick={scrollToBottomAndReset}
                aria-label={t('input.scrollToBottom', { defaultValue: 'Scroll to bottom' })}
                className="pointer-events-auto flex h-8 w-8 items-center justify-center rounded-full border border-border/50 bg-card text-muted-foreground shadow-sm transition-all duration-200 hover:bg-accent hover:text-foreground"
                title={t('input.scrollToBottom', { defaultValue: 'Scroll to bottom' })}
              >
                <ArrowDownIcon className="h-4 w-4" aria-hidden />
              </button>
            </div>
          )}

          <ChatComposer
          pendingPermissionRequests={pendingPermissionRequests}
          handlePermissionDecision={handlePermissionDecision}
          handleGrantToolPermission={handleGrantToolPermission}
          activity={sessionActivity}
          isLoading={isProcessing}
          onAbortSession={handleAbortSession}
          permissionMode={permissionMode}
          availablePermissionModes={availablePermissionModes}
          onSelectPermissionMode={(mode) => selectPermissionMode(mode as PermissionMode)}
          providerLabel={selectedProviderLabel}
          effort={currentProviderEffort}
          availableEffortOptions={currentProviderEffortOptions}
          onSelectEffort={handleSelectComposerEffort}
          model={currentProviderModel}
          availableModelOptions={currentProviderModelOptions}
          onSelectModel={handleSelectComposerModel}
          modelsLoading={providerModelsLoading}
          slashCommandsCount={slashCommandsCount}
          onToggleCommandMenu={handleToggleCommandMenu}
          hasInput={Boolean(input.trim())}
          onClearInput={handleClearInput}
          onSubmit={handleSubmit}
          isDragActive={isDragActive}
          queuedDraft={queuedDraft}
          onEditQueuedDraft={editQueuedDraft}
          onDeleteQueuedDraft={deleteQueuedDraft}
          attachedFiles={attachedFiles}
          onRemoveAttachment={(index) =>
            setAttachedFiles((previous) =>
              previous.filter((_, currentIndex) => currentIndex !== index),
            )
          }
          uploadingFiles={uploadingFiles}
          fileErrors={fileErrors}
          showFileDropdown={showFileDropdown}
          filteredFiles={filteredFiles}
          selectedFileIndex={selectedFileIndex}
          onSelectFile={selectFile}
          filteredCommands={filteredCommands}
          selectedCommandIndex={selectedCommandIndex}
          onCommandSelect={handleCommandSelect}
          onCloseCommandMenu={resetCommandMenuState}
          isCommandMenuOpen={showCommandMenu}
          frequentCommands={commandQuery ? [] : frequentCommands}
          getRootProps={getRootProps as (...args: unknown[]) => Record<string, unknown>}
          getInputProps={getInputProps as (...args: unknown[]) => Record<string, unknown>}
          openAttachmentPicker={openAttachmentPicker}
          inputHighlightRef={inputHighlightRef}
          renderInputWithMentions={renderInputWithMentions}
          textareaRef={textareaRef}
          input={input}
          onVoiceTranscript={handleVoiceTranscript}
          onInputChange={handleInputChange}
          onTextareaClick={handleTextareaClick}
          onTextareaKeyDown={handleKeyDown}
          onTextareaPaste={handlePaste}
          onTextareaScrollSync={syncInputOverlayScroll}
          onTextareaInput={handleTextareaInput}
          isInputFocused={isInputFocused}
          onInputFocusChange={handleInputFocusChange}
          placeholder={t('input.placeholder', { provider: selectedProviderLabel })}
          isTextareaExpanded={isTextareaExpanded}
          sendByCtrlEnter={sendByCtrlEnter}
        />

        <ContextUsageBar tokenBudget={tokenBudget} />
        </div>
      </div>

      <CommandResultModal
        payload={commandModalPayload}
        onClose={closeCommandModal}
        providerModelCatalog={providerModelCatalog}
        providerModelActions={providerModelActions}
        activeProvider={provider}
        activeProviderModel={currentProviderModel}
        currentSessionId={currentSessionId || selectedSession?.id || null}
        onSelectProviderModel={selectProviderModel}
      />
    </PermissionContext.Provider>
  );
}

export default React.memo(ChatInterface);
