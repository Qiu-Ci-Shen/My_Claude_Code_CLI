#!/bin/bash
# Claude Rewind 补丁恢复脚本
# 用途：claudecodeui 更新后，文件恢复快照功能被覆盖时，运行本脚本一键恢复。
# 前提：在 claudecodeui 项目根目录运行（或用第一个参数指定项目根目录）。
#
# 恢复内容（仅 1 处）：
#   server/modules/providers/list/claude/claude-runtime.provider.js
#     → mapCliOptionsToSDK() 内开启 enableFileCheckpointing，
#       没有它 CLI 不产生文件快照，rewind 的「恢复代码文件」功能静默失效
#       （对话截断不受影响，仍可用）。
#
# 另需确认（脚本会自动检查并提示）：
#   server.js 里 resolveHostNodeModules() 指向宿主的 node_modules
#   （better-sqlite3 从宿主加载）。宿主目录搬家时才需要改。
#
# 幂等：补丁已存在时自动跳过，可反复运行。
# 说明：push-to-talk 的 apply-push-to-talk-patch.sh [6/6] 步也是这同一处补丁，
#       两个脚本效果相同，用哪个都行；本脚本让 rewind 脱离对 push-to-talk 的依赖。

set -e

PROJECT_DIR="${1:-D:/Claude_Tools/claudecodeui}"
PLUGIN_DIR="$(dirname "$0")/.."

if [ ! -f "$PROJECT_DIR/package.json" ]; then
  echo "错误：$PROJECT_DIR 不是 claudecodeui 项目根目录"
  echo "用法：bash apply-rewind-patch.sh [项目根目录]"
  exit 1
fi

echo "== 恢复 Claude Rewind 补丁到 $PROJECT_DIR =="

# 1. claude-runtime 开启文件快照
CR="$PROJECT_DIR/server/modules/providers/list/claude/claude-runtime.provider.js"
if [ ! -f "$CR" ]; then
  echo "  [1/2] 错误：找不到 $CR"
  echo "        上游可能重构了目录结构。请在源码中搜索 mapCliOptionsToSDK，"
  echo "        在其 sdkOptions.tools 行之后手动加：sdkOptions.enableFileCheckpointing = true;"
  exit 1
fi

if ! grep -q "enableFileCheckpointing" "$CR"; then
  sed -i "s|  sdkOptions.tools = { type: 'preset', preset: 'claude_code' };|  sdkOptions.tools = { type: 'preset', preset: 'claude_code' };\n\n  // [claude-rewind plugin] Enable file checkpointing so the rewind plugin can\n  // restore files to any user message's state via ~/.claude/file-history.\n  sdkOptions.enableFileCheckpointing = true;|" "$CR"
  # sed 锚点匹配失败时不会报错，必须回读验证
  if grep -q "enableFileCheckpointing" "$CR"; then
    echo "  [1/2] claude-runtime.provider.js 已打补丁（文件快照）"
  else
    echo "  [1/2] 失败：锚点行 sdkOptions.tools = {...'claude_code'} 未匹配到，"
    echo "        上游可能改写了这段代码。请手动在 mapCliOptionsToSDK() 内加："
    echo "        sdkOptions.enableFileCheckpointing = true;"
    exit 1
  fi
else
  echo "  [1/2] claude-runtime 已有补丁，跳过"
fi

# 2. 检查插件 server.js 的宿主 node_modules 路径是否仍有效
HOST_NM="$PROJECT_DIR/node_modules/better-sqlite3"
if [ -d "$HOST_NM" ]; then
  echo "  [2/2] 宿主 node_modules/better-sqlite3 存在，server.js 依赖正常"
else
  echo "  [2/2] 警告：$HOST_NM 不存在"
  echo "        宿主没装 better-sqlite3 或目录已搬家，rewind 后端会启动失败。"
  echo "        若是搬家：改 $PLUGIN_DIR/server.js 里 resolveHostNodeModules() 的返回路径。"
  echo "        若是缺依赖：cd $PROJECT_DIR && npm install"
fi

echo ""
echo "== 完成 =="
echo "如果以生产模式运行，请再执行：cd $PROJECT_DIR && npm run build"
echo "dev 模式会热更新，无需其他操作。"
echo ""
echo "验证：让 Claude 用 Write/Edit 工具改个测试文件，多聊几轮后点该消息旁的"
echo "⟲ 按钮回退，文件应恢复到改前状态（详见 docs/修复指南.md 的验证方法）。"
