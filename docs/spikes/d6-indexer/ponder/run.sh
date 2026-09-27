#!/usr/bin/env bash
# Ponder reorg prototype: shallow reorg (within 30-block window) and deep reorg (beyond it).
set -u
P=$(dirname "$0"); cd "$P"
export RPC_URL=http://127.0.0.1:18545
PG=postgres://chain:chain@127.0.0.1:5432
Q="$(realpath /home/user/reasorting-plus/services/apps/quote-service)"
anvil --port 18545 --silent & ANVIL=$!
for i in $(seq 60); do cast chain-id --rpc-url $RPC_URL >/dev/null 2>&1 && break; sleep 0.25; done
(cd /home/user/reasorting-plus/contracts && forge script script/DeployLocal.s.sol --rpc-url $RPC_URL --broadcast >/dev/null 2>&1) || { echo "deploy failed"; kill $ANVIL; exit 1; }
export ESCROW=$(node -p 'require("/home/user/reasorting-plus/contracts/deployments/local.json").escrow')
psql $PG/postgres -qc "DROP DATABASE IF EXISTS ponder_proto WITH (FORCE)" -c "CREATE DATABASE ponder_proto" >/dev/null
export DATABASE_URL=$PG/ponder_proto
rows() { psql $DATABASE_URL -tAc "SELECT count(*) FROM proto.booking" 2>/dev/null || echo "n/a"; }
waitfor() { for i in $(seq 60); do [ "$(rows)" = "$1" ] && return 0; sleep 0.5; done; return 1; }
./node_modules/.bin/ponder start --schema proto --port 42099 > ponder.log 2>&1 & PONDER=$!
for i in $(seq 120); do curl -sf http://127.0.0.1:42099/ready >/dev/null && break; sleep 0.5; done
echo "ready: $(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:42099/ready)"

echo "--- shallow reorg (depth 3, inside Ponder's 30-block window)"
D=$(cd $Q && RPC_URL=$RPC_URL node .proto-deposit.mjs); echo "deposit $D"
waitfor 1 && echo "indexed: rows=$(rows)" || echo "NOT indexed: rows=$(rows)"
cast rpc anvil_mine 1 --rpc-url $RPC_URL >/dev/null
cast rpc --raw anvil_reorg '[3, []]' --rpc-url $RPC_URL >/dev/null && echo "reorged 3 blocks (deposit dropped)"
cast rpc anvil_mine 2 --rpc-url $RPC_URL >/dev/null
waitfor 0 && echo "rolled back: rows=$(rows)" || echo "NOT rolled back: rows=$(rows)"

echo "--- deep reorg (depth 70, beyond the 30-block window)"
D=$(cd $Q && RPC_URL=$RPC_URL node .proto-deposit.mjs); echo "deposit $D"
waitfor 1 && echo "indexed: rows=$(rows)"
cast rpc anvil_mine 75 --rpc-url $RPC_URL >/dev/null; sleep 8; echo "head $(cast block-number --rpc-url $RPC_URL)"
cast rpc --raw anvil_reorg '[70, []]' --rpc-url $RPC_URL >/dev/null && echo "reorged 70 blocks (deposit dropped)"
cast rpc anvil_mine 2 --rpc-url $RPC_URL >/dev/null
for i in $(seq 120); do
  grep -qi "unrecoverable" ponder.log && break; kill -0 $PONDER 2>/dev/null || break
  [ $((i % 10)) = 0 ] && cast rpc anvil_mine 1 --rpc-url $RPC_URL >/dev/null; sleep 1
done
echo "after ${i}s: rows=$(rows); ponder alive: $(kill -0 $PONDER 2>/dev/null && echo yes || echo no)"
grep -iE "unrecoverable|reorg" ponder.log | tail -5
kill $PONDER $ANVIL 2>/dev/null; wait 2>/dev/null
