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

const rt = (content: string) => [{ type: "text", text: { content } }];

// doc_ref holds a real block id once seeded from notion_ref; a placeholder
// (notion://TODO/...) means Notion isn't wired for this section.
function blockId(docRef: string): string | null {
  if (!key() || docRef.startsWith("notion://")) return null;
  return docRef;
}

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: H(),
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`Notion ${method} ${path} → ${res.status} ${await res.text()}`);
  return res.json() as Promise<{
    results?: { id: string }[];
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

// "Confirmed by Marco · 2026-07-04 · view in Slack" (last part linked if url given)
function provenanceRichText(p: ConfirmProvenance) {
  const parts: unknown[] = [{ type: "text", text: { content: `Confirmed by ${p.by} · ${p.date} · ` } }];
  parts.push(
    p.url
      ? { type: "text", text: { content: "view in Slack", link: { url: p.url } } }
      : { type: "text", text: { content: "from Slack" } },
  );
  return parts;
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

/** On resolve: overwrite the value block with the confirmed text, drop the
 *  pending callout, and append a provenance callout. Best-effort. */
export async function writeConfirmed(
  docRef: string,
  value: string,
  prov: ConfirmProvenance,
  pendingBlockId?: string | null,
): Promise<void> {
  const id = blockId(docRef);
  if (!id) return;
  try {
    await call("PATCH", `/blocks/${id}`, { paragraph: { rich_text: rt(value) } });
    if (pendingBlockId) await call("DELETE", `/blocks/${pendingBlockId}`);
    const parent = await parentOf(id);
    await call("PATCH", `/blocks/${parent}/children`, {
      after: id,
      children: [calloutBlock("✅", provenanceRichText(prov))],
    });
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
