import { z } from "zod";

const idSchema = z.string().regex(/^[a-f0-9]{24}$/, "Must be a 24-char hex ID");

const NOT_BOTH_IDS_MESSAGE =
  "Pass either aiAgentId or flowId, not both. Use aiAgentId for a normal agent; use flowId only for a flow driven by an LLM Prompt node (which has no agent resource).";

const REVEAL_TOKEN_MESSAGE =
  "revealToken: true is only valid with resourceType 'endpoint'.";

const paginationSchema = {
  limit: z.number().int().min(1).max(100).optional(),
  skip: z.number().int().min(0).optional(),
};

// Tool 1: create_ai_agent
export const createAiAgentSchema = z
  .object({
    projectId: idSchema.optional(),
    name: z.string().min(1).max(200),
    description: z.string().optional(),
    knowledgeStoreReferenceId: z.string().optional(),
    agentNodeType: z.enum(["aiAgent", "llmPrompt"]).optional(),
    systemPrompt: z.string().optional(),
  })
  .refine(
    (d) => !(d.agentNodeType === "llmPrompt" && d.knowledgeStoreReferenceId),
    {
      message:
        "knowledgeStoreReferenceId is not supported with agentNodeType 'llmPrompt' — LLM Prompt nodes only support 'tool', 'mcp', and 'http' tools.",
      path: ["knowledgeStoreReferenceId"],
    },
  )
  .refine(
    (d) =>
      d.agentNodeType !== "llmPrompt" ||
      Boolean(d.systemPrompt?.trim() || d.description?.trim()),
    {
      message:
        "agentNodeType 'llmPrompt' requires a systemPrompt (or description) — the prompt is the LLM Prompt node's entire persona and guardrails.",
      path: ["systemPrompt"],
    },
  )
  .refine((d) => !d.systemPrompt || d.agentNodeType === "llmPrompt", {
    message:
      "systemPrompt is only used with agentNodeType 'llmPrompt'. For a normal AI Agent, put the persona in description and refine it with update_ai_agent.",
    path: ["systemPrompt"],
  });

// Tool 2: update_ai_agent
export const updateAiAgentSchema = z.object({
  aiAgentId: idSchema,
  name: z.string().min(1).max(200).optional(),
  description: z.string().optional(),
  instructions: z.string().optional(),
  jobConfig: z
    .object({
      llmProviderReferenceId: z.string().optional(),
      jobName: z.string().optional(),
      jobDescription: z.string().optional(),
      jobInstructions: z.string().optional(),
      temperature: z.number().min(0).max(1).optional(),
      maxTokens: z.number().int().min(100).max(8000).optional(),
    })
    .optional(),
});

// Tool 3: setup_llm

export const SETUP_LLM_PROVIDERS = [
  "openAI",
  "azureOpenAI",
  "anthropic",
  "google",
  "mistral",
  "openAICompatible",
  "awsBedrock",
] as const;

export const BEDROCK_LOCATIONS = ["region", "geo", "global"] as const;

// Which providers may use which provider-specific setup_llm field.
const SETUP_LLM_FIELD_PROVIDERS = {
  baseCustomUrl: ["openAICompatible"],
  customModel: ["openAICompatible", "awsBedrock"],
  customAuthHeader: ["openAICompatible"],
  apiType: ["openAI", "azureOpenAI", "openAICompatible"],
  region: ["awsBedrock"],
  location: ["awsBedrock"],
  geo: ["awsBedrock"],
  accessKeyId: ["awsBedrock"],
  secretAccessKey: ["awsBedrock"],
  roleArn: ["awsBedrock"],
} as const;

