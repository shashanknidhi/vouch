import { readFileSync } from "node:fs";
import { WebClient } from "@slack/web-api";
import { setTimeout as sleep } from "node:timers/promises";

try {
  process.loadEnvFile();
} catch {
  // no .env file; rely on real env vars
}

const args = process.argv.slice(2);
const delayFlag = args.indexOf("--delay");
const delayMs = delayFlag >= 0 ? Number(args[delayFlag + 1]) : 3000;
const fixturePath =
  args.find((a) => a.endsWith(".json")) ?? "fixtures/channel-history.json";

const channel = process.env.SLACK_CHANNEL_ID;
if (!channel) throw new Error("SLACK_CHANNEL_ID not set");

const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
  messages: { user: string; text: string }[];
};

const EMOJI = ["🦊", "🐼", "🦉", "🐸", "🦁", "🐙", "🦄", "🐻"];
const iconFor = (user: string) =>
  EMOJI[[...user].reduce((a, c) => a + c.charCodeAt(0), 0) % EMOJI.length];

const slack = new WebClient(process.env.SLACK_BOT_TOKEN);

console.log(`replaying ${fixture.messages.length} messages to ${channel}, ${delayMs}ms apart`);
for (const [i, m] of fixture.messages.entries()) {
  await slack.chat.postMessage({
    channel,
    text: m.text,
    username: m.user,
    icon_emoji: iconFor(m.user),
  });
  console.log(`${i + 1}/${fixture.messages.length} [${m.user}] ${m.text.slice(0, 60)}`);
  await sleep(delayMs);
}
console.log("replay done");
