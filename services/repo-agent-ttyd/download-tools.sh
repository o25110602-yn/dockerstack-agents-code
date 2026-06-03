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

# Tool dùng manifest JSON (như antigravity/agy)
# Usage: download_via_manifest <name> <manifest_url>
download_via_manifest() {
  local name="$1"
  local manifest_url="$2"
  log "$name: fetching manifest from $manifest_url"
  local manifest
  manifest=$(curl -fsSL "$manifest_url")
  local url
  url=$(echo "$manifest" | grep -o '"url"[[:space:]]*:[[:space:]]*"[^"]*"' | sed 's/.*"url"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')
  local sha512
  sha512=$(echo "$manifest" | grep -o '"sha512"[[:space:]]*:[[:space:]]*"[^"]*"' | sed 's/.*"sha512"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')

  log "$name: downloading binary from $url"
  curl -fsSL "$url" -o "$DOWNLOADS/$name"

  # Verify checksum nếu có
  if [ -n "$sha512" ]; then
    local actual
    actual=$(sha512sum "$DOWNLOADS/$name" | cut -d' ' -f1)
    if [ "$actual" != "$sha512" ]; then
      warn "$name: checksum mismatch! Aborting."
      rm -f "$DOWNLOADS/$name"
      exit 1
    fi
    ok "$name: checksum verified"
  fi

  chmod +x "$DOWNLOADS/$name"
  ok "$name: ready at downloads/$name"
}

# Tool download thẳng URL (binary hoặc tarball)
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

# Tool qua npm (dùng npm pack để lấy binary, không cần npm install global)
# Usage: download_npm <name> <package>
download_npm() {
  local name="$1"
  local package="$2"
  log "$name: packing from npm ($package)"
  local tmpdir
  tmpdir=$(mktemp -d)
  # Install vào tmpdir, lấy binary
  npm install --prefix "$tmpdir" "$package" --no-save --silent 2>/dev/null
  # Tìm binary trong node_modules/.bin/
  local bin="$tmpdir/node_modules/.bin/$name"
  if [ ! -f "$bin" ]; then
    # Một số package đặt bin tên khác package
    bin=$(find "$tmpdir/node_modules/.bin/" -type f | head -1)
  fi
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

download_via_manifest "agy" \
  "https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/linux_amd64_musl.json"

# download_npm "claude" "@anthropic-ai/claude-code"
# download_npm "codex"  "@openai/codex"
# download_npm "opencode" "opencode-ai"
# download_direct "mytool" "https://example.com/releases/v1.0/mytool-linux-amd64"
# download_tar "another" "https://example.com/v1.0/another-linux-amd64.tar.gz" "another"

# ─────────────────────────────────────────────────────────────────

echo ""
echo "✅ All tools downloaded:"
ls -lh "$DOWNLOADS/"
echo ""