export const setupLlmSchema = z
  .object({
    projectId: idSchema,
    provider: z.enum(SETUP_LLM_PROVIDERS),
    modelType: z.string().min(1),
    name: z.string().optional(),
    apiKey: z.string().optional(),
    connectionId: z.string().optional(),
    isDefault: z.boolean().optional(),
    baseCustomUrl: z.string().url().optional(),
    customModel: z.string().min(1).optional(),
    customAuthHeader: z.string().min(1).optional(),
    apiType: z.enum(["chatCompletion", "responses"]).optional(),
    region: z.string().min(1).optional(),
    location: z.enum(BEDROCK_LOCATIONS).optional(),
    geo: z.string().min(1).optional(),
    accessKeyId: z.string().min(1).optional(),
    secretAccessKey: z.string().min(1).optional(),
    roleArn: z.string().min(1).optional(),
    dangerouslySkipConnectionTest: z.boolean().optional(),
  })
  .superRefine((data, ctx) => {
    if (
      data.connectionId &&
      (data.apiKey || data.accessKeyId || data.secretAccessKey || data.roleArn)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["connectionId"],
        message:
          "Provide either inline credentials (apiKey / accessKeyId + secretAccessKey / roleArn) OR connectionId, not both — inline credentials would be ignored.",
      });
    }

    for (const [field, providers] of Object.entries(
      SETUP_LLM_FIELD_PROVIDERS,
    )) {
      if (
        data[field as keyof typeof SETUP_LLM_FIELD_PROVIDERS] !== undefined &&
        !(providers as readonly string[]).includes(data.provider)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: `${field} is only supported for provider(s) ${providers
            .map((p) => `'${p}'`)
            .join(", ")}.`,
        });
      }
    }

    if (data.provider === "openAICompatible") {
      if (!data.baseCustomUrl) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["baseCustomUrl"],
          message:
            "Provider 'openAICompatible' requires baseCustomUrl — the provider's OpenAI-compatible API base URL (e.g. https://my-llm-host.example.com/v1).",
        });
      }
      if (!data.customModel) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["customModel"],
          message:
            "Provider 'openAICompatible' requires customModel — the model name as known by the provider (e.g. 'llama-3.3-70b-instruct').",
        });
      }
      if (
        data.modelType !== "custom-model" &&
        data.modelType !== "custom-embedding-model"
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["modelType"],
          message:
            "Provider 'openAICompatible' requires modelType 'custom-model' (chat) or 'custom-embedding-model' (embedding). Put the provider's model name in customModel instead.",
        });
      }
      if (
        data.modelType === "custom-embedding-model" &&
        data.apiType !== undefined
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["apiType"],
          message:
            "apiType is only supported for chat models; omit it when modelType is 'custom-embedding-model'.",
        });
      }
    }

    if (data.provider === "awsBedrock") {
      if (!data.region) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["region"],
          message:
            "Provider 'awsBedrock' requires region — the AWS region of the Bedrock deployment (e.g. 'us-east-1').",
        });
      }
      if (data.apiKey) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["apiKey"],
          message:
            "Provider 'awsBedrock' does not use apiKey. Provide accessKeyId + secretAccessKey (access-key auth) or roleArn (IAM-role auth) instead.",
        });
      }
      if (data.roleArn && (data.accessKeyId || data.secretAccessKey)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["roleArn"],
          message:
            "Provide either accessKeyId + secretAccessKey OR roleArn, not both.",
        });
      }
      if (
        (data.accessKeyId && !data.secretAccessKey) ||
        (!data.accessKeyId && data.secretAccessKey)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [data.accessKeyId ? "secretAccessKey" : "accessKeyId"],
          message: "accessKeyId and secretAccessKey must be provided together.",
        });
      }
      if (data.customModel && data.modelType !== "custom-model") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["modelType"],
          message:
            "customModel requires modelType 'custom-model' for provider 'awsBedrock'. Use a named modelType (e.g. 'amazon.nova-pro-v1:0') without customModel, or modelType 'custom-model' with the Bedrock model id in customModel.",
        });
      }
      if (data.modelType === "custom-model" && !data.customModel) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["customModel"],
          message:
            "modelType 'custom-model' requires customModel — the Bedrock model id or inference profile id (e.g. 'eu.anthropic.claude-sonnet-4-6').",
        });
      }
      if (data.location === "geo" && !data.geo) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["geo"],
          message:
            "location 'geo' requires geo — the geographic boundary requests may be routed within (e.g. 'us', 'eu', 'apac').",
        });
      }
      if (data.geo && data.location !== "geo") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["geo"],
          message: "geo is only supported when location is 'geo'.",
        });
      }
    }
  });

// Tool 4: talk_to_agent
export const talkToAgentSchema = z
  .object({
    endpointUrl: z.string().url().optional(),
    endpointId: idSchema.optional(),
    aiAgentId: idSchema.optional(),
    projectId: idSchema.optional(),
    message: z.string().min(1),
    sessionId: z.string().optional(),
    userId: z.string().optional(),
    data: z.record(z.any()).optional(),
    verbose: z.boolean().optional(),
    testMode: z.boolean().optional(),
  })
  .refine((d) => d.endpointUrl || d.endpointId || d.aiAgentId, {
    message: "One of endpointUrl, endpointId or aiAgentId must be provided",
    path: ["endpointUrl"],
  });

/** Actor values Cognigy records in `auditEvent.performedBy.actor`. */
export const AUDIT_ACTORS = [
  "human",
  "ask-ai",
  "mcp-plugin",
  "system",
] as const;

/** Audit event operation types (`auditEvent.type`). */
export const AUDIT_EVENT_TYPES = [
  "action",
  "create",
  "replace",
  "patch",
  "delete",
  "authentication",
  "authorization",
] as const;

export const LOG_LEVELS = [
  "fatal",
  "error",
  "warn",
  "info",
  "debug",
  "trace",
] as const;

