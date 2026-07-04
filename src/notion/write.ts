// Downstream doc rendering: Vouch's SQLite store is the source of truth; Notion
// is a display target updated on resolve. Every call here is best-effort and
// non-fatal — a Notion API hiccup must never break the verified Slack loop or
// the /vouch fallback.
// ponytail: native fetch + Notion REST, no @notionhq/client dep.

const BASE = "https://api.notion.com/v1";
// read lazily: app.ts loads .env AFTER imports, so a top-level read would miss it
const key = () => process.env.NOTION_API_KEY;
const H = () => ({
  Authorization: `Bearer ${key()}`,
  "Notion-Version": "2022-06-28",
  "Content-Type": "application/json",
});

const CHANGELOG_TITLE = "Changelog";
const rt = (content: string) => [{ type: "text", text: { content } }];
const noDashes = (id: string) => id.replaceAll("-", "");
// Notion's link-to-block anchor: page url + #<blockId without dashes>
const anchor = (pageId: string, blockId: string) =>
  `https://www.notion.so/${noDashes(pageId)}#${noDashes(blockId)}`;

// doc_ref holds a real block id once seeded from notion_ref; a placeholder
// (notion://TODO/...) means Notion isn't wired for this section.
function blockId(docRef: string): string | null {
  if (!key() || docRef.startsWith("notion://")) return null;
  return docRef;
}

interface NotionBlock {
  id: string;
  type: string;
  [k: string]: unknown;
}

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: H(),
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`Notion ${method} ${path} → ${res.status} ${await res.text()}`);
  return res.json() as Promise<{
    results?: NotionBlock[];
    parent?: { page_id?: string; block_id?: string };
  }>;
}

// the parent container id, so we can append a sibling `after` this block
async function parentOf(id: string): Promise<string> {
  const j = await call("GET", `/blocks/${id}`);
  const p = j.parent?.page_id ?? j.parent?.block_id;
  if (!p) throw new Error(`no parent for block ${id}`);
  return p;
}

function calloutBlock(emoji: string, richText: unknown[]) {
  return { object: "block", type: "callout", callout: { icon: { emoji }, rich_text: richText } };
}

export interface ConfirmProvenance {
  by: string; // human-readable name of who vouched
  date: string; // YYYY-MM-DD
  url?: string; // permalink to the Slack message where it was decided
}

/** Append a "pending" callout right after the section's value block. Returns the
 *  callout's block id (to archive on resolve), or null if Notion is off/failed. */
export async function markPending(docRef: string, note: string): Promise<string | null> {
  const id = blockId(docRef);
  if (!id) return null;
  try {
    const parent = await parentOf(id);
    const j = await call("PATCH", `/blocks/${parent}/children`, {
      after: id,
      children: [calloutBlock("⏳", rt(`Pending: ${note}`))],
    });
    return j.results?.[0]?.id ?? null;
  } catch (e) {
    console.warn(`⚠️  Notion markPending failed (non-fatal): ${(e as Error).message}`);
    return null;
  }
}

// Ensure a "Changelog" heading exists at the bottom of the page; entries append
// below it. ponytail: assumes Changelog is the last section (true for our doc).
async function ensureChangelog(pageId: string): Promise<void> {
  const kids = await call("GET", `/blocks/${pageId}/children?page_size=100`);
  const exists = kids.results?.some(
    (b) => b.type === "heading_1" && (b.heading_1 as any)?.rich_text?.[0]?.plain_text === CHANGELOG_TITLE,
  );
  if (exists) return;
  await call("PATCH", `/blocks/${pageId}/children`, {
    children: [
      { object: "block", type: "divider", divider: {} },
      { object: "block", type: "heading_1", heading_1: { rich_text: rt(CHANGELOG_TITLE) } },
    ],
  });
}

// Append a changelog entry (bulleted) and return its block id (link target).
async function appendChangelogEntry(
  pageId: string,
  change: string,
  prov: ConfirmProvenance,
): Promise<string | null> {
  const richText: unknown[] = [
    { type: "text", text: { content: `${change} — ${prov.by} · ${prov.date} · ` } },
    prov.url
      ? { type: "text", text: { content: "view in Slack", link: { url: prov.url } } }
      : { type: "text", text: { content: "from Slack" } },
  ];
  const j = await call("PATCH", `/blocks/${pageId}/children`, {
    children: [{ object: "block", type: "bulleted_list_item", bulleted_list_item: { rich_text: richText } }],
  });
  return j.results?.[0]?.id ?? null;
}

/** On resolve: overwrite the value block with the confirmed text, drop the
 *  pending callout, append a Changelog entry, and give the value line a subtle
 *  gray "↗ changelog" link that jumps to that entry. Best-effort. */
export async function writeConfirmed(
  docRef: string,
  value: string,
  change: string,
  prov: ConfirmProvenance,
  pendingBlockId?: string | null,
): Promise<void> {
  const id = blockId(docRef);
  if (!id) return;
  try {
    const pageId = await parentOf(id);
    if (pendingBlockId) await call("DELETE", `/blocks/${pendingBlockId}`);
    await ensureChangelog(pageId);
    const entryId = await appendChangelogEntry(pageId, change, prov);
    const marker = entryId
      ? [
          {
            type: "text",
            text: { content: "  ↗ changelog", link: { url: anchor(pageId, entryId) } },
            annotations: { color: "gray" },
          },
        ]
      : [];
    await call("PATCH", `/blocks/${id}`, { paragraph: { rich_text: [...rt(value), ...marker] } });
  } catch (e) {
    console.warn(`⚠️  Notion writeConfirmed failed (non-fatal): ${(e as Error).message}`);
  }
}

/** Archive a block (used to clear the pending callout on dismiss). Best-effort. */
export async function archiveBlock(blockId: string | null): Promise<void> {
  if (!key() || !blockId) return;
  try {
    await call("DELETE", `/blocks/${blockId}`);
  } catch (e) {
    console.warn(`⚠️  Notion archiveBlock failed (non-fatal): ${(e as Error).message}`);
  }
}
