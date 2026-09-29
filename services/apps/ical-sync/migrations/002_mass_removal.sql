-- Mass-removal guard (review 0006 G1, ADR 0018 amendment). held_removals: future blocks that left the
-- feed in a removal over the threshold and are kept until approved. approved_removals: the held set as
-- the operator saw it when running `pnpm confirm-removals <feedId>`; applied (and cleared) by the next
-- import. Removals outside it are judged afresh.
ALTER TABLE ical_sync.feed_state ADD COLUMN IF NOT EXISTS held_removals text[] NOT NULL DEFAULT '{}';
ALTER TABLE ical_sync.feed_state ADD COLUMN IF NOT EXISTS approved_removals text[] NOT NULL DEFAULT '{}';
