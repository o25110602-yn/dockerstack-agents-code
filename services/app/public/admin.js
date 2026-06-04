// public/admin.js — Alpine.js component for /admin.

function admin() {
  return {
    tab: "git",
    msg: "",
    msgKind: "info",
    adding: false,

    gitCreds: [],
    repos: [],
    agents: [],
    agentCreds: [],
    slots: [],

    repoSearch: "",

    newGit: {
      provider: "github",
      name: "",
      token: "",
      customRepos: "",
    },
    newAgent: {
      name: "",
      label: "",
      command: "",
      args: "",
      workdir: "/workspace",
      startMode: "shell",
    },
    newCred: {
      agentProfileId: "",
      name: "",
      type: "file",
      targetPath: "",
      mode: "0600",
      content: "",
      script: "",
      envText: "",
    },

    // UI state
    pageTitle: "Admin Settings",
    darkMode: false,
    sidebarOpen: false,
    deployModalOpen: false,
    deploySearchQuery: "",
    deployEnvs: {},

    // Custom confirm dialog state
    confirmModalOpen: false,
    confirmModalTitle: "",
    confirmModalMessage: "",
    confirmModalCallback: null,

    async init() {
      // Check theme on init
      this.darkMode = document.documentElement.classList.contains("dark");

      await Promise.all([
        this.loadGit(),
        this.loadRepos(),
        this.loadAgents(),
        this.loadCreds(),
        this.loadSlots(),
        this.loadDeployInfo(),
      ]);
      // Auto-refresh slots every 4s when on slots tab.
      setInterval(() => {
        if (this.tab === "slots") this.loadSlots();
      }, 4000);
    },

    tabLabel(t) {
      return {
        git: "🔑 Git Credentials",
        repos: "📦 Repository Cache",
        agents: "🤖 Agent Profiles",
        "agent-creds": "🛡 Agent Credentials",
        slots: "🟢 Slots",
      }[t];
    },

    flash(text, kind = "info") {
      this.msg = text;
      this.msgKind = kind;
      setTimeout(() => {
        if (this.msg === text) this.msg = "";
      }, 5000);
    },

    async req(url, opts = {}) {
      const res = await fetch(url, {
        headers: { "Content-Type": "application/json" },
        ...opts,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      return data;
    },

    // ── Git Credentials ─────────────────────────────────────────
    async loadGit() {
      try {
        const d = await this.req("/api/git-credentials");
        this.gitCreds = d.items || [];
      } catch (err) {
        this.flash(`Load git: ${err.message}`, "error");
      }
    },
    async addGit() {
      this.adding = true;
      try {
        const body = {
          provider: this.newGit.provider,
          name: this.newGit.name || undefined,
          token: this.newGit.token,
        };
        if (this.newGit.provider === "custom") {
          const repos = this.newGit.customRepos
            .split("\n")
            .map((l) => l.trim())
            .filter(Boolean)
            .map((line) => {
              const [fullName, cloneUrl, defaultBranch] = line.split("|").map((s) => s && s.trim());
              return { fullName, cloneUrl, defaultBranch };
            });
          body.extra = { username: "custom", repos };
        }
        const r = await this.req("/api/git-credentials", {
          method: "POST",
          body: JSON.stringify(body),
        });
        this.flash(
          `✓ Added ${r.item.provider} (user: ${r.account?.username || "?"}). Repos đang được fetch trong nền.`,
          "info"
        );
        this.newGit = { provider: "github", name: "", token: "", customRepos: "" };
        await this.loadGit();
        setTimeout(() => this.loadRepos(), 1500);
      } catch (err) {
        this.flash(`Add failed: ${err.message}`, "error");
      } finally {
        this.adding = false;
      }
    },
    async testGit(id) {
      try {
        const r = await this.req(`/api/git-credentials/${id}/test`, {
          method: "POST",
        });
        this.flash(`✓ Test OK — user: ${r.account.username}`, "info");
        await this.loadGit();
      } catch (err) {
        this.flash(`Test failed: ${err.message}`, "error");
      }
    },
    async researchGit(id) {
      try {
        const r = await this.req(
          `/api/git-credentials/${id}/refresh-repos`,
          { method: "POST" }
        );
        this.flash(`✓ Re-fetched ${r.count} repos`, "info");
        await this.loadRepos();
      } catch (err) {
        this.flash(`Research failed: ${err.message}`, "error");
      }
    },
    async toggleGit(id, enabled) {
      try {
        await this.req(`/api/git-credentials/${id}`, {
          method: "PATCH",
          body: JSON.stringify({ enabled }),
        });
        await this.loadGit();
      } catch (err) {
        this.flash(`Toggle failed: ${err.message}`, "error");
      }
    },
    async deleteGit(id) {
      this.triggerConfirm(
        "Xóa Git Credential",
        "Bạn có chắc chắn muốn xóa Git Credential này và tất cả repo cache liên quan?",
        async () => {
          try {
            await this.req(`/api/git-credentials/${id}`, { method: "DELETE" });
            await Promise.all([this.loadGit(), this.loadRepos()]);
            this.flash("✓ Deleted", "info");
          } catch (err) {
            this.flash(`Delete failed: ${err.message}`, "error");
          }
        }
      );
    },

    // ── Repos ───────────────────────────────────────────────────
    async loadRepos() {
      try {
        const d = await this.req("/api/repos");
        this.repos = d.items || [];
      } catch (err) {
        this.flash(`Load repos: ${err.message}`, "error");
      }
    },
    filteredRepos() {
      const q = this.repoSearch.trim().toLowerCase();
      if (!q) return this.repos;
      return this.repos.filter(
        (r) =>
          (r.fullName || "").toLowerCase().includes(q) ||
          (r.description || "").toLowerCase().includes(q)
      );
    },
    async toggleFavorite(r) {
      try {
        await this.req(`/api/repos/${r.id}`, {
          method: "PATCH",
          body: JSON.stringify({ favorite: !r.favorite }),
        });
        await this.loadRepos();
      } catch (err) {
        this.flash(`Toggle failed: ${err.message}`, "error");
      }
    },
    async toggleRepoEnabled(r, enabled) {
      try {
        await this.req(`/api/repos/${r.id}`, {
          method: "PATCH",
          body: JSON.stringify({ enabled }),
        });
        await this.loadRepos();
      } catch (err) {
        this.flash(`Toggle failed: ${err.message}`, "error");
      }
    },

    // ── Agents ──────────────────────────────────────────────────
    async loadAgents() {
      try {
        const d = await this.req("/api/agent-profiles");
        this.agents = d.items || [];
      } catch (err) {
        this.flash(`Load agents: ${err.message}`, "error");
      }
    },
    async addAgent() {
      try {
        await this.req("/api/agent-profiles", {
          method: "POST",
          body: JSON.stringify(this.newAgent),
        });
        this.newAgent = {
          name: "",
          label: "",
          command: "",
          args: "",
          workdir: "/workspace",
          startMode: "shell",
        };
        await this.loadAgents();
        this.flash("✓ Added agent profile", "info");
      } catch (err) {
        this.flash(`Add agent: ${err.message}`, "error");
      }
    },
    async patchAgent(id, patch) {
      try {
        await this.req(`/api/agent-profiles/${id}`, {
          method: "PATCH",
          body: JSON.stringify(patch),
        });
        await this.loadAgents();
      } catch (err) {
        this.flash(`Patch agent: ${err.message}`, "error");
      }
    },
    async deleteAgent(id) {
      this.triggerConfirm(
        "Xóa Agent Profile",
        "Bạn có chắc chắn muốn xóa agent profile này?",
        async () => {
          try {
            await this.req(`/api/agent-profiles/${id}`, { method: "DELETE" });
            await this.loadAgents();
          } catch (err) {
            this.flash(`Delete agent: ${err.message}`, "error");
          }
        }
      );
    },

    // ── Agent Credentials ───────────────────────────────────────
    async loadCreds() {
      try {
        const d = await this.req("/api/agent-credentials");
        this.agentCreds = d.items || [];
      } catch (err) {
        this.flash(`Load creds: ${err.message}`, "error");
      }
    },
    agentLabel(id) {
      const a = this.agents.find((x) => x.id === id);
      return a ? `${a.label} (${a.name})` : id;
    },
    async addCred() {
      try {
        const body = {
          agentProfileId: this.newCred.agentProfileId,
          name: this.newCred.name,
          type: this.newCred.type,
        };
        if (["file", "capture"].includes(this.newCred.type)) {
          body.targetPath = this.newCred.targetPath;
          body.mode = this.newCred.mode || "0600";
          body.content = this.newCred.content;
        } else if (this.newCred.type === "script") {
          body.script = this.newCred.script;
        } else if (this.newCred.type === "env") {
          body.env = {};
          for (const line of (this.newCred.envText || "").split("\n")) {
            const t = line.trim();
            if (!t || !t.includes("=")) continue;
            const idx = t.indexOf("=");
            body.env[t.slice(0, idx).trim()] = t.slice(idx + 1).trim();
          }
        }
        await this.req("/api/agent-credentials", {
          method: "POST",
          body: JSON.stringify(body),
        });
        this.newCred = {
          agentProfileId: "",
          name: "",
          type: "file",
          targetPath: "",
          mode: "0600",
          content: "",
          script: "",
          envText: "",
        };
        await this.loadCreds();
        this.flash("✓ Added agent credential", "info");
      } catch (err) {
        this.flash(`Add cred: ${err.message}`, "error");
      }
    },
    async patchCred(id, patch) {
      try {
        await this.req(`/api/agent-credentials/${id}`, {
          method: "PATCH",
          body: JSON.stringify(patch),
        });
        await this.loadCreds();
      } catch (err) {
        this.flash(`Patch cred: ${err.message}`, "error");
      }
    },
    async deleteCred(id) {
      this.triggerConfirm(
        "Xóa Agent Credential",
        "Bạn có chắc chắn muốn xóa agent credential này?",
        async () => {
          try {
            await this.req(`/api/agent-credentials/${id}`, { method: "DELETE" });
            await this.loadCreds();
          } catch (err) {
            this.flash(`Delete cred: ${err.message}`, "error");
          }
        }
      );
    },

    // ── Slots ───────────────────────────────────────────────────
    async loadSlots() {
      try {
        const d = await this.req("/api/slots");
        this.slots = d.items || [];
      } catch (err) {
        // not fatal
      }
    },
    async resetSlot(slot) {
      this.triggerConfirm(
        "Giải phóng Slot",
        `Bạn có chắc muốn giải phóng (release) slot ${slot}? Việc này sẽ dừng container và hủy session đang chạy.`,
        async () => {
          try {
            await this.req(`/api/admin/slots/${slot}/reset`, { method: "POST" });
            this.flash(`✓ Đã giải phóng slot ${slot}`, "info");
            await this.loadSlots();
          } catch (err) {
            this.flash(`Lỗi giải phóng slot: ${err.message}`, "error");
          }
        }
      );
    },
    async resetAllNonFreeSlots() {
      this.triggerConfirm(
        "Giải phóng TẤT CẢ Slots",
        "Cảnh báo: Bạn có chắc chắn muốn cưỡng bức giải phóng TẤT CẢ các slot đang bận/lỗi không? Hành động này sẽ dừng toàn bộ các sessions đang chạy.",
        async () => {
          try {
            const nonFreeSlots = this.slots.filter(s => s.status !== "free").map(s => s.slot);
            let count = 0;
            for (const slot of nonFreeSlots) {
              await this.req(`/api/admin/slots/${slot}/reset`, { method: "POST" }).catch(() => null);
              count++;
            }
            this.flash(`✓ Đã giải phóng ${count} slots`, "info");
            await this.loadSlots();
          } catch (err) {
            this.flash(`Lỗi giải phóng: ${err.message}`, "error");
          }
        }
      );
    },

    // Theme Toggle
    toggleTheme() {
      this.darkMode = !this.darkMode;
      if (this.darkMode) {
        document.documentElement.classList.add("dark");
        localStorage.setItem("theme", "dark");
      } else {
        document.documentElement.classList.remove("dark");
        localStorage.setItem("theme", "light");
      }
    },

    // Load Deploy Info
    async loadDeployInfo() {
      try {
        const r = await fetch("/api/deploy-info").then((r) => r.json());
        this.deployEnvs = r.envs || {};
      } catch (err) {
        // not fatal
      }
    },

    // Active Deploy Chips
    get activeChips() {
      const list = [];
      if (this.deployEnvs._DOTENVRTDB_RUNNER_ORG) {
        list.push({ label: "ORG", val: this.deployEnvs._DOTENVRTDB_RUNNER_ORG });
      }
      if (this.deployEnvs._DOTENVRTDB_RUNNER_REPO) {
        list.push({ label: "REPO", val: this.deployEnvs._DOTENVRTDB_RUNNER_REPO, truncate: true });
      }
      if (this.deployEnvs._DOTENVRTDB_RUNNER_COMMIT_SHORT_ID) {
        list.push({ label: "COMMIT", val: this.deployEnvs._DOTENVRTDB_RUNNER_COMMIT_SHORT_ID });
      }
      if (this.deployEnvs._DOTENVRTDB_RUNNER_COMMIT_AT) {
        list.push({ label: "DATE", val: this.deployEnvs._DOTENVRTDB_RUNNER_COMMIT_AT });
      }
      if (this.deployEnvs._DOTENVRTDB_RUNNER_HOST_TYPE) {
        list.push({ label: "HOST", val: this.deployEnvs._DOTENVRTDB_RUNNER_HOST_TYPE });
      }
      return list;
    },

    // Link Detection
    detectLink(key, val) {
      if (!val) return null;
      val = String(val);

      // Rule 1 — Explicit URL
      if (val.startsWith("https://") || val.startsWith("http://")) {
        return { href: val, text: val };
      }

      // Rule 2 — Bare hostname or hostname+path
      if (/^[\w][\w\-]*(\.[a-zA-Z]{2,})([\/:][^\s]*)?$/.test(val) && !val.includes("@") && !val.includes(" ")) {
        return { href: "https://" + val, text: val };
      }

      // Rule 3 — GitHub-relative path
      const serverUrl = this.deployEnvs._DOTENVRTDB_RUNNER_SERVER_URL;
      if (serverUrl && /^[\w\-]+\/[\w\-]+\/.+$/.test(val)) {
        const cleanVal = val.split("@")[0];
        const baseUrl = serverUrl.endsWith("/") ? serverUrl.slice(0, -1) : serverUrl;
        return { href: baseUrl + "/" + cleanVal, text: val };
      }

      return null;
    },

    // Filtered Env variables
    filteredEnvs() {
      const q = this.deploySearchQuery.trim().toLowerCase();
      const keys = Object.keys(this.deployEnvs)
        .filter((k) => k.startsWith("_DOTENVRTDB_RUNNER_"))
        .map((k) => {
          const stripped = k.replace(/^_DOTENVRTDB_RUNNER_/, "");
          const val = this.deployEnvs[k] || "—";
          const link = this.detectLink(k, val);
          return { rawKey: k, key: stripped, val, link };
        });

      // Sort alphabetically
      keys.sort((a, b) => a.key.localeCompare(b.key));

      if (!q) return keys;
      return keys.filter(
        (item) =>
          item.key.toLowerCase().includes(q) ||
          String(item.val).toLowerCase().includes(q)
      );
    },

    triggerConfirm(title, message, callback) {
      this.confirmModalTitle = title;
      this.confirmModalMessage = message;
      this.confirmModalCallback = callback;
      this.confirmModalOpen = true;
    },

    async executeConfirm() {
      this.confirmModalOpen = false;
      if (this.confirmModalCallback) {
        await this.confirmModalCallback();
        this.confirmModalCallback = null;
      }
    },
  };
}
