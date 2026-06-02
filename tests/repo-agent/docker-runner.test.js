// tests/repo-agent/docker-runner.test.js
//
// Pure unit test for services/app/src/docker-runner.js — the module that
// replaces the old `bash dc.sh up -d ttyd-NNN` per-slot mechanism with
// `docker run` against the host daemon.
//
// Strategy:
//   - Mock child_process.execFile so no real `docker` binary needs to be
//     installed and no real daemon is contacted.
//   - Verify pure functions (buildRunArgs, resolveRuntimeConfig,
//     hostPathsForSlot) directly.
//   - Verify async actions (runSlotContainer, removeSlotContainer,
//     inspectSlotContainer, dockerHealthCheck) by inspecting the recorded
//     execFile calls AND the values returned to the caller.
//
// Why this complements mock-flow.test.js:
//   - mock-flow.test.js verifies `buildRunArgs` from the launcher's POV
//     (slot 047 + boundary 001/100). This file goes deeper:
//       • exhaustive label set
//       • exact ordering of -e / -v / --label / image
//       • idempotent removal (rm -f -> ignored when not found)
//       • inspect parsing (`{{.Id}}|{{.State.Status}}|{{.State.Running}}`)
//       • runtime config env-var fallback chain
//       • host path resolution (HOST_PROJECT_ROOT + DOCKER_VOLUMES_ROOT)
//
// IMPORTANT: All async tests run sequentially inside main() so the
// installExecFileMock / restoreExecFile pairs don't race. Top-level
// (synchronous) tests run first.
//
// Usage: node tests/repo-agent/docker-runner.test.js
// Exit:  0 = all PASS, 1 = at least one FAIL.

"use strict";

const path = require("path");
const child_process = require("child_process");

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
  return check(
    name,
    ok,
    ok ? "" : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
  );
}

// ── execFile mock with pluggable per-call handler ────────────────────

const calls = [];
const origExecFile = child_process.execFile;

function installExecFileMock(handler) {
  child_process.execFile = function (cmd, args, opts, cb) {
    if (typeof opts === "function") {
      cb = opts;
      opts = {};
    }
    calls.push({ cmd, args, opts });
    let res;
    try {
      res = handler({ cmd, args, opts });
    } catch (e) {
      return cb(e, "", String(e.message || e));
    }
    if (res instanceof Error) return cb(res, "", res.stderr || "");
    if (res && typeof res === "object" && res.code != null) {
      const e = new Error(res.stderr || `exit ${res.code}`);
      e.code = res.code;
      return cb(e, res.stdout || "", res.stderr || "");
    }
    return cb(null, typeof res === "string" ? res : (res && res.stdout) || "", "");
  };
}
function restoreExecFile() {
  child_process.execFile = origExecFile;
}
function clearCalls() {
  calls.length = 0;
}

// Always work with a fresh module (don't share state across blocks).
function loadDockerRunnerFresh() {
  const abs = require.resolve(path.join(APP_SRC_DIR, "docker-runner.js"));
  delete require.cache[abs];
  return require(path.join(APP_SRC_DIR, "docker-runner.js"));
}

// ── 1. buildRunArgs — pure function ──────────────────────────────────

