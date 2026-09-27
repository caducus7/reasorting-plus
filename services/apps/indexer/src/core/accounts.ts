// Chart of accounts for one escrow's double-entry ledger (brief C6, spec 10.3).
//
// Assets (debit-normal):       idle, deployed, loss_debt (owed by the owner, ADR 0010)
// Liabilities (credit-normal): open_principal, disputed, pending:*, claimable:*, reserve,
//                              yield_unallocated
//
// Identity, exact after every event (LedgerLib's books identity):
//   idle + deployed + loss_debt == sum of every liability account
// and idle + deployed == lastAssets. idle/deployed are a book split: valuation changes (gains,
// recognised losses) are booked to `deployed`, because neither the contract nor its events can tell
// vault growth from a direct transfer to the escrow. Actual balances come from chain reads (monitors).

export const A = {
  idle: "idle",
  deployed: "deployed",
  lossDebt: "loss_debt",
  openPrincipal: "open_principal",
  disputed: "disputed",
  reserve: "reserve",
  yieldUnallocated: "yield_unallocated",
  ownerClaimable: "claimable:owner",
  pendingOwner: "pending:owner",
  guestClaimable: (a: string) => `claimable:guest:${a.toLowerCase()}`,
  feeClaimable: (a: string) => `claimable:fee:${a.toLowerCase()}`,
  pendingGuest: (a: string) => `pending:guest:${a.toLowerCase()}`,
  pendingDispute: (bookingId: string) => `pending:dispute:${bookingId.toLowerCase()}`,
} as const;

const ASSETS = new Set<string>([A.idle, A.deployed, A.lossDebt]);

export function isAsset(account: string): boolean {
  return ASSETS.has(account);
}

/** A posting leg: positive is a debit, negative a credit. Each event's legs sum to zero. */
export type Leg = { account: string; amount: bigint };

export const dr = (account: string, amount: bigint): Leg => ({ account, amount });
export const cr = (account: string, amount: bigint): Leg => ({ account, amount: -amount });

/** Natural-sign balance change of `account` for a leg amount. */
export function naturalDelta(account: string, amount: bigint): bigint {
  return isAsset(account) ? amount : -amount;
}

export function sumPrefix(balances: Iterable<[string, bigint]>, prefix: string): bigint {
  let s = 0n;
  for (const [k, v] of balances) if (k.startsWith(prefix)) s += v;
  return s;
}
