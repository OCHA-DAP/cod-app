import { asyncBufferFromUrl, parquetRead } from "hyparquet";
import { compressors } from "hyparquet-compressors";
import { parseCsv } from "$lib/explorer/csv";
import { iso3Url } from "$lib/utils/data";
import { base } from "$lib/utils/paths";

export const LEVELS = [1, 2, 3, 4] as const;
export type Level = (typeof LEVELS)[number];

export const polygonsUrl = (iso3: string, n: number, ext = "parquet") =>
  iso3Url(iso3, `adm${n}_polygons.${ext}`);

// Status data the deploy fetches into public/status/data/ (npm run fetch:status).
async function statusCsv(file: string): Promise<Record<string, string>[]> {
  const res = await fetch(`${base}status/data/${file}`);
  if (!res.ok) return [];
  const [header, ...rows] = parseCsv((await res.text()).replace(/^\uFEFF/, ""));
  return rows
    .filter((r) => r.length === header.length)
    .map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]])));
}

export type CodMetadata = Record<string, string>;

const versionNumber = (v: string | undefined) => Number(/\d+/.exec(v ?? "")?.[0] ?? 0);

let metadataPromise: Promise<Map<string, CodMetadata>> | null = null;

// COD-AB metadata rows for locations in the current system that are also on HDX; cod-ab-<iso3>
// datasets without a metadata row are older CODs and get no link.
export function codAbOnHdx(): Promise<Map<string, CodMetadata>> {
  metadataPromise ??= Promise.all([statusCsv("cod_metadata.csv"), statusCsv("hdx.csv")]).then(
    ([meta, hdx]) => {
      const onHdx = new Set(hdx.map((r) => r.iso3));
      const latest = new Map<string, CodMetadata>();
      for (const r of meta) {
        if (!onHdx.has(r.country_iso3)) continue;
        const prev = latest.get(r.country_iso3);
        if (!prev || versionNumber(r.version) > versionNumber(prev.version)) latest.set(r.country_iso3, r);
      }
      return latest;
    },
  );
  metadataPromise.catch(() => (metadataPromise = null));
  return metadataPromise;
}

async function readLevels(url: string): Promise<number[]> {
  const file = await asyncBufferFromUrl({ url });
  return new Promise((resolve) => {
    parquetRead({
      file,
      columns: ["level"],
      compressors,
      rowFormat: "object",
      onComplete: (rows) => resolve((rows as { level: number }[]).map((r) => r.level)),
    });
  });
}

// Units per admin level in the location's current boundaries; a level a location lacks counts 0.
export async function unitCounts(iso3: string): Promise<Record<Level, number>> {
  const counts = await Promise.all(
    LEVELS.map(async (n) => (await readLevels(polygonsUrl(iso3, n))).filter((l) => l === n).length),
  );
  return Object.fromEntries(LEVELS.map((n, i) => [n, counts[i]])) as Record<Level, number>;
}
