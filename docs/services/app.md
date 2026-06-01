# App service (`compose.apps.yml`) — Repo Agent Launcher UI

## Vai trò

App chính trong template này là **Repo Agent Launcher UI** — một Node.js
service quản lý:

- **Git Credentials** (riêng cho fetch/clone repo)
- **Agent Credentials** (riêng cho auth coding agent: AGY/Codex/Claude/OpenCode)
- **Repository Cache** + **Agent Profiles**
- **TTYD Slot Pool** (100 slot ở `compose.repo-ttyd.yml`)
- **Sessions / Launch flow**

Toàn bộ dữ liệu động lưu tại **Firebase Realtime Database** (RTDB).
`.env` chỉ giữ bootstrap tối thiểu.

## Cấu hình chính

- Image local tag: `${PROJECT_NAME}-app:local`
- Build context: `./services/app`
- Runtime: Node.js 20 Alpine + `docker-cli` + `git`
- Port expose localhost: `127.0.0.1:${APP_HOST_PORT}:${APP_PORT}` (default `54100`)
- Healthcheck: `wget http://localhost:${APP_PORT}${HEALTH_PATH}` (default `/api/health`)
- Mount Docker socket: `/var/run/docker.sock` → spawn ttyd slot containers
- Mount project root read-only: `.:/workspace:ro` → app gọi `dc.sh`
- Volumes:
  - `${DOCKER_VOLUMES_ROOT}/app/logs:/app/logs`
  - `${DOCKER_VOLUMES_ROOT}/app/data:/app/data`
  - `${DOCKER_VOLUMES_ROOT}/repo-agent/repos:/repos` (clone target)
  - `${DOCKER_VOLUMES_ROOT}/repo-agent/slots:/slots` (per-slot runtime.env + injected files)

## ENV bắt buộc (xem chi tiết trong `.env.example`)

- `APP_PORT=54100`
- `HEALTH_PATH=/api/health`
- `PROJECT_NAME`, `DOMAIN`, `CADDY_EMAIL`, `TINYAUTH_*`
- **Repo Agent Launcher**:
  - `ENABLE_REPO_AGENT=true`
  - `REPO_AGENT_MANAGER_HOST=agent.${DOMAIN}` (chỉ để hiển thị)
  - `REPO_AGENT_MANAGER_PORT=54100` (phải khớp `APP_PORT`)
  - `REPO_AGENT_FIREBASE_DATABASE_URL=https://<id>-default-rtdb.<region>.firebasedatabase.app`
  - `REPO_AGENT_FIREBASE_SERVICE_ACCOUNT_BASE64=<base64 of service-account.json>`

## ENV optional

- `REPO_AGENT_TOTAL_SLOTS=100` — không nên đổi runtime; nếu đổi cần regenerate
  `compose.repo-ttyd.yml` bằng `node services/app/scripts/gen-ttyd-compose.js`.
- `REPO_AGENT_TTYD_IMAGE=tsl0922/ttyd:1.7.7`
- `DOCKER_GID=999` — GID của group `docker` trên host (build-arg để app user
  có quyền đọc `/var/run/docker.sock`).
- `APP_HOST_PORT=54100` (default).
- `NODE_ENV=production`.
- `TAILSCALE_TAILNET_DOMAIN` — dùng cho route HTTPS nội bộ qua `caddy_1`.

## URL endpoint

- Public Launcher UI: `https://${PROJECT_NAME}.${DOMAIN}/`
- Public Admin UI: `https://${PROJECT_NAME}.${DOMAIN}/admin`
- Health: `/api/health`, Readiness: `/api/health/ready`
- TTYD slots: `https://ttyd001.${DOMAIN}` … `https://ttyd100.${DOMAIN}`
- Internal HTTPS host: `${PROJECT_NAME_TAILSCALE}.${TAILSCALE_TAILNET_DOMAIN}` với `tls internal`.

Toàn bộ endpoints (kể cả ttyd slot) đều đi qua **Caddy `forward_auth` → Tinyauth**.

## Firebase RTDB schema

```
/repoAgent/config
/repoAgent/gitCredentials/<id>     // {provider, name, tokenBase64, username, orgs, enabled}
/repoAgent/repoCache/<id>           // {gitCredentialId, fullName, cloneUrl, defaultBranch, ...}
/repoAgent/agentProfiles/<id>       // {name, label, command, args, workdir, startMode}
/repoAgent/agentCredentials/<id>    // {agentProfileId, type=file|script|env|capture, ...}
/repoAgent/ttydSlots/<slot>         // {slot, status, sessionId, ...}
/repoAgent/sessions/<id>            // {slot, repoId, agentProfileId, status, url, ...}
```

`gitCredentials` chỉ phục vụ **fetch/clone/pull repo**.
`agentCredentials` chỉ phục vụ **auth/config coding agent**.
Hai loại credential **không được dùng chéo nhau**.

## Launch flow

```
UI → POST /api/launch { repoId, agentProfileId }
  ↓
Backend resolve repoId → repoCache → gitCredentialId  (clone bằng Git Credential)
                       → agentProfileId → agentCredentials  (chép config/auth + script)
  ↓
Backend reserve free slot, ghi runtime.env, materialize injected-files
  ↓
bash docker-compose/scripts/dc.sh --profile repo-ttyd up -d --build --force-recreate ttyd-<slot>
  ↓
Trả URL: https://ttyd<slot>.${DOMAIN}
```

## Close session

```
UI → POST /api/sessions/:id/close
  ↓
docker compose --profile repo-ttyd rm -sf ttyd-<slot>
  ↓
Xóa thư mục slot/<slot>/injected-files
Reset slot/<slot>/runtime.env
  ↓
Slot quay về status "free"
```

## Auth/Litestream layer

- **App KHÔNG dùng SQLite** — tất cả state dynamic nằm trên Firebase RTDB.
  Vì vậy không cần thêm entry vào `services/litestream/litestream.yml` cho app.
- Tinyauth vẫn nằm ở `docker-compose/compose.auth.yml` (giữ invariant) và
  bảo vệ tất cả endpoint của app + tất cả ttyd slot.
- App giữ đủ 4 label `forward_auth` theo invariant 27.

## Bảo mật

- Token Git Credential lưu base64 trong RTDB (không hash) — bảo vệ bằng
  Firebase RTDB rules (chỉ service account có quyền read/write).
- API trả về client luôn ẩn token (chỉ hiện preview kiểu `abcd…wxyz`).
- Khi clone, URL HTTPS tạm injection token rồi bị reset ngay sau clone để
  `git remote -v` không leak.
- Khi close session, toàn bộ injected-files bị xóa.
- TTYD slots nằm sau Caddy + Tinyauth, không expose host port.
