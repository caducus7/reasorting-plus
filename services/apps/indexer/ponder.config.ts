// Ponder configuration (docs/adr/0014). One chain; the factory and every escrow it creates (EIP-1167
// clones discovered from EscrowCreated). Secrets and endpoints come from the environment only.
import { createConfig, factory } from "ponder";
import { getAbiItem, getAddress } from "viem";
import { escrowAbi, escrowFactoryAbi } from "@chain/abi";

const need = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is required`);
  return v;
};

const factoryAddress = getAddress(need("FACTORY_ADDRESS"));
const startBlock = Number(process.env.FACTORY_START_BLOCK ?? 0);

export default createConfig({
  database: { kind: "postgres", connectionString: need("DATABASE_URL") },
  chains: {
    chain: {
      id: Number(need("CHAIN_ID")),
      rpc: need("RPC_URL"),
      pollingInterval: Number(process.env.POLLING_INTERVAL_MS ?? 1_000),
      disableCache: process.env.CHAIN_ID === "31337", // Anvil state is rebuilt per run
    },
  },
  contracts: {
    EscrowFactory: { chain: "chain", abi: escrowFactoryAbi, address: factoryAddress, startBlock },
    Escrow: {
      chain: "chain",
      abi: escrowAbi,
      address: factory({
        address: factoryAddress,
        event: getAbiItem({ abi: escrowFactoryAbi, name: "EscrowCreated" }),
        parameter: "escrow",
      }),
      startBlock,
    },
  },
});
