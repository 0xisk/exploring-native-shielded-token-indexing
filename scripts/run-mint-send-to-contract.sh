#!/usr/bin/env bash
# Run the mint+send-to-contract experiment (src/mint-send-to-contract.ts) against
# a self-managed local v8 stack, mirroring scripts/run-mint-to-contract.sh.
# Brings compose.yml up with plain `docker compose`, waits for health, discovers
# ports, and injects them via HB_*.
#
# Usage:  bash scripts/run-mint-send-to-contract.sh
set -euo pipefail

cd "$(dirname "$0")/.."
export TESTCONTAINERS_UID="${TESTCONTAINERS_UID:-msc}"
export NETWORK_ID="${NETWORK_ID:-undeployed}"
COMPOSE=(docker compose -f compose.yml)

cleanup() {
  echo "[run-mint-send-to-contract] tearing down stack..."
  "${COMPOSE[@]}" down -v >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "[run-mint-send-to-contract] bringing up node + indexer + proof-server..."
"${COMPOSE[@]}" up -d

wait_healthy() {
  local svc="$1" name="${2}" tries="${3:-60}"
  echo "[run-mint-send-to-contract] waiting for $svc ($name) to be healthy..."
  for ((i = 1; i <= tries; i++)); do
    local status
    status=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$name" 2>/dev/null || echo "missing")
    if [[ "$status" == "healthy" ]]; then
      echo "[run-mint-send-to-contract]   $svc healthy after ${i}0s"; return 0
    fi
    if [[ "$status" == "exited" || "$status" == "dead" ]]; then
      echo "[run-mint-send-to-contract]   $svc $status — logs:"; docker logs "$name" 2>&1 | tail -30; return 1
    fi
    sleep 10
  done
  echo "[run-mint-send-to-contract]   $svc not healthy after $((tries * 10))s"; docker logs "$name" 2>&1 | tail -30; return 1
}

wait_log() {
  local name="$1" pattern="$2" tries="${3:-60}"
  echo "[run-mint-send-to-contract] waiting for $name log /$pattern/..."
  for ((i = 1; i <= tries; i++)); do
    if docker logs "$name" 2>&1 | grep -qE "$pattern"; then
      echo "[run-mint-send-to-contract]   $name ready after $((i * 5))s"; return 0
    fi
    local status
    status=$(docker inspect --format '{{.State.Status}}' "$name" 2>/dev/null || echo missing)
    if [[ "$status" == "exited" || "$status" == "dead" ]]; then
      echo "[run-mint-send-to-contract]   $name $status — logs:"; docker logs "$name" 2>&1 | tail -30; return 1
    fi
    sleep 5
  done
  echo "[run-mint-send-to-contract]   $name log not seen after $((tries * 5))s"; docker logs "$name" 2>&1 | tail -30; return 1
}

wait_healthy node "node_${TESTCONTAINERS_UID}" 30
wait_healthy indexer "indexer_${TESTCONTAINERS_UID}" 30
wait_log "proof-server_${TESTCONTAINERS_UID}" "listening on: 0\.0\.0\.0:6300" 60

port_of() { "${COMPOSE[@]}" port "$1" "$2" | sed 's/.*://'; }
HB_NODE_PORT="$(port_of node 9944)"
HB_INDEXER_PORT="$(port_of indexer 8088)"
HB_PS_PORT="$(port_of proof-server 6300)"
export HB_NODE_PORT HB_INDEXER_PORT HB_PS_PORT
echo "[run-mint-send-to-contract] ports -> node=$HB_NODE_PORT indexer=$HB_INDEXER_PORT proof-server=$HB_PS_PORT"

echo "[run-mint-send-to-contract] running the mint+send-to-contract experiment..."
pnpm tsx src/mint-send-to-contract.ts
