// C5 brief tests 1, 3, 4 and the E2E acceptance test, against the real C1 contracts on Anvil.
// Run: pnpm --filter @chain/quote-service test:anvil  (needs anvil + forge on PATH and Postgres).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fc from "fast-check";
import { BaseError, decodeErrorResult, decodeEventLog, parseEventLogs, toHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { exportSPKI, generateKeyPair } from "jose";
import { escrowAbi } from "@chain/abi";
import { bookingYield, refundBpsAt, settlementFigures, v1, validCurve, type Cutoff } from "@chain/shared";
import { bookingIdOf, quoteTypedData } from "@chain/shared/eip712";
import { createApp } from "../../src/app.js";
import { jwtAuth } from "../../src/auth.js";
import { escrowReader } from "../../src/chain.js";
import { pgCalendar } from "../../src/db.js";
import { chainReadModel } from "../../src/readModel.js";
import { localSigner } from "../../src/signer.js";
import { freshDb } from "../pgtest.js";
import { VILLA } from "../fixtures.js";
import { batchWalletAbi, KEYS, mockUsdcAbi, startAnvil, type Anvil } from "./harness.js";

const GENESIS = Date.parse("2026-04-01T09:00:00Z") / 1000;
const DAY = 86_400;
const GRACE = 72 * 3_600;
const FEE_CHANGE_DELAY = 7 * DAY;

let a: Anvil;
let escrow: Address;
const signer = localSigner(KEYS.signer, "test");
const guest = privateKeyToAccount(KEYS.guest).address;

beforeAll(async () => {
  a = await startAnvil(GENESIS);
  escrow = a.dep.escrow;
});
afterAll(() => a?.stop());

type QuoteArgs = {
  checkInUtc: number;
  checkOutUtc: number;
  priceAtomic: bigint;
  feeBps: number;
  guestYieldBps: number;
  cutoffs: Cutoff[];
  finalBps: number;
  expiresAt: number;
  guest?: Address;
};

function makeQuote(q: QuoteArgs): v1.Quote {
  return {
    resourceId: VILLA.resourceId,
    checkInUtc: q.checkInUtc,
    checkOutUtc: q.checkOutUtc,
    priceAtomic: q.priceAtomic.toString(),
    feeBps: q.feeBps,
    guestYieldBps: q.guestYieldBps,
    policyHash: `0x${"11".repeat(32)}`,
    cutoffs: q.cutoffs,
    finalBps: q.finalBps,
    guest: q.guest ?? guest,
    expiresAt: q.expiresAt,
    salt: toHex(crypto.getRandomValues(new Uint8Array(32))),
  };
}

const sign = (q: v1.Quote) => signer.signTypedData(quoteTypedData(q, a.dep.chainId, escrow) as never);
const message = (q: v1.Quote) => quoteTypedData(q, a.dep.chainId, escrow).message;

async function fundGuest(amount: bigint) {
  await a.send(KEYS.admin, { address: a.dep.usdc, abi: mockUsdcAbi, functionName: "mint", args: [guest, amount] });
  await a.send(KEYS.guest, { address: a.dep.usdc, abi: mockUsdcAbi, functionName: "approve", args: [escrow, amount] });
}

async function deposit(q: v1.Quote, sig: Hex) {
  return a.send(KEYS.guest, { address: escrow, abi: escrowAbi, functionName: "deposit", args: [message(q), sig] });
}

async function revertName(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    // Find the raw revert data anywhere in viem's error chain and decode it against the escrow ABI.
    let data: Hex | undefined;
    if (e instanceof BaseError) {
      e.walk((x) => {
        const d = (x as { data?: unknown }).data;
        if (typeof d === "string" && d.startsWith("0x") && d.length >= 10) data = d as Hex;
        else if (d && typeof d === "object" && "errorName" in d) data = undefined;
        return false;
      });
    }
    if (!data) throw e;
    return decodeErrorResult({ abi: escrowAbi, data }).errorName;
  }
  throw new Error("did not revert");
}