function testBuildRunArgsExhaustive() {
  section("1. buildRunArgs — flag/label/volume invariants");
  const dr = loadDockerRunnerFresh();

  const args = dr.buildRunArgs({
    slot: "042",
    containerName: "repo-agent-ttyd-042",
    image: "repo-agent-ttyd:local",
    network: "myapp_net",
    domain: "example.com",
    tinyauthPort: "3000",
    hostReposRoot: "/data/host/repo-agent/repos",
    hostSlotRoot: "/data/host/repo-agent/slots/042",
    memory: "1g",
    memorySwap: "1g",
    cpus: "1",
    pidsLimit: "512",
    ttydPort: "7681",
  });

  // ── Top-level positional args ────────────────────────────────────
  expectEq("buildRunArgs.firstIsRun", args[0], "run");
  check("buildRunArgs.detached", args.includes("-d"), "-d present");
  expectEq(
    "buildRunArgs.imageIsLast",
    args[args.length - 1],
    "repo-agent-ttyd:local"
  );

  // ── Container name & hostname ────────────────────────────────────
  const nameIdx = args.indexOf("--name");
  expectEq(
    "buildRunArgs.containerName",
    nameIdx >= 0 ? args[nameIdx + 1] : null,
    "repo-agent-ttyd-042"
  );
  const hostIdx = args.indexOf("--hostname");
  expectEq(
    "buildRunArgs.hostnameDashed",
    hostIdx >= 0 ? args[hostIdx + 1] : null,
    "ttyd-042"
  );

  // ── Lifecycle / restart policy ───────────────────────────────────
  check("buildRunArgs.init", args.includes("--init"), "--init present");
  const restartIdx = args.indexOf("--restart");
  expectEq(
    "buildRunArgs.restartNo",
    restartIdx >= 0 ? args[restartIdx + 1] : null,
    "no"
  );

  // ── Network ─────────────────────────────────────────────────────
  const netIdx = args.indexOf("--network");
  expectEq(
    "buildRunArgs.network",
    netIdx >= 0 ? args[netIdx + 1] : null,
    "myapp_net"
  );

  // ── Resource limits ─────────────────────────────────────────────
  const memIdx = args.indexOf("--memory");
  expectEq("buildRunArgs.memory", memIdx >= 0 ? args[memIdx + 1] : null, "1g");
  const memSwapIdx = args.indexOf("--memory-swap");
  expectEq(
    "buildRunArgs.memorySwap",
    memSwapIdx >= 0 ? args[memSwapIdx + 1] : null,
    "1g"
  );
  const cpusIdx = args.indexOf("--cpus");
  expectEq("buildRunArgs.cpus", cpusIdx >= 0 ? args[cpusIdx + 1] : null, "1");
  const pidsIdx = args.indexOf("--pids-limit");
  expectEq(
    "buildRunArgs.pidsLimit",
    pidsIdx >= 0 ? args[pidsIdx + 1] : null,
    "512"
  );

  // ── Security ────────────────────────────────────────────────────
  const secIdx = args.indexOf("--security-opt");
  expectEq(
    "buildRunArgs.noNewPriv",
    secIdx >= 0 ? args[secIdx + 1] : null,
    "no-new-privileges"
  );

  // ── Volumes ─────────────────────────────────────────────────────
  const vols = args
    .map((a, i) => (a === "-v" ? args[i + 1] : null))
    .filter(Boolean);
  check(
    "buildRunArgs.repoVolume",
    vols.includes("/data/host/repo-agent/repos:/repos"),
    `vols=${JSON.stringify(vols)}`
  );
  check(
    "buildRunArgs.slotVolume",
    vols.includes("/data/host/repo-agent/slots/042:/slot"),
    "slot mount"
  );
  check(
    "buildRunArgs.noRoMount",
    !vols.some((v) => v.endsWith(":ro")),
    "no read-only mounts"
  );
  expectEq("buildRunArgs.exactlyTwoVolumes", vols.length, 2);

  // ── Env vars passed via -e ──────────────────────────────────────
  const envs = args
    .map((a, i) => (a === "-e" ? args[i + 1] : null))
    .filter(Boolean);
  check(
    "buildRunArgs.envSlotDir",
    envs.includes("REPO_AGENT_SLOT_DIR=/slot"),
    `envs=${JSON.stringify(envs)}`
  );
  check(
    "buildRunArgs.envSlot",
    envs.includes("REPO_AGENT_SLOT=042"),
    "slot id"
  );
  check(
    "buildRunArgs.envTtydPort",
    envs.includes("REPO_AGENT_TTYD_PORT=7681"),
    "ttyd port"
  );

  // ── Labels — exhaustive ─────────────────────────────────────────
  const labels = args
    .map((a, i) => (a === "--label" ? args[i + 1] : null))
    .filter(Boolean);

  const expectedLabels = [
    "caddy=http://ttyd042.example.com",
    "caddy.forward_auth=tinyauth:3000",
    "caddy.forward_auth.uri=/api/auth/caddy",
    "caddy.forward_auth.header_up=X-Forwarded-Proto https",
    "caddy.forward_auth.copy_headers=Remote-User Remote-Email Remote-Name Remote-Groups",
    "caddy.reverse_proxy={{upstreams 7681}}",
    "caddy.reverse_proxy.flush_interval=-1",
    "dockerstack.role=repo-agent-ttyd-slot",
    "dockerstack.slot=042",
  ];
  for (const want of expectedLabels) {
    check(
      `buildRunArgs.label[${want.split("=")[0]}]`,
      labels.includes(want),
      want
    );
  }
}