// Tool 5: list_resources
export const listResourcesSchema = z
  .object({
    resourceType: z.enum([
      "project",
      "agent",
      "flow",
      "endpoint",
      "llm_model",
      "knowledge_store",
      "conversation",
      "extension",
      "function",
      "tool",
      "audit_event",
      "log",
    ]),
    projectId: idSchema.optional(),
    aiAgentId: idSchema.optional(),
    flowId: idSchema.optional(),
    startDate: z.string().optional(),
    endDate: z.string().optional(),
    channel: z.string().optional(),
    useCase: z.string().optional(),
    // log-only filters (resourceType 'log').
    logLevel: z.array(z.enum(LOG_LEVELS)).nonempty().optional(),
    search: z.string().min(1).max(200).optional(),
    flowName: z.string().min(1).max(100).optional(),
    sessionId: z.string().min(1).max(128).optional(),
    view: z.enum(["summary", "entries"]).optional(),
    msgChars: z.number().int().min(100).max(4000).optional(),
    // audit_event filters. `actor` and `eventType` are sent as repeatable query
    // params (actor[]=…), which the platform supports from 2026.17.0 onwards.
    // Named `eventType` rather than `type` so it cannot be confused with
    // `resourceType` at the call site.
    actor: z.array(z.enum(AUDIT_ACTORS)).nonempty().optional(),
    eventType: z.array(z.enum(AUDIT_EVENT_TYPES)).nonempty().optional(),
    user: z.string().min(1).optional(),
    // endpoint only: include the URL token and URL (a credential).
    revealToken: z.boolean().optional(),
    sort: z
      .string()
      .regex(
        /^[A-Za-z][A-Za-z0-9_]*:(asc|desc)$/,
        "Must be 'field:direction', e.g. 'lastChanged:desc'",
      )
      .optional(),
    ...paginationSchema,
  })
  .refine((d) => !(d.aiAgentId && d.flowId), {
    message: NOT_BOTH_IDS_MESSAGE,
    path: ["flowId"],
  })
  .refine((d) => !d.revealToken || d.resourceType === "endpoint", {
    message: REVEAL_TOKEN_MESSAGE,
    path: ["revealToken"],
  });

// Tool 6: get_resource
export const getResourceSchema = z
  .object({
    resourceType: z.enum([
      "agent",
      "flow",
      "endpoint",
      "project",
      "conversation",
      "session_state",
      "llm_model",
      "knowledge_store",
      "extension",
      "function",
      "user",
      "audit_event",
    ]),
    id: z.string().min(1),
    projectId: idSchema.optional(),
    raw: z.boolean().optional(),
    revealToken: z.boolean().optional(),
  })
  .refine((d) => !d.revealToken || d.resourceType === "endpoint", {
    message: REVEAL_TOKEN_MESSAGE,
    path: ["revealToken"],
  });

// Tool 7: delete_resource
/**
 * Flow lifecycle. Deliberately does NOT include delete or list — those already
 * live in delete_resource and list_resources, and duplicating them would give
 * the model two ways to do one thing.
 */
export const manageFlowsSchema = z.discriminatedUnion("operation", [
  z.object({
    operation: z.literal("create"),
    projectId: idSchema,
    name: z.string().min(1).max(200),
    description: z.string().max(2000).optional(),
  }),
  z.object({
    operation: z.literal("update"),
    flowId: idSchema,
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(2000).optional(),
  }),
  z.object({
    operation: z.literal("clone"),
    flowId: idSchema,
  }),
]);

export const deleteResourceSchema = z
  .object({
    resourceType: z.enum([
      "agent",
      "flow",
      "project",
      "endpoint",
      "llm_model",
      "knowledge_store",
      "function",
      "tool",
    ]),
    id: idSchema,
    projectId: idSchema.optional(),
    aiAgentId: idSchema.optional(),
    flowId: idSchema.optional(),
    cascade: z.boolean().optional(),
  })
  .refine((d) => !(d.aiAgentId && d.flowId), {
    message: NOT_BOTH_IDS_MESSAGE,
    path: ["flowId"],
  });

// Tool 8: manage_knowledge
export const manageKnowledgeSchema = z.object({
  operation: z.enum([
    "create_store",
    "create_source",
    "list_chunks",
    "list_sources",
  ]),
  projectId: idSchema.optional(),
  knowledgeStoreId: idSchema.optional(),
  sourceId: idSchema.optional(),
  name: z.string().min(1).max(200).optional(),
  description: z.string().optional(),
  type: z.enum(["url", "manual", "file"]).optional(),
  url: z.string().url().optional(),
  text: z.string().optional(),
  filePath: z.string().optional(),
  filter: z.string().optional(),
  limit: z.number().int().min(1).max(50).optional(),
});

// Tool 9: create_tool (includes http tool type, formerly create_custom_http_tool)
const a2aToolConfigSchema = {
  agentBaseUrl: z.string().optional(),
  agentCardPath: z.string().optional(),
  executionMode: z.string().optional(),
  taskTimeout: z.number().optional(),
  maxAutonomousTurns: z.number().int().optional(),
  toolFilter: z.enum(["none", "whitelist", "blacklist"]).optional(),
  whitelist: z.array(z.string()).optional(),
  blacklist: z.array(z.string()).optional(),
  authType: z.enum(["none", "apiKey", "bearer", "basic", "oAuth2"]).optional(),
  apiKeyConnection: z.string().optional(),
  apiKeyHeader: z.string().optional(),
  bearerConnection: z.string().optional(),
  basicConnection: z.string().optional(),
  oAuth2Connection: z.string().optional(),
  authForDiscovery: z.boolean().optional(),
  agentHeaders: z.string().optional(),
  cacheCard: z.boolean().optional(),
};

