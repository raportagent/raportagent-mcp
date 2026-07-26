#!/usr/bin/env node
/**
 * RaportAgent MCP server.
 *
 * Exposes RaportAgent's REST API (/v1) as Model Context Protocol tools so any MCP client
 * (Claude Desktop, Claude Code, Cursor, …) can generate sourced market & compliance research,
 * check status, and pull the finished report + its audit trail — all with the user's API key.
 *
 * Auth: set RAPORTAGENT_API_KEY (an `ra_live_…` key from the account page → API keys).
 * Base URL defaults to https://raportagent.com, override with RAPORTAGENT_BASE_URL.
 *
 * Transport: stdio (the standard for local MCP servers launched by a desktop client).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createRequire } from "node:module";

// Read the version from package.json at runtime instead of hardcoding it a second time,
// so the MCP handshake (serverInfo.version) can never drift from what's actually published.
const { version: PKG_VERSION } = createRequire(import.meta.url)("../package.json") as { version: string };

const BASE = (process.env.RAPORTAGENT_BASE_URL || process.env.REPORTAGENT_BASE_URL || "https://raportagent.com").replace(/\/+$/, "");
const API_KEY = process.env.RAPORTAGENT_API_KEY || process.env.REPORTAGENT_API_KEY || "";

const TEMPLATES = ["compliance", "pitch", "saas", "ecommerce", "realestate", "local", "battlecard", "duediligence", "fintech"] as const;

type ApiResult = { ok: boolean; status: number; data: any };

async function api(
  path: string,
  opts: { method?: string; body?: unknown; idempotencyKey?: string } = {},
): Promise<ApiResult> {
  if (!API_KEY) {
    return { ok: false, status: 0, data: { error: "RAPORTAGENT_API_KEY is not set." } };
  }
  const headers: Record<string, string> = {
    Authorization: `Bearer ${API_KEY}`,
    Accept: "application/json",
  };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method: opts.method || "GET",
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  } catch (e: any) {
    return { ok: false, status: 0, data: { error: `Network error: ${e?.message || e}` } };
  }
  let data: any = null;
  const text = await res.text();
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  return { ok: res.ok, status: res.status, data };
}

function jsonBlock(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function errBlock(r: ApiResult) {
  const msg = r.data?.error?.message || r.data?.error || `HTTP ${r.status}`;
  return { content: [{ type: "text" as const, text: `RaportAgent API error (${r.status}): ${msg}` }], isError: true };
}

const server = new McpServer({ name: "raportagent", version: PKG_VERSION });

server.tool(
  "generate_report",
  "Start a RaportAgent market/compliance research report. Typically takes ~15 min, occasionally " +
    "longer under load (hard timeout: 45 min), so this returns a report_id immediately " +
    "(status: queued) unless you set wait_seconds. Use get_report_status to poll, then get_report " +
    "to fetch the finished markdown. Costs 1 credit (2 credits for the 'battlecard' template).",
  {
    query: z.string().min(3).describe("The market/topic to research, e.g. 'EV charging infrastructure Europe 2026'."),
    template: z.enum(TEMPLATES).optional().describe(
      "Report shape. 'compliance' = legal/regulatory brief, 'battlecard' = head-to-head competitor " +
      "comparison (costs 2 credits instead of 1), 'duediligence' = investor-style scoped review, " +
      "'pitch'/'saas'/'ecommerce'/'realestate'/'local'/'fintech' = industry-tuned framing. Omit for a general report.",
    ),
    wait_seconds: z.number().int().min(0).max(2700).default(0)
      .describe("If >0, poll until the report completes or this many seconds elapse (max 2700, " +
        "matching the server's hard timeout)."),
  },
  async ({ query, template, wait_seconds }) => {
    const options: Record<string, unknown> = {};
    if (template) options.template = template;
    const created = await api("/v1/reports", {
      method: "POST",
      body: { query, options },
      idempotencyKey: `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    });
    if (!created.ok) return errBlock(created);
    const rid = created.data.report_id as string;
    if (!wait_seconds) return jsonBlock(created.data);

    const deadline = Date.now() + wait_seconds * 1000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 15000));
      const st = await api(`/v1/reports/${rid}/status`);
      if (st.ok && ["completed", "failed", "cancelled"].includes(st.data.status)) {
        return jsonBlock({ ...created.data, final_status: st.data });
      }
    }
    return jsonBlock({ ...created.data, note: `Still running after ${wait_seconds}s — poll get_report_status(${rid}).` });
  },
);

server.tool(
  "get_report_status",
  "Check whether a report is queued, in_progress, completed, failed, or cancelled.",
  { report_id: z.string().describe("The rep_… id from generate_report.") },
  async ({ report_id }) => {
    const r = await api(`/v1/reports/${report_id}/status`);
    return r.ok ? jsonBlock(r.data) : errBlock(r);
  },
);

server.tool(
  "get_report",
  "Fetch a completed report's full markdown content and section list.",
  { report_id: z.string().describe("The rep_… id.") },
  async ({ report_id }) => {
    const r = await api(`/v1/reports/${report_id}`);
    return r.ok ? jsonBlock(r.data) : errBlock(r);
  },
);

server.tool(
  "get_report_audit",
  "Get a report's audit trail / provenance: AI models, agents, source counts, and a SHA-256 of the " +
    "exact content. Useful for compliance review and verifying a report has not been altered.",
  { report_id: z.string().describe("The rep_… id.") },
  async ({ report_id }) => {
    const r = await api(`/v1/reports/${report_id}/audit`);
    return r.ok ? jsonBlock(r.data) : errBlock(r);
  },
);

server.tool(
  "get_report_sources",
  "List every source cited in a report with link-health counts (working / uncertain / dead) and " +
    "how many are actually cited inline. Use this to decide whether a report is trustworthy enough " +
    "to act on, or whether to regenerate it.",
  { report_id: z.string().describe("The rep_… id.") },
  async ({ report_id }) => {
    const r = await api(`/v1/reports/${report_id}/sources`);
    return r.ok ? jsonBlock(r.data) : errBlock(r);
  },
);

server.tool(
  "cancel_report",
  "Cancel a report that is still queued or in progress and refund its credit. Fails if the report " +
    "has already completed or failed (nothing to cancel at that point).",
  { report_id: z.string().describe("The rep_… id.") },
  async ({ report_id }) => {
    const r = await api(`/v1/reports/${report_id}`, { method: "DELETE" });
    return r.ok ? jsonBlock(r.data) : errBlock(r);
  },
);

server.tool(
  "list_reports",
  "List your recent reports (most recent first).",
  {
    limit: z.number().int().min(1).max(100).default(20),
    status: z.enum(["queued", "in_progress", "completed", "failed", "cancelled"]).optional(),
  },
  async ({ limit, status }) => {
    const qs = new URLSearchParams({ limit: String(limit) });
    if (status) qs.set("status", status);
    const r = await api(`/v1/reports?${qs.toString()}`);
    return r.ok ? jsonBlock(r.data) : errBlock(r);
  },
);

server.tool(
  "get_account",
  "Show your RaportAgent account: remaining credits and plan.",
  {},
  async () => {
    const r = await api("/v1/account");
    return r.ok ? jsonBlock(r.data) : errBlock(r);
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
// stderr is safe for logs; stdout is the MCP transport and must stay clean.
console.error(`[raportagent-mcp] connected · base=${BASE} · key=${API_KEY ? "set" : "MISSING"}`);
