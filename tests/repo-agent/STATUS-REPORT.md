# Status Report — Repo Agent Launcher + TTYD Pool Fixes

**Run date:** 2026-05-31 (Asia/Ho_Chi_Minh)
**Test runner:** `node tests/repo-agent/mock-flow.test.js`
**Final result:** **62 / 62 PASS · 0 FAIL**

> Sandbox limitation: this environment has no Docker daemon, so runtime
> container tests (`docker exec ttyd-001 …`) cannot be executed in-place.
> Each Docker mock test in the prompt is therefore replaced with the
> nearest **logic-equivalent** simulation:
>
> - **Compose YAML invariants** — parsed line-by-line from the actual
>   `compose.repo-ttyd.yml` produced by the generator.
> - **Entrypoint behaviour** — exercised by running the same `jq +
>   manifest copy + chmod` logic in `/bin/sh` against a fixture filesystem.
> - **Launcher / lifecycle / close** — runs the real `launcher.js`
>   module against an in-memory Firebase mock and a stubbed
>   `child_process.execFile` that records git/dc.sh invocations.
>
> The full evidence log is `tests/repo-agent/last-run.log`.

---

## 1) Per-item status table (matches the prompt)

| Item | Status | Files changed | Test command | Result (evidence) |
|---|---|---|---|---|
| 1.1 Remove read-only repo mount in TTYD | **PASS** | `services/app/scripts/gen-ttyd-compose.js`, `docker-compose/compose.repo-ttyd.yml` (regenerated) | `node tests/repo-agent/mock-flow.test.js` | `Compose.repoMountWritable` — `:ro` count = 0 in compose file |
| 1.2 Sync repo path to `/repos/<provider>/<owner>/<repo>` | **PASS** | `gen-ttyd-compose.js`, `compose.repo-ttyd.yml`, `services/repo-agent-ttyd/entrypoint.sh`, (verified) `services/app/src/repo-store.js` | same | `Compose.repoMountPathRepos` (100/100), `RuntimeEnv.repoPathStartsWithRepos`, `RuntimeEnv.productionReposRootDefault`, `Slot.repoPathValid/RejectsBadPrefix/RejectsMissing`, entrypoint symlinks `/workspace → $REPO_AGENT_REPO_PATH` |
| 1.3 Copy Agent Credential file → `targetPath` (mode/perm) | **PASS** | `services/app/src/agent-creds.js`, `services/repo-agent-ttyd/entrypoint.sh` | same | `AgentCredential.materialize.envExtras`, `manifest.fileSchema` (canonical `{source, targetPath, mode}`), `Entrypoint.manifestCopy.jq`, `AgentCredential.copyToTargetPath`, `contentMatches`, `modeIs0600` |
| 1.4 Respect `startMode = shell \| agent` | **PASS** | `services/repo-agent-ttyd/entrypoint.sh`, (already-correct) `services/app/src/launcher.js` | same | `RuntimeEnv.startMode`, `StartMode.shell.doesNotAutoRunAgent`, `StartMode.agent.execAgent`, `StartMode.agent.fallbackOnMissing` |
| 1.5 TTYD slot `restart: "no"` | **PASS** | `gen-ttyd-compose.js`, `compose.repo-ttyd.yml` | same | `Compose.restartNo` — anchor `x-ttyd-base` declares `restart: "no"`, inherited by all 100 services via `<<: *ttyd-base` |
| 1.6 New `repo-agent-ttyd` image (git/node/jq/rg/fd + entrypoint) | **PASS** | NEW: `services/repo-agent-ttyd/Dockerfile`, `services/repo-agent-ttyd/entrypoint.sh`; updated `gen-ttyd-compose.js` default image | `sh -n services/repo-agent-ttyd/entrypoint.sh && node tests/...` | Dockerfile installs `bash, git, curl, ca-certificates, nodejs, npm, openssh-client-default, ripgrep, fd, jq, coreutils, tzdata`; compose default image = `repo-agent-ttyd:local` (`Compose.imageDefault`); fallback shell on missing agent CLI (`StartMode.agent.fallbackOnMissing`) |
| 1.7 Slim `.env.example`, push slot/image config to Firebase | **PASS** | `.env.example`, NEW: `services/app/src/repo-agent-config.js` | `grep -E "^REPO_AGENT_TOTAL_SLOTS=\|^REPO_AGENT_TTYD_IMAGE=" .env.example` (must be empty) + `node tests/...` | `.env.example` only keeps bootstrap vars (ENABLE/MANAGER\_HOST/MANAGER\_PORT/FIREBASE\_DATABASE\_URL/FIREBASE\_SERVICE\_ACCOUNT\_BASE64); `Config.fallbackPoolSize=100`, `Config.fallbackImage=repo-agent-ttyd:local`, `Config.firebaseOverridesPoolSize=25`, `Config.envOverridesPoolSize=5` |
| 2.1 mock Git flow | **PASS** | – (test only) | `node tests/repo-agent/mock-flow.test.js` | `GitCredential.add`, `GitCredential.test`, `GitCredential.fetchAccount`, `RepoCache.save` (count=2), `RepoCache.localPathUsesRepos` (`/repos/...`) |
| 2.2 mock Agent Credential flow | **PASS** | – (test only) | same | `AgentCredential.materialize.envExtras`, `manifest.exists`, `manifest.fileSchema`, `scripts.bootstrap`, `disabled.skipped`, `resolveByAgent`, `materialize`, `copyToTargetPath` |
| 2.3 mock Launcher flow | **PASS** | – (test only) | same | `Launcher.payloadOnlyRepoAndAgent`, `resolveGitCredentialFromRepo`, `resolveAgentCredentialsFromAgent`, `Slot.poolInitialized`, `RuntimeEnv.write`, `Ttyd.startService` (`dc.sh --profile repo-ttyd up -d --build --force-recreate ttyd-001` recorded) |
| 2.4 mock Slot lifecycle | **PASS** | – (test only) | same | `transition.initialFree`, `transition.afterLaunch=busy`, `freeToReserved`, `reservedToCloning`, `cloningToStarting`, `startingToBusy`, `busyToStopping`, `stoppingToFree` |
| 2.5 mock Close session | **PASS** | – (test only) | same | `Session.close.stopContainer` (`dc.sh rm -sf ttyd-001`), `removeContainer`, `deleteInjectedFiles`, `resetRuntimeEnv`, `sessionClosed`, `slotFree` |
| 2.6 Generated Compose | **PASS** | `gen-ttyd-compose.js`, `compose.repo-ttyd.yml` | same | `generate100Slots`, `repoMountWritable`, `repoMountPathRepos`, `restartNo`, `noHostPorts`, `subdomainLabels` (ttyd001 + ttyd100), `imageDefault` |