const read = <T>(functionName: string, args: unknown[] = [], blockNumber?: bigint) =>
  a.client.readContract({ address: escrow, abi: escrowAbi, functionName: functionName as never, args: args as never, blockNumber }) as Promise<T>;

// ------------------------------------------------------------------ 4. signature

describe("signature (brief test 4)", () => {
  it("a service-signed quote is accepted; each tampered field is rejected", async () => {
    const t = await a.now();
    const base: QuoteArgs = {
      checkInUtc: t + 30 * DAY,
      checkOutUtc: t + 33 * DAY,
      priceAtomic: 900_000_000n,
      feeBps: await read<number>("effectiveFeeBps"),
      guestYieldBps: await read<number>("guestYieldBps"),
      cutoffs: [{ cutoffUtc: t + 10 * DAY, refundBps: 10_000 }],
      finalBps: 0,
      expiresAt: t + 900,
    };
    const q = makeQuote(base);
    const sig = await sign(q);
    expect(await read<Hex>("hashQuote", [message(q)])).toBe(bookingIdOf(q));
    await fundGuest(10_000_000_000n);

    const tampered: [string, v1.Quote][] = [
      ["price", { ...q, priceAtomic: "899000000" }],
      ["checkOut", { ...q, checkOutUtc: q.checkOutUtc + 3_600 }],
      ["cutoff", { ...q, cutoffs: [{ cutoffUtc: q.cutoffs[0]!.cutoffUtc + 1, refundBps: 10_000 }] }],
      ["refundBps", { ...q, cutoffs: [{ cutoffUtc: q.cutoffs[0]!.cutoffUtc, refundBps: 9_999 }] }],
      ["finalBps", { ...q, finalBps: 1 }],
      ["policyHash", { ...q, policyHash: `0x${"12".repeat(32)}` }],
      ["resourceId", { ...q, resourceId: `0x${"45".repeat(32)}` }],
      ["salt", { ...q, salt: `0x${"00".repeat(32)}` }],
      ["expiresAt", { ...q, expiresAt: q.expiresAt + 1 }],
    ];
    for (const [field, bad] of tampered) {
      expect([field, await revertName(deposit(bad, sig))]).toEqual([field, "InvalidQuoteSignature"]);
    }
    // A signature from any other key is rejected.
    const forged = await localSigner(KEYS.owner, "test").signTypedData(quoteTypedData(q, a.dep.chainId, escrow) as never);
    expect(await revertName(deposit(q, forged))).toBe("InvalidQuoteSignature");
    // The same quote signed for another chain id is rejected (domain separation).
    const otherChain = await signer.signTypedData(quoteTypedData(q, 8453, escrow) as never);
    expect(await revertName(deposit(q, otherChain))).toBe("InvalidQuoteSignature");

    const r = await deposit(q, sig);
    expect(r.status).toBe("success");
    const b = await read<{ principalAtomic: bigint; guest: Address; feeBps: number }>("getBooking", [bookingIdOf(q)]);
    expect([b.principalAtomic, b.guest, b.feeBps]).toEqual([900_000_000n, guest, q.feeBps]);
  });
});

// ------------------------------------------------------------------ 1. differential

