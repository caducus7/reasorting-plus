# D6 indexer spike (evidence for docs/adr/0014)

Evaluation code, not product code. Each directory is a minimal indexer of the real `Escrow`
`BookingDeposited` event. `run.sh` starts Anvil, deploys with `contracts/script/DeployLocal.s.sol`,
deposits a signed quote, forces `anvil_reorg` at several depths, and reports whether the projection
rolled back.

To reproduce:

- Install each directory with `pnpm install --ignore-workspace`.
- Copy `ponder/deposit.mjs` to `services/apps/quote-service/.proto-deposit.mjs`, so that it resolves
  `@chain/shared` and `@chain/abi`.
- Run `./run.sh`. It needs Postgres at `postgres://chain:chain@127.0.0.1:5432`, plus anvil, forge
  and cast.
- Ponder's run expects the Escrow ABI as `abis/Escrow.ts`:
  `export const EscrowAbi = <contracts/abi/Escrow.json> as const;`

`ponder/base-sepolia.config.ts` is the public-RPC run over Circle USDC `Transfer` on Base Sepolia.
