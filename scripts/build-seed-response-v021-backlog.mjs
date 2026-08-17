// Turn M4 Section 0: everything identified during this Turn that is
// explicitly OUT of the fixed 5-item scope ("이번 Turn부터 범위를 확장하지
// 마") gets recorded here instead of implemented. Nothing in this file
// has been built -- it is a backlog, not a Candidate/proposal artifact.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(REPO, "work/handoff/seed-final-response-owner-review/results");
const OUT_PATH = path.join(OUT_DIR, "seed-response-v021-backlog.v0.1.json");

const backlog = {
  schema_version: "0.1.0",
  generated_at: new Date().toISOString(),
  purpose: "Turn M4 Section 0 scope freeze: items identified this Turn that are explicitly out of scope (prettier wording, ontology for future questions, corpus-wide NLP research, qualifier-ontology redesign, Sub-request/Planner redesign, metrics unrelated to the current 25 questions) are recorded here rather than implemented. Nothing below has been built this Turn.",
  items: [
    {
      id: "b1",
      title: "Calculator PRODUCT (multiplication) formula",
      origin: "Turn M4 Section 2C / ontology card #4 (Q18)",
      description: "CALCULATOR_FORMULAS (domain/runtime/agent-runtime.mjs) currently supports [SUM, DIFF, RATIO, PERCENTAGE_CHANGE] only. Adding PRODUCT would let a Flow compute shares x price_per_share generically instead of requiring a standalone Fact per case. This Turn recommended the lower-risk ISSUANCE_AMOUNT Fact path instead (see ontology decision packet card #4) specifically BECAUSE this Calculator change is out of scope.",
      why_deferred: "A Shared-Service contract change (Calculator formula enum) requires its own version bump, contract/rejection tests, and Codex review -- outside this Turn's fixed 5-item scope, and the current gap (Q18) already has a safe non-Calculator path (ISSUANCE_AMOUNT Fact).",
      prerequisite_before_starting: "Owner decision on ontology card #4 first -- if ISSUANCE_AMOUNT is approved and sufficient, PRODUCT may never be needed at all.",
    },
    {
      id: "b2",
      title: "Cross-section semantic dedup beyond whitespace normalization (true role+source+normalized-content grouping)",
      origin: "Turn M4 Section 4D",
      description: "This Turn extended the existing exact-text dedup (capability G) to also collapse whitespace-RUN differences (real disclosure text carries irregular multi-space gaps). A full 'same source_id + same semantic claim role + normalized content, merge provenance across different evidence_ids' dedup engine was considered but NOT built: an empirical scan of all 25 real r9/r10 answers found zero actual instances of the deeper cross-section duplication pattern (same content stated twice via genuinely different wording/framing, e.g. '정기공시에는' vs '회사는'), so building a paraphrase-aware matcher now would be speculative, unverified-against-real-data work, and the existing dedup comment explicitly warns paraphrase-aware dedup risks conflating two genuinely different sentences.",
      why_deferred: "No live defect to fix (empirically verified against all 25 real answers); Turn M4 explicitly forbids speculative rule-building without a reproduced failure.",
      prerequisite_before_starting: "A reproduced real-data case where two DIFFERENT-wording sentences state the same underlying claim from different sources -- re-run this same empirical scan periodically as new synthesis capabilities are added.",
    },
    {
      id: "b3",
      title: "Source-type attribution beyond the TERMINATION Event-linkage refinement",
      origin: "Turn M4 Section 4C",
      description: "resolveSourceTypeLabel currently refines the generic document_id-group label to '후속 해지공시' only when the narrative Fact's own linked Event is anchored at the same source_document_id AND matches /TERMINATION/i. Other refinements (e.g. a '정정공시' label when the Event is a correction, an '연장공시' label for extension-only documents with no Fact linkage at all) were identified as possible but have no real-data case among the current 25 questions requiring them.",
      why_deferred: "No Owner note or reproduced defect calls for a label finer than the 5 currently implemented (정기공시/주요사항보고서/거래소 공시/대량보유 보고서/후속 해지공시) plus the 해당 공시 fallback.",
      prerequisite_before_starting: "A specific Owner note or Gold-evaluation finding that the current 5-label set is insufficiently precise for a real question.",
    },
    {
      id: "b4",
      title: "Qualifier-ontology redesign / broader 한정 표현 taxonomy",
      origin: "Explicitly named as out-of-scope in Turn M4 Section 0",
      description: "The current qualifier-preservation mechanism (verbatim '(예정)'/'(잠정)' etc. spans) is unchanged this Turn. A more general qualifier-type taxonomy (e.g. distinguishing PLANNED vs PROVISIONAL vs DISPUTED qualifiers as structured attributes rather than raw preserved spans) was raised in earlier Turns' idea backlog and remains there.",
      why_deferred: "Explicitly named as out of scope by the user this Turn.",
      prerequisite_before_starting: "A Gold-evaluation measured regression showing the current verbatim-preservation approach is insufficient (per CLAUDE.md Section 16 freeze-governance: only measured evidence justifies a Frozen-adjacent redesign).",
    },
    {
      id: "b5",
      title: "Sub-request / Planner redesign",
      origin: "Explicitly named as out-of-scope in Turn M4 Section 0",
      description: "The current sub_request_authority=HEURISTIC path (vs STRUCTURED) and the Planner's own decomposition logic are unchanged this Turn.",
      why_deferred: "Explicitly named as out of scope by the user this Turn.",
      prerequisite_before_starting: "A dedicated Turn scoped to Planner/Sub-request work, informed by DEV_TUNE evaluation results per CLAUDE.md Section 11-12.",
    },
    {
      id: "b6",
      title: "Corpus-wide NLP research / prettier wording improvements beyond the 24 Owner notes",
      origin: "Explicitly named as out-of-scope in Turn M4 Section 0",
      description: "Any wording polish not tied to a concrete Owner-note defect or a factual-accuracy/completeness/grounding break was intentionally left untouched this Turn, even where a nicer phrasing might exist.",
      why_deferred: "Explicitly named as out of scope by the user this Turn; scope is fixed to the 5 items in Section 0.",
      prerequisite_before_starting: "A future Turn explicitly scoped to sentence-quality polish, or a new Owner note flagging a specific sentence.",
    },
    {
      id: "b7",
      title: "Ontology tokens for question types beyond the current 25 Seed questions",
      origin: "Explicitly named as out-of-scope in Turn M4 Section 0",
      description: "No speculative metric_code/event_type/relation_type was added for hypothetical future question shapes -- only the 4 proposals concretely required by the current 25 questions' Owner notes were drafted (as PENDING cards, not implemented).",
      why_deferred: "Explicitly named as out of scope by the user this Turn; also matches the project-wide overfitting-prevention principle (CLAUDE.md Section 10).",
      prerequisite_before_starting: "New Gold questions requiring a concrete new token, reviewed the same way (ontology audit + decision packet) as this Turn's 4 cards.",
    },
  ],
};

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(OUT_PATH, `${JSON.stringify(backlog, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ item_count: backlog.items.length }, null, 2));
}

main().catch((error) => { console.error(error.message); process.exit(1); });
