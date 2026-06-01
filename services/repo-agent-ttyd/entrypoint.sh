#!/bin/sh
# ================================================================
#  repo-agent-ttyd entrypoint
#
#  Trách nhiệm:
#    1. Load /slot/runtime.env (nếu có).
#    2. Validate REPO_AGENT_REPO_PATH bắt đầu bằng "/repos/" và tồn tại.
#    3. Apply AgentCredentials manifest (copy file → targetPath, chmod, run script).
#    4. Symlink /workspace -> $REPO_AGENT_REPO_PATH (writable).
#    5. Tôn trọng REPO_AGENT_START_MODE:
#         shell  → mở bash, in banner, không tự chạy agent
#         agent  → exec agent command thẳng
#    6. Nếu agent command not found → fallback shell + cảnh báo.
#
#  Biến quan trọng:
#    REPO_AGENT_SLOT_DIR        (default /slot)
#    REPO_AGENT_REPO_PATH       (bắt buộc cho launch — phải bắt đầu /repos/)
#    REPO_AGENT_START_MODE      shell | agent  (default shell)
#    REPO_AGENT_AGENT_COMMAND   ví dụ: codex / claude / opencode / agy / bash
#    REPO_AGENT_AGENT_ARGS      tham số bổ sung
# ================================================================

set -u

SLOT_DIR="${REPO_AGENT_SLOT_DIR:-/slot}"
INJECTED_DIR="${SLOT_DIR}/injected-files"
RUNTIME_ENV="${SLOT_DIR}/runtime.env"
TTYD_PORT="${REPO_AGENT_TTYD_PORT:-7681}"

log() { printf '[repo-agent-ttyd] %s\n' "$*" >&2; }

# ── 1) Load runtime.env ────────────────────────────────────────────
if [ -f "$RUNTIME_ENV" ]; then
  log "loading $RUNTIME_ENV"
  set -a
  # shellcheck disable=SC1090
  . "$RUNTIME_ENV"
  set +a
else
  log "WARN: $RUNTIME_ENV not found; running with current environment only"
fi

START_MODE="${REPO_AGENT_START_MODE:-shell}"
AGENT_COMMAND="${REPO_AGENT_AGENT_COMMAND:-bash}"
AGENT_ARGS="${REPO_AGENT_AGENT_ARGS:-}"
REPO_PATH="${REPO_AGENT_REPO_PATH:-}"

