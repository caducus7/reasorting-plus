import { Property } from "../src/property.js";

export const VILLA: Property = Property.parse({
  resourceId: `0x${"44".repeat(32)}`,
  name: "Villa (Crete)",
  tz: "Europe/Athens",
  maxGuests: 8,
  checkInTime: "15:00",
  checkOutTime: "11:00",
  nightlyAtomic: "800000000",
  policy: {
    id: "pol_standard_v1",
    rendered: "Full refund until 18:00 30 days before arrival; 50% until 14 days; 25% until 7 days.",
    rules: [
      { daysBefore: 30, time: "18:00", refundBps: 10_000 },
      { daysBefore: 14, time: "18:00", refundBps: 5_000 },
      { daysBefore: 7, time: "18:00", refundBps: 2_500 },
    ],
    finalBps: 0,
  },
});
