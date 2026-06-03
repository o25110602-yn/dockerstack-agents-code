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

    async init() {
      await Promise.all([
        this.loadGit(),
        this.loadRepos(),
        this.loadAgents(),
        this.loadCreds(),
        this.loadSlots(),
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
      if (!confirm("Xóa Git Credential và tất cả repo cache liên quan?")) return;
      try {
        await this.req(`/api/git-credentials/${id}`, { method: "DELETE" });
        await Promise.all([this.loadGit(), this.loadRepos()]);
        this.flash("✓ Deleted", "info");
      } catch (err) {
        this.flash(`Delete failed: ${err.message}`, "error");
      }
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
      if (!confirm("Xóa agent profile?")) return;
      try {
        await this.req(`/api/agent-profiles/${id}`, { method: "DELETE" });
        await this.loadAgents();
      } catch (err) {
        this.flash(`Delete agent: ${err.message}`, "error");
      }
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
      if (!confirm("Xóa agent credential?")) return;
      try {
        await this.req(`/api/agent-credentials/${id}`, { method: "DELETE" });
        await this.loadCreds();
      } catch (err) {
        this.flash(`Delete cred: ${err.message}`, "error");
      }
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
      if (!confirm(`Bạn có chắc muốn giải phóng (release) slot ${slot}? Việc này sẽ dừng container và hủy session đang chạy.`)) return;
      try {
        await this.req(`/api/admin/slots/${slot}/reset`, { method: "POST" });
        this.flash(`✓ Đã giải phóng slot ${slot}`, "info");
        await this.loadSlots();
      } catch (err) {
        this.flash(`Lỗi giải phóng slot: ${err.message}`, "error");
      }
    },
    async resetAllNonFreeSlots() {
      if (!confirm("Cảnh báo: Bạn có chắc chắn muốn cưỡng bức giải phóng TẤT CẢ các slot đang bận/lỗi không? Hành động này sẽ dừng toàn bộ các sessions đang chạy.")) return;
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
  };
}
