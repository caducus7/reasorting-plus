-- C8 state: the decision log (audit: inputs, checks, decision, transaction), the one transaction in
-- flight per escrow (written before broadcast), revert cooldowns, and the published required amount.
CREATE SCHEMA IF NOT EXISTS rebalancer;

CREATE TABLE IF NOT EXISTS rebalancer.decisions (
  id          bigserial   PRIMARY KEY,
  chain_id    integer     NOT NULL,
  escrow      text        NOT NULL,
  at          timestamptz NOT NULL DEFAULT now(),
  block       bigint,
  snapshot    jsonb       NOT NULL,
  checks      jsonb       NOT NULL,
  kind        text        NOT NULL,   -- deploy | redeem | hold | replace | cancel
  reason      text        NOT NULL,
  amount      numeric(78, 0),
  dry_run     boolean     NOT NULL,
  outcome     text        NOT NULL,   -- logged | dry_run | cooldown | precheck_reverted | sent | mined | reverted | nonce_consumed | not_rebalancer | error
  tx_hash     text,
  detail      text
);
CREATE INDEX IF NOT EXISTS decisions_escrow_at ON rebalancer.decisions (escrow, at DESC);

CREATE TABLE IF NOT EXISTS rebalancer.pending_tx (
  chain_id      integer     NOT NULL,
  escrow        text        NOT NULL,
  sender        text        NOT NULL,
  nonce         bigint      NOT NULL,
  kind          text        NOT NULL,   -- deploy | redeem | cancel
  amount        numeric(78, 0) NOT NULL,
  hashes        text[]      NOT NULL,   -- every broadcast at this nonce (replacements included)
  raw           text        NOT NULL,   -- last signed transaction: rebroadcast after a crash
  broadcast     boolean     NOT NULL DEFAULT false, -- set once the node accepted it
  max_fee       numeric(78, 0) NOT NULL,
  priority_fee  numeric(78, 0) NOT NULL,
  decision_id   bigint      NOT NULL,
  first_sent_at timestamptz NOT NULL,
  last_sent_at  timestamptz NOT NULL,
  PRIMARY KEY (chain_id, escrow)
);

CREATE TABLE IF NOT EXISTS rebalancer.cooldowns (
  chain_id  integer     NOT NULL,
  escrow    text        NOT NULL,
  key       text        NOT NULL,   -- kind:reason
  strikes   integer     NOT NULL,
  until     timestamptz NOT NULL,
  PRIMARY KEY (chain_id, escrow, key)
);

-- Published required liquid amount (spec 6.7) per escrow, for INV-5 consumers and the owner digest.
CREATE TABLE IF NOT EXISTS rebalancer.required_liquid (
  chain_id     integer     NOT NULL,
  escrow       text        NOT NULL,
  block        bigint      NOT NULL,
  required     numeric(78, 0) NOT NULL,
  computed_at  timestamptz NOT NULL,
  PRIMARY KEY (chain_id, escrow)
);
