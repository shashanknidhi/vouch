// Delete all messages in the bound channel (demo cleanup). Replay posts as the
// bot, so the bot token can delete them. Best-effort per message.
import { WebClient } from "@slack/web-api";
import { setTimeout as sleep } from "node:timers/promises";

process.loadEnvFile();
const channel = process.env.SLACK_CHANNEL_ID;
if (!channel) throw new Error("SLACK_CHANNEL_ID not set");
const slack = new WebClient(process.env.SLACK_BOT_TOKEN);

let cursor: string | undefined;
let deleted = 0;
do {
  const res = await slack.conversations.history({ channel, limit: 200, cursor });
  for (const m of res.messages ?? []) {
    if (!m.ts) continue;
    try {
      await slack.chat.delete({ channel, ts: m.ts });
      deleted++;
    } catch (e) {
      console.warn(`skip ${m.ts}: ${(e as Error).message}`);
    }
    await sleep(300); // chat.delete is Tier 3 (~50/min); stay under it
  }
  cursor = res.response_metadata?.next_cursor || undefined;
} while (cursor);

console.log(`deleted ${deleted} messages from ${channel}`);
