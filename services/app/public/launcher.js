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

    async init() {
      await Promise.all([
        this.loadRepos(),
        this.loadAgents(),
        this.loadAgentCredentials(),
        this.loadSessions(),
      ]);
      // Poll sessions every 5s.
      this.pollHandle = setInterval(() => this.loadSessions(), 5000);
    },
    get selectedRepo() {
      return this.repos.find((r) => r.id === this.selectedRepoId) || null;
    },
    get selectedAgentCredentials() {
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
      if (!confirm(`Close session ${id}?`)) return;
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
    },
  };
}
