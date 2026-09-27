# Chain workstream: rules for every agent

You are building the on-chain and service side of a direct booking platform: USDC escrow on Base,
yield on idle float, a quote service, an indexer, iCal channel sync and a rebalancer. It holds
other people's money in immutable contracts. Correctness beats speed on every decision.

## 1. Sources of truth

| File | Role |
|---|---|
| `docs/chain-spec.md` | **The spec.** Canonical. If code and spec disagree, the spec wins or you stop and ask |
| `briefs/Cx-*.md` | Your work package: scope, deliverables, acceptance tests |
| `docs/agent-spec-v1.md` | The other workstream (guest agent, checkout UI). Read-only context for section 11 of the spec. Never implement from it |
| `docs/adr/` | Architecture decision records. Read all before starting |

Read `docs/chain-spec.md` sections listed in your brief **in full** before writing code. Do not
work from memory of earlier spec versions; v2 and the v3 delta are superseded.

## 2. Repo layout

```
contracts/                  Foundry project
  src/
    EscrowFactory.sol
    Escrow.sol
    interfaces/             IEscrow.sol, IEscrowFactory.sol (adapter = ERC-4626, ADR 0008)
    adapters/               only if the Aave choice (D5) needs a thin ERC-4626 adapter
    libraries/              QuoteLib.sol, SettlementLib.sol, ...
  test/
    unit/                   one file per contract area
    invariant/              handlers + invariant suites (C9 owns the independent suite)
    fork/                   Base mainnet fork tests (adapters, USDC)
    utils/
  script/                   deployment scripts
services/                   pnpm workspace, TypeScript
  packages/
    abi/                    generated from Foundry artifacts; never hand-edited
    shared/                 money types, time zones, API schemas (zod), config
  apps/
    api-stub/               C0
    quote-service/          C5 (serves the /v1 Service API)
    indexer/                C6
    ical-sync/              C7
    rebalancer/             C8
docs/
  chain-spec.md
  agent-spec-v1.md
  adr/NNNN-title.md
  handoffs/Cx.md
ops/
  runbook.md
briefs/
```

## 3. Stack and commands

**Contracts:** Solidity 0.8.x (pin exact version in `foundry.toml`), OpenZeppelin Contracts v5
(`EIP712`, `SignatureChecker`, `SafeERC20`, `Clones`), Foundry.

```
forge build
forge test                                   # unit + invariant, default profile
FOUNDRY_PROFILE=ci forge test                # fuzz runs 10_000, invariant runs 1_000, depth 100
forge test --match-path 'test/fork/*' --fork-url $BASE_RPC_URL --fork-block-number <pinned>
forge coverage
slither contracts/src
```

**Services:** Node 22 LTS, pnpm workspaces, TypeScript `strict`, viem, zod, vitest, Postgres,
Luxon for IANA time zones.

```
pnpm -r build
pnpm -r test
pnpm --filter @chain/abi generate            # regenerate ABIs after any contract change
```

Money in TS is `bigint` of atomic units end to end. Serialise as decimal strings in JSON. A
`number` anywhere on a money path is a bug.

Pin fork tests to a block number so they are reproducible. Verify every external address (USDC,
Aave pool, oracles) from the issuer's or protocol's official source or address-book package, and
record the source in a comment. Never trust an address from memory, a blog, or this repo's docs
without checking.

## 4. Money rules (non-negotiable)

