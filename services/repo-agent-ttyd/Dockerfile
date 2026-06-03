# ================================================================
#  repo-agent-ttyd — TTYD slot image with coding tools
#
#  Agent CLI được cài sẵn vào image.
#  Binary pre-downloaded bởi download-tools.sh trên CI runner.
#
#  Thêm tool mới:
#    1. Thêm vào download-tools.sh (group tương ứng)
#    2. Không cần sửa Dockerfile — COPY downloads/* tự pick up
# ================================================================

FROM tsl0922/ttyd:1.7.7-alpine

SHELL ["/bin/sh", "-c"]

RUN apk add --no-cache \
    bash \
    git \
    curl \
    ca-certificates \
    nodejs \
    npm \
    openssh-client-default \
    ripgrep \
    fd \
    jq \
    coreutils \
    tzdata \
    unzip

# ── Agent CLI tools (pre-downloaded by CI via download-tools.sh) ──
# downloads/ không commit vào git (.gitignore).
# CI chạy download-tools.sh trước, tạo ra thư mục này.
# Nếu downloads/ trống hoặc không tồn tại → build vẫn pass,
# chỉ thiếu tool (entrypoint sẽ in cảnh báo).
COPY downloads/ /usr/local/bin/
RUN find /usr/local/bin -maxdepth 1 -type f ! -name '*.sh' -exec chmod +x {} \; \
 && echo "Installed tools:" \
 && ls -lh /usr/local/bin/ | grep -v '^total' || true

# ── Default workdir ───────────────────────────────────────────────
WORKDIR /workspace

COPY entrypoint.sh /usr/local/bin/repo-agent-ttyd-entrypoint
RUN chmod +x /usr/local/bin/repo-agent-ttyd-entrypoint

EXPOSE 7681

ENTRYPOINT ["/usr/local/bin/repo-agent-ttyd-entrypoint"]
