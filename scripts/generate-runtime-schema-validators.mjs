#!/usr/bin/env node
// Generate CSP/Worker-safe validators from the frozen JSON Schemas.
//
// Ajv normally compiles schemas with `new Function()` when a module loads.
// Cloudflare Workers deliberately disallow that operation.  This script runs
// only in the trusted Node build/development environment and emits ordinary
// ESM validation functions for the Runtime to import.  Runtime modules never
// instantiate Ajv and therefore remain compatible with eval-free Workers.
import { writeFile } from "node:fs/promises";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import standaloneCode from "ajv/dist/standalone/index.js";
import answerWireResponseSchema from "../domain/interfaces/answer-wire-response.schema.json" with { type: "json" };
import documentIrSchema from "../domain/interfaces/document-ir.schema.json" with { type: "json" };
import factCoverageSnapshotSchema from "../domain/interfaces/fact-coverage-snapshot.schema.json" with { type: "json" };
import finalResponseSchema from "../domain/interfaces/final-response.schema.json" with { type: "json" };
import semanticBundleSchema from "../domain/interfaces/semantic-bundle.schema.json" with { type: "json" };
import structuredQuerySchema from "../domain/interfaces/structured-query.schema.json" with { type: "json" };
import structuredResultSchema from "../domain/interfaces/structured-result.schema.json" with { type: "json" };
import retrievalRequestSchema from "../domain/retrieval/retrieval-request.schema.json" with { type: "json" };
import retrievalResultSchema from "../domain/retrieval/retrieval-result.schema.json" with { type: "json" };

const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  allowUnionTypes: true,
  code: { source: true, esm: true },
});
addFormats(ajv);

const schemas = [
  answerWireResponseSchema,
  documentIrSchema,
  factCoverageSnapshotSchema,
  finalResponseSchema,
  semanticBundleSchema,
  structuredQuerySchema,
  structuredResultSchema,
  retrievalRequestSchema,
  retrievalResultSchema,
];
for (const schema of schemas) ajv.addSchema(schema, schema.$id);

const wrapperSchemas = {
  "urn:seed-runtime:evidence": { $ref: `${semanticBundleSchema.$id}#/$defs/evidence` },
  "urn:seed-runtime:fact": { $ref: `${semanticBundleSchema.$id}#/$defs/fact` },
  "urn:seed-runtime:event": { $ref: `${semanticBundleSchema.$id}#/$defs/event` },
};
for (const [id, schema] of Object.entries(wrapperSchemas)) ajv.addSchema({ $id: id, ...schema }, id);

let moduleCode = standaloneCode(ajv, {
  validateAnswerWireResponseSchema: answerWireResponseSchema.$id,
  validateDocumentIrSchema: documentIrSchema.$id,
  validateFactCoverageSnapshotSchema: factCoverageSnapshotSchema.$id,
  validateFinalResponseSchema: finalResponseSchema.$id,
  validateEvidenceSchema: "urn:seed-runtime:evidence",
  validateFactSchema: "urn:seed-runtime:fact",
  validateEventSchema: "urn:seed-runtime:event",
  validateStructuredQuerySchema: structuredQuerySchema.$id,
  validateStructuredResultSchema: structuredResultSchema.$id,
  validateRetrievalRequestSchema: retrievalRequestSchema.$id,
  validateRetrievalResultSchema: retrievalResultSchema.$id,
});

// Ajv's ESM standalone output still emits CommonJS `require()` expressions
// for three small runtime helpers.  A real ESM module (and the Worker
// bundler) cannot execute those. Replace only the exact helper expressions
// Ajv owns with static ESM imports; fail if a future Ajv version introduces
// another dynamic require so code generation cannot silently become unsafe.
moduleCode = moduleCode
  .replaceAll('require("ajv/dist/runtime/ucs2length").default', "ucs2length")
  .replaceAll('require("ajv/dist/runtime/equal").default', "equal")
  .replaceAll('require("ajv-formats/dist/formats")', "ajvFormats");
if (/\brequire\s*\(/.test(moduleCode)) {
  throw new Error("generated validator contains an unsupported dynamic require()");
}

const banner = `// GENERATED FILE — DO NOT EDIT BY HAND.\n// Source: scripts/generate-runtime-schema-validators.mjs\n// Regenerate after an intentional schema change. Runtime-safe: no eval/new Function.\nimport ucs2lengthModule from "ajv/dist/runtime/ucs2length.js";\nimport equalModule from "ajv/dist/runtime/equal.js";\nimport ajvFormats from "ajv-formats/dist/formats.js";\nconst ucs2length = ucs2lengthModule.default;\nconst equal = equalModule.default;\n`;
await writeFile(new URL("../domain/generated/runtime-schema-validators.mjs", import.meta.url), banner + moduleCode + "\n", "utf8");
