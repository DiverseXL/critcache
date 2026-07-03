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
const BTL_BASE_URL = process.env.BTL_BASE_URL ?? "https://runtime.badtheorylabs.com";
const BTL_API_KEY = process.env.BTL_API_KEY;
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
// ---------------------------------------------------------------------------
// Header helpers
// ---------------------------------------------------------------------------
/**
 * Reads a numeric header, returning undefined if missing or not parseable
 * as a number. Keeps callers from crashing on a renamed/missing header.
 */
function readNumericHeader(headers, name) {
    const raw = headers.get(name);
    if (raw === null)
        return undefined;
    const parsed = Number.parseFloat(raw);
    return Number.isNaN(parsed) ? undefined : parsed;
}
function readUsageInfo(headers) {
    return {
        cacheTier: headers.get("x-btl-cache-tier") ?? undefined,
        benchmarkCostUsd: readNumericHeader(headers, "x-btl-benchmark-cost"),
        customerChargeUsd: readNumericHeader(headers, "x-btl-customer-charge"),
        savedUsd: readNumericHeader(headers, "x-btl-saved"),
    };
}
// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------
/**
 * Attempts to parse the model's text content as a FileAnalysis JSON object.
 * Strips markdown code fences defensively, in case the model wraps its
 * output despite instructions not to.
 */
function parseAnalysis(rawText) {
    const stripped = rawText
        .trim()
        .replace(/^```(?:json)?/i, "")
        .replace(/```$/, "")
        .trim();
    const obj = JSON.parse(stripped);
    if (typeof obj !== "object" ||
        obj === null ||
        typeof obj.role !== "string" ||
        typeof obj.complexity !== "string" ||
        typeof obj.test_gaps !== "string" ||
        typeof obj.security_note !== "string" ||
        typeof obj.summary !== "string") {
        throw new Error("Parsed JSON does not match expected FileAnalysis shape");
    }
    return obj;
}
/**
 * Attempts to parse the model's text content as a RepoSynthesis JSON object.
 * Same defensive fence-stripping as parseAnalysis.
 */
function parseSynthesis(rawText) {
    const stripped = rawText
        .trim()
        .replace(/^```(?:json)?/i, "")
        .replace(/```$/, "")
        .trim();
    const obj = JSON.parse(stripped);
    if (typeof obj !== "object" ||
        obj === null ||
        typeof obj.architecture_overview !== "string" ||
        !Array.isArray(obj.top_risks) ||
        !Array.isArray(obj.next_steps)) {
        throw new Error("Parsed JSON does not match expected RepoSynthesis shape");
    }
    return obj;
}
// ---------------------------------------------------------------------------
// Shared BTL Runtime request helper
// ---------------------------------------------------------------------------
const EMPTY_USAGE = {
    cacheTier: undefined,
    benchmarkCostUsd: undefined,
    customerChargeUsd: undefined,
    savedUsd: undefined,
};
/**
 * Shared request/response handling for any BTL Runtime chat completion call.
 * Both per-file analysis and the repo-level synthesis pass go through this —
 * the only difference between callers is the system prompt, the user message,
 * and how the resulting text is parsed.
 */
async function callBtlRuntime(systemPrompt, userMessage, parse) {
    if (!BTL_API_KEY) {
        return {
            parsed: null,
            usage: EMPTY_USAGE,
            requestError: "BTL_API_KEY is not set. Export it before running critcache.",
        };
    }
    let response;
    try {
        response = await fetch(`${BTL_BASE_URL}/v1/chat/completions`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${BTL_API_KEY}`,
            },
            body: JSON.stringify({
                model: "auto", // confirm BTL's expected model identifier once key is live
                messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: userMessage },
                ],
                temperature: 0,
            }),
        });
    }
    catch (err) {
        return {
            parsed: null,
            usage: EMPTY_USAGE,
            requestError: `Network error calling BTL Runtime: ${err.message}`,
        };
    }
    const usage = readUsageInfo(response.headers);
    if (!response.ok) {
        const bodyText = await response.text().catch(() => "");
        return {
            parsed: null,
            usage,
            requestError: `BTL Runtime returned ${response.status}: ${bodyText.slice(0, 300)}`,
        };
    }
    const data = (await response.json());
    const rawText = data?.choices?.[0]?.message?.content;
    if (!rawText) {
        return {
            parsed: null,
            usage,
            parseError: "No message content in BTL Runtime response.",
        };
    }
    try {
        const parsed = parse(rawText);
        return { parsed, usage };
    }
    catch (err) {
        return {
            parsed: null,
            usage,
            parseError: `Failed to parse model output as JSON: ${err.message}`,
        };
    }
}
// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
/**
 * Sends one file's content to BTL Runtime for analysis.
 * Never throws — all failure modes are reported back on the result object
 * so a single bad file never crashes the whole repo scan.
 */
export async function analyzeFile(relPath, content) {
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
export async function synthesize(fileAnalyses) {
    const userMessage = JSON.stringify(fileAnalyses, null, 2);
    const outcome = await callBtlRuntime(SYNTHESIS_SYSTEM_PROMPT, userMessage, parseSynthesis);
    return {
        synthesis: outcome.parsed,
        usage: outcome.usage,
        parseError: outcome.parseError,
        requestError: outcome.requestError,
    };
}
//# sourceMappingURL=btl-client.js.map