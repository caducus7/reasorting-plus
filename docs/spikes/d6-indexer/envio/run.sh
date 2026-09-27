#!/usr/bin/env bash
# Envio reorg prototype: 3 blocks, 40 blocks (inside max_reorg_depth 50), 70 blocks (beyond it).
set -u
E=$(dirname "$0"); cd "$E"
export RPC_URL=http://127.0.0.1:18545 ENVIO_RPC_URL=http://127.0.0.1:18545
PG=postgres://chain:chain@127.0.0.1:5432
Q="$(realpath /home/user/reasorting-plus/services/apps/quote-service)"
anvil --port 18545 --silent & ANVIL=$!
for i in $(seq 60); do cast chain-id --rpc-url $RPC_URL >/dev/null 2>&1 && break; sleep 0.25; done
(cd /home/user/reasorting-plus/contracts && forge script script/DeployLocal.s.sol --rpc-url $RPC_URL --broadcast >/dev/null 2>&1) || { echo "deploy failed"; kill $ANVIL; exit 1; }
export ENVIO_ESCROW=$(node -p 'require("/home/user/reasorting-plus/contracts/deployments/local.json").escrow')
psql $PG/postgres -qc "DROP DATABASE IF EXISTS envio_proto WITH (FORCE)" -c "CREATE DATABASE envio_proto" >/dev/null 2>&1
export ENVIO_PG_HOST=127.0.0.1 ENVIO_PG_PORT=5432 ENVIO_PG_USER=chain ENVIO_PG_PASSWORD=chain ENVIO_PG_DATABASE=envio_proto ENVIO_PG_SCHEMA=proto ENVIO_HASURA=false ENVIO_TUI=false
rows() { psql $PG/envio_proto -tAc 'SELECT count(*) FROM proto."Booking"' 2>/dev/null || echo "n/a"; }
waitfor() { for i in $(seq 90); do [ "$(rows)" = "$1" ] && return 0; [ $((i % 10)) = 0 ] && cast rpc anvil_mine 1 --rpc-url $RPC_URL >/dev/null; sleep 1; done; return 1; }
./node_modules/.bin/envio start > envio.log 2>&1 & ENVIO=$!
for i in $(seq 120); do [ "$(rows)" != "n/a" ] && break; sleep 1; done
echo "started: rows=$(rows)"
deposit() { (cd $Q && RPC_URL=$RPC_URL node .proto-deposit.mjs); }
reorg() {
  echo "--- reorg depth $1 (mined $2 blocks after the deposit)"
  echo "deposit $(deposit)"; waitfor 1 && echo "indexed: rows=1" || echo "NOT indexed: rows=$(rows)"
  cast rpc anvil_mine $2 --rpc-url $RPC_URL >/dev/null; sleep 5
  cast rpc --raw anvil_reorg "[$1, []]" --rpc-url $RPC_URL >/dev/null && echo "reorged $1 blocks (deposit dropped)"
  cast rpc anvil_mine 2 --rpc-url $RPC_URL >/dev/null
  if waitfor 0; then echo "rolled back: rows=0"; else echo "NOT rolled back after 90s: rows=$(rows); envio alive: $(kill -0 $ENVIO 2>/dev/null && echo yes || echo no)"; fi
  psql $PG/envio_proto -qc 'DELETE FROM proto."Booking"' >/dev/null 2>&1
}
reorg 3 1
reorg 40 38
reorg 70 68
grep -iE "reorg|rollback|error" envio.log | sed 's/\x1b\[[0-9;]*m//g' | cut -c1-200 | tail -8
kill $ENVIO $ANVIL 2>/dev/null; wait 2>/dev/null
