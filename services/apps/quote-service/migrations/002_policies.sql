-- Rendered policy text per policyHash (ADR 0004): a booking shows the terms it was signed under,
-- even after the owner edits the policy. policyHash = keccak256(utf8(rendered)).
CREATE TABLE policies (
  policy_hash  text PRIMARY KEY,
  policy_id    text NOT NULL,
  rendered     text NOT NULL
);
