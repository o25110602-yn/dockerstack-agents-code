# ================================================================
#  repo-agent-ttyd — Ubuntu base (glibc) + ttyd
#
#  Lý do đổi từ Alpine sang Ubuntu:
#    - Agent CLI binaries (agy, claude, codex...) build cho glibc
#    - Alpine dùng musl → binary không chạy được
#    - Ubuntu 24.04 LTS dùng glibc → tương thích hoàn toàn
# ================================================================

FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
ENV TZ=UTC

# ── Locale (UTF-8 để gõ tiếng Việt và ký tự Unicode trong terminal) ──
ENV LANG=en_US.UTF-8
ENV LC_ALL=en_US.UTF-8
ENV LANGUAGE=en_US.UTF-8

# ── System packages ───────────────────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash \
    tmux \
    git \
    curl \
    wget \
    ca-certificates \
    openssh-client \
    ripgrep \
    fd-find \
    jq \
    coreutils \
    tzdata \
    unzip \
    xz-utils \
    nodejs \
    npm \
    locales \
 && locale-gen en_US.UTF-8 \
 && update-locale LANG=en_US.UTF-8 \
 && ln -sf /usr/bin/fdfind /usr/local/bin/fd \
 && echo "set -g status off" > /etc/tmux.conf \
 && echo "set -g mouse on" >> /etc/tmux.conf \
 && echo "set -g history-limit 50000" >> /etc/tmux.conf \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/*

# ── Install ttyd ──────────────────────────────────────────────────
# Lấy binary ttyd release mới nhất cho linux amd64
RUN TTYD_VER=$(curl -fsSL https://api.github.com/repos/tsl0922/ttyd/releases/latest \
      | grep '"tag_name"' | sed 's/.*"tag_name": *"\([^"]*\)".*/\1/') \
 && curl -fsSL "https://github.com/tsl0922/ttyd/releases/download/${TTYD_VER}/ttyd.x86_64" \
      -o /usr/local/bin/ttyd \
 && chmod +x /usr/local/bin/ttyd \
 && ttyd --version

# ── Agent CLI tools (pre-downloaded by CI via download-tools.sh) ──
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