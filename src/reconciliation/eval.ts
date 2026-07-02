import { readFileSync } from "node:fs";
import { detectDecision, type ChannelMessage, type SectionInfo } from "./detect.js";

const CONTEXT_WINDOW = 6;

interface FixtureMessage extends ChannelMessage {
  label: { section_id: string } | null;
}

interface Fixture {
  channel: string;
  sections: SectionInfo[];
  messages: FixtureMessage[];
}

const fixture: Fixture = JSON.parse(
  readFileSync(new URL("../../fixtures/channel-history.json", import.meta.url), "utf8"),
);

let tp = 0;
let fp = 0;
let fn = 0;
let misrouted = 0;
// ponytail: eval mimics production state — each detection opens a "thread" whose
// note is fed back so the same change isn't re-flagged (dedupe, issue #4)
const openThreadNotes: string[] = [];

for (let i = 0; i < fixture.messages.length; i++) {
  const target = fixture.messages[i];
  const context = fixture.messages.slice(Math.max(0, i - CONTEXT_WINDOW), i);
  const d = await detectDecision(target, context, fixture.sections, openThreadNotes);
  if (d.is_decision && d.suggested_note) openThreadNotes.push(d.suggested_note);

  const expected = target.label;
  const gotDecision = d.is_decision && d.section_id !== null;

  if (expected && gotDecision) {
    if (d.section_id === expected.section_id) {
      tp++;
      console.log(`✅ TP  [${target.ts}] "${target.text.slice(0, 60)}" → ${d.section_id}`);
      console.log(`       note: ${d.suggested_note}`);
    } else {
      misrouted++;
      console.log(`🔀 MISROUTE [${target.ts}] expected ${expected.section_id}, got ${d.section_id}`);
    }
  } else if (!expected && gotDecision) {
    fp++;
    console.log(`❌ FP  [${target.ts}] "${target.text.slice(0, 60)}" → ${d.section_id}`);
  } else if (expected && !gotDecision) {
    fn++;
    console.log(`😴 FN  [${target.ts}] "${target.text.slice(0, 60)}" (missed ${expected.section_id})`);
  }
}

const totalExpected = fixture.messages.filter((m) => m.label).length;
const precision = tp / (tp + fp + misrouted) || 0;
const recall = tp / totalExpected || 0;

console.log(`\n=== ${fixture.messages.length} messages, ${totalExpected} labeled decisions ===`);
console.log(`TP: ${tp}  FP: ${fp}  FN: ${fn}  misrouted: ${misrouted}`);
console.log(`precision: ${(precision * 100).toFixed(0)}%  recall: ${(recall * 100).toFixed(0)}%`);
