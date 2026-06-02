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
#
#  Robustness features (auto, không cần config):
#    1. Resolve placeholders ${X} trong .env → nếu không có giá trị, thay
#       bằng chuỗi rỗng (thay vì để literal "${X}" lan vào Compose).
#       Cảnh báo 1 lần với danh sách biến chưa set, dedupe.
#    2. Tạo "resolved env file" tạm pass cho --env-file và env_file:
#       cho service → loại bỏ warning "X variable is not set" do dangling
#       placeholders.
#    3. HOST_PROJECT_ROOT auto-validate: khi đang trong container, ưu tiên
#       ground truth từ `docker inspect` (Mounts của /workspace). Nếu env
#       inherit (vd từ GH Actions runner cũ) trỏ tới path không còn tồn tại
#       trên host daemon → tự sửa.
#    4. COMPOSE_BAKE auto-fallback: tắt khi `docker buildx` không có sẵn,
#       tránh warning "Compose is configured to build using Bake, but
#       buildx isn't installed".
#    5. CWD-isolation khi exec compose: chuyển sang tmpdir để Compose không
#       auto-load .env raw làm rò warning placeholder.
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
  # Track unresolved placeholders to warn the user (instead of silently passing
  # the literal "${name}" through to docker compose, which then prints
  # "The X variable is not set. Defaulting to a blank string.").
  # NOTE: this function is called via $(...) (subshell), so we cannot rely on
  # exported variables to escape — append to a tempfile instead.
  while [[ "$value" =~ \$\{([A-Za-z_][A-Za-z0-9_]*)\} ]]; do
    ref="${BASH_REMATCH[1]}"
    if [ -z "${!ref+x}" ]; then
      # Variable is genuinely unset — record (deduped later) and strip the
      # placeholder so the resulting string contains a clean empty token
      # instead of the literal "${ref}".
      if [ -n "${DC_UNRESOLVED_LOG:-}" ]; then
        printf '%s\n' "$ref" >> "$DC_UNRESOLVED_LOG"
      fi
      replacement=""
    else
      replacement="${!ref}"
    fi
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

    # Mirror the resolved value into a "compose-safe" env file that we will
    # pass to docker compose with --env-file. This prevents Compose from
    # re-parsing the original .env (raw) and printing warnings like
    # "The X variable is not set" for placeholders we already collapsed to "".
    if [ -n "${DC_RESOLVED_ENV_FILE:-}" ]; then
      # Compose --env-file format: KEY=VALUE per line, no quotes needed; values
      # should not contain newlines. We escape any literal $ to $$ so Compose
      # does not try to interpolate further.
      local safe_value
      safe_value="${value//\$/\$\$}"
      printf '%s=%s\n' "$key" "$safe_value" >> "$DC_RESOLVED_ENV_FILE"
    fi
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
  # Tempfile để expand_env_refs (chạy trong subshell $()) ghi tên biến chưa resolve.
  DC_UNRESOLVED_LOG="$(mktemp -t dc-unresolved.XXXXXX)"
  export DC_UNRESOLVED_LOG
  # Tempfile để mirror các giá trị đã resolve sạch — dùng làm --env-file cho
  # docker compose, tránh việc Compose tự re-parse .env raw và in warning về
  # các placeholder ${X} đã được ta xử lý.
  DC_RESOLVED_ENV_FILE="$(mktemp -t dc-resolved.XXXXXX)"
  export DC_RESOLVED_ENV_FILE
  load_env_file "$ROOT_DIR/.env"
else
  echo "⚠️  .env not found — using defaults. Run: cp .env.example .env" >&2
fi

# Warn về các biến placeholder ${X} không thể resolve được (sạch hơn so với
# việc để Compose tự warn từng lần "The X variable is not set").
if [ -n "${DC_UNRESOLVED_LOG:-}" ] && [ -s "$DC_UNRESOLVED_LOG" ]; then
  _DEDUP="$(sort -u "$DC_UNRESOLVED_LOG" | tr '\n' ' ')"
  echo "⚠️  Các biến placeholder trong .env không có giá trị (đã thay bằng chuỗi rỗng):" >&2
  echo "    → $_DEDUP" >&2
  echo "    Nếu chúng cần thiết, hãy set chúng trong .env hoặc export trước khi chạy." >&2
  unset _DEDUP
fi
[ -n "${DC_UNRESOLVED_LOG:-}" ] && rm -f "$DC_UNRESOLVED_LOG"
unset DC_UNRESOLVED_LOG

