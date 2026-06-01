// src/firebase.js — Firebase Realtime Database client (admin SDK)
// Chỉ giữ duy nhất bootstrap config trong .env:
//   REPO_AGENT_FIREBASE_DATABASE_URL
//   REPO_AGENT_FIREBASE_SERVICE_ACCOUNT_BASE64
//
// Mọi dữ liệu động (gitCredentials, agentCredentials, repoCache,
// agentProfiles, ttydSlots, sessions, auditLogs) đều lưu trên RTDB.

"use strict";

const admin = require("firebase-admin");

let _db = null;
let _initError = null;

function init() {
  if (_db) return _db;
  if (_initError) throw _initError;

  const url = process.env.REPO_AGENT_FIREBASE_DATABASE_URL || "";
  const saB64 = process.env.REPO_AGENT_FIREBASE_SERVICE_ACCOUNT_BASE64 || "";

  if (!url) {
    _initError = new Error(
      "REPO_AGENT_FIREBASE_DATABASE_URL is required. Set it in .env."
    );
    throw _initError;
  }
  if (!saB64) {
    _initError = new Error(
      "REPO_AGENT_FIREBASE_SERVICE_ACCOUNT_BASE64 is required. " +
        "Encode service account JSON to base64 and set it in .env."
    );
    throw _initError;
  }

  let serviceAccount;
  try {
    const json = Buffer.from(saB64, "base64").toString("utf8");
    serviceAccount = JSON.parse(json);
  } catch (err) {
    _initError = new Error(
      `Failed to decode REPO_AGENT_FIREBASE_SERVICE_ACCOUNT_BASE64: ${err.message}`
    );
    throw _initError;
  }

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: url,
  });

  _db = admin.database();
  return _db;
}

function db() {
  return init();
}

// Convenience helpers ------------------------------------------------

async function readPath(p) {
  const snap = await db().ref(p).once("value");
  return snap.val();
}

async function writePath(p, value) {
  await db().ref(p).set(value);
}

async function updatePath(p, partial) {
  await db().ref(p).update(partial);
}

async function pushPath(p, value) {
  const ref = await db().ref(p).push(value);
  return ref.key;
}

async function deletePath(p) {
  await db().ref(p).remove();
}

module.exports = {
  init,
  db,
  readPath,
  writePath,
  updatePath,
  pushPath,
  deletePath,
};
