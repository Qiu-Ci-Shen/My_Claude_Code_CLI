/**
 * Claude Rewind 插件前端
 * ======================
 * 职责：在聊天界面的每条「用户消息」气泡旁注入 ⟲ 回退按钮。
 *
 * 工作方式：
 *   - MutationObserver 监听 .chat-message.user 节点出现（React 重渲染也覆盖）
 *   - 按钮读取气泡所在 .chat-message 的 data-message-timestamp + 文本前缀
 *   - 点击弹确认框 → 调插件后端 /locate 精确定位 uuid → /rewind 执行截断+文件恢复
 *   - 完成后刷新页面消息（location.reload 最简单可靠）
 */

const RPC_BASE = '/api/plugins/claude-rewind/rpc';

// 从页面 URL 提取 app session id（路由 /session/<id>，根路径时为 null=新会话）
function currentSessionId() {
  const m = window.location.pathname.match(/\/session\/([^/?#]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

async function rpc(method, path, body) {
  const token = localStorage.getItem('auth-token');
  const res = await fetch(`${RPC_BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) throw new Error(`RPC ${path} failed: ${res.status}`);
  return res.json();
}

function showToast(msg, isError) {
  const bar = document.createElement('div');
  bar.style.cssText =
    'position:fixed;z-index:2147483647;left:50%;top:18px;transform:translateX(-50%);' +
    'padding:10px 18px;border-radius:10px;' +
    `background:hsl(var(--destructive));color:hsl(var(--destructive-foreground));` +
    'font:13px/1.4 system-ui,sans-serif;box-shadow:0 6px 18px rgba(0,0,0,.35)';
  bar.textContent = msg;
  document.body.appendChild(bar);
  setTimeout(() => bar.remove(), 4000);
}

// ---------- 界面内居中确认模态窗 ----------
// 全部使用应用的主题 token（hsl(var(--…))），自动适配明暗两套主题
// 返回 Promise<boolean>：确定=true，取消/Esc/点遮罩=false
function showConfirmDialog(title, lines) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.style.cssText =
      'position:fixed;inset:0;z-index:2147483646;display:flex;align-items:center;justify-content:center;' +
      'background:rgba(0,0,0,.45);backdrop-filter:blur(2px)';

    const card = document.createElement('div');
    card.style.cssText =
      'width:min(420px,90vw);padding:22px 24px;border-radius:14px;' +
      'background:hsl(var(--popover));color:hsl(var(--popover-foreground));' +
      'border:1px solid hsl(var(--border));' +
      'box-shadow:0 12px 40px rgba(0,0,0,.18);font-family:system-ui,sans-serif';

    const heading = document.createElement('div');
    heading.textContent = title;
    heading.style.cssText =
      'font-size:15.5px;font-weight:600;margin-bottom:12px;color:hsl(var(--foreground))';

    const list = document.createElement('ul');
    list.style.cssText =
      'margin:0 0 18px;padding-left:18px;font-size:13px;line-height:1.9;color:hsl(var(--muted-foreground))';
    for (const line of lines) {
      const li = document.createElement('li');
      li.textContent = line;
      list.appendChild(li);
    }

    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;justify-content:flex-end;gap:10px';

    const mkBtn = (label, primary) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.style.cssText =
        'padding:7px 18px;border-radius:8px;font-size:13px;cursor:pointer;' +
        (primary
          ? 'background:hsl(var(--primary));color:hsl(var(--primary-foreground));border:1px solid transparent'
          : 'background:transparent;color:hsl(var(--muted-foreground));border:1px solid hsl(var(--border))');
      b.addEventListener('mouseenter', () => {
        b.style.background = primary ? 'hsl(var(--primary) / 0.9)' : 'hsl(var(--accent))';
        b.style.color = primary ? 'hsl(var(--primary-foreground))' : 'hsl(var(--accent-foreground))';
      });
      b.addEventListener('mouseleave', () => {
        b.style.background = primary ? 'hsl(var(--primary))' : 'transparent';
        b.style.color = primary ? 'hsl(var(--primary-foreground))' : 'hsl(var(--muted-foreground))';
      });
      return b;
    };
    const cancelBtn = mkBtn('取消', false);
    const okBtn = mkBtn('确定回退', true);

    const close = (confirmed) => {
      overlay.remove();
      window.removeEventListener('keydown', onKey, true);
      resolve(confirmed);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); close(false); }
    };

    cancelBtn.addEventListener('click', () => close(false));
    okBtn.addEventListener('click', () => close(true));
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close(false);
    });
    window.addEventListener('keydown', onKey, true);

    btnRow.append(cancelBtn, okBtn);
    card.append(heading, list, btnRow);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    okBtn.focus();
  });
}

async function handleRewindClick(messageEl, bubbleEl) {
  const sessionId = currentSessionId();
  if (!sessionId) {
    showToast('当前是新会话，还没有可回退的历史。', true);
    return;
  }

  const timestamp = messageEl.getAttribute('data-message-timestamp') || '';
  const textPrefix = (bubbleEl.textContent || '').trim().slice(0, 50);
  if (!timestamp) {
    showToast('无法识别该消息（缺少时间戳标记）。', true);
    return;
  }

  // 取消/Esc/点遮罩都不执行回退
  const confirmed = await showConfirmDialog('回退到此消息之前？', [
    '此消息及之后的所有对话将被删除',
    '代码/文件将恢复到该消息执行前的状态（如有快照）',
    '确定后页面会自动刷新',
  ]);
  if (!confirmed) return;

  try {
    showToast('正在定位消息…');
    const locate = await rpc('POST', '/locate', { sessionId, timestamp, textPrefix });
    if (!locate.found) throw new Error('转录中找不到这条消息');

    const result = await rpc('POST', '/rewind', {
      sessionId,
      targetUuid: locate.uuid,
      restoreFiles: true,
    });
    if (!result.ok) throw new Error(result.error || 'rewind failed');

    const parts = [`已丢弃 ${result.truncated.dropped} 条记录`];
    if (result.files.restored.length) parts.push(`恢复 ${result.files.restored.length} 个文件`);
    if (result.files.removed.length) parts.push(`移除 ${result.files.removed.length} 个新建文件`);
    if (result.files.errors.length) parts.push(`错误 ${result.files.errors.length} 个`);

    showToast(`回退完成：${parts.join('，')}。刷新页面…`);
    setTimeout(() => window.location.reload(), 1200);
  } catch (err) {
    showToast(`回退失败：${err.message}`, true);
  }
}

// ---------- 注入按钮 ----------
const BTN_ID = 'claude-rewind-btn';

function injectButton(messageEl) {
  if (messageEl.querySelector(`.${BTN_ID}`)) return;
  // 只处理用户消息；气泡是 .group 圆角块
  if (!messageEl.classList.contains('user')) return;
  const bubble = messageEl.querySelector('.group.rounded-2xl');
  if (!bubble) return;

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = BTN_ID;
  btn.title = '回到此消息之前（rewind）';
  // 回退图标：逆时针箭头 + 转回起点的小竖线，与「刷新」（顺时针循环箭头）区分
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '13');
  svg.setAttribute('height', '13');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2.2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  arrow.setAttribute('d', 'M9 14 4 9l5-5');
  const curve = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  curve.setAttribute('d', 'M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5v0a5.5 5.5 0 0 1-5.5 5.5H11');
  svg.append(arrow, curve);
  btn.appendChild(svg);
  btn.style.cssText =
    'margin-left:8px;padding:4px;border:none;border-radius:6px;background:transparent;' +
    'color:hsl(var(--muted-foreground));line-height:0;cursor:pointer;opacity:0;transition:opacity .15s;';
  btn.addEventListener('mouseenter', () => {
    btn.style.background = 'hsl(var(--accent))';
    btn.style.color = 'hsl(var(--accent-foreground))';
  });
  btn.addEventListener('mouseleave', () => {
    btn.style.background = 'transparent';
    btn.style.color = 'hsl(var(--muted-foreground))';
  });
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    handleRewindClick(messageEl, bubble);
  });

  // 放到时间戳旁边（气泡内右下角的 flex 行）
  const metaRow = bubble.querySelector('.mt-1.flex.items-center.justify-end');
  if (metaRow) metaRow.appendChild(btn);

  // 常显（不随 hover 消失）；仅透明度弱化，鼠标悬停气泡时提亮
  btn.style.opacity = '0.35';
  bubble.addEventListener('mouseenter', () => { btn.style.opacity = '1'; });
  bubble.addEventListener('mouseleave', () => { btn.style.opacity = '0.35'; });
}

function scanAndInject() {
  document.querySelectorAll('.chat-message.user').forEach(injectButton);
}

function startObserver() {
  const observer = new MutationObserver(() => scanAndInject());
  const mountPoint = document.getElementById('root') || document.body;
  observer.observe(mountPoint, { childList: true, subtree: true });
  scanAndInject();
}

export async function mount() {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startObserver);
  } else {
    startObserver();
  }
}

export function unmount() {
  // 按钮随 React 重渲染自然消失；监听器挂在 root 上，页面级生命周期管理即可
  document.querySelectorAll(`.${BTN_ID}`).forEach((b) => b.remove());
}
