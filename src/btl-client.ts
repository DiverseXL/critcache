/**
 * BTL Runtime client.
 *
 * One responsibility: send a file's content through BTL Runtime's
 * /v1/chat/completions endpoint using a FIXED system prompt + schema,
 * and return both the parsed analysis and the raw savings/cache headers.
 *
 * The system prompt below must stay byte-identical across every call —
 * that repetition is exactly what lets BTL's exact/prefix caching kick in.
 * Do not template or vary this string per file.
 */

// Confirmed against BTL's own published docs/smoke-test example:
// base URL is api.badtheorylabs.com, NOT runtime.badtheorylabs.com.
// Their docs also use GATEWAY_API_KEY as the env var name — we check that
// first and fall back to BTL_API_KEY in case the hackathon issues it
// under a different name.
const BTL_BASE_URL = process.env.BTL_BASE_URL ?? "https://api.badtheorylabs.com/v1";
const BTL_API_KEY = process.env.GATEWAY_API_KEY ?? process.env.BTL_API_KEY;

// When set, every call below is simulated locally instead of hitting BTL
// Runtime — no network, no key required, no credits spent. This exists so
// the full CLI (including the two-pass `compare` flow) can be rehearsed
// end-to-end before a real key is available, and as a safe demo fallback
// if the network drops mid-presentation.
const MOCK_MODE = process.env.CRITCACHE_MOCK === "1";

const SYSTEM_PROMPT = `You are a careful, senior code reviewer analyzing a single file from a larger codebase.

Respond with ONLY a JSON object, no markdown fences, no commentary, matching this exact shape:

{
  "role": "<one short phrase describing this file's role in the architecture>",
  "complexity": "<low|medium|high>",
  "test_gaps": "<one sentence on missing or weak test coverage, or 'none apparent'>",
  "security_note": "<one sentence flagging a concrete concern, or 'none apparent'>",
  "summary": "<one sentence summary of what this file does>"
}

Be concrete and specific to the actual code shown. Do not pad with generic advice.`;

const SYNTHESIS_SYSTEM_PROMPT = `You are a senior engineer producing a repo-level summary from a set of individual file reviews.

You will be given a JSON array of per-file analysis objects, each with: path, role, complexity, test_gaps, security_note, summary.

Respond with ONLY a JSON object, no markdown fences, no commentary, matching this exact shape:

{
  "architecture_overview": "<2-3 sentences describing the overall shape of the codebase based on the files reviewed>",
  "top_risks": ["<risk 1>", "<risk 2>", "<risk 3>"],
  "next_steps": ["<concrete suggestion 1>", "<concrete suggestion 2>", "<concrete suggestion 3>"]
}

Base every claim strictly on the per-file data provided. Do not invent files or details not present in the input. Keep top_risks and next_steps to at most 5 items each, fewer if the input doesn't support more.`;

/** Shape of the structured analysis we expect back from the model. */
export interface FileAnalysis {
  role: string;
  complexity: "low" | "medium" | "high" | string;
  test_gaps: string;
  security_note: string;
  summary: string;
}

/** Savings/cache metadata read off the BTL Runtime response headers. */
export interface BtlUsageInfo {
  cacheTier: string | undefined;
  benchmarkCostUsd: number | undefined;
  customerChargeUsd: number | undefined;
  savedUsd: number | undefined;
  /** Confirmed real header per BTL's own docs — useful for support/debugging if a call misbehaves. */
  requestId: string | undefined;
  /** Client-side measured round-trip time for this call, in milliseconds. */
  responseTimeMs: number | undefined;
}

export interface AnalyzeFileResult {
  analysis: FileAnalysis | null;
  usage: BtlUsageInfo;
  /** Set if the model response couldn't be parsed as the expected JSON shape. */
  parseError?: string;
  /** Set if the HTTP call itself failed (network, auth, non-2xx). */
  requestError?: string;
}

/** Repo-level findings produced by the synthesis pass over all file analyses. */
export interface RepoSynthesis {
  architecture_overview: string;
  top_risks: string[];
  next_steps: string[];
}

export interface SynthesizeResult {
  synthesis: RepoSynthesis | null;
  usage: BtlUsageInfo;
  parseError?: string;
  requestError?: string;
}

/**
 * Reads a numeric header, returning undefined if missing or not parseable
 * as a number. Keeps callers from crashing on a renamed/missing header.
 */
