// src/docker-runner.js — dynamic ttyd slot launcher via `docker run`
//
// Thay thế cách cũ (compose service tĩnh ttyd-001..ttyd-100 + dc.sh up).
// Mỗi slot bây giờ là 1 container được manager spawn trực tiếp bằng
// `docker run -d --name repo-agent-ttyd-<slot> ...` với labels Caddy đầy đủ.
//
// Tại sao bỏ compose:
//   - 100 service tĩnh trong YAML 1650 dòng + auto-generator dễ lỗi
//   - dc.sh phức tạp (HOST_PROJECT_ROOT, --env-file, --profile, project-directory)
//     khi chạy in-container đồng bộ /var/run/docker.sock với host runner
//   - `docker run` đơn giản, idempotent, dễ debug bằng `docker ps`/`docker logs`
//
// Quan trọng:
//   - Container ttyd join cùng network `${PROJECT_NAME}_net` → Caddy auto-route
//     qua label theo cơ chế của caddy-docker-proxy (đọc Docker events).
//   - Volume mount dùng HOST path (resolve từ HOST_VOLUMES_ROOT) vì daemon
//     thực thi `docker run` là daemon HOST, không phải in-container.
//
// Public API:
//   - runSlotContainer(slot, opts) → spawn container, trả {containerId}
//   - removeSlotContainer(slot)    → docker rm -f, idempotent
//   - inspectSlotContainer(slot)   → {exists, status, id} cho health-check
//   - buildRunArgs(...)            → exposed cho test (kiểm tra labels/flags)

"use strict";

const { execFile } = require("child_process");
const path = require("path");

// ── Helpers ────────────────────────────────────────────────────────

function execDocker(args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      "docker",
      args,
      {
        env: process.env,
        maxBuffer: 16 * 1024 * 1024,
        ...opts,
      },
      (err, stdout, stderr) => {
        if (err) {
          err.stdout = stdout;
          err.stderr = stderr;
          err.dockerArgs = args;
          return reject(err);
        }
        resolve({ stdout: String(stdout || ""), stderr: String(stderr || "") });
      }
    );
  });
}

function getEnvOrDefault(key, dflt) {
  const v = process.env[key];
  return v == null || v === "" ? dflt : v;
}

// ── Build args for `docker run` ───────────────────────────────────

/**
 * Build argv cho `docker run -d ...`.
 * Tách thành function thuần để test verify từng flag/label mà không cần daemon.
 *
 * @param {object} cfg
 * @param {string} cfg.slot              "001".."100"
 * @param {string} cfg.containerName     "repo-agent-ttyd-001"
 * @param {string} cfg.image             "repo-agent-ttyd:local"
 * @param {string} cfg.network           "${PROJECT_NAME}_net"
 * @param {string} cfg.domain            ex "myapp.example.com"
 * @param {string} cfg.tinyauthPort      "3000"
 * @param {string} cfg.hostReposRoot     HOST path → mount /repos
 * @param {string} cfg.hostSlotRoot      HOST path → mount /slot (slot-cụ-thể)
 * @param {string} cfg.memory            "1g"
 * @param {string} cfg.memorySwap        "1g"
 * @param {string} cfg.cpus              "1"
 * @param {string|number} cfg.pidsLimit  512
 * @param {string} cfg.ttydPort          "7681"
 * @returns {string[]}                   argv tới `docker`
 */
