// src/git-providers.js — Git provider integrations
//
// Mỗi provider triển khai 2 hàm:
//   fetchAccount(token)   -> { username, orgs[] }
//   fetchRepos(token)     -> [ { fullName, cloneUrl, defaultBranch, ... } ]
//
// Token được dùng CHỈ cho việc fetch metadata + clone/pull repo.
// Token KHÔNG dùng cho auth coding agent — đó là phần Agent Credentials.

"use strict";

const fetch = require("node-fetch");

// ── GitHub ─────────────────────────────────────────────────────────

async function githubFetchAccount(token) {
  const headers = {
    "User-Agent": "repo-agent-launcher",
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
  };

  const meRes = await fetch("https://api.github.com/user", { headers });
  if (!meRes.ok) {
    throw new Error(`GitHub /user failed: ${meRes.status} ${meRes.statusText}`);
  }
  const me = await meRes.json();

  const orgsRes = await fetch("https://api.github.com/user/orgs?per_page=100", {
    headers,
  });
  const orgs = orgsRes.ok ? await orgsRes.json() : [];

  return {
    username: me.login,
    accountUrl: me.html_url,
    avatarUrl: me.avatar_url,
    orgs: orgs.map((o) => o.login),
  };
}

async function githubFetchRepos(token) {
  const headers = {
    "User-Agent": "repo-agent-launcher",
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
  };
  const out = [];

  // Iterate pagination on /user/repos (covers personal + collaborator + org).
  for (let page = 1; page <= 20; page += 1) {
    const url = `https://api.github.com/user/repos?per_page=100&page=${page}&affiliation=owner,collaborator,organization_member`;
    const r = await fetch(url, { headers });
    if (!r.ok) {
      throw new Error(`GitHub /user/repos failed: ${r.status} ${r.statusText}`);
    }
    const arr = await r.json();
    if (!Array.isArray(arr) || arr.length === 0) break;
    for (const repo of arr) {
      out.push({
        provider: "github",
        fullName: repo.full_name,
        cloneUrl: repo.clone_url,
        defaultBranch: repo.default_branch || "main",
        private: !!repo.private,
        description: repo.description || "",
      });
    }
    if (arr.length < 100) break;
  }
  return out;
}

// ── GitLab ─────────────────────────────────────────────────────────

async function gitlabFetchAccount(token) {
  const headers = { "PRIVATE-TOKEN": token };
  const meRes = await fetch("https://gitlab.com/api/v4/user", { headers });
  if (!meRes.ok) {
    throw new Error(`GitLab /user failed: ${meRes.status} ${meRes.statusText}`);
  }
  const me = await meRes.json();

  const groupsRes = await fetch(
    "https://gitlab.com/api/v4/groups?per_page=100",
    { headers }
  );
  const groups = groupsRes.ok ? await groupsRes.json() : [];

  return {
    username: me.username,
    accountUrl: me.web_url,
    avatarUrl: me.avatar_url,
    orgs: groups.map((g) => g.path),
  };
}

async function gitlabFetchRepos(token) {
  const headers = { "PRIVATE-TOKEN": token };
  const out = [];
  for (let page = 1; page <= 20; page += 1) {
    const url = `https://gitlab.com/api/v4/projects?membership=true&per_page=100&page=${page}`;
    const r = await fetch(url, { headers });
    if (!r.ok) {
      throw new Error(
        `GitLab /projects failed: ${r.status} ${r.statusText}`
      );
    }
    const arr = await r.json();
    if (!Array.isArray(arr) || arr.length === 0) break;
    for (const repo of arr) {
      out.push({
        provider: "gitlab",
        fullName: repo.path_with_namespace,
        cloneUrl: repo.http_url_to_repo,
        defaultBranch: repo.default_branch || "main",
        private: repo.visibility !== "public",
        description: repo.description || "",
      });
    }
    if (arr.length < 100) break;
  }
  return out;
}

// ── Azure DevOps ───────────────────────────────────────────────────
// Azure DevOps PAT auth = Basic with empty user + token as password.

