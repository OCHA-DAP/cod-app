import { asyncBufferFromUrl, parquetRead } from "hyparquet";
import { compressors } from "hyparquet-compressors";
import { referenceUrl } from "$lib/utils/data";

export interface SourceMatch {
  source: string;
  level: number;
  iso3: string;
  preferredSource: string;
  matchedCount: number;
  // Values of the source's tile id field (adminTiles idField), as strings.
  unmatchedCodes: string[];
}

let matchPromise: Promise<SourceMatch[]> | null = null;

function loadMatch(): Promise<SourceMatch[]> {
  return asyncBufferFromUrl({ url: referenceUrl("source_match") }).then(
    (asyncBuffer) =>
      new Promise((resolve) => {
        parquetRead({
          file: asyncBuffer,
          columns: [
            "source",
            "level",
            "iso3",
            "preferred_source",
            "matched_count",
            "unmatched_codes",
          ],
          compressors,
          rowFormat: "object",
          onComplete(rows) {
            const matches = (
              rows as Array<{
                source: string;
                level: bigint | number;
                iso3: string;
                preferred_source: string;
                matched_count: bigint | number;
                unmatched_codes: string[] | null;
              }>
            ).map((r) => ({
              source: r.source,
              // BIGINT columns decode as JS bigint; coerce to number.
              level: Number(r.level),
              iso3: r.iso3,
              preferredSource: r.preferred_source,
              matchedCount: Number(r.matched_count),
              unmatchedCodes: r.unmatched_codes ?? [],
            }));
            resolve(matches);
          },
        });
      }),
  );
}

export function getAllSourceMatch(): Promise<SourceMatch[]> {
  if (!matchPromise) matchPromise = loadMatch();
  return matchPromise;
}

export async function getMatchForCountry(iso3: string): Promise<SourceMatch[]> {
  const matches = await getAllSourceMatch();
  return matches.filter((m) => m.iso3 === iso3);
}
