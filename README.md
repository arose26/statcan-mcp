# statcan-mcp

An [MCP](https://modelcontextprotocol.io) server that gives Claude and other LLMs live access to **Statistics Canada** — all 8,200+ data tables from the [Web Data Service](https://www.statcan.gc.ca/en/developers/wds): CPI, GDP, labour force, housing starts, population, trade, and more.

No API key required.

Sibling project: [bank-of-canada-mcp](https://github.com/arose26/bank-of-canada-mcp) for Bank of Canada rates and FX.

## Why this exists

StatCan's API is powerful but hostile: POST-only lookups, opaque numeric vector IDs, 10-position "coordinate" addressing, and numeric code enums everywhere (`scalarFactorCode: 3`). This server translates it into something an LLM can actually drive:

- **Discovery flow built into the tools** — search tables → inspect dimensions → fetch data, with each tool description pointing to the next step.
- **Context-friendly by default** — a CPI dimension has 359 members and a series can span a century; members are capped and keyword-filterable, data defaults to the last 12 periods.
- **Codes decoded at runtime** via StatCan's own code-set endpoint — responses say `"scale": "thousands"` and `"note": "use with caution"`, not `scalarFactorCode: 3, statusCode: 5`. Nothing hardcoded to go stale.
- **Forgiving inputs** — vector IDs accepted as `v41690973` or `41690973`; coordinates padded automatically.

## Quick start

**Claude Code**

```bash
claude mcp add statcan -- npx -y statcan-mcp
```

**Claude Desktop** — add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "statcan": {
      "command": "npx",
      "args": ["-y", "statcan-mcp"]
    }
  }
}
```

The same `npx` invocation works in Cursor, Windsurf, and any other MCP client.

## Tools

| Tool | What it does |
|------|--------------|
| `search_tables` | Keyword search across all ~8,200 data tables |
| `get_table_metadata` | A table's dimensions and members (capped, filterable) — the map you need to pull data |
| `get_data_by_vectors` | Time series by vector ID(s), date range or latest-N |
| `get_data_by_coordinate` | Time series by table + one member choice per dimension |
| `get_series_info` | Decode a mystery vector ID into its title and source table |

## Example prompts

- *"What's Canada's current unemployment rate, and how has it trended over 12 months?"*
- *"Compare gasoline price inflation in Ontario vs Quebec since 2024."*
- *"How many housing starts were there in Canada last quarter?"*
- *"What is vector v41690973?"*

## Development

```bash
npm install
npm test           # offline unit tests (vitest)
npm run build      # tsc → dist/
node scripts/smoke.mjs   # live smoke test against the real API
```

Architecture: [`src/wds.ts`](src/wds.ts) is a plain WDS client with pure, unit-tested logic (catalogue search, coordinate padding, code decoding); [`src/index.ts`](src/index.ts) is the MCP wiring. API failures (unknown vector, bad coordinate) come back as MCP tool errors carrying StatCan's own message so the model can self-correct.

## Notes

- Data is © Statistics Canada, used under the [Statistics Canada Open Licence](https://www.statcan.gc.ca/en/reference/licence). This project is not affiliated with or endorsed by Statistics Canada.
- English output only for now (the API also carries French — see roadmap).

## Roadmap

- French-language output (`*Fr` fields are already in the API responses)
- Full-table CSV download for bulk analysis
- Streamable HTTP transport for remote deployment

## License

MIT
