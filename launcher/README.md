# CCUI-Launcher

CloudCLI 的 Windows 一键启动器。双击桌面图标 → 自动起后端 + 打开 Edge 应用模式窗口 → 关闭浏览器时自动清理后端进程。

## 文件说明

| 文件 | 作用 |
|------|------|
| `launcher.vbs` | 入口（双击桌面快捷方式实际调它）。无窗口静默启动 PowerShell |
| `manager.ps1` | 主控脚本。起 Vite dev 服务器 + tsx 后端 → 打开 splash → 等浏览器加载完跳转 → 监视浏览器关闭后清理进程 |
| `splash.html` | 启动过渡页。轮询 `localhost:5173`,Vite ready 后自动跳转到主界面 |
| `claude.ico` / `claude-ai-icon.svg` / `good-icon-7b73cc.ico` | 桌面图标资源 |

## 部署位置

**真身路径**: `D:\Claude_Tools\CCUI-Launcher\`

桌面快捷方式指向 `launcher.vbs`，由它调起 `manager.ps1`。

**本仓库的 `launcher/` 是只读备份**,真身修改后请同步到这里(改完后告诉 Claude「同步 launcher」即可)。

## 工作流程

```
双击桌面图标
    ↓
launcher.vbs (静默启动)
    ↓
manager.ps1
    ├─ 起 Vite (port 5173, 隐藏窗口)
    ├─ 起 tsx server/index.ts (port 3001, 隐藏窗口)
    ├─ 打开 Edge --app=splash.html
    │       ↓
    │   splash.html 轮询 5173
    │       ↓ 5173 listen
    │   splash 自我跳转到 localhost:5173
    │       ↓
    │   浏览器加载 CCUI 主界面
    ↓
manager.ps1 持续监视浏览器进程
    ↓ 浏览器关闭
taskkill /T 杀掉 vite + tsx 进程树
```

## 手机访问 (与 launcher 配合)

CCUI 主体已加入「手机访问」功能(设置 → 手机访问):
- **局域网二维码**: 同一 WiFi 扫码即开
- **公网隧道二维码**: Cloudflare quick tunnel,4G 也能开
- **6 位 PIN 登录**: 扫码后输入 6 位数字直接登录,不用输账号密码

手机链路走的是 `localhost:3001`(后端端口),与桌面 launcher 的 5173 互不干扰。

## 故障排查

**Q: 启动后 splash 一直转圈**
A: 看 `logs/launch-YYYYMMDD.log` 和 `logs/server-err.log`。常见原因是 5173 被占用 (Task Manager 杀 node.exe)。

**Q: 想完全退出**
A: 关闭浏览器窗口即可,manager.ps1 会自动清理后端。不要直接关 PowerShell。

**Q: 修改后没生效**
A: 改 `D:\Claude_Tools\CCUI-Launcher\` 下的文件后,需要关闭 CCUI 浏览器再重新点 launcher。

## 备份与回滚

仓库里这份是备份。真身在 `D:\Claude_Tools\CCUI-Launcher\`。

如果 launcher 改坏了,从仓库恢复:
```bash
git checkout main -- launcher/
cp -r launcher/* /d/Claude_Tools/CCUI-Launcher/
```