describe("differential: TS reference evaluator vs contract (brief test 1)", () => {
  const scenario = fc.record({
    feeBps: fc.integer({ min: 0, max: 2_000 }), // approveOwner maxFeeBps = 2000 in DeployLocal
    guestYieldBps: fc.integer({ min: 0, max: 10_000 }),
    leadDays: fc.integer({ min: 2, max: 60 }),
    nights: fc.integer({ min: 1, max: 14 }),
    shortBy: fc.integer({ min: 0, max: 3_599 }), // check-out earlier than whole nights
    extra: fc.bigInt({ min: 0n, max: 5_000_000_000n }),
    curve: fc.array(fc.tuple(fc.double({ min: 0, max: 1, noNaN: true }), fc.integer({ min: 0, max: 10_000 })), {
      minLength: 1,
      maxLength: 4,
    }),
    finalBps: fc.integer({ min: 0, max: 10_000 }),
    donation: fc.bigInt({ min: 0n, max: 2_000_000_000n }),
    action: fc.oneof(
      fc.record({ kind: fc.constant("cancel" as const), at: fc.double({ min: 0, max: 1, noNaN: true }) }),
      fc.record({ kind: fc.constant("settle" as const), at: fc.integer({ min: 0, max: 10 * DAY }) }),
    ),
  });

  it("identical refund, fee, owner and yield figures for random quotes and cancellation times", async () => {
    // The run must actually reach the interesting cases, not just pass vacuously.
    const seen = { cancel: 0, settle: 0, yieldPositive: 0, partialRefund: 0, feePositive: 0 };
    await fc.assert(
      fc.asyncProperty(scenario, async (s) => {
        const snap = await a.test.snapshot();
        try {
          if ((await read<number>("effectiveFeeBps")) !== s.feeBps) {
            await a.send(KEYS.admin, { address: escrow, abi: escrowAbi, functionName: "proposeFeeBps", args: [s.feeBps] });
            await a.mineAt((await a.now()) + FEE_CHANGE_DELAY + 1);
          }
          await a.send(KEYS.owner, { address: escrow, abi: escrowAbi, functionName: "setGuestYieldBps", args: [s.guestYieldBps] });
          const t0 = await a.now();
          const checkInUtc = t0 + s.leadDays * DAY;
          const checkOutUtc = checkInUtc + s.nights * DAY - s.shortBy;
          // Strictly increasing cutoffs in (t0 + 100, checkIn), refund non-increasing.
          const span = checkInUtc - (t0 + 100);
          const times = [...new Set(s.curve.map(([f]) => t0 + 100 + Math.floor(f * (span - 1))))].sort((x, y) => x - y);
          const bpsSorted = s.curve.map(([, b]) => b).sort((x, y) => y - x);
          const cutoffs = times.map((cutoffUtc, i) => ({ cutoffUtc, refundBps: bpsSorted[i]! }));
          const finalBps = Math.min(s.finalBps, cutoffs.at(-1)!.refundBps); // curve is non-increasing
          expect(validCurve(cutoffs, finalBps, checkInUtc)).toBe(true);
          const minNightly = await read<bigint>("minNightlyAtomic");
          const q = makeQuote({
            checkInUtc,
            checkOutUtc,
            priceAtomic: minNightly * BigInt(s.nights) + s.extra,
            feeBps: s.feeBps,
            guestYieldBps: s.guestYieldBps,
            cutoffs,
            finalBps,
            expiresAt: t0 + 900,
          });
          await fundGuest(BigInt(q.priceAtomic));
          await deposit(q, await sign(q));
          const id = bookingIdOf(q);
          const accAtDeposit = (await read<{ accAtDeposit: bigint }>("getBooking", [id])).accAtDeposit;
          if (s.donation > 0n) {
            await a.send(KEYS.admin, { address: a.dep.usdc, abi: mockUsdcAbi, functionName: "mint", args: [escrow, s.donation] });
          }

          let when: number;
          let receipt;
          if (s.action.kind === "cancel") {
            const from = (await a.now()) + 1;
            when = from + Math.floor(s.action.at * (checkOutUtc - 1 - from));
            await a.at(when);
            receipt = await a.send(KEYS.guest, { address: escrow, abi: escrowAbi, functionName: "cancelByGuest", args: [id] });
          } else {
            when = checkOutUtc + GRACE + s.action.at;
            await a.at(when);
            receipt = await a.send(KEYS.relayer, { address: escrow, abi: escrowAbi, functionName: "settle", args: [id] });
          }
          const [ev] = parseEventLogs({ abi: escrowAbi, logs: receipt.logs, eventName: "BookingSettled" });
          const got = ev!.args as unknown as {
            refund: bigint; ownerPrincipal: bigint; fee: bigint; y: bigint; guestYield: bigint; ownerYield: bigint;
          };
          const bps = s.action.kind === "cancel" ? refundBpsAt({ ...q, cutoffs }, when)! : 0;
          if (s.action.kind === "cancel") {
            const [c] = parseEventLogs({ abi: escrowAbi, logs: receipt.logs, eventName: "BookingCancelled" });
            expect(Number(c!.args.refundBps)).toBe(bps);
          }
          const acc = await read<bigint>("accYieldPerUnit", [], receipt.blockNumber);
          expect(got.y).toBe(bookingYield(BigInt(q.priceAtomic), acc, accAtDeposit));
          const want = settlementFigures(BigInt(q.priceAtomic), bps, s.feeBps, got.y, s.guestYieldBps, s.action.kind === "settle");
          expect({ ...got, y: undefined }).toMatchObject({ ...want });
          expect(got.refund + got.ownerPrincipal + got.fee).toBe(BigInt(q.priceAtomic));
          seen[s.action.kind]++;
          if (got.y > 0n) seen.yieldPositive++;
          if (bps > 0 && bps < 10_000) seen.partialRefund++;
          if (got.fee > 0n) seen.feePositive++;
        } finally {
          await a.test.revert({ id: snap });
        }
      }),
      { numRuns: Number(process.env.DIFF_RUNS ?? 40), seed: process.env.DIFF_SEED ? Number(process.env.DIFF_SEED) : undefined },
    );
    console.log("differential coverage", seen);
    for (const [k, n] of Object.entries(seen)) expect([k, n > 0]).toEqual([k, true]);
  });
});