---

## 2) Files changed / created

### Created
- `services/repo-agent-ttyd/Dockerfile` — new image based on `tsl0922/ttyd:1.7.7-alpine` with bash/git/curl/node/npm/openssh-client/ripgrep/fd/jq/coreutils.
- `services/repo-agent-ttyd/entrypoint.sh` — replaces the inline `entrypoint:` block in compose. Loads `runtime.env`, validates repo path, applies AgentCredential manifest (copy → `targetPath`, `chmod`), runs bootstrap scripts, symlinks `/workspace`, respects `REPO_AGENT_START_MODE`, falls back gracefully when agent CLI is missing.
- `services/app/src/repo-agent-config.js` — reads `/repoAgent/config` from Firebase with hardcoded defaults (`ttydPoolSize=100`, `ttydImage=repo-agent-ttyd:local`, `workspacesRoot=/repos`, …); env vars `REPO_AGENT_TOTAL_SLOTS` / `REPO_AGENT_TTYD_IMAGE` act as escape-hatch overrides only.
- `tests/repo-agent/mock-flow.test.js` — 62-assertion test suite covering all flows.
- `tests/repo-agent/STATUS-REPORT.md` — this report.
- `tests/repo-agent/last-run.log` — full PASS/FAIL log of the latest test run.

### Modified
- `services/app/scripts/gen-ttyd-compose.js`
  - mount path → `/repos` (was `/workspace/repos:ro`)
  - removed `:ro` flag
  - `restart: "no"` (was `unless-stopped`)
  - default image → `repo-agent-ttyd:local` with `build: ../services/repo-agent-ttyd`
  - removed inline entrypoint hack — image's `ENTRYPOINT` does the work
  - added `REPO_AGENT_TOTAL_SLOTS` env-driven pool size knob (kept as escape hatch only)
