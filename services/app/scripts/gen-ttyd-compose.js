// Generate compose.repo-ttyd.yml with 100 ttyd slots.
//
// Quan trọng (đã sửa theo prompt):
//   1. Repo source mount READ-WRITE (không có :ro), để coding agent
//      có thể edit code.
//   2. Repo root mount vào /repos (đồng bộ path với manager:
//      manager dùng /repos/<provider>/<owner>/<repo>; ttyd cũng vậy).
//   3. restart: "no" — slot chỉ chạy theo lifecycle do manager điều khiển.
//   4. Image mặc định là repo-agent-ttyd (build từ services/repo-agent-ttyd/),
//      có sẵn git/node/npm/jq/rg/fd. Có thể override bằng
//      REPO_AGENT_TTYD_IMAGE.
//
// File output: docker-compose/compose.repo-ttyd.yml (cùng đường dẫn cũ).
"use strict";
const fs = require("fs");
const path = require("path");

const TOTAL_SLOTS = parseInt(
  process.env.REPO_AGENT_TOTAL_SLOTS || "100",
  10
);

const HEADER = [
  "# ================================================================",
  "#  compose.repo-ttyd.yml — TTYD Slot Pool (100 slots)",
  "#  Profile: repo-ttyd",
  "#",
  "#  Mỗi slot là 1 container ttyd độc lập, chỉ START khi user bấm Launch",
  "#  trên Repo Agent Launcher UI (gọi:",
  "#    dc.sh --profile repo-ttyd up -d ttyd-<slot>).",
  "#  Không bao giờ start cả 100 cùng lúc.",
  "#",
  "#  URL fix-pattern:  https://ttyd<XXX>.${DOMAIN}",
  "#  Service / Container: ttyd-<XXX> / repo-agent-ttyd-<XXX>",
  "#",
  "#  Volumes per slot:",
  "#    - repos    : ${DOCKER_VOLUMES_ROOT}/repo-agent/repos     → /repos      (READ-WRITE)",
  "#    - slot dir : ${DOCKER_VOLUMES_ROOT}/repo-agent/slots/<XXX> → /slot     (READ-WRITE)",
  "#",
  "#  runtime.env (do app/repo-agent ghi) được nạp tự động bởi entrypoint:",
  "#    /usr/local/bin/repo-agent-ttyd-entrypoint",
  "#",
  "#  restart: \"no\" — slot không tự restart; manager phụ trách lifecycle.",
  "#",
  "#  Auth: cùng Caddy + Tinyauth forward_auth như app chính.",
  "#",
  "#  ⚠️  File này được sinh tự động bởi:",
  "#       node services/app/scripts/gen-ttyd-compose.js",
  "#       Đừng sửa tay — chỉnh script generator rồi chạy lại.",
  "# ================================================================",
  "",
  "x-ttyd-base: &ttyd-base",
  "  image: ${REPO_AGENT_TTYD_IMAGE:-repo-agent-ttyd:local}",
  "  build:",
  "    context: ../services/repo-agent-ttyd",
  "    dockerfile: Dockerfile",
  "  profiles: [repo-ttyd]",
  "  restart: \"no\"",
  "  networks: [app_net]",
  "  depends_on:",
  "    tinyauth:",
  "      condition: service_healthy",
  "  # entrypoint của image repo-agent-ttyd:",
  "  #   - load /slot/runtime.env",
  "  #   - validate REPO_AGENT_REPO_PATH bắt đầu /repos/ và tồn tại",
  "  #   - apply manifest AgentCredentials → copy vào targetPath đúng mode",
  "  #   - symlink /workspace → $REPO_AGENT_REPO_PATH",
  "  #   - tôn trọng REPO_AGENT_START_MODE (shell|agent)",
  "",
  "services:",
  "",
];

const lines = HEADER.slice();
const pad3 = (n) => String(n).padStart(3, "0");

for (let i = 1; i <= TOTAL_SLOTS; i += 1) {
  const slot = pad3(i);
  lines.push(`  ttyd-${slot}:`);
  lines.push(`    <<: *ttyd-base`);
  lines.push(`    container_name: "repo-agent-ttyd-${slot}"`);
  lines.push(`    hostname: "ttyd-${slot}"`);
  lines.push(`    volumes:`);
  // /repos — READ-WRITE: agent phải sửa được code
  lines.push(
    `      - \${DOCKER_VOLUMES_ROOT:-./.docker-volumes}/repo-agent/repos:/repos`
  );
  // Slot folder — chứa runtime.env + injected-files (read-write, entrypoint chỉ đọc)
  lines.push(
    `      - \${DOCKER_VOLUMES_ROOT:-./.docker-volumes}/repo-agent/slots/${slot}:/slot`
  );
  lines.push(`    labels:`);
  lines.push(`      - "caddy=http://ttyd${slot}.\${DOMAIN}"`);
  lines.push(`      - "caddy.forward_auth=tinyauth:\${TINYAUTH_PORT:-3000}"`);
  lines.push(`      - "caddy.forward_auth.uri=/api/auth/caddy"`);
  lines.push(`      - "caddy.forward_auth.header_up=X-Forwarded-Proto https"`);
  lines.push(
    `      - "caddy.forward_auth.copy_headers=Remote-User Remote-Email Remote-Name Remote-Groups"`
  );
  lines.push(`      - "caddy.reverse_proxy={{upstreams 7681}}"`);
  lines.push(`      - "caddy.reverse_proxy.flush_interval=-1"`);
  lines.push("");
}

const outPath = path.resolve(
  __dirname,
  "../../../docker-compose/compose.repo-ttyd.yml"
);
fs.writeFileSync(outPath, lines.join("\n"));
console.log(`Wrote ${outPath} (${lines.length} lines, ${TOTAL_SLOTS} slots)`);
