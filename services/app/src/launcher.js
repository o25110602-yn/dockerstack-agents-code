// src/launcher.js — TTYD slot allocation + lifecycle
//
// Refactored: bỏ compose service tĩnh + dc.sh. Mỗi slot bây giờ là 1 container
// được manager spawn trực tiếp bằng `docker run` qua module docker-runner.
//
// Slot pool: 100 slot tĩnh 001..100 (cấu hình qua REPO_AGENT_TOTAL_SLOTS).
// Mỗi slot ánh xạ:
//   - container name : repo-agent-ttyd-<slot>
//   - URL            : https://ttyd<slot>.${DOMAIN}    (subdomain không có dấu gạch)
//
// Container chỉ start khi user bấm Launch. Khi close → docker rm -f.

"use strict";

const fb = require("./firebase");
const { genId, nowIso, pad3 } = require("./util");
const repoStore = require("./repo-store");
const agentCreds = require("./agent-creds");
const dockerRunner = require("./docker-runner");

const TOTAL_SLOTS = parseInt(process.env.REPO_AGENT_TOTAL_SLOTS || "100", 10);
const DOMAIN = process.env.DOMAIN || "localhost";

function slotName(slot) {
  // Backward-compat helper used by other modules (server admin endpoints +
  // tests). Pattern giữ nguyên "ttyd-<NNN>" để Firebase data cũ không bị break.
  return `ttyd-${slot}`;
}
function containerName(slot) {
  return `repo-agent-ttyd-${slot}`;
}
function slotHost(slot) {
  return `ttyd${slot}.${DOMAIN}`;
}
function slotUrl(slot) {
  return `https://${slotHost(slot)}`;
}

// ── Slot pool init ────────────────────────────────────────────────

async function ensureSlotPoolInitialized() {
  const existing = (await fb.readPath("/repoAgent/ttydSlots")) || {};
  const updates = {};
  for (let i = 1; i <= TOTAL_SLOTS; i += 1) {
    const slot = pad3(i);
    if (!existing[slot]) {
      updates[slot] = {
        slot,
        name: slotName(slot),
        // serviceName giữ field cũ để backward-compat, dù không còn dùng để
        // gọi compose.
        serviceName: slotName(slot),
        containerName: containerName(slot),
        host: slotHost(slot),
        url: slotUrl(slot),
        status: "free",
        sessionId: null,
        updatedAt: nowIso(),
      };
    }
  }
  if (Object.keys(updates).length > 0) {
    await fb.updatePath("/repoAgent/ttydSlots", updates);
  }
}

// ── Reserve / release ─────────────────────────────────────────────

async function reserveFreeSlot(sessionId) {
  await ensureSlotPoolInitialized();

  // Random hóa thứ tự slot để giảm contention khi nhiều user launch đồng thời.
  const order = [];
  for (let i = 1; i <= TOTAL_SLOTS; i += 1) order.push(pad3(i));
  for (let i = order.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }

  const failures = []; // chi tiết để debug
  let freeSeen = 0;

  for (const slot of order) {
    const ref = fb.db().ref(`/repoAgent/ttydSlots/${slot}`);

    // Pre-fetch để warm cache — tránh transaction abort do cur===null lần đầu
    let cur0;
    try {
      const snap = await ref.once("value");
      cur0 = snap.val();
    } catch (err) {
      failures.push({ slot, reason: "pre-read-failed", err: String(err.message || err) });
      continue;
    }
    if (!cur0) {
      failures.push({ slot, reason: "missing-in-db" });
      continue;
    }
    if (cur0.status !== "free") {
      // không log spam — chỉ slot busy là chuyện bình thường
      continue;
    }
    freeSeen += 1;

    // Atomic CAS — applyLocally:false để callback luôn nhận server-truth.
    let tx;
    try {
      tx = await ref.transaction((cur) => {
        const data = cur || cur0;
        if (!data || data.status !== "free") return; // abort: race
        data.status = "reserved";
        data.sessionId = sessionId;
        data.updatedAt = nowIso();
        return data;
      }, undefined, false);
    } catch (err) {
      failures.push({ slot, reason: "tx-threw", err: String(err.message || err) });
      continue;
    }

    if (tx && tx.committed && tx.snapshot && tx.snapshot.val()) {
      return tx.snapshot.val();
    }
    failures.push({
      slot,
      reason: "tx-not-committed",
      committed: !!(tx && tx.committed),
    });
    // race lost → thử slot tiếp theo
  }

  // Build error rõ ràng để debug
  const detail = JSON.stringify({
    totalSlots: TOTAL_SLOTS,
    freeSeen,
    failureCount: failures.length,
    sample: failures.slice(0, 5),
  });
  throw new Error(`No free TTYD slot available (${detail})`);
}

