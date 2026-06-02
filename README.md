# Docker Stack Template

Template triển khai nhanh 1 ứng dụng container (app chính) kèm đầy đủ lớp truy cập và vận hành:

- **Core**: Caddy + Cloudflare Tunnel.
- **Ops**: Dozzle, Filebrowser, WebSSH (có thể truy cập qua domain hoặc Tailscale hostname:port).
- **Access**: Tailscale + Keep-IP workflow.
- **Deploy Code**: sidecar self-deploy/app-control, mặc định tắt và chỉ bật khi `DOCKER_DEPLOY_CODE_ENABLED=true`.

Tài liệu chính đã được chuẩn hoá theo codebase hiện tại:

- Hướng dẫn triển khai tổng quát: `docs/DEPLOY.md`
- Hướng dẫn thay thế app/service mới: `docs/deploy.new.md`
- Tài liệu chi tiết từng dịch vụ (mỗi dịch vụ 1 file): thư mục `docs/services/`
- Tài liệu Deploy Code: `docs/services/deploy-code.md`
- One-file handoff cho coding agent khi thay app: `AGENT_APP_SWAP.md`
- Sync embedded files into agent handoff: `npm run agent-app-swap:sync`

## Cấu trúc compose

- `docker-compose/compose.core.yml`
- `docker-compose/compose.ops.yml`
- `docker-compose/compose.access.yml`
- `docker-compose/compose.deploy.yml`
- `compose.apps.yml`

Script điều phối chính:

- `docker-compose/scripts/dc.sh` (tự bật profile theo `ENABLE_*`)
- `docker-compose/scripts/validate-env.js` (validate env trước deploy)

## Repo Agent Launcher — Dynamic ttyd slots (refactor 2026-06)

App service trong template này là **Repo Agent Launcher** (services/app):
manager UI cho phép user chọn 1 git repo + 1 agent profile (codex/claude/agy/
opencode), sau đó spawn 1 web-terminal container (ttyd) chạy agent đó với
repo đã clone sẵn.

Pre-refactor: 100 ttyd slot là **service compose tĩnh** trong file 1650-dòng
`compose.repo-ttyd.yml`, sinh tự động bởi `gen-ttyd-compose.js`. Script
manager gọi `bash dc.sh up -d ttyd-NNN` để start từng slot — phức tạp,
nhiều lỗi liên hoàn khi chạy in-container qua docker.sock.

Post-refactor: 100 slot được manager **spawn động** bằng `docker run` qua
module `services/app/src/docker-runner.js`. Container join cùng network
với caddy + tinyauth → caddy-docker-proxy auto-discover qua label
`caddy=http://ttyd<NNN>.${DOMAIN}`.

Yêu cầu deploy:

1. **Wildcard DNS** trên Cloudflare: `*.${DOMAIN} CNAME <tunnel-id>.cfargotunnel.com (proxied)`.
   Có thể tạo bằng CLI: `npm run cname:create-wildcard`.
2. **Wildcard ingress** trong `cloudflared/config.yml` (đã setup sẵn):
   `- hostname: "*.${DOMAIN}"  service: http://caddy:80` đặt NGAY TRƯỚC catch-all 404.
3. **Build image** một lần ở step deploy:
   `docker build -t repo-agent-ttyd:local services/repo-agent-ttyd`
4. **Mount docker.sock** vào main-app: đã setup trong `compose.apps.yml`.
   Build-arg `DOCKER_GID` phải khớp `stat -c '%g' /var/run/docker.sock` (default 999).
5. **`HOST_PROJECT_ROOT`** phải là path tuyệt đối host khi main-app chạy
   in-container (vì `docker run` từ manager dùng path này để bind-mount).

Tests chứng minh deploy:

```bash
npm run repo-agent-test:mock-flow      # 74 unit checks (firebase + lifecycle)
npm run repo-agent-test:http           # 64 HTTP route checks
npm run repo-agent-test:docker-runner  # 86 buildRunArgs/spawn/inspect checks
npm run repo-agent-test:deploy-smoke   # 87 deployment-readiness checks
npm run repo-agent-test:all            # chạy 3 cái đầu
```

CLI tools:

- `npm run cname:verify` — kiểm tra Cloudflare API token + zone access
- `npm run cname:list` — list CNAME records hiện có
- `npm run cname:create-wildcard` — tạo `*.${DOMAIN}` CNAME (1 lần)
- `npm run cname:delete-wildcard` — gỡ wildcard

## Lệnh thường dùng

```bash
npm run dockerapp-validate:env
npm run dockerapp-validate:all
npm run dockerapp-exec:up
npm run dockerapp-exec:ps
npm run dockerapp-exec:logs
npm run dockerapp-exec:down
```

## Tiện ích clone template cho dịch vụ mới

Đã thêm script NodeJS:

```bash
node scripts/clone-stack.js --output /path/deployments --name my-new-service
```

Hoặc chạy interactive:

```bash
node scripts/clone-stack.js
```
