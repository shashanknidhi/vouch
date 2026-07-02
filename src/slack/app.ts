import bolt from "@slack/bolt";
import { detectDecision, type ChannelMessage } from "../reconciliation/detect.js";
import { searchRelated, rtsEnabled, type RtsHit } from "../rts/search.js";
import {
  getSection,
  getSectionsByChannel,
  getThread,
  listOpenThreadNotes,
  listOpenThreads,
  listProvenance,
  listSections,
  listThreadSourceRefs,
  openThread,
  resolveThread,
  dismissThread,
  writeProvenance,
  type Thread,
} from "../store/queries.js";

try {
  process.loadEnvFile();
} catch {
  // no .env file; rely on real env vars
}

const app = new bolt.App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
  // replay demo posts personas with this app's own token; Bolt drops own-bot
  // events by default. Safe: this app never posts into the channel itself.
  ignoreSelf: false,
});

process.on("unhandledRejection", (err) => console.error("unhandledRejection:", err));

const userNames = new Map<string, string>();

async function resolveName(userId: string | undefined, username: string | undefined) {
  if (username) return username; // persona override on replayed bot messages
  if (!userId) return "unknown";
  if (!userNames.has(userId)) {
    const res = await app.client.users.info({ user: userId });
    userNames.set(userId, res.user?.profile?.display_name || res.user?.real_name || userId);
  }
  return userNames.get(userId)!;
}

app.event("message", async ({ event }) => {
  const msg = event as {
    channel: string;
    ts: string;
    text?: string;
    user?: string;
    username?: string;
    subtype?: string;
  };

  // process plain messages and replayed persona messages (subtype bot_message);
  // skip edits, deletions, joins, and empty text
  if (msg.subtype && msg.subtype !== "bot_message") return;
  if (!msg.text) return;

  const sections = getSectionsByChannel(msg.channel);
  if (sections.length === 0) return; // not a bound channel

  const history = await app.client.conversations.history({
    channel: msg.channel,
    latest: msg.ts,
    inclusive: false,
    limit: 6,
  });
  const context: ChannelMessage[] = await Promise.all(
    (history.messages ?? [])
      .reverse()
      .filter((m) => m.text)
      .map(async (m) => ({
        ts: m.ts!,
        user: await resolveName(m.user, (m as { username?: string }).username),
        text: m.text!,
      })),
  );

  const author = await resolveName(msg.user, msg.username);
  const target: ChannelMessage = { ts: msg.ts, user: author, text: msg.text };

  const detection = await detectDecision(
    target,
    context,
    sections.map((s) => ({ id: s.id, title: s.title, current_value: s.current_value ?? "" })),
    listOpenThreadNotes(),
  );

  if (!detection.is_decision || !detection.section_id) return;
  if (!sections.some((s) => s.id === detection.section_id)) {
    console.warn(`detector returned unknown section '${detection.section_id}', ignoring`);
    return;
  }

  // RTS (assistant.search.context): gather related workspace discussion for
  // the nudge, and guard against re-tracking a change whose settling message
  // already has a thread (e.g. reprocessing after a listener restart)
  let related: RtsHit[] = [];
  if (rtsEnabled && detection.suggested_note) {
    const query = detection.suggested_note.replace(/\s*Confirm\?$/i, "");
    related = (await searchRelated(query)).filter(
      (h) => !(h.channel === msg.channel && h.ts === msg.ts), // not the trigger itself
    );
    // same-ts reprocess guard checks ALL threads; related-hit guard checks only
    // OPEN ones — a resolved thread is a finished change, not a block on new ones
    const allRefs = new Set(listThreadSourceRefs(detection.section_id));
    if (allRefs.has(`slack://${msg.channel}/${msg.ts}`)) {
      console.log(`🔁 RTS dedupe: trigger message already has a thread, skipping`);
      return;
    }
    const openRefs = new Set(listThreadSourceRefs(detection.section_id, "open"));
    const alreadyTracked = related.find((h) => openRefs.has(`slack://${h.channel}/${h.ts}`));
    if (alreadyTracked) {
      console.log(
        `🔁 RTS dedupe: related message ${alreadyTracked.ts} already spawned a thread for '${detection.section_id}', skipping`,
      );
      return;
    }
  }

  const thread = openThread({
    sectionId: detection.section_id,
    sourceSignal: `slack://${msg.channel}/${msg.ts}`,
    assignee: detection.author ?? author,
    suggestedNote: detection.suggested_note ?? undefined,
    proposedValue: detection.proposed_value ?? undefined,
  });

  console.log(
    `🟡 thread ${thread.id} opened — section '${detection.section_id}' now pending` +
      (related.length ? ` (${related.length} related via RTS)` : ""),
  );
  await sendNudge(thread, related);
});

