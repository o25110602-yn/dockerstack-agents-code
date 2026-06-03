# ================================================================
#  repo-agent-ttyd — TTYD slot image with coding tools
#
#  Built once, reused by all 100 ttyd-XXX slots in compose.repo-ttyd.yml.
#  Includes:
#    - ttyd (web terminal)
#    - bash, git, curl, ca-certificates
#    - node + npm  (cho codex/claude/opencode/agy npm-based)
#    - openssh-client (git over SSH nếu cần)
#    - ripgrep, fd, jq, coreutils (cho coding agent)
#
#  Agent CLI (codex / claude / opencode / agy) KHÔNG cài sẵn ở đây.
#  Lý do: package name không ổn định, có agent là binary, có agent là
#  npm package. Có 2 cơ chế để cài thêm:
#    1. Bootstrap script qua AgentCredential type=script
#       (decode → /slot/injected-files/bootstrap-*.sh → entrypoint chạy)
#    2. Build image custom dựa trên image này, thêm RUN cài CLI mong muốn
#
#  Nếu agent command not found, entrypoint vẫn mở shell và in cảnh báo
#  để user biết cần cài thêm.
# ================================================================

FROM tsl0922/ttyd:1.7.7-alpine

# Set bash as default shell for RUN
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
    tzdata

# Install antigravity CLI
RUN curl -fsSL https://antigravity.google/cli/install.sh | sh

# Default workdir (entrypoint sẽ symlink về repo path nếu có)
WORKDIR /workspace

COPY entrypoint.sh /usr/local/bin/repo-agent-ttyd-entrypoint
RUN chmod +x /usr/local/bin/repo-agent-ttyd-entrypoint

EXPOSE 7681

ENTRYPOINT ["/usr/local/bin/repo-agent-ttyd-entrypoint"]
