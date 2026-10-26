-- =============================================================================
-- 1100 — 'proxmox', alone, for the reason 0405 gives
--
-- A new enum value cannot be used in the transaction that added it, and
-- db/migrate.ts runs each file in one transaction. 1110 uses the value in
-- function bodies and a trigger, so it gets a committed type to do that with.
-- =============================================================================

SET search_path = public, extensions;

ALTER TYPE integration_provider ADD VALUE IF NOT EXISTS 'proxmox';
