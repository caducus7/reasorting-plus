import { createConfig } from "ponder";
import { parseAbi } from "viem";

// Circle native USDC on Base Sepolia, verified in C1 (contracts/script/DeployBaseSepolia.s.sol).
export default createConfig({
  database: { kind: "postgres", connectionString: process.env.DATABASE_URL! },
  chains: { baseSepolia: { id: 84532, rpc: "https://sepolia.base.org" } },
  contracts: {
    USDC: {
      chain: "baseSepolia",
      abi: parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)"]),
      address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      startBlock: 47376749,
    },
  },
});
