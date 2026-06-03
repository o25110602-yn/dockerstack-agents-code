// src/agent-creds.js — materialize Agent Credentials cho từng slot
//
// Mỗi slot có thư mục:
//   ${SLOTS_ROOT}/<slot>/injected-files/  (file/script)
//   ${SLOTS_ROOT}/<slot>/runtime.env      (env vars)
//
// Khi close session -> xóa injected-files và reset runtime.env.

"use strict";

const fs = require("fs");
const path = require("path");
const { fromBase64 } = require("./util");

const SLOTS_ROOT = process.env.REPO_AGENT_SLOTS_ROOT || "/slots";

function slotDir(slot) {
  return path.join(SLOTS_ROOT, String(slot));
}

function ensureSlotDir(slot) {
  const dir = slotDir(slot);
  fs.mkdirSync(path.join(dir, "injected-files"), { recursive: true });
  return dir;
}

function writeRuntimeEnv(slot, envMap) {
  const dir = ensureSlotDir(slot);
  const file = path.join(dir, "runtime.env");
  const lines = Object.entries(envMap || {}).map(
    ([k, v]) => `${k}=${String(v ?? "")}`
  );
  fs.writeFileSync(file, lines.join("\n") + "\n", { mode: 0o600 });
  return file;
}

function clearSlotInjectedFiles(slot) {
  const dir = path.join(slotDir(slot), "injected-files");
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  fs.mkdirSync(dir, { recursive: true });
}

function resetSlotRuntimeEnv(slot) {
  const file = path.join(slotDir(slot), "runtime.env");
  try {
    if (fs.existsSync(file)) fs.rmSync(file, { force: true });
  } catch {
    /* ignore */
  }
}

/**
 * Apply một danh sách AgentCredential (đã filter enabled, đúng agentProfileId)
 * vào slot. Trả về:
 *   { envExtras, scripts, files }
 *
 * - type=file:    decode contentBase64 → ghi targetPath (relative under
 *                 injected-files/) và 1 mapping host→container.
 * - type=script:  decode scriptBase64 → bootstrap.sh (chạy trước agent).
 * - type=env:     gộp vào envExtras.
 * - type=capture: cũng coi như file (đã capture sẵn contentBase64).
 */
function materializeForSlot(slot, credentials) {
  ensureSlotDir(slot);
  clearSlotInjectedFiles(slot);

  const slotInjectedDir = path.join(slotDir(slot), "injected-files");
  const envExtras = {};
  const scripts = [];
  const files = [];

  for (const cred of credentials || []) {
    if (cred.enabled === false) continue;
    switch (cred.type) {
      case "file":
      case "capture": {
        const target = cred.targetPath;
        if (!target) break;
        // Store inside injected-files/files/<safe-targetPath> on host.
        // Inside the ttyd container, slot dir is mounted at /slot, so the
        // entrypoint sees the file at /slot/injected-files/files/...
        // Manifest records BOTH host and container-side source paths so
        // the entrypoint can find it without knowing the host layout.
        const safe = target.replace(/[^A-Za-z0-9._/-]+/g, "_").replace(/^\/+/, "");
        const hostFile = path.join(slotInjectedDir, "files", safe);
        const containerSource = path.posix.join(
          "/slot/injected-files/files",
          safe
        );
        fs.mkdirSync(path.dirname(hostFile), { recursive: true });
        const buf = Buffer.from(cred.contentBase64 || "", "base64");
        const modeOctal = parseInt(cred.mode || "0600", 8) || 0o600;
        fs.writeFileSync(hostFile, buf, { mode: modeOctal });
        files.push({
          // Canonical fields used by the ttyd entrypoint manifest reader.
          source: containerSource,
          targetPath: target,
          mode: cred.mode || "0600",
          name: cred.name || "",
          // Backward-compatible aliases (some older entrypoints read these).
          hostPath: hostFile,
          containerPath: target,
        });
        break;
      }
      case "script": {
        const safeName = `bootstrap-${(cred.id || "x").replace(/[^A-Za-z0-9_-]+/g, "_")}.sh`;
        const hostFile = path.join(slotInjectedDir, safeName);
        const buf = Buffer.from(cred.scriptBase64 || "", "base64");
        fs.writeFileSync(hostFile, buf, { mode: 0o700 });
        scripts.push({ hostPath: hostFile, name: safeName, credentialName: cred.name || "" });
        break;
      }
      case "env": {
        if (cred.env && typeof cred.env === "object") {
          for (const [k, v] of Object.entries(cred.env)) {
            envExtras[k] = String(v ?? "");
          }
        }
        break;
      }
      default:
        // Unknown type → ignore.
        break;
    }
  }

  // Always write a manifest so a downstream entrypoint (if any) can replay.
  const manifest = { files, scripts, envExtras };
  fs.writeFileSync(
    path.join(slotInjectedDir, "_manifest.json"),
    JSON.stringify(manifest, null, 2),
    { mode: 0o600 }
  );

  return { envExtras, scripts, files };
}

module.exports = {
  SLOTS_ROOT,
  slotDir,
  ensureSlotDir,
  writeRuntimeEnv,
  clearSlotInjectedFiles,
  resetSlotRuntimeEnv,
  materializeForSlot,
};
