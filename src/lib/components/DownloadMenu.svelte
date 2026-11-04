<script lang="ts">
  import { downloadBlob } from "$lib/utils/download";
  import {
    gdalGeoJSONFormat,
    listFormats,
    runExport,
    runExportZip,
    sourceKind,
    type ExportFormat,
    type ExportResult,
    type ExportSource,
  } from "$lib/db/export";

  let {
    primaryLabel,
    filenameStem,
    cachedGeoJSON,
    exportSource,
    zipName,
    disabled = false,
    excludeFormatIds = [],
    variant = "primary",
  }: {
    primaryLabel: string;
    filenameStem: string;
    cachedGeoJSON?: string;
    // Several sources download together as one zip named `zipName`.
    exportSource: ExportSource | ExportSource[];
    zipName?: string;
    disabled?: boolean;
    excludeFormatIds?: string[];
    variant?: "primary" | "secondary";
  } = $props();

  let rootEl: HTMLDivElement | undefined = $state();
  let caretEl: HTMLButtonElement | undefined = $state();
  let menuEl: HTMLUListElement | undefined = $state();
  let open = $state(false);
  let busy = $state(false);
  let error = $state<string | null>(null);
  let formats = $state<ExportFormat[] | null>(null);
  let formatsError = $state<string | null>(null);
  let loadingFormats = $state(false);

  const visibleFormats = $derived(
    formats ? formats.filter((f) => !excludeFormatIds.includes(f.id)) : null,
  );

  const cachedGeoJSONFormat: ExportFormat = {
    id: "geojson_cached",
    label: "GeoJSON (.geojson)",
    ext: ".geojson",
    mime: "application/geo+json",
    kind: "geojson_cached",
    rank: 0,
  };

  const csvFormat: ExportFormat = {
    id: "csv",
    label: "CSV (.csv)",
    ext: ".csv",
    mime: "text/csv",
    kind: "csv",
    rank: 1,
  };

  const firstSource = $derived(Array.isArray(exportSource) ? exportSource[0] : exportSource);
  const isTabular = $derived(sourceKind(firstSource) === "tabular");

  $effect(() => {
    if (!open) return;
    const onDocMouseDown = (e: MouseEvent) => {
      if (rootEl && !rootEl.contains(e.target as Node)) {
        open = false;
      }
    };
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  });

  async function ensureFormats() {
    if (formats || loadingFormats) return;
    loadingFormats = true;
    formatsError = null;
    try {
      formats = await listFormats(firstSource);
    } catch (e) {
      formatsError = e instanceof Error ? e.message : String(e);
    } finally {
      loadingFormats = false;
    }
  }

  function triggerDownload({ blob, filename }: ExportResult) {
    downloadBlob(blob, filename);
  }

  function exportAs(fmt: ExportFormat): Promise<ExportResult> {
    return Array.isArray(exportSource)
      ? runExportZip(exportSource, fmt, filenameStem, zipName ?? filenameStem)
      : runExport(exportSource, fmt, filenameStem, cachedGeoJSON);
  }

  async function handlePrimary() {
    error = null;
    busy = true;
    try {
      // Format picked from source kind + cached availability:
      //  - tabular source → CSV (always native COPY, no spatial drivers)
      //  - spatial + cached string → use cached GeoJSON for instant download
      //  - spatial + no cache → GDAL GeoJSON via OPFS (avoids re-OOM on big results)
      let fmt: ExportFormat;
      if (isTabular) {
        fmt = csvFormat;
      } else if (cachedGeoJSON) {
        fmt = cachedGeoJSONFormat;
      } else {
        fmt = gdalGeoJSONFormat;
      }
      const r = await exportAs(fmt);
      triggerDownload(r);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  async function handleToggle() {
    open = !open;
    if (open) {
      error = null;
      await ensureFormats();
    }
  }

  async function handlePick(fmt: ExportFormat) {
    open = false;
    busy = true;
    error = null;
    try {
      const r = await exportAs(fmt);
      triggerDownload(r);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  function handleMenuKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      open = false;
      caretEl?.focus();
    }
  }
</script>

<div class="dl-group" class:dl-secondary={variant === "secondary"} bind:this={rootEl}>
  <button
    type="button"
    class="dl-btn dl-primary"
    onclick={handlePrimary}
    disabled={disabled || busy}
  >
    {primaryLabel}
  </button>
  <button
    bind:this={caretEl}
    type="button"
    class="dl-btn dl-caret"
    aria-haspopup="menu"
    aria-expanded={open}
    aria-label="More download formats"
    onclick={handleToggle}
    disabled={disabled || busy}
  >
    <svg
      viewBox="0 0 12 12"
      width="12"
      height="12"
      aria-hidden="true"
      class="dl-caret-icon"
      class:dl-caret-open={open}
    >
      <path
        d="M2 4 L6 8 L10 4"
        stroke="currentColor"
        stroke-width="1.5"
        fill="none"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  </button>

  {#if open}
    <ul
      bind:this={menuEl}
      class="dl-menu"
      role="menu"
      onkeydown={handleMenuKeydown}
    >
      {#if loadingFormats || (formats === null && !formatsError)}
        <li class="dl-info" role="none">Loading formats…</li>
      {:else if formatsError}
        <li class="dl-error" role="none">{formatsError}</li>
      {:else if visibleFormats}
        {#each visibleFormats as f (f.id)}
          <li role="none">
            <button
              type="button"
              role="menuitem"
              class="dl-item"
              disabled={busy}
              onclick={() => handlePick(f)}
            >
              {f.label}
            </button>
          </li>
        {/each}
      {/if}
    </ul>
  {/if}

  {#if busy}
    <p class="dl-status">Exporting…</p>
  {/if}
  {#if error}
    <p class="dl-error-line">{error}</p>
  {/if}
</div>

<style>
  .dl-group {
    position: relative;
    display: flex;
    flex-wrap: wrap;
  }

  .dl-btn {
    background: var(--brand-primary--text);
    color: var(--cd-white);
    border: none;
    padding: 0.6rem 1rem;
    font-size: 0.875rem;
    font-weight: 500;
    cursor: pointer;
  }

  .dl-btn:hover:not(:disabled) {
    background: var(--brand-primary--dark);
  }

  .dl-btn:disabled {
    background: var(--cd-grey--300);
    color: var(--cd-grey--500);
    cursor: not-allowed;
  }

  /* Secondary variant: for a less-prominent action alongside a primary
     DownloadMenu elsewhere on the same page (e.g. "Download issues" next to
     the main "Download GeoJSON" CTA) — outline style instead of solid blue. */
  .dl-group.dl-secondary .dl-btn {
    background: var(--cd-white);
    color: var(--cd-grey--800);
    border: 1px solid var(--cd-grey--500);
  }

  .dl-group.dl-secondary .dl-btn:hover:not(:disabled) {
    background: var(--brand-primary--lightest);
  }

  .dl-group.dl-secondary .dl-primary {
    border-right: none;
  }

  .dl-primary {
    flex: 1;
    border-radius: var(--brand-radius--sm) 0 0 var(--brand-radius--sm);
  }

  .dl-caret {
    padding: 0.6rem 0.5rem;
    border-radius: 0 var(--brand-radius--sm) var(--brand-radius--sm) 0;
    border-left: 1px solid rgba(255, 255, 255, 0.2);
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }

  .dl-caret-icon {
    transition: transform 0.15s ease;
  }

  .dl-caret-open {
    transform: rotate(180deg);
  }

  .dl-menu {
    position: absolute;
    right: 0;
    top: calc(100% + 4px);
    background: var(--cd-white);
    border: 1px solid var(--cd-grey--400);
    border-radius: var(--brand-radius--sm);
    padding: 0.25rem;
    min-width: 100%;
    z-index: 10;
    list-style: none;
    margin: 0;
  }

  .dl-item {
    width: 100%;
    text-align: left;
    background: transparent;
    border: none;
    padding: 0.5rem 0.75rem;
    font-size: 0.875rem;
    color: var(--cd-grey--900);
    cursor: pointer;
    border-radius: var(--brand-radius--sm);
  }

  .dl-item:hover:not(:disabled) {
    background: var(--brand-primary--lightest);
  }

  .dl-item:disabled {
    color: var(--cd-grey--600);
    cursor: not-allowed;
  }

  .dl-info {
    color: var(--cd-grey--800);
    font-size: 0.8rem;
    padding: 0.5rem 0.75rem;
  }

  .dl-error {
    color: var(--brand-error);
    font-size: 0.8rem;
    padding: 0.5rem 0.75rem;
  }

  .dl-status {
    width: 100%;
    margin: 0.4rem 0 0;
    font-size: 0.8rem;
    color: var(--cd-grey--800);
  }

  .dl-error-line {
    width: 100%;
    margin: 0.4rem 0 0;
    font-size: 0.8rem;
    color: var(--brand-error);
    word-break: break-word;
  }
</style>
