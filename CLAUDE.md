# vouch

Slack agent that catches decisions in Slack, gets a human to vouch for them, and writes them back into a doc with provenance. See README for the one-liner.

## Stack
Node/TypeScript, single package, flat `src/`. No monorepo tooling.

LLM: Ollama Cloud via its OpenAI-compatible endpoint (`OLLAMA_BASE_URL`, `OLLAMA_API_KEY` in `.env`) — use the `openai` SDK pointed at that base URL, not the Anthropic SDK.

## Layout
- `src/store` — MCP store: bindings, sections, threads, provenance (issue #2)
- `src/mcp-server` — MCP server exposing the store as tools (issue #2)
- `src/reconciliation` — decision detection + resolution-note drafting (issue #3)
- `src/slack` — channel listener, DM nudge, `/vouch` command (issue #1)
- `src/rts` — Real-Time Search context-gathering + dedupe (issue #4, create when that work starts)

## Source of truth for scope
GitHub issues #1-#5 in this repo — not this file — track scope and build order. Issue #5 is the sequencing tracker; don't touch Slack or Notion live until its step 2 (offline detection test) passes.

## Commands
- `npm run dev` — run src/index.ts with watch
- `npm run build` — compile to dist/
- `npm run typecheck` — type-check only
