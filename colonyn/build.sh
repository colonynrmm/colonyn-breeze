#!/usr/bin/env bash
# Build the Colonyn images on the Breeze server.
#
#   sudo bash /opt/colonyn-breeze/colonyn/build.sh
#
# Needs ~6 GB free RAM (or swap) and ~10 GB disk; takes 10-20 minutes.
set -euo pipefail

SRC="${COLONYN_SRC:-/opt/colonyn-breeze}"
STACK="${BREEZE_STACK:-/opt/breeze}"
TAG="${COLONYN_IMAGE_TAG:-0.123.0-colonyn.8}"

cd "$SRC"
echo "[colonyn] source: $SRC ($(git describe --tags --always 2>/dev/null || echo 'no git'))"

# 1. Branding (idempotent). Put logo.svg / favicon.svg in colonyn/branding/ first if you have them.
if command -v node >/dev/null 2>&1; then
  node colonyn/branding/apply-branding.mjs
else
  docker run --rm -v "$SRC":/src -w /src node:24-alpine node colonyn/branding/apply-branding.mjs
fi

# 2. Docs site (docs.colonyn.com) from apps/docs, and the AI docs index the API image bundles.
#    Needs network access to the npm registry (Astro/Starlight, versions pinned from pnpm-lock.yaml).
if command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then
  node colonyn/docs/build-docs.mjs
else
  docker run --rm -v "$SRC":/src -w /src node:24-alpine node colonyn/docs/build-docs.mjs
fi

# 3. Images (same Dockerfiles as upstream).
docker build -f docker/Dockerfile.api --build-arg APP_VERSION=0.123.0 -t "colonyn/breeze-api:$TAG" .
docker build -f docker/Dockerfile.web --build-arg PUBLIC_API_URL= --build-arg PUBLIC_APP_VERSION=0.123.0 -t "colonyn/breeze-web:$TAG" .

# 4. Overlay files next to the stock compose file.
install -d "$STACK/colonyn"
install -m 0644 colonyn/docker-compose.colonyn.yml "$STACK/docker-compose.colonyn.yml"
install -m 0644 colonyn/Caddyfile.colonyn "$STACK/colonyn/Caddyfile.colonyn"
# Docs are replaced in place: Caddy bind-mounts this directory, a new directory would not be seen.
install -d "$STACK/colonyn/docs"
find "$STACK/colonyn/docs" -mindepth 1 -delete
cp -a colonyn/docs/dist/. "$STACK/colonyn/docs/"

echo "[colonyn] images built: colonyn/breeze-api:$TAG, colonyn/breeze-web:$TAG"
echo "[colonyn] next: cd $STACK && docker compose -f docker-compose.yml -f docker-compose.colonyn.yml up -d"