# ── COMPOSE_BAKE safe-fallback ────────────────────────────────────
# Compose v2 có thể bật bake (nhanh hơn) khi COMPOSE_BAKE=true, nhưng yêu cầu
# `docker buildx`. Trong nhiều môi trường (rootless, slim images, runner cũ)
# buildx không có sẵn → Compose sẽ in warning và fallback. Để tránh warning
# và tăng tính dự đoán, ta tự tắt COMPOSE_BAKE khi buildx thiếu.
if [ "${COMPOSE_BAKE:-}" = "true" ] || [ "${COMPOSE_BAKE:-}" = "1" ]; then
  if ! docker buildx version >/dev/null 2>&1; then
    if [ "${DC_VERBOSE:-0}" = "1" ]; then
      echo "  Note: COMPOSE_BAKE=true nhưng docker buildx không có sẵn → tắt bake." >&2
    fi
    unset COMPOSE_BAKE
    export COMPOSE_BAKE=false
  fi
fi

# ── HOST_PROJECT_ROOT resolution ──────────────────────────────────
# Mục tiêu: --project-directory phải trỏ tới path TỒN TẠI trên Docker daemon
# host. Khi dc.sh chạy trong container và share /var/run/docker.sock với host,
# Compose sẽ build context, mount volumes, ... bằng path đó trên host daemon.
#
# Thứ tự ưu tiên (giá trị non-empty và HỢP LỆ đầu tiên thắng):
#   1. Giá trị từ process env (caller / GH Actions set).
#   2. Giá trị từ .env (user override thủ công).
#   3. Auto-detect từ docker inspect khi đang chạy trong container
#      (đọc HostConfig.Mounts để tìm bind mount của /workspace → ground truth).
#   4. ROOT_DIR — fallback an toàn khi chạy trực tiếp trên host.
#
# QUAN TRỌNG: Một giá trị "non-empty" chưa chắc đúng. Ví dụ: GitHub Actions
# runner set HOST_PROJECT_ROOT=/home/runner/work/... nhưng sau khi workflow
# kết thúc, directory đó bị xoá. Nếu lần chạy tiếp theo (cùng container vẫn
# alive) vẫn dùng giá trị stale đó → Compose báo "path not found".
# Vì vậy ta validate bằng cách kiểm tra path tồn tại trên host daemon.

# Detect xem có đang chạy trong container không (qua /.dockerenv hoặc cgroup).
in_container() {
  [ -f "/.dockerenv" ] && return 0
  if [ -r "/proc/1/cgroup" ] && grep -qE "docker|containerd|kubepods" /proc/1/cgroup 2>/dev/null; then
    return 0
  fi
  return 1
}

# Auto-detect host path của /workspace bind mount (khi đang trong container).
# Trả về path host hoặc rỗng nếu không xác định được.
detect_host_root_from_inspect() {
  local cid mount_src
  # Lấy container ID hiện tại từ /proc/self/cgroup hoặc /etc/hostname.
  cid="$(awk -F/ '/docker|containerd/ {print $NF; exit}' /proc/self/cgroup 2>/dev/null || true)"
  if [ -z "$cid" ] && [ -r "/etc/hostname" ]; then
    cid="$(cat /etc/hostname 2>/dev/null | tr -d '[:space:]')"
  fi
  [ -z "$cid" ] && return 1

  command -v docker >/dev/null 2>&1 || return 1

  # Tìm bind mount có Destination=/workspace → Source là host path thật.
  mount_src="$(docker inspect "$cid" \
    --format '{{range .Mounts}}{{if eq .Destination "/workspace"}}{{.Source}}{{end}}{{end}}' \
    2>/dev/null || true)"

  if [ -n "$mount_src" ]; then
    printf '%s' "$mount_src"
    return 0
  fi
  return 1
}

# Validate path tồn tại trên Docker daemon host bằng cách dùng `docker run`
# với một image bất kỳ và mount path đó. Trả về 0 nếu OK, 1 nếu không.
# Chỉ dùng khi nghi ngờ path stale — không gọi mặc định để tránh chậm.
validate_host_path_on_daemon() {
  local p="$1"
  command -v docker >/dev/null 2>&1 || return 0   # không có docker → skip
  # Lightweight check: dùng alpine (đa số host đã có sẵn từ các build trước).
  # Nếu image chưa có thì không pull (--pull=never) để tránh delay; lúc đó
  # ta giả định path OK (best-effort, không block).
  docker run --rm --pull=never --entrypoint /bin/true \
    -v "$p:/__check__:ro" alpine 2>/dev/null
}

# Lưu lại HOST_PROJECT_ROOT từ process env / .env trước khi reset.
_HOST_PROJECT_ROOT_FROM_ENV="${_HOST_PROJECT_ROOT_FROM_ENV:-}"
_HOST_PROJECT_ROOT_FROM_DOTENV="${HOST_PROJECT_ROOT:-}"

