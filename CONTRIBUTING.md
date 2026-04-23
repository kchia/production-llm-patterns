# Contributing to Production LLM Patterns

This repo is a living reference for production LLM engineering. Contributions that make it more accurate, more useful, or more complete are genuinely welcome.

There's no formal process — I'd rather have a short feedback loop than a heavyweight review gate. That said, here's how I think about what fits here and how to make contributions land well.

## What Fits Here

The patterns in this repo share a few characteristics:

- **Framework-agnostic** — they work with any LLM provider and any stack
- **Production-grounded** — backed by real failure modes, not theoretical concerns
- **Dual-implemented** — TypeScript and Python, both idiomatic
- **Honest about tradeoffs** — including when the pattern stops applying

A proposed addition that fits this profile is a good candidate. One that's framework-specific, highly theoretical, or duplicates an existing pattern probably isn't — but open an issue and we can figure it out together.

## Ways to Contribute

### Reporting a bug or inaccuracy

If something in a pattern is technically wrong, outdated, or misleading, [open an issue](https://github.com/kchia/production-llm-patterns/issues) using the **Bug Report** template. Specific is better than general — quote the claim and explain what's actually true.

### Suggesting a new pattern

If you've hit a production problem that doesn't map to any existing pattern, [open an issue](https://github.com/kchia/production-llm-patterns/issues) using the **Pattern Request** template. The most useful requests describe a real failure you've seen, not a hypothetical. What broke? What did you end up building?

### Proposing an improvement

Improvements to existing patterns — better failure mode examples, updated cost numbers, clearer architecture diagrams, additional test cases — are the easiest contributions to evaluate. Use the **Improvement** issue template and link to the specific pattern.

### Submitting a pull request

For small fixes (typos, broken links, code bugs), a PR without a prior issue is fine. For anything larger — new sections, architecture changes, new patterns — open an issue first so we can align on direction before you invest the time.

When submitting a PR:

1. Follow the structure of the existing pattern (see `PATTERN_TEMPLATE.md` for the full template)
2. Match the voice guide — first-person reasoning, contractions, no prescriptive "you should" framing
3. Include a brief description of what changed and why in the PR body
4. For code changes: run the tests (`npm test` in the pattern's `src/ts/` directory, `pytest` in `src/py/`)

## Voice and Tone

The patterns here have a specific voice: first-person, specific over vague, honest about uncertainty. A few things that help contributions fit:

- Write like you're describing something you actually built or operated, not like you're authoring documentation
- Use contractions — "I'd want" not "one should", "it's" not "it is"
- Avoid prescriptive framing — "I wouldn't ship without this" over "you need to do X"
- Use real numbers when you have them — "latency dropped from ~2s to ~400ms" over "significant improvement"

## Code Contributions

Pattern implementations follow these rules (from `PLAYBOOK.md`):

- No framework-specific imports (no LangChain, LlamaIndex, etc.)
- Every implementation ships with a mock provider for testing
- Minimal dependencies — every dep is a maintenance burden
- Idiomatic TypeScript and Python — not translated from one to the other
- All tests must pass before a PR is ready for review

## Questions

If you're not sure whether something fits or how to approach it, open an issue with the question. I'd rather have a quick back-and-forth than have you invest time in something that doesn't land.
