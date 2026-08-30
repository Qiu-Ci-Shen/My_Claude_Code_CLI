# Qiu_Ai_LZ

一个给 Claude Code CLI 套上图形界面的本地 Web / 桌面应用：聊天对话、文件浏览与编辑、Git 操作、内置终端、插件系统、手机远程访问，全部在一个界面里完成。完全本地运行，无云端依赖。

基于开源项目 [siteboon/claudecodeui](https://github.com/siteboon/claudecodeui) 深度定制。

---

## 给 AI 助手 / 快速总览

如果你是 AI 助手，正在帮用户部署这个项目，按下面的顺序执行即可。关键事实：

- **技术栈**：前端 React 18 + Vite + Tailwind；后端 Node.js + Express + WebSocket + better-sqlite3；桌面壳 Electron
- **端口**：后端/API/Web 界面 `3001`（生产模式唯一入口）；开发模式前端另占 `5173`
- **启动命令**：`npm install` → `npm run build` → `npm run server`，然后打开 `http://localhost:3001`
- **健康检查**：`curl http://localhost:3001/health` 返回 `{"status":"ok",...,"version":"1.1.0"}`
- **首次打开**：需在页面里注册一个本机账号（仅存本机 SQLite），然后在侧边栏选择一个本地文件夹作为项目
- **硬性前置**：本机已安装并登录 [Claude Code CLI](https://claude.com/claude-code)（终端里运行 `claude` 能进入对话即可），本应用是其图形界面，没有它无法对话

## 环境要求

| 依赖 | 要求 | 自检命令 |
|---|---|---|
| Node.js | **v22 或更高** | `node -v` |
| npm | 随 Node 附带 | `npm -v` |
| git | 任意近期版本 | `git --version` |
| Claude Code CLI | 已安装并完成登录（必需） | `claude --version` |

安装 Claude Code CLI（如尚未安装）：

```bash
npm install -g @anthropic-ai/claude-code
claude        # 首次运行会引导登录
```

## 从零启动（5 步）

```bash
# 1. 克隆仓库
git clone https://github.com/Qiu-Ci-Shen/My_Claude_Code_CLI.git qiu-ai-lz
cd qiu-ai-lz

# 2. 安装依赖（better-sqlite3 使用预编译二进制，无需额外编译工具）
npm install

# 3. 构建（产出前端 dist/ 与后端 dist-server/，无报错即成功）
npm run build

# 4. 启动（监听 3001 端口）
npm run server

# 5. 浏览器打开 http://localhost:3001
#    - 首次访问会要求注册本机账号（用户名 + 密码，只存本机）
#    - 登录后在侧边栏「创建/选择项目」指定一个本地文件夹
#    - 在输入框发消息即可开始对话
```

验证启动成功：

```bash
curl http://localhost:3001/health
# 期望输出：{"status":"ok","timestamp":"…","installMode":"git","version":"1.1.0"}
```

## 桌面应用（推荐日常使用）

```bash
npm run app
```

- 启动时自动检查构建新鲜度，源码有更新会自动重新构建（约 1 分钟，期间启动画面会显示进度）
- 自动拉起本地服务并直接进入应用，重复启动只唤起已有窗口
- 不创建菜单栏（保证「按住 Alt 说话」等快捷键不被 Windows 菜单拦截）
- 关闭窗口即退出并清理全部后台进程

## 配置（.env，全部可选）

```bash
cp .env.example .env
```

| 变量 | 默认值 | 说明 |
|---|---|---|
| `SERVER_PORT` | `3001` | 后端与 Web 界面端口 |
| `VITE_PORT` | `5173` | 开发模式前端端口 |
| `HOST` | `0.0.0.0` | 监听地址，改 `127.0.0.1` 可仅限本机访问 |
| `CLAUDE_CLI_PATH` | `claude` | Claude CLI 不在 PATH 时指定完整路径 |
| `DATABASE_PATH` | `~/.cloudcli/auth.db` | 账号/会话数据库位置 |
| `CONTEXT_WINDOW` | `160000` | 上下文窗口兜底值（代理用户建议按实际模型窗口修改） |
| `QIU_PLUGINS_DIR` | `~/.claude-code-ui/plugins` | 插件代码目录 |

## 让 Claude CLI 走自定义模型（中转/代理）

官方订阅用户无需任何配置。如果你通过中转站或本地代理使用其他模型，编辑 `~/.claude/settings.json`：

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:15721",
    "ANTHROPIC_API_KEY": "你的中转key",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "claude-sonnet-4-6[1M]"
  }
}
```

界面右上角的模型下拉列表会自动反映 CLI 的可用模型。上下文用量进度条会优先读取模型名里的 `[1M]`/`[200k]` 窗口标记。

## 功能

- **多智能体支持** — 同时接入 Claude Code 与 OpenAI Codex CLI，可在界面内切换
- **聊天界面** — 会话管理、Markdown/代码高亮/公式渲染、上下文用量指示（实时反映当前对话占用的窗口比例）
- **编辑与回退** — 消息 ✎ 编辑重发（原文载入底部输入框，回车截断重发，Esc 取消恢复草稿）、消息级 checkpoint 回退（/rewind）、生成中 ESC/停止即刻生效不残留输出
- **提问点导航轨** — 聊天区左侧按你的每条提问显示密排刻度，滚动时带波浪动效，悬停预览问答摘要，点击跳转置顶
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

## 手机访问

设置 → 手机访问 中开启，扫码或输入地址 + PIN 配对后，手机浏览器即为完整操作界面；同屏通知推送需要 PWA 安装到主屏。局域网直连或隧道模式均可。

## 语音

设置 → 语音 中配置 OpenAI 兼容的 STT/TTS 接口（baseUrl + apiKey + 模型名）。不配置则语音功能不可用。配置好后即可**按住 Alt 说话**，松开自动识别填入输入框。

### 推荐：硅基流动 SiliconFlow（有免费额度）

**1. 获取 API Key（约 2 分钟）**

1. 打开 [https://cloud.siliconflow.cn](https://cloud.siliconflow.cn) 注册/登录（手机号即可，送免费额度）
2. 左侧菜单 → **API 密钥** → **新建 API 密钥** → 复制（`sk-` 开头，只显示一次）

**2. 填写配置**（设置 → 语音）：

| 配置项 | 值 |
|---|---|
| Base URL | `https://api.siliconflow.cn/v1` |
| API Key | 上一步复制的 `sk-…` |

