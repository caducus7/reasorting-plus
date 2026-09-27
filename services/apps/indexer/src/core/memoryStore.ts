import type { Address, Hex } from "viem";
import { naturalDelta, type Leg } from "./accounts.js";
import { eventKey, type BookingRow, type ChainEvent, type EscrowRow, type JournalRow, type Store } from "./types.js";

const bk = (escrow: string, id: string) => `${escrow.toLowerCase()}:${id.toLowerCase()}`;

/** In-memory projection store: tests and the replay diff's reference build. */
export class MemoryStore implements Store {
  private readonly seenKeys = new Set<string>();
  private readonly escrows = new Map<string, EscrowRow>();
  private readonly bookings = new Map<string, BookingRow>();
  private readonly bal = new Map<string, Map<string, bigint>>();
  readonly journal: JournalRow[] = [];

  async seen(key: string) {
    return this.seenKeys.has(key);
  }
  async markSeen(key: string) {
    this.seenKeys.add(key);
  }
  async getEscrow(escrow: Address) {
    const r = this.escrows.get(escrow.toLowerCase());
    return r && structuredClone(r);
  }
  async putEscrow(row: EscrowRow) {
    this.escrows.set(row.id.toLowerCase(), structuredClone(row));
  }
  async getBooking(escrow: Address, bookingId: Hex) {
    const r = this.bookings.get(bk(escrow, bookingId));
    return r && structuredClone(r);
  }
  async putBooking(row: BookingRow) {
    this.bookings.set(row.id, structuredClone(row));
  }
  async balance(escrow: Address, account: string) {
    return this.bal.get(escrow.toLowerCase())?.get(account) ?? 0n;
  }
  async post(escrow: Address, ev: ChainEvent, key: string, legs: Leg[]) {
    const m = this.bal.get(escrow.toLowerCase()) ?? new Map<string, bigint>();
    this.bal.set(escrow.toLowerCase(), m);
    legs.forEach((l, i) => {
      m.set(l.account, (m.get(l.account) ?? 0n) + naturalDelta(l.account, l.amount));
      this.journal.push({
        id: `${key}:${i}`,
        escrow,
        eventKey: key,
        eventName: ev.name,
        blockNumber: ev.blockNumber,
        timestamp: ev.timestamp,
        account: l.account,
        amount: l.amount,
      });
    });
  }

  /** Current balances of one escrow, zero balances omitted. */
  balances(escrow: Address): [string, bigint][] {
    return [...(this.bal.get(escrow.toLowerCase()) ?? new Map()).entries()].filter(([, v]) => v !== 0n);
  }
  bookingRows(): BookingRow[] {
    return [...this.bookings.values()];
  }
  escrowRows(): EscrowRow[] {
    return [...this.escrows.values()];
  }

  /** A deterministic, comparable image of everything replay produces. */
  dump() {
    const sort = <T>(xs: [string, T][]) => xs.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return {
      escrows: sort([...this.escrows.entries()]),
      bookings: sort([...this.bookings.entries()]),
      balances: sort([...this.bal.entries()].map(([k, m]) => [k, sort([...m.entries()].filter(([, v]) => v !== 0n))])),
      journal: [...this.journal].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    };
  }
}

export { eventKey };
