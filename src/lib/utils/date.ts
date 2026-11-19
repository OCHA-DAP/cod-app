const FORMAT = new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });

// "2025-08-01" as "01 Aug 2025"; input that isn't a YYYY-MM-DD date comes back unchanged.
export function formatDate(iso: string): string {
  if (!/^\d{4}-\d{2}-\d{2}/.test(iso.trim())) return iso;
  const date = new Date(`${iso.trim().slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? iso : FORMAT.format(date);
}
