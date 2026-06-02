# DEPLOY.md — Triển khai Repo Agent Launcher (Docker Stack Template)

Hướng dẫn cài đặt **Repo Agent Launcher UI** dựa trên Docker Stack Template. Áp dụng cho mọi môi trường (local dev, VPS production, Tailscale-only).

---

## 1. Tổng quan kiến trúc

| Lớp        | Service               | Mặc định | Vai trò                                                     |
|------------|-----------------------|----------|-------------------------------------------------------------|
| Core       | `caddy`, `cloudflared`| ✅       | Reverse proxy + Cloudflare Tunnel (HTTPS public)            |
| Auth       | `tinyauth`            | ✅       | Forward-auth gate cho mọi service (sessions ở SQLite)       |
| Auth-Backup| `litestream-restore`, `litestream` | ⚙️ optional | Backup/restore SQLite của Tinyauth lên S3-compatible |
| Ops        | `dozzle`, `filebrowser`, `webssh` | ✅ | Logs viewer, file manager, web SSH                          |
| Apps       | `app` (Repo Agent Launcher) | ✅ | UI quản lý Git/Agent credentials + Launch ttyd slot         |
| Apps-pool  | `ttyd-001`..`ttyd-100`| ⚙️ on-demand | TTYD container mỗi slot, chỉ start khi user bấm Launch  |
| Backup     | `rclone-init`/`restore`/`sync` | ⚙️ optional | Sync 2 chiều `${DOCKER_VOLUMES_ROOT}` ↔ remote storage |
| Access     | `tailscale`           | ⚙️ optional | VPN mesh để truy cập private                               |
| Deploy     | `deploy-code`         | ⚙️ optional | Sidecar tự deploy ZIP/Git từ UI                            |

Toàn bộ data động (gitCredentials, agentCredentials, repoCache, agentProfiles, ttydSlots, sessions) lưu ở **Firebase Realtime Database**, KHÔNG nằm trong `.env`.

`.env` chỉ giữ bootstrap config tối thiểu.

---

## 2. Yêu cầu hệ thống

- Docker ≥ 24.x + Docker Compose v2 (plugin)
- Node.js ≥ 18 (chạy validate scripts)
- Bash, base64, curl
- Linux/macOS host (Windows hỗ trợ qua WSL2)
- Domain trỏ về Cloudflare (cho tunnel) HOẶC Tailscale (cho private access)

---

## 3. Lần đầu setup (one-time)

### 3.1. Clone repo

```bash
git clone <repo-url> dockerstack-agents
cd dockerstack-agents
```

### 3.2. Tạo Firebase Realtime Database

1. Truy cập https://console.firebase.google.com → Add project → đặt tên (vd `myorg-agents`).
2. **Build → Realtime Database** → Create database → chọn region gần nhất → Locked mode.
3. **Rules** → cho phép service account read/write:
   ```json
   { "rules": { ".read": "auth != null", ".write": "auth != null" } }
   ```
4. **Project Settings → Service accounts** → Generate new private key → tải file JSON.
5. Encode service account base64 (KHÔNG xuống dòng):
   ```bash
   # Linux/macOS
   base64 -w 0 service-account.json
   # Windows PowerShell
   [Convert]::ToBase64String([IO.File]::ReadAllBytes("service-account.json"))
   ```
6. Copy URL của RTDB (dạng `https://<project>-default-rtdb.<region>.firebasedatabase.app`).

### 3.3. Tạo Cloudflare Tunnel (nếu deploy public)

1. https://dash.cloudflare.com → Zero Trust → Networks → Tunnels → Create a tunnel → Docker.
2. Copy tunnel ID + tải `credentials.json` → đặt vào `cloudflared/credentials.json`.
3. Vào tab "Public Hostname" → thêm:
   - `${DOMAIN}` → `http://caddy:80`
   - `auth.${DOMAIN}`, `main.${DOMAIN}`, `dozzle.${DOMAIN}`, `files.${DOMAIN}`, `ttyd.${DOMAIN}`, `deploy.${DOMAIN}` → tất cả → `http://caddy:80`
   - **`ttyd001.${DOMAIN}` … `ttyd100.${DOMAIN}`** (100 slots, có thể dùng wildcard hostname `*.${DOMAIN}` nếu plan cho phép) → `http://caddy:80`
4. Edit `cloudflared/config.yml` (đã có template tại `cloudflared/config.yml.example`).

### 3.4. Tạo Tinyauth admin user

```bash
docker run -it --rm ghcr.io/steveiliop56/tinyauth:v5 user create --interactive
# Chọn "Format for Docker" → copy chuỗi → paste vào TINYAUTH_USERS trong .env
# Chú ý: $$ trong .env sẽ tự normalize về $ trong container.
```

