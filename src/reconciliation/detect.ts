import { llm, MODEL } from "./llm.js";

export interface SectionInfo {
  id: string;
  title: string;
  current_value: string;
}

export interface ChannelMessage {
  ts: string;
  user: string;
  text: string;
}

export interface Detection {
  is_decision: boolean;
  section_id: string | null;
  author: string | null;
  suggested_note: string | null;
  proposed_value: string | null;
}

const SYSTEM_PROMPT = `You are Vouch, a documentation-freshness watchdog reading a Slack engineering channel.

You are given:
- The documented sections Vouch watches (id, title, and the doc's CURRENT text).
- A window of recent channel messages for context.
- One TARGET message to classify.

Decide whether the TARGET message SETTLES a decision that makes one of the documented sections stale.

A message settles a decision only if it commits the team to a change ("ship it", "decided", "moves to", "effective next week", "no longer need X"). These are NOT decisions:
- Proposals, questions, or ideas still under discussion ("should we...", "propose 30?", "can we also...").
- Technical recommendations or arguments, however confident ("actually we should set X to 15 or partners will see errors") — a recommendation is still a proposal until someone accepts it ("ok fine", "do it", "ship it"). The accepting message is the decision.
- Deferrals ("let's discuss tomorrow").
- Reports that a previously-made decision was executed ("deployed", "done").
- Rejections or affirmations that keep a documented value unchanged ("hard no", "let's not", "leave it as is") — the doc is still correct.
- References to a change that was already settled earlier in the context window. Only the message that SETTLES the change counts; later messages that mention, apply, or build on the new value are not new decisions.
- Decisions about things the doc sections do not actually document. The settled fact must contradict or change specific text in a section's current doc text. A decision merely on the same general topic (e.g. a library upgrade in a channel that also discusses deploys) is NOT a match.

If it is a decision, also draft:
- suggested_note: one short sentence stating old value → new value, phrased so the decision-maker can confirm it in ten seconds. Example: "Rate limit changed 60/min → 100/min. Confirm?"
- proposed_value: the section's current doc text rewritten with ONLY the settled change applied. Keep the original style, structure, and length; change nothing else.

Respond with ONLY a JSON object, no prose:
{"is_decision": boolean, "section_id": string | null, "author": string | null, "suggested_note": string | null, "proposed_value": string | null}

section_id must be one of the given section ids or null. author is the username of whoever made the call.`;

// Re-apply a single settled change onto the CURRENT section text. Used at accept
// time to merge a change when the section already drifted from what the thread's
// proposed_value assumed (two concurrent decisions on one section).
export async function redraftValue(currentValue: string, change: string): Promise<string> {
  const res = await llm.chat.completions.create({
    model: MODEL,
    temperature: 0,
    messages: [
      {
        role: "system",
        content:
          "You update one section of an engineering doc. Apply ONLY the described change to the current text. Keep the original style, structure, and length; change nothing else. Return ONLY the updated section text — no prose, no quotes, no code fences.",
      },
      { role: "user", content: `Current text:\n${currentValue}\n\nChange to apply:\n${change}` },
    ],
  });
  return (res.choices[0]?.message?.content ?? currentValue).trim();
}

export async function detectDecision(
  target: ChannelMessage,
  context: ChannelMessage[],
  sections: SectionInfo[],
  openThreadNotes: string[] = [],
): Promise<Detection> {
  const sectionsBlock = sections
    .map((s) => `- id: ${s.id}\n  title: ${s.title}\n  current doc text: ${s.current_value}`)
    .join("\n");
  const contextBlock = context.map((m) => `[${m.user}]: ${m.text}`).join("\n");
  const threadsBlock = openThreadNotes.length
    ? `\n\n## Changes already tracked in open threads (do NOT re-flag these; a different change to the same section still counts)\n${openThreadNotes.map((n) => `- ${n}`).join("\n")}`
    : "";

  const res = await llm.chat.completions.create({
    model: MODEL,
    temperature: 0,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: `## Watched sections\n${sectionsBlock}${threadsBlock}\n\n## Recent context\n${contextBlock}\n\n## TARGET message\n[${target.user}]: ${target.text}`,
      },
    ],
  });

  const raw = res.choices[0]?.message?.content ?? "";
  let match = raw.match(/\{[\s\S]*\}/);
  if (!match) {
    // ponytail: single blind retry — Ollama occasionally returns empty content
    const retry = await llm.chat.completions.create({
      model: MODEL,
      temperature: 0,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: `## Watched sections\n${sectionsBlock}${threadsBlock}\n\n## Recent context\n${contextBlock}\n\n## TARGET message\n[${target.user}]: ${target.text}`,
        },
      ],
    });
    const retryRaw = retry.choices[0]?.message?.content ?? "";
    match = retryRaw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error(`no JSON in model output after retry: ${retryRaw}`);
  }
  const parsed = JSON.parse(match[0]);

  return {
    is_decision: Boolean(parsed.is_decision),
    section_id: parsed.section_id ?? null,
    author: parsed.author ?? null,
    suggested_note: parsed.suggested_note ?? null,
    proposed_value: parsed.proposed_value ?? null,
  };
}
