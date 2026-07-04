import { readFileSync } from "node:fs";
import { db } from "./db.js";

try {
  process.loadEnvFile();
} catch {
  // no .env file; rely on real env vars
}

// ponytail: seed sections straight from the eval fixture — one source of truth
// for eval, seed, and demo replay
const fixture = JSON.parse(
  readFileSync(new URL("../../fixtures/channel-history.json", import.meta.url), "utf8"),
) as {
  sections: { id: string; title: string; current_value: string; notion_ref?: string }[];
};

const channelId = process.env.SLACK_CHANNEL_ID ?? "C_DEMO_CHANNEL";

for (const s of fixture.sections) {
  // doc_ref = the Notion block id of the section's value paragraph, so write-back
  // updates it in place. Falls back to a placeholder if no notion_ref (Notion off).
  db.prepare(
    `INSERT OR REPLACE INTO sections (id, doc_ref, title, current_value, freshness_state, author_hint)
     VALUES (?, ?, ?, ?, 'fresh', NULL)`,
  ).run(s.id, s.notion_ref ?? `notion://TODO/${s.id}`, s.title, s.current_value);
  db.prepare(
    `INSERT OR REPLACE INTO bindings (section_id, slack_channel_id) VALUES (?, ?)`,
  ).run(s.id, channelId);
}

console.log(`seeded ${fixture.sections.length} sections bound to channel '${channelId}'`);
