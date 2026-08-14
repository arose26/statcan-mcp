import { describe, expect, it } from "vitest";
import {
  decodeSeries,
  filterCubes,
  normalizeVector,
  padCoordinate,
  parseCodeSets,
  summarizeMetadata,
  unwrap,
  type CubeInfo,
} from "../src/wds.js";

const cubes: CubeInfo[] = [
  { productId: 18100004, title: "Consumer Price Index, monthly, not seasonally adjusted", startDate: "1914-01-01", endDate: "2026-06-01", frequencyCode: 6, archived: false },
  { productId: 18100005, title: "Consumer Price Index, annual average", startDate: "1914-01-01", endDate: "2025-01-01", frequencyCode: 12, archived: false },
  { productId: 34100135, title: "Canada Mortgage and Housing Corporation, housing starts", startDate: "1948-01-01", endDate: "2026-06-01", frequencyCode: 6, archived: false },
];

const codes = parseCodeSets({
  scalar: [
    { scalarFactorCode: 0, scalarFactorDescEn: "units" },
    { scalarFactorCode: 3, scalarFactorDescEn: "thousands" },
  ],
  frequency: [{ frequencyCode: 6, frequencyDescEn: "Monthly" }],
  status: [
    { statusCode: 0, statusDescEn: "" },
    { statusCode: 1, statusDescEn: "normal" },
    { statusCode: 5, statusDescEn: "use with caution" },
  ],
  symbol: [
    { symbolCode: 0, symbolDescEn: "" },
    { symbolCode: 1, symbolDescEn: "preliminary" },
  ],
  uom: [{ memberUomCode: 17, memberUomEn: "Dollars" }],
  wdsResponseStatus: [
    { codeId: 3, codeTextEn: "Request failed" },
    { codeId: 4, codeTextEn: "Vector is invalid" },
  ],
});

describe("filterCubes", () => {
  it("requires every term, case-insensitive, across id and title", () => {
    expect(filterCubes(cubes, "price INDEX monthly", 10)).toEqual([cubes[0]]);
    expect(filterCubes(cubes, "18100005", 10)).toEqual([cubes[1]]);
    expect(filterCubes(cubes, "housing banana", 10)).toEqual([]);
  });

  it("respects the limit", () => {
    expect(filterCubes(cubes, "consumer", 1)).toHaveLength(1);
  });
});

describe("normalizeVector", () => {
  it("accepts v-prefixed strings, bare strings, and numbers", () => {
    expect(normalizeVector("v41690973")).toBe(41690973);
    expect(normalizeVector("V41690973")).toBe(41690973);
    expect(normalizeVector(" 41690973 ")).toBe(41690973);
    expect(normalizeVector(41690973)).toBe(41690973);
  });

  it("rejects garbage", () => {
    expect(() => normalizeVector("vector-one")).toThrow(/Not a valid vector ID/);
    expect(() => normalizeVector(-5)).toThrow(/Not a valid vector ID/);
    expect(() => normalizeVector(1.5)).toThrow(/Not a valid vector ID/);
  });
});

describe("padCoordinate", () => {
  it("pads member IDs to 10 dot-separated positions", () => {
    expect(padCoordinate([2, 2])).toBe("2.2.0.0.0.0.0.0.0.0");
    expect(padCoordinate([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toBe("1.2.3.4.5.6.7.8.9.10");
  });

  it("rejects empty and oversized coordinates", () => {
    expect(() => padCoordinate([])).toThrow(/1-10 member IDs/);
    expect(() => padCoordinate(Array(11).fill(1))).toThrow(/1-10 member IDs/);
  });
});

describe("unwrap", () => {
  it("returns objects from SUCCESS envelopes, array or single", () => {
    expect(unwrap([{ status: "SUCCESS", object: { a: 1 } }])).toEqual([{ a: 1 }]);
    expect(unwrap({ status: "SUCCESS", object: { a: 1 } })).toEqual([{ a: 1 }]);
  });

  it("throws the API's own reason on FAILED items", () => {
    expect(() => unwrap([{ status: "FAILED", object: "Vector doesn't exist" }])).toThrow(
      /FAILED: Vector doesn't exist/,
    );
  });

  it("decodes numeric responseStatusCode failures via code sets", () => {
    // Real WDS failure shape: no message field, just a code.
    const failed = { status: "FAILED", object: { responseStatusCode: 3, productId: 0, vectorDataPoint: [] } };
    expect(() => unwrap([failed], codes)).toThrow(/FAILED: Request failed/);
  });
});

describe("summarizeMetadata", () => {
  const raw = {
    productId: 18100004,
    cubeTitleEn: "Consumer Price Index, monthly, not seasonally adjusted",
    cubeStartDate: "1914-01-01T05:00:00Z",
    cubeEndDate: "2026-06-01T04:00:00Z",
    frequencyCode: 6,
    dimension: [
      {
        dimensionPositionId: 1,
        dimensionNameEn: "Geography",
        member: [
          { memberId: 2, memberNameEn: "Canada" },
          { memberId: 3, memberNameEn: "Ontario" },
        ],
      },
      {
        dimensionPositionId: 2,
        dimensionNameEn: "Products and product groups",
        member: [
          { memberId: 2, memberNameEn: "All-items" },
          { memberId: 50, memberNameEn: "Gasoline" },
          { memberId: 51, memberNameEn: "Fuel oil", memberUomCode: 17 },
        ],
      },
    ],
  };

  it("caps members and flags truncation", () => {
    const summary = summarizeMetadata(raw, { maxMembers: 1 }, codes);
    expect(summary.dimensions[1].members).toEqual([{ memberId: 2, name: "All-items" }]);
    expect(summary.dimensions[1].totalMembers).toBe(3);
    expect(summary.dimensions[1].truncated).toBe(true);
    expect(summary.startDate).toBe("1914-01-01");
  });

  it("filters members by keyword and decodes units", () => {
    const summary = summarizeMetadata(raw, { memberFilter: "fuel" }, codes);
    expect(summary.dimensions[1].members).toEqual([{ memberId: 51, name: "Fuel oil", unit: "Dollars" }]);
    expect(summary.dimensions[1].truncated).toBe(false);
    expect(summary.dimensions[0].members).toEqual([]);
  });
});

describe("decodeSeries", () => {
  it("decodes scale and per-point quality notes", () => {
    const series = decodeSeries(
      {
        vectorId: 111,
        productId: 222,
        coordinate: "2.2.0.0.0.0.0.0.0.0",
        vectorDataPoint: [
          { refPer: "2026-05-01", value: 169.6, scalarFactorCode: 3, statusCode: 1, symbolCode: 0 },
          { refPer: "2026-06-01", value: null, scalarFactorCode: 3, statusCode: 5, symbolCode: 1 },
        ],
      },
      codes,
    );
    expect(series.scale).toBe("thousands");
    expect(series.points[0]).toEqual({ period: "2026-05-01", value: 169.6 });
    expect(series.points[1]).toEqual({ period: "2026-06-01", value: null, note: "use with caution; preliminary" });
  });

  it("omits scale for plain units", () => {
    const series = decodeSeries(
      { vectorId: 1, productId: 2, coordinate: "1", vectorDataPoint: [{ refPer: "2026-01-01", value: 5, scalarFactorCode: 0, statusCode: 1, symbolCode: 0 }] },
      codes,
    );
    expect(series.scale).toBeUndefined();
  });
});