function buildRunArgs(cfg) {
  if (!cfg || !cfg.slot) throw new Error("buildRunArgs: cfg.slot required");
  if (!cfg.image) throw new Error("buildRunArgs: cfg.image required");
  if (!cfg.network) throw new Error("buildRunArgs: cfg.network required");
  if (!cfg.domain) throw new Error("buildRunArgs: cfg.domain required");
  if (!cfg.containerName) throw new Error("buildRunArgs: cfg.containerName required");
  if (!cfg.hostReposRoot) throw new Error("buildRunArgs: cfg.hostReposRoot required");
  if (!cfg.hostSlotRoot) throw new Error("buildRunArgs: cfg.hostSlotRoot required");

  const slot = String(cfg.slot);
  const ttydPort = String(cfg.ttydPort || "7681");
  const tinyauthPort = String(cfg.tinyauthPort || "3000");
  const memory = String(cfg.memory || "1g");
  const memorySwap = String(cfg.memorySwap || memory);
  const cpus = String(cfg.cpus || "1");
  const pidsLimit = String(cfg.pidsLimit || "512");

  // Pattern URL: ttyd<NNN>.${DOMAIN} (no dash) — giữ giống launcher.slotHost().
  const subdomain = `ttyd${slot}`;
  const fqdn = `${subdomain}.${cfg.domain}`;
  // Hostname container — chuẩn DNS (a-z, 0-9, -). Có dấu gạch nối:
  // "ttyd-001". Caddy không phụ thuộc hostname này, chỉ phụ thuộc label.
  const hostname = `ttyd-${slot}`;

  const args = [
    "run",
    "-d",
    "--name", cfg.containerName,
    "--hostname", hostname,
    "--init",
    "--restart", "no",
    "--network", cfg.network,
    "--memory", memory,
    "--memory-swap", memorySwap,
    "--cpus", cpus,
    "--pids-limit", pidsLimit,
    "--security-opt", "no-new-privileges",
    // ttyd container không cần thêm capability nào ngoài mặc định (đọc/ghi /workspace).
    // Không cap-drop ALL vì git/ssh/node cần một số cap mặc định để chmod, link.
    // Volume — đường dẫn HOST vì daemon chạy ở host.
    "-v", `${cfg.hostReposRoot}:/repos`,
    "-v", `${cfg.hostSlotRoot}:/slot`,
    // Env cho entrypoint
    "-e", "REPO_AGENT_SLOT_DIR=/slot",
    "-e", `REPO_AGENT_TTYD_PORT=${ttydPort}`,
    "-e", `REPO_AGENT_SLOT=${slot}`,
    // Label cho caddy-docker-proxy — y hệt block compose cũ (ttyd<NNN>.${DOMAIN}).
    "--label", `caddy=http://${fqdn}`,
    "--label", `caddy.forward_auth=tinyauth:${tinyauthPort}`,
    "--label", `caddy.forward_auth.uri=/api/auth/caddy`,
    "--label", `caddy.forward_auth.header_up=X-Forwarded-Proto https`,
    "--label", `caddy.forward_auth.copy_headers=Remote-User Remote-Email Remote-Name Remote-Groups`,
    "--label", `caddy.reverse_proxy={{upstreams ${ttydPort}}}`,
    "--label", `caddy.reverse_proxy.flush_interval=-1`,
    // Labels metadata để dễ filter/inspect.
    "--label", `dockerstack.role=repo-agent-ttyd-slot`,
    "--label", `dockerstack.slot=${slot}`,
    cfg.image,
  ];
  return args;
}

// ── Public actions ────────────────────────────────────────────────

/**
 * Spawn container cho slot. Idempotent: nếu container đã tồn tại (theo name),
 * remove trước rồi run lại.
 * Trả về {containerId}.
 */
async function runSlotContainer(slot, opts = {}) {
  const containerName = opts.containerName || `repo-agent-ttyd-${slot}`;

  // Best-effort: dọn container cũ cùng tên (running hoặc exited).
  await execDocker(["rm", "-f", containerName]).catch(() => null);

  const args = buildRunArgs({ slot, containerName, ...opts });
  const { stdout } = await execDocker(args);
  const containerId = stdout.trim();
  return { containerId, containerName, args };
}

async function removeSlotContainer(slot, opts = {}) {
  const containerName = opts.containerName || `repo-agent-ttyd-${slot}`;
  // -f stop + remove. Không throw nếu không tồn tại (idempotent).
  await execDocker(["rm", "-f", containerName]).catch(() => null);
  return { containerName };
}

async function inspectSlotContainer(slot, opts = {}) {
  const containerName = opts.containerName || `repo-agent-ttyd-${slot}`;
  try {
    const { stdout } = await execDocker([
      "inspect",
      "--format",
      "{{.Id}}|{{.State.Status}}|{{.State.Running}}",
      containerName,
    ]);
    const line = stdout.trim();
    if (!line) return { exists: false };
    const [id, status, running] = line.split("|");
    return {
      exists: true,
      id,
      status,
      running: running === "true",
    };
  } catch {
    return { exists: false };
  }
}

