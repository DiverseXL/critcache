# critcache

**Fan out parallel AI code-review agents across your repo through BTL Runtime — and watch the cache savings land live in your terminal.**

```
  ▄▄▄ ▄▄▄ ▄ ▄▄▄ ▄▄▄ ▄▄▄ ▄▄▄ ▄ ▄ ▄▄▄
  █   █▄▄ █  █  █   █▀█ █   █▀█ █▀▀
  ▀▀▀ ▀   ▀  ▀  ▀▀▀ ▀ ▀ ▀▀▀ ▀ ▀ ▀▀▀
  v0.1.1 · parallel AI code review · powered by BTL Runtime
```

[![npm](https://img.shields.io/npm/v/critcache)](https://www.npmjs.com/package/critcache)
[![license](https://img.shields.io/npm/l/critcache)](./LICENSE)
[![node](https://img.shields.io/node/v/critcache)](https://nodejs.org)

---

## What is critcache?

critcache is a CLI tool that:

1. Walks your repo and picks the most relevant source files
2. Fires **parallel AI code-review agents** across every file simultaneously through BTL Runtime's `/v1/chat/completions` endpoint
3. Reads `x-btl-cache-tier`, `x-btl-benchmark-cost`, `x-btl-customer-charge`, and `x-btl-saved` off every response — live, per file, as results land
4. Runs the same analysis **twice** with `compare` to prove BTL's cache warming in real time

The whole product is the savings proof. Every call goes through BTL Runtime. Every header gets surfaced. Nothing is hidden.

---

## Quick start — no key needed

```bash
CRITCACHE_MOCK=1 npx critcache analyze .
```

```bash
# Windows PowerShell
$env:CRITCACHE_MOCK = "1"
npx critcache analyze .
```

Mock mode runs the full pipeline locally — file discovery, parallel agents, live renderer, synthesis pass, and report writer — with simulated cache hit behavior. Pass 1 shows misses, pass 2 shows hits. The cold-to-warm story works correctly without spending a single credit.

---

## Full experience — BTL Runtime key required

Get a free key at **https://runtime.badtheorylabs.com**

```bash
# Mac/Linux
GATEWAY_API_KEY=your_btl_key npx critcache analyze .

# Windows PowerShell
$env:GATEWAY_API_KEY = "your_btl_key"
npx critcache analyze .
```

---

## Installation

No global install required. Run directly with npx:

```bash
npx critcache analyze .
```

Or install globally:

```bash
npm install -g critcache
critcache analyze .
```

**Requirements:** Node.js v18+

---

## Commands

### `analyze <repo>`

Walks the repo, picks the top files by relevance, fires parallel AI review agents through BTL Runtime, and prints live cache-tier and response-time data per file. Writes a full report to `critcache-report.md`.

```bash
npx critcache analyze .
npx critcache analyze ./my-project --max-files 10 --concurrency 4
```

**Options:**

| Option | Default | Description |
|---|---|---|
| `--max-files, -m` | 20 | Maximum files to analyze |
| `--concurrency, -c` | 6 | Parallel requests at once |
| `--output, -o` | critcache-report.md | Report output path |

**Live output:**

```
  [✦] critcache v0.1.1
  parallel AI code review · powered by BTL Runtime
  ─────────────────────────────────────────────────

  ● src/btl-client.ts   [hit 563ms]   $0.0000 saved
  ● src/runner.ts       [hit 560ms]   $0.0000 saved
  ◐ src/walker.ts       [miss 3500ms] $0.0000 saved
  ● src/cli.ts          [hit 564ms]   $0.0000 saved

  Synthesizing repo-level findings…

  ┌─────────────────────────────┬─────────┐
  │ Metric                      │ Value   │
  ├─────────────────────────────┼─────────┤
  │ Files analyzed              │ 4       │
  │ Cache hits                  │ 3       │
  │ Cache misses                │ 1       │
  └─────────────────────────────┴─────────┘

  Full report written to critcache-report.md
```

---

### `compare <repo>`

Runs the full analysis **twice, back to back**, on the same file set. Pass 1 is cold. Pass 2 is warm. Prints a before/after delta table showing cache hit rate, cost, and wall time for both passes.

```bash
npx critcache compare .
npx critcache compare ./my-project --max-files 5
```

**Real results from a live BTL Runtime run:**

```
  — Pass 1: cold run —
  ● src/btl-client.ts [miss 4469ms]
  ● src/cli.ts        [miss 2342ms]
  ● src/runner.ts     [miss 2530ms]
  Pass 1 completed in 8.7s

  — Pass 2: warm run (same files, same prompts) —
  ● src/btl-client.ts [hit 1093ms]
  ● src/cli.ts        [hit 1600ms]
  ● src/runner.ts     [hit 1619ms]
  Pass 2 completed in 3.7s

  ┌────────────────┬───────────────┬───────────────┬─────────┐
  │ Metric         │ Pass 1 (cold) │ Pass 2 (warm) │ Δ       │
  ├────────────────┼───────────────┼───────────────┼─────────┤
  │ Cache hit rate │ 0%            │ 67%           │ +67 pts │
  │ Wall time      │ 8.7s          │ 3.7s          │ -57.7%  │
  └────────────────┴───────────────┴───────────────┴─────────┘

  Cache hit rate jumped from 0% to 67% on the warm pass.
```

---

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `GATEWAY_API_KEY` | Yes* | — | Your BTL Runtime API key |
| `BTL_BASE_URL` | No | `https://api.badtheorylabs.com/v1` | BTL Runtime base URL |
| `BTL_MODEL` | No | `btl-2` | Model to use for analysis |
| `CRITCACHE_MOCK` | No | — | Set to `1` to enable mock mode |

*Not required when `CRITCACHE_MOCK=1` is set.

---

## How BTL Runtime caching works

critcache sends every file through the **same fixed system prompt and JSON schema** — this is an explicit architectural decision, not an accident. Keeping the instruction scaffolding byte-identical across every call is what makes BTL Runtime's exact and prefix caching fire consistently.

On the first run, calls are cache misses and routed live to the model. On subsequent runs, the identical prompt prefix hits BTL's cache and returns in under 1 second instead of 3-5 seconds.

Every response includes headers critcache reads and surfaces live:

```
x-btl-cache-tier       — cache status per call
x-btl-benchmark-cost   — what you would have paid without caching
x-btl-customer-charge  — what you actually paid
x-btl-saved            — the difference, per call
```

The BTL Runtime dashboard confirmed **50% cache hit rate across 6 requests** in testing, with cached calls returning in ~560ms vs ~3,500ms for uncached calls — a 6x speed improvement per cached call.

Run `compare` to see this live on your own repo.

---

## Why the fixed prompt matters

Most tools that call an LLM gateway use dynamic, variable prompts — different context, different instructions, different output formats per call. This means the cache never warms up because every request looks different to the cache layer.

critcache is designed the opposite way: one fixed system prompt, one fixed JSON schema, variable only in the file content passed as the user message. This means:

- The system prompt prefix is identical on every call → prefix cache fires
- The full request is identical on repeat runs → exact cache fires
- Cache hit rate climbs predictably with repeated use

This is the core BTL Runtime integration insight: **design your prompt architecture around the cache, not after it.**

---

## Output

Every `analyze` run writes a `critcache-report.md` to your current directory containing:

- Savings summary table (files analyzed, cache hits/misses, benchmark vs actual cost)
- Repo-level synthesis (architecture overview, top risks, suggested next steps)
- Per-file detail (role, complexity, test gaps, security note, summary, cache tier)

---

## Links

- **Landing page:** https://critcache.vercel.app
- **npm:** https://www.npmjs.com/package/critcache
- **GitHub:** https://github.com/DiverseXL/critcache
- **BTL Runtime:** https://runtime.badtheorylabs.com

---

## Judges Q&A

**Why BTL Runtime and not OpenAI directly?**

BTL Runtime is the only gateway that exposes per-call cache savings as response headers — `x-btl-cache-tier`, `x-btl-saved`, `x-btl-benchmark-cost`, `x-btl-customer-charge`. critcache's entire value proposition — live, per-call savings proof in your terminal — is only possible because BTL surfaces this data per request. A standard OpenAI call gives you no visibility into whether you're paying for redundant computation. You just get a bill at month end.

**What does BTL Runtime enable that a standard server wouldn't?**

Three things: automatic exact and prefix caching across identical prompt scaffolding, multi-provider smart routing so the cheapest healthy provider handles each request, and the savings headers critcache reads live per call. Without BTL, you get no caching, no routing, and no per-call cost attribution — just raw LLM spend with no proof of what was necessary vs. redundant.

**Why deterministic prompts? Why not semantic caching?**

critcache deliberately uses a fixed, byte-identical system prompt with zero variability in the instruction scaffolding. The only variable per call is the file content passed as the user message. This means BTL's exact and prefix caching fires reliably — the cache warms predictably with every repeat run. Semantic similarity introduces probabilistic cache hits that could return an analysis of a different file for a similar-looking one. Deterministic caching is the right tradeoff for a code-review tool where accuracy matters.

**How do you prevent stale or incorrect cached responses?**

If the file content changes, the user message changes, the request no longer matches the cache, and a fresh analysis runs automatically. There's no risk of serving a stale response for a modified file. The deterministic prompt architecture makes cache correctness a structural guarantee, not something that needs to be managed separately.

**What's the actual latency improvement?**

Measured from live BTL Runtime runs: cache misses average 3,500–5,000ms per file. Cache hits average 560–1,600ms. Running `compare` on a 3-file repo dropped wall time from 8.7s (cold) to 3.7s (warm) — a 57.7% reduction. The BTL dashboard confirmed 50% cache hit rate across 6 requests with exact match cache firing 3 times.

**Is the cache local or distributed?**

BTL Runtime's cache is distributed and server-side — critcache has no local cache. This means a cache hit from one run on your machine warms the cache for a colleague's run on theirs, as long as they're in the same BTL workspace analyzing the same files. Team-shared cache warming is a side effect of the architecture, not an afterthought.

**Why a CLI and not a web app or API?**

Because the target user is a developer already in a terminal. A CLI integrates into existing workflows — `git commit`, `npm run build`, CI pipelines — without context switching. The live in-place ANSI renderer brings the BTL savings data directly into the developer's flow, at the moment they're making decisions about their codebase. A dashboard requires opening a browser. A CLI requires nothing.

**Couldn't this just run on any LLM provider?**

Technically yes — critcache uses the OpenAI-compatible `/v1/chat/completions` endpoint. But without BTL Runtime's caching layer, the `compare` command has nothing to prove. The cold-to-warm cache hit rate jump is the product. BTL Runtime is not incidental infrastructure — it's the feature.

---

## License

MIT © [Samuel Akinjo](https://github.com/DiverseXL)