function readNumericHeader(headers: Headers, name: string): number | undefined {
  const raw = headers.get(name);
  if (raw === null) return undefined;
  const parsed = Number.parseFloat(raw);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function readUsageInfo(headers: Headers): BtlUsageInfo {
  return {
    cacheTier: headers.get("x-btl-cache-tier") ?? undefined,
    benchmarkCostUsd: readNumericHeader(headers, "x-btl-benchmark-cost"),
    customerChargeUsd: readNumericHeader(headers, "x-btl-customer-charge"),
    savedUsd: readNumericHeader(headers, "x-btl-saved"),
    requestId: headers.get("x-btl-request-id") ?? undefined,
    responseTimeMs: undefined,
  };
}

/**
 * Attempts to parse the model's text content as a FileAnalysis JSON object.
 * Strips markdown code fences defensively, in case the model wraps its
 * output despite instructions not to.
 */
function parseAnalysis(rawText: string): FileAnalysis {
  const stripped = rawText
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/, "")
    .trim();

  const obj = JSON.parse(stripped);

  if (
    typeof obj !== "object" ||
    obj === null ||
    typeof obj.role !== "string" ||
    typeof obj.complexity !== "string" ||
    typeof obj.test_gaps !== "string" ||
    typeof obj.security_note !== "string" ||
    typeof obj.summary !== "string"
  ) {
    throw new Error("Parsed JSON does not match expected FileAnalysis shape");
  }

  return obj as FileAnalysis;
}

/**
 * Attempts to parse the model's text content as a RepoSynthesis JSON object.
 * Same defensive fence-stripping as parseAnalysis.
 */
function parseSynthesis(rawText: string): RepoSynthesis {
  const stripped = rawText
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/, "")
    .trim();

  const obj = JSON.parse(stripped);

  if (
    typeof obj !== "object" ||
    obj === null ||
    typeof obj.architecture_overview !== "string" ||
    !Array.isArray(obj.top_risks) ||
    !Array.isArray(obj.next_steps)
  ) {
    throw new Error("Parsed JSON does not match expected RepoSynthesis shape");
  }

  return obj as RepoSynthesis;
}

/**
 * Sends one file's content to BTL Runtime for analysis.
 * Never throws — all failure modes are reported back on the result object
 * so a single bad file never crashes the whole repo scan.
 */
const EMPTY_USAGE: BtlUsageInfo = {
  cacheTier: undefined,
  benchmarkCostUsd: undefined,
  customerChargeUsd: undefined,
  savedUsd: undefined,
  requestId: undefined,
  responseTimeMs: undefined,
};

interface BtlCallOutcome<T> {
  parsed: T | null;
  usage: BtlUsageInfo;
  parseError?: string;
  requestError?: string;
}

/**
 * Shared request/response handling for any BTL Runtime chat completion call.
 * Both per-file analysis and the repo-level synthesis pass go through this —
 * the only difference between callers is the system prompt, the user message,
 * and how the resulting text is parsed.
 */
async function callBtlRuntime<T>(
  systemPrompt: string,
  userMessage: string,
  parse: (rawText: string) => T
): Promise<BtlCallOutcome<T>> {
  const startTime = performance.now();

  if (!BTL_API_KEY) {
    return {
      parsed: null,
      usage: { ...EMPTY_USAGE, responseTimeMs: Math.round(performance.now() - startTime) },
      requestError: "GATEWAY_API_KEY is not set. Export it before running critcache (BTL_API_KEY also works).",
    };
  }

  let response: Response;
  try {
    response = await fetch(`${BTL_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${BTL_API_KEY}`,
      },
      body: JSON.stringify({
        // BTL's own docs smoke-test against "gpt-4.1-mini" as a real,
        // concrete model name — there's no confirmed "auto" alias.
        // Override via BTL_MODEL once you know what your dashboard shows.
        model: process.env.BTL_MODEL ?? "gpt-4.1-mini",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage },
        ],
        temperature: 0,
      }),
    });
  } catch (err) {
    return {
      parsed: null,
      usage: { ...EMPTY_USAGE, responseTimeMs: Math.round(performance.now() - startTime) },
      requestError: `Network error calling BTL Runtime: ${(err as Error).message}`,
    };
  }

  const usage = readUsageInfo(response.headers);

  if (!response.ok) {
    const bodyText = await response.text().catch(() => "");
    return {
      parsed: null,
      usage: { ...usage, responseTimeMs: Math.round(performance.now() - startTime) },
      requestError: `BTL Runtime returned ${response.status}: ${bodyText.slice(0, 300)}`,
    };
  }

  const data: any = await response.json();
  const rawText: string | undefined = data?.choices?.[0]?.message?.content;

  if (!rawText) {
    return {
      parsed: null,
      usage: { ...usage, responseTimeMs: Math.round(performance.now() - startTime) },
      parseError: "No message content in BTL Runtime response.",
    };
  }

  try {
    const parsed = parse(rawText);
    return { parsed, usage: { ...usage, responseTimeMs: Math.round(performance.now() - startTime) } };
  } catch (err) {
    return {
      parsed: null,
      usage: { ...usage, responseTimeMs: Math.round(performance.now() - startTime) },
      parseError: `Failed to parse model output as JSON: ${(err as Error).message}`,
    };
  }
}