// ── 2. buildRunArgs — defaults & validation ──────────────────────────

function testBuildRunArgsDefaultsAndValidation() {
  section("2. buildRunArgs — defaults + validation");
  const dr = loadDockerRunnerFresh();

  const a = dr.buildRunArgs({
    slot: "001",
    containerName: "repo-agent-ttyd-001",
    image: "img:tag",
    network: "n",
    domain: "d.local",
    hostReposRoot: "/r",
    hostSlotRoot: "/s",
  });
  const memIdx = a.indexOf("--memory");
  expectEq(
    "buildRunArgs.defaults.memory",
    memIdx >= 0 ? a[memIdx + 1] : null,
    "1g"
  );
  const cpusIdx = a.indexOf("--cpus");
  expectEq(
    "buildRunArgs.defaults.cpus",
    cpusIdx >= 0 ? a[cpusIdx + 1] : null,
    "1"
  );
  const pidsIdx = a.indexOf("--pids-limit");
  expectEq(
    "buildRunArgs.defaults.pids",
    pidsIdx >= 0 ? a[pidsIdx + 1] : null,
    "512"
  );
  const labels = a
    .map((x, i) => (x === "--label" ? a[i + 1] : null))
    .filter(Boolean);
  check(
    "buildRunArgs.defaults.tinyauthPort3000",
    labels.includes("caddy.forward_auth=tinyauth:3000"),
    "default tinyauth port"
  );
  check(
    "buildRunArgs.defaults.ttydPort7681",
    labels.includes("caddy.reverse_proxy={{upstreams 7681}}"),
    "default ttyd port"
  );

  // Validation — every required field individually
  const reqs = [
    "slot",
    "image",
    "network",
    "domain",
    "containerName",
    "hostReposRoot",
    "hostSlotRoot",
  ];
  const baseValid = {
    slot: "001",
    containerName: "x",
    image: "i",
    network: "n",
    domain: "d",
    hostReposRoot: "/r",
    hostSlotRoot: "/s",
  };
  for (const k of reqs) {
    const cfg = { ...baseValid };
    delete cfg[k];
    let threw = false;
    try {
      dr.buildRunArgs(cfg);
    } catch (e) {
      threw = /required/.test(String(e.message));
    }
    check(`buildRunArgs.validates.missing[${k}]`, threw, `should throw for missing ${k}`);
  }

  let threw = false;
  try {
    dr.buildRunArgs();
  } catch {
    threw = true;
  }
  check("buildRunArgs.validates.noCfg", threw, "throws on undefined cfg");
}

// ── 3. resolveRuntimeConfig — env fallback chain ─────────────────────

