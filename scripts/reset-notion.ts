// Reset the demo Notion page to the seeded fixture state: restore each section's
// value block and clear any pending/confirmed callouts left by prior demo runs.
// Run alongside `rm vouch.db && npm run seed` between demo takes.
import { readFileSync } from "node:fs";

process.loadEnvFile();
const key = process.env.NOTION_API_KEY;
if (!key) {
  console.log("NOTION_API_KEY unset — nothing to reset");
  process.exit(0);
}
const H = { Authorization: `Bearer ${key}`, "Notion-Version": "2022-06-28", "Content-Type": "application/json" };

const fixture = JSON.parse(
  readFileSync(new URL("../fixtures/channel-history.json", import.meta.url), "utf8"),
) as { sections: { title: string; current_value: string; notion_ref?: string }[] };

let page: string | undefined;
for (const s of fixture.sections) {
  if (!s.notion_ref) continue;
  await fetch(`https://api.notion.com/v1/blocks/${s.notion_ref}`, {
    method: "PATCH",
    headers: H,
    body: JSON.stringify({ paragraph: { rich_text: [{ type: "text", text: { content: s.current_value } }] } }),
  });
  if (!page) {
    const b = (await (await fetch(`https://api.notion.com/v1/blocks/${s.notion_ref}`, { headers: H })).json()) as any;
    page = b.parent?.page_id;
  }
  console.log(`reset ${s.title}`);
}

if (page) {
  // reverting the value blocks above already strips the gray "↗ changelog"
  // marker; here we clear the Changelog section + any leftover callouts.
  const junk = new Set(["callout", "bulleted_list_item", "divider", "heading_1"]);
  const kids = (await (await fetch(`https://api.notion.com/v1/blocks/${page}/children?page_size=100`, { headers: H })).json()) as any;
  for (const b of kids.results.filter((b: any) => junk.has(b.type))) {
    await fetch(`https://api.notion.com/v1/blocks/${b.id}`, { method: "DELETE", headers: H });
  }
  console.log("cleared changelog + callouts");
}
