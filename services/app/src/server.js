// src/server.js — Repo Agent Launcher UI HTTP server
//
// Routes:
//   GET  /api/health
//   GET  /api/health/ready
//
//   Git Credentials (admin)
//   GET    /api/git-credentials
//   POST   /api/git-credentials                       create
//   POST   /api/git-credentials/:id/test              fetch account + repos preview
//   POST   /api/git-credentials/:id/refresh-repos     refresh repo cache
//   PATCH  /api/git-credentials/:id                   update (enable/disable, name)
//   DELETE /api/git-credentials/:id
//
//   Repo cache (admin + launcher)
//   GET    /api/repos                                 list (Launcher uses this)
//   PATCH  /api/repos/:id                             update favorite/enabled
//
//   Agent Profiles
//   GET    /api/agent-profiles
//   POST   /api/agent-profiles
//   PATCH  /api/agent-profiles/:id
//   DELETE /api/agent-profiles/:id
//
//   Agent Credentials
//   GET    /api/agent-credentials
//   POST   /api/agent-credentials
//   PATCH  /api/agent-credentials/:id
//   DELETE /api/agent-credentials/:id
//
//   Slot pool
//   GET    /api/slots
//
//   Sessions / Launch
//   POST   /api/launch                                { repoId, agentProfileId }
//   POST   /api/sessions/:id/close
//   GET    /api/sessions
//
//   Static
//   GET    /                                          Launcher UI (public/index.html)
//   GET    /admin                                     Admin UI (public/admin.html)

"use strict";

const express = require("express");
const path = require("path");
const fs = require("fs");
const fb = require("./firebase");
const { genId, nowIso, toBase64, maskToken } = require("./util");
const gitProviders = require("./git-providers");
const launcher = require("./launcher");
const { DEFAULT_AGY_SETTINGS_TEMPLATE } = require("./agy-settings-template");

const PORT = parseInt(process.env.PORT || "54100", 10);
const ENABLE_REPO_AGENT = String(process.env.ENABLE_REPO_AGENT || "true").toLowerCase() === "true";

const LOG_DIR = process.env.LOG_DIR || "/app/logs";
fs.mkdirSync(LOG_DIR, { recursive: true });

function log(level, msg, extra) {
  const line = JSON.stringify({
    t: nowIso(),
    level,
    msg,
    ...(extra || {}),
  });
  console.log(line);
  try {
    fs.appendFileSync(path.join(LOG_DIR, "app.log"), line + "\n");
  } catch {
    /* ignore */
  }
}

const app = express();
app.use(express.json({ limit: "20mb" }));
app.disable("x-powered-by");

app.use((req, res, next) => {
  log("info", "request", { method: req.method, url: req.url });
  next();
});

// ── Health ─────────────────────────────────────────────────────────

app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "repo-agent-launcher",
    enabled: ENABLE_REPO_AGENT,
    uptime: process.uptime(),
  });
});

app.get("/api/health/ready", async (_req, res) => {
  try {
    fb.init();
    res.json({ status: "ready", firebase: "ok" });
  } catch (err) {
    res.status(503).json({ status: "not-ready", error: String(err.message) });
  }
});

// Helper to wrap async handlers and centralize error responses.
function wrap(fn) {
  return (req, res) => {
    Promise.resolve(fn(req, res)).catch((err) => {
      log("error", "handler-error", {
        url: req.url,
        method: req.method,
        message: String(err.message || err),
      });
      res.status(err.statusCode || 500).json({
        error: String(err.message || err),
      });
    });
  };
}

