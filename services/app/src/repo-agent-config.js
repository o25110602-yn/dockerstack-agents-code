// src/repo-agent-config.js
// Đọc/ghi cấu hình Repo Agent ở Firebase /repoAgent/config.
// Trả về default nếu Firebase chưa có. Giúp .env gọn (xem .env.example).
"use strict";

const fb = require("./firebase");

const DEFAULTS = Object.freeze({
  ttydPoolSize: 100,
  ttydImage: "repo-agent-ttyd:local",
  ttydHostPattern: "ttyd{slot}.${DOMAIN}",
  ttydUrlPattern: "https://ttyd{slot}.${DOMAIN}",
  workspacesRoot: "/repos",
  removeContainerOnClose: true,
});

const CONFIG_PATH = "/repoAgent/config";

let _cache = null;
let _cacheAt = 0;
const CACHE_TTL_MS = 5_000;

async function getConfig({ force = false } = {}) {
  const now = Date.now();
  if (!force && _cache && now - _cacheAt < CACHE_TTL_MS) {
    return _cache;
  }
  let remote = {};
  try {
    remote = (await fb.readPath(CONFIG_PATH)) || {};
  } catch {
    remote = {};
  }
  // env override (escape hatch — chỉ dùng khi không có Firebase)
  const fromEnv = {};
  if (process.env.REPO_AGENT_TOTAL_SLOTS) {
    fromEnv.ttydPoolSize = parseInt(process.env.REPO_AGENT_TOTAL_SLOTS, 10);
  }
  if (process.env.REPO_AGENT_TTYD_IMAGE) {
    fromEnv.ttydImage = process.env.REPO_AGENT_TTYD_IMAGE;
  }
  _cache = { ...DEFAULTS, ...remote, ...fromEnv };
  _cacheAt = now;
  return _cache;
}

function getDefaults() {
  return { ...DEFAULTS };
}

function clearCache() {
  _cache = null;
  _cacheAt = 0;
}

module.exports = {
  DEFAULTS,
  CONFIG_PATH,
  getConfig,
  getDefaults,
  clearCache,
};
