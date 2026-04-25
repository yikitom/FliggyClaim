#!/usr/bin/env bash
# FliggyClaim - 一键安装到 Chrome (macOS / Linux)
#
# 做什么：
#   1. 把扩展拷贝到 ~/.fliggyclaim/extension （一个稳定路径，避免下载目录被清理）
#   2. 在 ~/.fliggyclaim/launch-chrome.sh 写一个启动器，用 --load-extension 加载
#   3. 立即启动 Chrome 加载本扩展
#
# 为什么不能完全静默安装：
#   稳定版 Chrome 出于安全限制，禁止本地 .crx 静默安装非 Web Store 扩展，
#   仅支持「开发者模式 + Load unpacked」或「--load-extension 启动参数」。
#   本脚本采用后者，效果是双击启动器即可在加载本扩展的状态下打开 Chrome。

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="${HOME}/.fliggyclaim/extension"
LAUNCHER="${HOME}/.fliggyclaim/launch-chrome.sh"

# ---- 复制扩展文件 ----
echo "→ 安装扩展到 ${TARGET}"
mkdir -p "${TARGET}"
rm -rf "${TARGET}"/*
cp -R "${ROOT}/manifest.json" \
      "${ROOT}/background" \
      "${ROOT}/content" \
      "${ROOT}/icons" \
      "${ROOT}/lib" \
      "${ROOT}/options" \
      "${ROOT}/popup" \
      "${TARGET}/"

# ---- 探测 Chrome ----
detect_chrome() {
  case "$(uname -s)" in
    Darwin)
      for p in \
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
        "${HOME}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
        "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary" \
        "/Applications/Chromium.app/Contents/MacOS/Chromium"; do
        [[ -x "$p" ]] && { echo "$p"; return; }
      done
      ;;
    Linux)
      for c in google-chrome google-chrome-stable chromium chromium-browser; do
        if command -v "$c" >/dev/null 2>&1; then
          command -v "$c"; return
        fi
      done
      ;;
  esac
  return 1
}

CHROME="$(detect_chrome || true)"
if [[ -z "${CHROME}" ]]; then
  echo "✗ 没有找到 Chrome / Chromium。请先安装 Chrome 后再运行本脚本。" >&2
  exit 1
fi
echo "→ 检测到 Chrome: ${CHROME}"

# ---- 写启动器脚本 ----
mkdir -p "$(dirname "${LAUNCHER}")"
cat > "${LAUNCHER}" <<EOF
#!/usr/bin/env bash
# 由 FliggyClaim 安装脚本生成。运行此脚本会以加载报销助手扩展的方式打开 Chrome。
exec "${CHROME}" --load-extension="${TARGET}" "\$@"
EOF
chmod +x "${LAUNCHER}"

# ---- macOS: 同时生成可双击的 .command ----
if [[ "$(uname -s)" == "Darwin" ]]; then
  cp "${LAUNCHER}" "${HOME}/.fliggyclaim/启动飞猪报销助手.command"
  chmod +x "${HOME}/.fliggyclaim/启动飞猪报销助手.command"
fi

echo
echo "✓ 安装完成"
echo
echo "立即启动："
echo "    ${LAUNCHER}"
if [[ "$(uname -s)" == "Darwin" ]]; then
  echo "  或双击：${HOME}/.fliggyclaim/启动飞猪报销助手.command"
fi
echo
echo "下次想用直接运行启动器即可。如希望永久安装（不依赖启动器），"
echo "请在 chrome://extensions 打开开发者模式，点「加载已解压的扩展程序」选择："
echo "    ${TARGET}"
echo

# ---- 立即启动一次 ----
read -r -p "现在就启动 Chrome 加载扩展吗? [Y/n] " ans
ans="${ans:-Y}"
if [[ "${ans}" =~ ^[Yy]$ ]]; then
  echo "→ 正在启动 Chrome..."
  if [[ "$(uname -s)" == "Darwin" ]]; then
    # 用 open -na 以新进程方式启动，不会复用已运行的实例
    open -na "Google Chrome" --args --load-extension="${TARGET}" >/dev/null 2>&1 || \
      "${LAUNCHER}" >/dev/null 2>&1 &
  else
    "${LAUNCHER}" >/dev/null 2>&1 &
  fi
  echo "→ 完成。如已有 Chrome 运行，可能需要先退出全部 Chrome 窗口再次执行启动器。"
fi
