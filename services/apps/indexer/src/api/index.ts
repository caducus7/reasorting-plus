// Read API (brief C6): served by Ponder's HTTP server from the projection. Consumers: C5 (booking
// status, refund if cancelled now, accrued yield), the owner digest (escrow summary), C8 (ledger at
// the finalized head, spec 10.2 "count funds as deployable: finalized").
import { Hono } from "hono";
import { and, eq, lte, sql } from "ponder";
import { db, publicClients } from "ponder:api";
import { balance, booking, escrow, journal } from "ponder:schema";
import { getAddress, isAddress, isHex } from "viem";
import { bookingView, bucketsOf, escrowSummary, json } from "../core/views.js";
import { naturalDelta } from "../core/accounts.js";
import type { BookingRow, BookingStatus, EscrowRow, Outcome } from "../core/types.js";

const app = new Hono();
const client = publicClients.chain;

// Chain time for derived state (DELIVERED, refund tier). One read per second at most.
let clock: { at: number; ts: bigint; number: bigint } | null = null;
async function chainNow() {
  if (!clock || Date.now() - clock.at > 1_000) {
    const b = await client.getBlock({ blockTag: "latest" });
    clock = { at: Date.now(), ts: b.timestamp, number: b.number! };
  }
  return clock;
}

const send = (c: { body: (s: string, status: number, h: Record<string, string>) => Response }, v: unknown, status = 200) =>
  c.body(json(v), status, { "content-type": "application/json" });

async function balances(e: string) {
  const rows = await db.select().from(balance).where(eq(balance.escrow, e as `0x${string}`));
  return new Map(rows.map((r) => [r.account, r.amount]));
}

const asBooking = (r: typeof booking.$inferSelect): BookingRow =>
  ({ ...r, status: r.status as BookingStatus, frozenFrom: r.frozenFrom as BookingStatus | null, outcome: r.outcome as Outcome | null }) as BookingRow;

app.get("/v1/indexer/bookings/:escrow/:bookingId", async (c) => {
  const e = c.req.param("escrow");
  const id = c.req.param("bookingId");
  if (!isAddress(e) || !isHex(id) || id.length !== 66) return send(c, { error: "bad_request" }, 400);
  const addr = getAddress(e).toLowerCase() as `0x${string}`;
  const [b] = await db.select().from(booking).where(eq(booking.id, `${addr}:${id.toLowerCase()}`));
  const [er] = await db.select().from(escrow).where(eq(escrow.id, addr));
  if (!b || !er) return send(c, { error: "not_found" }, 404);
  const [now, bal] = await Promise.all([chainNow(), balances(addr)]);
  const view = bookingView(asBooking(b), er as EscrowRow, now.ts, bucketsOf(bal, b.guest, er.payoutAddress));
  return send(c, { ...view, asOf: { block: now.number, timestamp: now.ts } });
});

app.get("/v1/indexer/escrows/:escrow/summary", async (c) => {
  const e = c.req.param("escrow");
  if (!isAddress(e)) return send(c, { error: "bad_request" }, 400);
  const addr = getAddress(e).toLowerCase() as `0x${string}`;
  const [er] = await db.select().from(escrow).where(eq(escrow.id, addr));
  if (!er) return send(c, { error: "not_found" }, 404);
  const head = c.req.query("head") ?? "latest";
  if (!["latest", "safe", "finalized"].includes(head)) return send(c, { error: "bad_request" }, 400);
  const now = await chainNow();
  let bal: Map<string, bigint>;
  let at = now.number;
  if (head === "latest") {
    bal = await balances(addr);
  } else {
    // Balances as of the tag: journal up to that block (entries are immutable facts per block).
    at = (await client.getBlock({ blockTag: head as "safe" | "finalized" })).number!;
    const rows = await db
      .select({ account: journal.account, amount: sql<string>`sum(${journal.amount})` })
      .from(journal)
      .where(and(eq(journal.escrow, addr), lte(journal.blockNumber, at)))
      .groupBy(journal.account);
    bal = new Map(rows.map((r) => [r.account, naturalDelta(r.account, BigInt(r.amount))]));
  }
  const bs = (await db.select().from(booking).where(eq(booking.escrow, addr))).map(asBooking);
  return send(c, { ...escrowSummary(er as EscrowRow, bal, bs, now.ts), head, asOf: { block: at, timestamp: now.ts } });
});

app.get("/v1/indexer/escrows/:escrow/accounts/:account", async (c) => {
  const e = c.req.param("escrow");
  const a = c.req.param("account");
  if (!isAddress(e) || !isAddress(a)) return send(c, { error: "bad_request" }, 400);
  const addr = getAddress(e).toLowerCase() as `0x${string}`;
  const [er] = await db.select().from(escrow).where(eq(escrow.id, addr));
  if (!er) return send(c, { error: "not_found" }, 404);
  return send(c, bucketsOf(await balances(addr), a, er.payoutAddress));
});

export default app;
