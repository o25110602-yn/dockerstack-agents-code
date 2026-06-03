#!/bin/bash
# ================================================================
#  download-tools.sh
#  Chạy trên GitHub Actions runner (có internet đầy đủ) TRƯỚC khi
#  docker build. Tải tất cả agent CLI binary về downloads/ để
#  Dockerfile COPY vào image — không cần internet lúc build.
#
#  Thêm tool mới: thêm 1 dòng download_* ở section "TOOLS" bên dưới.
# ================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DOWNLOADS="$SCRIPT_DIR/downloads"
mkdir -p "$DOWNLOADS"

log()  { echo "  → $*"; }
ok()   { echo "  ✓ $*"; }
warn() { echo "  ⚠ $*" >&2; }

# ── Download helpers ──────────────────────────────────────────────

# Tool dùng install script chính thức (tự detect platform)
# Usage: download_via_script <name> <install_script_url>
download_via_script() {
  local name="$1"
  local script_url="$2"
  log "$name: running official install script (--dir $DOWNLOADS)"
  curl -fsSL "$script_url" | bash -s -- --dir "$DOWNLOADS"
  if [ -f "$DOWNLOADS/$name" ]; then
    chmod +x "$DOWNLOADS/$name"
    ok "$name: ready at downloads/$name"
  else
    warn "$name: binary not found after install — check script output above"
    exit 1
  fi
}

# Tool download thẳng URL
# Usage: download_direct <name> <url>
download_direct() {
  local name="$1"
  local url="$2"
  log "$name: downloading from $url"
  curl -fsSL "$url" -o "$DOWNLOADS/$name"
  chmod +x "$DOWNLOADS/$name"
  ok "$name: ready at downloads/$name"
}

# Tool trong tarball
# Usage: download_tar <name> <url> <binary_in_archive>
download_tar() {
  local name="$1"
  local url="$2"
  local binary_in_archive="$3"
  log "$name: downloading archive from $url"
  curl -fsSL "$url" | tar -xz -C "$DOWNLOADS" "$binary_in_archive"
  mv "$DOWNLOADS/$binary_in_archive" "$DOWNLOADS/$name"
  chmod +x "$DOWNLOADS/$name"
  ok "$name: ready at downloads/$name"
}

# Tool qua npm
# Usage: download_npm <name> <package>
download_npm() {
  local name="$1"
  local package="$2"
  log "$name: installing from npm ($package)"
  local tmpdir
  tmpdir=$(mktemp -d)
  npm install --prefix "$tmpdir" "$package" --no-save --silent 2>/dev/null
  local bin="$tmpdir/node_modules/.bin/$name"
  if [ -f "$bin" ]; then
    cp "$bin" "$DOWNLOADS/$name"
    chmod +x "$DOWNLOADS/$name"
    ok "$name: ready at downloads/$name"
  else
    warn "$name: binary not found in node_modules/.bin/ — skipping"
  fi
  rm -rf "$tmpdir"
}

# ── TOOLS — thêm tool mới ở đây ──────────────────────────────────

echo ""
echo "📦 Downloading agent CLI tools for Docker image..."
echo ""

# agy — dùng install script chính thức, tự detect platform runner
download_via_script "agy" "https://antigravity.google/cli/install.sh"

# download_npm "claude"    "@anthropic-ai/claude-code"
# download_npm "codex"     "@openai/codex"
# download_npm "opencode"  "opencode-ai"
# download_direct "mytool" "https://example.com/releases/v1.0/mytool-linux-amd64"
# download_tar "other" "https://example.com/v1.0/other.tar.gz" "other-binary"

# ─────────────────────────────────────────────────────────────────

echo ""
echo "✅ All tools downloaded:"
ls -lh "$DOWNLOADS/"
echo ""