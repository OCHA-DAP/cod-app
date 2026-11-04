import { asyncBufferFromUrl, parquetReadObjects } from "hyparquet";
import { compressors } from "hyparquet-compressors";
import { referenceUrl } from "$lib/utils/data";

function cell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = value instanceof Date ? value.toISOString().slice(0, 10) : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** The source_comparison table as a CSV blob, built from its parquet. */
export async function sourceComparisonCsv(): Promise<Blob> {
  const file = await asyncBufferFromUrl({ url: referenceUrl("source_comparison") });
  const rows = await parquetReadObjects({ file, compressors });
  const columns = rows.length ? Object.keys(rows[0]) : [];
  const lines = [columns.join(","), ...rows.map((r) => columns.map((c) => cell(r[c])).join(","))];
  return new Blob([lines.join("\r\n") + "\r\n"], { type: "text/csv" });
}
