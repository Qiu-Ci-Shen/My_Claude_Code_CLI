# Qiu_Ai_LZ

一个给 Claude Code CLI 套上图形界面的本地 Web / 桌面应用：聊天对话、文件浏览与编辑、Git 操作、内置终端、插件系统、手机远程访问，全部在一个界面里完成。

基于开源项目 [siteboon/claudecodeui](https://github.com/siteboon/claudecodeui) 深度定制，去除了全部云端服务依赖，完全本地运行。

## 功能

- **多智能体支持** — 同时接入 Claude Code 与 OpenAI Codex CLI，可在界面内切换
- **聊天界面** — 会话管理、Markdown/代码高亮/公式渲染、上下文用量指示（实时反映当前对话占用的窗口比例）
- **编辑与回退** — 消息 ✎ 编辑重发（ZCode 同款：原文载入底部输入框，回车截断重发，Esc 取消恢复草稿）、消息级 checkpoint 回退（/rewind）、生成中 ESC/停止即刻生效不残留输出
- **提问点导航轨** — 聊天区左侧按你的每条提问显示密排刻度，悬停预览问答摘要，点击跳转置顶
- **文件系统** — 项目文件树 + CodeMirror 编辑器（语法高亮、diff 对比、minimap）
- **Git 面板** — 状态、暂存、提交、分支（支持中文分支名）、提交历史与 diff、远端 Fetch/Pull/Push/发布，失败原因直接显示在面板上
- **内置终端** — node-pty 驱动的真实 shell，多标签
- **MCP 管理** — 查看/编辑各 Provider 的 MCP 服务器配置
- **插件系统** — 模块化插件（前端 tab / 后台模块 / 可选 Node 后端），本机已内置：
  - **Push to Talk** — 按住 Alt 说话，松开自动识别填入输入框
  - **Claude Rewind** — 消息级回退 + 主题自适应确认弹窗
- **手机访问** — 局域网/隧道 + 6 位 PIN 配对，手机浏览器获得完整界面（PWA，可加到主屏，支持推送通知）
- **语音** — 语音输入（STT）与语音回复（TTS），任何 OpenAI 兼容语音接口均可
- **Task Master** — 集成 task-master-ai 任务管理
- **Browser Use** — 让智能体操控浏览器（可选功能）
- **Worktree** — git worktree 一键开分支工作区
- **界面** — 深色/浅色主题、简体中文等多语言、命令面板（Ctrl+K）

## 环境要求

- Node.js **v22+**
- 已安装并登录 [Claude Code CLI](https://claude.com/claude-code)（或 Codex CLI）
- Windows / macOS / Linux 均可（桌面壳当前主要面向 Windows 使用）

## 快速开始

```bash
npm install
cp .env.example .env        # 按需修改（可选）

# 开发模式（前端 Vite 5173 + 后端 3001 热更新）
npm run dev

# 生产模式
npm run build
npm run server              # 或直接用下面的桌面壳
```

首次打开 `http://localhost:3001` 会要求注册本机账号（数据存在本机 SQLite）。

## 桌面应用（推荐日常使用）

```bash
npm run app
```

- 启动时自动检查构建新鲜度，源码有更新会自动重新构建
- 自动拉起本地服务并直接进入应用，重复启动只唤起已有窗口
- 不创建菜单栏（保证「按住 Alt 说话」等快捷键不被 Windows 菜单拦截）
- 关闭窗口即退出并清理全部后台进程

## 手机访问

设置 → 手机访问 中开启，扫码或输入地址 + PIN 配对后，手机浏览器即为完整操作界面；同屏通知推送需要 PWA 安装到主屏。局域网直连或隧道模式均可。

## 语音

设置 → 语音 中配置 OpenAI 兼容的 STT/TTS 接口（baseUrl + apiKey + 模型名）。不配置则语音功能不可用（插件会提示 HTTP 错误码，通常是识别服务过载或未配置）。

## 插件

在 **设置 → 插件** 中直接从 Git 仓库安装，或自己开发：

- 插件安装位置：`~/.claude-code-ui/plugins/`
- 插件 = `manifest.json` + 前端入口（可带 Node 后端文件），支持 tab 挂载点和后台模块（`backgroundOnly`，如全局快捷键类）
- 换图标：替换 `desktop/assets/logo-windows.ico` 后执行 `node scripts/regenerate-icons.mjs`，全套 27 个图标（PWA/favicon/logo/icns）一键重生成

## 数据与配置位置

| 路径 | 内容 |
|---|---|
| `~/.cloudcli/auth.db` | 本机账号与会话数据（SQLite） |
| `~/.cloudcli/assets/` | 聊天图片附件 |
| `~/.cloudcli/mobile-access/` | 手机配对与隧道设置 |
| `~/.claude-code-ui/plugins/` | 已安装插件 |

## 常用脚本

| 命令 | 作用 |
|---|---|
| `npm run dev` | 开发模式（前后端热更新） |
| `npm run build` | 全量构建（前端 dist + 后端 dist-server） |
| `npm run server` | 运行构建产物 |
| `npm run app` | 桌面壳（自动构建检查 + 服务托管） |
| `npm run test` | 服务端测试 |
| `npm run typecheck` | TypeScript 类型检查 |
| `node scripts/regenerate-icons.mjs` | 从 `desktop/assets/logo-windows.ico` 重生成全套图标 |

## 更新

应用内 **设置** 里可直接触发更新（git 安装模式执行 `git pull && npm install`），或手动：

```bash
git pull && npm install && npm run build
```

## 更新日志

### v1.1.0

- **编辑重发重构** — ✎ 后原文载入底部输入框（ZCode 同款），编辑指示条悬浮于聊天区顶部居中，Esc 取消并恢复原草稿；弃用原来的内联窄卡片
- **提问点导航轨** — 聊天区左侧新增密排刻度轨，每条提问一根杠，悬停预览问答摘要，点击跳转置顶，整排垂直居中
- **打断可靠性** — 修复 ESC/停止按钮被状态守卫吞掉导致 agent 停不下来；打断后已生成的内容不再漏进界面；CLI 卡死时自动降级为强制关闭子进程
- **CONTEXT 占用修复** — 不再用回合结算总用量（费用口径）刷新进度条，排除子代理用量，消除"莫名爆满又恢复"；窗口大小解析支持代理 env 槽位的 `[1M]`/`[200k]` 声明
- **会话自愈** — 转录被截空（回退第一条消息）后自动降级为全新会话，不再报 "No conversation found with session ID"
- **插件设置清理** — 移除官方插件区块、入门模板页脚与全部失效的外部推荐卡（Claude Watch 等源仓库已 404）
- **Git 面板** — 支持中文分支名（按 git check-ref-format 规则校验）；创建/切换分支失败时在面板显示具体原因

## 安全说明

Claude Code 的全部工具（文件写入、bash 执行等）默认处于禁用状态，需要在界面中逐项确认启用。语音/插件等外接能力请只配置自己信任的服务地址。

## 许可

本项目遵循 [AGPL-3.0](LICENSE)（继承自上游）。基于 [siteboon/claudecodeui](https://github.com/siteboon/claudecodeui) 修改，感谢上游贡献者。

