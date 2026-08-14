// Live smoke test: drives the built server over stdio against the real WDS API.
// Usage: npm run build && node scripts/smoke.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({ name: "smoke", version: "0.0.0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"] }));

const { tools } = await client.listTools();
console.log("tools:", tools.map((t) => t.name).join(", "));

const calls = [
  ["search_tables", { query: "consumer price index monthly", limit: 3 }],
  ["get_table_metadata", { product_id: 18100004, member_filter: "gasoline" }],
  ["get_data_by_vectors", { vectors: ["v41690973"], latest_n: 3 }],
  ["get_data_by_vectors", { vectors: [41690973], start_date: "2026-01-01", end_date: "2026-03-01" }],
  ["get_data_by_coordinate", { product_id: 18100004, member_ids: [2, 2], latest_n: 2 }],
  ["get_series_info", { vector: "v41690973" }],
  ["get_data_by_vectors", { vectors: [2000000000], latest_n: 1 }], // nonexistent vector: must return isError, not crash
];

for (const [name, args] of calls) {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content[0].text;
  console.log(`\n== ${name} ${res.isError ? "(isError)" : ""}\n${text.slice(0, 500)}`);
}

await client.close();
console.log("\nSMOKE OK");