function nudgeBlocks(thread: Thread, related: RtsHit[] = []) {
  const section = getSection(thread.section_id);
  return [
    {
      type: "section" as const,
      text: {
        type: "mrkdwn" as const,
        text:
          `*${section?.section.title ?? thread.section_id}* looks stale.\n` +
          `${thread.suggested_note ?? "A change was detected."}`,
      },
    },
    ...(thread.proposed_value
      ? [
          {
            type: "section" as const,
            text: {
              type: "mrkdwn" as const,
              text: `*Doc will be updated to:*\n>${thread.proposed_value.replaceAll("\n", "\n>")}`,
            },
          },
        ]
      : []),
    ...(related.length
      ? [
          {
            type: "context" as const,
            elements: [
              {
                type: "mrkdwn" as const,
                text:
                  "*Related discussion:* " +
                  related
                    .slice(0, 3)
                    .map((h, i) =>
                      h.permalink
                        ? `<${h.permalink}|${h.text.slice(0, 40).trim() || `message ${i + 1}`}…>`
                        : h.text.slice(0, 60),
                    )
                    .join("  ·  "),
              },
            ],
          },
        ]
      : []),
    {
      type: "actions" as const,
      elements: [
        {
          type: "button" as const,
          action_id: "vouch_accept",
          style: "primary" as const,
          text: { type: "plain_text" as const, text: "Accept" },
          value: thread.id,
        },
        {
          type: "button" as const,
          action_id: "vouch_edit",
          text: { type: "plain_text" as const, text: "Edit" },
          value: thread.id,
        },
        {
          type: "button" as const,
          action_id: "vouch_dismiss",
          style: "danger" as const,
          text: { type: "plain_text" as const, text: "Dismiss" },
          value: thread.id,
        },
      ],
    },
  ];
}

async function sendNudge(thread: Thread, related: RtsHit[] = []) {
  // personas aren't real users; the demo routes every nudge to one human
  const target = process.env.VOUCH_ASSIGNEE_OVERRIDE;
  if (!target) {
    console.log(`   no VOUCH_ASSIGNEE_OVERRIDE set — nudge for '${thread.assignee}' not sent`);
    return;
  }
  const dm = await app.client.conversations.open({ users: target });
  await app.client.chat.postMessage({
    channel: dm.channel!.id!,
    text: thread.suggested_note ?? "Vouch: a doc section looks stale.",
    blocks: nudgeBlocks(thread, related),
  });
  console.log(`   nudge DMed to ${target} (assignee: ${thread.assignee})`);
}

async function finalizeDm(
  channelId: string,
  ts: string,
  text: string,
) {
  await app.client.chat.update({ channel: channelId, ts, text, blocks: [] });
}

app.action("vouch_accept", async ({ ack, body, action }) => {
  await ack();
  const threadId = (action as { value?: string }).value!;
  const thread = getThread(threadId);
  if (!thread || thread.status !== "open") return;

  resolveThread(threadId, thread.suggested_note ?? "confirmed", thread.proposed_value ?? undefined);
  writeProvenance({
    sectionId: thread.section_id,
    confirmedBy: body.user.id,
    sourceThreadId: threadId,
    sourceSlackRef: thread.source_signal ?? undefined,
    humanConfirmed: true,
  });
  const b = body as unknown as { channel?: { id: string }; message?: { ts: string } };
  if (b.channel && b.message) {
    await finalizeDm(b.channel.id, b.message.ts, `✅ Confirmed — *${thread.section_id}* updated, section fresh.`);
  }
  console.log(`✅ thread ${threadId} accepted by ${body.user.id}`);
});

app.action("vouch_dismiss", async ({ ack, body, action }) => {
  await ack();
  const threadId = (action as { value?: string }).value!;
  const thread = getThread(threadId);
  if (!thread || thread.status !== "open") return;

  dismissThread(threadId);
  const b = body as unknown as { channel?: { id: string }; message?: { ts: string } };
  if (b.channel && b.message) {
    await finalizeDm(b.channel.id, b.message.ts, `Dismissed — *${thread.section_id}* back to fresh, doc untouched.`);
  }
  console.log(`🚫 thread ${threadId} dismissed by ${body.user.id}`);
});

