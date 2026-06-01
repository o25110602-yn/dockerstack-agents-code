// src/util.js — small helpers shared across modules.
"use strict";

const crypto = require("crypto");

function genId(prefix) {
  const ts = Date.now().toString(36);
  const rnd = crypto.randomBytes(4).toString("hex");
  return `${prefix}_${ts}${rnd}`;
}

function nowIso() {
  return new Date().toISOString();
}

function toBase64(s) {
  return Buffer.from(String(s ?? ""), "utf8").toString("base64");
}

function fromBase64(b) {
  return Buffer.from(String(b ?? ""), "base64").toString("utf8");
}

function maskToken(token) {
  if (!token) return "";
  const t = String(token);
  if (t.length <= 8) return "***";
  return `${t.slice(0, 4)}…${t.slice(-4)}`;
}

function ensureEnabled(obj) {
  // Default `enabled = true` when reading older entries that may not have the flag.
  if (!obj || typeof obj !== "object") return obj;
  if (typeof obj.enabled === "undefined") obj.enabled = true;
  return obj;
}

function safeJson(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return null;
  }
}

function pad3(n) {
  return String(n).padStart(3, "0");
}

module.exports = {
  genId,
  nowIso,
  toBase64,
  fromBase64,
  maskToken,
  ensureEnabled,
  safeJson,
  pad3,
};
