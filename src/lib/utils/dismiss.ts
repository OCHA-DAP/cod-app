// Svelte action: closes a <details> menu on a click outside it or on Escape, like the site header's menus.
export function dismiss(details: HTMLDetailsElement) {
  const onClick = (e: MouseEvent) => {
    if (details.open && !details.contains(e.target as Node)) details.open = false;
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || !details.open) return;
    details.open = false;
    details.querySelector("summary")?.focus();
  };
  document.addEventListener("click", onClick);
  document.addEventListener("keydown", onKey);
  return {
    destroy() {
      document.removeEventListener("click", onClick);
      document.removeEventListener("keydown", onKey);
    },
  };
}
