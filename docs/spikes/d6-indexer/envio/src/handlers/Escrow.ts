import { indexer } from "envio";

indexer.onEvent({ contract: "Escrow", event: "BookingDeposited" }, async ({ event, context }) => {
  context.Booking.set({
    id: event.params.bookingId,
    guest: event.params.guest,
    principal: event.params.principalAtomic,
    blockNumber: event.block.number,
    eventKey: `${event.chainId}-${event.transaction.hash}-${event.logIndex}`,
  });
});
