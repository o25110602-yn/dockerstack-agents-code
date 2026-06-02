#!/usr/bin/env bash
# ================================================================
#  dc.sh — Docker Compose Orchestrator
#  Reads .env feature flags → auto-selects profiles → runs compose
#
#  Usage:
#    bash docker-compose/scripts/dc.sh up -d --build
#    bash docker-compose/scripts/dc.sh down
#    bash docker-compose/scripts/dc.sh logs -f
#    bash docker-compose/scripts/dc.sh ps
#    bash docker-compose/scripts/dc.sh config
#    bash docker-compose/scripts/dc.sh <any compose command>
# ================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

trim() {
  local s="$1"
  s="${s#"${s%%[![:space:]]*}"}"
  s="${s%"${s##*[![:space:]]}"}"
  printf '%s' "$s"
}

expand_env_refs() {
  local value="$1"
  local ref replacement
  while [[ "$value" =~ \$\{([A-Za-z_][A-Za-z0-9_]*)\} ]]; do
    ref="${BASH_REMATCH[1]}"
    replacement="${!ref-}"
    value="${value//\$\{$ref\}/$replacement}"
  done
  printf '%s' "$value"
}

load_env_file() {
  local env_file="${1:-.env}"
  local line key value

  [ -f "$env_file" ] || return 0

  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    [ -z "$(trim "$line")" ] && continue
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    [[ "$line" != *=* ]] && continue

    key="$(trim "${line%%=*}")"
    value="$(trim "${line#*=}")"

    if [ "${#value}" -ge 2 ]; then
      if [[ "$value" == \"*\" && "$value" == *\" ]]; then
        value="${value:1:${#value}-2}"
      elif [[ "$value" == \'*\' && "$value" == *\' ]]; then
        value="${value:1:${#value}-2}"
      fi
    fi

    # Backward-compatible with legacy .env entries that escaped "$" as "$$".
    value="${value//\$\$/\$}"
    value="$(expand_env_refs "$value")"
    export "$key=$value"
  done < "$env_file"
}

resolve_host_path() {
  local path="$1"
  if [[ "$path" = /* ]]; then
    printf '%s' "$path"
  elif [[ "$path" =~ ^[A-Za-z]:[\\/].* ]]; then
    printf '%s' "$path"
  else
    path="${path#./}"
    printf '%s' "$ROOT_DIR/$path"
  fi
}

prepare_docker_volume_dirs() {
  local volume_root
  volume_root="$(resolve_host_path "${DOCKER_VOLUMES_ROOT:-./.docker-volumes}")"

  mkdir -p \
    "$volume_root/app/logs" \
    "$volume_root/app/data" \
    "$volume_root/tinyauth" \
    "$volume_root/caddy/data" \
    "$volume_root/caddy/config" \
    "$volume_root/filebrowser/database" \
    "$volume_root/tailscale/var-lib" \
    "$volume_root/deploy-code/logs" \
    "$volume_root/deploy-code/backups" \
    "$volume_root/deploy-code/tmp" \
    "$volume_root/rclone/cache" \
    "$volume_root/repo-agent/repos" \
    "$volume_root/repo-agent/slots"

  if [ "${DC_VERBOSE:-0}" = "1" ]; then
    echo "  DATA_ROOT : $volume_root"
  fi
}

# ── Load .env ─────────────────────────────────────────────────────
# Lưu lại HOST_PROJECT_ROOT từ process env (do GH Actions / caller set)
# trước khi load .env có thể ghi đè bằng giá trị rỗng.
_HOST_PROJECT_ROOT_FROM_ENV="${HOST_PROJECT_ROOT:-}"

if [ -f "$ROOT_DIR/.env" ]; then
  load_env_file "$ROOT_DIR/.env"
else
  echo "⚠️  .env not found — using defaults. Run: cp .env.example .env" >&2
fi

# ── HOST_PROJECT_ROOT resolution ──────────────────────────────────
# Thứ tự ưu tiên (giá trị non-empty đầu tiên thắng):
#   1. Giá trị từ process env (do GitHub Actions / caller set TRƯỚC khi gọi
#      dc.sh) — đây là giá trị quan trọng nhất, vì host runner cần truyền
#      đúng path host vào main-app container.
#   2. Giá trị trong .env (cho phép user override thủ công).
#   3. ROOT_DIR — fallback an toàn khi dc.sh chạy *trực tiếp trên host*
#      (không phải trong container). Trường hợp trong container mà cả 2
#      nguồn trên đều rỗng thì path /workspace sẽ KHÔNG resolve được trên
#      host daemon → sẽ báo "path not found" rõ ràng.
if [ -n "$_HOST_PROJECT_ROOT_FROM_ENV" ]; then
  HOST_PROJECT_ROOT="$_HOST_PROJECT_ROOT_FROM_ENV"
elif [ -z "${HOST_PROJECT_ROOT:-}" ]; then
  HOST_PROJECT_ROOT="$ROOT_DIR"
fi
export HOST_PROJECT_ROOT
unset _HOST_PROJECT_ROOT_FROM_ENV

# ── ENV_FILE resolution ──────────────────────────────────────────
# Path tuyệt đối tới .env trong filesystem hiện tại (không phải host path).
# Cần để các compose YAML reference `env_file: ${ENV_FILE:-./.env}` resolve
# về đúng file trong container (vì --project-directory trỏ tới host path).
if [ -f "$ROOT_DIR/.env" ]; then
  export ENV_FILE="$ROOT_DIR/.env"
fi

# Normalize tags to comma-separated form without spaces.
if [ -n "${TAILSCALE_TAGS:-}" ]; then
  TAILSCALE_TAGS="$(printf '%s' "$TAILSCALE_TAGS" | tr -d '[:space:]')"
  export TAILSCALE_TAGS
fi

# Default deploy-code public hostname. Override in .env when a different
# Cloudflare/Caddy hostname is required.
if [ -z "${DOCKER_DEPLOY_CODE_CADDY_HOSTS:-}" ]; then
  DOCKER_DEPLOY_CODE_CADDY_HOSTS="deploy.${DOMAIN:-localhost}"
  export DOCKER_DEPLOY_CODE_CADDY_HOSTS
fi

should_render_tailscale_serve() {
  case "${1:-}" in
    ""|up|start|restart|create|run|config|pull)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

render_tailscale_serve_config() {
  local tailnet_domain app_port serve_dir serve_file serve_hostname
  tailnet_domain="$(trim "${TAILSCALE_TAILNET_DOMAIN:-}")"
  app_port="$(trim "${APP_PORT:-3000}")"
  serve_hostname="${PROJECT_NAME:-myapp}.${tailnet_domain}"

  if [ -z "$tailnet_domain" ] || [ "$tailnet_domain" = "-" ]; then
    echo "❌ ENABLE_TAILSCALE=true nhưng TAILSCALE_TAILNET_DOMAIN chưa có giá trị hợp lệ." >&2
    echo "   Chạy: npm run tailscale-init (hoặc điền TAILSCALE_TAILNET_DOMAIN trong .env)." >&2
    exit 1
  fi

  if ! [[ "$app_port" =~ ^[0-9]+$ ]] || [ "$app_port" -lt 1 ] || [ "$app_port" -gt 65535 ]; then
    echo "❌ APP_PORT không hợp lệ: $app_port" >&2
    exit 1
  fi

  serve_dir="$ROOT_DIR/tailscale"
  serve_file="$serve_dir/serve.json"
  mkdir -p "$serve_dir"
  cat > "$serve_file" <<EOF
{
  "TCP": {
    "443": {
      "HTTPS": true
    }
  },
  "Web": {
    "${serve_hostname}:443": {
      "Handlers": {
        "/": {
          "Proxy": "http://127.0.0.1:80"
        }
      }
    }
  }
}
EOF

  if [ "${DC_VERBOSE:-0}" = "1" ]; then
    echo "  TS_SERVE  : $serve_file (${serve_hostname} -> 127.0.0.1:80)"
  fi
}

# ── Detect OS (uname-based, not RUNNER_OS) ─────────────────────
UNAME_S="$(uname -s)"
UNAME_R="$(uname -r)"

if echo "$UNAME_R" | grep -qi "microsoft\|wsl"; then
  _OS="windows"
elif [ "$UNAME_S" = "Darwin" ]; then
  _OS="macos"
else
  _OS="${CUR_OS:-linux}"
fi

# ── Build --profile arguments from ENABLE_* flags ──────────────
PROFILE_ARGS=()

if [ "${ENABLE_DOZZLE:-true}" = "true" ]; then
  PROFILE_ARGS+=(--profile dozzle)
fi

if [ "${ENABLE_FILEBROWSER:-true}" = "true" ]; then
  PROFILE_ARGS+=(--profile filebrowser)
fi

if [ "${ENABLE_WEBSSH:-true}" = "true" ]; then
  if [ "$_OS" = "windows" ]; then
    PROFILE_ARGS+=(--profile webssh-windows)
  else
    PROFILE_ARGS+=(--profile webssh-linux)
  fi
fi

if [ "${ENABLE_TAILSCALE:-false}" = "true" ]; then
  if [ "$_OS" = "windows" ]; then
    PROFILE_ARGS+=(--profile tailscale-windows)
  else
    PROFILE_ARGS+=(--profile tailscale-linux)
  fi
fi

if [ "${ENABLE_LITESTREAM:-true}" = "true" ]; then
  PROFILE_ARGS+=(--profile litestream)
fi

if [ "${DOCKER_DEPLOY_CODE_ENABLED:-false}" = "true" ]; then
  PROFILE_ARGS+=(--profile deploy-code)
fi

if [ "${ENABLE_RCLONE:-false}" = "true" ]; then
  PROFILE_ARGS+=(--profile rclone)
fi

# Repo Agent Launcher: launcher app chạy mặc định khi ENABLE_REPO_AGENT=true,
# nhưng các ttyd slot KHÔNG start tự động — chúng chỉ start khi user bấm
# Launch trên UI (qua `dc.sh --profile repo-ttyd up -d ttyd-XXX`).
# Do đó ở đây ta KHÔNG add `--profile repo-ttyd` vào PROFILE_ARGS mặc định.

if [ "${ENABLE_TAILSCALE:-false}" = "true" ] && should_render_tailscale_serve "${1:-}"; then
  render_tailscale_serve_config
fi

prepare_docker_volume_dirs

# ── Compose file list ──────────────────────────────────────────
FILES=(
  -f "$ROOT_DIR/docker-compose/compose.core.yml"
  -f "$ROOT_DIR/docker-compose/compose.auth.yml"
  -f "$ROOT_DIR/docker-compose/compose.ops.yml"
  -f "$ROOT_DIR/docker-compose/compose.access.yml"
  -f "$ROOT_DIR/docker-compose/compose.deploy.yml"
  -f "$ROOT_DIR/docker-compose/compose.rclone.yml"
  -f "$ROOT_DIR/docker-compose/compose.repo-ttyd.yml"
  -f "$ROOT_DIR/compose.apps.yml"
)

# Khi rclone bật, nạp thêm gate override để các service quan trọng
# depends_on rclone-restore (đảm bảo data có sẵn trước khi start).
if [ "${ENABLE_RCLONE:-false}" = "true" ]; then
  FILES+=( -f "$ROOT_DIR/docker-compose/compose.rclone-gate.yml" )
fi

# Khi litestream bật, nạp gate override để tinyauth + app depends_on
# litestream-restore (đảm bảo SQLite được restore từ S3 trước khi start).
# Khi tắt, file này không được merge → tinyauth/app chạy độc lập, lưu data
# trực tiếp tại ${DOCKER_VOLUMES_ROOT}/tinyauth/ trong docker-volumes.
if [ "${ENABLE_LITESTREAM:-true}" = "true" ]; then
  FILES+=( -f "$ROOT_DIR/docker-compose/compose.auth.litestream-gate.yml" )
fi

# ── Debug info (set DC_VERBOSE=1 to show) ─────────────────────
if [ "${DC_VERBOSE:-0}" = "1" ]; then
  echo "── dc.sh debug ──────────────────────────────────"
  echo "  OS         : $_OS"
  echo "  PROJECT    : ${PROJECT_NAME:-?}"
  echo "  DOMAIN     : ${DOMAIN:-?}"
  echo "  ROOT_DIR   : $ROOT_DIR"
  echo "  HOST_ROOT  : $HOST_PROJECT_ROOT"
  echo "  PROFILES   : ${PROFILE_ARGS[*]:-<none>}"
  echo "  FILES      : ${FILES[*]}"
  echo "─────────────────────────────────────────────────"
fi

# Cảnh báo nhanh khi HOST_PROJECT_ROOT khác ROOT_DIR và path không tồn tại
# trên filesystem hiện tại — nghĩa là chúng ta đang chạy *trong container*
# và Docker daemon ở host cần path host. Không cần check tồn tại trong
# container vì path đó là cho daemon trên host, không phải cho container.
if [ "$HOST_PROJECT_ROOT" != "$ROOT_DIR" ] && [ "${DC_VERBOSE:-0}" = "1" ]; then
  echo "  Note: dùng HOST_PROJECT_ROOT='$HOST_PROJECT_ROOT' (khác ROOT_DIR)" \
       "cho --project-directory để Docker daemon trên host phân giải đúng path."
fi

# ── Execute ───────────────────────────────────────────────────
# --env-file: explicit path tới .env trong filesystem hiện tại (ROOT_DIR).
#   Cần thiết khi --project-directory trỏ tới path host (khác ROOT_DIR khi
#   chạy trong container) — Compose mặc định tìm .env ở project-directory,
#   nhưng path đó chỉ tồn tại trên host, không có trong container.
ENV_FILE_ARGS=()
if [ -f "$ROOT_DIR/.env" ]; then
  ENV_FILE_ARGS+=( --env-file "$ROOT_DIR/.env" )
fi

exec docker compose \
  "${ENV_FILE_ARGS[@]}" \
  "${FILES[@]}" \
  --project-directory "$HOST_PROJECT_ROOT" \
  --project-name "${PROJECT_NAME:-myapp}" \
  "${PROFILE_ARGS[@]}" \
  "$@"