function testResolveRuntimeConfig() {
  section("3. resolveRuntimeConfig — env fallback chain");

  const snapshot = {};
  const KEYS = [
    "PROJECT_NAME",
    "DOMAIN",
    "TINYAUTH_PORT",
    "REPO_AGENT_TTYD_IMAGE",
    "REPO_AGENT_DOCKER_NETWORK",
    "REPO_AGENT_CONTAINER_MEMORY",
    "REPO_AGENT_CONTAINER_MEMORY_SWAP",
    "REPO_AGENT_CONTAINER_CPUS",
    "REPO_AGENT_CONTAINER_PIDS_LIMIT",
    "REPO_AGENT_TTYD_PORT",
    "HOST_PROJECT_ROOT",
    "DOCKER_VOLUMES_ROOT",
    "HOST_VOLUMES_ROOT",
  ];
  for (const k of KEYS) snapshot[k] = process.env[k];

  function clearAll() {
    for (const k of KEYS) delete process.env[k];
  }
  function restoreAll() {
    for (const k of KEYS) {
      if (snapshot[k] === undefined) delete process.env[k];
      else process.env[k] = snapshot[k];
    }
  }

  // 3a. All defaults
  clearAll();
  let dr = loadDockerRunnerFresh();
  let r = dr.resolveRuntimeConfig();
  expectEq("resolveRuntimeConfig.default.image", r.image, "repo-agent-ttyd:local");
  expectEq("resolveRuntimeConfig.default.network", r.network, "myapp_net");
  expectEq("resolveRuntimeConfig.default.domain", r.domain, "localhost");
  expectEq("resolveRuntimeConfig.default.tinyauthPort", r.tinyauthPort, "3000");
  expectEq("resolveRuntimeConfig.default.memory", r.memory, "1g");
  expectEq("resolveRuntimeConfig.default.memorySwap", r.memorySwap, "1g");
  expectEq("resolveRuntimeConfig.default.cpus", r.cpus, "1");
  expectEq("resolveRuntimeConfig.default.pidsLimit", r.pidsLimit, "512");
  expectEq("resolveRuntimeConfig.default.ttydPort", r.ttydPort, "7681");

  // 3b. PROJECT_NAME drives default network
  clearAll();
  process.env.PROJECT_NAME = "stacky";
  dr = loadDockerRunnerFresh();
  r = dr.resolveRuntimeConfig();
  expectEq(
    "resolveRuntimeConfig.networkFollowsProjectName",
    r.network,
    "stacky_net"
  );

  // 3c. Explicit REPO_AGENT_DOCKER_NETWORK overrides PROJECT_NAME
  clearAll();
  process.env.PROJECT_NAME = "stacky";
  process.env.REPO_AGENT_DOCKER_NETWORK = "explicit_net";
  dr = loadDockerRunnerFresh();
  r = dr.resolveRuntimeConfig();
  expectEq(
    "resolveRuntimeConfig.explicitNetworkWins",
    r.network,
    "explicit_net"
  );

  // 3d. memorySwap defaults to memory
  clearAll();
  process.env.REPO_AGENT_CONTAINER_MEMORY = "2g";
  dr = loadDockerRunnerFresh();
  r = dr.resolveRuntimeConfig();
  expectEq("resolveRuntimeConfig.memorySwap.fallsBack", r.memorySwap, "2g");

  // 3e. HOST_VOLUMES_ROOT explicit wins
  clearAll();
  process.env.HOST_VOLUMES_ROOT = "/srv/volumes";
  dr = loadDockerRunnerFresh();
  r = dr.resolveRuntimeConfig();
  expectEq(
    "resolveRuntimeConfig.hostVolumes.explicit",
    r.hostVolumesRoot,
    "/srv/volumes"
  );

  // 3f. HOST_VOLUMES_ROOT computed from HOST_PROJECT_ROOT + DOCKER_VOLUMES_ROOT
  clearAll();
  process.env.HOST_PROJECT_ROOT = "/srv/dockerstack";
  process.env.DOCKER_VOLUMES_ROOT = "./.docker-volumes";
  dr = loadDockerRunnerFresh();
  r = dr.resolveRuntimeConfig();
  expectEq(
    "resolveRuntimeConfig.hostVolumes.computed",
    r.hostVolumesRoot,
    "/srv/dockerstack/.docker-volumes"
  );

  // 3g. fallback when nothing set
  clearAll();
  dr = loadDockerRunnerFresh();
  r = dr.resolveRuntimeConfig();
  expectEq(
    "resolveRuntimeConfig.hostVolumes.fallback",
    r.hostVolumesRoot,
    "./.docker-volumes"
  );

  restoreAll();
}

// ── 4. hostPathsForSlot ──────────────────────────────────────────────

function testHostPathsForSlot() {
  section("4. hostPathsForSlot — host bind-mount path layout");
  const dr = loadDockerRunnerFresh();

  const r = { hostVolumesRoot: "/srv/dockerstack/.docker-volumes" };
  const p = dr.hostPathsForSlot("007", r);
  expectEq(
    "hostPaths.repos",
    p.hostReposRoot,
    "/srv/dockerstack/.docker-volumes/repo-agent/repos"
  );
  expectEq(
    "hostPaths.slot",
    p.hostSlotRoot,
    "/srv/dockerstack/.docker-volumes/repo-agent/slots/007"
  );

  const p1 = dr.hostPathsForSlot("001", r);
  const p100 = dr.hostPathsForSlot("100", r);
  check(
    "hostPaths.slotsDistinct",
    p1.hostSlotRoot !== p100.hostSlotRoot,
    "001 vs 100 host slot dirs differ"
  );
  check(
    "hostPaths.reposShared",
    p1.hostReposRoot === p100.hostReposRoot,
    "/repos shared across slots"
  );

  check(
    "hostPaths.noBackslash",
    !p.hostReposRoot.includes("\\") && !p.hostSlotRoot.includes("\\"),
    `${p.hostReposRoot} | ${p.hostSlotRoot}`
  );
}

