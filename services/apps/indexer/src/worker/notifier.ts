// Pluggable alert notifier (brief C6: "alerts to a pluggable notifier interface; the agent
// workstream owns the messaging adapter"). The outbox is the durable record; adapters are called
// once per newly opened alert.
import type pg from "pg";
import type { Breach } from "../core/invariants.js";

export type Alert = Breach & { chainId: number };

/** Implemented by the agent workstream's messaging adapter (and by LogNotifier here). */
export interface Notifier {
  notify(alert: Alert): Promise<void>;
}

export class LogNotifier implements Notifier {
  async notify(a: Alert) {
    const line = JSON.stringify({ level: a.severity, invariant: a.invariant, escrow: a.escrow, msg: a.message, response: a.response });
    (a.severity === "warn" ? console.warn : console.error)(line);
  }
}

/**
 * Opens, keeps and resolves alerts in indexer_ops.alerts. `sync(family, breaches)` makes the open set
 * for one monitor family equal to `breaches`: new keys are opened and sent to the adapters, keys no
 * longer breached are resolved. Anomaly alerts (family "anomaly") are facts and are never
 * auto-resolved.
 */
export class AlertOutbox {
  constructor(
    private readonly db: pg.Pool | pg.PoolClient,
    private readonly chainId: number,
    private readonly adapters: Notifier[],
  ) {}

  async sync(family: string, breaches: Breach[], opts: { autoResolve?: boolean; keepEscrows?: string[] } = {}) {
    const opened: Alert[] = [];
    for (const b of breaches) {
      const r = await this.db.query(
        `INSERT INTO indexer_ops.alerts (dedupe_key, invariant, severity, chain_id, escrow, message, details, response)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (dedupe_key) WHERE resolved_at IS NULL DO NOTHING RETURNING id`,
        [b.key, b.invariant, b.severity, this.chainId, b.escrow ?? null, b.message, b.details ?? {}, b.response],
      );
      if (r.rowCount) opened.push({ ...b, chainId: this.chainId });
    }
    if (opts.autoResolve !== false) {
      await this.db.query(
        `UPDATE indexer_ops.alerts SET resolved_at = now()
         WHERE resolved_at IS NULL AND chain_id = $1 AND dedupe_key LIKE $2 AND NOT (dedupe_key = ANY($3::text[]))
           AND NOT (lower(coalesce(escrow, '')) = ANY($4::text[]))`,
        // An escrow that could not be read keeps its open alerts: unknown is not cleared.
        [this.chainId, `${family}:%`, breaches.map((b) => b.key), (opts.keepEscrows ?? []).map((e) => e.toLowerCase())],
      );
    }
    for (const a of opened) for (const n of this.adapters) await n.notify(a).catch((e) => console.error("notifier failed", e));
    return opened;
  }

  /** Opens `breaches` without resolving anything else (for producers that see only part of a family). */
  async open(breaches: Breach[]) {
    return this.sync("\u0000none", breaches, { autoResolve: false });
  }

  /** Resolves exactly these keys (for producers that know a specific condition has cleared). */
  async resolve(keys: string[]) {
    if (keys.length === 0) return;
    await this.db.query(
      "UPDATE indexer_ops.alerts SET resolved_at = now() WHERE resolved_at IS NULL AND chain_id = $1 AND dedupe_key = ANY($2::text[])",
      [this.chainId, keys],
    );
  }
}
