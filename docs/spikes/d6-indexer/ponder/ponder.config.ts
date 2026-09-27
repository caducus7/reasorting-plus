import { createConfig } from "ponder";
import { EscrowAbi } from "./abis/Escrow";

export default createConfig({
  database: { kind: "postgres", connectionString: process.env.DATABASE_URL! },
  chains: { anvil: { id: 31337, rpc: process.env.RPC_URL!, pollingInterval: 500, disableCache: true } },
  contracts: {
    Escrow: { chain: "anvil", abi: EscrowAbi, address: process.env.ESCROW as `0x${string}`, startBlock: 0 },
  },
});