// ── 5. runSlotContainer (async) ──────────────────────────────────────

async function testRunSlotContainer() {
  section("5. runSlotContainer — docker rm -f + docker run");
  clearCalls();

  // IMPORTANT: install mock BEFORE require — docker-runner.js does
  //   const { execFile } = require("child_process");
  // which destructures the property at load time. Mock-then-load.
  installExecFileMock(({ cmd, args }) => {
    if (cmd !== "docker") throw new Error(`unexpected cmd ${cmd}`);
    if (args[0] === "rm") {
      const e = new Error("Error: No such container: repo-agent-ttyd-009");
      e.code = 1;
      e.stderr = "Error: No such container";
      return e;
    }
    if (args[0] === "run") {
      return "deadbeefdeadbeef0123456789abcdef\n";
    }
    return "";
  });
  const dr = loadDockerRunnerFresh();

  let result;
  try {
    result = await dr.runSlotContainer("009", {
      containerName: "repo-agent-ttyd-009",
      image: "repo-agent-ttyd:local",
      network: "myapp_net",
      domain: "test.local",
      hostReposRoot: "/host/r",
      hostSlotRoot: "/host/s",
    });
  } finally {
    restoreExecFile();
  }

  expectEq(
    "runSlotContainer.callCount",
    calls.filter((c) => c.cmd === "docker").length,
    2
  );
  expectEq(
    "runSlotContainer.firstIsRm",
    calls[0] && calls[0].args && calls[0].args.slice(0, 3),
    ["rm", "-f", "repo-agent-ttyd-009"]
  );
  expectEq(
    "runSlotContainer.secondIsRun",
    calls[1] && calls[1].args && calls[1].args[0],
    "run"
  );

  expectEq(
    "runSlotContainer.containerId",
    result.containerId,
    "deadbeefdeadbeef0123456789abcdef"
  );
  expectEq(
    "runSlotContainer.containerName",
    result.containerName,
    "repo-agent-ttyd-009"
  );
  check(
    "runSlotContainer.argsEchoed",
    Array.isArray(result.args) && result.args[0] === "run",
    "args[] returned"
  );

  check(
    "runSlotContainer.argsContainName",
    result.args.includes("repo-agent-ttyd-009"),
    "name in args"
  );
  expectEq(
    "runSlotContainer.argsLastIsImage",
    result.args[result.args.length - 1],
    "repo-agent-ttyd:local"
  );
}

// ── 6. removeSlotContainer — idempotent ──────────────────────────────

async function testRemoveSlotContainer() {
  section("6. removeSlotContainer — idempotent rm -f");
  clearCalls();

  installExecFileMock(({ cmd, args }) => {
    if (cmd !== "docker") throw new Error(`unexpected cmd ${cmd}`);
    if (args[0] === "rm") {
      const e = new Error("Error: No such container");
      e.code = 1;
      return e;
    }
    return "";
  });
  const dr = loadDockerRunnerFresh();

  let threw = false;
  let result;
  try {
    result = await dr.removeSlotContainer("042", {
      containerName: "repo-agent-ttyd-042",
    });
  } catch (e) {
    threw = true;
  } finally {
    restoreExecFile();
  }
  check("removeSlot.idempotent.noThrow", !threw, "rm -f failure swallowed");
  expectEq(
    "removeSlot.containerName",
    result && result.containerName,
    "repo-agent-ttyd-042"
  );
  expectEq(
    "removeSlot.calledRmF",
    calls[0] && calls[0].args,
    ["rm", "-f", "repo-agent-ttyd-042"]
  );
}

// ── 7. inspectSlotContainer ─────────────────────────────────────────