// --- Mock mode simulation ---
//
// Tracks how many times each file path has been "seen" within this process,
// so a second analyze/compare pass realistically reports cache hits for
// files already seen in the first pass — mirroring what BTL's exact/prefix
// caching should do for byte-identical repeat prompts. State is per-process
// and intentionally not persisted, since mock mode is for rehearsal, not
// for producing numbers that should be trusted as real savings data.
const mockSeenCount = new Map<string, number>();

function mockDelay(): Promise<number> {
  const ms = 150 + Math.random() * 350;
  return new Promise((resolve) => setTimeout(() => resolve(Math.round(ms)), ms));
}

async function mockAnalyzeFile(relPath: string, content: string): Promise<AnalyzeFileResult> {
  const responseTimeMs = await mockDelay();

  const seen = (mockSeenCount.get(relPath) ?? 0) + 1;
  mockSeenCount.set(relPath, seen);
  const isHit = seen > 1;

  const lineCount = content.split("\n").length;
  const complexity: FileAnalysis["complexity"] = lineCount > 150 ? "high" : lineCount > 50 ? "medium" : "low";

  return {
    analysis: {
      role: `[mock] plays a role in ${relPath.split("/").pop()}`,
      complexity,
      test_gaps: "[mock] no real analysis performed — running in mock mode",
      security_note: "[mock] none apparent",
      summary: `[mock] simulated summary for ${relPath}`,
    },
    usage: {
      cacheTier: isHit ? "exact_response_cache" : "none",
      benchmarkCostUsd: 0.012,
      customerChargeUsd: isHit ? 0.0007 : 0.007,
      savedUsd: isHit ? 0.0113 : 0.005,
      requestId: `mock_${Math.random().toString(36).slice(2, 10)}`,
      responseTimeMs,
    },
  };
}

async function mockSynthesize(
  fileAnalyses: Array<{ path: string } & FileAnalysis>
): Promise<SynthesizeResult> {
  const responseTimeMs = await mockDelay();

  return {
    synthesis: {
      architecture_overview: `[mock] Simulated repo-level summary covering ${fileAnalyses.length} reviewed file(s). Run with a real GATEWAY_API_KEY for an actual synthesis.`,
      top_risks: ["[mock] this is simulated output — set GATEWAY_API_KEY and unset CRITCACHE_MOCK for real findings"],
      next_steps: ["[mock] unset CRITCACHE_MOCK once a real key is available"],
    },
    usage: {
      cacheTier: "none",
      benchmarkCostUsd: 0.02,
      customerChargeUsd: 0.014,
      savedUsd: 0.006,
      requestId: `mock_${Math.random().toString(36).slice(2, 10)}`,
      responseTimeMs,
    },
  };
}

export async function analyzeFile(relPath: string, content: string): Promise<AnalyzeFileResult> {
  if (MOCK_MODE) return mockAnalyzeFile(relPath, content);

  const userMessage = `File: ${relPath}\n\n\`\`\`\n${content}\n\`\`\``;
  const outcome = await callBtlRuntime(SYSTEM_PROMPT, userMessage, parseAnalysis);

  return {
    analysis: outcome.parsed,
    usage: outcome.usage,
    parseError: outcome.parseError,
    requestError: outcome.requestError,
  };
}

/**
 * One extra call: takes every successfully-parsed per-file analysis and asks
 * the model to produce repo-level findings. Expects an array of
 * { path, ...FileAnalysis } objects as input.
 */