export const createToolSchema = z
  .object({
    aiAgentId: idSchema.optional(),
    flowId: idSchema.optional(),
    parentNodeId: idSchema.optional(),
    toolType: z.enum(["tool", "knowledge", "send_email", "mcp", "http", "a2a"]),
    name: z.string().min(1).max(200),
    config: z.object({
      toolId: z.string().optional(),
      description: z.string().optional(),
      parameters: z.string().optional(),
      knowledgeStoreId: z.string().optional(),
      topK: z.number().int().min(1).max(50).optional(),
      recipient: z.string().optional(),
      mcpServerUrl: z.string().optional(),
      mcpName: z.string().optional(),
      timeout: z.number().optional(),
      url: z.string().optional(),
      method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).optional(),
      headers: z.record(z.string()).optional(),
      body: z.string().optional(),
      preProcessCode: z.string().optional(),
      postProcessCode: z.string().optional(),
      toolResponseValue: z.string().optional(),
      // http tools: set false to skip the generated failure guards
      errorGuard: z.boolean().optional(),
      // set false to skip the generated tool-call Log node
      logToolCalls: z.boolean().optional(),
      ...a2aToolConfigSchema,
    }),
  })
  .refine((d) => d.aiAgentId || d.flowId, {
    message: "Either aiAgentId or flowId must be provided",
    path: ["aiAgentId"],
  })
  .refine((d) => !(d.aiAgentId && d.flowId), {
    message: NOT_BOTH_IDS_MESSAGE,
    path: ["flowId"],
  });

// Tool 10: update_tool
export const updateToolSchema = z
  .object({
    aiAgentId: idSchema.optional(),
    flowId: idSchema.optional(),
    toolNodeId: idSchema,
    name: z.string().min(1).max(200).optional(),
    toolType: z
      .enum(["tool", "knowledge", "send_email", "mcp", "http", "a2a"])
      .optional(),
    config: z
      .object({
        toolId: z.string().optional(),
        description: z.string().optional(),
        parameters: z.string().optional(),
        knowledgeStoreId: z.string().optional(),
        topK: z.number().int().min(1).max(50).optional(),
        recipient: z.string().optional(),
        mcpServerUrl: z.string().optional(),
        mcpName: z.string().optional(),
        timeout: z.number().optional(),
        url: z.string().optional(),
        method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).optional(),
        headers: z.record(z.string()).optional(),
        body: z.string().optional(),
        preProcessCode: z.string().optional(),
        postProcessCode: z.string().optional(),
        toolResponseValue: z.string().optional(),
        errorGuard: z.boolean().optional(),
        logToolCalls: z.boolean().optional(),
        httpNodeId: idSchema.optional(),
        preProcessNodeId: idSchema.optional(),
        postProcessNodeId: idSchema.optional(),
        resolveNodeId: idSchema.optional(),
        ...a2aToolConfigSchema,
      })
      .optional(),
  })
  .refine((d) => d.aiAgentId || d.flowId, {
    message: "Either aiAgentId or flowId must be provided",
    path: ["aiAgentId"],
  })
  .refine((d) => !(d.aiAgentId && d.flowId), {
    message: NOT_BOTH_IDS_MESSAGE,
    path: ["flowId"],
  });

// Tool 12: manage_flow_nodes
// Emptiness is reported per field by utils/fileAccess, not as a schema failure.
const filePathSchema = z.string().max(1000);
export const manageFlowNodesSchema = z.object({
  operation: z.enum([
    "list",
    "get",
    "create",
    "update",
    "delete",
    "render",
    "compare",
  ]),
  flowId: idSchema,
  nodeId: idSchema.optional(),
  nodeType: z.string().optional(),
  label: z.string().min(1).max(200).optional(),
  // the node's Comment field in the editor; "" clears it on update
  comment: z.string().max(2000).optional(),
  parentNodeId: idSchema.optional(),
  mode: z.enum(["append", "appendChild"]).optional(),
  config: z.record(z.any()).optional(),
  // code node error handling (create/update) — see utils/errorTrace.ts
  errorTrace: z.boolean().optional(),
  errorGuard: z.boolean().optional(),
  errorHandlerFlowId: z.string().min(1).optional(),
  // render operation
  focus: z.union([idSchema, z.array(idSchema)]).optional(),
  format: z.enum(["ascii", "mermaid", "both"]).optional(),
  legend: z.boolean().optional(),
  writeHtml: z.boolean().optional(),
  openInBrowser: z.boolean().optional(),
  // file-backed large fields (get / update / compare) — see tools/flowNodeFiles.ts
  fields: z.array(z.string().min(1).max(200)).max(50).optional(),
  saveTo: z
    .record(z.string().min(1).max(200), filePathSchema)
    .refine((r) => Object.keys(r).length <= 50, {
      message: "saveTo accepts at most 50 entries.",
    })
    .optional(),
  overwrite: z.boolean().optional(),
  configFromFiles: z
    .record(
      z
        .string()
        .regex(/^[A-Za-z0-9_]{1,64}$/)
        .refine((k) => !["__proto__", "constructor", "prototype"].includes(k), {
          message: "configFromFiles key is not allowed.",
        }),
      filePathSchema,
    )
    .refine((r) => Object.keys(r).length <= 20, {
      message: "configFromFiles accepts at most 20 entries.",
    })
    .optional(),
  field: z.string().min(1).max(200).optional(),
  file: filePathSchema.optional(),
});