### 3.5. Tạo `.env`

```bash
cp .env.example .env
# Sau đó mở file và thay các giá trị BẮT BUỘC:
#   PROJECT_NAME, PROJECT_NAME_TAILSCALE, DOMAIN, CADDY_EMAIL
#   TINYAUTH_APP_URL, TINYAUTH_USERS
#   REPO_AGENT_FIREBASE_DATABASE_URL
#   REPO_AGENT_FIREBASE_SERVICE_ACCOUNT_BASE64
#   CLOUDFLARED_TUNNEL_NAME (+ hostnames + credentials.json)
```

Nếu chưa cần backup S3 cho Tinyauth → giữ `ENABLE_LITESTREAM=false` (DB lưu trực tiếp tại `${DOCKER_VOLUMES_ROOT}/tinyauth/`).

---

## 4. Validate trước khi up

```bash
npm run dockerapp-validate:env       # check .env
npm run dockerapp-validate:compose   # check merged compose YAML
npm run dockerapp-validate:all       # chạy cả 2
```

Nếu lỗi `❌ Errors`, đọc thông báo và sửa `.env`. Tool sẽ báo từng dòng.

---

## 5. Up stack

```bash
npm run dockerapp-exec:up
# tương đương: bash docker-compose/scripts/dc.sh up -d --build --remove-orphans
```

`dc.sh` tự động:
- Đọc `ENABLE_*` flags từ `.env`
- Chọn `--profile` tương ứng (dozzle, filebrowser, webssh, litestream, rclone, deploy-code)
- Nạp `compose.auth.litestream-gate.yml` chỉ khi `ENABLE_LITESTREAM=true`
- Nạp `compose.rclone-gate.yml` chỉ khi `ENABLE_RCLONE=true`
- Tạo các thư mục bind-mount tại `${DOCKER_VOLUMES_ROOT}`
- Render `tailscale/serve.json` nếu Tailscale bật

Kiểm tra trạng thái:

```bash
npm run dockerapp-exec:ps
npm run dockerapp-exec:logs:app   # log app chính
npm run dockerapp-exec:logs       # log toàn stack
```

Truy cập:

| URL                                | Vai trò                |
|------------------------------------|------------------------|
| `https://${DOMAIN}/`               | Launcher UI            |
| `https://${DOMAIN}/admin`          | Admin UI (Git/Agent creds) |
| `https://auth.${DOMAIN}/`          | Tinyauth login         |
| `https://dozzle.${DOMAIN}/`        | Logs viewer            |
| `https://files.${DOMAIN}/`         | Filebrowser            |
| `https://ttyd001.${DOMAIN}/`       | Slot ttyd 001 (sau khi launch) |

---

## 6. Quy trình sử dụng (sau khi up)

### 6.1. Setup Git Credentials

1. Vào `https://${DOMAIN}/admin` → tab **Git Credentials**
2. Add Credential: chọn provider (GitHub / GitLab / Azure DevOps / Custom Git)
3. Paste Personal Access Token → Test → Save
4. Hệ thống tự fetch danh sách repo và lưu vào Firebase `/repoAgent/repoCache`

### 6.2. Setup Agent Profiles + Credentials

1. Tab **Agent Profiles** — đã có sẵn 5 mặc định (AGY, Codex, Claude, OpenCode, Custom)
2. Tab **Agent Credentials** — gắn auth/config cho mỗi agent:
   - `type=file`: chép config file vào container (ví dụ `~/.codex/config.toml`)
   - `type=script`: chạy bootstrap script trước khi agent khởi động
   - `type=env`: inject env vars cho agent
   - `type=capture`: login thủ công → capture file auth (sau này tự áp dụng)

### 6.3. Launch (Launcher UI)

1. Vào `https://${DOMAIN}/` (hoặc trang root)
2. Chọn repo (từ `/repoAgent/repoCache`)
3. Chọn agent (từ `/repoAgent/agentProfiles`)
4. Bấm **Launch**
5. Hệ thống:
   - Reserve slot free trong `/repoAgent/ttydSlots`
   - Clone/pull repo bằng Git Credential gắn với repo
   - Materialize Agent Credentials vào `${DOCKER_VOLUMES_ROOT}/repo-agent/slots/<slot>/`
   - Ghi `runtime.env`
   - Start container `repo-agent-ttyd-<slot>` qua `dc.sh --profile repo-ttyd up -d ttyd-<slot>`
6. Trả URL terminal: `https://ttyd<slot>.${DOMAIN}`

### 6.4. Close session

