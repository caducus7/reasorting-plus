// The reducer's Store on Ponder's reorg-aware tables (docs/adr/0014).
import type { Address, Hex } from "viem";
import type { Context } from "ponder:registry";
import { anomaly, balance, booking, escrow, journal, processedEvent } from "ponder:schema";
import { naturalDelta, type Leg } from "./core/accounts.js";
import type { Anomaly, BookingRow, BookingStatus, ChainEvent, EscrowRow, Outcome, Store } from "./core/types.js";

type Db = Context["db"];
const lc = (s: string) => s.toLowerCase();

export class PonderStore implements Store {
  constructor(private readonly db: Db) {}

  async seen(key: string) {
    return (await this.db.find(processedEvent, { id: key })) !== null;
  }

  async markSeen(key: string, ev: ChainEvent) {
    await this.db.insert(processedEvent).values({
      id: key,
      escrow: ev.address,
      name: ev.name,
      blockNumber: ev.blockNumber,
      blockHash: ev.blockHash,
      txHash: ev.txHash,
      logIndex: ev.logIndex,
      timestamp: ev.timestamp,
    });
  }

  async getEscrow(a: Address): Promise<EscrowRow | undefined> {
    const r = await this.db.find(escrow, { id: a });
    return r ? ({ ...r } as EscrowRow) : undefined;
  }

  async putEscrow(row: EscrowRow) {
    const { id, ...rest } = row;
    await this.db.insert(escrow).values(row).onConflictDoUpdate(rest);
  }

  async getBooking(e: Address, bookingId: Hex): Promise<BookingRow | undefined> {
    const r = await this.db.find(booking, { id: `${lc(e)}:${lc(bookingId)}` });
    if (!r) return undefined;
    return {
      ...r,
      status: r.status as BookingStatus,
      frozenFrom: r.frozenFrom as BookingStatus | null,
      outcome: r.outcome as Outcome | null,
    } as BookingRow;
  }

  async putBooking(row: BookingRow) {
    const { id, ...rest } = row;
    await this.db.insert(booking).values(row).onConflictDoUpdate(rest);
  }

  async balance(e: Address, account: string) {
    return (await this.db.find(balance, { id: `${lc(e)}:${account}` }))?.amount ?? 0n;
  }

  async post(e: Address, ev: ChainEvent, key: string, legs: Leg[]) {
    for (const [i, l] of legs.entries()) {
      const d = naturalDelta(l.account, l.amount);
      await this.db
        .insert(balance)
        .values({ id: `${lc(e)}:${l.account}`, escrow: e, account: l.account, amount: d })
        .onConflictDoUpdate((r) => ({ amount: r.amount + d }));
      await this.db.insert(journal).values({
        id: `${key}:${i}`,
        escrow: e,
        eventKey: key,
        eventName: ev.name,
        blockNumber: ev.blockNumber,
        timestamp: ev.timestamp,
        account: l.account,
        amount: l.amount,
      });
    }
  }

  async recordAnomalies(list: Anomaly[], blockNumber: bigint) {
    for (const [i, a] of list.entries()) {
      await this.db.insert(anomaly).values({ id: `${a.eventKey}:${i}`, ...a, blockNumber }).onConflictDoNothing();
    }
  }
}