1. Guest refunds round **up**; fees and yield shares round **down**; owner takes remainders.
2. Crediting a claim never reverts. Only the transfer may be partial.
3. No function takes a recipient address for escrowed funds. Recipients come from stored booking
   data or stored roles. The one exception is the vault's ERC-4626 `withdraw(assets, receiver,
   owner)`, which the escrow always calls with itself as `receiver` and `owner`; test that.
4. `accrue()` is the first call in every escrow function that moves funds or changes an accounting
   parameter. Pure flags (`pauseDeposits`/`unpauseDeposits`) are exempt and make no external call;
   `writeOffVault`/`recoverVault` set their flag first (ADR 0013).
5. Every inflow and outflow updates `lastAssets` by the exact amount moved.
6. Terms on a booking (price, cutoffs, `feeBps`, `guestYieldBps`, arbitrator) never change after
   deposit.
7. Every state change emits an event with enough data to rebuild the ledger without calls.
8. Use custom errors, checks-effects-interactions, and `nonReentrant` on every external function
   that moves tokens.

## 5. Designs that look like bugs. Do not "fix" them

| Looks like | Why it is intentional | Spec |
|---|---|---|
| Guest's yield share goes to the owner on cancellation, owner cancellation, and guest-won disputes | Decided by the project owner (D3) | 4.4 |
| `resolve` has no recipient parameter | Bounds a compromised arbitrator to one contested amount | 7 |
| Both a mock ERC-4626 vault and the Aave ERC-4626 path exist | Mock is the demo and testnet surface; fork is where correctness is proven. Never merge them | 6.6 |
| Owner and fee recipient cannot claim while `lossDebt > 0` or a shortfall is observed | Guests are paid before anyone else during a loss | 6.4, ADR 0009 |
| `accrue()` does not lower `lastAssets` on a dip | Otherwise a recovery is paid out as phantom yield | 6.1, ADR 0009 |
| No on-chain overlap check | Availability must include external channels, which the chain cannot see | 4.2, 9 |
| Quote `feeBps` must **equal** the live fee, not be `<=` it | Otherwise the owner's signer could waive the platform fee | 4.2 |
| Fee recipient is read at settlement, but arbitrator is snapshotted at deposit | Different threat models; both deliberate | 3.4 |
| Rebalancer does not redeem on a depeg | Redeeming during a depeg locks in the loss | 6.7 |
| Utilisation is not a deployment gate | At ~90% Base utilisation it would idle funds permanently; liquidity is gated directly | 6.7 |
| No upgrade path | Immutable clones; migration by draining | 2 |
| Pause does not run `accrue()` | A broken vault must never stop the guardian pausing; Aave's pause does not sync indexes either | 6.1, ADR 0013 |
| `deploy` needs a seeded vault and a 1 USDC owner reserve | Inflation-attack defence and first-loss dust buffer, per audited vault practice | 6.3, ADR 0013 |
| `openDispute` is guest-only | Owners have nothing to claim without a damage deposit (D8) | 7 |

If you believe one of these is actually wrong, write it up in your handoff under "Spec concerns".
Do not change it.

## 6. Testing rules

- Write the invariant and property tests for your package **before** the happy-path
  implementation. The brief names them.
- Every settlement path is fuzzed against the three equalities in spec 4.4.
- Every revert path has a test asserting the specific custom error.
- Contracts: aim for 100% branch coverage on `Escrow` and `EscrowFactory`; explain any gap.
- Fork tests run against pinned Base mainnet state and never against testnet Aave.
- Do not weaken, skip or delete a failing test to make a build pass. If a test is wrong, say so in
  the handoff with the reason.

## 7. Scope discipline

- Build only what your brief lists. Do not edit files owned by another package, except to fix a
  compile break, which you report.
- Any change to a shared interface (`IEscrow`, `IEscrowFactory`, event signatures, the `/v1` API
  schema, DB schema consumed by another app) requires an ADR in `docs/adr/` and a flag in your
  handoff. The Service API in spec 5.3 is also the other workstream's contract: never change it
  unilaterally.
- Do not add features, parameters or roles the spec does not ask for, including compliance or KYC
  features.

## 8. Stop and ask

Stop, write what you found in `docs/handoffs/Cx.md` under "Blocked", and end your run if:

- the spec is ambiguous or self-contradictory on anything that touches funds
- an invariant or equality cannot hold under the spec as written
- you need a new external dependency on a money path (contract library, oracle, service)
- an external address or interface does not match what the spec assumes (for example the USDC
  `permit` signature on Base)
- you would need to change a shared interface and cannot justify it in an ADR
- a decision in spec section 14 turns out to block you

Do not guess on these. A wrong guess in an immutable contract is expensive to undo.

## 9. Secrets and keys

Never commit private keys, RPC URLs with keys, or KMS credentials. Use `.env` (gitignored) and
`.env.example`. Local development uses Anvil's default accounts. The quote signer in any deployed
environment is a KMS key.

## 10. Handoff

End every run by writing `docs/handoffs/Cx.md`:

```
# Cx handoff
## Done
## Not done
## Tests            (commands run and results, coverage numbers)
## Deviations from spec   (each with the reason; should normally be empty)
## Spec concerns    (things you think are wrong but did not change)
## Interfaces changed     (with ADR links)
## Blocked          (questions for the project owner)
```

Be exact. "All tests pass" without the command and output is not a handoff.