# ── 2) Validate repo path ──────────────────────────────────────────
validate_repo_path() {
  if [ -z "$REPO_PATH" ]; then
    log "WARN: REPO_AGENT_REPO_PATH is empty — falling back to /workspace"
    return 1
  fi
  case "$REPO_PATH" in
    /repos/*) : ;;
    *)
      log "ERROR: REPO_AGENT_REPO_PATH must start with /repos/ — got: $REPO_PATH"
      return 2
      ;;
  esac
  if [ ! -d "$REPO_PATH" ]; then
    log "ERROR: REPO_AGENT_REPO_PATH does not exist in container: $REPO_PATH"
    log "  Hint: check that the manager mounted /repos volume read-write"
    log "        and that 'repo-store.cloneOrPull' completed successfully."
    return 3
  fi
  return 0
}

REPO_PATH_OK=0
if validate_repo_path; then
  REPO_PATH_OK=1
fi

# ── 3) Apply AgentCredentials manifest ─────────────────────────────
apply_manifest() {
  manifest="${INJECTED_DIR}/_manifest.json"
  if [ ! -f "$manifest" ]; then
    log "no manifest at $manifest — skipping credential injection"
    return 0
  fi
  if ! command -v jq >/dev/null 2>&1; then
    log "WARN: jq not found — cannot parse manifest"
    return 0
  fi

  # Copy files into their targetPath (read mapping array of {source,targetPath,mode})
  count_files=$(jq '.files | length' "$manifest" 2>/dev/null || echo 0)
  if [ "$count_files" -gt 0 ] 2>/dev/null; then
    i=0
    while [ "$i" -lt "$count_files" ]; do
      src=$(jq -r ".files[$i].source // .files[$i].hostPath // empty" "$manifest")
      tgt=$(jq -r ".files[$i].targetPath // empty" "$manifest")
      mode=$(jq -r ".files[$i].mode // \"0600\"" "$manifest")
      if [ -n "$src" ] && [ -n "$tgt" ] && [ -f "$src" ]; then
        mkdir -p "$(dirname "$tgt")" 2>/dev/null || true
        if cp "$src" "$tgt"; then
          chmod "$mode" "$tgt" 2>/dev/null || true
          log "credential file: $src -> $tgt (mode $mode)"
        else
          log "WARN: failed to copy $src -> $tgt"
        fi
      fi
      i=$((i + 1))
    done
  fi

  # Run bootstrap scripts in name order
  for s in "$INJECTED_DIR"/bootstrap-*.sh; do
    [ -f "$s" ] || continue
    log "running bootstrap script: $s"
    sh "$s" || log "WARN: bootstrap script failed: $s"
  done
}

apply_manifest

# ── 4) Symlink /workspace → repo path ─────────────────────────────
if [ "$REPO_PATH_OK" -eq 1 ]; then
  # Replace /workspace with a symlink to the repo so any tool that defaults
  # to /workspace lands in the right place. /workspace must NOT be a
  # bind-mount target — Dockerfile uses it as a normal dir.
  if [ -L /workspace ] || [ -d /workspace ]; then
    rm -rf /workspace 2>/dev/null || true
  fi
  ln -s "$REPO_PATH" /workspace
  log "/workspace -> $REPO_PATH"
  cd /workspace || cd "$REPO_PATH" || cd /
else
  cd /workspace 2>/dev/null || cd /
fi

# ── 5) Resolve agent command ───────────────────────────────────────
AGENT_BIN=$(printf '%s' "$AGENT_COMMAND" | awk '{print $1}')
AGENT_FOUND=0
if [ -n "$AGENT_BIN" ] && command -v "$AGENT_BIN" >/dev/null 2>&1; then
  AGENT_FOUND=1
fi

# ── 6) Launch ──────────────────────────────────────────────────────
case "$START_MODE" in
  agent)
    if [ "$AGENT_FOUND" -eq 1 ]; then
      log "startMode=agent — exec: $AGENT_COMMAND $AGENT_ARGS"
      exec ttyd -W -p "$TTYD_PORT" bash -lc "cd /workspace && exec $AGENT_COMMAND $AGENT_ARGS"
    else
      log "startMode=agent but '$AGENT_BIN' NOT FOUND — falling back to shell"
      log "  Install the agent CLI via AgentCredential type=script,"
      log "  or build a custom image FROM repo-agent-ttyd:* with the CLI."
      exec ttyd -W -p "$TTYD_PORT" bash -lc \
        "cd /workspace && \
         echo '⚠️  Agent CLI not found: $AGENT_BIN' && \
         echo 'Run command manually after installing it.' && \
         exec bash"
    fi
    ;;
  shell|*)
    if [ "$AGENT_FOUND" -eq 1 ]; then
      exec ttyd -W -p "$TTYD_PORT" bash -lc \
        "cd /workspace && \
         echo '✅ Repo Agent session ready.' && \
         echo '   Repo : ${REPO_AGENT_REPO_FULL_NAME:-?} @ ${REPO_AGENT_BRANCH:-?}' && \
         echo '   Path : ${REPO_PATH:-/workspace}' && \
         echo '   Run  : $AGENT_COMMAND $AGENT_ARGS' && \
         exec bash"
    else
      exec ttyd -W -p "$TTYD_PORT" bash -lc \
        "cd /workspace && \
         echo '✅ Repo Agent session ready (shell mode).' && \
         echo '   Repo : ${REPO_AGENT_REPO_FULL_NAME:-?} @ ${REPO_AGENT_BRANCH:-?}' && \
         echo '   Path : ${REPO_PATH:-/workspace}' && \
         echo '⚠️  Agent CLI not found: $AGENT_BIN — install it before running.' && \
         exec bash"
    fi
    ;;
esac
