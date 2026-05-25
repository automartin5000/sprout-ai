#!/usr/bin/env bash
#
# Sprout new-app bootstrap.
#
# Usage:
#   bash bootstrap-app.sh <slug> <destination-dir>
#
# Copies the bundled hono-react template into <destination-dir>, substitutes
# __APP_NAME__ + __APP_SLUG__, runs `bun install`, then a one-shot build to
# confirm the toolchain works.
#
# Designed to be re-run safely: skips file copies if the destination already
# has the marker file `.sprout-scaffolded`.

set -euo pipefail

SLUG="${1:-}"
DEST="${2:-}"

if [[ -z "$SLUG" || -z "$DEST" ]]; then
  echo "Usage: bootstrap-app.sh <slug> <destination>" >&2
  exit 1
fi

if [[ -z "${CLAUDE_PLUGIN_ROOT:-}" ]]; then
  echo "CLAUDE_PLUGIN_ROOT is not set; can't locate the bundled template" >&2
  exit 1
fi

TEMPLATE="${CLAUDE_PLUGIN_ROOT}/templates/hono-react"
if [[ ! -d "$TEMPLATE" ]]; then
  echo "Template missing at $TEMPLATE" >&2
  exit 1
fi

# Pretty name = slug with hyphens replaced by spaces + title-case (best-effort)
APP_NAME="$(echo "$SLUG" | tr '-' ' ' | awk '{for(i=1;i<=NF;i++) $i=toupper(substr($i,1,1)) substr($i,2)}1')"

mkdir -p "$DEST"

if [[ -f "$DEST/.sprout-scaffolded" ]]; then
  echo "Project already scaffolded at $DEST — skipping copy."
else
  # Copy everything, follow no symlinks. -a preserves perms.
  cp -a "$TEMPLATE"/. "$DEST"/

  # Substitute __APP_NAME__ / __APP_SLUG__ placeholders in our own files.
  # IMPORTANT: prune node_modules — it's the (potentially huge) pre-bundled
  # dep tree from the staged template, and we don't want sed touching it
  # (slow, and could corrupt JSON manifests). Same for the .git dir.
  find "$DEST" \
    \( -name node_modules -o -name .git \) -prune -o \
    -type f \
    \( -name '*.ts' -o -name '*.tsx' -o -name '*.json' -o -name '*.md' -o -name '*.html' -o -name '*.sh' \) \
    -print0 \
  | xargs -0 sed -i '' \
      -e "s/__APP_NAME__/${APP_NAME}/g" \
      -e "s/__APP_SLUG__/${SLUG}/g"

  touch "$DEST/.sprout-scaffolded"
fi

cd "$DEST"

# If `node_modules` was already copied in from the bundled template — which is
# Sprout's normal case — skip the install. The stage step (run when the
# desktop app was built) pre-installed everything, so deps are sitting in
# `node_modules` already and we just need to confirm the build still works.
#
# Fall back to `npm install` only when node_modules is missing (e.g. dev
# mode with SKIP_TEMPLATE_INSTALL=1, or someone wiped node_modules manually).
echo ""
if [[ -d "$DEST/node_modules" ]]; then
  echo "→ Dependencies already bundled — skipping install."
else
  echo "→ Installing dependencies (this can take a minute on first install)…"
  npm install --prefer-offline --no-audit --no-fund
fi

echo ""
echo "→ Running an initial build to confirm everything works…"
npm run build || { echo "Build failed — leaving the scaffold in place so you can inspect it."; exit 1; }

echo ""
echo "✅ Scaffold ready at $DEST"
