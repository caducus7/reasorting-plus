// Spec 10.4 invariants as pure functions over plain inputs, so each can be broken deliberately in a
// test. The worker gathers the inputs (projection snapshot + chain reads at the same block).
import { A, sumPrefix } from "./accounts.js";
import type { BookingRow, EscrowRow } from "./types.js";

export const MIN_LOSS_ATOMIC = 1_000_000n; // ADR 0010 §4, ADR 0013 §4
export const MIN_BUFFER_BPS = 1_000n; // spec 13
export const BPS = 10_000n;
export const MIN_LEAD_TIME_SEC = 14n * 86_400n; // spec 6.7

export type Severity = "page" | "alert" | "warn";
export type Breach = {
  invariant: string;
  severity: Severity;
  key: string; // dedupe key: one open alert per key
  escrow?: string;
  message: string;
  details?: Record<string, string | number | boolean | null>;
  response: string[];
};

/** Spec 10.4 response table. */
export const RESPONSE: Record<string, string[]> = {
  "INV-1": ["page", "guardian_pause_deposits", "halt_deployment"],
  "INV-2": ["loss_handling", "halt_deployment"],
  "INV-3": ["alert_owner", "conflict_runbook"],
  "INV-4": ["page", "halt_yield_payouts"],
  "INV-5": ["halt_deployment", "redeem"],
  "INV-6": ["page", "guardian_pause_deposits"],
  RECONCILE: ["page", "halt_deployment"],
  DIVERGENCE: ["page", "halt_deployment"],
  DEEP_REORG: ["page", "full_replay"],
  LAG: ["page", "check_indexer", "full_replay_if_unrecoverable_reorg"],
};

/** The projection must keep up with the chain; a stalled indexer is as dangerous as a wrong one. */
export function lag(indexed: bigint, latest: bigint, maxLag: bigint): Breach | null {
  if (latest - indexed <= maxLag) return null;
  return {
    invariant: "LAG",
    severity: "page",
    key: "LAG:indexer",
    message: `projection at block ${indexed}, chain at ${latest}: ${latest - indexed} blocks behind`,
    details: { indexed: indexed.toString(), latest: latest.toString() },
    response: RESPONSE.LAG!,
  };
}

/** The contract's accounting fields, as the escrow's views return them. */
export type LedgerFields = {
  totalOpenPrincipal: bigint;
  totalDisputed: bigint;
  totalPendingYield: bigint;
  totalClaimable: bigint;
  reserve: bigint;
  lossDebt: bigint;
  accYieldPerUnit: bigint;
  lastAssets: bigint;
  yieldUnallocated: bigint;
  ownerClaimable: bigint;
  pendingOwnerYield: bigint;
  shortfallSince: bigint;
};

/** The same fields computed from the projection. */
export function projectedFields(balances: Iterable<[string, bigint]>, e: EscrowRow): LedgerFields {
  const m = new Map(balances);
  const b = (k: string) => m.get(k) ?? 0n;
  return {
    totalOpenPrincipal: b(A.openPrincipal),
    totalDisputed: b(A.disputed),
    totalPendingYield: sumPrefix(m, "pending:"),
    totalClaimable: sumPrefix(m, "claimable:"),
    reserve: b(A.reserve),
    lossDebt: b(A.lossDebt),
    accYieldPerUnit: e.accYieldPerUnit,
    lastAssets: b(A.idle) + b(A.deployed),
    yieldUnallocated: b(A.yieldUnallocated),
    ownerClaimable: b(A.ownerClaimable),
    pendingOwnerYield: b(A.pendingOwner),
    shortfallSince: e.shortfallSince,
  };
}

const s = (x: bigint) => x.toString();

/** INV-1 (hard): page when the gap is >= MIN_LOSS_ATOMIC (ERC-4626 rounding is below it). */
export function inv1(escrow: string, c: LedgerFields & { totalAssets: bigint }): Breach | null {
  const need = c.totalOpenPrincipal + c.totalDisputed + c.totalClaimable;
  const have = c.totalAssets + c.lossDebt;
  if (need - have < MIN_LOSS_ATOMIC) return null;
  return {
    invariant: "INV-1",
    severity: "page",
    key: `INV-1:${escrow}`,
    escrow,
    message: `solvency: assets + lossDebt ${have} < principal + disputed + claimable ${need}`,
    details: { gap: s(need - have) },
    response: RESPONSE["INV-1"]!,
  };
}

/** INV-2 (full): alert at the loss threshold; smaller gaps are rounding and only warn. */
export function inv2(escrow: string, c: LedgerFields & { totalAssets: bigint }): Breach | null {
  const need = c.totalOpenPrincipal + c.totalDisputed + c.totalPendingYield + c.totalClaimable + c.reserve + c.yieldUnallocated;
  const have = c.totalAssets + c.lossDebt;
  if (have >= need) return null;
  const gap = need - have;
  return {
    invariant: "INV-2",
    severity: gap >= MIN_LOSS_ATOMIC ? "alert" : "warn",
    key: `INV-2:${escrow}`,
    escrow,
    message: `full solvency short by ${gap}`,
    details: { gap: s(gap) },
    response: RESPONSE["INV-2"]!,
  };
}

