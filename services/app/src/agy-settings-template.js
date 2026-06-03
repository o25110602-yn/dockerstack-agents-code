// src/agy-settings-template.js
//
// Nguồn duy nhất cho AGY settings template.
// Dùng trong server.js và launcher.js:
//
//   const { DEFAULT_AGY_SETTINGS_TEMPLATE } = require("./agy-settings-template");
//
// Không cần đổi gì khác trong hai file đó.

"use strict";

// Tạo settings template bằng object JS thuần — dễ comment, dễ chỉnh từng field.
// Cuối cùng stringify thành chuỗi JSON đẹp để ghi ra file disk.
const DEFAULT_AGY_SETTINGS_TEMPLATE = JSON.stringify(
  (() => {
    const s = {};

    s.toolPermission = "always-proceed";

    // ── Giao diện ────────────────────────────────────────────────
    // "terminal" | "dark" | "light" | "solarized dark" | "solarized light"
    // "colorblind-friendly dark" | "colorblind-friendly light" | "tokyo night"
    // "terminal" = dùng màu sẵn có của terminal, không override → skip màn hình chọn
    s.colorScheme = "terminal";

    // "alt-screen" (full-screen TUI) | "inline" (stream vào history terminal)
    s.renderingMode = "alt-screen";

    // ── Quyền thực thi ───────────────────────────────────────────
    // "all"  = toàn bộ tự approve, tương đương --dangerously-skip-permissions
    // Muốn fine-grained thì bỏ dòng này và bật block permissions bên dưới
    s.autoApprove = "all";

    // Fine-grained permissions — bỏ comment để dùng thay cho autoApprove:
    // s.permissions = {
    //   allow: [
    //     "command(git)",
    //     "command(npm)",
    //     "command(node)",
    //     "command(npx)",
    //     "read_file(**)",
    //     "write_file(**)",
    //     "edit_file(**)",
    //   ],
    //   deny: [
    //     "command(rm -rf /)",
    //     "command(sudo rm)",
    //     "command(mkfs)",
    //     "command(dd)",
    //   ],
    // };

    // ── Model ────────────────────────────────────────────────────
    // Model mặc định khi khởi động. Đổi trong session bằng /model
    // Ví dụ: "gemini-3-5-flash" | "gemini-3-pro" | "claude-opus-4-6"
    // Bỏ comment dòng dưới để chọn model cụ thể; để nguyên = dùng default CLI
    // s.model = "gemini-3-5-flash";

    // ── Workspace ────────────────────────────────────────────────
    // true = cho phép truy cập file ngoài workspace hiện tại
    s.allowNonWorkspaceAccess = true;

    // ── Telemetry ────────────────────────────────────────────────
    // false = tắt gửi dữ liệu usage về Google
    s.enableTelemetry = false;

    // ── Sandbox (Terminal Sandbox) ───────────────────────────────
    // Bật sandbox OS-level khi AI thực thi shell commands
    //   Linux → nsjail | macOS → sandbox-exec
    // Nên bật nếu dùng autoApprove: "all"
    // s.sandbox = true;

    // ── LaTeX rendering ──────────────────────────────────────────
    // false = tắt render LaTeX (dùng khi terminal không hỗ trợ)
    // Tương đương env AGY_CLI_DISABLE_LATEX=1
    // s.enableLatex = false;

    // ── Account info header ──────────────────────────────────────
    // true = ẩn email và plan tier khỏi header CLI
    // Tương đương env AGY_CLI_HIDE_ACCOUNT_INFO=1
    // s.hideAccountInfo = false;

    // ── Subagents ────────────────────────────────────────────────
    // Giới hạn số subagent chạy song song (mặc định không giới hạn)
    // s.maxSubagents = 3;

    // ── Custom status line ───────────────────────────────────────
    // Script nhận JSON metadata (CWD, model, token usage...) để tạo status bar
    // s.statusLineScript = "/path/to/your/status-script.sh";

    // ── MCP Servers ──────────────────────────────────────────────
    // Khai báo MCP servers để dùng tools bên ngoài
    // s.mcpServers = {
    //   "my-server": {
    //     command: "node",
    //     args: ["/path/to/mcp-server.js"],
    //     env: {},
    //   },
    // };

    return s;
  })(),
  null,
  2,
);

module.exports = { DEFAULT_AGY_SETTINGS_TEMPLATE };
