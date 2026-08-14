#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  filterCubes,
  getCodeSets,
  getCoordinateData,
  getCubeMetadata,
  getSeriesInfo,
  getVectorData,
  listCubes,
} from "./wds.js";

const server = new McpServer({ name: "statcan", version: "0.1.0" });

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

function jsonResult(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

// WDS failures (unknown vector, bad coordinate...) come back as tool errors
// carrying the API's own message so the model can self-correct.
function guarded<A extends unknown[]>(fn: (...args: A) => Promise<ToolResult>) {
  return async (...args: A): Promise<ToolResult> => {
    try {
      return await fn(...args);
    } catch (err) {
      return { content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }], isError: true };
    }
  };
}

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

server.registerTool(
  "search_tables",
  {
    title: "Search Statistics Canada data tables",
    description:
      "Keyword search across all ~8,200 Statistics Canada data tables (CPI, GDP, labour force, housing, population...). Returns product IDs to explore with get_table_metadata.",
    inputSchema: {
      query: z.string().describe("Keywords, e.g. 'consumer price index monthly' or 'housing starts'"),
      limit: z.number().int().min(1).max(50).default(15).describe("Max results"),
    },
  },
  guarded(async ({ query, limit }) => {
    const codes = await getCodeSets();
    const cubes = filterCubes(await listCubes(), query, limit);
    return jsonResult(
      cubes.map((c) => ({
        productId: c.productId,
        title: c.title,
        range: `${c.startDate} to ${c.endDate}`,
        frequency: codes.frequency.get(c.frequencyCode),
        ...(c.archived ? { archived: true } : {}),
      })),
    );
  }),
);

server.registerTool(
  "get_table_metadata",
  {
    title: "Get table dimensions and members",
    description:
      "Structure of a Statistics Canada table: its dimensions and their members with member IDs. Large dimensions are truncated — pass member_filter (e.g. 'gasoline') to find specific members. Use the member IDs with get_data_by_coordinate.",
    inputSchema: {
      product_id: z.number().int().describe("Table product ID from search_tables, e.g. 18100004"),
      member_filter: z.string().optional().describe("Keyword to filter dimension members by name"),
      max_members: z.number().int().min(1).max(200).default(25).describe("Max members listed per dimension"),
    },
  },
  guarded(async ({ product_id, member_filter, max_members }) =>
    jsonResult(await getCubeMetadata(product_id, { memberFilter: member_filter, maxMembers: max_members })),
  ),
);

server.registerTool(
  "get_data_by_vectors",
  {
    title: "Get time series by vector ID",
    description:
      "Fetch observations for up to 10 Statistics Canada vector IDs (a vector uniquely identifies one time series, e.g. v41690973 = CPI all-items Canada). Give a date range, or latest_n most recent periods (default 12).",
    inputSchema: {
      vectors: z.array(z.union([z.string(), z.number()])).min(1).max(10).describe("Vector IDs, 'v41690973' or 41690973"),
      latest_n: z.number().int().min(1).max(500).optional().describe("N most recent periods"),
      start_date: isoDate.optional().describe("Start of range, YYYY-MM-DD"),
      end_date: isoDate.optional().describe("End of range, YYYY-MM-DD"),
    },
  },
  guarded(async ({ vectors, latest_n, start_date, end_date }) =>
    jsonResult(await getVectorData(vectors, { latestN: latest_n, startDate: start_date, endDate: end_date })),
  ),
);

server.registerTool(
  "get_data_by_coordinate",
  {
    title: "Get time series by table coordinate",
    description:
      "Fetch observations by choosing one member ID per dimension of a table (get them from get_table_metadata). Example: table 18100004 with member_ids [2, 2] = CPI, Canada, all-items.",
    inputSchema: {
      product_id: z.number().int().describe("Table product ID, e.g. 18100004"),
      member_ids: z.array(z.number().int().positive()).min(1).max(10).describe("One member ID per dimension, in dimension order"),
      latest_n: z.number().int().min(1).max(500).default(12).describe("N most recent periods"),
    },
  },
  guarded(async ({ product_id, member_ids, latest_n }) =>
    jsonResult(await getCoordinateData(product_id, member_ids, latest_n)),
  ),
);

server.registerTool(
  "get_series_info",
  {
    title: "Decode a vector ID",
    description: "What is this vector? Returns the series title, source table, and coordinate for a vector ID.",
    inputSchema: {
      vector: z.union([z.string(), z.number()]).describe("Vector ID, 'v41690973' or 41690973"),
    },
  },
  guarded(async ({ vector }) => jsonResult(await getSeriesInfo(vector))),
);

await server.connect(new StdioServerTransport());
