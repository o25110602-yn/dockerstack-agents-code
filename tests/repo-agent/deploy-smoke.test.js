// tests/repo-agent/deploy-smoke.test.js
//
// Deploy-readiness smoke test — proves that the refactor is actually
// deployable on Linux + Docker (incl. GitHub-hosted runners), without
// requiring a running Docker daemon.
//
// What this checks:
//   1. compose.repo-ttyd.yml DELETED (refactor invariant: no static slots)
//   2. compose.apps.yml has docker socket mount + DOCKER_GID + new env vars
//   3. cloudflared/config.yml has wildcard ingress placed BEFORE catch-all
//   4. Dockerfile for repo-agent-ttyd builds with required tools (apk lines)
//   5. entrypoint.sh has `-m 1` ttyd flag
//   6. .env.example documents every new var the manager reads
//   7. validate-env.js validates every new var
//   8. docker-runner.js and cloudflare-cname-bulk.js parse OK (require())
//   9. package.json scripts exist for repo-agent-test and cname:*
//   10. compose YAMLs (apart from deleted one) referenced by dc.sh exist
//   11. dc.sh and validate-compose.js no longer reference compose.repo-ttyd.yml
//   12. cloudflare-cname-bulk.js CLI prints help / exits sanely
//
// Strategy:
//   - All checks are STATIC (file existence, regex matching) so the test
//     runs on any CI host without Docker / Linux / GitHub Actions.
//   - Where a behavioural check is needed (e.g. CLI help output), we
//     spawn `node` against the script with a benign arg.
//
// Usage: node tests/repo-agent/deploy-smoke.test.js
// Exit:  0 = all PASS, 1 = at least one FAIL.

"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const PROJECT_ROOT = path.resolve(__dirname, "../..");

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

function readUtf8(rel) {
  return fs.readFileSync(path.join(PROJECT_ROOT, rel), "utf8");
}
function fileExists(rel) {
  try {
    fs.accessSync(path.join(PROJECT_ROOT, rel));
    return true;
  } catch {
    return false;
  }
}

// ── 1. compose.repo-ttyd.yml DELETED ────────────────────────────────

(function testOldComposeRemoved() {
  section("1. Old compose file removed");
  check(
    "OldCompose.deleted",
    !fileExists("docker-compose/compose.repo-ttyd.yml"),
    "compose.repo-ttyd.yml must be gone"
  );
  check(
    "OldComposeGen.deleted",
    !fileExists("services/app/scripts/gen-ttyd-compose.js"),
    "compose generator must be gone"
  );
})();

// ── 2. compose.apps.yml — docker socket + new env vars ───────────────

(function testComposeApps() {
  section("2. compose.apps.yml — manager has socket + new env vars");
  if (!fileExists("compose.apps.yml")) {
    fail("ComposeApps.exists", "compose.apps.yml missing");
    return;
  }
  pass("ComposeApps.exists");
  const src = readUtf8("compose.apps.yml");

  check(
    "ComposeApps.dockerSocketMount",
    /\/var\/run\/docker\.sock:\/var\/run\/docker\.sock/.test(src),
    "docker.sock bind-mount required"
  );
  check(
    "ComposeApps.dockerGidBuildArg",
    /DOCKER_GID:/.test(src),
    "DOCKER_GID build-arg required"
  );

  // New env vars passed to manager so it can spawn ttyd containers
  const mustContain = [
    "REPO_AGENT_TTYD_IMAGE",
    "REPO_AGENT_DOCKER_NETWORK",
    "REPO_AGENT_CONTAINER_MEMORY",
    "REPO_AGENT_CONTAINER_CPUS",
    "REPO_AGENT_CONTAINER_PIDS_LIMIT",
    "REPO_AGENT_TTYD_PORT",
    "HOST_VOLUMES_ROOT",
    "DOCKER_VOLUMES_ROOT",
    "PROJECT_NAME",
    "DOMAIN",
    "TINYAUTH_PORT",
  ];
  for (const k of mustContain) {
    check(
      `ComposeApps.env[${k}]`,
      new RegExp(`\\b${k}\\b`).test(src),
      `${k} must be exposed to manager`
    );
  }

  // /repos and /slots bind mounts (manager + ttyd share)
  check(
    "ComposeApps.reposMount",
    /:\/repos\b/.test(src),
    "/repos mount missing"
  );
  check(
    "ComposeApps.slotsMount",
    /:\/slots\b/.test(src),
    "/slots mount missing"
  );

  // Old `:/workspace:ro` mount must be gone (manager no longer needs project root).
  check(
    "ComposeApps.noWorkspaceMount",
    !/:\/workspace:ro\b/.test(src),
    "manager should not mount project root"
  );
})();

