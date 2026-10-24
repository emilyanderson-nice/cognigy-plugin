/**
 * Read side of manage_settings { operation: "get_knowledge_ai" }. The output is
 * built field by field from the project settings so no other setting (which
 * may hold connection ids or secrets) can leak through.
 */

import { jsonSafeCopy } from "../utils/jsonSafe.js";

const MAX_DEPTH = 4;

function pick(
  source: any,
  fields: Record<string, (v: unknown) => unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (source === null || typeof source !== "object") return out;
  for (const [key, copy] of Object.entries(fields)) {
    const copied = source[key] === undefined ? undefined : copy(source[key]);
    if (copied !== undefined) out[key] = copied;
  }
  return out;
}

const asScalar = (v: unknown) =>
  typeof v === "string" || typeof v === "boolean" || typeof v === "number"
    ? v
    : undefined;

export function buildKnowledgeAiSettings(projectId: string, settings: any) {
  return {
    projectId,
    knowledgeAI: pick(settings?.knowledgeAISettings, {
      fileExtractor: asScalar,
      azureDIConnectionId: asScalar,
    }),
    generativeAI: pick(settings?.generativeAISettings, {
      enabled: asScalar,
      useCasesSettings: (v) => jsonSafeCopy(v, MAX_DEPTH),
    }),
  };
}
