// Client for Statistics Canada's Web Data Service (WDS)
// https://www.statcan.gc.ca/en/developers/wds/user-guide
// Pure logic lives here so it can be unit-tested without the MCP runtime.

const BASE = "https://www150.statcan.gc.ca/t1/wds/rest";

async function wdsFetch(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`${BASE}${path}`, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body.message ?? `WDS request failed with status ${res.status}`);
  }
  return body;
}

function wdsPost(path: string, payload: unknown): Promise<any> {
  return wdsFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

// WDS wraps results in {status, object} envelopes — one per requested item,
// but single-item responses may arrive unwrapped from an array. Failures carry
// only a numeric responseStatusCode; `codes` decodes it to readable text.
export function unwrap(body: any, codes?: CodeSets): any[] {
  const items = Array.isArray(body) ? body : [body];
  return items.map((item) => {
    if (item.status !== "SUCCESS") {
      const reason =
        codes?.responseStatus.get(item.object?.responseStatusCode) ??
        item.object?.message ??
        (typeof item.object === "string" ? item.object : JSON.stringify(item.object ?? item));
      throw new Error(`WDS returned ${item.status ?? "an error"}: ${reason}`);
    }
    return item.object;
  });
}

// ---------------------------------------------------------------------------
// Code sets: WDS speaks in numeric enums (scalarFactorCode 3 = "thousands").
// Fetched once per process and decoded at runtime so nothing goes stale.

export interface CodeSets {
  scalar: Map<number, string>;
  frequency: Map<number, string>;
  status: Map<number, string>;
  symbol: Map<number, string>;
  uom: Map<number, string>;
  responseStatus: Map<number, string>;
}

export function parseCodeSets(object: any): CodeSets {
  const toMap = (rows: any[], codeKey: string, descKey: string) =>
    new Map<number, string>((rows ?? []).map((r) => [r[codeKey], r[descKey]]));
  return {
    scalar: toMap(object.scalar, "scalarFactorCode", "scalarFactorDescEn"),
    frequency: toMap(object.frequency, "frequencyCode", "frequencyDescEn"),
    status: toMap(object.status, "statusCode", "statusDescEn"),
    symbol: toMap(object.symbol, "symbolCode", "symbolDescEn"),
    uom: toMap(object.uom, "memberUomCode", "memberUomEn"),
    responseStatus: toMap(object.wdsResponseStatus, "codeId", "codeTextEn"),
  };
}

let codeSetsCache: CodeSets | undefined;
export async function getCodeSets(): Promise<CodeSets> {
  if (!codeSetsCache) {
    codeSetsCache = parseCodeSets(unwrap(await wdsFetch("/getCodeSets"))[0]);
  }
  return codeSetsCache;
}

// ---------------------------------------------------------------------------
// Table (cube) catalogue: ~8,200 tables, memoized for process lifetime.

export interface CubeInfo {
  productId: number;
  title: string;
  startDate: string;
  endDate: string;
  frequencyCode: number;
  archived: boolean;
}

let cubeCache: CubeInfo[] | undefined;
export async function listCubes(): Promise<CubeInfo[]> {
  if (!cubeCache) {
    const body = await wdsFetch("/getAllCubesListLite");
    cubeCache = (body as any[]).map((c) => ({
      productId: c.productId,
      title: c.cubeTitleEn ?? "",
      startDate: String(c.cubeStartDate ?? "").slice(0, 10),
      endDate: String(c.cubeEndDate ?? "").slice(0, 10),
      frequencyCode: c.frequencyCode,
      archived: c.archived === "1" || c.archived === 1,
    }));
  }
  return cubeCache;
}

export function filterCubes(all: CubeInfo[], query: string, limit: number): CubeInfo[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  return all
    .filter((c) => {
      const haystack = `${c.productId} ${c.title}`.toLowerCase();
      return terms.every((t) => haystack.includes(t));
    })
    .slice(0, limit);
}

// ---------------------------------------------------------------------------
// Cube metadata: dimensions can have hundreds of members (CPI products: 359),
// so members are filterable and capped rather than dumped into context.

export interface MetadataOptions {
  memberFilter?: string;
  maxMembers?: number;
}

export interface DimensionSummary {
  position: number;
  name: string;
  totalMembers: number;
  members: { memberId: number; name: string; unit?: string }[];
  truncated: boolean;
}

export interface CubeMetadataSummary {
  productId: number;
  title: string;
  startDate: string;
  endDate: string;
  frequencyCode: number;
  dimensions: DimensionSummary[];
}

export function summarizeMetadata(raw: any, opts: MetadataOptions = {}, codes?: CodeSets): CubeMetadataSummary {
  const max = opts.maxMembers ?? 25;
  const filter = opts.memberFilter?.toLowerCase();
  const dimensions: DimensionSummary[] = (raw.dimension ?? []).map((d: any) => {
    const all = (d.member ?? []) as any[];
    const matching = filter ? all.filter((m) => String(m.memberNameEn ?? "").toLowerCase().includes(filter)) : all;
    const members = matching.slice(0, max).map((m) => {
      const unit = m.memberUomCode != null ? codes?.uom.get(m.memberUomCode) : undefined;
      return { memberId: m.memberId, name: m.memberNameEn ?? "", ...(unit ? { unit } : {}) };
    });
    return {
      position: d.dimensionPositionId,
      name: d.dimensionNameEn ?? "",
      totalMembers: all.length,
      members,
      truncated: matching.length > members.length,
    };
  });
  return {
    productId: Number(raw.productId),
    title: raw.cubeTitleEn ?? "",
    startDate: String(raw.cubeStartDate ?? "").slice(0, 10),
    endDate: String(raw.cubeEndDate ?? "").slice(0, 10),
    frequencyCode: raw.frequencyCode,
    dimensions,
  };
}

export async function getCubeMetadata(productId: number, opts: MetadataOptions = {}): Promise<CubeMetadataSummary> {
  const codes = await getCodeSets();
  const [raw] = unwrap(await wdsPost("/getCubeMetadata", [{ productId }]), codes);
  return summarizeMetadata(raw, opts, codes);
}

// ---------------------------------------------------------------------------
// Series data. Users and docs write vector IDs as "v41690973"; the API wants
// the bare number. Accept both.

export function normalizeVector(v: string | number): number {
  const n = typeof v === "number" ? v : Number(String(v).trim().replace(/^[vV]/, ""));
  if (!Number.isInteger(n) || n <= 0) throw new Error(`Not a valid vector ID: ${v}`);
  return n;
}

// Coordinates address a series inside a table: one member ID per dimension,
// always padded to 10 dot-separated positions (unused dimensions are 0).
export function padCoordinate(memberIds: number[]): string {
  if (memberIds.length < 1 || memberIds.length > 10) {
    throw new Error(`A coordinate needs 1-10 member IDs, got ${memberIds.length}`);
  }
  return [...memberIds, ...Array(10 - memberIds.length).fill(0)].join(".");
}

export interface DataPoint {
  period: string;
  value: number | null;
  note?: string;
}

export interface SeriesData {
  vectorId: number;
  productId: number;
  coordinate: string;
  scale?: string;
  points: DataPoint[];
}

export function decodeSeries(raw: any, codes: CodeSets): SeriesData {
  const points: DataPoint[] = (raw.vectorDataPoint ?? []).map((p: any) => {
    const notes: string[] = [];
    // statusCode/symbolCode flag data quality (E = use with caution, p = preliminary...)
    const status = codes.status.get(p.statusCode);
    if (status && p.statusCode !== 0 && !/normal/i.test(status)) notes.push(status);
    const symbol = codes.symbol.get(p.symbolCode);
    if (symbol && p.symbolCode !== 0) notes.push(symbol);
    return { period: p.refPer, value: p.value, ...(notes.length ? { note: notes.join("; ") } : {}) };
  });
  const scalarCode = raw.vectorDataPoint?.[0]?.scalarFactorCode;
  const scale = scalarCode ? codes.scalar.get(scalarCode) : undefined;
  return {
    vectorId: raw.vectorId,
    productId: raw.productId,
    coordinate: raw.coordinate,
    ...(scale ? { scale } : {}),
    points,
  };
}

export interface RangeOptions {
  latestN?: number;
  startDate?: string;
  endDate?: string;
}

export async function getVectorData(vectors: (string | number)[], opts: RangeOptions = {}): Promise<SeriesData[]> {
  const ids = vectors.map(normalizeVector);
  const codes = await getCodeSets();
  let body: any;
  if (opts.startDate || opts.endDate) {
    const params = new URLSearchParams({ vectorIds: ids.join(",") });
    if (opts.startDate) params.set("startRefPeriod", opts.startDate);
    if (opts.endDate) params.set("endReferencePeriod", opts.endDate);
    body = await wdsFetch(`/getDataFromVectorByReferencePeriodRange?${params}`);
  } else {
    const latestN = opts.latestN ?? 12; // default keeps responses context-friendly
    body = await wdsPost("/getDataFromVectorsAndLatestNPeriods", ids.map((vectorId) => ({ vectorId, latestN })));
  }
  return unwrap(body, codes).map((raw) => decodeSeries(raw, codes));
}

export async function getCoordinateData(productId: number, memberIds: number[], latestN: number): Promise<SeriesData> {
  const coordinate = padCoordinate(memberIds);
  const codes = await getCodeSets();
  const body = await wdsPost("/getDataFromCubePidCoordAndLatestNPeriods", [{ productId, coordinate, latestN }]);
  return decodeSeries(unwrap(body, codes)[0], codes);
}

export interface SeriesInfo {
  vectorId: number;
  productId: number;
  coordinate: string;
  title: string;
  frequency?: string;
}

export async function getSeriesInfo(vector: string | number): Promise<SeriesInfo> {
  const vectorId = normalizeVector(vector);
  const codes = await getCodeSets();
  const [raw] = unwrap(await wdsPost("/getSeriesInfoFromVector", [{ vectorId }]), codes);
  return {
    vectorId,
    productId: raw.productId,
    coordinate: raw.coordinate,
    title: raw.SeriesTitleEn ?? "",
    frequency: codes.frequency.get(raw.frequencyCode),
  };
}
