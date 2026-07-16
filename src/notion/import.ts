// Import Notion docs into the store: headings → sections, the first paragraph
// under each heading → its writable value anchor (doc_ref). Routing is
// workspace-global (any channel → any doc), so sections are NOT bound to a
// channel here — bindings are unused.
//
//   npx tsx src/notion/import.ts <pageId>   # one page (+ its sub-pages)
//   npx tsx src/notion/import.ts --all      # every page the integration can see
//   npx tsx src/notion/import.ts --selftest
//
// ponytail: a section's value is the first non-empty paragraph after its
// heading (matches how write-back overwrites a paragraph block). Headings whose
// content is bullets/tables/etc are logged and skipped — upgrade to create an
// empty paragraph anchor for them if real docs need it. Nested blocks inside
// toggles/columns are not descended into (only page → child_page).
import { call } from "./write.js";

type Block = { id: string; type: string; has_children?: boolean; [k: string]: any };

const isHeading = (t: string) => t === "heading_1" || t === "heading_2" || t === "heading_3";
const plain = (b: Block): string =>
  (b[b.type]?.rich_text ?? []).map((t: any) => t.plain_text ?? t.text?.content ?? "").join("");
const slug = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "section";
// stable unique id: slug + tail of the value block id. Block ids are stable
// across runs, so re-import (webhook/rescan) is idempotent (INSERT OR REPLACE),
// and two docs sharing a heading title don't collide.
const sectionId = (title: string, docRef: string) =>
  `${slug(title)}-${docRef.replaceAll("-", "").slice(-6)}`;

export interface ImportedSection {
  id: string;
  title: string;
  doc_ref: string; // real Notion block id of the value paragraph
  current_value: string;
}

/** Pure: turn one page's direct children into section rows. Returns rows +
 *  titles skipped for lack of a value paragraph. */
export function parseSections(blocks: Block[]): { sections: ImportedSection[]; skipped: string[] } {
  const sections: ImportedSection[] = [];
  const skipped: string[] = [];
  for (let i = 0; i < blocks.length; i++) {
    if (!isHeading(blocks[i].type)) continue;
    const title = plain(blocks[i]).trim();
    if (!title) continue;
    // first non-empty paragraph before the next heading is the section value
    let value: Block | null = null;
    for (let j = i + 1; j < blocks.length && !isHeading(blocks[j].type); j++) {
      if (blocks[j].type === "paragraph" && plain(blocks[j]).trim()) {
        value = blocks[j];
        break;
      }
    }
    if (!value) {
      skipped.push(title);
      continue;
    }
    sections.push({ id: sectionId(title, value.id), title, doc_ref: value.id, current_value: plain(value) });
  }
  return { sections, skipped };
}

// IO: all direct children of a block, following pagination.
async function children(blockId: string): Promise<Block[]> {
  const out: Block[] = [];
  let cursor: string | null | undefined;
  do {
    const qs = new URLSearchParams({ page_size: "100" });
    if (cursor) qs.set("start_cursor", cursor);
    const j = await call("GET", `/blocks/${blockId}/children?${qs}`);
    out.push(...((j.results ?? []) as Block[]));
    cursor = j.has_more ? j.next_cursor : undefined;
  } while (cursor);
  return out;
}

// Parse one page's own children; when recurse, descend into child_page blocks.
async function crawl(
  pageId: string,
  recurse: boolean,
  acc: { sections: ImportedSection[]; skipped: string[] },
): Promise<void> {
  const blocks = await children(pageId);
  const { sections, skipped } = parseSections(blocks);
  acc.sections.push(...sections);
  acc.skipped.push(...skipped);
  if (recurse) for (const b of blocks) if (b.type === "child_page") await crawl(b.id, true, acc);
}

async function upsert(rows: ImportedSection[]): Promise<void> {
  // lazy: importing db opens vouch.db as a side effect; selftest must not need it
  const { db } = await import("../store/db.js");
  const tx = db.transaction((rs: ImportedSection[]) => {
    for (const s of rs)
      db.prepare(
        `INSERT OR REPLACE INTO sections (id, doc_ref, title, current_value, freshness_state, author_hint)
         VALUES (?, ?, ?, ?, 'fresh', NULL)`,
      ).run(s.id, s.doc_ref, s.title, s.current_value);
  });
  tx(rows);
}

