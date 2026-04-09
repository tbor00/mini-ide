FROM node:20-bookworm

# Build tools for node-pty + basic utilities
RUN apt-get update && apt-get install -y \
    build-essential python3 python3-pip python3-venv \
    git curl wget vim nano sudo gosu unzip zip \
    bubblewrap \
    ca-certificates openssh-client \
    jq less tree rsync tmux htop \
    make pkg-config \
    net-tools iputils-ping dnsutils \
    && rm -rf /var/lib/apt/lists/*

# Install AWS CLI v2 (arch-aware)
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
      amd64) awsurl="https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" ;; \
      arm64) awsurl="https://awscli.amazonaws.com/awscli-exe-linux-aarch64.zip" ;; \
      *) echo "unsupported arch $arch" && exit 1 ;; \
    esac; \
    curl -fsSL "$awsurl" -o /tmp/awscliv2.zip; \
    unzip -q /tmp/awscliv2.zip -d /tmp; \
    /tmp/aws/install; \
    rm -rf /tmp/aws /tmp/awscliv2.zip

# Install cloudflared (Cloudflare Tunnel client, arch-aware). Used by
# the Play button feature to expose a local dev server via a quick
# trycloudflare.com URL with no account.
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
      amd64) cfurl="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64" ;; \
      arm64) cfurl="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64" ;; \
      *) echo "unsupported arch $arch" && exit 1 ;; \
    esac; \
    curl -fsSL "$cfurl" -o /usr/local/bin/cloudflared; \
    chmod +x /usr/local/bin/cloudflared; \
    /usr/local/bin/cloudflared --version

# Install GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y gh \
    && rm -rf /var/lib/apt/lists/*

# Install Claude Code CLI, OpenAI Codex CLI and Pyright (Python LSP)
RUN npm install -g @anthropic-ai/claude-code @openai/codex pyright

# Install uv + ruff from Astral, system-wide. The installer drops
# binaries in $CARGO_HOME/bin or ~/.local/bin depending on version, so
# we just cp whatever ends up there into /usr/local/bin.
RUN curl -LsSf https://astral.sh/uv/install.sh | sh \
    && curl -LsSf https://astral.sh/ruff/install.sh | sh \
    && cp /root/.local/bin/uv /root/.local/bin/uvx /root/.local/bin/ruff /usr/local/bin/ \
    && /usr/local/bin/uv --version \
    && /usr/local/bin/ruff --version

# pipx so the user can install extra Python CLIs on demand
RUN apt-get update && apt-get install -y pipx && rm -rf /var/lib/apt/lists/* \
    && pipx ensurepath --global 2>/dev/null || true

# Create user "mini-ide" with full sudo permissions
RUN useradd -m -s /bin/bash -G sudo mini-ide \
    && echo "mini-ide ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/mini-ide \
    && chmod 0440 /etc/sudoers.d/mini-ide

# Persistent data directory — mount a Railway volume at /data from the dashboard
RUN mkdir -p /data && chown mini-ide:mini-ide /data

WORKDIR /app

# Install server dependencies
COPY package.json package-lock.json* ./
RUN npm install

# Install client dependencies and build
COPY client/package.json client/package-lock.json* ./client/
RUN cd client && npm install

COPY . .
RUN npm run build

# Give mini-ide ownership of the app
RUN chown -R mini-ide:mini-ide /app /data

ENV DATA_DIR=/data
ENV SHELL=/bin/bash

# Fix permissions on data dir at startup and run as mini-ide
EXPOSE 3000
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["npm", "start"]