export async function synthesize(
  fileAnalyses: Array<{ path: string } & FileAnalysis>
): Promise<SynthesizeResult> {
  if (MOCK_MODE) return mockSynthesize(fileAnalyses);

  const userMessage = JSON.stringify(fileAnalyses, null, 2);
  const outcome = await callBtlRuntime(SYNTHESIS_SYSTEM_PROMPT, userMessage, parseSynthesis);

  return {
    synthesis: outcome.parsed,
    usage: outcome.usage,
    parseError: outcome.parseError,
    requestError: outcome.requestError,
  };
}

// --- Catalog + account endpoints ---

export interface BtlModel {
  id: string;
  object: string;
  created?: number;
  owned_by?: string;
}

export interface FetchModelsResult {
  models: BtlModel[];
  requestError?: string;
}

/**
 * GET /v1/models — returns the public model slugs BTL Runtime supports.
 * Used by the `critcache models` command so developers know exactly
 * what to pass as BTL_MODEL without guessing.
 */
export async function fetchModels(): Promise<FetchModelsResult> {
  if (MOCK_MODE) {
    return {
      models: [
        { id: "btl-2", object: "model", owned_by: "btl" },
        { id: "btl-frontier", object: "model", owned_by: "btl" },
        { id: "gpt-4.1-mini", object: "model", owned_by: "openai" },
        { id: "gpt-4o-mini", object: "model", owned_by: "openai" },
        { id: "claude-3-5-haiku", object: "model", owned_by: "anthropic" },
      ],
    };
  }

  if (!BTL_API_KEY) {
    return {
      models: [],
      requestError: "GATEWAY_API_KEY is not set. Export it before running critcache.",
    };
  }

  let response: Response;
  try {
    response = await fetch(`${BTL_BASE_URL}/models`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${BTL_API_KEY}`,
      },
    });
  } catch (err) {
    return {
      models: [],
      requestError: `Network error fetching models: ${(err as Error).message}`,
    };
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    return {
      models: [],
      requestError: `BTL Runtime returned ${response.status}: ${body.slice(0, 200)}`,
    };
  }

  const data: any = await response.json();
  const models: BtlModel[] = Array.isArray(data?.data) ? data.data : [];
  return { models };
}

export interface BtlUsageSummary {
  totalRequests?: number;
  totalSpend?: number;
  totalSaved?: number;
  cachedTokens?: number;
  cacheHitRate?: number;
  period?: string;
}

export interface FetchStatsResult {
  summary: BtlUsageSummary | null;
  raw: Record<string, unknown> | null;
  requestError?: string;
}

/**
 * GET /v1/usage/summary — returns cumulative spend and savings across
 * ALL requests in this workspace, not just the current run.
 * Used by the `critcache stats` command to show total savings over time.
 */
export async function fetchStats(): Promise<FetchStatsResult> {
  if (MOCK_MODE) {
    return {
      summary: {
        totalRequests: 20,
        totalSpend: 0.0059,
        totalSaved: 0.09,
        cachedTokens: 4992,
        cacheHitRate: 55,
        period: "all time",
      },
      raw: null,
    };
  }

  if (!BTL_API_KEY) {
    return {
      summary: null,
      raw: null,
      requestError: "GATEWAY_API_KEY is not set. Export it before running critcache.",
    };
  }

  let response: Response;
  try {
    response = await fetch(`${BTL_BASE_URL}/usage/summary`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${BTL_API_KEY}`,
      },
    });
  } catch (err) {
    return {
      summary: null,
      raw: null,
      requestError: `Network error fetching usage summary: ${(err as Error).message}`,
    };
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    return {
      summary: null,
      raw: null,
      requestError: `BTL Runtime returned ${response.status}: ${body.slice(0, 200)}`,
    };
  }

  const data: any = await response.json();

  const summary: BtlUsageSummary = {
    totalRequests: data?.request_count,
    totalSpend: data?.benchmark_direct_cost,
    totalSaved: data?.customer_saved,
    cachedTokens: data?.cached_input_tokens,
    cacheHitRate: data?.cache_tiers
      ? ((data.cache_tiers.exact_response ?? 0) / (data.request_count ?? 1)) * 100
      : undefined,
    period: "all time",
  };

  return { summary, raw: data as Record<string, unknown> };
}