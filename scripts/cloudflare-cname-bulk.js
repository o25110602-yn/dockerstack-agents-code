#!/usr/bin/env node
// scripts/cloudflare-cname-bulk.js
//
// CLI tool để tạo/xóa DNS CNAME records cho 100 ttyd slot trên Cloudflare.
// CHẠY 1 LẦN khi setup, KHÔNG gọi từ runtime của manager.
//
// Tại sao có script này:
//   Cloudflare Tunnel chỉ route subdomain dựa vào ingress rules trong
//   `cloudflared/config.yml`. Để route được ttyd001..ttyd100, có 2 cách:
//     1. (Khuyến nghị) Wildcard: thêm `*.${DOMAIN}` vào ingress, +
//        1 DNS record `*.${DOMAIN} CNAME <tunnel>.cfargotunnel.com`
//        → script này có lệnh `create-wildcard` / `delete-wildcard`.
//     2. Cụ thể: tạo 100 record `ttyd001..ttyd100 CNAME <tunnel>...`
//        → script này có lệnh `create-all` / `delete-all`.
//
// Yêu cầu env (.env):
//   CLOUDFLARED_API_TOKEN     — Cloudflare API token có quyền edit DNS
//   CLOUDFLARED_ZONE_ID       — Zone ID của domain
//   DOMAIN                    — domain root (ví dụ example.com)
//   CLOUDFLARED_TUNNEL_ID     — UUID tunnel (xem `cloudflared tunnel list`)
//                               HOẶC tunnel hostname đầy đủ:
//                               <tunnel-id>.cfargotunnel.com
//
// Usage:
//   node scripts/cloudflare-cname-bulk.js create-wildcard
//   node scripts/cloudflare-cname-bulk.js delete-wildcard
//   node scripts/cloudflare-cname-bulk.js create-all
//   node scripts/cloudflare-cname-bulk.js delete-all
//   node scripts/cloudflare-cname-bulk.js list
//   node scripts/cloudflare-cname-bulk.js create ttyd047
//   node scripts/cloudflare-cname-bulk.js delete ttyd047
//   node scripts/cloudflare-cname-bulk.js verify       # smoke test API token
//
// Exit code: 0 OK, 1 partial fail, 2 fatal (token/zone sai).

"use strict";

const fs = require("fs");
const path = require("path");
const https = require("https");

// ── Tiny .env loader (no dotenv dep) ──────────────────────────────
function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  const raw = fs.readFileSync(file, "utf8");
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const idx = line.indexOf("=");
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    // strip surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] == null) process.env[key] = value;
  }
}

const ENV_FILE = process.env.ENV_FILE || path.resolve(__dirname, "..", ".env");
loadDotEnv(ENV_FILE);

const API_TOKEN = process.env.CLOUDFLARED_API_TOKEN || "";
const ZONE_ID = process.env.CLOUDFLARED_ZONE_ID || "835d2e2cc167da44769841a15c8beb3c";
const DOMAIN = process.env.DOMAIN || "dockerstackagentscode.dpdns.org";
const TUNNEL_ID = process.env.CLOUDFLARED_TUNNEL_ID || "9d241926-7a36-441a-bfac-2ff960946ea9";
const TOTAL_SLOTS = parseInt(process.env.REPO_AGENT_TOTAL_SLOTS || "100", 10);

const TUNNEL_TARGET = TUNNEL_ID.includes(".") ? TUNNEL_ID : TUNNEL_ID ? `${TUNNEL_ID}.cfargotunnel.com` : "";

function pad3(n) {
  return String(n).padStart(3, "0");
}

function preflight() {
  const errors = [];
  if (!API_TOKEN) errors.push("CLOUDFLARED_API_TOKEN is empty");
  if (!ZONE_ID) errors.push("CLOUDFLARED_ZONE_ID is empty");
  if (!DOMAIN) errors.push("DOMAIN is empty");
  if (!TUNNEL_ID) errors.push("CLOUDFLARED_TUNNEL_ID is empty (UUID hoặc <id>.cfargotunnel.com)");
  if (errors.length) {
    console.error("❌ Pre-flight failed:");
    for (const e of errors) console.error("   -", e);
    console.error(`\nĐọc env từ: ${ENV_FILE}`);
    console.error("Xem .env.example phần ── CLOUDFLARED ── để biết các biến cần.");
    process.exit(2);
  }
}

