import { db } from "./db.js";

const sectionId = "api-limits";

db.prepare(
  `INSERT OR REPLACE INTO sections (id, doc_ref, title, current_value, freshness_state, author_hint)
   VALUES (?, ?, ?, ?, 'fresh', ?)`,
).run(sectionId, "notion://TODO-page-id/TODO-block-id", "API Limits", "60/min", null);

db.prepare(
  `INSERT OR REPLACE INTO bindings (section_id, slack_channel_id) VALUES (?, ?)`,
).run(sectionId, "C_DEMO_CHANNEL");

console.log(`seeded section '${sectionId}' bound to channel 'C_DEMO_CHANNEL'`);