async function setSlotStatus(slot, status, patch = {}) {
  const updates = { status, updatedAt: nowIso(), ...patch };
  await fb.updatePath(`/repoAgent/ttydSlots/${slot}`, updates);
}

// ── Container actions ─────────────────────────────────────────────
// Trước đây gọi `bash dc.sh --profile repo-ttyd up -d ttyd-XXX`. Giờ gọi
// docker-runner trực tiếp → đơn giản, dễ debug, không cần resolve
// HOST_PROJECT_ROOT/--env-file/--profile dài dòng.

async function startSlotContainer(slot) {
  const runtime = dockerRunner.resolveRuntimeConfig();
  const hostPaths = dockerRunner.hostPathsForSlot(slot, runtime);
  return dockerRunner.runSlotContainer(slot, {
    containerName: containerName(slot),
    image: runtime.image,
    network: runtime.network,
    domain: runtime.domain,
    tinyauthPort: runtime.tinyauthPort,
    memory: runtime.memory,
    memorySwap: runtime.memorySwap,
    cpus: runtime.cpus,
    pidsLimit: runtime.pidsLimit,
    ttydPort: runtime.ttydPort,
    hostReposRoot: hostPaths.hostReposRoot,
    hostSlotRoot: hostPaths.hostSlotRoot,
  });
}

async function stopSlotContainer(slot) {
  return dockerRunner.removeSlotContainer(slot, {
    containerName: containerName(slot),
  });
}

const DEFAULT_AGY_SETTINGS_TEMPLATE = `{
  // ── Giao diện ──────────────────────────────────────────────────
  // colorScheme: "terminal" | "dark" | "light" | "solarized dark" | "solarized light"
  //              "colorblind-friendly dark" | "colorblind-friendly light" | "tokyo night"
  // "terminal" = dùng màu sẵn có của terminal, không override gì cả → skip màn hình chọn
  "colorScheme": "terminal",

  // renderingMode: "alt-screen" (full-screen TUI) | "inline" (stream vào history terminal)
  "renderingMode": "alt-screen",

  // ── Quyền thực thi (YOLO / fine-grained) ──────────────────────
  // Cách 1 — Toàn bộ tự approve (dùng khi chạy trong sandbox an toàn):
  //   Tương đương flag \`agy --dangerously-skip-permissions\`
  "autoApprove": "all",

  // Cách 2 — Whitelist từng lệnh/path (khuyến nghị cho production):
  // "permissions": {
  //   "allow": [
  //     // Cho phép toàn bộ lệnh git
  //     "command(git)",
  //     // Cho phép npm/node
  //     "command(npm)",
  //     "command(node)",
  //     "command(npx)",
  //     // Cho phép đọc/ghi trong thư mục làm việc
  //     "read_file(**)",
  //     "write_file(**)",
  //     "edit_file(**)"
  //     // Ví dụ thêm path cụ thể:
  //     // "read_file(/workspace)",
  //     // "command(python3)"
  //   ],
  //   "deny": [
  //     // Chặn các lệnh nguy hiểm
  //     "command(rm -rf /)",
  //     "command(sudo rm)",
  //     "command(mkfs)",
  //     "command(dd)"
  //   ]
  // },

  // ── Model ──────────────────────────────────────────────────────
  // Model mặc định khi khởi động. Có thể đổi trong session bằng /model
  // Ví dụ: "gemini-3-5-flash" | "gemini-3-pro" | "claude-opus-4-6" | ...
  // Để trống = dùng default của CLI (Gemini 3.5 Flash Medium)
  // "model": "gemini-3-5-flash",

  // ── Workspace & project discovery ─────────────────────────────
  // Cho phép truy cập file ngoài workspace hiện tại
  "allowNonWorkspaceAccess": true,

  // ── Telemetry ─────────────────────────────────────────────────
  // false = tắt gửi dữ liệu usage về Google
  "enableTelemetry": false,

  // ── Sandbox (Terminal Sandbox) ────────────────────────────────
  // Bật sandbox OS-level khi AI thực thi shell commands:
  //   Linux  → nsjail
  //   macOS  → sandbox-exec
  // Nên bật nếu chạy agy --dangerously-skip-permissions
  // "sandbox": true,

  // ── LaTeX rendering ───────────────────────────────────────────
  // false = tắt render công thức LaTeX trong terminal (dùng khi terminal không hỗ trợ)
  // Tương đương env: AGY_CLI_DISABLE_LATEX=1
  // "enableLatex": false,

  // ── Account info header ───────────────────────────────────────
  // Ẩn email và plan tier khỏi header của CLI
  // Tương đương env: AGY_CLI_HIDE_ACCOUNT_INFO=1
  // "hideAccountInfo": false,

  // ── Subagents ────────────────────────────────────────────────
  // Giới hạn số subagent chạy song song (mặc định không giới hạn)
  // "maxSubagents": 3,

  // ── Custom status line ────────────────────────────────────────
  // Script nhận JSON metadata (CWD, model, token usage, state...) để tạo status bar
  // "statusLineScript": "/path/to/your/status-script.sh",

  // ── MCP Servers ───────────────────────────────────────────────
  // Khai báo MCP servers để dùng tools bên ngoài
  // "mcpServers": {
  //   "my-server": {
  //     "command": "node",
  //     "args": ["/path/to/mcp-server.js"],
  //     "env": {}
  //   }
  // }
}`;