async function testInspectSlotContainer() {
  section("7. inspectSlotContainer — exists/status/running parsing");

  // Case A: running
  clearCalls();
  installExecFileMock(({ cmd, args }) => {
    if (cmd === "docker" && args[0] === "inspect") {
      return "abc123def456|running|true\n";
    }
    return "";
  });
  let dr = loadDockerRunnerFresh();
  let info;
  try {
    info = await dr.inspectSlotContainer("001", {
      containerName: "repo-agent-ttyd-001",
    });
  } finally {
    restoreExecFile();
  }
  expectEq("inspect.exists", info.exists, true);
  expectEq("inspect.id", info.id, "abc123def456");
  expectEq("inspect.status", info.status, "running");
  expectEq("inspect.running", info.running, true);

  const inspectCall = calls.find((c) => c.cmd === "docker" && c.args[0] === "inspect");
  check(
    "inspect.formatFlag",
    inspectCall &&
      inspectCall.args.includes("--format") &&
      inspectCall.args.includes(
        "{{.Id}}|{{.State.Status}}|{{.State.Running}}"
      ),
    "uses Go template format"
  );

  // Case B: missing → exists:false
  clearCalls();
  installExecFileMock(({ cmd }) => {
    if (cmd === "docker") {
      const e = new Error("No such object: repo-agent-ttyd-099");
      e.code = 1;
      return e;
    }
    return "";
  });
  dr = loadDockerRunnerFresh();
  try {
    info = await dr.inspectSlotContainer("099");
  } finally {
    restoreExecFile();
  }
  expectEq("inspect.missing.exists", info.exists, false);

  // Case C: stopped
  clearCalls();
  installExecFileMock(() => "id1|exited|false\n");
  dr = loadDockerRunnerFresh();
  try {
    info = await dr.inspectSlotContainer("055");
  } finally {
    restoreExecFile();
  }
  expectEq("inspect.stopped.exists", info.exists, true);
  expectEq("inspect.stopped.status", info.status, "exited");
  expectEq("inspect.stopped.running", info.running, false);
}

// ── 8. dockerHealthCheck ─────────────────────────────────────────────

async function testDockerHealthCheck() {
  section("8. dockerHealthCheck — `docker version` probe");

  // Healthy
  clearCalls();
  installExecFileMock(({ cmd, args }) => {
    if (cmd === "docker" && args[0] === "version") return "26.1.4\n";
    return "";
  });
  let dr = loadDockerRunnerFresh();
  let h;
  try {
    h = await dr.dockerHealthCheck();
  } finally {
    restoreExecFile();
  }
  expectEq("dockerHealth.ok.true", h.ok, true);
  const versionCall = calls.find(
    (c) => c.cmd === "docker" && c.args[0] === "version"
  );
  check("dockerHealth.versionCalled", !!versionCall, "version invoked");

  // Unhealthy
  clearCalls();
  installExecFileMock(({ cmd }) => {
    if (cmd === "docker") {
      const e = new Error("permission denied while trying to connect to /var/run/docker.sock");
      e.code = 1;
      e.stderr = "permission denied";
      return e;
    }
    return "";
  });
  dr = loadDockerRunnerFresh();
  try {
    h = await dr.dockerHealthCheck();
  } finally {
    restoreExecFile();
  }
  expectEq("dockerHealth.ok.false", h.ok, false);
  check(
    "dockerHealth.errorMsg",
    /permission denied/.test(h.error || ""),
    `error=${h.error}`
  );
}

// ── Main runner ─────────────────────────────────────────────────────

async function main() {
  // Sync tests first.
  testBuildRunArgsExhaustive();
  testBuildRunArgsDefaultsAndValidation();
  testResolveRuntimeConfig();
  testHostPathsForSlot();

  // Async tests — sequential, each cleans up its own mock.
  await testRunSlotContainer();
  await testRemoveSlotContainer();
  await testInspectSlotContainer();
  await testDockerHealthCheck();

  // ── Summary ──────────────────────────────────────────────────────
  const failed = results.filter((r) => r.status === "FAIL");
  console.log("\n────────────────────────────────────────");
  console.log(
    `Total: ${results.length}  |  PASS: ${results.length - failed.length}  |  FAIL: ${failed.length}`
  );
  if (failed.length > 0) {
    console.log("\nFAIL details:");
    for (const f of failed) {
      console.log(`  • [${f.section}] ${f.name}  — ${f.detail}`);
    }
  }
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Test runner crashed:", err);
  process.exit(1);
});
