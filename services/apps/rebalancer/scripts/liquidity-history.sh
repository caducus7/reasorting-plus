#!/usr/bin/env bash
# Samples Aave V3 Base USDC available liquidity and utilisation over the last DAYS days, every HOURS
# hours, from archive state (C8 brief: evidence for the 20x / 5x thresholds). Paced for public RPCs.
#   RPC_URL=https://mainnet.base.org scripts/liquidity-history.sh 90 12 > history.csv
# Addresses: bgd-labs/aave-address-book AaveV3Base.sol (POOL, USDC underlying, USDC_A_TOKEN, USDC_V_TOKEN).
set -u
DAYS=${1:-90}; HOURS=${2:-12}; R=${RPC_URL:?}
POOL=0xA238Dd80C259a72e81d7e4664a9801593F98d1c5; USDC=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
AT=0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB; VD=0x59dca05b6c26dbd64b5381374aAaC5CD05644C28
call() { for i in 1 2 3 4 5 6; do out=$(cast call "$@" --rpc-url "$R" 2>/dev/null) && { echo "${out%% *}"; return; }; sleep $((i * 5)); done; echo NA; }
HEAD=$(cast block-number --rpc-url "$R"); HT=$(cast block "$HEAD" -f timestamp --rpc-url "$R")
echo "block,timestamp,available_usdc,supplied_usdc,borrowed_usdc"
for ((h = DAYS * 24; h >= 0; h -= HOURS)); do
  B=$((HEAD - h * 1800)); T=$((HT - h * 3600))   # Base: 2 s blocks
  A=$(call $POOL "getVirtualUnderlyingBalance(address)(uint128)" $USDC --block $B); sleep 1
  S=$(call $AT "totalSupply()(uint256)" --block $B); sleep 1
  D=$(call $VD "totalSupply()(uint256)" --block $B); sleep 1
  echo "$B,$T,$A,$S,$D"
done
