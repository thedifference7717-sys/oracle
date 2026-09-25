#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Prop Shop engine server: one-time setup. Safe to run again.
#
# On a fresh Ubuntu 24.04 server, as root (the provider's web console is fine):
#
#   curl -fsSL https://raw.githubusercontent.com/thedifference7717-sys/oracle/main/deploy/setup-server.sh | bash -s -- RUNNER_TOKEN
#
# RUNNER_TOKEN comes from github.com/thedifference7717-sys/prop-shop-engine →
# Settings → Actions → Runners → New self-hosted runner. It's the value after
# --token in the "Configure" box, and it's good for one hour.
#
# What it does:
#   - a user, propshop, that the runners run as (never root)
#   - two GitHub runners for the private engine repo, as system services:
#       prop-shop-alerts   the alerts loop, which occupies its runner all day
#       prop-shop-jobs     everything else (prices, logs, backtests)
#   - a deploy key for the public oracle repo. The secret half never leaves
#     this server; it prints the public half for you to add to oracle.
#   - 1 GB of swap, so a small plan doesn't run out of memory
# Nothing here holds a secret: Telegram, PICKS_KEY and the rest stay in
# GitHub and reach the runners only while a job runs.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
TOKEN="${1:-}"
REPO_URL="https://github.com/thedifference7717-sys/prop-shop-engine"
U=propshop
H=/home/$U

[ "$(id -u)" = 0 ] || { echo "Run this as root (or put sudo in front of bash)."; exit 1; }
[ -n "$TOKEN" ] || { echo "Missing the runner token. See the top of this script."; exit 1; }

echo "▸ packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq git curl jq tar ca-certificates openssh-client >/dev/null

echo "▸ swap"
if ! swapon --show | grep -q .; then
  fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "▸ user $U"
id "$U" >/dev/null 2>&1 || useradd -m -s /bin/bash "$U"
install -d -o "$U" -g "$U" -m 700 "$H/.ssh"
install -d -o "$U" -g "$U" "$H/prop-shop"

echo "▸ deploy key for oracle"
[ -f "$H/.ssh/oracle_deploy" ] || sudo -u "$U" ssh-keygen -q -t ed25519 -N "" -C "prop-shop-engine" -f "$H/.ssh/oracle_deploy"
cat > "$H/.ssh/config" <<'EOF'
Host github-oracle
  HostName github.com
  User git
  IdentityFile ~/.ssh/oracle_deploy
  IdentitiesOnly yes
EOF
# Trust github.com's key only if it is the one GitHub publishes.
GH_FP="SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU"
KEY=$(ssh-keyscan -t ed25519 github.com 2>/dev/null)
echo "$KEY" | ssh-keygen -lf - | grep -q "$GH_FP" || { echo "github.com's SSH key did not match GitHub's published fingerprint — stopping."; exit 1; }
grep -qF "$KEY" "$H/.ssh/known_hosts" 2>/dev/null || echo "$KEY" >> "$H/.ssh/known_hosts"
chown "$U:$U" "$H/.ssh/config" "$H/.ssh/known_hosts"; chmod 600 "$H/.ssh/config"

echo "▸ GitHub runners"
case "$(uname -m)" in x86_64) A=x64 ;; aarch64) A=arm64 ;; *) echo "Unsupported CPU $(uname -m)"; exit 1 ;; esac
V=$(curl -fsSL https://api.github.com/repos/actions/runner/releases/latest | jq -r .tag_name | sed 's/^v//')
curl -fsSL -o /tmp/runner.tgz "https://github.com/actions/runner/releases/download/v$V/actions-runner-linux-$A-$V.tar.gz"
for R in alerts jobs; do
  D="$H/runner-$R"
  if [ -f "$D/.runner" ]; then echo "  $R: already registered"; continue; fi
  install -d -o "$U" -g "$U" "$D"
  sudo -u "$U" tar xzf /tmp/runner.tgz -C "$D"
  (cd "$D" && ./bin/installdependencies.sh >/dev/null)
  sudo -u "$U" bash -c "cd '$D' && ./config.sh --unattended --url '$REPO_URL' --token '$TOKEN' --name '$(hostname)-$R' --labels 'prop-shop-$R' --work _work --replace"
  (cd "$D" && ./svc.sh install "$U" >/dev/null && ./svc.sh start >/dev/null)
  echo "  $R: running"
done
rm -f /tmp/runner.tgz

cat <<EOF

✅ Server ready.

NEXT: add this key to the PUBLIC oracle repo, so the engine can publish the record:
  github.com/thedifference7717-sys/oracle → Settings → Deploy keys → Add deploy key
  Title:  prop-shop-engine
  Key:    (the line below)
  ☑ Allow write access

$(cat "$H/.ssh/oracle_deploy.pub")

EOF
