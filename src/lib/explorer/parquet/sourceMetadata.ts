import { asyncBufferFromUrl, parquetRead } from "hyparquet";
import { compressors } from "hyparquet-compressors";
import { referenceUrl } from "$lib/utils/data";

export interface SourceMetadata {
  source: string;
  iso3: string;
  producer: string | null;
  validFrom: string | null;
}

let metadataPromise: Promise<SourceMetadata[]> | null = null;

function loadMetadata(): Promise<SourceMetadata[]> {
  return asyncBufferFromUrl({ url: referenceUrl("source_metadata") }).then(
    (asyncBuffer) =>
      new Promise((resolve) => {
        parquetRead({
          file: asyncBuffer,
          columns: ["source", "iso3", "producer", "valid_from"],
          compressors,
          rowFormat: "object",
          onComplete(rows) {
            const metadata = (
              rows as Array<{
                source: string;
                iso3: string;
                producer: string | null;
                valid_from: Date | null;
              }>
            ).map((r) => ({
              source: r.source,
              iso3: r.iso3,
              producer: r.producer,
              validFrom: r.valid_from ? r.valid_from.toISOString().slice(0, 10) : null,
            }));
            resolve(metadata);
          },
        });
      }),
  );
}

export function getAllSourceMetadata(): Promise<SourceMetadata[]> {
  if (!metadataPromise) metadataPromise = loadMetadata();
  return metadataPromise;
}

export async function getSourceMetadataForCountry(iso3: string): Promise<SourceMetadata[]> {
  const metadata = await getAllSourceMetadata();
  return metadata.filter((m) => m.iso3 === iso3);
}