**3. 选择模型**（同为硅基流动账号，STT/TTS 各填一个）：

| 用途 | 模型名 | 说明 |
|---|---|---|
| 语音识别 STT（免费） | `FunAudioLLM/SenseVoiceSmall` | 免费但高峰期拥挤，偶发 503 属服务端过载——本应用已内置最多 10 次自动重试 |
| 语音识别 STT（付费，更稳） | `XingChenAGI/XingChenASR-V3.2` | 实测响应快、成功率高，按量计费 |
| 语音回复 TTS | `FunAudioLLM/CosyVoice2-0.5B` | 可选音色，用于朗读 AI 回复（TTS 留空则不朗读） |

更多模型在 [硅基流动模型广场](https://cloud.siliconflow.cn/models)（筛选「音频」分类）查看，任何 OpenAI 兼容的音频接口都可用——不限于硅基流动，其他服务商只要 BaseURL + Key + 模型名三件套齐全即可。


## 插件

在 **设置 → 插件** 中直接从 Git 仓库安装（粘贴仓库 URL 回车），或自己开发：

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
| `npm run test` | 服务端测试（277 个用例） |
| `npm run typecheck` | TypeScript 类型检查 |
| `node scripts/regenerate-icons.mjs` | 从 `desktop/assets/logo-windows.ico` 重生成全套图标 |

## 故障排查

| 现象 | 处理 |
|---|---|
| 打开页面空白 | 执行 `npm run build` 后刷新；桌面壳会自动做这一步 |
| 3001 端口被占用 | `.env` 里改 `SERVER_PORT=3002` 后重启 |
| 发消息无响应 | 终端直接运行 `claude` 确认 CLI 本身可用（本应用只是它的界面） |
| 语音识别报 HTTP 503/401 | 语音走外部 STT/TTS 服务，检查 设置 → 语音 的地址、key 与模型名 |
| Git 面板报错 | 确认所选文件夹是 git 仓库（不是的话先在面板里点「初始化」） |
| 桌面壳卡在「构建中」 | 源码有更新时首次启动会自动重建，约 1 分钟；构建不会清空旧产物，完成后自动进入 |
| Claude Code 会话报错后无法继续 | 界面内对任意消息点回退按钮（↩）即可重建会话，无需手动删转录文件 |

## 更新

应用内 **设置** 里可直接触发更新（git 安装模式执行 `git pull && npm install`），或手动：

```bash
git pull && npm install && npm run build
```

## 更新日志

### v1.1.0

- **编辑重发重构** — ✎ 后原文载入底部输入框，编辑指示条悬浮于聊天区顶部居中，Esc 取消并恢复原草稿
- **提问点导航轨** — 聊天区左侧新增密排刻度轨，带波浪跟随动效，悬停预览问答，点击跳转置顶
- **打断可靠性** — ESC/停止按钮不再被状态守卫吞掉；打断后已生成内容不漏进界面；CLI 卡死时自动降级为强制关闭
- **CONTEXT 占用修复** — 不再用回合结算总用量刷新进度条，排除子代理用量；窗口解析支持代理 env 槽位的 `[1M]`/`[200k]` 声明
- **会话自愈** — 转录被截空后自动降级为全新会话，不再报 "No conversation found with session ID"
- **插件设置清理** — 移除官方插件区块、入门模板页脚与全部失效的外部推荐卡
- **Git 面板** — 支持中文分支名；创建/切换分支失败时在面板显示具体原因

## 安全说明

Claude Code 的全部工具（文件写入、bash 执行等）默认处于禁用状态，需要在界面中逐项确认启用。账号数据仅存本机 SQLite。语音/插件等外接能力请只配置自己信任的服务地址。

## 许可

本项目遵循 [AGPL-3.0](LICENSE)（继承自上游）。基于 [siteboon/claudecodeui](https://github.com/siteboon/claudecodeui) 修改，感谢上游贡献者。