// Tool 13: manage_packages
const packageResourceSelectionSchema = z.object({
  id: idSchema,
  import: z.boolean().optional(),
  strategy: z.enum(["replace", "re-identify"]).optional(),
});

const packageLocaleMappingSchema = z.object({
  packageLocaleId: idSchema,
  agentLocaleId: idSchema,
});

const packageResourceIdsSchema = z.array(idSchema).min(1);

export const managePackagesSchema = z.discriminatedUnion("operation", [
  z.object({
    operation: z.literal("list_exportable"),
    projectId: idSchema,
  }),
  z.object({
    operation: z.literal("upload_and_inspect"),
    projectId: idSchema,
    filePath: z.string().min(1),
    timeoutMs: z.number().int().min(1000).max(3600000).optional(),
  }),
  z.object({
    operation: z.literal("inspect"),
    projectId: idSchema,
    packageId: idSchema,
  }),
  z.object({
    operation: z.literal("import"),
    projectId: idSchema,
    packageId: idSchema,
    resources: z.array(packageResourceSelectionSchema).optional(),
    localeMapping: z.array(packageLocaleMappingSchema).optional(),
    waitForCompletion: z.boolean().optional(),
    timeoutMs: z.number().int().min(1000).max(3600000).optional(),
  }),
  z.object({
    operation: z.literal("export"),
    projectId: idSchema,
    resourceIds: packageResourceIdsSchema,
    dependencyResourceIds: z.array(idSchema).optional(),
    includeDependencies: z.boolean().optional(),
    name: z.string().min(1).max(200),
    description: z.string().optional(),
    outputPath: z.string().min(1).optional(),
    waitForCompletion: z.boolean().optional(),
    timeoutMs: z.number().int().min(1000).max(3600000).optional(),
  }),
  z.object({
    operation: z.literal("download"),
    projectId: idSchema,
    packageId: idSchema,
    outputPath: z.string().min(1).optional(),
  }),
  z.object({
    operation: z.literal("read_task"),
    projectId: idSchema,
    taskId: idSchema,
  }),
]);

// Tool 11: manage_webchat

const conversationStarterSchema = z.object({
  title: z.string(),
  type: z.enum(["postback", "url"]),
  value: z.string(),
});

const webchatColorsSchema = z
  .object({
    primaryColor: z.string().optional(),
    secondaryColor: z.string().optional(),
    chatBackground: z.string().optional(),
    agentMessageBg: z.string().optional(),
    userMessageBg: z.string().optional(),
    textLink: z.string().optional(),
  })
  .optional();

const webchatLayoutSchema = z
  .object({
    title: z.string().optional(),
    logoUrl: z.string().optional(),
    colors: webchatColorsSchema,
    chatWindowWidth: z.number().int().min(200).max(2000).optional(),
    botOutputMaxWidth: z.number().int().min(1).max(100).optional(),
    disableBotOutputBorder: z.boolean().optional(),
    maxInputRows: z.number().int().min(1).max(50).optional(),
    enableInputCollation: z.boolean().optional(),
    inputCollationTimeout: z.number().int().min(100).max(10000).optional(),
    dynamicImageAspectRatio: z.boolean().optional(),
    disableInputAutocomplete: z.boolean().optional(),
    enableGenericHtml: z.boolean().optional(),
    allowJsInHtml: z.boolean().optional(),
    allowJsInUrls: z.boolean().optional(),
    useAgentAvatars: z.boolean().optional(),
    botAvatarName: z.string().optional(),
    botAvatarLogoUrl: z.string().optional(),
    humanAvatarName: z.string().optional(),
    humanAvatarLogoUrl: z.string().optional(),
  })
  .optional();

const webchatBehaviorSchema = z
  .object({
    scrollingBehavior: z.enum(["alwaysScroll", "scrollToLastInput"]).optional(),
    collateStreamedOutputs: z.boolean().optional(),
    progressiveMessageRendering: z.boolean().optional(),
    renderMarkdown: z.boolean().optional(),
    enableTypingIndicator: z.boolean().optional(),
    inputPlaceholder: z.string().optional(),
    messageDelay: z.number().int().min(0).max(10000).optional(),
    focusInputAfterPostback: z.boolean().optional(),
    enableConnectionStatusIndicator: z.boolean().optional(),
    enableStt: z.boolean().optional(),
    enableTts: z.boolean().optional(),
    collectMetadata: z.boolean().optional(),
    displayAIAgentNotice: z.boolean().optional(),
    aiAgentNoticeText: z.string().optional(),
    enableScrollButton: z.boolean().optional(),
  })
  .optional();

