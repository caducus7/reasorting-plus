// A mixed booking history on Anvil for the acceptance run (brief C6: at least 50 mixed bookings,
// cancels, disputes and settlements): guest and property cancellations at different refund tiers,
// freezes, disputes resolved by the arbitrator and by default, delivered settlements, yield from
// donations, a fee change and a guest-yield change, and claims by every party.
import { keccak256, toHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { escrowAbi } from "@chain/abi";
import { book, KEYS, mockUsdcAbi, type Anvil } from "./harness.js";

const DAY = 86_400;
const GRACE = 72 * 3_600;
const DISPUTE_WINDOW = 14 * DAY;

export type Booked = Awaited<ReturnType<typeof book>> & { key: Hex; checkIn: number; nights: number };

export async function runScenario(a: Anvil) {
  const escrow = a.dep.escrow;
  const call = (key: Hex, functionName: string, args: unknown[] = []) => a.send(key, { address: escrow, abi: escrowAbi, functionName, args });
  const guests = Array.from({ length: 8 }, (_, i) => keccak256(toHex(`c6-guest-${i}`)) as Hex);
  let seed = 7;
  const rnd = (n: number) => (seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) % n;
  const warpTo = async (t: number) => {
    await a.test.setNextBlockTimestamp({ timestamp: BigInt(t) });
    await a.test.mine({ blocks: 1 });
  };
  const counts = { bookings: 0, guestCancels: 0, propertyCancels: 0, disputes: 0, resolved: 0, defaulted: 0, settled: 0, frozen: 0, claims: 0 };
  for (const k of guests) await a.test.setBalance({ address: privateKeyToAccount(k).address, value: 10n ** 20n });
  const T0 = await a.now();

  // 1. Sixty bookings, check-in 8 to 25 days out, 1 to 4 nights; tiers 100% until -7d, 50% until -2d.
  const all: Booked[] = [];
  const bookOne = async (checkIn: number, fixedNights?: number) => {
    const key = guests[rnd(guests.length)]!;
    const nights = fixedNights ?? 1 + rnd(4);
    const b = await book(a, {
      guestKey: key,
      checkInUtc: checkIn,
      nights,
      priceAtomic: BigInt(nights) * 150_000_000n,
      cutoffs: [
        { cutoffUtc: checkIn - 7 * DAY, refundBps: 10_000 },
        { cutoffUtc: checkIn - 2 * DAY, refundBps: 5_000 },
      ],
      finalBps: 0,
    });
    counts.bookings++;
    const r = { ...b, key, checkIn, nights };
    all.push(r);
    return r;
  };
  for (let i = 0; i < 52; i++) await bookOne(T0 + 8 * DAY + rnd(17 * DAY));
  // Eight stays ending on day 28, so their GRACE is still open on day 30: the dispute candidates.
  const candidates: Booked[] = [];
  for (let i = 0; i < 8; i++) candidates.push(await bookOne(T0 + 26 * DAY + i * 600, 2));
  const reserved = new Set(candidates.map((b) => b.bookingId));
  const open = new Set(all.map((b) => b.bookingId));

  // 2. Day 1: twelve guest cancellations at 100%, five property cancellations.
  await warpTo(T0 + DAY);
  for (const b of all.slice(0, 12)) {
    await call(b.key, "cancelByGuest", [b.bookingId]);
    open.delete(b.bookingId);
    counts.guestCancels++;
  }
  for (const b of all.slice(12, 17)) {
    await call(KEYS.owner, "cancelByProperty", [b.bookingId]);
    open.delete(b.bookingId);
    counts.propertyCancels++;
  }

  // 3. Yield: a donation is booked as a gain on the next accruing call (the reserve funding).
  await a.send(KEYS.admin, { address: a.dep.usdc, abi: mockUsdcAbi, functionName: "mint", args: [escrow, 37_123_457n] });
  await a.send(KEYS.admin, { address: a.dep.usdc, abi: mockUsdcAbi, functionName: "mint", args: [privateKeyToAccount(KEYS.owner).address, 10_000_000n] });
  await a.send(KEYS.owner, { address: a.dep.usdc, abi: mockUsdcAbi, functionName: "approve", args: [escrow, 10_000_000n] });
  await call(KEYS.owner, "fundReserve", [5_000_000n]);

  // 4. Configuration: guest yield share now, a fee change after the 7-day timelock.
  await call(KEYS.owner, "setGuestYieldBps", [4_000]);
  await call(KEYS.admin, "proposeFeeBps", [600]);

  // 5. Day 10: guests cancel at whatever tier applies; guardian freezes three bookings.
  await warpTo(T0 + 10 * DAY);
  const rest = all.filter((b) => open.has(b.bookingId) && !reserved.has(b.bookingId));
  for (const b of rest.filter((x) => x.checkIn - (T0 + 10 * DAY) > 2 * DAY).slice(0, 8)) {
    await call(b.key, "cancelByGuest", [b.bookingId]);
    open.delete(b.bookingId);
    counts.guestCancels++;
  }
  const frozen = all.filter((b) => open.has(b.bookingId) && !reserved.has(b.bookingId)).slice(0, 3);
  for (const b of frozen) {
    await call(KEYS.guardian, "freezeBooking", [b.bookingId]);
    counts.frozen++;
  }
  await warpTo(T0 + 12 * DAY);
  for (const b of frozen.slice(0, 2)) await call(KEYS.guardian, "unfreezeBooking", [b.bookingId]);

  // 6. A second donation and five new bookings under the new fee and split.
  await a.send(KEYS.admin, { address: a.dep.usdc, abi: mockUsdcAbi, functionName: "mint", args: [escrow, 11_000_001n] });
  await warpTo(T0 + 30 * DAY);
  for (let i = 0; i < 5; i++) await bookOne(T0 + 40 * DAY + i * DAY);
  for (const b of all.slice(60)) open.add(b.bookingId);

  // 7. Day 30: every earlier stay has ended. Eight guests dispute within GRACE.
  // Frozen bookings run on a shifted clock (docs/adr/0015 §1): they are settled at the end.
  const frozenIds = new Set(frozen.map((b) => b.bookingId));
  const delivered = all.slice(0, 60).filter((b) => open.has(b.bookingId) && !frozenIds.has(b.bookingId));
  // Only stays whose GRACE has not run out can be disputed (spec 7): the reserved candidates.
  const disputed = candidates;
  const disputedIds = new Set(disputed.map((b) => b.bookingId));
  for (const [i, b] of disputed.entries()) {
    const price = BigInt(b.nights) * 150_000_000n;
    await call(b.key, "openDispute", [b.bookingId, (price * BigInt(1 + i)) / 9n, keccak256(toHex(`evidence-${i}`))]);
    open.delete(b.bookingId);
    counts.disputes++;
  }

  // 8. After GRACE: settle the other delivered stays; the arbitrator resolves five disputes.
  await warpTo(T0 + 30 * DAY + GRACE + 60);
  for (const b of delivered.filter((x) => !disputedIds.has(x.bookingId))) {
    await call(KEYS.relayer, "settle", [b.bookingId]);
    open.delete(b.bookingId);
    counts.settled++;
  }
  const bps = [0, 3_000, 10_000, 5_000, 2_500];
  const byArbitrator = Math.min(5, Math.ceil(disputed.length / 2));
  for (const [i, b] of disputed.slice(0, byArbitrator).entries()) {
    await call(KEYS.arbitrator, "resolve", [b.bookingId, bps[i]!, i]);
    counts.resolved++;
  }

  // 9. After the dispute window: the rest resolve by default; the last frozen booking is released.
  await warpTo(T0 + 30 * DAY + GRACE + DISPUTE_WINDOW + 120);
  for (const b of disputed.slice(byArbitrator)) {
    await call(KEYS.relayer, "resolveByDefault", [b.bookingId]);
    counts.defaulted++;
  }
  await call(KEYS.guardian, "unfreezeBooking", [frozen[2]!.bookingId]);
  await warpTo((await a.now()) + 30 * DAY); // past their shifted clocks (checkOut + GRACE + frozenTotal)
  for (const b of frozen) {
    await call(KEYS.relayer, "settle", [b.bookingId]);
    open.delete(b.bookingId);
    counts.settled++;
  }

  // 10. Claims by every guest, the fee recipient and the owner (payout address).
  for (const k of [...guests, KEYS.feeRecipient, KEYS.owner]) {
    await call(k, "claim");
    counts.claims++;
  }
  return { counts, all, openFuture: all.filter((b) => open.has(b.bookingId)) };
}
