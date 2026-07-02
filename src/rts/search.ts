import { WebClient } from "@slack/web-api";

try {
  process.loadEnvFile();
} catch {
  // no .env file; rely on real env vars
}

// Real-Time Search (assistant.search.context) — user token avoids the
// action_token requirement that bot tokens carry for this method.
const userToken = process.env.SLACK_USER_TOKEN;
const client = userToken ? new WebClient(userToken) : null;

export interface RtsHit {
  channel: string;
  ts: string;
  text: string;
  permalink: string | null;
}

export async function searchRelated(query: string, limit = 5): Promise<RtsHit[]> {
  if (!client) return []; // RTS disabled without SLACK_USER_TOKEN

  const res = (await client.apiCall("assistant.search.context", {
    query,
    content_types: "messages",
    channel_types: "public_channel",
    sort: "score",
    limit,
  })) as {
    results?: {
      messages?: {
        channel_id?: string;
        message_ts?: string;
        content?: string;
        permalink?: string;
      }[];
    };
  };

  return (res.results?.messages ?? [])
    .filter((m) => m.channel_id && m.message_ts)
    .map((m) => ({
      channel: m.channel_id!,
      ts: m.message_ts!,
      text: m.content ?? "",
      permalink: m.permalink ?? null,
    }));
}

export const rtsEnabled = client !== null;
