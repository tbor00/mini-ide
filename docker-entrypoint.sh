#!/bin/bash
# Fix ownership of /data (may have been created by root on volume mount)
sudo chown -R mini-ide:mini-ide /data 2>/dev/null || true

# Auto-login to GitHub CLI if GITHUB_TOKEN is set
if [ -n "$GITHUB_TOKEN" ]; then
  sudo -u mini-ide bash -c "echo '$GITHUB_TOKEN' | gh auth login --with-token 2>/dev/null || true"
fi

exec gosu mini-ide "$@"
