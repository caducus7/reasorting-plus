import { onchainTable } from "ponder";

export const booking = onchainTable("booking", (t) => ({
  id: t.hex().primaryKey(), // bookingId
  guest: t.hex().notNull(),
  principal: t.bigint().notNull(),
  blockNumber: t.bigint().notNull(),
  eventId: t.text().notNull(),
}));
