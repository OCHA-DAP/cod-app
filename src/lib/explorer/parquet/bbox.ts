import { asyncBufferFromUrl, parquetRead } from "hyparquet";
import { compressors } from "hyparquet-compressors";
import { referenceUrl } from "$lib/utils/data";

export type Bbox = [number, number, number, number];

// Per-country fit bboxes from scripts/catalog/explorer/bbox.py: antimeridian-aware, so xmax may
// exceed 180 near the dateline and goes to map.fitBounds as is.
async function loadBboxMap(file: string): Promise<Map<string, Bbox>> {
  const url = referenceUrl(file);
  const asyncBuffer = await asyncBufferFromUrl({ url });
  const map = new Map<string, Bbox>();

  await new Promise<void>((resolve) => {
    parquetRead({
      file: asyncBuffer,
      columns: ["iso3", "xmin", "ymin", "xmax", "ymax"],
      compressors,
      rowFormat: "object",
      onComplete(rows) {
        for (const row of rows as Array<{
          iso3: string;
          xmin: number;
          ymin: number;
          xmax: number;
          ymax: number;
        }>) {
          if (row.iso3) {
            map.set(row.iso3, [row.xmin, row.ymin, row.xmax, row.ymax]);
          }
        }
        resolve();
      },
    });
  });

  return map;
}

const mapPromises = new Map<string, Promise<Map<string, Bbox>>>();

export async function getBboxForIso3(iso3: string, file = "country_bbox"): Promise<Bbox | null> {
  if (!mapPromises.has(file)) {
    mapPromises.set(file, loadBboxMap(file));
  }
  const map = await mapPromises.get(file)!;
  return map.get(iso3) ?? null;
}