const webchatStartBehaviorSchema = z
  .object({
    mode: z.enum(["textField", "button", "autoSend"]).optional(),
    textPayload: z.string().optional(),
    dataPayload: z.string().optional(),
    displayText: z.string().optional(),
    buttonTitle: z.string().optional(),
  })
  .optional();

const webchatHomeScreenSchema = z
  .object({
    enabled: z.boolean().optional(),
    welcomeText: z.string().optional(),
    backgroundImage: z.string().optional(),
    backgroundColor: z.string().optional(),
    startConversationButtonText: z.string().optional(),
    conversationStarters: z.array(conversationStarterSchema).max(5).optional(),
    previousConversations: z
      .object({
        enabled: z.boolean().optional(),
        enableDeleteAll: z.boolean().optional(),
        buttonText: z.string().optional(),
        title: z.string().optional(),
        startNewButtonText: z.string().optional(),
      })
      .optional(),
  })
  .optional();

const webchatTeaserMessageSchema = z
  .object({
    text: z.string().optional(),
    showInChat: z.boolean().optional(),
    conversationStarters: z.array(conversationStarterSchema).max(5).optional(),
  })
  .optional();

const webchatChatOptionsSchema = z
  .object({
    enabled: z.boolean().optional(),
    title: z.string().optional(),
    enableDeleteConversation: z.boolean().optional(),
    quickReplies: z
      .object({
        enabled: z.boolean().optional(),
        sectionTitle: z.string().optional(),
        items: z.array(conversationStarterSchema).max(5).optional(),
      })
      .optional(),
    textToSpeech: z
      .object({
        showToggle: z.boolean().optional(),
        toggleLabel: z.string().optional(),
        activateByDefault: z.boolean().optional(),
      })
      .optional(),
    rating: z
      .object({
        enabled: z.boolean().optional(),
        titleText: z.string().optional(),
        commentPlaceholder: z.string().optional(),
        submitButtonText: z.string().optional(),
        submittedBannerText: z.string().optional(),
      })
      .optional(),
    footer: z
      .object({
        enabled: z.boolean().optional(),
        items: z
          .array(z.object({ title: z.string(), url: z.string() }))
          .max(2)
          .optional(),
      })
      .optional(),
  })
  .optional();

const webchatPrivacyNoticeSchema = z
  .object({
    enabled: z.boolean().optional(),
    title: z.string().optional(),
    text: z.string().optional(),
    submitButton: z.string().optional(),
    policyLinkTitle: z.string().optional(),
    policyLinkUrl: z.string().optional(),
  })
  .optional();

const webchatBusinessHoursSchema = z
  .object({
    enabled: z.boolean().optional(),
    mode: z.enum(["inform", "disable", "hide"]).optional(),
    informationText: z.string().optional(),
    informationTitle: z.string().optional(),
    timezone: z.string().optional(),
    schedule: z
      .array(
        z.object({
          dayOfWeek: z.string(),
          startTime: z.string(),
          endTime: z.string(),
        }),
      )
      .optional(),
  })
  .optional();

const webchatUnreadMessagesSchema = z
  .object({
    enableTitleIndicator: z.boolean().optional(),
    enableBadge: z.boolean().optional(),
    enablePreview: z.boolean().optional(),
    enableSound: z.boolean().optional(),
  })
  .optional();

const webchatMaintenanceSchema = z
  .object({
    enabled: z.boolean().optional(),
    mode: z.enum(["inform", "disable", "hide"]).optional(),
    informationText: z.string().optional(),
    informationTitle: z.string().optional(),
  })
  .optional();

const webchatWatermarkSchema = z
  .object({
    type: z.enum(["default", "custom", "none"]).optional(),
    text: z.string().optional(),
    url: z.string().optional(),
  })
  .optional();

const webchatPersistentMenuSchema = z
  .object({
    enabled: z.boolean().optional(),
    title: z.string().optional(),
    items: z
      .array(z.object({ title: z.string(), payload: z.string() }))
      .optional(),
  })
  .optional();

const webchatAttachmentUploadSchema = z
  .object({
    enabled: z.boolean().optional(),
    dropzoneText: z.string().optional(),
  })
  .optional();

const webchatIconSchema = z
  .object({
    animation: z.enum(["none", "bounce", "swing", "pulse"]).optional(),
    animationInterval: z.number().min(1).max(60).optional(),
    animationSpeed: z.enum(["slow", "normal", "fast", "superfast"]).optional(),
  })
  .optional();

