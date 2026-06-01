# Repo Agent Launcher UI — Dockerfile
# Node.js 20 Alpine + Docker CLI + git
# Cần Docker CLI để spawn/stop các ttyd slot container.
# Cần git để clone/pull repo từ Git providers.

FROM node:20-alpine

# ── Install Docker CLI + git + bash + curl ────────────────────────
# - docker-cli: gọi `docker compose ... up ttyd-001` cho từng slot
# - git: clone/pull repo bằng Git Credential
# - bash: run scripts/dc.sh
# - curl: healthcheck + outbound calls
# - openssh-client: cho git over SSH (nếu user dùng SSH URL)
RUN apk add --no-cache \
    docker-cli \
    docker-cli-compose \
    git \
    bash \
    curl \
    openssh-client \
    ca-certificates \
    tzdata

# Tạo user không phải root, nhưng cho join vào group "docker"
# bằng GID động (mount /var/run/docker.sock từ host).
# GID mặc định = 999 (Linux phổ biến); có thể override bằng build-arg.
ARG DOCKER_GID=999
RUN addgroup -g ${DOCKER_GID} docker 2>/dev/null || true \
 && addgroup -S appgroup \
 && adduser -S -G appgroup appuser \
 && addgroup appuser docker \
 && addgroup appuser root

WORKDIR /app

# Copy package files trước để tận dụng Docker cache
COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force

# Copy source code
COPY . .

# Tạo các thư mục runtime
RUN mkdir -p /app/logs /app/data /repos /slots \
 && chown -R appuser:appgroup /app /repos /slots

USER appuser

EXPOSE 54100

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:${PORT:-54100}${HEALTH_PATH:-/api/health} || exit 1

CMD ["node", "src/server.js"]
