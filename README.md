![vouch — Slack decides. A human vouches. The doc stays honest.](assets/banner.png)

# vouch

Slack agent that keeps docs honestly fresh — catches decisions in Slack, gets a human to vouch, writes them back with provenance.

## How it works

1. **Listen** — a Slack bot watches a channel for messages that look like settled decisions (LLM-based detection).
2. **Nudge** — when a decision touches a doc section, the bot DMs the decision-maker with a proposed update and Accept / Edit / Dismiss buttons.
3. **Write back** — on accept, the section is updated and a provenance record (who vouched, source Slack message) is stored.
4. **Ask** — `/vouch status` shows what's fresh or stale; `/vouch why <section>` shows the provenance trail for any section.

Duplicate decisions are deduped via Slack Real-Time Search (`assistant.search.context`), which also enriches nudges with related discussions.

## Stack

- Node/TypeScript, single flat package
- SQLite (`better-sqlite3`) — local `vouch.db`, no server
- Slack Bolt (Socket Mode)
- LLM via Ollama Cloud's OpenAI-compatible endpoint (`openai` SDK)
- MCP server exposing the store as tools

## Layout

```
src/store           # SQLite store: bindings, sections, threads, provenance
src/mcp-server      # MCP server exposing the store as tools
src/reconciliation  # decision detection + resolution-note drafting
src/slack           # channel listener, DM nudge, /vouch command
src/rts             # Real-Time Search context-gathering + dedupe
scripts/replay.ts   # replay a message fixture into the channel
fixtures/           # demo + eval conversation fixtures
```

## Running locally

### Prerequisites

- Node 20+
- A Slack workspace where you can install apps
- An [Ollama Cloud](https://ollama.com) API key

### 1. Install

```sh
npm install
```

### 2. Create the Slack app

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From a manifest**, and paste `slack-app-manifest.json`.
2. Install the app to your workspace.
3. Generate an app-level token (Settings → Basic Information → App-Level Tokens) with the `connections:write` scope — this is `SLACK_APP_TOKEN`.
4. Grab the **Bot User OAuth Token** (`SLACK_BOT_TOKEN`) and **User OAuth Token** (`SLACK_USER_TOKEN`, needed for Real-Time Search) from OAuth & Permissions.
5. Invite the bot to the channel you want it to watch, and copy that channel's ID.

### 3. Configure

```sh
cp .env.example .env
```

Fill in:

| Variable | What it is |
|---|---|
| `SLACK_BOT_TOKEN` | Bot token (`xoxb-…`) |
| `SLACK_APP_TOKEN` | App-level token (`xapp-…`) for Socket Mode |
| `SLACK_USER_TOKEN` | User token (`xoxp-…`) for Real-Time Search |
| `SLACK_CHANNEL_ID` | Channel to watch (e.g. `C0123456789`) |
| `VOUCH_ASSIGNEE_OVERRIDE` | Optional: Slack user ID to send all nudges to (handy for demos) |
| `OLLAMA_API_KEY` | Ollama Cloud API key |
| `OLLAMA_BASE_URL` | Leave as `https://ollama.com/v1` |
| `NOTION_API_KEY` | Optional: for Notion write-back |

### 4. Seed and run

```sh
npm run seed    # create vouch.db with sample sections + bindings
npm run slack   # start the Slack listener (Socket Mode, no public URL needed)
```

Post a decision-shaped message in the watched channel (e.g. *"ok let's settle it — rate limit goes to 500 req/min for enterprise"*) and you should get a DM nudge. Try `/vouch status` and `/vouch why <section>` in Slack.

### Other commands

```sh
npm run demo       # full demo reset: wipe DB, seed, replay build-up fixture, start app
npm run eval       # run decision detection against fixtures (offline, no Slack needed)
npm run mcp        # run the MCP server over stdio
npm run inspect    # open MCP Inspector against the server
npm run typecheck  # type-check
```

## License

See [LICENSE](LICENSE).
