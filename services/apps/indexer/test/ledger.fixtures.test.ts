// Brief C6 test 3 (ledger balance): for fuzzed event sequences from the C9 handlers, every event's
// postings balance, the books identity holds after every event, and at each snapshot the ledger's
// totals and per-account buckets equal the contract's own accounting fields.
import { describe, expect, it } from "vitest";
import { MemoryStore } from "../src/core/memoryStore.js";
import { reduce, bootstrapEscrow } from "../src/core/reducer.js";
import { A, isAsset, sumPrefix } from "../src/core/accounts.js";
import { FIELDS, loadTapes, type Field } from "./fixtures.js";

const tapes = loadTapes();

async function projected(store: MemoryStore, escrow: `0x${string}`): Promise<Record<Field, bigint>> {
  const b = (acct: string) => store.balance(escrow, acct);
  const e = (await store.getEscrow(escrow))!;
  return {
    totalOpenPrincipal: await b(A.openPrincipal),
    totalDisputed: await b(A.disputed),
    totalPendingYield: sumPrefix(store.balances(escrow), "pending:"),
    totalClaimable: sumPrefix(store.balances(escrow), "claimable:"),
    reserve: await b(A.reserve),
    lossDebt: await b(A.lossDebt),
    accYieldPerUnit: e.accYieldPerUnit,
    lastAssets: (await b(A.idle)) + (await b(A.deployed)),
    yieldUnallocated: await b(A.yieldUnallocated),
    ownerClaimable: await b(A.ownerClaimable),
    pendingOwnerYield: await b(A.pendingOwner),
    shortfallSince: e.shortfallSince,
  };
}

describe("ledger projection vs the contract's accounting (C9 tapes)", () => {
  it("has tapes to check", () => {
    expect(tapes.length).toBeGreaterThanOrEqual(10);
    const names = new Set(tapes.flatMap((t) => t.events.map((e) => e.name)));
    for (const n of [
      "BookingDeposited", "BookingSettled", "BookingCancelled", "DisputeOpened", "DisputeResolved",
      "Claimed", "YieldAccrued", "YieldDeferred", "PendingYieldReleased", "LossRecognised",
      "LossRepaid", "LossToppedUp", "ReserveFunded", "ReserveWithdrawn", "Deployed", "Redeemed",
      "ShortfallObserved", "ShortfallCleared", "BookingFrozen", "BookingUnfrozen",
    ]) expect(names, n).toContain(n);
  });

  for (const tape of tapes) {
    it(`${tape.name}: balanced postings, books identity, and fields equal at every snapshot`, async () => {
      const store = new MemoryStore();
      await bootstrapEscrow(store, { chainId: 31337, escrow: tape.escrow, vault: tape.vault });
      let snap = 0;
      for (let i = 0; i <= tape.events.length; i++) {
        while (snap < tape.snapshots.length && tape.snapshots[snap]!.at === i) {
          const s = tape.snapshots[snap]!;
          const p = await projected(store, tape.escrow);
          for (const f of FIELDS) expect(p[f], `${f} at snapshot ${snap} (event ${i})`).toBe(s.fields[f]);
          for (const [k, a] of tape.accounts.entries()) {
            expect(await store.balance(tape.escrow, A.guestClaimable(a)), `guestClaimable ${a}`).toBe(s.guestClaimable[k]);
            expect(await store.balance(tape.escrow, A.feeClaimable(a)), `feeClaimable ${a}`).toBe(s.feeClaimable[k]);
            expect(await store.balance(tape.escrow, A.pendingGuest(a)), `pendingGuestYield ${a}`).toBe(s.pendingGuestYield[k]);
          }
          snap++;
        }
        if (i === tape.events.length) break;
        const r = await reduce(store, tape.events[i]!);
        expect(r.anomalies, `anomalies at event ${i} ${tape.events[i]!.name}`).toEqual([]);
        expect(r.legs.reduce((s, l) => s + l.amount, 0n), `unbalanced ${tape.events[i]!.name}`).toBe(0n);
        // Books identity (LedgerLib): assets + lossDebt == every liability account.
        let assets = 0n;
        let liabilities = 0n;
        for (const [acct, bal] of store.balances(tape.escrow)) {
          if (isAsset(acct)) assets += bal;
          else liabilities += bal;
          // idle/deployed are a book split (valuation lands on deployed, as the contract cannot tell a
          // donation from vault growth either); every other account is a non-negative balance.
          if (acct !== A.idle && acct !== A.deployed) {
            expect(bal >= 0n, `${acct} negative after ${tape.events[i]!.name}`).toBe(true);
          }
        }
        expect(assets, `books identity after ${tape.events[i]!.name}`).toBe(liabilities);
      }
      expect(snap).toBe(tape.snapshots.length);
    });
  }
});
