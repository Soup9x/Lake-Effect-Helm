-- =============================================================================
-- 1150 — documents and locations can be tagged
--
-- A client's Documents and Locations lists get the bulk bar entries and
-- contacts already have: Tag, Archive, Export, Make copies and Delete. Tagging
-- them needed somewhere to put the tag.
--
-- THE SAME SHAPE AS asset_node.tags AND contact.tags (1050): a text[],
-- lowercased by the writer (src/lib/bulk/service.ts normalises), bounded, with
-- a GIN index. An uploaded file and a written document are two tables but one
-- list, so both get the column.
--
-- attachment.tags is only ever written for a document in the tree (is_document);
-- a file attached to an entry or a page is that thing's, and is not listed.
-- =============================================================================

ALTER TABLE attachment ADD COLUMN tags text[] NOT NULL DEFAULT '{}';
ALTER TABLE attachment ADD CONSTRAINT attachment_tags_bounded CHECK (cardinality(tags) <= 50);
CREATE INDEX attachment_tags_idx ON attachment USING gin (tags) WHERE is_document;

ALTER TABLE document_page ADD COLUMN tags text[] NOT NULL DEFAULT '{}';
ALTER TABLE document_page ADD CONSTRAINT document_page_tags_bounded CHECK (cardinality(tags) <= 50);
CREATE INDEX document_page_tags_idx ON document_page USING gin (tags);

ALTER TABLE site ADD COLUMN tags text[] NOT NULL DEFAULT '{}';
ALTER TABLE site ADD CONSTRAINT site_tags_bounded CHECK (cardinality(tags) <= 50);
CREATE INDEX site_tags_idx ON site USING gin (tags);

COMMENT ON COLUMN attachment.tags IS 'Free-text labels on a document in the tree, lowercased (1150).';
COMMENT ON COLUMN document_page.tags IS 'Free-text labels, lowercased (1150).';
COMMENT ON COLUMN site.tags IS 'Free-text labels, lowercased (1150).';
