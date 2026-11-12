#!/usr/bin/env bash
# Build the Colonyn images on the Breeze server.
#
#   sudo bash /opt/colonyn-breeze/colonyn/build.sh
#
# Needs ~6 GB free RAM (or swap) and ~10 GB disk; takes 10-20 minutes.
set -euo pipefail

SRC="${COLONYN_SRC:-/opt/colonyn-breeze}"
STACK="${BREEZE_STACK:-/opt/breeze}"
TAG="${COLONYN_IMAGE_TAG:-0.123.0-colonyn.4}"

cd "$SRC"
echo "[colonyn] source: $SRC ($(git describe --tags --always 2>/dev/null || echo 'no git'))"

# 1. Branding (idempotent). Put logo.svg / favicon.svg in colonyn/branding/ first if you have them.
if command -v node >/dev/null 2>&1; then
  node colonyn/branding/apply-branding.mjs
else
  docker run --rm -v "$SRC":/src -w /src node:24-alpine node colonyn/branding/apply-branding.mjs
fi

# 2. Images (same Dockerfiles as upstream).
docker build -f docker/Dockerfile.api --build-arg APP_VERSION=0.123.0 -t "colonyn/breeze-api:$TAG" .
docker build -f docker/Dockerfile.web --build-arg PUBLIC_API_URL= --build-arg PUBLIC_APP_VERSION=0.123.0 -t "colonyn/breeze-web:$TAG" .

# 3. Overlay files next to the stock compose file.
install -d "$STACK/colonyn"
install -m 0644 colonyn/docker-compose.colonyn.yml "$STACK/docker-compose.colonyn.yml"
install -m 0644 colonyn/Caddyfile.colonyn "$STACK/colonyn/Caddyfile.colonyn"

echo "[colonyn] images built: colonyn/breeze-api:$TAG, colonyn/breeze-web:$TAG"
echo "[colonyn] next: cd $STACK && docker compose -f docker-compose.yml -f docker-compose.colonyn.yml up -d"