async function azureFetchAccount(token) {
  const auth =
    "Basic " + Buffer.from(`:${token}`).toString("base64");
  const headers = { Authorization: auth, Accept: "application/json" };

  const profileRes = await fetch(
    "https://app.vssps.visualstudio.com/_apis/profile/profiles/me?api-version=7.1",
    { headers }
  );
  if (!profileRes.ok) {
    throw new Error(
      `Azure /profiles/me failed: ${profileRes.status} ${profileRes.statusText}`
    );
  }
  const profile = await profileRes.json();

  const orgsRes = await fetch(
    `https://app.vssps.visualstudio.com/_apis/accounts?memberId=${profile.id}&api-version=7.1`,
    { headers }
  );
  const orgs = orgsRes.ok ? (await orgsRes.json()).value || [] : [];

  return {
    username: profile.emailAddress || profile.displayName,
    displayName: profile.displayName,
    orgs: orgs.map((o) => o.accountName),
  };
}

async function azureFetchRepos(token) {
  const auth =
    "Basic " + Buffer.from(`:${token}`).toString("base64");
  const headers = { Authorization: auth, Accept: "application/json" };
  const out = [];

  // Need orgs first.
  const account = await azureFetchAccount(token);
  for (const org of account.orgs) {
    const projectsRes = await fetch(
      `https://dev.azure.com/${org}/_apis/projects?api-version=7.1`,
      { headers }
    );
    if (!projectsRes.ok) continue;
    const projects = (await projectsRes.json()).value || [];
    for (const proj of projects) {
      const reposRes = await fetch(
        `https://dev.azure.com/${org}/${encodeURIComponent(
          proj.name
        )}/_apis/git/repositories?api-version=7.1`,
        { headers }
      );
      if (!reposRes.ok) continue;
      const repos = (await reposRes.json()).value || [];
      for (const r of repos) {
        out.push({
          provider: "azure",
          fullName: `${org}/${proj.name}/${r.name}`,
          cloneUrl: r.remoteUrl,
          defaultBranch: (r.defaultBranch || "refs/heads/main").replace(
            "refs/heads/",
            ""
          ),
          private: true,
          description: "",
        });
      }
    }
  }
  return out;
}

// ── Custom Git ─────────────────────────────────────────────────────
// "Custom Git" credential: user dán manual list repo URLs, không có API.
// Account = chỉ là username thông tin, repos = parse từ field tự nhập.

async function customFetchAccount(token, extra = {}) {
  return {
    username: extra.username || "custom",
    orgs: [],
  };
}

async function customFetchRepos(_token, extra = {}) {
  // extra.repos: array of { fullName, cloneUrl, defaultBranch }
  const list = Array.isArray(extra.repos) ? extra.repos : [];
  return list.map((r) => ({
    provider: "custom",
    fullName: r.fullName,
    cloneUrl: r.cloneUrl,
    defaultBranch: r.defaultBranch || "main",
    private: true,
    description: r.description || "",
  }));
}

// ── Dispatcher ─────────────────────────────────────────────────────

async function fetchAccount(provider, token, extra) {
  switch (provider) {
    case "github":
      return githubFetchAccount(token);
    case "gitlab":
      return gitlabFetchAccount(token);
    case "azure":
      return azureFetchAccount(token);
    case "custom":
      return customFetchAccount(token, extra);
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}

async function fetchRepos(provider, token, extra) {
  switch (provider) {
    case "github":
      return githubFetchRepos(token);
    case "gitlab":
      return gitlabFetchRepos(token);
    case "azure":
      return azureFetchRepos(token);
    case "custom":
      return customFetchRepos(token, extra);
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}

// ── Build authenticated clone URL (HTTPS) ──────────────────────────

function buildAuthenticatedCloneUrl(provider, cloneUrl, token, username) {
  // Convert https://host/path to https://<userOrTokenSlot>:<token>@host/path
  if (!cloneUrl) return cloneUrl;
  if (!cloneUrl.startsWith("http")) return cloneUrl; // SSH or other — leave as is
  const u = new URL(cloneUrl);
  switch (provider) {
    case "github":
      // GitHub PAT works with username "x-access-token" or any user + token
      u.username = username || "x-access-token";
      u.password = token;
      break;
    case "gitlab":
      u.username = "oauth2";
      u.password = token;
      break;
    case "azure":
      u.username = ""; // Azure DevOps PAT = empty user
      u.password = token;
      break;
    case "custom":
    default:
      u.username = username || "x-access-token";
      u.password = token;
      break;
  }
  return u.toString();
}

module.exports = {
  fetchAccount,
  fetchRepos,
  buildAuthenticatedCloneUrl,
};