// Sanitize a Git credential before sending to client (never leak token).
function publicGitCredential(c) {
  if (!c) return c;
  return {
    id: c.id,
    provider: c.provider,
    name: c.name,
    username: c.username || "",
    orgs: c.orgs || [],
    enabled: c.enabled !== false,
    tokenPreview: c.tokenBase64 ? maskToken(Buffer.from(c.tokenBase64, "base64").toString("utf8")) : "",
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

function publicAgentCredential(c) {
  if (!c) return c;
  return {
    id: c.id,
    agentProfileId: c.agentProfileId,
    name: c.name,
    type: c.type,
    targetPath: c.targetPath || null,
    mode: c.mode || null,
    env: c.env || null,
    hasContent: !!c.contentBase64,
    hasScript: !!c.scriptBase64,
    enabled: c.enabled !== false,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

// ── Git Credentials ────────────────────────────────────────────────

app.get(
  "/api/git-credentials",
  wrap(async (_req, res) => {
    const all = (await fb.readPath("/repoAgent/gitCredentials")) || {};
    res.json({
      items: Object.values(all).map(publicGitCredential),
    });
  }),
);

app.post(
  "/api/git-credentials",
  wrap(async (req, res) => {
    const { provider, name, token, extra } = req.body || {};
    if (!provider) throw new Error("provider is required");
    if (!token) throw new Error("token is required");

    // Try to fetch account first to validate token.
    const account = await gitProviders.fetchAccount(provider, token, extra || {});

    const id = genId("git");
    const obj = {
      id,
      provider,
      name: name || `${provider} (${account.username})`,
      tokenBase64: toBase64(token),
      username: account.username || "",
      orgs: account.orgs || [],
      extra: extra || null,
      enabled: true,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    await fb.writePath(`/repoAgent/gitCredentials/${id}`, obj);

    // Kick off repo refresh (non-blocking).
    refreshReposForCredential(id).catch((err) => log("error", "auto-refresh-repos failed", { id, err: String(err) }));

    res.json({ ok: true, item: publicGitCredential(obj), account });
  }),
);

app.post(
  "/api/git-credentials/:id/test",
  wrap(async (req, res) => {
    const id = req.params.id;
    const cred = await fb.readPath(`/repoAgent/gitCredentials/${id}`);
    if (!cred) throw new Error("Not found");
    const token = Buffer.from(cred.tokenBase64 || "", "base64").toString("utf8");
    const account = await gitProviders.fetchAccount(cred.provider, token, cred.extra || {});
    await fb.updatePath(`/repoAgent/gitCredentials/${id}`, {
      username: account.username,
      orgs: account.orgs || [],
      updatedAt: nowIso(),
    });
    res.json({ ok: true, account });
  }),
);

app.post(
  "/api/git-credentials/:id/refresh-repos",
  wrap(async (req, res) => {
    const id = req.params.id;
    const result = await refreshReposForCredential(id);
    res.json({ ok: true, ...result });
  }),
);

app.patch(
  "/api/git-credentials/:id",
  wrap(async (req, res) => {
    const id = req.params.id;
    const cred = await fb.readPath(`/repoAgent/gitCredentials/${id}`);
    if (!cred) throw new Error("Not found");
    const patch = {};
    if (typeof req.body.name === "string") patch.name = req.body.name;
    if (typeof req.body.enabled === "boolean") patch.enabled = req.body.enabled;
    patch.updatedAt = nowIso();
    await fb.updatePath(`/repoAgent/gitCredentials/${id}`, patch);
    res.json({ ok: true });
  }),
);

app.delete(
  "/api/git-credentials/:id",
  wrap(async (req, res) => {
    const id = req.params.id;
    await fb.deletePath(`/repoAgent/gitCredentials/${id}`);
    // Also delete repo cache entries owned by this credential.
    const repos = (await fb.readPath("/repoAgent/repoCache")) || {};
    const updates = {};
    for (const [rid, r] of Object.entries(repos)) {
      if (r && r.gitCredentialId === id) updates[rid] = null;
    }
    if (Object.keys(updates).length) {
      await fb.updatePath("/repoAgent/repoCache", updates);
    }
    res.json({ ok: true });
  }),
);

async function refreshReposForCredential(id) {
  const cred = await fb.readPath(`/repoAgent/gitCredentials/${id}`);
  if (!cred) throw new Error("Credential not found");
  const token = Buffer.from(cred.tokenBase64 || "", "base64").toString("utf8");
  const repos = await gitProviders.fetchRepos(cred.provider, token, cred.extra || {});

  // Reuse existing favorite/enabled flags by fullName.
  const cache = (await fb.readPath("/repoAgent/repoCache")) || {};
  const byKey = new Map();
  for (const r of Object.values(cache)) {
    if (r && r.gitCredentialId === id) {
      byKey.set(`${r.provider}:${r.fullName}`, r);
    }
  }

  const updates = {};
  // Mark old entries for removal first.
  for (const r of Object.values(cache)) {
    if (r && r.gitCredentialId === id) {
      updates[r.id] = null;
    }
  }

  let count = 0;
  for (const r of repos) {
    const existing = byKey.get(`${r.provider}:${r.fullName}`);
    const id2 = existing ? existing.id : genId("repo");
    const obj = {
      id: id2,
      gitCredentialId: cred.id,
      provider: r.provider,
      fullName: r.fullName,
      cloneUrl: r.cloneUrl,
      defaultBranch: r.defaultBranch,
      private: r.private,
      description: r.description || "",
      localPath: `/repos/${r.provider}/${r.fullName}`,
      enabled: existing ? existing.enabled !== false : true,
      favorite: existing ? !!existing.favorite : false,
      lastFetchedAt: nowIso(),
    };
    updates[id2] = obj;
    count += 1;
  }
  await fb.updatePath("/repoAgent/repoCache", updates);
  return { count };
}

// ── Repo cache ─────────────────────────────────────────────────────

app.get(
  "/api/repos",
  wrap(async (_req, res) => {
    const all = (await fb.readPath("/repoAgent/repoCache")) || {};
    const items = Object.values(all)
      .filter(Boolean)
      .sort((a, b) => {
        if (!!b.favorite - !!a.favorite) return !!b.favorite - !!a.favorite;
        return (a.fullName || "").localeCompare(b.fullName || "");
      });
    res.json({ items });
  }),
);

app.patch(
  "/api/repos/:id",
  wrap(async (req, res) => {
    const id = req.params.id;
    const patch = {};
    if (typeof req.body.favorite === "boolean") patch.favorite = req.body.favorite;
    if (typeof req.body.enabled === "boolean") patch.enabled = req.body.enabled;
    patch.updatedAt = nowIso();
    await fb.updatePath(`/repoAgent/repoCache/${id}`, patch);
    res.json({ ok: true });
  }),
);

// ── Agent Profiles ─────────────────────────────────────────────────

const DEFAULT_AGENT_PROFILES = [
  {
    name: "agy",
    label: "AGY / Antigravity",
    command: "agy",
    args: "",
    workdir: "/workspace",
    startMode: "shell",
    settingsPath: "~/.gemini/antigravity-cli/settings.json",
    settingsTemplate: DEFAULT_AGY_SETTINGS_TEMPLATE,
  },
  {
    name: "codex",
    label: "Codex CLI",
    command: "codex",
    args: "",
    workdir: "/workspace",
    startMode: "shell",
  },
  {
    name: "claude",
    label: "Claude Code",
    command: "claude",
    args: "",
    workdir: "/workspace",
    startMode: "shell",
  },
  {
    name: "opencode",
    label: "OpenCode",
    command: "opencode",
    args: "",
    workdir: "/workspace",
    startMode: "shell",
  },
  {
    name: "custom",
    label: "Custom Agent",
    command: "bash",
    args: "",
    workdir: "/workspace",
    startMode: "shell",
  },
];

async function ensureDefaultAgentProfiles() {
  const existing = (await fb.readPath("/repoAgent/agentProfiles")) || {};
  const haveByName = new Set(
    Object.values(existing)
      .filter(Boolean)
      .map((p) => p.name),
  );
  const updates = {};
  for (const p of DEFAULT_AGENT_PROFILES) {
    if (haveByName.has(p.name)) continue;
    const id = genId("agent");
    updates[id] = {
      id,
      ...p,
      enabled: true,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
  }
  if (Object.keys(updates).length) {
    await fb.updatePath("/repoAgent/agentProfiles", updates);
  }
}

app.get(
  "/api/agent-profiles",
  wrap(async (_req, res) => {
    await ensureDefaultAgentProfiles();
    const all = (await fb.readPath("/repoAgent/agentProfiles")) || {};
    res.json({ items: Object.values(all).filter(Boolean) });
  }),
);

app.post(
  "/api/agent-profiles",
  wrap(async (req, res) => {
    const { name, label, command, args, workdir, startMode, settingsPath, settingsTemplate } = req.body || {};
    if (!name) throw new Error("name is required");
    if (!command) throw new Error("command is required");
    const id = genId("agent");
    const obj = {
      id,
      name,
      label: label || name,
      command,
      args: args || "",
      workdir: workdir || "/workspace",
      startMode: startMode || "shell",
      settingsPath: settingsPath || "",
      settingsTemplate: settingsTemplate || "",
      enabled: true,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    await fb.writePath(`/repoAgent/agentProfiles/${id}`, obj);
    res.json({ ok: true, item: obj });
  }),
);

app.patch(
  "/api/agent-profiles/:id",
  wrap(async (req, res) => {
    const id = req.params.id;
    const allowed = ["label", "command", "args", "workdir", "startMode", "enabled", "settingsPath", "settingsTemplate"];
    const patch = {};
    for (const k of allowed) {
      if (typeof req.body[k] !== "undefined") patch[k] = req.body[k];
    }
    patch.updatedAt = nowIso();
    await fb.updatePath(`/repoAgent/agentProfiles/${id}`, patch);
    res.json({ ok: true });
  }),
);

app.delete(
  "/api/agent-profiles/:id",
  wrap(async (req, res) => {
    const id = req.params.id;
    await fb.deletePath(`/repoAgent/agentProfiles/${id}`);
    res.json({ ok: true });
  }),
);

// ── Agent Credentials ──────────────────────────────────────────────

app.get(
  "/api/agent-credentials",
  wrap(async (_req, res) => {
    const all = (await fb.readPath("/repoAgent/agentCredentials")) || {};
    res.json({
      items: Object.values(all).filter(Boolean).map(publicAgentCredential),
    });
  }),
);

app.post(
  "/api/agent-credentials",
  wrap(async (req, res) => {
    const { agentProfileId, name, type } = req.body || {};
    if (!agentProfileId) throw new Error("agentProfileId is required");
    if (!name) throw new Error("name is required");
    if (!["file", "script", "env", "capture"].includes(type)) {
      throw new Error("type must be one of: file, script, env, capture");
    }
    const id = genId("agent_cred");
    const obj = {
      id,
      agentProfileId,
      name,
      type,
      enabled: true,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    if (type === "file" || type === "capture") {
      if (!req.body.targetPath) throw new Error("targetPath is required");
      obj.targetPath = req.body.targetPath;
      obj.mode = req.body.mode || "0600";
      obj.contentBase64 = req.body.contentBase64 || "";
      if (req.body.content && !obj.contentBase64) {
        obj.contentBase64 = toBase64(req.body.content);
      }
    } else if (type === "script") {
      obj.scriptBase64 = req.body.scriptBase64 || "";
      if (req.body.script && !obj.scriptBase64) {
        obj.scriptBase64 = toBase64(req.body.script);
      }
    } else if (type === "env") {
      if (!req.body.env || typeof req.body.env !== "object") {
        throw new Error("env must be an object of KEY:VALUE pairs");
      }
      obj.env = req.body.env;
    }
    await fb.writePath(`/repoAgent/agentCredentials/${id}`, obj);
    res.json({ ok: true, item: publicAgentCredential(obj) });
  }),
);

app.patch(
  "/api/agent-credentials/:id",
  wrap(async (req, res) => {
    const id = req.params.id;
    const allowed = ["name", "enabled", "targetPath", "mode", "env"];
    const patch = {};
    for (const k of allowed) {
      if (typeof req.body[k] !== "undefined") patch[k] = req.body[k];
    }
    if (typeof req.body.content === "string") {
      patch.contentBase64 = toBase64(req.body.content);
    } else if (typeof req.body.contentBase64 === "string") {
      patch.contentBase64 = req.body.contentBase64;
    }
    if (typeof req.body.script === "string") {
      patch.scriptBase64 = toBase64(req.body.script);
    } else if (typeof req.body.scriptBase64 === "string") {
      patch.scriptBase64 = req.body.scriptBase64;
    }
    patch.updatedAt = nowIso();
    await fb.updatePath(`/repoAgent/agentCredentials/${id}`, patch);
    res.json({ ok: true });
  }),
);

app.delete(
  "/api/agent-credentials/:id",
  wrap(async (req, res) => {
    const id = req.params.id;
    await fb.deletePath(`/repoAgent/agentCredentials/${id}`);
    res.json({ ok: true });
  }),
);

// ── Slot pool ──────────────────────────────────────────────────────

app.get(
  "/api/slots",
  wrap(async (_req, res) => {
    await launcher.ensureSlotPoolInitialized();
    await launcher.checkAndReleaseInterruptedSlots().catch(() => null);
    const all = (await fb.readPath("/repoAgent/ttydSlots")) || {};
    res.json({
      items: Object.values(all)
        .filter(Boolean)
        .sort((a, b) => (a.slot || "").localeCompare(b.slot || "")),
    });
  }),
);

// Admin: force-reset 1 slot về free + clear session + best-effort stop container.
// Dùng khi slot mồ côi (container đã chết nhưng status vẫn busy/reserved).
//   POST /api/admin/slots/:slot/reset
app.post(
  "/api/admin/slots/:slot/reset",
  wrap(async (req, res) => {
    const slot = String(req.params.slot || "").padStart(3, "0");
    const cur = await fb.readPath(`/repoAgent/ttydSlots/${slot}`);
    if (!cur) throw new Error(`Slot not found: ${slot}`);

    // Best-effort: stop container nếu đang chạy.
    await launcher.stopSlotContainer(slot).catch(() => null);

    // Mark associated session as forced-closed.
    if (cur.sessionId) {
      await fb
        .updatePath(`/repoAgent/sessions/${cur.sessionId}`, {
          status: "forced-closed",
          closedAt: nowIso(),
          closedReason: "admin-reset",
        })
        .catch(() => null);
    }

    await launcher.setSlotStatus(slot, "free", { sessionId: null });
    log("info", "admin-reset-slot", { slot, prevStatus: cur.status });
    res.json({ ok: true, slot, prevStatus: cur.status });
  }),
);

// Admin: bulk reset tất cả slot không phải "busy" trong một lần (xóa rác mồ côi).
//   POST /api/admin/slots/reset-stale
app.post(
  "/api/admin/slots/reset-stale",
  wrap(async (_req, res) => {
    const all = (await fb.readPath("/repoAgent/ttydSlots")) || {};
    const reset = [];
    for (const [slot, cur] of Object.entries(all)) {
      if (!cur || cur.status === "free" || cur.status === "busy") continue;
      // Reset tất cả trạng thái trung gian: reserved/cloning/starting/stopping/error
      await launcher.stopSlotContainer(slot).catch(() => null);
      if (cur.sessionId) {
        await fb
          .updatePath(`/repoAgent/sessions/${cur.sessionId}`, {
            status: "forced-closed",
            closedAt: nowIso(),
            closedReason: "admin-reset-stale",
          })
          .catch(() => null);
      }
      await launcher.setSlotStatus(slot, "free", { sessionId: null });
      reset.push({ slot, prevStatus: cur.status });
    }
    log("info", "admin-reset-stale", { count: reset.length });
    res.json({ ok: true, count: reset.length, items: reset });
  }),
);

// ── Sessions / Launch ──────────────────────────────────────────────

app.post(
  "/api/launch",
  wrap(async (req, res) => {
    const { repoId, agentProfileId, branch, agentCredentialIds } = req.body || {};
    const result = await launcher.launch({ repoId, agentProfileId, branch, agentCredentialIds });
    res.json({ ok: true, ...result });
  }),
);

app.post(
  "/api/sessions/:id/close",
  wrap(async (req, res) => {
    const id = req.params.id;
    const result = await launcher.closeSession(id);
    res.json({ ok: true, ...result });
  }),
);

app.get(
  "/api/sessions",
  wrap(async (_req, res) => {
    const all = (await fb.readPath("/repoAgent/sessions")) || {};
    res.json({
      items: Object.values(all)
        .filter(Boolean)
        .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || ""))),
    });
  }),
);

// ── Static UI ──────────────────────────────────────────────────────

const PUBLIC_DIR = path.join(__dirname, "..", "public");
app.use(express.static(PUBLIC_DIR));

app.get("/", (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});
app.get("/admin", (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "admin.html"));
});

// 404 JSON for /api/*
app.use("/api/*", (_req, res) => {
  res.status(404).json({ error: "Not found" });
});

// ── Boot ───────────────────────────────────────────────────────────

if (!ENABLE_REPO_AGENT) {
  log("warn", "ENABLE_REPO_AGENT=false — server starting in disabled mode");
}

app.listen(PORT, () => {
  log("info", `Repo Agent Launcher UI listening on :${PORT}`);
  // Best-effort init.
  Promise.resolve()
    .then(() => fb.init())
    .then(() => launcher.ensureSlotPoolInitialized())
    .then(() => ensureDefaultAgentProfiles())
    .then(() => launcher.releaseAllSlotsOnStart())
    .then((resetList) => {
      log("info", `Firebase + slot pool + default agents ready. Auto-released ${resetList.length} slots on boot.`, { resetList });
      // Periodically clean up any interrupted busy slots every 15 seconds.
      setInterval(() => {
        launcher
          .checkAndReleaseInterruptedSlots()
          .then((released) => {
            if (released.length > 0) {
              log("info", "auto-released-interrupted-slots", { count: released.length, slots: released });
            }
          })
          .catch((err) => {
            log("error", "auto-release-interrupted-slots-failed", { err: String(err.message || err) });
          });
      }, 15000);
    })
    .catch((err) => log("error", "init-failed", { err: String(err.message || err) }));
});
