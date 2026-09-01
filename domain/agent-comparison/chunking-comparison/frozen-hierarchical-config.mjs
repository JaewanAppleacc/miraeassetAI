// Turn P10.1.1: the FROZEN original hierarchical config
// (doctype-hier-parent-child-table-dual.v0.2.0, parent_max_tokens=1024),
// read directly off the shared, tested, frozen artifact
// domain/chunking/strategy-configs.v0.1.json's own PRIMARY entry -- never
// redefined or hand-copied with literal numbers here, so this can never
// silently drift from the shared config. Config C in this Turn's brief.
import configs from "../../chunking/strategy-configs.v0.1.json" with { type: "json" };

export const FROZEN_HIERARCHICAL_CONFIG = configs.strategies.find((s) => s.role === "PRIMARY");

if (!FROZEN_HIERARCHICAL_CONFIG || FROZEN_HIERARCHICAL_CONFIG.chunking_config_id !== "doctype-hier-parent-child-table-dual.v0.2.0" || FROZEN_HIERARCHICAL_CONFIG.parent_max_tokens !== 1024) {
  throw new Error("frozen-hierarchical-config.mjs: strategy-configs.v0.1.json's PRIMARY entry no longer matches the expected frozen doctype-hier-parent-child-table-dual.v0.2.0 (parent_max_tokens=1024) shape -- refusing to proceed with a possibly-drifted config");
}
