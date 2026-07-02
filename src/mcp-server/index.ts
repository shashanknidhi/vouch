import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  getSection,
  setFreshness,
  openThread,
  resolveThread,
  dismissThread,
  writeProvenance,
} from "../store/queries.js";

const server = new McpServer({ name: "vouch-store", version: "0.0.1" });

function json(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

server.registerTool(
  "get_section",
  {
    description: "Get a section's current value, freshness state, and latest provenance",
    inputSchema: { section_id: z.string() },
  },
  async ({ section_id }) => json(getSection(section_id) ?? null),
);

server.registerTool(
  "set_freshness",
  {
    description: "Set a section's freshness state",
    inputSchema: {
      section_id: z.string(),
      freshness_state: z.enum(["fresh", "pending", "stale-suspected"]),
    },
  },
  async ({ section_id, freshness_state }) => json(setFreshness(section_id, freshness_state)),
);

server.registerTool(
  "open_thread",
  {
    description: "Open a resolution thread for a section and flip it to pending",
    inputSchema: {
      section_id: z.string(),
      source_signal: z.string().optional(),
      assignee: z.string().optional(),
      suggested_note: z.string().optional(),
      proposed_value: z.string().optional(),
    },
  },
  async ({ section_id, source_signal, assignee, suggested_note, proposed_value }) =>
    json(
      openThread({
        sectionId: section_id,
        sourceSignal: source_signal,
        assignee,
        suggestedNote: suggested_note,
        proposedValue: proposed_value,
      }),
    ),
);

server.registerTool(
  "resolve_thread",
  {
    description:
      "Resolve a thread with a confirmed resolution note, optionally write the new doc text to the section, and flip it to fresh",
    inputSchema: {
      thread_id: z.string(),
      resolution_note: z.string(),
      new_value: z.string().optional(),
    },
  },
  async ({ thread_id, resolution_note, new_value }) =>
    json(resolveThread(thread_id, resolution_note, new_value)),
);

server.registerTool(
  "dismiss_thread",
  {
    description:
      "Dismiss a thread (false alarm or reverted change): section back to fresh, doc text untouched, no provenance",
    inputSchema: { thread_id: z.string() },
  },
  async ({ thread_id }) => json(dismissThread(thread_id)),
);

server.registerTool(
  "write_provenance",
  {
    description: "Record who confirmed a section's value and which thread/Slack message it traces to",
    inputSchema: {
      section_id: z.string(),
      confirmed_by: z.string(),
      source_thread_id: z.string(),
      source_slack_ref: z.string().optional(),
      human_confirmed: z.boolean(),
    },
  },
  async ({ section_id, confirmed_by, source_thread_id, source_slack_ref, human_confirmed }) =>
    json(
      writeProvenance({
        sectionId: section_id,
        confirmedBy: confirmed_by,
        sourceThreadId: source_thread_id,
        sourceSlackRef: source_slack_ref,
        humanConfirmed: human_confirmed,
      }),
    ),
);

await server.connect(new StdioServerTransport());
