-- =============================================================================
-- 0840 — a location's public IP addresses
--
-- The question an MSP asks about a location more than any other after "where
-- is it" is "what is its address on the internet": the static WAN IP, or the
-- /29 the ISP handed over, that firewall rules, VPN peers and remote support
-- are pointed at. It had nowhere to live except the notes.
--
-- inet[] rather than text, so a typo is refused instead of being written down
-- and found during an outage, and a block like 203.0.113.8/29 keeps its prefix.
-- NOT NULL with an empty default, like every other list column here: "none
-- recorded" is the empty list, and there is no second way to say it.
-- =============================================================================
ALTER TABLE site ADD COLUMN public_ips inet[] NOT NULL DEFAULT '{}';
ALTER TABLE site ADD CONSTRAINT site_public_ips_bounded CHECK (cardinality(public_ips) <= 32);