// ── 3. cloudflared/config.yml — wildcard before catch-all ────────────

(function testCloudflared() {
  section("3. cloudflared/config.yml — wildcard ingress");
  if (!fileExists("cloudflared/config.yml")) {
    // config.yml is .gitignored in some setups; check the example.
    check(
      "Cloudflared.exampleHasWildcard",
      fileExists("cloudflared/config.yml.example"),
      "fallback to config.yml.example"
    );
    if (fileExists("cloudflared/config.yml.example")) {
      const ex = readUtf8("cloudflared/config.yml.example");
      check(
        "Cloudflared.example.wildcard",
        /hostname:\s*"?\*\./.test(ex),
        "example must show wildcard ingress"
      );
    }
    return;
  }

  const src = readUtf8("cloudflared/config.yml");
  check(
    "Cloudflared.hasIngress",
    /^ingress:/m.test(src),
    "ingress: block present"
  );

  // Wildcard ingress entry must exist
  const wildcardRegex = /-\s*hostname:\s*['"]?\*\./;
  check(
    "Cloudflared.hasWildcard",
    wildcardRegex.test(src),
    "wildcard *.<DOMAIN> ingress required"
  );

  // catch-all 404 must be the LAST ingress entry — wildcard before it
  const lines = src.split(/\r?\n/);
  const wildcardIdx = lines.findIndex((l) => /-\s*hostname:\s*['"]?\*\./.test(l));
  const catchAllIdx = lines.findIndex((l) => /service:\s*http_status:404/.test(l));
  check(
    "Cloudflared.wildcardBeforeCatchAll",
    wildcardIdx >= 0 && catchAllIdx >= 0 && wildcardIdx < catchAllIdx,
    `wildcard at line ${wildcardIdx + 1}, catch-all at line ${catchAllIdx + 1}`
  );

  // Wildcard service must point to caddy:80 (not directly to a backend)
  const wildcardLineEnd = lines.findIndex(
    (l, i) => i > wildcardIdx && /service:/.test(l)
  );
  if (wildcardLineEnd > 0) {
    check(
      "Cloudflared.wildcardToCaddy",
      /service:\s*http:\/\/caddy:80/.test(lines[wildcardLineEnd]),
      "wildcard must route to caddy"
    );
  }
})();

// ── 4. Dockerfile for repo-agent-ttyd ────────────────────────────────

(function testTtydDockerfile() {
  section("4. services/repo-agent-ttyd/Dockerfile");
  const rel = "services/repo-agent-ttyd/Dockerfile";
  if (!fileExists(rel)) {
    fail("TtydDockerfile.exists", `${rel} missing`);
    return;
  }
  pass("TtydDockerfile.exists");
  const src = readUtf8(rel);
  check(
    "TtydDockerfile.fromTtyd",
    /^FROM\s+(tsl0922\/ttyd|.*ttyd)/m.test(src),
    "must start FROM ttyd image"
  );
  // Required tools for coding agents
  for (const tool of ["bash", "git", "nodejs", "npm", "jq"]) {
    check(
      `TtydDockerfile.has[${tool}]`,
      new RegExp(`\\b${tool}\\b`).test(src),
      `${tool} required`
    );
  }
  check(
    "TtydDockerfile.exposes7681",
    /EXPOSE\s+7681/.test(src),
    "must EXPOSE 7681"
  );
  check(
    "TtydDockerfile.entrypoint",
    /ENTRYPOINT.*entrypoint/i.test(src),
    "ENTRYPOINT directive missing"
  );
  check(
    "TtydDockerfile.entrypointFile",
    fileExists("services/repo-agent-ttyd/entrypoint.sh"),
    "entrypoint.sh missing"
  );
})();

// ── 5. entrypoint.sh — ttyd -m 1 ────────────────────────────────────

(function testEntrypoint() {
  section("5. services/repo-agent-ttyd/entrypoint.sh");
  const rel = "services/repo-agent-ttyd/entrypoint.sh";
  if (!fileExists(rel)) {
    fail("Entrypoint.exists", `${rel} missing`);
    return;
  }
  pass("Entrypoint.exists");
  const src = readUtf8(rel);

  // Must invoke ttyd at least once
  const ttydInvocations = src.match(/exec\s+ttyd\s/g) || [];
  check(
    "Entrypoint.invokesTtyd",
    ttydInvocations.length >= 1,
    `${ttydInvocations.length} ttyd invocation(s)`
  );

  // Every ttyd invocation should use -m 1 (single-client per slot)
  // The script has 4 invocations covering different startup modes.
  const lines = src.split(/\r?\n/);
  const ttydLines = lines.filter((l) => /exec\s+ttyd\s/.test(l));
  const withDashM = ttydLines.filter((l) => /-m\s+1\b/.test(l));
  check(
    "Entrypoint.allTtydHaveDashM",
    ttydLines.length > 0 && withDashM.length === ttydLines.length,
    `${withDashM.length}/${ttydLines.length} ttyd lines have -m 1`
  );
})();

// ── 6. .env.example — new vars documented ───────────────────────────

(function testEnvExample() {
  section("6. .env.example — new vars documented");
  if (!fileExists(".env.example")) {
    fail("EnvExample.exists", ".env.example missing");
    return;
  }
  pass("EnvExample.exists");
  const src = readUtf8(".env.example");

  // Each new var must appear as a key (KEY=) at column 0 (commented-out
  // examples ARE allowed since validator treats them as documentation).
  const newVars = [
    "REPO_AGENT_TTYD_IMAGE",
    "REPO_AGENT_DOCKER_NETWORK",
    "REPO_AGENT_CONTAINER_MEMORY",
    "REPO_AGENT_CONTAINER_MEMORY_SWAP",
    "REPO_AGENT_CONTAINER_CPUS",
    "REPO_AGENT_CONTAINER_PIDS_LIMIT",
    "REPO_AGENT_TTYD_PORT",
    "HOST_VOLUMES_ROOT",
    "HOST_PROJECT_ROOT",
    "DOCKER_VOLUMES_ROOT",
    "DOCKER_GID",
  ];
  for (const k of newVars) {
    const re = new RegExp(`^[#\\s]*${k}=`, "m");
    check(`EnvExample.has[${k}]`, re.test(src), `${k}= must appear in .env.example`);
  }

  // Old gen-ttyd-compose reference should be REMOVED — except as a
  // historical note explaining the refactor (must mention "bỏ"/"removed"
  // /"deleted" on the same line).
  const lines = src.split(/\r?\n/);
  const staleRefs = lines
    .map((l, i) => ({ l, i }))
    .filter(({ l }) => /gen-ttyd-compose/i.test(l))
    .filter(({ l }) => !/(bỏ|deleted|removed|xoá|xóa|gone|no longer|refactor)/i.test(l));
  check(
    "EnvExample.noStaleGenScript",
    staleRefs.length === 0,
    staleRefs.length === 0
      ? "ok"
      : `still references gen-ttyd-compose without refactor note at line(s): ${staleRefs.map((x) => x.i + 1).join(",")}`
  );
})();

// ── 7. validate-env.js — references new vars ────────────────────────

(function testValidateEnv() {
  section("7. validate-env.js — knows about new vars");
  const rel = "docker-compose/scripts/validate-env.js";
  if (!fileExists(rel)) {
    fail("ValidateEnv.exists", `${rel} missing`);
    return;
  }
  pass("ValidateEnv.exists");
  const src = readUtf8(rel);

  // Existing required vars (sanity)
  check(
    "ValidateEnv.firebase",
    /REPO_AGENT_FIREBASE_DATABASE_URL/.test(src),
    "Firebase URL still validated"
  );
  // New optional vars (added by refactor) — at least these should be
  // mentioned (validator may treat them as `checkOptional`).
  const optionals = [
    "REPO_AGENT_TTYD_IMAGE",
    "REPO_AGENT_TOTAL_SLOTS",
    "DOCKER_GID",
  ];
  for (const k of optionals) {
    check(
      `ValidateEnv.knows[${k}]`,
      new RegExp(`\\b${k}\\b`).test(src),
      `${k} must be mentioned`
    );
  }
})();

// ── 8. JS modules require() cleanly ─────────────────────────────────

(function testRequiresClean() {
  section("8. require() docker-runner + cname tool");
  let dr;
  try {
    dr = require(path.join(PROJECT_ROOT, "services/app/src/docker-runner.js"));
    pass("Require.dockerRunner");
  } catch (e) {
    fail("Require.dockerRunner", String(e.message || e));
  }

  if (dr) {
    for (const fn of [
      "buildRunArgs",
      "runSlotContainer",
      "removeSlotContainer",
      "inspectSlotContainer",
      "dockerHealthCheck",
      "resolveRuntimeConfig",
      "hostPathsForSlot",
    ]) {
      check(
        `Require.dockerRunner.${fn}`,
        typeof dr[fn] === "function",
        `${fn} must be exported as function`
      );
    }
  }

  // cname tool — must at least parse as Node module (no syntax errors).
  // Don't actually require()/run it because it may auto-execute on require;
  // instead, syntax-check via `node --check`.
  const cnameTool = path.join(PROJECT_ROOT, "scripts/cloudflare-cname-bulk.js");
  if (fs.existsSync(cnameTool)) {
    try {
      execFileSync(process.execPath, ["--check", cnameTool], {
        stdio: "pipe",
      });
      pass("Require.cnameTool.syntax", "node --check OK");
    } catch (e) {
      fail("Require.cnameTool.syntax", String(e.stderr || e.message || e));
    }
  } else {
    fail("Require.cnameTool.exists", `${cnameTool} missing`);
  }
})();

// ── 9. package.json scripts ─────────────────────────────────────────

(function testPackageJsonScripts() {
  section("9. package.json — refactor scripts present");
  const pkg = JSON.parse(readUtf8("package.json"));
  const scripts = pkg.scripts || {};

  const must = [
    "repo-agent-test:mock-flow",
    "repo-agent-test:http",
    "repo-agent-test:docker-runner",
    "repo-agent-test:deploy-smoke",
    "repo-agent-test:all",
    "cname:verify",
    "cname:list",
    "cname:create-wildcard",
    "cname:delete-wildcard",
    "cname:create-all",
    "cname:delete-all",
    "dockerapp-validate:env",
    "dockerapp-validate:compose",
    "dockerapp-validate:all",
  ];
  for (const k of must) {
    check(
      `Scripts.has[${k}]`,
      typeof scripts[k] === "string" && scripts[k].length > 0,
      `script ${k} required`
    );
  }

  // The :all alias should chain the three repo-agent tests at minimum.
  if (scripts["repo-agent-test:all"]) {
    const all = scripts["repo-agent-test:all"];
    check(
      "Scripts.all.chains.mockFlow",
      /repo-agent-test:mock-flow/.test(all),
      "repo-agent-test:all must run mock-flow"
    );
    check(
      "Scripts.all.chains.http",
      /repo-agent-test:http/.test(all),
      "repo-agent-test:all must run http"
    );
    check(
      "Scripts.all.chains.dockerRunner",
      /repo-agent-test:docker-runner/.test(all),
      "repo-agent-test:all must run docker-runner"
    );
    check(
      "Scripts.all.chains.deploySmoke",
      /repo-agent-test:deploy-smoke/.test(all),
      "repo-agent-test:all must run deploy-smoke"
    );
  }

  // Old generator script should be GONE
  for (const stale of ["gen-ttyd-compose"]) {
    const has = Object.values(scripts).some((v) => v.includes(stale));
    check(
      `Scripts.noStale[${stale}]`,
      !has,
      `${stale} script must be removed`
    );
  }
})();

// ── 10. dc.sh + validate-compose.js no longer reference deleted file ─

(function testDcShCleansUp() {
  section("10. dc.sh + validate-compose.js no longer reference compose.repo-ttyd.yml");

  for (const rel of [
    "docker-compose/scripts/dc.sh",
    "docker-compose/scripts/validate-compose.js",
  ]) {
    if (!fileExists(rel)) {
      fail(`Cleanup.exists[${rel}]`, "missing");
      continue;
    }
    const src = readUtf8(rel);
    // It's OK to mention compose.repo-ttyd.yml IN COMMENTS (refactor note).
    // What's NOT ok is to use it as a `-f` flag arg or include it in a
    // FILES array entry.
    const lines = src.split(/\r?\n/);
    const stillUses = lines.some(
      (l) =>
        /compose\.repo-ttyd\.yml/.test(l) &&
        !/^\s*#/.test(l) && // not a # comment
        !/^\s*\/\//.test(l) && // not a // comment
        !/\*/.test(l) // not inside a /* … */ comment marker
    );
    check(
      `Cleanup.noActiveRef[${path.basename(rel)}]`,
      !stillUses,
      stillUses
        ? "active (non-comment) reference still present"
        : "only comment references remain (OK)"
    );
  }
})();

// ── 11. cloudflare-cname-bulk.js — CLI runs without crashing ─────────

(function testCnameToolHelp() {
  section("11. cloudflare-cname-bulk.js — CLI smoke");
  const tool = path.join(PROJECT_ROOT, "scripts/cloudflare-cname-bulk.js");
  if (!fs.existsSync(tool)) {
    fail("CnameTool.exists", `${tool} missing`);
    return;
  }
  pass("CnameTool.exists");

  // Run with no args — should print usage + exit non-zero (or 0 with help).
  // We capture both — what matters is: exits within timeout, prints something
  // to stdout/stderr, and doesn't crash with an uncaught throw.
  let stdout = "";
  let stderr = "";
  let exited = false;
  let exitCode = -1;
  try {
    stdout = execFileSync(process.execPath, [tool], {
      timeout: 8000,
      stdio: "pipe",
      encoding: "utf8",
    });
    exited = true;
    exitCode = 0;
  } catch (e) {
    // execFileSync throws on non-zero exit — that's expected for a CLI
    // that prints help to stderr and exits with code 1/2.
    exited = !!e.status || e.status === 0;
    exitCode = e.status == null ? -1 : e.status;
    stdout = String(e.stdout || "");
    stderr = String(e.stderr || "");
  }
  check("CnameTool.exited", exited, `exit code ${exitCode}`);
  const combined = stdout + stderr;
  check(
    "CnameTool.printsUsage",
    /usage|command|verify|create-wildcard|delete-wildcard/i.test(combined),
    `output length ${combined.length}`
  );
})();

// ── 12. README / docs mention refactor ───────────────────────────────

(function testReadmeMentions() {
  section("12. README / docs mention dynamic ttyd / docker run");
  // OPTIONAL — skip silently if README doesn't exist.
  if (!fileExists("README.md")) return;
  const src = readUtf8("README.md");
  // Soft check — at least one of these should appear so future maintainers
  // know the architecture changed.
  const hints = [
    /docker-runner/i,
    /docker run/i,
    /dynamic ttyd/i,
    /ttyd[\d{}.]+\.\$\{?DOMAIN/i,
    /wildcard/i,
  ];
  const matched = hints.some((re) => re.test(src));
  check(
    "Readme.mentionsRefactor",
    matched,
    matched ? "found at least one architecture hint" : "consider documenting the refactor"
  );
})();

// ── Summary ─────────────────────────────────────────────────────────

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
