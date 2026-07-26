# RaportAgent MCP server

A [Model Context Protocol](https://modelcontextprotocol.io) server that puts **RaportAgent**
inside any MCP client — Claude Desktop, Claude Code, Cursor. Ask your assistant to research a
market or map a regulatory landscape, and it generates a sourced RaportAgent report, then pulls
the finished markdown and its audit trail.

Thin wrapper over the RaportAgent REST API (`/v1`), so it inherits per-key rate limits, the
credit model, and the audit trail unchanged.

## Tools

| Tool | What it does |
|------|--------------|
| `generate_report` | Start a report (`query`, `depth`, optional `template: compliance` for a legal/regulatory brief). Returns a `report_id`; optionally polls with `wait_seconds`. Costs 1 credit. |
| `get_report_status` | queued / running / completed / failed |
| `get_report` | The finished report's full markdown + sections |
| `get_report_audit` | Provenance: AI models, agents, source counts, SHA-256 of the exact content |
| `list_reports` | Your recent reports |
| `get_account` | Remaining credits and plan |

## Setup

1. Get an API key: RaportAgent → **My account → API keys** (an `ra_live_…` key).
2. Register it with your MCP client — no clone, no build, `npx` pulls the published package.

### Claude Desktop

Add to `claude_desktop_config.json`
(macOS: `~/Library/Application Support/Claude/`, Windows: `%APPDATA%\Claude\`):

```json
{
  "mcpServers": {
    "raportagent": {
      "command": "npx",
      "args": ["-y", "@raportagent/mcp"],
      "env": {
        "RAPORTAGENT_API_KEY": "ra_live_xxx"
      }
    }
  }
}
```

### Claude Code

```bash
claude mcp add raportagent -e RAPORTAGENT_API_KEY=ra_live_xxx -- npx -y @raportagent/mcp
```

### Cursor

Same `command`/`args`/`env` shape as Claude Desktop above, under Cursor's MCP settings.

### Running from source (contributing / debugging only)

```bash
git clone <this repo>
cd mcp-server
npm install
npm run build
```
Then point `command`/`args` at `node` / `dist/index.js` with an absolute path instead of `npx`.

## Config

| Env | Default | Notes |
|-----|---------|-------|
| `RAPORTAGENT_API_KEY` | — | **Required.** `ra_live_…` key. |
| `RAPORTAGENT_BASE_URL` | `https://raportagent.com` | Override for self-hosted / staging. |

## Notes

- Generation takes ~7–15 minutes. `generate_report` returns immediately with a `report_id`;
  the assistant should poll `get_report_status` (or pass `wait_seconds`) before `get_report`.
- `stdout` is the MCP transport — the server logs only to `stderr`.
- The API key is only ever sent to your configured `RAPORTAGENT_BASE_URL`.