// ------------------------------------------------------------------ service on Anvil: 3 + E2E

describe("quote service against the deployed escrow", () => {
  let pg: Awaited<ReturnType<typeof freshDb>>;
  let clock = 0;
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    pg = await freshDb();
    const kp = await generateKeyPair("ES256");
    app = createApp({
      db: pg.db,
      calendar: pgCalendar(pg.db),
      chain: escrowReader(a.client, escrow),
      signer,
      bookings: chainReadModel(a.client, escrow, 0n),
      auth: await jwtAuth({ issuer: "checkout", audience: "booking-api", publicKeyPem: await exportSPKI(kp.publicKey) }),
      properties: [VILLA],
      settings: {
        chainId: a.dep.chainId,
        escrow,
        usdc: a.dep.usdc,
        offerLockSec: 1_500,
        quoteTtlSec: 900,
        feedMaxAgeSec: 900,
      holdGraceSec: 600,
      maxClockSkewSec: 120,
        apyEstimateBps: 400,
        yieldProtocol: "mock",
      },
      now: () => new Date(clock * 1000),
    });
  });
  afterAll(async () => pg?.drop());

  const post = (path: string, body: unknown) =>
    app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  async function offerAndPrepare(checkIn: string, checkOut: string, guestAddress: Address) {
    clock = await a.now();
    const o = await post("/v1/offers", { resourceId: VILLA.resourceId, checkIn, checkOut, guests: 2, locale: "en" });
    expect(o.status).toBe(200);
    const { offerId } = v1.OfferResponse.parse(await o.json());
    const p = await post(`/v1/offers/${offerId}/prepare`, { guestAddress, email: "g@example.com" });
    return p;
  }

  it("E2E: offer, prepare, submit calls from a smart wallet; the booking exists with the quoted terms", async () => {
    const wallet = a.dep.batchWallet;
    const p = await offerAndPrepare("2026-08-10", "2026-08-14", wallet);
    expect(p.status).toBe(200);
    const r = v1.PrepareResponse.parse(await p.json());
    await a.send(KEYS.admin, { address: a.dep.usdc, abi: mockUsdcAbi, functionName: "mint", args: [wallet, BigInt(r.quote.priceAtomic)] });
    // Anyone may trigger the test wallet; the escrow only sees msg.sender == wallet == quote.guest.
    await a.send(KEYS.relayer, {
      address: wallet,
      abi: batchWalletAbi,
      functionName: "execute",
      args: [r.calls.map((c) => ({ to: c.to as Address, data: c.data as Hex }))],
    });
    const b = await read<{
      guest: Address; checkInUtc: number; checkOutUtc: number; feeBps: number; guestYieldBps: number; finalBps: number;
      resourceId: Hex; principalAtomic: bigint; policyHash: Hex; state: number;
    }>("getBooking", [r.bookingId]);
    expect(b).toMatchObject({
      guest: wallet,
      checkInUtc: Date.parse("2026-08-10T12:00:00Z") / 1000, // 15:00 EEST
      checkOutUtc: Date.parse("2026-08-14T08:00:00Z") / 1000, // 11:00 EEST
      feeBps: await read<number>("effectiveFeeBps"),
      guestYieldBps: await read<number>("guestYieldBps"),
      finalBps: 0,
      resourceId: VILLA.resourceId,
      principalAtomic: 3_200_000_000n,
      state: 1,
    });
    expect(await read<{ cutoffUtc: number; refundBps: number }[]>("getCutoffs", [r.bookingId])).toEqual(r.quote.cutoffs);
    const view = await chainReadModel(a.client, escrow, 0n).getBooking(r.bookingId as Hex);
    expect(view).toMatchObject({ state: "ESCROWED", principalAtomic: 3_200_000_000n, guest: wallet });
    // The logged deposit carries the whole ledger row (CLAUDE.md money rule 7).
    const logs = await a.client.getLogs({ address: escrow, fromBlock: 0n });
    const dep = logs
      .map((l) => { try { return decodeEventLog({ abi: escrowAbi, ...l }); } catch { return null; } })
      .find((e) => e?.eventName === "BookingDeposited" && (e.args as { bookingId: Hex }).bookingId === r.bookingId);
    expect(dep).toBeTruthy();
  });

  it("fee straddle (brief test 3): no quote outlives pendingFeeAt; a pre-change quote reverts after the change", async () => {
    const oldFee = await read<number>("effectiveFeeBps");
    const newFee = oldFee === 1_000 ? 900 : 1_000;
    await a.send(KEYS.admin, { address: escrow, abi: escrowAbi, functionName: "proposeFeeBps", args: [newFee] });
    const pendingFeeAt = Number(await read<bigint>("pendingFeeAt"));

    // Right up to the last minute before the change, issued quotes stop at pendingFeeAt - 60.
    await a.mineAt(pendingFeeAt - 300);
    const p = await offerAndPrepare("2026-09-20", "2026-09-23", guest);
    const r = v1.PrepareResponse.parse(await p.json());
    expect(r.quote.feeBps).toBe(oldFee);
    expect(r.quote.expiresAt).toBe(pendingFeeAt - 60);
    expect(r.quote.expiresAt).toBeLessThan(pendingFeeAt);

    await a.mineAt(pendingFeeAt - 30);
    const late = await offerAndPrepare("2026-09-25", "2026-09-27", guest);
    expect([late.status, await late.json()]).toEqual([409, { error: "terms_changed" }]);

    // After the change the service's quote cannot be used (expired first), and a pre-change quote
    // that an uncapped signer might have issued is rejected by the fee check.
    await fundGuest(10_000_000_000n);
    await a.at(pendingFeeAt + 1);
    expect(await revertName(deposit(r.quote, r.quoteSig as Hex))).toBe("QuoteExpired");
    const t = pendingFeeAt + 2;
    const uncapped = makeQuote({
      checkInUtc: t + 20 * DAY,
      checkOutUtc: t + 22 * DAY,
      priceAtomic: 500_000_000n,
      feeBps: oldFee,
      guestYieldBps: await read<number>("guestYieldBps"),
      cutoffs: [{ cutoffUtc: t + 5 * DAY, refundBps: 10_000 }],
      finalBps: 0,
      expiresAt: t + 900,
    });
    await a.at(t);
    expect(await revertName(deposit(uncapped, await sign(uncapped)))).toBe("FeeMismatch");

    // And the service now quotes the new fee with a full TTL.
    await a.mineAt(t + 10);
    const fresh = v1.PrepareResponse.parse(await (await offerAndPrepare("2026-10-01", "2026-10-03", guest)).json());
    expect([fresh.quote.feeBps, fresh.quote.expiresAt - clock]).toEqual([newFee, 900]);
  });
});