app.action("vouch_edit", async ({ ack, body, action, client }) => {
  await ack();
  const threadId = (action as { value?: string }).value!;
  const thread = getThread(threadId);
  if (!thread || thread.status !== "open") return;

  const b = body as unknown as {
    trigger_id: string;
    channel?: { id: string };
    message?: { ts: string };
  };
  await client.views.open({
    trigger_id: b.trigger_id,
    view: {
      type: "modal",
      callback_id: "vouch_edit_submit",
      private_metadata: JSON.stringify({
        thread_id: threadId,
        dm_channel: b.channel?.id,
        dm_ts: b.message?.ts,
      }),
      title: { type: "plain_text", text: "Edit doc text" },
      submit: { type: "plain_text", text: "Confirm" },
      blocks: [
        {
          type: "input",
          block_id: "value",
          label: { type: "plain_text", text: "New section text" },
          element: {
            type: "plain_text_input",
            action_id: "input",
            multiline: true,
            initial_value: thread.proposed_value ?? thread.suggested_note ?? "",
          },
        },
      ],
    },
  });
});

app.view("vouch_edit_submit", async ({ ack, body, view }) => {
  await ack();
  const meta = JSON.parse(view.private_metadata) as {
    thread_id: string;
    dm_channel?: string;
    dm_ts?: string;
  };
  const thread = getThread(meta.thread_id);
  if (!thread || thread.status !== "open") return;

  const edited = view.state.values.value.input.value ?? "";
  resolveThread(meta.thread_id, `edited by human: ${thread.suggested_note ?? ""}`, edited);
  writeProvenance({
    sectionId: thread.section_id,
    confirmedBy: body.user.id,
    sourceThreadId: meta.thread_id,
    sourceSlackRef: thread.source_signal ?? undefined,
    humanConfirmed: true,
  });
  if (meta.dm_channel && meta.dm_ts) {
    await finalizeDm(meta.dm_channel, meta.dm_ts, `✏️ Edited & confirmed — *${thread.section_id}* updated, section fresh.`);
  }
  console.log(`✏️ thread ${meta.thread_id} edited+confirmed by ${body.user.id}`);
});

const STATE_ICON = { fresh: "🟢", pending: "🟡", "stale-suspected": "🟠" } as const;

async function slackLink(sourceSignal: string | null) {
  // source_signal format: slack://CHANNEL/TS
  const m = sourceSignal?.match(/^slack:\/\/([^/]+)\/(.+)$/);
  if (!m) return null;
  try {
    const res = await app.client.chat.getPermalink({ channel: m[1], message_ts: m[2] });
    return res.permalink ?? null;
  } catch {
    return null;
  }
}

app.command("/vouch", async ({ ack, command, respond }) => {
  await ack();
  const [sub, ...rest] = command.text.trim().split(/\s+/);
  const arg = rest.join(" ");

  if (sub === "why" && arg) {
    const query = arg.toLowerCase();
    const section = listSections().find(
      (s) => s.id.toLowerCase() === query || s.title.toLowerCase().includes(query),
    );
    if (!section) {
      await respond(`No section matching "${arg}". Try \`/vouch status\` to see them all.`);
      return;
    }
    const trail = listProvenance(section.id);
    const lines = await Promise.all(
      trail.map(async (p) => {
        const thread = p.source_thread_id ? getThread(p.source_thread_id) : undefined;
        const link = await slackLink(p.source_slack_ref);
        const when = p.confirmed_at?.slice(0, 10) ?? "?";
        const what = thread?.resolution_note ?? "confirmed";
        return `• ${when} — ${what} — confirmed by <@${p.confirmed_by}>${link ? ` (<${link}|source>)` : ""}`;
      }),
    );
    await respond(
      `${STATE_ICON[section.freshness_state]} *${section.title}*\n` +
        `>${(section.current_value ?? "_empty_").replaceAll("\n", "\n>")}\n\n` +
        (lines.length
          ? `*How it got here:*\n${lines.join("\n")}`
          : "_No confirmations recorded yet — this text predates Vouch._"),
    );
    return;
  }

  // default: status
  const open = listOpenThreads();
  const lines = listSections().map((s) => {
    const threads = open.filter((t) => t.section_id === s.id);
    const detail = threads.length
      ? `\n${threads.map((t) => `    ↳ awaiting ${t.assignee ?? "?"}: ${t.suggested_note ?? "open thread"}`).join("\n")}`
      : "";
    return `${STATE_ICON[s.freshness_state]} *${s.title}* — ${s.freshness_state}${detail}`;
  });
  await respond(
    `*Doc status:*\n${lines.join("\n")}\n\n_\`/vouch why <section>\` shows any section's provenance trail._`,
  );
});

await app.start();
console.log("⚡ vouch listening (socket mode)");
