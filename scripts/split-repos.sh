#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Split SportsAI into the two repositories selling the tool requires.
#
#   sportsai      PRIVATE — the models and the alerter. This is the product;
#                 the moment it is readable, there is nothing to charge for.
#   sportsai-web  PUBLIC  — the record page and the bet ledger. This has to stay
#                 public: the ledger's verifiability IS its commit history, and
#                 a private proof is not proof.
#
# The dashboard stays in `oracle` and keeps working until the API can feed it.
# Moving it before then would take the live board dark, because it computes
# everything client-side from dd-model.js.
#
# Usage:  scripts/split-repos.sh <github-user> [--push]
# Without --push it stages both trees under build/ and stops, so you can look
# before anything leaves the machine.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
USER_NAME="${1:?usage: split-repos.sh <github-user> [--push]}"
PUSH="${2:-}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/build"
WEB_URL="https://${USER_NAME}.github.io/oracle"   # where the dashboard still lives

rm -rf "$OUT"; mkdir -p "$OUT/sportsai" "$OUT/sportsai-web/data" "$OUT/sportsai-web/.github/workflows" "$OUT/sportsai/.github/workflows" "$OUT/sportsai/scripts"

# ── private: the product ────────────────────────────────────────────────────
for f in dd-model.js gridiron-model.js; do cp "$ROOT/$f" "$OUT/sportsai/"; done
for f in parlaiy-alerts.mjs kalshi-snapshot.mjs nfl-prop-shape.mjs; do
  [ -f "$ROOT/scripts/$f" ] && cp "$ROOT/scripts/$f" "$OUT/sportsai/scripts/"
done
cp "$ROOT/.github/workflows/parlaiy-alerts.yml" "$OUT/sportsai/.github/workflows/"
printf 'state.json\nbuild.json\nnode_modules/\n' > "$OUT/sportsai/.gitignore"
cat > "$OUT/sportsai/README.md" <<'MD'
# SportsAI — models and alerting (private)

The pricing engines and the alerter. Private on purpose: this is the product.

- `dd-model.js` — MLB hit-probability engine. Log5 matchups, K/HR/BABIP split
  with per-statistic shrinkage, an inning model for plate appearances, bullpen
  exposure, and a Gaussian copula for same-game pairs.
- `gridiron-model.js` — NFL prop pricing.
- `scripts/parlaiy-alerts.mjs` — per-game alerter. Publishes every bet to the
  public ledger before first pitch and settles it from the official boxscore.

The ledger it writes is pushed to the public web repo, whose commit history is
what makes the record checkable. See LEDGER_PUSH in the workflow.
MD

# ── public: the proof ───────────────────────────────────────────────────────
cp "$ROOT/record.html" "$OUT/sportsai-web/"
for f in sportsai.svg sportsai-square.svg sportsai-180.png sportsai-512.png manifest.json .nojekyll 404.html; do
  [ -f "$ROOT/$f" ] && cp "$ROOT/$f" "$OUT/sportsai-web/"
done
cp "$ROOT/.github/workflows/pages.yml" "$OUT/sportsai-web/.github/workflows/"
# The dashboard is still hosted from `oracle`, so the record page's nav has to
# point at it absolutely rather than at a sibling path that no longer exists.
sed -i "s|href=\"./\"|href=\"${WEB_URL}/\"|g; s|href=\"gridiron.html\"|href=\"${WEB_URL}/gridiron.html\"|g" \
  "$OUT/sportsai-web/record.html"
if [ -f "$ROOT/data/ledger.json" ]; then cp "$ROOT/data/ledger.json" "$OUT/sportsai-web/data/";
else printf '{\n "v": 1,\n "sport": "MLB",\n "bets": []\n}\n' > "$OUT/sportsai-web/data/ledger.json"; fi
[ -f "$ROOT/data/model-log.json" ] && cp "$ROOT/data/model-log.json" "$OUT/sportsai-web/data/"
cat > "$OUT/sportsai-web/README.md" <<MD
# SportsAI — public record

Every bet SportsAI publishes, written here **before first pitch** and settled
afterwards from the official boxscore.

\`data/ledger.json\` is committed the moment a pick is sent. GitHub timestamps
that commit, not us, so [the file's history](../../commits/main/data/ledger.json)
independently proves each pick predated its game. Rows are updated in place when
they settle; nothing is deleted or rewritten.

The verified record starts **2026-09-10**, when per-game alerting went live.
Earlier results came from a materially different system and are reported
separately and marked unverifiable, because they were never logged bet by bet.

⚠ Model estimates, not advice. Past results do not predict future ones. 21+.
MD

echo "staged:"
for r in sportsai sportsai-web; do
  echo "  $r/"; (cd "$OUT/$r" && find . -type f -not -path './.git/*' | sed 's|^\./|    |' | sort)
done

[ "$PUSH" = "--push" ] || { echo; echo "dry run — nothing pushed. re-run with --push once both repos exist."; exit 0; }

for r in sportsai sportsai-web; do
  cd "$OUT/$r"
  git init -q -b main
  git add -A
  git -c user.name=SportsAI -c user.email=noreply@users.noreply.github.com \
      commit -q -m "SportsAI: initial split from oracle"
  git remote add origin "https://github.com/${USER_NAME}/${r}.git"
  git push -u origin main && echo "pushed $r"
done
