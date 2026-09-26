# 0005: escrow deployment pattern: EIP-1167 clones, not upgradeable proxies

**Status:** Accepted for testnet (C1). Project owner to confirm before mainnet.
**Context:** The project owner allowed proxies "if that is a better option for deployment", and said
contracts are changeable for now. Spec section 2 says the contracts are immutable clones, with
migration by draining.

## Options

| | EIP-1167 clone (`Clones.clone`) | `BeaconProxy` + `UpgradeableBeacon` | Per-escrow UUPS / Transparent proxy |
|---|---|---|---|
| Who can change a live escrow's code | Nobody | Beacon owner, for **every** escrow at once | Proxy admin, per escrow |
| Can the platform move escrowed funds? | No (role table, spec 3.3) | Yes: upgrade, then drain | Yes, if the platform holds admin |
| Blast radius of a compromised admin key | Fee and arbitrator changes, 7-day timelocked, bounded by `maxFeeBps` | All float in all escrows | That owner's float |
| Extra gas per call | ~2.6k (one delegatecall) | ~2.6k + beacon `SLOAD` + call | ~2.6k + implementation-slot `SLOAD` |
| Fixing a bug | New implementation for new escrows; owners drain and migrate | One upgrade | One upgrade per escrow |
| Audited OpenZeppelin building block | `Clones` | `BeaconProxy`, `UpgradeableBeacon` | `ERC1967Proxy`, `UUPSUpgradeable` |

## Decision

Use OpenZeppelin `Clones` (EIP-1167), as the spec says. The escrow is written in the upgradeable
style anyway: `Initializable`, OpenZeppelin's `*Upgradeable` parents with ERC-7201 namespaced
storage, and `_disableInitializers()` in the implementation's constructor. That means the same
`Escrow` bytecode can sit behind a `BeaconProxy` unchanged. Switching patterns is about ten lines in
`EscrowFactory.createEscrow` and needs no change to `Escrow`.

## Why not proxies

1. **Upgradeability is a key that can move funds.** Every guarantee in spec 3.3 ("factoryAdmin
   cannot move funds", "arbitrator can misallocate one contested amount and nothing else") holds
   only while nobody can replace the code. A beacon turns the factoryAdmin Safe into the custodian
   of every owner's float. That contradicts spec 3.1's containment rationale and D-level decisions
   on who absorbs losses.
2. **A timelock does not fix it at an acceptable delay.** Guests would need to be able to exit
   before an upgrade lands. But principal is locked until settlement, which can be months after
   deposit (up to 60 nights plus the lead time plus `GRACE`). No practical delay covers that.
3. **Testnet does not need it.** Redeploying on Base Sepolia is free and fast.
   `setImplementation` already gives new escrows new code, and `DeployBaseSepolia` redeploys
   everything.
4. **Gas.** A clone is the cheapest per-owner deployment (`createEscrow` measured at ~363k gas,
   dominated by initialiser storage writes) and adds no per-call beacon lookup.

## If the owner still wants upgrades

Use `BeaconProxy` with the beacon owned by an OpenZeppelin `TimelockController`, proposer = the
factoryAdmin Safe, and an owner-held veto (the owner as canceller). Record it as a new ADR, and
update spec 2 and the CLAUDE.md "no upgrade path" row. The escrow code does not change.
