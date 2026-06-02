// src/launcher.js — TTYD slot allocation + lifecycle
//
// 100 slot tĩnh: 001..100. Mỗi slot ánh xạ đến container "repo-agent-ttyd-<slot>"
// và service compose "ttyd-<slot>" trong compose.repo-ttyd.yml.
// Container chỉ được start khi user bấm Launch.

"use strict";

const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const fb = require("./firebase");
const { genId, nowIso, pad3 } = require("./util");
const repoStore = require("./repo-store");
const agentCreds = require("./agent-creds");

const TOTAL_SLOTS = parseInt(process.env.REPO_AGENT_TOTAL_SLOTS || "100", 10);
const DOMAIN = process.env.DOMAIN || "localhost";
const PROJECT_ROOT = process.env.REPO_AGENT_PROJECT_ROOT || path.resolve(__dirname, "../../.."); // /workspace
const DC_SCRIPT = process.env.REPO_AGENT_DC_SCRIPT || path.join(PROJECT_ROOT, "docker-compose/scripts/dc.sh");

function slotName(slot) {
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
        if (!cur || cur.status !== "free") return; // abort: race
        cur.status = "reserved";
        cur.sessionId = sessionId;
        cur.updatedAt = nowIso();
        return cur;
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

// ── Compose actions ───────────────────────────────────────────────

function runDc(args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      "bash",
      [DC_SCRIPT, ...args],
      {
        cwd: PROJECT_ROOT,
        env: process.env,
        maxBuffer: 32 * 1024 * 1024,
        ...opts,
      },
      (err, stdout, stderr) => {
        if (err) {
          err.stdout = stdout;
          err.stderr = stderr;
          return reject(err);
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

async function startSlotContainer(slot) {
  // bash docker-compose/scripts/dc.sh --profile repo-ttyd up -d --build --force-recreate ttyd-<slot>
  return runDc(["--profile", "repo-ttyd", "up", "-d", "--build", "--force-recreate", slotName(slot)]);
}

async function stopSlotContainer(slot) {
  return runDc(["--profile", "repo-ttyd", "rm", "-sf", slotName(slot)]).catch(() => null);
}

// ── Launch flow ───────────────────────────────────────────────────

async function launch({ repoId, agentProfileId, branch }) {
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
  const myCreds = Object.values(allCreds).filter((c) => c && c.agentProfileId === agentProfileId && c.enabled !== false);

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
    await startSlotContainer(slot);

    await setSlotStatus(slot, "busy", {
      lastSessionId: sessionId,
    });
    await fb.updatePath(`/repoAgent/sessions/${sessionId}`, {
      status: "running",
      startedAt: nowIso(),
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
};
