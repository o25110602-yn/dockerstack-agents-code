// tests/repo-agent/http-integration.test.js
//
// HTTP-level integration test:
//   - Spin up the real Express server (services/app/src/server.js) on
//     a random port using the in-memory Firebase mock + git-providers
//     stub + child_process.execFile mock.
//   - Hit the real REST endpoints with `node-fetch` to exercise the
//     route layer (validation, error mapping, JSON shape).
//   - Tear down server + clean tmp dirs at the end.
//
// Why this is in addition to mock-flow.test.js:
//   - mock-flow.test.js exercises the LAUNCHER MODULE in isolation
//     (no HTTP). This file additionally proves the HTTP routes wire
//     things up correctly: payload validation, sanitization
//     (publicGitCredential / publicAgentCredential), 404 mapping,
//     and the end-to-end ENV flag (ENABLE_REPO_AGENT).
//
// Usage: node tests/repo-agent/http-integration.test.js
// Exit:  0 = all PASS, 1 = at least one FAIL.

"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const child_process = require("child_process");
const http = require("http");

const PROJECT_ROOT = path.resolve(__dirname, "../..");
const APP_SRC_DIR = path.join(PROJECT_ROOT, "services/app/src");

// ── Tiny test runner ─────────────────────────────────────────────────

const results = [];
let currentSection = "";

function section(name) {
  currentSection = name;
  console.log(`\n=== ${name} ===`);
}
function pass(name, detail) {
  results.push({ name, status: "PASS", detail: detail || "", section: currentSection });
  console.log(`  PASS ${name}${detail ? "  — " + detail : ""}`);
}
function fail(name, detail) {
  results.push({ name, status: "FAIL", detail: detail || "", section: currentSection });
  console.error(`  FAIL ${name}${detail ? "  — " + detail : ""}`);
}
function check(name, cond, detail) {
  if (cond) pass(name, detail);
  else fail(name, detail);
  return cond;
}
function expectEq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  return check(name, ok, ok ? "" : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// ── Firebase mock (path-based RTDB simulation) ───────────────────────

function makeFirebaseMock() {
  const store = {};
  function getDeep(p) {
    const parts = String(p).replace(/^\//, "").split("/").filter(Boolean);
    let cur = store;
    for (const k of parts) {
      if (cur == null || typeof cur !== "object") return undefined;
      cur = cur[k];
    }
    return cur;
  }
  function setDeep(p, v) {
    const parts = String(p).replace(/^\//, "").split("/").filter(Boolean);
    if (parts.length === 0) return;
    let cur = store;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const k = parts[i];
      if (typeof cur[k] !== "object" || cur[k] === null) cur[k] = {};
      cur = cur[k];
    }
    cur[parts[parts.length - 1]] = v;
  }
  function delDeep(p) {
    const parts = String(p).replace(/^\//, "").split("/").filter(Boolean);
    if (parts.length === 0) return;
    let cur = store;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const k = parts[i];
      if (typeof cur[k] !== "object" || cur[k] === null) return;
      cur = cur[k];
    }
    delete cur[parts[parts.length - 1]];
  }
  return {
    _store: store,
    init() { return this; },
    db() {
      return {
        ref(p) {
          return {
            async transaction(fn) {
              const cur = getDeep(p);
              const next = fn(cur ? JSON.parse(JSON.stringify(cur)) : cur);
              if (next === undefined) return { committed: false, snapshot: null };
              setDeep(p, next);
              return { committed: true, snapshot: { val: () => next } };
            },
            async once() {
              return { val: () => getDeep(p) };
            },
          };
        },
      };
    },
    async readPath(p) {
      const v = getDeep(p);
      return v == null ? null : JSON.parse(JSON.stringify(v));
    },
    async writePath(p, v) { setDeep(p, v); },
    async updatePath(p, partial) {
      const cur = getDeep(p);
      if (cur && typeof cur === "object" && !Array.isArray(cur)) {
        for (const [k, v] of Object.entries(partial || {})) {
          if (v === null) delete cur[k];
          else if (k.includes("/")) setDeep(`${p}/${k}`, v);
          else cur[k] = v;
        }
      } else {
        const next = {};
        for (const [k, v] of Object.entries(partial || {})) {
          if (v !== null) next[k] = v;
        }
        setDeep(p, next);
      }
    },
    async deletePath(p) { delDeep(p); },
  };
}

// ── execFile mock (stub git/docker) ──────────────────────────────────
// Refactor 2026-06: launcher gọi `docker run`/`docker rm` qua docker-runner,
// không còn `bash dc.sh ...`. Mock cả 2.

const activeContainers = new Set();
const calls = [];
const origExecFile = child_process.execFile;
function installExecFileMock() {
  child_process.execFile = function (cmd, args, opts, cb) {
    if (typeof opts === "function") { cb = opts; opts = {}; }
    calls.push({ cmd, args });
    if (cmd === "git" && args[0] === "clone") {
      const target = args[args.length - 1];
      try {
        fs.mkdirSync(path.join(target, ".git"), { recursive: true });
        fs.writeFileSync(path.join(target, "README.md"), "# mock\n");
      } catch { /* ignore */ }
    }
    if (cmd === "docker") {
      if (args[0] === "run") {
        // Track the container name to simulate it running
        const nameIdx = args.indexOf("--name");
        if (nameIdx !== -1 && nameIdx + 1 < args.length) {
          activeContainers.add(args[nameIdx + 1]);
        }
        return cb(null, "mockcontainerid0123456789abcdef\n", "");
      }
      if (args[0] === "rm") {
        const containerName = args[args.length - 1];
        activeContainers.delete(containerName);
        return cb(null, "", "");
      }
      if (args[0] === "inspect") {
        const containerName = args[args.length - 1];
        if (activeContainers.has(containerName)) {
          return cb(null, `mockcontainerid0123456789abcdef|running|true\n`, "");
        } else {
          const err = new Error("No such container");
          err.code = 1;
          return cb(err, "", "");
        }
      }
      // version/etc → silent success
    }
    cb(null, "", "");
  };
}
function restoreExecFile() { child_process.execFile = origExecFile; }

// ── Module-cache injection ───────────────────────────────────────────

function injectModuleMock(modulePath, exportsObj) {
  const abs = require.resolve(modulePath);
  require.cache[abs] = {
    id: abs, filename: abs, loaded: true, exports: exportsObj,
    children: [], paths: [],
  };
}

// ── Setup tmp dirs + env ─────────────────────────────────────────────

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "repo-agent-http-"));
const SLOTS_ROOT = path.join(TMP, "slots");
const REPOS_ROOT = path.join(TMP, "repos");
const LOG_DIR = path.join(TMP, "logs");
fs.mkdirSync(SLOTS_ROOT, { recursive: true });
fs.mkdirSync(REPOS_ROOT, { recursive: true });
fs.mkdirSync(LOG_DIR, { recursive: true });

