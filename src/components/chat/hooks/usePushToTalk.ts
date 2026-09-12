import { useEffect, useRef } from 'react';

import type { PttKey } from '../../../hooks/useVoiceConfig';

import type { VoiceInputState } from './useVoiceInput';

const HOLD_MS = 250;
const COMPOSER_TEXTAREA_SELECTOR = 'textarea[data-slot="prompt-input-textarea"]';

type UsePushToTalkArgs = {
  enabled: boolean;
  binding: PttKey;
  /** useVoiceInput 的实时状态（ref 镜像，避免监听器反复重挂） */
  state: VoiceInputState;
  /** 长按达到阈值：开始录音 */
  onHoldStart: () => void;
  /** 松开按键：结束录音并转写填入 */
  onHoldRelease: () => void;
  /** Esc/失焦/组合键：取消本次录音（丢弃音频） */
  onHoldCancel: () => void;
  /** 空格键位下未到阈值的轻点：补发普通空格字符 */
  onTap: () => void;
  /** alt/ctrlm 键位下未聚焦聊天框：先唤起并聚焦输入框 */
  onActivateComposer: () => void;
};

function composerFocused(): boolean {
  const el = window.document.activeElement;
  return Boolean(el && el.matches(COMPOSER_TEXTAREA_SELECTOR));
}

/**
 * 按住说话（push-to-talk）键位层，行为自 plugins/push-to-talk 移植：
 *
 * - 左 Alt（默认）：全局生效，输入框未聚焦时先唤起；只认 AltLeft，右 Alt 不受影响；
 *   按住期间出现其他按键（Alt+Tab、Alt+C 等）→ 放弃本次。
 * - 空格：仅输入框聚焦时生效，长按录音、轻点仍是普通空格，拼音选字（IME）不受影响。
 * - Ctrl+M：全局生效的组合键。
 * - Esc 取消本次录音/转写；窗口失焦自动取消录音（含麦克风就绪前的按住）；录音中吞掉按键 repeat。
 */
export function usePushToTalk({
  enabled,
  binding,
  state,
  onHoldStart,
  onHoldRelease,
  onHoldCancel,
  onTap,
  onActivateComposer,
}: UsePushToTalkArgs): void {
  const holdingRef = useRef(false);
  const pressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const callbacksRef = useRef({ onHoldStart, onHoldRelease, onHoldCancel, onTap, onActivateComposer });
  callbacksRef.current = { onHoldStart, onHoldRelease, onHoldCancel, onTap, onActivateComposer };

  useEffect(() => {
    if (!enabled) return;

    const clearPressTimer = () => {
      if (pressTimerRef.current) {
        clearTimeout(pressTimerRef.current);
        pressTimerRef.current = null;
      }
    };

    const matchesBinding = (e: KeyboardEvent): boolean => {
      if (binding === 'alt') return e.code === 'AltLeft';
      if (binding === 'space') return e.key === ' ' || e.code === 'Space';
      return e.ctrlKey && !e.altKey && !e.metaKey && (e.key === 'm' || e.key === 'M' || e.code === 'KeyM');
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (!matchesBinding(e)) return;
      if (e.isComposing || e.keyCode === 229) return; // IME 组字/候选

      // 录音中：吞掉 repeat 与额外敲击
      if (stateRef.current === 'recording') {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (stateRef.current === 'transcribing') {
        // 转写中只拦住新的按压手势（防止开新一轮录音），不吞按键——
        // 原先的 preventDefault 会干扰 Alt 等键的正常使用（2026-09-10 事故）
        return;
      }
      if (e.repeat) return;

      // 空格键位只在输入框聚焦时接管；alt/ctrlm 全局生效
      if (binding === 'space' && !composerFocused()) return;

      holdingRef.current = true;
      if (binding === 'space') {
        // 接管空格字符：长按录音、轻点补空格
        e.preventDefault();
        e.stopPropagation();
      } else if (binding === 'ctrlm') {
        e.preventDefault();
        e.stopPropagation();
      } else if (!composerFocused()) {
        callbacksRef.current.onActivateComposer();
      }

      clearPressTimer();
      pressTimerRef.current = setTimeout(() => {
        pressTimerRef.current = null;
        callbacksRef.current.onHoldStart();
      }, HOLD_MS);
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (!matchesBinding(e)) return;
      if (!holdingRef.current) return;
      holdingRef.current = false;
      if (pressTimerRef.current) {
        // 未到阈值就松开：轻点一下
        clearPressTimer();
        if (binding === 'space') callbacksRef.current.onTap();
        return;
      }
      // 计时器已触发（onHoldStart 发出过）：无论 state 是否已翻到 recording
      // 都要把「松开」交给语音层——getUserMedia 可能仍在进行中，语音层需要
      // 记录作废标记，否则麦克风就绪后会悬着一个没人停止的录音（2026-09-10）
      callbacksRef.current.onHoldRelease();
    };

    // 组合键保护（alt/ctrlm 计时期间又按了别的键 → 放弃本次）
    const onAnyKeyDown = (e: KeyboardEvent) => {
      if (!holdingRef.current || !pressTimerRef.current) return;
      if (e.isComposing || e.keyCode === 229) return;
      if (matchesBinding(e) && e.repeat) return; // 自己的 repeat 不算
      if (!matchesBinding(e)) {
        clearPressTimer();
        holdingRef.current = false;
      }
    };

    const onEscKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // 录音中丢弃本次录音；转写中中止在途请求（两者都走 onHoldCancel）
      if (stateRef.current === 'idle') return;
      holdingRef.current = false;
      clearPressTimer();
      // 消费掉这次 Esc：浮条承诺「Esc 取消」的是本次识别，取消后事件止步于
      // 本层——下游（ChatInterface 全局 Esc 的打断/退出编辑）经 defaultPrevented
      // 让路，避免一次 Esc 既取消识别又退出编辑、把输入框恢复成空草稿（2026-09-12）
      e.preventDefault();
      callbacksRef.current.onHoldCancel();
    };

    const onBlurWindow = () => {
      clearPressTimer();
      const wasHolding = holdingRef.current;
      holdingRef.current = false;
      // 录音中失焦取消；按住中但 state 还没翻到 recording（getUserMedia 进行中）
      // 同样要取消，否则麦克风会在后台就绪、录音悬着没人停止
      if (stateRef.current === 'recording' || (wasHolding && stateRef.current === 'idle')) {
        callbacksRef.current.onHoldCancel();
      }
    };

    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('keydown', onAnyKeyDown, true);
    window.addEventListener('keydown', onEscKeyDown, true);
    window.addEventListener('blur', onBlurWindow);
    return () => {
      // 设置切换/组件卸载时放弃进行中的录音，避免麦克风静默常开
      if (stateRef.current === 'recording') {
        callbacksRef.current.onHoldCancel();
      }
      clearPressTimer();
      holdingRef.current = false;
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('keydown', onAnyKeyDown, true);
      window.removeEventListener('keydown', onEscKeyDown, true);
      window.removeEventListener('blur', onBlurWindow);
    };
  }, [enabled, binding]);
}
