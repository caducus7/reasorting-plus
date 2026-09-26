import { vi } from "vitest";
import { createApp } from "../src/app.js";
import { PROPERTY } from "../src/fixtures.js";

/** Fixed clock for deterministic fixtures. */
export const NOW = new Date("2026-09-26T12:00:00Z");

export const GUEST = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"; // Anvil account 1
export const BOOKING_ID = `0x${"ab".repeat(32)}`;
export const AUTH = { authorization: `Bearer stub-guest:${BOOKING_ID}` };

export function makeApp(now: Date = NOW) {
  const delay = vi.fn(async (_ms: number) => {});
  const app = createApp({ now: () => now, delay });
  return { app, delay };
}

type Req = { method?: string; headers?: Record<string, string>; body?: unknown; scenario?: string };

export async function call(app: ReturnType<typeof makeApp>["app"], path: string, r: Req = {}) {
  const headers: Record<string, string> = { ...(r.headers ?? {}) };
  if (r.scenario !== undefined) headers["x-stub-scenario"] = r.scenario;
  if (r.body !== undefined) headers["content-type"] = "application/json";
  const res = await app.request(path, {
    method: r.method ?? "GET",
    headers,
    body: r.body === undefined ? undefined : JSON.stringify(r.body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

export const STAY = { checkIn: "2026-11-25", checkOut: "2026-12-02", guests: 4 } as const;

export const offerBody = (over: Record<string, unknown> = {}) => ({
  resourceId: PROPERTY.resourceId,
  ...STAY,
  locale: "en-GB",
  sessionId: "sess_1",
  ...over,
});

export async function offerThenPrepare(app: ReturnType<typeof makeApp>["app"], scenario?: string) {
  const offer = await call(app, "/v1/offers", { method: "POST", body: offerBody() });
  const prep = await call(app, `/v1/offers/${offer.body.offerId}/prepare`, {
    method: "POST",
    body: { guestAddress: GUEST, email: "guest@example.com", sessionId: "sess_1" },
    ...(scenario === undefined ? {} : { scenario }),
  });
  return { offer, prep };
}

/** Every (path-in-JSON, key) where key === name, e.g. to find stray `feeBps`. */
export function findKeys(value: unknown, name: string, path = "$"): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => findKeys(v, name, `${path}[${i}]`));
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([k, v]) => [
      ...(k === name ? [`${path}.${k}`] : []),
      ...findKeys(v, name, `${path}.${k}`),
    ]);
  }
  return [];
}
