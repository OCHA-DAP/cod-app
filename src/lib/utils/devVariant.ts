// Dev-only design variants: `?variant-<name>=<option>` picks one, the first option is the default.
export function devVariant<T extends string>(name: string, options: readonly T[]): T {
  if (!import.meta.env.DEV) return options[0];
  const raw = new URLSearchParams(location.search).get(`variant-${name}`);
  return options.find((o) => o === raw) ?? options[0];
}