// ── HTTPS request helper ──────────────────────────────────────────
function cfRequest(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const opts = {
      method,
      hostname: "api.cloudflare.com",
      port: 443,
      path: urlPath,
      headers: {
        Authorization: `Bearer ${API_TOKEN}`,
        "Content-Type": "application/json",
        "User-Agent": "dockerstackagentscode-cname-bulk/1.0",
      },
    };
    const data = body == null ? null : JSON.stringify(body);
    if (data) opts.headers["Content-Length"] = Buffer.byteLength(data);

    const req = https.request(opts, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try {
          json = text ? JSON.parse(text) : null;
        } catch {
          /* keep null */
        }
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

// ── DNS API ───────────────────────────────────────────────────────
async function listRecords(name) {
  // List all CNAME records under this zone, optionally filtered by name.
  const q = new URLSearchParams({ type: "CNAME", per_page: "100" });
  if (name) q.set("name", name);
  const res = await cfRequest("GET", `/client/v4/zones/${ZONE_ID}/dns_records?${q.toString()}`);
  if (!res.json || res.json.success !== true) {
    throw new Error(`listRecords ${name || "*"} failed: ${res.status} ${res.text || ""}`);
  }
  return res.json.result || [];
}

async function createRecord(host, content) {
  const res = await cfRequest("POST", `/client/v4/zones/${ZONE_ID}/dns_records`, {
    type: "CNAME",
    name: host,
    content,
    ttl: 1, // 1 = automatic when proxied
    proxied: true,
    comment: "managed by cloudflare-cname-bulk.js",
  });
  if (res.status === 200 || res.status === 201) return { ok: true, id: res.json.result.id };
  // 409 = already exists with different content; we surface that.
  return {
    ok: false,
    status: res.status,
    error: res.json && res.json.errors,
    raw: res.text,
  };
}

async function deleteRecord(id) {
  const res = await cfRequest("DELETE", `/client/v4/zones/${ZONE_ID}/dns_records/${id}`);
  return res.status === 200 ? { ok: true } : { ok: false, status: res.status, raw: res.text };
}

// ── Commands ──────────────────────────────────────────────────────

async function cmdVerify() {
  preflight();
  const res = await cfRequest("GET", `/client/v4/zones/${ZONE_ID}`);
  if (!res.json || !res.json.success) {
    console.error("❌ Token / Zone verify failed:", res.status, res.text);
    process.exit(2);
  }
  console.log("✅ API token + zone OK");
  console.log(`   Zone     : ${res.json.result.name}`);
  console.log(`   Plan     : ${res.json.result.plan && res.json.result.plan.name}`);
  console.log(`   Domain   : ${DOMAIN}`);
  console.log(`   Tunnel   : ${TUNNEL_TARGET}`);
}

async function cmdList() {
  preflight();
  const slotPattern = /^ttyd\d{3}\./;
  const all = await listRecords();
  const ttyd = all.filter((r) => slotPattern.test(r.name) || r.name === `*.${DOMAIN}`);
  console.log(`Total CNAME under ${DOMAIN}: ${all.length}`);
  console.log(`TTYD-related (incl. wildcard): ${ttyd.length}`);
  for (const r of ttyd) {
    console.log(`  ${r.name.padEnd(40)} -> ${r.content}  ${r.proxied ? "(proxied)" : ""}`);
  }
}

async function cmdCreateOne(host) {
  preflight();
  const fqdn = host.includes(".") ? host : `${host}.${DOMAIN}`;
  const existing = await listRecords(fqdn);
  if (existing.length) {
    console.log(`✓ ${fqdn} already exists → ${existing[0].content}`);
    return { ok: true, already: true };
  }
  const r = await createRecord(fqdn, TUNNEL_TARGET);
  if (r.ok) console.log(`✅ created ${fqdn} -> ${TUNNEL_TARGET}`);
  else console.log(`❌ failed ${fqdn}: ${JSON.stringify(r.error || r.raw)}`);
  return r;
}

async function cmdDeleteOne(host) {
  preflight();
  const fqdn = host.includes(".") ? host : `${host}.${DOMAIN}`;
  const existing = await listRecords(fqdn);
  if (!existing.length) {
    console.log(`✓ ${fqdn} not present (nothing to delete)`);
    return { ok: true };
  }
  for (const rec of existing) {
    const r = await deleteRecord(rec.id);
    if (r.ok) console.log(`✅ deleted ${fqdn} (${rec.id})`);
    else console.log(`❌ delete failed ${fqdn}: ${JSON.stringify(r)}`);
  }
}

async function cmdCreateWildcard() {
  return cmdCreateOne(`*.${DOMAIN}`);
}
async function cmdDeleteWildcard() {
  return cmdDeleteOne(`*.${DOMAIN}`);
}

async function cmdCreateAll() {
  preflight();
  console.log(`Creating ${TOTAL_SLOTS} CNAME records → ${TUNNEL_TARGET}`);
  let ok = 0;
  let already = 0;
  let failed = 0;
  for (let i = 1; i <= TOTAL_SLOTS; i += 1) {
    const host = `ttyd${pad3(i)}.${DOMAIN}`;
    const existing = await listRecords(host);
    if (existing.length) {
      already += 1;
      process.stdout.write("·");
      continue;
    }
    const r = await createRecord(host, TUNNEL_TARGET);
    if (r.ok) {
      ok += 1;
      process.stdout.write("+");
    } else {
      failed += 1;
      process.stdout.write("!");
      console.error(`\n  ${host}: ${JSON.stringify(r.error || r.raw)}`);
    }
    // Cloudflare API rate limit ~1200/5min; throttle nhẹ ~50ms.
    await new Promise((r2) => setTimeout(r2, 50));
  }
  console.log(`\nDone — created: ${ok}, already: ${already}, failed: ${failed}`);
  process.exit(failed === 0 ? 0 : 1);
}

async function cmdDeleteAll() {
  preflight();
  console.log(`Deleting ttyd001..ttyd${pad3(TOTAL_SLOTS)} CNAME records`);
  let ok = 0;
  let missing = 0;
  let failed = 0;
  for (let i = 1; i <= TOTAL_SLOTS; i += 1) {
    const host = `ttyd${pad3(i)}.${DOMAIN}`;
    const existing = await listRecords(host);
    if (!existing.length) {
      missing += 1;
      process.stdout.write("·");
      continue;
    }
    for (const rec of existing) {
      const r = await deleteRecord(rec.id);
      if (r.ok) {
        ok += 1;
        process.stdout.write("-");
      } else {
        failed += 1;
        process.stdout.write("!");
        console.error(`\n  ${host}: ${JSON.stringify(r)}`);
      }
    }
    await new Promise((r2) => setTimeout(r2, 50));
  }
  console.log(`\nDone — deleted: ${ok}, missing: ${missing}, failed: ${failed}`);
  process.exit(failed === 0 ? 0 : 1);
}

// ── Entry ─────────────────────────────────────────────────────────
const cmd = process.argv[2];
const arg = process.argv[3];

const commands = {
  verify: cmdVerify,
  list: cmdList,
  create: () => cmdCreateOne(arg || ""),
  delete: () => cmdDeleteOne(arg || ""),
  "create-wildcard": cmdCreateWildcard,
  "delete-wildcard": cmdDeleteWildcard,
  "create-all": cmdCreateAll,
  "delete-all": cmdDeleteAll,
};

(async () => {
  if (!cmd || !commands[cmd]) {
    console.log("Usage: node scripts/cloudflare-cname-bulk.js <command> [args]");
    console.log("");
    console.log("Commands:");
    console.log("  verify              Verify API token + zone access");
    console.log("  list                List all ttyd*+wildcard CNAME records");
    console.log("  create-wildcard     Create *.${DOMAIN} CNAME (recommended)");
    console.log("  delete-wildcard     Delete *.${DOMAIN} CNAME");
    console.log("  create-all          Create ttyd001..ttydN explicitly");
    console.log("  delete-all          Delete ttyd001..ttydN");
    console.log("  create <host>       Create a single host (e.g. ttyd047)");
    console.log("  delete <host>       Delete a single host");
    process.exit(cmd ? 1 : 0);
  }
  if ((cmd === "create" || cmd === "delete") && !arg) {
    console.error(`Command '${cmd}' requires <host> argument (ex: ttyd047)`);
    process.exit(1);
  }
  try {
    await commands[cmd]();
  } catch (err) {
    console.error("FATAL:", err.message || err);
    process.exit(2);
  }
})();