export const manageWebchatSchema = z.object({
  endpointId: idSchema.optional(),
  projectId: idSchema.optional(),
  flowId: z.string().optional(),
  name: z.string().min(1).max(200).optional(),
  stylePreset: z.enum(["classic", "modern", "slick"]).optional(),
  layout: webchatLayoutSchema,
  behavior: webchatBehaviorSchema,
  startBehavior: webchatStartBehaviorSchema,
  homeScreen: webchatHomeScreenSchema,
  teaserMessage: webchatTeaserMessageSchema,
  chatOptions: webchatChatOptionsSchema,
  privacyNotice: webchatPrivacyNoticeSchema,
  businessHours: webchatBusinessHoursSchema,
  unreadMessages: webchatUnreadMessagesSchema,
  maintenance: webchatMaintenanceSchema,
  watermark: webchatWatermarkSchema,
  persistentMenu: webchatPersistentMenuSchema,
  attachmentUpload: webchatAttachmentUploadSchema,
  webchatIcon: webchatIconSchema,
  customJson: z.string().optional(),
});

// Tool 14: manage_voice_gateway

const webrtcTranscriptionSchema = z
  .object({
    enabled: z.boolean().optional(),
    backgroundMode: z.enum(["transparent", "custom"]).optional(),
  })
  .optional();

const webrtcDemoPageSchema = z
  .object({
    background: z
      .object({
        mode: z.enum(["color", "image"]).optional(),
        color: z.string().optional(),
      })
      .optional(),
    position: z.enum(["centered", "bottom-right"]).optional(),
  })
  .optional();

const webrtcWidgetConfigSchema = z
  .object({
    label: z.string().optional(),
    theme: z.enum(["CLEAN_WHITE", "DARK_MODE", "AI_PURPLE"]).optional(),
    transcription: webrtcTranscriptionSchema,
    demoPage: webrtcDemoPageSchema,
    avatarLogoUrl: z.string().optional(),
    tagline: z.string().optional(),
  })
  .optional();

export const manageVoiceGatewaySchema = z.object({
  endpointId: idSchema.optional(),
  projectId: idSchema.optional(),
  flowId: z.string().optional(),
  name: z.string().min(1).max(200).optional(),
  webrtcWidgetConfig: webrtcWidgetConfigSchema,
});

// Tool 15: manage_settings
const speechProviderEnum = z.enum([
  "microsoft",
  "google",
  "aws",
  "deepgram",
  "elevenlabs",
]);

const knowledgeContentParserEnum = z.enum(["default", "legacy", "azure"]);

const manageVoicePreviewSettingsSchema = z.object({
  operation: z.literal("set_voice_preview"),
  projectId: idSchema,
  provider: speechProviderEnum,
  connectionId: z.string().optional(),
});

const manageKnowledgeAiSettingsSchema = z
  .object({
    operation: z.literal("set_knowledge_ai"),
    projectId: idSchema,
    knowledgeSearchModelId: z.string().optional(),
    answerExtractionModelId: z.string().optional(),
    contentParser: knowledgeContentParserEnum.optional(),
    azureDIConnectionId: z.string().optional(),
  })
  .refine(
    (data) =>
      data.knowledgeSearchModelId !== undefined ||
      data.answerExtractionModelId !== undefined ||
      data.contentParser !== undefined ||
      data.azureDIConnectionId !== undefined,
    {
      message: "Provide at least one Knowledge AI setting to update.",
      path: ["operation"],
    },
  )
  .refine(
    (data) => data.contentParser !== "azure" || !!data.azureDIConnectionId,
    {
      message:
        "azureDIConnectionId is required when contentParser is set to azure.",
      path: ["azureDIConnectionId"],
    },
  )
  .refine(
    (data) =>
      !data.contentParser ||
      data.contentParser === "azure" ||
      data.azureDIConnectionId === undefined,
    {
      message:
        "azureDIConnectionId can only be provided when contentParser is azure or omitted.",
      path: ["azureDIConnectionId"],
    },
  );

const getKnowledgeAiSettingsSchema = z.object({
  operation: z.literal("get_knowledge_ai"),
  projectId: idSchema,
});

export const manageSettingsSchema = z.union([
  manageVoicePreviewSettingsSchema,
  manageKnowledgeAiSettingsSchema,
  getKnowledgeAiSettingsSchema,
]);

// Tool 16: audit_voice_agent
export const auditVoiceAgentSchema = z
  .object({
    aiAgentId: idSchema.optional(),
    flowId: idSchema.optional(),
    endpointId: idSchema.optional(),
    projectId: idSchema.optional(),
    apply: z.boolean().optional(),
    only: z.array(z.string()).optional(),
  })
  .refine((d) => d.aiAgentId || d.flowId, {
    message: "Either aiAgentId or flowId must be provided",
    path: ["aiAgentId"],
  });

// Tool 17: manage_snapshots
//
// `create` deliberately takes a short `label`, not a full `name`: the plugin
// owns the name so the "[AI Backup] " marker prefix can never be omitted by the
// caller, and so the timestamp that keeps names unique is always present.
const snapshotTimeoutSchema = z.number().int().min(1000).max(3600000);