- Trên Launcher UI, bấm **Close** trên session
- Backend stop container, xóa `injected-files`, reset `runtime.env`, set slot = `free`

---

## 7. ENABLE_LITESTREAM — Quyết định khi nào bật

| Trường hợp                              | Khuyến nghị         | Lý do                                          |
|-----------------------------------------|---------------------|------------------------------------------------|
| Local dev, single-host, ít dùng         | `ENABLE_LITESTREAM=false` | Không cần S3, đỡ phụ thuộc network          |
| Có Rclone sync `.docker-volumes` lên remote | `false`         | Rclone đã backup toàn bộ volume → đủ cho DR  |
| Production multi-host hoặc cần PITR     | `true` + S3         | Litestream replicate WAL liên tục, RPO ≈ 5s |
| Re-deploy thường xuyên (immutable infra)| `true` + S3         | Restore tự động khi container mới start      |

Khi `false`, data Tinyauth nằm tại `${DOCKER_VOLUMES_ROOT}/tinyauth/${TINYAUTH_DB_FILE}`. Mất volume = mất data → backup `.docker-volumes/tinyauth/` thủ công nếu không bật Rclone.

---

## 8. Lệnh thường dùng

```bash
# Validate
npm run dockerapp-validate:env
npm run dockerapp-validate:compose
npm run dockerapp-validate:all

# Lifecycle
npm run dockerapp-exec:up                # up -d --build --remove-orphans
npm run dockerapp-exec:up:fresh          # down -v && up (XÓA volumes)
npm run dockerapp-exec:restart           # restart all
npm run dockerapp-exec:restart:app       # restart only app
npm run dockerapp-exec:down              # stop all
npm run dockerapp-exec:down:volumes      # stop + xóa volumes (NGUY HIỂM)

# Inspect
npm run dockerapp-exec:ps
npm run dockerapp-exec:config            # in merged compose YAML
npm run dockerapp-exec:health            # ps + logs tail

# Logs
npm run dockerapp-exec:logs              # all
npm run dockerapp-exec:logs:app          # only app
npm run dockerapp-exec:logs:caddy
npm run dockerapp-exec:logs:cloudflared

# Exec shell
npm run dockerapp-exec:exec:app          # sh inside main-app
```

---

## 9. Test mock (không cần Docker)

Repo có sẵn test suite mock toàn bộ flow (Git fetch, Agent creds, Launch, Slot lifecycle, Close session, Compose YAML invariants):

```bash
node tests/repo-agent/mock-flow.test.js
```

Expected: `Total: 62  PASS: 62  FAIL: 0` (xem chi tiết tại `tests/repo-agent/STATUS-REPORT.md`).

---

## 10. Troubleshooting

| Triệu chứng                                                | Nguyên nhân                                              | Cách xử lý                                       |
|------------------------------------------------------------|----------------------------------------------------------|-----------------------------------------------|
| `service "litestream-restore" depends on undefined service` | `ENABLE_LITESTREAM=false` nhưng compose vẫn require | ✅ Đã fix: gate file `compose.auth.litestream-gate.yml` chỉ load khi `=true` |
| App không start, log: `REPO_AGENT_FIREBASE_DATABASE_URL is required` | Chưa điền Firebase config trong `.env`         | Điền 2 biến `REPO_AGENT_FIREBASE_*`              |
| Tinyauth restart liên tục                                  | Caddy chưa health, Tinyauth chưa proxy được             | Check `npm run dockerapp-exec:logs:caddy`        |
| TTYD slot không truy cập được qua URL                      | Cloudflared chưa thêm hostname `ttyd<slot>.${DOMAIN}`    | Thêm public hostname trong CF dashboard         |
| Launch trả lỗi `No free TTYD slot available`               | 100 slot đều busy hoặc Firebase chưa init pool          | Check Firebase `/repoAgent/ttydSlots`            |
| Launch lỗi `Permission denied: /var/run/docker.sock`       | `DOCKER_GID` không khớp host                             | `stat -c '%g' /var/run/docker.sock` → set lại trong `.env` rồi rebuild |

---

## 11. Tài liệu liên quan

- [docs/services/](services/) — chi tiết từng service
- [docs/services/litestream.md](services/litestream.md) — backup config
- [docs/services/deploy-code.md](services/deploy-code.md) — sidecar deploy
- [docs/services/app.md](services/app.md) — Repo Agent Launcher chi tiết
- [docs/deploy.new.md](deploy.new.md) — hướng dẫn thay app mới vào template
- [promt-dockerstack-agents.md](../promt-dockerstack-agents.md) — đặc tả gốc
- [tests/repo-agent/STATUS-REPORT.md](../tests/repo-agent/STATUS-REPORT.md) — test report