/** INV-4: yield crystallised from the accumulator never exceeds the gains credited to it. */
export function inv4(e: EscrowRow): Breach | null {
  if (e.crystallisedYield <= e.realisedGain) return null;
  return {
    invariant: "INV-4",
    severity: "page",
    key: `INV-4:${e.id}`,
    escrow: e.id,
    message: `yield credited ${e.crystallisedYield} exceeds realised gain ${e.realisedGain}`,
    response: RESPONSE["INV-4"]!,
  };
}

/** Spec 6.7: what must stay liquid, and the MIN_BUFFER_BPS floor; the larger applies. */
export function requiredLiquid(c: LedgerFields, bookings: BookingRow[], nowUtc: bigint): bigint {
  let soon = 0n;
  for (const b of bookings) {
    if ((b.status === "ESCROWED" || b.status === "FROZEN") && b.checkInUtc <= nowUtc + MIN_LEAD_TIME_SEC) {
      soon += b.principalAtomic; // includes stays in progress and awaiting settlement
    }
  }
  const mustStay = c.totalClaimable + c.totalDisputed + c.totalPendingYield + soon;
  const liabilities = c.totalOpenPrincipal + c.totalDisputed + c.totalPendingYield + c.totalClaimable;
  const floor = (liabilities * MIN_BUFFER_BPS) / BPS;
  return mustStay > floor ? mustStay : floor;
}

/** INV-5: idle covers the rebalancer's required liquid amount. */
export function inv5(escrow: string, idle: bigint, required: bigint): Breach | null {
  if (idle >= required) return null;
  return {
    invariant: "INV-5",
    severity: "alert",
    key: `INV-5:${escrow}`,
    escrow,
    message: `idle ${idle} below required liquid ${required}`,
    details: { idle: s(idle), required: s(required) },
    response: RESPONSE["INV-5"]!,
  };
}

export type CalendarRow = { resourceId: string; source: string; ref: string; from: string; to: string };

/** INV-3: every ESCROWED booking is in the calendar, and no channel event overlaps one. Dates are
 * ISO property-local dates, [from, to). */
export function inv3(
  escrowed: { escrow: string; bookingId: string; resourceId: string; from: string; to: string }[],
  calendar: CalendarRow[],
): Breach[] {
  const out: Breach[] = [];
  for (const b of escrowed) {
    const own = calendar.some((r) => r.source === "escrow" && r.ref === b.bookingId && r.resourceId === b.resourceId);
    if (!own) {
      out.push({
        invariant: "INV-3",
        severity: "alert",
        key: `INV-3:missing:${b.bookingId}`,
        escrow: b.escrow,
        message: `escrowed booking ${b.bookingId} is not in the calendar`,
        response: RESPONSE["INV-3"]!,
      });
    }
    for (const r of calendar) {
      if (r.source === "escrow" || r.resourceId !== b.resourceId) continue;
      if (r.from < b.to && b.from < r.to) {
        out.push({
          invariant: "INV-3",
          severity: "alert",
          key: `INV-3:overlap:${b.bookingId}:${r.source}:${r.ref}`,
          escrow: b.escrow,
          message: `channel event ${r.source}/${r.ref} overlaps escrowed booking ${b.bookingId}`,
          details: { resourceId: b.resourceId, from: b.from, to: b.to },
          response: RESPONSE["INV-3"]!,
        });
      }
    }
  }
  return out;
}

/** Projection vs the contract at the same block: any difference is a page. */
export function reconcile(escrow: string, block: bigint, p: LedgerFields, c: LedgerFields): Breach | null {
  const diff = (Object.keys(p) as (keyof LedgerFields)[]).filter((k) => p[k] !== c[k]);
  if (diff.length === 0) return null;
  return {
    invariant: "RECONCILE",
    severity: "page",
    key: `RECONCILE:${escrow}`,
    escrow,
    message: `projection differs from the contract at block ${block}: ${diff.join(", ")}`,
    details: Object.fromEntries(diff.map((k) => [k, `${p[k]} != ${c[k]}`])),
    response: RESPONSE.RECONCILE!,
  };
}

/** INV-6 and projection-divergence anomalies recorded by the reducer become pages. */
export function fromAnomaly(a: { id: string; escrow: string; code: string; message: string }): Breach {
  const inv = a.code === "INV-6" ? "INV-6" : "DIVERGENCE";
  return {
    invariant: inv,
    severity: "page",
    key: `ANOMALY:${a.id}`,
    escrow: a.escrow,
    message: `${a.code}: ${a.message}`,
    response: RESPONSE[inv]!,
  };
}