// ── Launch flow ───────────────────────────────────────────────────

async function launch({ repoId, agentProfileId, branch, agentCredentialIds }) {
  if (!repoId) throw new Error("repoId is required");
  if (!agentProfileId) throw new Error("agentProfileId is required");

  const repo = await fb.readPath(`/repoAgent/repoCache/${repoId}`);
  if (!repo) throw new Error(`Repo not found: ${repoId}`);

  const gitCred = await fb.readPath(`/repoAgent/gitCredentials/${repo.gitCredentialId}`);
  if (!gitCred) {
    throw new Error(`Git credential not found: ${repo.gitCredentialId}`);
  }
  if (gitCred.enabled === false) {
    throw new Error("Git credential is disabled");
  }

  const agentProfile = await fb.readPath(`/repoAgent/agentProfiles/${agentProfileId}`);
  if (!agentProfile) {
    throw new Error(`Agent profile not found: ${agentProfileId}`);
  }
  if (agentProfile.enabled === false) {
    throw new Error("Agent profile is disabled");
  }

  // Filter agent credentials for this profile.
  const allCreds = (await fb.readPath("/repoAgent/agentCredentials")) || {};
  let myCreds = Object.values(allCreds).filter((c) => c && c.agentProfileId === agentProfileId && c.enabled !== false);

  if (Array.isArray(agentCredentialIds)) {
    myCreds = myCreds.filter((c) => agentCredentialIds.includes(c.id));
  }

  // Allocate session id first so slot.sessionId is meaningful.
  const sessionId = genId("sess");

  const slotEntry = await reserveFreeSlot(sessionId);
  const slot = slotEntry.slot;

  try {
    await setSlotStatus(slot, "cloning");

    // 1) Clone or pull repo using git credential.
    const { localPath } = await repoStore.cloneOrPull({
      repo,
      gitCredential: gitCred,
    });
    const useBranch = branch || repo.defaultBranch || "main";

    // 2) Materialize agent credentials into slot folder.
    const mat = agentCreds.materializeForSlot(slot, myCreds);

    // 2.5) If agentProfile has settingsPath & settingsTemplate (e.g. for agy), write it to slot injected-files and update _manifest.json
    let settingsPath = agentProfile.settingsPath;
    let settingsTemplate = agentProfile.settingsTemplate;

    if (agentProfile.name === "agy") {
      if (!settingsPath) {
        settingsPath = "~/.gemini/antigravity-cli/settings.json";
      }
      if (!settingsTemplate) {
        settingsTemplate = DEFAULT_AGY_SETTINGS_TEMPLATE;
      }
    }

    if (settingsPath && settingsTemplate) {
      const fs = require("fs");
      const path = require("path");
      const slotDir = agentCreds.slotDir(slot);
      const slotInjectedDir = path.join(slotDir, "injected-files");
      const safe = "agy-settings.json";
      const hostFile = path.join(slotInjectedDir, "files", safe);
      fs.mkdirSync(path.dirname(hostFile), { recursive: true });
      fs.writeFileSync(hostFile, settingsTemplate, { mode: 0o600 });

      // Resolve ~ to /root for the container target path
      let targetPath = settingsPath;
      if (targetPath.startsWith("~/")) {
        targetPath = "/root/" + targetPath.substring(2);
      } else if (targetPath === "~") {
        targetPath = "/root";
      }

      // Read manifest, push new file, and write back
      const manifestPath = path.join(slotInjectedDir, "_manifest.json");
      let manifest = { files: [], scripts: [], envExtras: {} };
      if (fs.existsSync(manifestPath)) {
        try {
          manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
        } catch (e) {
          // ignore
        }
      }
      manifest.files = manifest.files || [];
      manifest.files.push({
        source: path.posix.join("/slot/injected-files/files", safe),
        targetPath: targetPath,
        mode: "0600",
        name: "agy settings",
        hostPath: hostFile,
        containerPath: targetPath,
      });
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), { mode: 0o600 });
    }

    const token = Buffer.from(gitCred.tokenBase64 || "", "base64").toString("utf8");
    let gitHost = "";
    if (repo.cloneUrl && repo.cloneUrl.startsWith("http")) {
      try {
        const u = new URL(repo.cloneUrl);
        gitHost = u.host;
      } catch (e) {
        // ignore
      }
    }
    if (!gitHost) {
      if (repo.provider === "github") gitHost = "github.com";
      else if (repo.provider === "gitlab") gitHost = "gitlab.com";
      else if (repo.provider === "azure") gitHost = "dev.azure.com";
    }

    let gitUser = gitCred.username || "";
    if (!gitUser) {
      if (repo.provider === "github") gitUser = "x-access-token";
      else if (repo.provider === "gitlab") gitUser = "oauth2";
      else gitUser = "x-access-token";
    }

    // 3) Write runtime.env for slot.
    const runtimeEnv = {
      REPO_AGENT_SESSION_ID: sessionId,
      REPO_AGENT_SLOT: slot,
      REPO_AGENT_REPO_ID: repo.id,
      REPO_AGENT_REPO_PATH: localPath,
      REPO_AGENT_REPO_FULL_NAME: repo.fullName,
      REPO_AGENT_BRANCH: useBranch,
      REPO_AGENT_AGENT_PROFILE_ID: agentProfileId,
      REPO_AGENT_AGENT_NAME: agentProfile.name || "agent",
      REPO_AGENT_AGENT_LABEL: agentProfile.label || agentProfile.name || "agent",
      REPO_AGENT_AGENT_COMMAND: agentProfile.command || "bash",
      REPO_AGENT_AGENT_ARGS: agentProfile.args || "",
      REPO_AGENT_AGENT_WORKDIR: agentProfile.workdir || "/workspace",
      REPO_AGENT_START_MODE: agentProfile.startMode || "shell",
      REPO_AGENT_GIT_PROVIDER: repo.provider || "",
      REPO_AGENT_GIT_USERNAME: gitUser,
      REPO_AGENT_GIT_TOKEN: token || "",
      REPO_AGENT_GIT_HOST: gitHost || "",
      ...mat.envExtras,
    };
    agentCreds.writeRuntimeEnv(slot, runtimeEnv);

    // 4) Save session.
    await setSlotStatus(slot, "starting");
    const session = {
      id: sessionId,
      slot,
      repoId: repo.id,
      repoFullName: repo.fullName,
      branch: useBranch,
      agentProfileId,
      agentName: agentProfile.name || "agent",
      url: slotUrl(slot),
      status: "starting",
      createdAt: nowIso(),
    };
    await fb.writePath(`/repoAgent/sessions/${sessionId}`, session);

    // 5) Start container.
    const runResult = await startSlotContainer(slot);

    await setSlotStatus(slot, "busy", {
      lastSessionId: sessionId,
      containerId: runResult && runResult.containerId,
    });
    await fb.updatePath(`/repoAgent/sessions/${sessionId}`, {
      status: "running",
      startedAt: nowIso(),
      containerId: runResult && runResult.containerId,
    });

    return { sessionId, slot, url: slotUrl(slot), session };
  } catch (err) {
    // Roll back to free if anything fails.
    await setSlotStatus(slot, "error").catch(() => null);
    await fb
      .updatePath(`/repoAgent/sessions/${sessionId}`, {
        status: "error",
        error: String(err.message || err),
      })
      .catch(() => null);
    // Best effort: free the slot back if container never started.
    await stopSlotContainer(slot).catch(() => null);
    await setSlotStatus(slot, "free", { sessionId: null }).catch(() => null);
    throw err;
  }
}

