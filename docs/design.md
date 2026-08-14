# statcan-mcp — Design

**Date:** 2026-08-14
**Goal:** Second public portfolio MCP server, complementing `bank-of-canada-mcp`.

## Idea selection

Candidates checked against existing public servers before committing:

1. Network diagnostics (DNS/TLS/RDAP) — **taken** (mcp-netutils, mcp-nettools).
2. Git repository archaeology (hotspots, bus factor, coupling) — **taken**
   (GitIntel-MCP-Server, msr-mcp, repowise).
3. Canadian Parliament (OpenParliament) — **taken** (FedMCP).
4. **Statistics Canada Web Data Service (chosen)** — confirmed unserved. CPI,
   GDP, labour force, housing, population: 8,226 data tables, free, no key.

The differentiator isn't just the gap. The WDS API is famously awkward —
POST-only lookups, opaque numeric vector IDs, cube/coordinate addressing,
numeric code enums everywhere — so the engineering story is **API ergonomics
for LLMs**: turning an API that speaks in `scalarFactorCode: 3` into one that
says "values are in thousands."

## Ergonomic moves (the interesting part)

- **Discovery flow taught in tool descriptions:** search_tables →
  get_table_metadata (pick member IDs per dimension) → get_data_by_coordinate;
  or straight to get_data_by_vectors when a vector ID is known.
- **Dimension members are capped and filterable.** The CPI table has a
  359-member product dimension; dumping it would flood context. Metadata
  returns the first N members per dimension plus a `truncated` flag, and a
  `member_filter` keyword search ("gasoline") to find the needle.
- **Codes decoded at runtime** via the WDS `getCodeSets` endpoint (memoized):
  scalar factors, frequencies, data-point status ("use with caution") and
  symbols (preliminary/revised). Nothing hardcoded to go stale.
- **Vector IDs normalized:** users say "v41690973", the API wants `41690973`.
  Both accepted.
- **Coordinates padded:** callers pass the member IDs that matter
  (`[2, 2]`); the client pads to the required 10-dimension form
  (`2.2.0.0.0.0.0.0.0.0`).
- **Defaults prevent context floods:** data calls default to the 12 most
  recent periods.

## Architecture

Mirror of bank-of-canada-mcp (deliberately — a consistent house style across
the two repos is itself a signal):

- `src/wds.ts` — WDS client + pure logic, no MCP imports, offline-testable.
- `src/index.ts` — McpServer wiring, five tools, shared error guard.
- `test/wds.test.ts` — vitest, stubbed fetch.
- `scripts/smoke.mjs` — live stdio smoke test used before release.

## Tools

| Tool | Purpose |
|------|---------|
| `search_tables(query, limit?)` | Keyword search over all 8,226 tables (memoized catalogue), frequency decoded, archived flagged |
| `get_table_metadata(product_id, member_filter?, max_members?)` | Title, date range, dimensions and members — capped/filterable |
| `get_data_by_vectors(vectors[], latest_n? \| start_date?+end_date?)` | Time series by vector ID(s), range or latest-N |
| `get_data_by_coordinate(product_id, member_ids[], latest_n?)` | Time series by table + dimension member choices |
| `get_series_info(vector)` | Decode a vector ID: which table/coordinate/title it is |

## Error handling

WDS wraps each result in `{status, object}` envelopes and reports failures
per-item; top-level errors use `{message}`. Both are surfaced as MCP tool
errors with the API's own text. Single-item responses may arrive unwrapped —
the client normalizes array-vs-object.

## Testing

Offline unit tests: cube filtering, vector normalization, coordinate padding,
envelope unwrapping (incl. FAILED items), metadata summarization
(filter/truncation), point decoding against fixture code sets. Live smoke
before release exercises all five tools plus one failure path.

## Out of scope (v1)

Full-table CSV downloads, French output (`*_Fr` fields exist; English only for
now), changed-series notifications, HTTP transport.