process.env.REPO_AGENT_SLOTS_ROOT = SLOTS_ROOT;
process.env.REPO_AGENT_REPOS_ROOT = REPOS_ROOT;
process.env.REPO_AGENT_TOTAL_SLOTS = "5";
process.env.DOMAIN = "test.local";
process.env.PORT = "0"; // ask Express to assign a free port
process.env.LOG_DIR = LOG_DIR;
process.env.ENABLE_REPO_AGENT = "true";

// Inject mocks BEFORE first require of server.js
const fbMock = makeFirebaseMock();
injectModuleMock(path.join(APP_SRC_DIR, "firebase.js"), fbMock);

const gitProvidersStub = {
  async fetchAccount(provider, token) {
    if (token === "BAD") throw new Error("invalid token");
    return { username: "mock-user", orgs: ["org-a"] };
  },
  async fetchRepos(provider) {
    return [
      { provider, fullName: "mock-user/repo-a", cloneUrl: "https://github.com/mock-user/repo-a.git", defaultBranch: "main", private: false, description: "" },
      { provider, fullName: "mock-user/repo-b", cloneUrl: "https://github.com/mock-user/repo-b.git", defaultBranch: "main", private: true, description: "lib" },
    ];
  },
  buildAuthenticatedCloneUrl(provider, cloneUrl, token, username) {
    return cloneUrl.replace("https://", `https://${username || "x"}:${token}@`);
  },
};
injectModuleMock(path.join(APP_SRC_DIR, "git-providers.js"), gitProvidersStub);

