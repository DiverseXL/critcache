# critcache

**Fan out parallel AI code-review agents across your repo through BTL Runtime — and watch the cache savings land live in your terminal.**

```
  ▄▄▄ ▄▄▄ ▄ ▄▄▄ ▄▄▄ ▄▄▄ ▄▄▄ ▄ ▄ ▄▄▄
  █   █▄▄ █  █  █   █▀█ █   █▀█ █▀▀
  ▀▀▀ ▀   ▀  ▀  ▀▀▀ ▀ ▀ ▀▀▀ ▀ ▀ ▀▀▀
  v0.1.1 · parallel AI code review · powered by BTL Runtime
```

> **BTL Runtime is the engine. critcache is the dashboard.**
>
> Every time your AI app makes a request, BTL Runtime knows:
> - Did this response come from cache?
> - How much did you save?
> - Was this faster because of caching?
>
> But those details are buried in response headers most developers never look at.
>
> critcache makes the invisible visible — showing you in real time, per call, in your terminal:
>
> - `[hit 563ms]` — this request hit the cache
> - `3× faster` than an uncached call  
> - `$0.02 saved` on this one call alone
>
> Run `compare` on any repo and watch your cache hit rate climb from 0% to 67% between pass 1 and pass 2. That's not a claim — it's a receipt, printed live.
>
> **You can't improve what you can't measure. critcache gives you the measurement.**

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

### `watch <repo>`

```bash
$ npx critcache watch <repo>
```

Sits in your terminal while you code, re-analyzes changed files through BTL Runtime automatically on every save, and shows whether the save was a cache hit or miss. First save: ~3800ms miss. Second save: ~400ms hit. That's BTL Runtime's cache warming in real time, no commands needed.

**Options:**

| Option | Default | Description |
|---|---|---|
| `--max-files, -m` | 20 | Maximum files to watch |
| `--debounce, -d` | 600 | Debounce delay in ms after a file save |
| `--sarif` | — | Write live-updating critcache-watch.sarif on each change |

---

### `review-pr <repo> <target>`

```bash
$ npx critcache review-pr <repo> <target>
```

Reviews only the files changed between your current branch and a target branch — the daily-driver mode for PR review. Uses git diff under the hood, no GitHub API required. Pipes changed file content through BTL Runtime with the same fixed prompt architecture, so cache warming works across repeated PR reviews of the same codebase.

**Options:**

| Option | Default | Description |
|---|---|---|
| `--concurrency, -c` | 6 | Parallel requests at once |
| `--output, -o` | critcache-pr-report.md | Report output path |
| `--sarif` | — | Also write a .sarif report |

**Example:**

```bash
npx critcache review-pr . main
npx critcache review-pr . origin/main
npx critcache review-pr . HEAD~1
```

---

### `diff [branch]`

```bash
$ npx critcache diff [branch]
```

Reviews uncommitted changes (no branch specified) or changes against a branch. Fastest way to review what you just wrote before committing.

```bash
npx critcache diff              # review uncommitted changes
npx critcache diff main         # review changes vs main
```

---

## CI integration — GitHub Actions

critcache fits naturally into CI pipelines. Here's a complete GitHub Actions workflow that runs critcache on every PR, uploads SARIF to GitHub Code Scanning, and posts results as a PR comment.

### GitHub Actions workflow (`.github/workflows/critcache.yml`)

```yaml
name: critcache AI code review

on:
  pull_request:
    branches: [main]
  push:
    branches: [main]

permissions:
  contents: read
  security-events: write  # Required for SARIF upload
  pull-requests: write    # Required for PR comments

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0  # Required for review-pr to diff against target

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: "20"

      - name: Run critcache PR review
        run: npx critcache review-pr . origin/main --sarif --output critcache-ci-report.md
        env:
          GATEWAY_API_KEY: ${{ secrets.GATEWAY_API_KEY }}
        continue-on-error: true  # Don't fail CI on review results

      - name: Upload SARIF to GitHub Code Scanning
        uses: github/codeql-action/upload-sarif@v3
        with:
          sarif_file: critcache-ci-report.sarif
          category: critcache

      - name: Post PR comment with results
        uses: marocchino/sticky-pull-request-comment@v2
        with:
          path: critcache-ci-report.md
```

### Setting up