async function closeSession(sessionId) {
  const session = await fb.readPath(`/repoAgent/sessions/${sessionId}`);
  if (!session) throw new Error(`Session not found: ${sessionId}`);

  const slot = session.slot;
  await setSlotStatus(slot, "stopping");
  await stopSlotContainer(slot);
  agentCreds.clearSlotInjectedFiles(slot);
  agentCreds.resetSlotRuntimeEnv(slot);
  await setSlotStatus(slot, "free", { sessionId: null });
  await fb.updatePath(`/repoAgent/sessions/${sessionId}`, {
    status: "closed",
    closedAt: nowIso(),
  });
  return { sessionId, slot, status: "closed" };
}

async function checkAndReleaseInterruptedSlots() {
  await ensureSlotPoolInitialized();
  const all = (await fb.readPath("/repoAgent/ttydSlots")) || {};
  const released = [];
  for (const [slot, cur] of Object.entries(all)) {
    if (!cur || cur.status !== "busy") continue;
    try {
      const inspect = await dockerRunner.inspectSlotContainer(slot).catch(() => ({ exists: false }));
      if (!inspect.exists || !inspect.running) {
        // Container is not running, but status is busy in DB -> Interrupted!
        await stopSlotContainer(slot).catch(() => null);
        agentCreds.clearSlotInjectedFiles(slot);
        agentCreds.resetSlotRuntimeEnv(slot);
        if (cur.sessionId) {
          await fb
            .updatePath(`/repoAgent/sessions/${cur.sessionId}`, {
              status: "interrupted",
              closedAt: nowIso(),
              closedReason: "container-not-running",
            })
            .catch(() => null);
        }
        await setSlotStatus(slot, "free", { sessionId: null });
        released.push(slot);
      }
    } catch (err) {
      // ignore
    }
  }
  return released;
}