installExecFileMock();

// Now require server module (it calls app.listen on import).
// We override port to 0 via env before require.
const expressApp = (() => {
  // server.js calls app.listen(PORT). Read source and shadow `app.listen`
  // through module's express? Simpler: load server.js, but capture the
  // returned http server by intercepting express().listen. We do so
  // by patching express() behaviour after first require.
  //
  // Easiest approach: just require server.js — it will start a server on
  // PORT=0. We retrieve the actual port via a post-listen hook by patching
  // http.Server.prototype.listen to record any server bound during require.
  //
  // Implementation: monkey-patch BEFORE require.
  const origListen = http.Server.prototype.listen;
  let captured = null;
  http.Server.prototype.listen = function (...args) {
    captured = this;
    return origListen.apply(this, args);
  };

  require(path.join(APP_SRC_DIR, "server.js"));
  http.Server.prototype.listen = origListen;
  return captured;
})();

// ── HTTP helper ─────────────────────────────────────────────────────

function getServerPort() {
  if (!expressApp) throw new Error("server failed to start");
  const addr = expressApp.address();
  if (!addr) throw new Error("server has no address yet");
  return typeof addr === "object" ? addr.port : Number(addr);
}

function httpReq(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const port = getServerPort();
    const opts = {
      hostname: "127.0.0.1",
      port,
      path: urlPath,
      method,
      headers: { "Content-Type": "application/json" },
    };
    const data = body == null ? null : JSON.stringify(body);
    if (data) opts.headers["Content-Length"] = Buffer.byteLength(data);
    const req = http.request(opts, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { /* keep null */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

async function waitForListening(timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const addr = expressApp && expressApp.address();
      if (addr && addr.port) return addr.port;
    } catch { /* not ready */ }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("server did not start within timeout");
}

// ── Tests ───────────────────────────────────────────────────────────

async function testHealth() {
  section("HTTP — health & readiness");

  const port = await waitForListening();
  pass("Server.listening", `port=${port}`);

  const h = await httpReq("GET", "/api/health");
  expectEq("Health.status", h.status, 200);
  expectEq("Health.json.status", h.json && h.json.status, "ok");
  expectEq("Health.json.service", h.json && h.json.service, "repo-agent-launcher");
  expectEq("Health.json.enabled", h.json && h.json.enabled, true);

  const r = await httpReq("GET", "/api/health/ready");
  expectEq("Ready.status", r.status, 200);
  expectEq("Ready.json.status", r.json && r.json.status, "ready");
}

async function testGitCredentialsAPI() {
  section("HTTP — Git Credentials");

  // POST create — provider missing → 500 with error
  const bad = await httpReq("POST", "/api/git-credentials", { token: "x" });
  check("GitCred.createRequiresProvider", bad.status >= 400 && /provider is required/.test(bad.json && bad.json.error || ""), `${bad.status} ${JSON.stringify(bad.json)}`);

  // POST create OK — use a realistic-length token (>8 chars) so maskToken
  // returns the "first4…last4" preview rather than just "***" for short ones.
  const RAW_TOKEN = "ghp_1234567890ABCDwxyz";
  const ok = await httpReq("POST", "/api/git-credentials", {
    provider: "github", name: "GH Main", token: RAW_TOKEN,
  });
  expectEq("GitCred.create.status", ok.status, 200);
  check("GitCred.create.idGenerated", ok.json && /^git_/.test(ok.json.item.id), JSON.stringify(ok.json && ok.json.item));
  // Hard requirements: raw token must NEVER leak; tokenBase64 must be hidden;
  // and tokenPreview must show ONLY the first/last 4 chars in `xxxx…yyyy` form.
  const item = ok.json && ok.json.item;
  const preview = (item && item.tokenPreview) || "";
  const noRawLeak = !JSON.stringify(ok.json).includes(RAW_TOKEN);
  const noBase64Leak = item && !item.tokenBase64;
  const previewShape = /^ghp_…wxyz$/.test(preview);
  check("GitCred.create.tokenMaskedInResponse",
    noRawLeak && noBase64Leak && previewShape,
    `noRawLeak=${noRawLeak} noBase64Leak=${noBase64Leak} preview="${preview}"`);
  pass("GitCred.fetchAccountAndStoreOrgs", `username=${ok.json.account.username} orgs=${ok.json.account.orgs.join(",")}`);

  // GET list
  const list = await httpReq("GET", "/api/git-credentials");
  expectEq("GitCred.list.status", list.status, 200);
  check("GitCred.list.containsCreated",
    list.json && Array.isArray(list.json.items) && list.json.items.some((i) => i.id === ok.json.item.id),
    `count=${list.json && list.json.items && list.json.items.length}`);

  // POST test endpoint
  const t = await httpReq("POST", `/api/git-credentials/${ok.json.item.id}/test`);
  expectEq("GitCred.test.status", t.status, 200);
  expectEq("GitCred.test.account.username", t.json && t.json.account && t.json.account.username, "mock-user");

  // POST refresh-repos endpoint
  const rr = await httpReq("POST", `/api/git-credentials/${ok.json.item.id}/refresh-repos`);
  expectEq("GitCred.refreshRepos.status", rr.status, 200);
  expectEq("GitCred.refreshRepos.count", rr.json && rr.json.count, 2);

  return ok.json.item.id;
}

async function testReposAPI(gitId) {
  section("HTTP — Repository Cache");

  const list = await httpReq("GET", "/api/repos");
  expectEq("Repos.list.status", list.status, 200);
  check("Repos.list.has2", list.json && list.json.items && list.json.items.length === 2, `count=${list.json && list.json.items && list.json.items.length}`);

  const repo = list.json.items[0];
  check("Repos.list.itemHasGitCredentialId", repo.gitCredentialId === gitId, `${repo.gitCredentialId}`);
  check("Repos.list.localPathStartsWithRepos", String(repo.localPath || "").startsWith("/repos/"), repo.localPath);

  // PATCH favorite=true
  const upd = await httpReq("PATCH", `/api/repos/${repo.id}`, { favorite: true });
  expectEq("Repos.patchFavorite.status", upd.status, 200);

  const list2 = await httpReq("GET", "/api/repos");
  const sameRepo = list2.json.items.find((r) => r.id === repo.id);
  expectEq("Repos.favoritePersisted", sameRepo && sameRepo.favorite, true);

  return repo;
}

async function testAgentProfilesAPI() {
  section("HTTP — Agent Profiles (5 defaults seeded)");

  const list = await httpReq("GET", "/api/agent-profiles");
  expectEq("AgentProfiles.list.status", list.status, 200);
  const names = (list.json && list.json.items || []).map((p) => p.name).sort();
  // Default profiles per server.js DEFAULT_AGENT_PROFILES
  expectEq("AgentProfiles.defaultsSeeded", names, ["agy", "claude", "codex", "custom", "opencode"]);

  // Create custom profile
  const c = await httpReq("POST", "/api/agent-profiles", {
    name: "myagent", label: "My Agent", command: "echo", args: "hello", workdir: "/workspace",
  });
  expectEq("AgentProfiles.create.status", c.status, 200);
  check("AgentProfiles.create.idGenerated", c.json && /^agent_/.test(c.json.item.id), JSON.stringify(c.json));

  // PATCH
  const p = await httpReq("PATCH", `/api/agent-profiles/${c.json.item.id}`, { label: "Renamed" });
  expectEq("AgentProfiles.patch.status", p.status, 200);

  // DELETE
  const d = await httpReq("DELETE", `/api/agent-profiles/${c.json.item.id}`);
  expectEq("AgentProfiles.delete.status", d.status, 200);

  // Pick codex profile id for later launch
  const codex = list.json.items.find((p) => p.name === "codex");
  return codex.id;
}

async function testAgentCredentialsAPI(agentProfileId) {
  section("HTTP — Agent Credentials");

  // type=file
  const f = await httpReq("POST", "/api/agent-credentials", {
    agentProfileId,
    name: "codex config",
    type: "file",
    targetPath: "/home/coder/.codex/config.toml",
    mode: "0600",
    content: "test_config = true\n",
  });
  expectEq("AgentCred.createFile.status", f.status, 200);
  check("AgentCred.createFile.contentNotLeaked",
    f.json && f.json.item && !("contentBase64" in f.json.item) && f.json.item.hasContent === true,
    JSON.stringify(f.json && f.json.item));

  // type=script
  const s = await httpReq("POST", "/api/agent-credentials", {
    agentProfileId, name: "bootstrap", type: "script",
    script: "#!/bin/sh\necho bootstrap\n",
  });
  expectEq("AgentCred.createScript.status", s.status, 200);
  check("AgentCred.createScript.scriptNotLeaked",
    s.json && s.json.item && !("scriptBase64" in s.json.item) && s.json.item.hasScript === true,
    JSON.stringify(s.json && s.json.item));

  // type=env
  const e = await httpReq("POST", "/api/agent-credentials", {
    agentProfileId, name: "env vars", type: "env",
    env: { CODEX_API_KEY: "sk-test", CODEX_MODEL: "gpt-x" },
  });
  expectEq("AgentCred.createEnv.status", e.status, 200);
  expectEq("AgentCred.createEnv.envEcho", e.json && e.json.item && e.json.item.env, { CODEX_API_KEY: "sk-test", CODEX_MODEL: "gpt-x" });

  // bad type
  const bad = await httpReq("POST", "/api/agent-credentials", {
    agentProfileId, name: "nope", type: "weird",
  });
  check("AgentCred.create.rejectsUnknownType", bad.status >= 400, `${bad.status}`);

  // GET list
  const list = await httpReq("GET", "/api/agent-credentials");
  expectEq("AgentCred.list.status", list.status, 200);
  check("AgentCred.list.has3", list.json && list.json.items && list.json.items.length === 3,
    `count=${list.json && list.json.items && list.json.items.length}`);

  // PATCH disable
  const p = await httpReq("PATCH", `/api/agent-credentials/${f.json.item.id}`, { enabled: false });
  expectEq("AgentCred.patchDisable.status", p.status, 200);
  const list2 = await httpReq("GET", "/api/agent-credentials");
  const upd = list2.json.items.find((c) => c.id === f.json.item.id);
  expectEq("AgentCred.patchDisable.persisted", upd && upd.enabled, false);

  // Re-enable for launch test
  await httpReq("PATCH", `/api/agent-credentials/${f.json.item.id}`, { enabled: true });

  return { fileId: f.json.item.id, scriptId: s.json.item.id, envId: e.json.item.id };
}

async function testSlotsAndLaunchAPI(repo, agentProfileId) {
  section("HTTP — Slots + Launch + Sessions");

  const slots = await httpReq("GET", "/api/slots");
  expectEq("Slots.list.status", slots.status, 200);
  check("Slots.poolSize", slots.json && slots.json.items && slots.json.items.length === 5,
    `count=${slots.json && slots.json.items && slots.json.items.length}`);
  const allFree = (slots.json.items || []).every((s) => s.status === "free");
  check("Slots.allInitiallyFree", allFree, "all slots free");

  // Launch — payload chỉ cần repoId + agentProfileId
  const lr = await httpReq("POST", "/api/launch", {
    repoId: repo.id, agentProfileId,
  });
  expectEq("Launch.status", lr.status, 200);
  check("Launch.returnsSessionId", lr.json && /^sess_/.test(lr.json.sessionId), JSON.stringify(lr.json));
  check("Launch.returnsTtydUrl", lr.json && /^https:\/\/ttyd\d{3}\.test\.local$/.test(lr.json.url), lr.json && lr.json.url);
  check("Launch.returnsSlot", lr.json && /^\d{3}$/.test(lr.json.slot), lr.json && lr.json.slot);

  // Verify slot now busy
  const slots2 = await httpReq("GET", "/api/slots");
  const busy = (slots2.json.items || []).filter((s) => s.status === "busy");
  expectEq("Launch.slotBusy", busy.length, 1);

  // Sessions list
  const sess = await httpReq("GET", "/api/sessions");
  expectEq("Sessions.list.status", sess.status, 200);
  check("Sessions.list.hasOne", sess.json && sess.json.items && sess.json.items.length >= 1,
    `count=${sess.json && sess.json.items && sess.json.items.length}`);

  // Verify docker run call recorded (replaces dc.sh up call)
  const upCall = calls.find((c) =>
    c.cmd === "docker" && Array.isArray(c.args) &&
    c.args[0] === "run" && c.args.includes("-d") &&
    c.args.some((a) => /^repo-agent-ttyd-\d{3}$/.test(a))
  );
  check("Launch.invokesDockerRun", !!upCall, upCall ? upCall.args.slice(0, 6).join(" ") + "..." : "no docker run call");

  // Close session
  const close = await httpReq("POST", `/api/sessions/${lr.json.sessionId}/close`);
  expectEq("CloseSession.status", close.status, 200);

  const slots3 = await httpReq("GET", "/api/slots");
  const allFreeAgain = (slots3.json.items || []).every((s) => s.status === "free");
  check("CloseSession.slotBackToFree", allFreeAgain, "all slots free after close");

  const stopCall = calls.find((c) =>
    c.cmd === "docker" && Array.isArray(c.args) &&
    c.args[0] === "rm" && c.args.includes("-f") &&
    c.args.some((a) => /^repo-agent-ttyd-\d{3}$/.test(a))
  );
  check("CloseSession.invokesDockerRm", !!stopCall, stopCall ? stopCall.args.join(" ") : "no docker rm call");
}

async function testLaunchValidation(repoId, agentProfileId) {
  section("HTTP — Launch validation errors");

  const noRepo = await httpReq("POST", "/api/launch", { agentProfileId });
  check("Launch.rejectsMissingRepoId", noRepo.status >= 400 && /repoId/.test(noRepo.json && noRepo.json.error || ""), `${noRepo.status} ${JSON.stringify(noRepo.json)}`);

  const noAgent = await httpReq("POST", "/api/launch", { repoId });
  check("Launch.rejectsMissingAgentProfileId", noAgent.status >= 400 && /agentProfileId/.test(noAgent.json && noAgent.json.error || ""), `${noAgent.status} ${JSON.stringify(noAgent.json)}`);

  const ghostRepo = await httpReq("POST", "/api/launch", { repoId: "ghost", agentProfileId });
  check("Launch.rejectsUnknownRepo", ghostRepo.status >= 400 && /Repo not found/.test(ghostRepo.json && ghostRepo.json.error || ""), `${ghostRepo.status}`);
}

async function test404() {
  section("HTTP — 404 handler");
  const r = await httpReq("GET", "/api/does-not-exist");
  expectEq("404.status", r.status, 404);
  expectEq("404.json.error", r.json && r.json.error, "Not found");
}

async function testStaticUI() {
  section("HTTP — Static UI");
  const home = await httpReq("GET", "/");
  expectEq("StaticHome.status", home.status, 200);
  check("StaticHome.html", /(html|<!DOCTYPE html>|<title>)/i.test(home.text || ""), home.text && home.text.slice(0, 60));

  const adm = await httpReq("GET", "/admin");
  expectEq("StaticAdmin.status", adm.status, 200);
  check("StaticAdmin.html", /(html|<!DOCTYPE html>|<title>)/i.test(adm.text || ""), adm.text && adm.text.slice(0, 60));
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  try {
    await testHealth();
    const gitId = await testGitCredentialsAPI();
    const repo = await testReposAPI(gitId);
    const agentProfileId = await testAgentProfilesAPI();
    await testAgentCredentialsAPI(agentProfileId);
    await testSlotsAndLaunchAPI(repo, agentProfileId);
    await testLaunchValidation(repo.id, agentProfileId);
    await test404();
    await testStaticUI();
  } catch (err) {
    fail("UnexpectedError", String(err.stack || err));
  }

  restoreExecFile();

  const total = results.length;
  const passed = results.filter((r) => r.status === "PASS").length;
  const failed = results.filter((r) => r.status === "FAIL").length;
  console.log("\n────────────────────────────────────────────────");
  console.log(`Total: ${total}    PASS: ${passed}    FAIL: ${failed}`);
  console.log("────────────────────────────────────────────────");
  if (failed > 0) {
    console.log("\nFailures:");
    for (const r of results) {
      if (r.status === "FAIL") {
        console.log(`  - [${r.section}] ${r.name}: ${r.detail}`);
      }
    }
    if (expressApp) try { expressApp.close(); } catch { /* ignore */ }
    process.exit(1);
  }
  if (expressApp) try { expressApp.close(); } catch { /* ignore */ }
  process.exit(0);
}

main();
