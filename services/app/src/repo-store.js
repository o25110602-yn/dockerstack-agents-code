// src/repo-store.js — clone/pull repo using Git Credentials
//
// Local clone path:
//   /repos/<provider>/<safeFullName>
// được mount từ host qua volume DOCKER_VOLUMES_ROOT/repo-agent/repos.

"use strict";

const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { fromBase64 } = require("./util");
const gitProviders = require("./git-providers");

const REPOS_ROOT = process.env.REPO_AGENT_REPOS_ROOT || "/repos";

function safeName(s) {
  return String(s || "").replace(/[^A-Za-z0-9._-]+/g, "_");
}

function localPathFor(repo) {
  const provider = safeName(repo.provider || "git");
  const parts = String(repo.fullName || "")
    .split("/")
    .map(safeName)
    .filter(Boolean);
  return path.join(REPOS_ROOT, provider, ...parts);
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { env: process.env, maxBuffer: 32 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        return reject(err);
      }
      resolve({ stdout, stderr });
    });
  });
}

async function cloneOrPull({ repo, gitCredential }) {
  if (!repo) throw new Error("repo is required");
  if (!gitCredential) throw new Error("gitCredential is required");

  const target = localPathFor(repo);
  const parent = path.dirname(target);
  fs.mkdirSync(parent, { recursive: true });

  const token = fromBase64(gitCredential.tokenBase64 || "");
  if (!token) {
    throw new Error("Git credential token is empty");
  }
  const authedUrl = gitProviders.buildAuthenticatedCloneUrl(repo.provider, repo.cloneUrl, token, gitCredential.username || "");

  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "/bin/true",
  };

  const exists = fs.existsSync(path.join(target, ".git"));
  if (exists) {
    // pull (fetch + reset to origin/default branch)
    await run("git", ["-C", target, "remote", "set-url", "origin", authedUrl], { env });
    await run("git", ["-C", target, "fetch", "--all", "--prune"], { env });
    const branch = repo.defaultBranch || "main";
    try {
      await run("git", ["-C", target, "checkout", branch], { env });
    } catch {
      /* branch may not exist locally yet */
    }
    try {
      await run("git", ["-C", target, "reset", "--hard", `origin/${branch}`], { env });
    } catch (err) {
      // fallback to plain pull
      await run("git", ["-C", target, "pull", "--ff-only"], { env });
    }
  } else {
    const branch = repo.defaultBranch || "main";
    await run("git", ["clone", "--depth", "1", "--branch", branch, authedUrl, target], { env }).catch(async (err) => {
      // fallback if branch doesn't exist
      if (String(err.stderr || "").includes("Remote branch") || String(err.stderr || "").includes("not found")) {
        await run("git", ["clone", "--depth", "1", authedUrl, target], {
          env,
        });
      } else {
        throw err;
      }
    });
  }

  // Modified by agent: Do NOT strip token from origin URL on disk so that
  // the slot/agent can perform git push directly using the remote origin URL.
  /*
  try {
    await run(
      "git",
      ["-C", target, "remote", "set-url", "origin", repo.cloneUrl || ""],
      { env }
    );
  } catch {
    // non-fatal
  }
  */

  return { localPath: target };
}

module.exports = {
  REPOS_ROOT,
  localPathFor,
  cloneOrPull,
};