async function releaseAllSlotsOnStart() {
  await ensureSlotPoolInitialized();
  const all = (await fb.readPath("/repoAgent/ttydSlots")) || {};
  const reset = [];
  for (const [slot, cur] of Object.entries(all)) {
    if (!cur || cur.status === "free") continue;
    try {
      await stopSlotContainer(slot).catch(() => null);
      agentCreds.clearSlotInjectedFiles(slot);
      agentCreds.resetSlotRuntimeEnv(slot);
      if (cur.sessionId) {
        await fb
          .updatePath(`/repoAgent/sessions/${cur.sessionId}`, {
            status: "forced-closed",
            closedAt: nowIso(),
            closedReason: "server-boot-reset",
          })
          .catch(() => null);
      }
      await setSlotStatus(slot, "free", { sessionId: null });
      reset.push(slot);
    } catch (err) {
      // ignore
    }
  }
  return reset;
}

module.exports = {
  TOTAL_SLOTS,
  ensureSlotPoolInitialized,
  reserveFreeSlot,
  setSlotStatus,
  startSlotContainer,
  stopSlotContainer,
  launch,
  closeSession,
  slotName,
  containerName,
  slotUrl,
  slotHost,
  checkAndReleaseInterruptedSlots,
  releaseAllSlotsOnStart,
};