// Healthcheck: gọi 1 lệnh `docker version` để chắc chắn socket OK + có quyền.
async function dockerHealthCheck() {
  try {
    await execDocker(["version", "--format", "{{.Server.Version}}"]);
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: String(err.message || err),
      stderr: String(err.stderr || ""),
    };
  }
}

// Resolve config từ env (gọi 1 lần khi build args).
function resolveRuntimeConfig() {
  const PROJECT_NAME = getEnvOrDefault("PROJECT_NAME", "myapp");
  const DOMAIN = getEnvOrDefault("DOMAIN", "localhost");
  const TINYAUTH_PORT = getEnvOrDefault("TINYAUTH_PORT", "3000");
  const REPO_AGENT_TTYD_IMAGE = getEnvOrDefault(
    "REPO_AGENT_TTYD_IMAGE",
    "repo-agent-ttyd:local"
  );
  const REPO_AGENT_DOCKER_NETWORK = getEnvOrDefault(
    "REPO_AGENT_DOCKER_NETWORK",
    `${PROJECT_NAME}_net`
  );
  const memory = getEnvOrDefault("REPO_AGENT_CONTAINER_MEMORY", "1g");
  const memorySwap = getEnvOrDefault("REPO_AGENT_CONTAINER_MEMORY_SWAP", memory);
  const cpus = getEnvOrDefault("REPO_AGENT_CONTAINER_CPUS", "1");
  const pidsLimit = getEnvOrDefault("REPO_AGENT_CONTAINER_PIDS_LIMIT", "512");
  const ttydPort = getEnvOrDefault("REPO_AGENT_TTYD_PORT", "7681");

  // HOST_VOLUMES_ROOT — đường dẫn ABSOLUTE trên HOST (Docker daemon view) tới
  // ${DOCKER_VOLUMES_ROOT}. Cần vì khi manager chạy in-container và share
  // /var/run/docker.sock với host, các bind-mount của container con phải là
  // path host. Mặc định = HOST_PROJECT_ROOT/.docker-volumes (tự ghép).
  const HOST_PROJECT_ROOT = getEnvOrDefault("HOST_PROJECT_ROOT", "");
  const DOCKER_VOLUMES_ROOT_REL = getEnvOrDefault(
    "DOCKER_VOLUMES_ROOT",
    "./.docker-volumes"
  );
  let hostVolumesRoot = getEnvOrDefault("HOST_VOLUMES_ROOT", "");
  if (!hostVolumesRoot) {
    if (HOST_PROJECT_ROOT) {
      hostVolumesRoot = path.posix.join(
        HOST_PROJECT_ROOT.replace(/\\/g, "/"),
        DOCKER_VOLUMES_ROOT_REL.replace(/^\.\//, "")
      );
    } else {
      // Fallback: dùng path trong-container (chỉ work khi chạy trên host bare).
      hostVolumesRoot = DOCKER_VOLUMES_ROOT_REL;
    }
  }

  return {
    image: REPO_AGENT_TTYD_IMAGE,
    network: REPO_AGENT_DOCKER_NETWORK,
    domain: DOMAIN,
    tinyauthPort: TINYAUTH_PORT,
    memory,
    memorySwap,
    cpus,
    pidsLimit,
    ttydPort,
    hostVolumesRoot,
  };
}

function hostPathsForSlot(slot, runtime = null) {
  const r = runtime || resolveRuntimeConfig();
  const repoAgentRoot = path.posix.join(
    r.hostVolumesRoot.replace(/\\/g, "/"),
    "repo-agent"
  );
  return {
    hostReposRoot: path.posix.join(repoAgentRoot, "repos"),
    hostSlotRoot: path.posix.join(repoAgentRoot, "slots", String(slot)),
  };
}

module.exports = {
  buildRunArgs,
  runSlotContainer,
  removeSlotContainer,
  inspectSlotContainer,
  dockerHealthCheck,
  resolveRuntimeConfig,
  hostPathsForSlot,
  // Test hook: cho phép test override execFile bằng cách require module này
  // và monkey-patch ngay hàm execDocker thông qua child_process.execFile.
};
