# 0006: contracts toolchain and dependency pins

**Status:** Accepted (C1).

| Item | Pin | Why / source |
|---|---|---|
| Solidity | `0.8.35` (`solc-linux-amd64-v0.8.35+commit.47b9dedd`, sha256 `fa8ac9a3…617f4`) | Newest release with months of use. 0.8.37 (2026-09-10) has no known bugs but is two weeks old. 0.8.35's known bugs ([bugs_by_version.json](https://github.com/ethereum/solidity/blob/develop/docs/bugs_by_version.json)) are all via-IR-only except `MemoryByteArrayElementDeleteClearsWholeWord`, which needs `delete` on one element of an in-memory `bytes` array; the code never does that |
| Code generator | legacy (`via_ir = false`) | Avoids every via-IR-only bug listed for 0.8.35 |
| EVM | `cancun` | Base supports EIP-1153 transient storage, used by `ReentrancyGuardTransient` |
| Optimizer | on, 200 runs | Default |
| OpenZeppelin Contracts and Contracts Upgradeable | `v5.6.1` (git submodules) | npm `latest` dist-tag; 5.7.0 is tagged `dev` |
| forge-std | `v1.16.2` (git submodule) | Latest tag from `foundry-rs/forge-std`. The npm package named `forge-std` is published by a third party and is **not** used |
| Foundry | `1.7.1`, installed from npm `@foundry-rs/forge`, `@foundry-rs/anvil`, `@foundry-rs/cast` | Official packages; maintainers gakonst and onbjerg (Foundry core). The foundryup host was blocked in the build environment |
| Slither | `0.11.6` (PyPI `slither-analyzer`) | |

OpenZeppelin components used, all unmodified: `Clones`, `Initializable`, `EIP712Upgradeable`,
`Ownable2Step` / `Ownable2StepUpgradeable`, `PausableUpgradeable`, `ReentrancyGuardTransient`,
`SignatureChecker`, `SafeERC20`, `Math`, `IERC4626`, `IERC20Permit`. Test-only: `ERC20Permit`,
`ERC4626`, `ERC1271WalletMock`.
