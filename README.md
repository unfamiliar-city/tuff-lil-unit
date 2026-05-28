# Tuff Lil Unit

![Tuff Lil Unit](./assets/tuff.jpg)

A lil resumable pipeline toolkit for AI coding agents.

Tuff is an ultra-simple version of the 'step function' pattern from hardcore workflow tools like Temporal.

It's for building reusable multi-step workflows using AI coding tools like Claude Code, Cowork, Codex and friends.

It ain't big. It ain't clever. It's just a little TypeScript and a SQLite database.

## In practice

A GEO study with synthetic personas — hundreds of GPT queries mimicking customer searches, responses post-processed, citations fetched and analysed — iteratively refined and re-run on the fly.

```mermaid
flowchart TD
    tuff["tuff('run-id', ...)"] --> C1 & C2 & CN

    C1["Call 1"] --> P1["Process 1"]
    C2["Call 2"] --> P2["Process 2"]
    CN["Call N"] --> PN["Process N"]

    P1 --> D1["..."]
    P2 --> D2["..."]
    PN --> DN["..."]

    D1 & D2 & DN --> Synth["Synthesise"]

    tuff <-->|"cache / persist"| DB[(tuff.db)]

    style CN stroke-dasharray: 5 5
    style PN stroke-dasharray: 5 5
    style D1 stroke-dasharray: 5 5
    style D2 stroke-dasharray: 5 5
    style DN stroke-dasharray: 5 5
```

## Features

- **Slot-based concurrency** — new tasks start when a slot opens (vs. Claude Code's native Tasks = max 10 concurrent in batched waves, slowest holds flow).
- **Three execution modes, mix freely** — LLM API calls, Claude Code headless using your subscription (play at your own risk), or any async function.
- **Concurrency per stage** — slot limits per phase (fan out high for HTTP fetches, throttle back for LLM processing).
- **Token budget** — global and per-step limits (Claude Code subprocess kills mid-run).
- **Progress and state is queryable** — step results, token usage, and durations land in Tuff's local db. Talk to Claude about progress during execution.
- **Domain storage** — define your own data tables alongside Tuff's state tables.

## Get started

Install the skill:

```
/plugin marketplace add unfamiliar-city/marketplace
/reload-plugins
/plugin install tuff
```

Then use it:

```
Claude Code
Opus 4.6 · Claude API
~/Projects/myproject

 > /tuff build me a pipeline to make a million bucks.
```

## Code example

```ts
// Pipeline 'my-pipeline', state persisted to ./state/tuff.db
await tuff('my-pipeline', { stateDir: './state' }, async (ctx) => {

  // Resumable step — if this succeeded before, returns cached result instantly
  const data = await ctx.step('fetch', async () => fetchAll());

  // Fan out — one step per item, concurrent within slot limit
  // Each has a unique ID, so on resume only uncompleted ones re-execute
  const results = await Promise.all(
    data.map((item) => ctx.step(item.id, async () => process(item)))
  );

  // Fan in — summarise all results
  return ctx.step('summarise', async () => summarise(results));
});
```

## Status

Alpha.

**Claude Code CLI provider** — a house of cards on top of undocumented Claude Code internals. As of June 2026, `claude -p` draws from a separate Agent SDK credit pool (limited monthly allowance, overages billed at full API rates). Use with care.

## License

MIT