- `docker-compose/compose.repo-ttyd.yml` — fully regenerated (1648 lines, 100 services). All invariants from 1.1/1.2/1.5 verified by parser tests.
- `services/app/src/agent-creds.js` — manifest schema standardized to `{source, targetPath, mode}` per the prompt's example, with backward-compatible `{hostPath, containerPath}` aliases retained.
- `.env.example` — removed `REPO_AGENT_TOTAL_SLOTS` and `REPO_AGENT_TTYD_IMAGE`, replaced with a comment block pointing at `/repoAgent/config` in Firebase. Bootstrap-only `REPO_AGENT_*` vars left in place.

---

## 3) How to reproduce locally

```bash
cd dockerstack-agents-ttyd/src-template

# Regenerate compose (idempotent)
node services/app/scripts/gen-ttyd-compose.js

# Quick syntax check on entrypoint
sh -n services/repo-agent-ttyd/entrypoint.sh

# Full mock test suite
node tests/repo-agent/mock-flow.test.js
```

Expected output ends with:

```
Total: 62    PASS: 62    FAIL: 0
```

---

## 4) Production-only checks (require Docker)

The following checks **cannot** be executed inside this sandbox but are
ready to run on a host with Docker. They mirror the mock-test
assertions one-for-one:

```bash
# Build the new image
docker build -t repo-agent-ttyd:local services/repo-agent-ttyd

# Verify tools inside the image
docker run --rm repo-agent-ttyd:local sh -lc \
  'git --version && node --version && npm --version && rg --version && jq --version'

# Validate that compose declares restart=no on every slot
docker compose -f docker-compose/compose.repo-ttyd.yml config --no-interpolate \
  | python3 -c '
import sys, yaml
d = yaml.safe_load(sys.stdin)
bad = [k for k,v in d["services"].items() if v.get("restart") != "no"]
print("OK" if not bad else "FAIL " + ",".join(bad))
'

# After launching slot 001 via the manager:
docker exec repo-agent-ttyd-001 sh -lc \
  'cd "$REPO_AGENT_REPO_PATH" && echo write-test > .repo-agent-write-test && test -f .repo-agent-write-test'
docker exec repo-agent-ttyd-001 sh -lc \
  'test -d "$REPO_AGENT_REPO_PATH"'
docker exec repo-agent-ttyd-001 sh -lc \
  'test "$(readlink /workspace)" = "$REPO_AGENT_REPO_PATH"'
docker exec repo-agent-ttyd-001 sh -lc \
  'test -f /home/coder/.codex/config.toml'
```

Each command above corresponds to a logic-equivalent mock assertion in
`tests/repo-agent/mock-flow.test.js`, all of which currently PASS.

---

## 5) Definition of Done — checklist

- [x] Repo mount in TTYD writeable (no `:ro` on repo volumes).
- [x] Repo path unified at `/repos/<provider>/<owner>/<repo>` in both manager and ttyd.
- [x] Agent Credential `file` copied to its `targetPath` with correct `mode`.
- [x] `startMode=shell` does NOT auto-run the agent.
- [x] `startMode=agent` execs the agent command directly.
- [x] TTYD slot services declare `restart: "no"`.
- [x] Dedicated `repo-agent-ttyd` image, with explicit fallback when the agent CLI is missing.
- [x] `.env.example` only retains bootstrap variables; pool/image config moved to Firebase `/repoAgent/config`.
- [x] All mock business-flow tests (Git, AgentCred, Launcher, Lifecycle, Close, Compose, Config) PASS.
- [x] Status report present (this file) with concrete commands and evidence.
