# Tuff Lil Unit

![Tuff Lil Unit](./assets/tuff.jpg)

A lil resumable pipeline toolkit for AI coding agents.

Tuff's an ultra-simple implementation of the 'step function' pattern from Temporal and Inngest, built for AI coding agents like Claude Code and friends. Micro-scale, on your local machine.

It's just a little TypeScript and SQLite. Your agent could build this from scratch every time, but Tuff saves it the trouble — so it can focus on what you want to get done.

## Tuff features

- **Slot-based concurrency** — new tasks start when a slot opens (vs. Claude Code's native Tasks = max 10 concurrent in batched waves, slowest holds flow).
- **Three execution modes, mix freely** — LLM API calls, Claude Code headless using your subscription (play at your own risk), or any async function.
- **Concurrency per stage** — slot limits per phase (fan out high for HTTP fetches, throttle back for LLM processing).
- **Token budget** — global and per-step limits (Claude Code subprocess kills mid-run).
- **Progress and state is queryable** — step results, token usage, and durations land in Tuff's local db. Talk to Claude about progress during execution.
- **Domain storage** — define your own data tables alongside Tuff's state tables.

## An example pipeline

| Phase | What it does | Model | Calls | Concurrency |
|-------|-------------|-------|-------|-------------|
| Collect | Fetch 200 source URLs | *none* | 200 | 50 |
| Extract | Pull structured data from each page | GPT-5-nano | 200 | 10 |
| Classify | Score and categorise each result | GPT-5-mini | 200 | 5 |
| Distil | Aggregate into final report | *none* | 1 | 1 |

~400 LLM calls, 200 HTTP fetches, 4 phases. One `tuff()` call.

## Getting started

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

The entire runtime is one function call:

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

> You either die a hero or you live long enough to see yourself reimplementing Kubernetes.

Alpha.

Not production-tested.

**Claude Code CLI provider** — a house of cards on top of undocumented Claude Code internals. Use if you're relaxed about robustness, approximate budget tracking is good enough, and you want to use your Claude subscription.

## License

MIT