# Resolve theo priority.
HOST_PROJECT_ROOT_RESOLVED=""
HOST_PROJECT_ROOT_SOURCE=""

if [ -n "$_HOST_PROJECT_ROOT_FROM_ENV" ]; then
  HOST_PROJECT_ROOT_RESOLVED="$_HOST_PROJECT_ROOT_FROM_ENV"
  HOST_PROJECT_ROOT_SOURCE="process-env"
elif [ -n "$_HOST_PROJECT_ROOT_FROM_DOTENV" ]; then
  HOST_PROJECT_ROOT_RESOLVED="$_HOST_PROJECT_ROOT_FROM_DOTENV"
  HOST_PROJECT_ROOT_SOURCE=".env"
fi

# Khi đang chạy trong container, ưu tiên ground-truth từ docker inspect.
# Nếu giá trị từ env/dotenv khác với ground truth → cảnh báo & dùng ground truth.
if in_container; then
  _DETECTED_HOST_ROOT="$(detect_host_root_from_inspect 2>/dev/null || true)"
  if [ -n "$_DETECTED_HOST_ROOT" ]; then
    if [ -n "$HOST_PROJECT_ROOT_RESOLVED" ] \
       && [ "$HOST_PROJECT_ROOT_RESOLVED" != "$_DETECTED_HOST_ROOT" ]; then
      echo "⚠️  HOST_PROJECT_ROOT từ $HOST_PROJECT_ROOT_SOURCE khác ground-truth từ docker inspect:" >&2
      echo "    $HOST_PROJECT_ROOT_SOURCE  : $HOST_PROJECT_ROOT_RESOLVED" >&2
      echo "    docker inspect : $_DETECTED_HOST_ROOT" >&2
      echo "    → dùng giá trị từ docker inspect (ground truth)." >&2
    fi
    HOST_PROJECT_ROOT_RESOLVED="$_DETECTED_HOST_ROOT"
    HOST_PROJECT_ROOT_SOURCE="docker-inspect"
  fi
fi

# Fallback cuối: ROOT_DIR (chỉ đúng khi chạy trực tiếp trên host).
if [ -z "$HOST_PROJECT_ROOT_RESOLVED" ]; then
  HOST_PROJECT_ROOT_RESOLVED="$ROOT_DIR"
  HOST_PROJECT_ROOT_SOURCE="root-dir-fallback"
fi

HOST_PROJECT_ROOT="$HOST_PROJECT_ROOT_RESOLVED"
export HOST_PROJECT_ROOT
unset _HOST_PROJECT_ROOT_FROM_ENV _HOST_PROJECT_ROOT_FROM_DOTENV \
      HOST_PROJECT_ROOT_RESOLVED _DETECTED_HOST_ROOT

if [ "${DC_VERBOSE:-0}" = "1" ]; then
  echo "  HOST_ROOT  : $HOST_PROJECT_ROOT  (source: $HOST_PROJECT_ROOT_SOURCE)"
fi

# ── ENV_FILE resolution ──────────────────────────────────────────
# Path tuyệt đối tới file env trong filesystem hiện tại (không phải host path).
# Cần để các compose YAML reference `env_file: ${ENV_FILE:-./.env}` resolve
# về đúng file trong container (vì --project-directory trỏ tới host path).
#
# Ưu tiên file resolved (placeholder ${X} đã thay rỗng) để khi service đọc
# `env_file` không còn warn "variable is not set" cho các placeholder dangling.
if [ -n "${DC_RESOLVED_ENV_FILE:-}" ] && [ -s "$DC_RESOLVED_ENV_FILE" ]; then
  export ENV_FILE="$DC_RESOLVED_ENV_FILE"
elif [ -f "$ROOT_DIR/.env" ]; then
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

# Repo Agent Launcher: launcher app (services/app) chạy trong compose.apps.yml
# với mặc định ENABLE_REPO_AGENT=true. Các ttyd slot KHÔNG còn là compose
# service tĩnh — chúng được manager spawn động bằng `docker run` (qua
# /var/run/docker.sock mount) khi user bấm Launch trên UI. Vì vậy ở đây
# không add `--profile repo-ttyd` (profile cũ đã bị bỏ cùng compose.repo-ttyd.yml).

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
  # NOTE: compose.repo-ttyd.yml đã bị xóa (refactor 2026-06).
  # 100 ttyd slot không còn là compose service tĩnh — manager (services/app)
  # spawn từng container động bằng `docker run` qua docker-runner.js. Lý do:
  # đơn giản hóa lifecycle, bỏ HOST_PROJECT_ROOT phức tạp khi gọi compose
  # in-container, dễ scale (1..N slot) mà không phải sinh lại YAML.
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

