import bolt from "@slack/bolt";
import { detectDecision, type ChannelMessage } from "../reconciliation/detect.js";
import {
  getSectionsByChannel,
  listOpenThreadNotes,
  openThread,
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

  const thread = openThread({
    sectionId: detection.section_id,
    sourceSignal: `slack://${msg.channel}/${msg.ts}`,
    assignee: detection.author ?? author,
    suggestedNote: detection.suggested_note ?? undefined,
  });

  console.log(
    `🟡 thread ${thread.id} opened — section '${detection.section_id}' now pending\n` +
      `   would DM ${thread.assignee}: "${thread.suggested_note}"`,
  );
});

await app.start();
console.log("⚡ vouch listening (socket mode)");