/** Import one page's sections into the store. `recurse` follows child_page;
 *  `dryRun` parses + returns but skips the DB write. */
export async function importPage(
  pageId: string,
  recurse = false,
  dryRun = false,
): Promise<{ sections: ImportedSection[]; skipped: string[] }> {
  const acc = { sections: [] as ImportedSection[], skipped: [] as string[] };
  await crawl(pageId, recurse, acc);
  if (!dryRun) await upsert(acc.sections);
  return acc;
}

// Every page id the integration can see. POST /search returns pages flat
// (child pages included), so callers import each page's own blocks — no
// child_page recursion needed, which would double-crawl.
async function searchAllPages(): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | null | undefined;
  do {
    const j = await call("POST", "/search", {
      filter: { property: "object", value: "page" },
      page_size: 100,
      ...(cursor ? { start_cursor: cursor } : {}),
    });
    for (const r of j.results ?? []) ids.push(r.id);
    cursor = j.has_more ? j.next_cursor : undefined;
  } while (cursor);
  return ids;
}

/** Import every page the integration can access (initial backfill + rescan).
 *  `dryRun` parses + returns but writes nothing. */
export async function importWorkspace(dryRun = false): Promise<{ sections: ImportedSection[]; skipped: string[] }> {
  const pages = await searchAllPages();
  const acc = { sections: [] as ImportedSection[], skipped: [] as string[] };
  for (const pid of pages) {
    const a = await importPage(pid, false, dryRun);
    acc.sections.push(...a.sections);
    acc.skipped.push(...a.skipped);
  }
  return acc;
}

function report(acc: { sections: ImportedSection[]; skipped: string[] }, label: string, dryRun = false) {
  console.log(`${dryRun ? "[dry-run] would import" : "imported"} ${acc.sections.length} sections ${label}:`);
  for (const s of acc.sections) console.log(`  • ${s.id} — "${s.title}"`);
  if (acc.skipped.length)
    console.log(`skipped ${acc.skipped.length} heading(s) with no paragraph value: ${acc.skipped.join(", ")}`);
}

async function main() {
  if (process.argv.includes("--selftest")) return selftest();

  try {
    process.loadEnvFile();
  } catch {
    // rely on real env vars
  }
  if (!process.env.NOTION_API_KEY) {
    console.error("NOTION_API_KEY not set");
    process.exit(1);
  }

  const dryRun = process.argv.includes("--dry-run");
  if (process.argv.includes("--all")) {
    report(await importWorkspace(dryRun), "from workspace search", dryRun);
    return;
  }
  const pageId = process.argv.find((a) => !a.startsWith("--") && !a.endsWith(".ts") && a !== process.execPath);
  if (!pageId) {
    console.error("usage: tsx src/notion/import.ts <pageId> | --all  [--dry-run]");
    process.exit(1);
  }
  report(await importPage(pageId, true, dryRun), `from page ${pageId}`, dryRun);
}

function selftest() {
  const h = (type: string, text: string, id = text): Block => ({ id, type, [type]: { rich_text: [{ plain_text: text }] } });
  const p = (text: string, id: string): Block => ({ id, type: "paragraph", paragraph: { rich_text: [{ plain_text: text }] } });
  const { sections, skipped } = parseSections([
    h("heading_1", "Rate Limits"),
    p("500 req/min for enterprise", "blk-a1b2c3"),
    h("heading_2", "Rate Limits"), // same title, different block → distinct id
    p("100 req/min for free tier", "blk-d4e5f6"),
    h("heading_1", "Roadmap"), // no paragraph before EOF → skipped
  ]);
  console.assert(sections.length === 2, `expected 2 sections, got ${sections.length}`);
  console.assert(sections[0].id === "rate-limits-a1b2c3" && sections[0].doc_ref === "blk-a1b2c3", `id0 wrong: ${sections[0].id}`);
  console.assert(sections[1].id === "rate-limits-d4e5f6", `id1 wrong: ${sections[1].id}`);
  console.assert(sections[0].id !== sections[1].id, "same-title sections must get distinct ids");
  console.assert(skipped.length === 1 && skipped[0] === "Roadmap", "skip detection wrong");
  console.log("selftest ok");
}

if (import.meta.url === `file://${process.argv[1]}`) main();
