import { randomUUID } from "node:crypto";
import { db } from "./db.js";

export type FreshnessState = "fresh" | "pending" | "stale-suspected";

export interface Section {
  id: string;
  doc_ref: string;
  title: string;
  current_value: string | null;
  freshness_state: FreshnessState;
  author_hint: string | null;
}

export interface Provenance {
  section_id: string;
  confirmed_by: string | null;
  confirmed_at: string | null;
  source_thread_id: string | null;
  source_slack_ref: string | null;
  human_confirmed: number | null;
}

export interface Thread {
  id: string;
  section_id: string;
  status: "open" | "resolved" | "dismissed";
  source_signal: string | null;
  assignee: string | null;
  suggested_note: string | null;
  proposed_value: string | null;
  resolution_note: string | null;
}

export function getThread(threadId: string) {
  return db.prepare("SELECT * FROM threads WHERE id = ?").get(threadId) as
    | Thread
    | undefined;
}

export function getSection(sectionId: string) {
  const section = db
    .prepare("SELECT * FROM sections WHERE id = ?")
    .get(sectionId) as Section | undefined;
  if (!section) return undefined;

  const provenance = db
    .prepare(
      "SELECT * FROM provenance WHERE section_id = ? ORDER BY confirmed_at DESC LIMIT 1",
    )
    .get(sectionId) as Provenance | undefined;

  return { section, provenance: provenance ?? null };
}

export function getBindingByChannel(slackChannelId: string) {
  return db
    .prepare("SELECT * FROM bindings WHERE slack_channel_id = ?")
    .get(slackChannelId) as { section_id: string; slack_channel_id: string } | undefined;
}

export function getSectionsByChannel(slackChannelId: string) {
  return db
    .prepare(
      `SELECT s.* FROM sections s JOIN bindings b ON b.section_id = s.id
       WHERE b.slack_channel_id = ?`,
    )
    .all(slackChannelId) as Section[];
}

export function listOpenThreadNotes() {
  return (
    db
      .prepare("SELECT suggested_note FROM threads WHERE status = 'open'")
      .all() as { suggested_note: string | null }[]
  )
    .map((r) => r.suggested_note)
    .filter((n): n is string => n !== null);
}

export function setFreshness(sectionId: string, freshnessState: FreshnessState) {
  db.prepare("UPDATE sections SET freshness_state = ? WHERE id = ?").run(
    freshnessState,
    sectionId,
  );
  return getSection(sectionId);
}

export function openThread(params: {
  sectionId: string;
  sourceSignal?: string;
  assignee?: string;
  suggestedNote?: string;
  proposedValue?: string;
}) {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO threads (id, section_id, status, source_signal, assignee, suggested_note, proposed_value)
     VALUES (?, ?, 'open', ?, ?, ?, ?)`,
  ).run(
    id,
    params.sectionId,
    params.sourceSignal ?? null,
    params.assignee ?? null,
    params.suggestedNote ?? null,
    params.proposedValue ?? null,
  );
  setFreshness(params.sectionId, "pending");
  return getThread(id)!;
}

export function resolveThread(threadId: string, resolutionNote: string, newValue?: string) {
  const thread = getThread(threadId);
  if (!thread) throw new Error(`thread not found: ${threadId}`);

  db.prepare(
    "UPDATE threads SET status = 'resolved', resolution_note = ? WHERE id = ?",
  ).run(resolutionNote, threadId);
  if (newValue !== undefined) {
    db.prepare("UPDATE sections SET current_value = ? WHERE id = ?").run(
      newValue,
      thread.section_id,
    );
  }
  setFreshness(thread.section_id, "fresh");

  return getThread(threadId)!;
}

export function dismissThread(threadId: string) {
  const thread = getThread(threadId);
  if (!thread) throw new Error(`thread not found: ${threadId}`);

  db.prepare("UPDATE threads SET status = 'dismissed' WHERE id = ?").run(threadId);
  setFreshness(thread.section_id, "fresh");

  return getThread(threadId)!;
}

export function writeProvenance(params: {
  sectionId: string;
  confirmedBy: string;
  sourceThreadId: string;
  sourceSlackRef?: string;
  humanConfirmed: boolean;
}) {
  const confirmedAt = new Date().toISOString();
  db.prepare(
    `INSERT INTO provenance
       (section_id, confirmed_by, confirmed_at, source_thread_id, source_slack_ref, human_confirmed)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    params.sectionId,
    params.confirmedBy,
    confirmedAt,
    params.sourceThreadId,
    params.sourceSlackRef ?? null,
    params.humanConfirmed ? 1 : 0,
  );
  return getSection(params.sectionId);
}
