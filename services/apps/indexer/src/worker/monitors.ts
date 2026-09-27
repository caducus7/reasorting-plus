// Invariant monitors (spec 10.4): projection-side checks on every tick, and chain reads at the exact
// block the projection snapshot is complete to, so projection and contract are compared like for like.
import type pg from "pg";
import { erc20Abi, type Address, type PublicClient } from "viem";
import { escrowAbi } from "@chain/abi";
import {
  fromAnomaly,
  inv1,
  inv2,
  inv3,
  inv4,
  inv5,
  projectedFields,
  reconcile,
  requiredLiquid,
  type Breach,
  type CalendarRow,
  type LedgerFields,
} from "../core/invariants.js";
import type { AlertOutbox } from "./notifier.js";
import type { Snapshot } from "./projection.js";
import { localStay } from "./calendar.js";

const FIELD_FNS = [
  "totalOpenPrincipal", "totalDisputed", "totalPendingYield", "totalClaimable", "reserve", "lossDebt",
  "accYieldPerUnit", "lastAssets", "yieldUnallocated", "ownerClaimable", "pendingOwnerYield", "shortfallSince",
] as const;

export async function chainFields(client: PublicClient, escrow: Address, blockNumber: bigint) {
  const read = (functionName: string) =>
    client.readContract({ address: escrow, abi: escrowAbi, functionName: functionName as never, blockNumber }) as Promise<bigint | number | Address>;
  const vals = await Promise.all([...FIELD_FNS, "totalAssets", "usdc"].map(read));
  const f = Object.fromEntries(FIELD_FNS.map((k, i) => [k, BigInt(vals[i] as bigint)])) as LedgerFields;
  const totalAssets = BigInt(vals[FIELD_FNS.length] as bigint);
  const usdc = vals[FIELD_FNS.length + 1] as Address;
  const idle = await client.readContract({ address: usdc, abi: erc20Abi, functionName: "balanceOf", args: [escrow], blockNumber });
  return { ...f, totalAssets, idle };
}

async function calendarRows(pool: pg.Pool): Promise<CalendarRow[]> {
  const r = await pool.query("SELECT resource_id, source, ref, lower(stay)::text AS f, upper(stay)::text AS t FROM calendar_blocks");
  return r.rows.map((x) => ({ resourceId: (x.resource_id as string).toLowerCase(), source: x.source, ref: (x.ref as string).toLowerCase(), from: x.f, to: x.t }));
}

export async function runMonitors(
  pool: pg.Pool,
  client: PublicClient,
  snap: Snapshot,
  zones: Map<string, string>,
  outbox: AlertOutbox,
): Promise<Breach[]> {
  const all: Breach[] = [];
  const sync = async (family: string, list: Breach[], autoResolve = true) => {
    all.push(...list);
    await outbox.sync(family, list, { autoResolve });
  };

  // INV-6 and divergence: recorded per event by the reducer. Facts, never auto-resolved.
  await sync("ANOMALY", snap.anomalies.map(fromAnomaly), false);
  // INV-4: from the projection alone.
  await sync("INV-4", snap.escrows.map(inv4).filter((b): b is Breach => b !== null));

  if (snap.block === 0n) return all;
  const ts = (await client.getBlock({ blockNumber: snap.block })).timestamp;
  const inv: Record<string, Breach[]> = { "INV-1": [], "INV-2": [], "INV-5": [], RECONCILE: [] };
  for (const e of snap.escrows) {
    const c = await chainFields(client, e.id, snap.block);
    const p = projectedFields(snap.balances.get(e.id.toLowerCase()) ?? new Map(), e);
    const bookings = snap.bookings.filter((b) => b.escrow.toLowerCase() === e.id.toLowerCase());
    for (const [k, b] of [
      ["INV-1", inv1(e.id, c)],
      ["INV-2", inv2(e.id, c)],
      ["INV-5", inv5(e.id, c.idle, requiredLiquid(c, bookings, ts))],
      ["RECONCILE", reconcile(e.id, snap.block, p, c)],
    ] as const) if (b) inv[k]!.push(b);
  }
  for (const [k, list] of Object.entries(inv)) await sync(k, list);

  // INV-3: escrowed bookings whose stay has not ended, against the calendar (ours and channels').
  const escrowed = snap.bookings
    .filter((b) => b.status === "ESCROWED" && b.checkOutUtc > ts)
    .map((b) => ({ escrow: b.escrow, bookingId: b.bookingId.toLowerCase(), resourceId: b.resourceId.toLowerCase(), ...localStay(b, zones.get(b.resourceId.toLowerCase()) ?? "UTC") }));
  await sync("INV-3", inv3(escrowed, await calendarRows(pool)));
  return all;
}
