// public/launcher.js — Alpine.js component for the Launcher page.

function launcher() {
  return {
    repos: [],
    agents: [],
    agentCredentials: [],
    sessions: [],
    repoSearch: "",
    selectedRepoId: "",
    selectedAgentId: "",
    selectedCredIds: [],
    launching: false,
    lastError: "",
    lastResult: null,
    pollHandle: null,

    // Layout, Theme, and Deploy variables
    pageTitle: "Repo Agent Launcher",
    darkMode: false,
    sidebarOpen: false,
    deployModalOpen: false,
    deploySearchQuery: "",
    deployEnvs: {},

    async init() {
      // Check theme on init
      this.darkMode = document.documentElement.classList.contains("dark");

      await Promise.all([
        this.loadRepos(),
        this.loadAgents(),
        this.loadAgentCredentials(),
        this.loadSessions(),
        this.loadDeployInfo(),
      ]);
      // Poll sessions every 5s.
      this.pollHandle = setInterval(() => this.loadSessions(), 5000);

      // Watch selectedAgentId to dynamically update selectedCredIds
      this.$watch("selectedAgentId", (val) => {
        this.selectedCredIds = this.agentCredentials
          .filter((c) => c.agentProfileId === val && c.enabled !== false)
          .map((c) => c.id);
      });
    },
    get selectedRepo() {
      return this.repos.find((r) => r.id === this.selectedRepoId) || null;
    },
    selectedAgentCredentials() {
      if (!this.selectedAgentId) return [];
      return this.agentCredentials.filter(
        (c) => c.agentProfileId === this.selectedAgentId && c.enabled !== false
      );
    },
    canLaunch() {
      return !!this.selectedRepoId && !!this.selectedAgentId;
    },
    filteredRepos() {
      const q = this.repoSearch.trim().toLowerCase();
      const enabled = this.repos.filter((r) => r.enabled !== false);
      if (!q) return enabled;
      return enabled.filter(
        (r) =>
          (r.fullName || "").toLowerCase().includes(q) ||
          (r.description || "").toLowerCase().includes(q)
      );
    },
    agentCredCount(agentId) {
      return this.agentCredentials.filter(
        (c) => c.agentProfileId === agentId && c.enabled !== false
      ).length;
    },
    async loadRepos() {
      try {
        const r = await fetch("/api/repos").then((r) => r.json());
        this.repos = r.items || [];
      } catch (err) {
        this.lastError = `Load repos failed: ${err.message}`;
      }
    },
    async loadAgents() {
      try {
        const r = await fetch("/api/agent-profiles").then((r) => r.json());
        this.agents = (r.items || []).filter((a) => a.enabled !== false);
      } catch (err) {
        this.lastError = `Load agents failed: ${err.message}`;
      }
    },
    async loadAgentCredentials() {
      try {
        const r = await fetch("/api/agent-credentials").then((r) => r.json());
        this.agentCredentials = r.items || [];
      } catch (err) {
        // not fatal
      }
    },
    async loadSessions() {
      try {
        const r = await fetch("/api/sessions").then((r) => r.json());
        this.sessions = r.items || [];
      } catch (err) {
        // not fatal
      }
    },
    async doLaunch() {
      if (!this.canLaunch()) return;
      this.launching = true;
      this.lastError = "";
      this.lastResult = null;
      try {
        const res = await fetch("/api/launch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            repoId: this.selectedRepoId,
            agentProfileId: this.selectedAgentId,
            agentCredentialIds: this.selectedCredIds,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        this.lastResult = data;
        await this.loadSessions();
      } catch (err) {
        this.lastError = `Launch failed: ${err.message}`;
      } finally {
        this.launching = false;
      }
    },
    async closeSession(id) {
      this.triggerConfirm(
        "Đóng Session",
        `Bạn có chắc chắn muốn đóng session ${id}?`,
        async () => {
          try {
            const res = await fetch(`/api/sessions/${id}/close`, {
              method: "POST",
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
            await this.loadSessions();
          } catch (err) {
            this.lastError = `Close failed: ${err.message}`;
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

    // Custom confirm dialog handlers
    confirmModalOpen: false,
    confirmModalTitle: "",
    confirmModalMessage: "",
    confirmModalCallback: null,

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
