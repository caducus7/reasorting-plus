import { ponder } from "ponder:registry";
import { booking } from "ponder:schema";

ponder.on("Escrow:BookingDeposited", async ({ event, context }) => {
  await context.db.insert(booking).values({
    id: event.args.bookingId,
    guest: event.args.guest,
    principal: event.args.principalAtomic,
    blockNumber: event.block.number,
    eventId: event.id,
  });
});