export const manageSnapshotsSchema = z.discriminatedUnion("operation", [
  z.object({
    operation: z.literal("list"),
    projectId: idSchema,
    ...paginationSchema,
  }),
  z.object({
    operation: z.literal("create"),
    projectId: idSchema,
    label: z.string().min(1).max(120).optional(),
    confirmDeleteOldest: z.boolean().optional(),
    waitForCompletion: z.boolean().optional(),
    timeoutMs: snapshotTimeoutSchema.optional(),
  }),
  z.object({
    operation: z.literal("restore"),
    projectId: idSchema,
    snapshotId: idSchema,
    confirm: z.boolean().optional(),
    waitForCompletion: z.boolean().optional(),
    timeoutMs: snapshotTimeoutSchema.optional(),
  }),
  z.object({
    operation: z.literal("delete"),
    projectId: idSchema,
    snapshotId: idSchema,
    waitForCompletion: z.boolean().optional(),
    timeoutMs: snapshotTimeoutSchema.optional(),
  }),
  z.object({
    operation: z.literal("decline"),
    projectId: idSchema,
  }),
  z.object({
    operation: z.literal("read_task"),
    projectId: idSchema,
    taskId: idSchema,
  }),
]);

// Tool 18: manage_a2a_server
const a2aSkillSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
});

export const manageA2AServerSchema = z.object({
  endpointId: idSchema.optional(),
  projectId: idSchema.optional(),
  flowId: z.string().optional(),
  name: z.string().min(1).max(200).optional(),
  agentName: z.string().optional(),
  agentDescription: z.string().optional(),
  skills: z
    .array(a2aSkillSchema)
    .refine(
      (skills) => new Set(skills.map((s) => s.id)).size === skills.length,
      {
        message: "Each skill id must be unique within the Agent Card",
      },
    )
    .optional(),
  enableStreaming: z.boolean().optional(),
  authenticationType: z.enum(["none", "apiKey"]).optional(),
});

// Tool 20: manage_intents (NLU intents of a flow; logic in src/tools/intents/)
const intentRefSchema = z.string().min(1).max(300);
const intentSentencesSchema = z.array(z.string().min(1).max(500)).max(200);
const MAX_IMPORT_SENTENCES = 10000;

export const manageIntentsSchema = z
  .discriminatedUnion("operation", [
    z.object({
      operation: z.literal("list"),
      flowId: idSchema,
      includeSentenceCounts: z.boolean().optional(),
      includeStatus: z.boolean().optional(),
    }),
    z.object({
      operation: z.literal("get"),
      flowId: idSchema,
      intent: intentRefSchema,
      includeSentences: z.boolean().optional(),
    }),
    z.object({ operation: z.literal("export_tree"), flowId: idSchema }),
    z.object({ operation: z.literal("model_state"), flowId: idSchema }),
    z.object({
      operation: z.literal("below_minimum"),
      flowId: idSchema,
      min: z.number().int().min(1).max(200).optional(),
    }),
    z.object({
      operation: z.literal("compare"),
      flowId: idSchema,
      file: z.string().min(1).max(500),
    }),
    z.object({
      operation: z.literal("create"),
      flowId: idSchema,
      projectId: idSchema,
      name: z.string().min(1).max(200),
      parent: intentRefSchema.optional(),
      childFeatures: z.boolean().optional(),
      priority: z.enum(["parents", "children"]).optional(),
      sentences: intentSentencesSchema.optional(),
    }),
    z.object({
      operation: z.literal("update"),
      flowId: idSchema,
      projectId: idSchema,
      intent: intentRefSchema,
      name: z.string().min(1).max(200).optional(),
      childFeatures: z.boolean().optional(),
      priority: z.enum(["parents", "children"]).optional(),
    }),
    z.object({
      operation: z.literal("move"),
      flowId: idSchema,
      projectId: idSchema,
      intent: intentRefSchema,
      parent: intentRefSchema.nullable(),
    }),
    z.object({
      operation: z.literal("delete"),
      flowId: idSchema,
      projectId: idSchema,
      intent: intentRefSchema,
    }),
    z.object({
      operation: z.literal("import_sentences"),
      flowId: idSchema,
      projectId: idSchema,
      mode: z.enum(["add", "replace"]),
      deadlineSeconds: z.number().int().min(1).max(600).optional(),
      entries: z
        .array(
          z.object({
            intent: intentRefSchema,
            sentences: intentSentencesSchema,
          }),
        )
        .min(1)
        .max(500),
    }),
    z.object({
      operation: z.literal("build"),
      flowId: idSchema,
      projectId: idSchema,
      mode: z.enum(["full", "quick"]).optional(),
      waitSeconds: z.number().int().min(0).max(300).optional(),
    }),
  ])
  .superRefine((d, ctx) => {
    if (
      d.operation === "update" &&
      d.name === undefined &&
      d.childFeatures === undefined &&
      d.priority === undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "update needs at least one of name, childFeatures, priority",
        path: ["name"],
      });
    }
    if (
      d.operation === "import_sentences" &&
      d.entries.reduce((n, e) => n + e.sentences.length, 0) >
        MAX_IMPORT_SENTENCES
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `At most ${MAX_IMPORT_SENTENCES} sentences per call`,
        path: ["entries"],
      });
    }
  });
