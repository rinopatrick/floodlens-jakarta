#!/usr/bin/env bash
set -euo pipefail

image="floodlens:smoke"
container="floodlens-smoke-$$"

cleanup() {
  docker rm -f "$container" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker build -t "$image" .
docker run -d --name "$container" \
  -p 127.0.0.1:8767:8766 \
  -e FLOODLENS_HOST=0.0.0.0 \
  "$image" >/dev/null

for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:8767/healthz" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

curl -fsS "http://127.0.0.1:8767/healthz" | grep -q '"status":"ok"'
curl -fsS "http://127.0.0.1:8767/" | grep -q "FloodLens"
echo "container smoke test passed"
