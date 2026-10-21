-- =============================================================================
-- 1050 — contacts can be tagged
--
-- Every entry has had free-text tags since 0050, and a client's Contacts list
-- now has the same bulk bar as its entry lists: Tag, Archive, Export, Make
-- copies. Tagging a contact needed somewhere to put the tag.
--
-- THE SAME SHAPE AS asset_node.tags: a text[], lowercased by the writer
-- (src/lib/bulk/service.ts normalises; the tag editor uses the same route),
-- with a GIN index for "every contact tagged vip". Not a tag table, for the
-- reason 0050 gave: a tag is a label somebody types, not a record somebody
-- owns.
--
-- THE ROLE BADGES ARE NOT TAGS. Primary, technical, billing, emergency and
-- authorised are flags with meaning — who may authorise a reset, who is called
-- at 2am — and stay booleans. Tags sit beside them on the contact page.
-- =============================================================================

ALTER TABLE contact ADD COLUMN tags text[] NOT NULL DEFAULT '{}';

ALTER TABLE contact ADD CONSTRAINT contact_tags_bounded CHECK (cardinality(tags) <= 50);

CREATE INDEX contact_tags_idx ON contact USING gin (tags);

COMMENT ON COLUMN contact.tags IS
  'Free-text labels, lowercased (1050). The role flags are booleans beside them, not tags.';