1. **Get a BTL Runtime API key** at [runtime.badtheorylabs.com](https://runtime.badtheorylabs.com)
2. **Add the key to your GitHub repository secrets** as `GATEWAY_API_KEY` (Settings → Secrets and variables → Actions)
3. **Create the workflow file** at `.github/workflows/critcache.yml` with the content above
4. **Enable Code Scanning** — after the first run, go to your repo's Security tab → Code Scanning → add the `critcache` tool

### How it works in CI

- On every PR, critcache diffs the PR branch against `origin/main` and analyzes only the changed files
- Results are written as SARIF and uploaded to GitHub Code Scanning — findings appear in the Security tab
- A markdown report is posted as a PR comment with savings data, security notes, and analysis details
- The workflow uses `continue-on-error: true` so CI doesn't block on review findings — they're advisory

### Alternative: scheduled full analysis

```yaml
name: Weekly critcache analysis

on:
  schedule:
    - cron: "0 8 * * 1"  # Every Monday at 8 AM UTC

jobs:
  analyze:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "20"

      - name: Run critcache full analysis
        run: npx critcache analyze . --sarif --max-files 50
        env:
          GATEWAY_API_KEY: ${{ secrets.GATEWAY_API_KEY }}

      - name: Upload SARIF
        uses: github/codeql-action/upload-sarif@v3
        with:
          sarif_file: critcache-report.sarif
          category: critcache-weekly
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

## SARIF output

Add `--sarif` to any analysis command to write a SARIF v2.1 report alongside the markdown report:

```bash
npx critcache analyze . --sarif        # writes critcache-report.sarif
npx critcache review-pr . main --sarif # writes critcache-pr-report.sarif
npx critcache watch . --sarif          # writes live-updating critcache-watch.sarif
```

SARIF (Static Analysis Results Interchange Format) is the standard format consumed natively by:

- **GitHub Code Scanning** — upload to the Security tab, get inline PR annotations
- **VS Code** — open the `.sarif` file directly, see findings in the Problems panel
- **GitLab SAST** — compatible with GitLab's security dashboard
- **Azure DevOps** — consumed by the SARIF SAST Results Import task

**GitHub Actions CI example:**

```yaml
- name: Run critcache
  run: GATEWAY_API_KEY=${{ secrets.BTL_KEY }} npx critcache review-pr . main --sarif

- name: Upload to Code Scanning
  uses: github/codeql-action/upload-sarif@v3
  with:
    sarif_file: critcache-pr-report.sarif
```

---

## Custom review rules

Create a `.critcacherules` file in your repo root to focus the analysis on what matters to your team:

```
# Security
- Flag hardcoded credentials, API keys, or tokens
- Check for SQL injection vulnerabilities in raw queries
- Flag unvalidated user input in financial calculations

# Performance
- Look for N+1 query patterns in database calls
- Flag synchronous operations in async contexts

# Team standards
- This is a financial application — treat any unvalidated input as high severity
```

Rules are appended to the fixed system prompt and hashed into the prompt fingerprint. Changing your rules file will show as a fingerprint change and correctly bust the BTL Runtime cache — ensuring fresh analysis that reflects your updated standards.

The base system prompt stays byte-identical across all files in a run, so BTL's exact and prefix caching still works within a single session.

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

### Markdown report

Every `analyze` run writes a `critcache-report.md` to your current directory containing:

- Savings summary table (files analyzed, cache hits/misses, benchmark vs actual cost)
- Repo-level synthesis (architecture overview, top risks, suggested next steps)
- Per-file detail (role, complexity, test gaps, security note, summary, cache tier)

### SARIF — native GitHub & VS Code integration

Pass `--sarif` to any analysis command to also emit a **SARIF v2.1** file alongside the markdown report:

```bash
npx critcache analyze . --sarif
npx critcache review-pr . main --sarif
npx critcache watch . --sarif
```

**Why SARIF matters:**

SARIF (Static Analysis Results Interchange Format) is the OASIS standard format for static analysis tool output. critcache's SARIF output is consumed natively by:

- **GitHub Code Scanning** — upload the `.sarif` file in CI and findings appear in the Security tab
- **VS Code** — install the [SARIF Viewer extension](https://marketplace.visualstudio.com/items?itemName=MS-SarifVSCode.sarif-viewer) and open the `.sarif` file to see results inline in the Problems panel
- **GitLab SAST** — SARIF is GitLab's native SAST format
- **Azure DevOps** — SARIF results are rendered in the Pipeline and pull request experience

Each SARIF result includes:
- File-level analysis summaries with `note` severity
- Security warnings promoted to `warning` severity so they stand out
- Test coverage gaps surfaced as separate findings
- Custom properties with complexity, role, cache tier, and savings per file
- Repo-level synthesis risks and next steps as informational results

**Zero integration code needed on critcache's side.** Every SARIF consumer already understands the format — critcache just writes the file.

```bash
# Open SARIF results in VS Code (after installing the SARIF Viewer extension)
code critcache-report.sarif
```

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

## BTL Runtime API surface

critcache uses the following BTL Runtime endpoints:

| Endpoint | Command | Purpose |
|---|---|---|
| `POST /v1/chat/completions` | `analyze`, `compare`, `review-pr`, `watch` | Per-file AI code review and repo-level synthesis |
| `GET /v1/models` | `models` | Lists all available model slugs across providers |
| `GET /v1/usage/summary` | `stats` | Cumulative workspace spend, savings, and cache hit breakdown |

BTL-specific response headers read per call:

| Header | Used for |
|---|---|
| `x-btl-cache-tier` | Cache tier display per file |
| `x-btl-benchmark-cost` | Cost without caching |
| `x-btl-customer-charge` | Actual charge after caching |
| `x-btl-saved` | Per-call savings |
| `x-btl-request-id` | Debug reference |

BTL Runtime savings mechanisms confirmed active in this workspace (from `critcache stats`):

- **Exact response cache** — 11 hits confirmed, serving repeated file analyses in ~560ms vs ~3500ms
- **Provider prompt cache** — prefix reuse at the upstream provider level
- **Request compaction** — conversation history compressed before hitting the provider
- **Output budget shaping** — runaway completions capped automatically
- **Smart routing** — `btl-2` routes to cheapest healthy provider per request

---

## License

MIT © [Samuel Akinjo](https://github.com/DiverseXL)