# ── Pre-flight: validate HOST_PROJECT_ROOT trên Docker daemon ────
# Chỉ chạy cho các lệnh "build/up/run/create" (cần resolve build context).
# Logic: thử mount path đó vào một throw-away container alpine. Nếu daemon
# không thấy path → sẽ fail; lúc đó ta tự fallback về ROOT_DIR (path trong
# container hoặc host trực tiếp) như nỗ lực cuối, rồi cảnh báo rõ.
needs_path_validation() {
  case "${1:-}" in
    up|run|create|build|start) return 0 ;;
    *) return 1 ;;
  esac
}

if needs_path_validation "${1:-}" \
   && command -v docker >/dev/null 2>&1 \
   && [ "$HOST_PROJECT_ROOT_SOURCE" != "docker-inspect" ]; then
  if ! docker run --rm --pull=never --entrypoint /bin/true \
        -v "$HOST_PROJECT_ROOT:/__cb_check__:ro" alpine 2>/dev/null; then
    echo "⚠️  HOST_PROJECT_ROOT='$HOST_PROJECT_ROOT' (source: $HOST_PROJECT_ROOT_SOURCE)" >&2
    echo "    không tồn tại / không truy cập được trên Docker daemon host." >&2
    if in_container; then
      _GROUND_TRUTH="$(detect_host_root_from_inspect 2>/dev/null || true)"
      if [ -n "$_GROUND_TRUTH" ] && [ "$_GROUND_TRUTH" != "$HOST_PROJECT_ROOT" ]; then
        echo "    → tự sửa thành ground truth từ docker inspect: $_GROUND_TRUTH" >&2
        HOST_PROJECT_ROOT="$_GROUND_TRUTH"
        export HOST_PROJECT_ROOT
        HOST_PROJECT_ROOT_SOURCE="docker-inspect-recover"
      else
        echo "    → không tìm được ground truth. Hãy export HOST_PROJECT_ROOT đúng path host trước khi chạy." >&2
        echo "    Ví dụ: HOST_PROJECT_ROOT=\"\$(pwd)\" bash docker-compose/scripts/dc.sh ..." >&2
        exit 1
      fi
      unset _GROUND_TRUTH
    else
      echo "    → đang chạy trên host nhưng path không tồn tại. Kiểm tra lại .env hoặc cd đúng project root." >&2
      exit 1
    fi
  fi
fi

# ── Execute ───────────────────────────────────────────────────
# --env-file: ưu tiên file resolved (đã thay placeholder rỗng) để Compose
#   không re-parse .env raw và in warning về các ${X} chưa set. Fallback về
#   .env raw nếu không có resolved file.
ENV_FILE_ARGS=()
if [ -n "${DC_RESOLVED_ENV_FILE:-}" ] && [ -s "$DC_RESOLVED_ENV_FILE" ]; then
  ENV_FILE_ARGS+=( --env-file "$DC_RESOLVED_ENV_FILE" )
elif [ -f "$ROOT_DIR/.env" ]; then
  ENV_FILE_ARGS+=( --env-file "$ROOT_DIR/.env" )
fi

# Compose v2 vẫn auto-load `.env` trong CWD nếu thấy — kể cả khi đã có
# --env-file. Để tránh nó re-parse `.env` raw (có placeholder ${X} chưa set
# ta đã collapse thành rỗng trong resolved file), ta đổi CWD tạm sang một
# thư mục không có `.env`. Tất cả path khác (-f, --project-directory,
# --env-file) đều tuyệt đối nên không bị ảnh hưởng.
_DC_TMP_CWD="$(mktemp -d -t dc-cwd.XXXXXX)"
cd "$_DC_TMP_CWD"

# Chạy compose. KHÔNG dùng `exec` để bash giữ quyền cleanup tempfile sau khi
# compose return. Compose trả về exit code → chuyển tiếp.
docker compose \
  "${ENV_FILE_ARGS[@]}" \
  "${FILES[@]}" \
  --project-directory "$HOST_PROJECT_ROOT" \
  --project-name "${PROJECT_NAME:-myapp}" \
  "${PROFILE_ARGS[@]}" \
  "$@"
_DC_EXIT=$?

# Cleanup tempfiles.
[ -n "${DC_RESOLVED_ENV_FILE:-}" ] && rm -f "$DC_RESOLVED_ENV_FILE"
[ -n "${_DC_TMP_CWD:-}" ] && [ -d "$_DC_TMP_CWD" ] && rmdir "$_DC_TMP_CWD" 2>/dev/null || true

exit $_DC_EXIT
