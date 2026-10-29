-- =============================================================================
-- 1190 — diagram lines get a style, boxes and lines get a colour, and a
-- diagram remembers how big its canvas is
--
-- v1 drew every line the same way, solid and undirected, and sized the canvas
-- to whatever the boxes reached. A drawing of a real network wants more: a
-- dotted line for a VPN or a wireless hop, an arrow for which way the uplink
-- goes, a colour per VLAN, and room to the right to put the next rack.
--
-- STILL ONLY A PERSON WRITES HERE (0580). These are presentation columns on a
-- hand-drawn picture, not facts about the network.
--
-- arrow IS RELATIVE TO from_node_id → to_node_id, the order the line was drawn
-- in. The pair index (0570) still treats A→B and B→A as one cable: the arrow is
-- a decoration on that cable, not a second one.
--
-- colour IS A NAME FROM A SHORT PALETTE, not a hex value: the app maps each name
-- to a theme colour that reads in both light and dark mode, and a free-form
-- value would be CSS a reader's browser renders from somebody else's input.
--
-- canvas_width/canvas_height are a floor, not a cap: the canvas still grows to
-- fit a box dragged past the edge. Null means "the default size".
-- =============================================================================

ALTER TABLE topology_link
  ADD COLUMN line_style text NOT NULL DEFAULT 'solid',
  ADD COLUMN arrow text NOT NULL DEFAULT 'none',
  ADD COLUMN color text,
  ADD CONSTRAINT topology_link_line_style_ck CHECK (line_style IN ('solid', 'dashed', 'dotted')),
  ADD CONSTRAINT topology_link_arrow_ck CHECK (arrow IN ('none', 'end', 'start', 'both')),
  ADD CONSTRAINT topology_link_color_ck
    CHECK (color IS NULL OR color IN ('slate', 'blue', 'green', 'amber', 'red', 'purple'));

ALTER TABLE topology_node
  ADD COLUMN color text,
  ADD CONSTRAINT topology_node_color_ck
    CHECK (color IS NULL OR color IN ('slate', 'blue', 'green', 'amber', 'red', 'purple'));

ALTER TABLE network_diagram
  ADD COLUMN canvas_width integer,
  ADD COLUMN canvas_height integer,
  ADD CONSTRAINT network_diagram_canvas_ck CHECK (
    (canvas_width IS NULL OR canvas_width BETWEEN 400 AND 10000)
    AND (canvas_height IS NULL OR canvas_height BETWEEN 240 AND 10000));

COMMENT ON COLUMN topology_link.line_style IS 'solid, dashed or dotted ((1190)).';
COMMENT ON COLUMN topology_link.arrow IS
  'none, end (at to_node_id), start (at from_node_id) or both ((1190)).';
COMMENT ON COLUMN topology_link.color IS 'A palette name, or null for the default ((1190)).';
COMMENT ON COLUMN topology_node.color IS 'A palette name, or null for the default ((1190)).';
COMMENT ON COLUMN network_diagram.canvas_width IS
  'The canvas size somebody dragged it to, in px; null for the default ((1190)).';
