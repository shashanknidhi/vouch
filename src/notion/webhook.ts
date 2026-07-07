// Notion webhook receiver: live pickup of new/edited docs. Notion posts events
// to a public URL (use a tunnel like ngrok/cloudflared in dev) — Bolt runs in
// Socket Mode and has no public server, so this is a separate tiny listener.
//
// One-time setup: add the subscription URL in the integration settings; Notion
// first POSTs `{ verification_token }` — we log it so you paste it back into the
// UI, then set it as NOTION_WEBHOOK_SECRET so we can verify later events.
//
// ponytail: create/update → re-import that page (idempotent via stable ids).
// Deletes are ignored — sections linger harmlessly; add pruning if it matters.
import { createServer } from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";
import { importPage } from "./import.js";

const PORT = Number(process.env.PORT ?? 3100);

// Notion signs with HMAC-SHA256(rawBody) keyed by the verification token,
// sent as `X-Notion-Signature: sha256=<hex>`. Verify only if we have the token.
function verified(raw: string, sig: string | undefined): boolean {
  const secret = process.env.NOTION_WEBHOOK_SECRET;
  if (!secret) return true; // not configured yet — accept (dev)
  if (!sig) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function startWebhookServer(port = PORT) {
  const server = createServer((req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", async () => {
      let body: any;
      try {
        body = JSON.parse(raw);
      } catch {
        res.writeHead(400).end();
        return;
      }

      // one-time subscription handshake
      if (body.verification_token) {
        console.log(`\n🔑 Notion verification_token — paste into the integration UI, then set NOTION_WEBHOOK_SECRET:\n${body.verification_token}\n`);
        res.writeHead(200).end();
        return;
      }

      if (!verified(raw, req.headers["x-notion-signature"] as string | undefined)) {
        console.warn("⚠️  Notion webhook: bad signature, ignoring");
        res.writeHead(401).end();
        return;
      }

      // ack immediately; do the import async (Notion retries on non-2xx/timeouts)
      res.writeHead(200).end();

      const type: string = body.type ?? "";
      const pageId: string | undefined = body.entity?.id;
      if (!pageId || !/^page\.(created|content_updated|properties_updated)$/.test(type)) return;
      try {
        const { sections } = await importPage(pageId, false);
        console.log(`↻ ${type} → re-imported page ${pageId}: ${sections.length} section(s)`);
      } catch (e) {
        console.warn(`⚠️  webhook import failed for ${pageId}: ${(e as Error).message}`);
      }
    });
  });
  server.listen(port, () => console.log(`📥 Notion webhook receiver on :${port}`));
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.loadEnvFile();
  } catch {
    // rely on real env vars
  }
  startWebhookServer();
}
