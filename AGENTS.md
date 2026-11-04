# CLAUDE.md

## Verification Over Recall

- Never rely on remembered knowledge for libraries, APIs, or frameworks —
  check installed versions and docs before writing code or making claims
- If you lack verified information, acknowledge uncertainty and investigate
  first rather than speculate

## Code Reuse

When adding a feature that requires logic that already exists elsewhere in the codebase, extract it into a shared module — don't copy it. Duplication is not a "minimal change"; it creates two places to maintain identical behaviour. The rule against premature abstraction applies to inventing new layers of indirection for hypothetical future needs, not to consolidating code that is already proven and used in multiple places.

## Collaboration Style

- Be objective, not agreeable — act as a partner, not a sycophant
- Push back when you disagree, flag tradeoffs honestly, don't sugarcoat problems
- Keep explanations brief and to the point
- Accuracy over speed

## Solution Choice

- Optimise for the best long-term answer, not the smallest delta from the
  current state. "Minimal change" is expedient, not principled — don't default
  to it. If you're proposing it for scope reasons, say so explicitly.
- When two clean endpoints exist (all-A or all-B), lead with the better one.
  Don't propose hybrids that split the difference unless the hybrid is
  genuinely better than both endpoints — mixed states usually carry the
  costs of both options without the full benefits of either.
- When recommending an approach, name the endpoint you'd actually pick and
  why, before listing alternatives.

## Documentation Structure

`docs/` follows Diátaxis: `docs/reference/` (RFC-2119 MUST/SHOULD/MAY behavior
contracts, no rationale), `docs/explanation/` (current-state rationale,
squashed/rewritten as understanding evolves), `docs/how-to/` (task-oriented
guides), `docs/tutorials/` (not yet written). `docs/adr/` holds immutable,
one-decision-per-file Architecture Decision Records (Nygard format, see
`docs/adr/README.md`). `docs/proposals/` holds one-page requests for managers
and IT, written for non-developers.

## Commands

```bash
npm run dev       # Start dev server (localhost:4321)
npm run build     # Production build
npm run preview   # Preview production build
npm run check     # Astro + TypeScript type check
uv sync          # Python env for scripts/ (pyproject.toml, uv.lock, Python from .python-version; outside it: aws CLI v2 for the push, resvg and cwebp for population_maps)
npm run fetch:status  # Fetch /status CSVs (needs ARCGIS_* and JIRA_* in .env)
uv run scripts/about/pcode_figures.py  # Render /about/ Morafeno and P-code level SVGs and the /standards/ migration maps
uv run scripts/about/population_maps.py <cod_population_admin2.csv>  # Render /about/ population maps
uv run scripts/catalog/run.py [--step <name>] [--skip-build] [--push]  # Build the data catalog in catalog/ (push needs PORTOLAN_REMOTE and source.coop keys in .env)
```

## UI Verification

**Always verify UI changes in a real browser before reporting them done.** Type-checking and build success do not prove that a page renders, that an island hydrates, or that user flows work. Use `playwright-cli` (installed at `/opt/homebrew/bin/playwright-cli`) — a terminal wrapper around the Playwright MCP server, drivable from Bash.

Minimal flow:

```bash
npm run dev > /tmp/dev.log 2>&1 &      # background dev server
sleep 4 && grep -E "Local" /tmp/dev.log # find the port (may not be 4321 if busy)
playwright-cli open http://localhost:<port>/
playwright-cli snapshot                  # accessibility-tree snapshot of current page
playwright-cli eval "() => ({ ... })"    # arbitrary JS in page context
playwright-cli click <ref>               # ref comes from snapshot
playwright-cli dialog-accept             # or dialog-dismiss for window.confirm()
playwright-cli close                     # always close at the end
```

Notes:

- `playwright-cli snapshot` writes a YAML accessibility tree to `.playwright-cli/page-*.yml`. The tree includes element `ref` IDs (e.g. `ref=e9`) you pass to `click`/`hover`/`fill`. Trust `eval` output over older snapshot files — snapshots can be stale relative to the live DOM.
- `playwright-cli` uses one persistent browser per session. Use `attach`/`detach` only if you need to share a browser across processes; for our verification flows, `open` + `close` is enough.
- Do NOT write standalone `.spec.ts` files for this — drive Playwright from Bash via `playwright-cli`. (Reason: the project does not have a Playwright test runner configured, and per-test setup duplicates the dev-server lifecycle.)

## Branding

- Use OCHA branding via the `ocha-bdu` plugin (`ocha-visual-identity`, `ocha-mapping`, `ocha-editorial-style` skills; tokens from `UN-OCHA/ocha-common-design-system-BDU`). Never use HDX branding or the `hdx:styles` skill.

## Architecture

The site hosts several COD-AB portals: `/` is the home page linking to each, `/about/` is a landing page of cards routing to `/about/why/` (why CODs exist and how P-codes join them) and `/about/un80/` (where COD-AB fits in UN80 Work Package 2), MDX pages in the `about` content collection at `src/content/about/` (routes in `src/pages/about/`, figures in `src/lib/about/` rendered by `scripts/about/*.py` and UN80 diagrams in `src/lib/about/un80/`, layout `src/layouts/PageLayout.astro`, card grid `src/lib/components/DocCards.astro` shared with `/standards/`), `/standards/` is COD-AB Standards (the Specification and Process documents, imported by hand from their Google Docs drafts into the `standards` content collection at `src/content/standards/<doc>/`, one folder per document with an `index` page; routes in `src/pages/standards/`, layout `src/layouts/StandardsLayout.astro` with a dismissable draft banner, helpers and the P-code diagram in `src/lib/standards/`), `/tools/` is Tools, `/explorer/` is the Boundaries Explorer (a per-country comparison of boundary sources against the team's decisions sheet, `PUBLIC_DECISIONS_SHEET_URL`; code in `src/lib/explorer/`, reading the `explorer/` collections of the site's portolan catalog), and `/status/` is the COD status dashboard (tabs: `/status/` COD-AB and COD-PS reference years, full and partial admin levels, and per-level p-code match for each country in GIS, grouped by plan priority, from `cod_metadata.csv` and `scripts/status/cod_ps.py` (`cod_ps.csv` per country and `levels.csv` per admin level, from `cod-ps-global` and `global-pcodes`); `/status/work` JIRA work orders; `/status/review` COD-AB review schedule, work order and COD-PS age (years since reference year) by plan priority; all built from CSVs that `scripts/status/*.py` fetch into the gitignored `public/status/data/`; code in `src/lib/status/`, layout `src/layouts/StatusLayout.astro`, styles scoped under `.status-page`). Page links use `base`, `aboutBase`, `toolsBase`, `standardsBase` and `statusBase` from `src/lib/utils/paths.ts`; static assets stay at the root. The site's data lives in one portolan catalog on source.coop: `scripts/catalog/run.py` builds it into `catalog/` (metadata committed, data files gitignored; `explorer/` merges OCHA's original COD-AB layers and downloads partner boundaries and reference tables, `tools/` builds the NLD demo inputs) and pushes it with the vendored `fieldmaps_publish.py`, kept byte-identical with fieldmaps/subnational and fieldmaps/international. In hand-written code its URL lives only in `DATA_BASE` in `src/lib/utils/data.ts`; scripts derive it from `PORTOLAN_REMOTE` in `.env`. **Tools** is a browser-only suite of geospatial topology utilities. Each tool runs client-side via WebAssembly, and no data leaves the browser. `/tools/` is a landing page that lists tools, and `/tools/intro` is an introduction that can be presented as slides (slide text in `src/lib/talk/{intro,outro}.md`, demo slides embed each landing-page step's main tool that has a `tools.ts` `demo` entry, and the slide holding an `<!-- explorer -->` comment cycles a map through the views in `src/lib/talk/explorer.ts`, drawn from the catalog's combined `tools/sources/sources_adm1.pmtiles`). `/tools/docs/` is the Python & CLI user docs, rendered by Starlight from topo-tools' `docs/pages`, which `scripts/sync-py-docs.mjs` symlinks into `src/content/docs/tools/docs` (`PY_DOCS_DIR` overrides the sibling-checkout default); the OCHA theme for it lives in `src/styles/starlight-ocha.css` (over the vendored `src/styles/brand.css` and `site-tokens.css`) and `src/lib/components/starlight/`. The deploy also publishes the Claude Code plugin's `marketplace.json` and zip under `/tools/` from topo-tools' `plugins/`. Twenty-two tools ship today: **Topology Cleaner** at `/tools/topo-clean`, **Edge Extender** at `/tools/edge-extend`, **Changelog** at `/tools/change`, **Edge Matcher** at `/tools/edge-match`, **Stitch** at `/tools/edge-stitch`, **Detect** at `/tools/topo-detect`, **Clip** at `/tools/edge-clip`, **Mosaic** at `/tools/edge-mosaic`, **Package** at `/tools/package`, **Package Polygons** at `/tools/package-polygons`, **Package Points** at `/tools/package-points`, **Package Lines** at `/tools/package-lines`, **Schema Map** at `/tools/schema-map`, **Schema Join** at `/tools/schema-join`, **Schema Fill** at `/tools/schema-fill`, **Schema Detect** at `/tools/schema-detect`, **Code Create** at `/tools/code-create`, **Code Update** at `/tools/code-update`, **Code Detect** at `/tools/code-detect`, **Name Detect** at `/tools/name-detect`, **Name Clean** at `/tools/name-clean` (one shared app, py's `docs/dev/reference/5-names/` is its spec), and **Validate** at `/tools/validate` (runs schema-, topo-, code- and name-detect and summarizes them; the three detect tools and Validate share `src/lib/components/CheckApp.svelte`); see `docs/explanation/{topo-clean,edge-extend,change,edge-match,edge-stitch,topo-detect,edge-clip,edge-mosaic,package,package-polygons,package-points,package-lines,schema-map,schema-refactor,schema-join,schema-fill,code,code-create,code-update}.md` for what each does and how, and `docs/reference/{topo-clean,edge-extend,change,edge-match,edge-stitch,topo-detect,edge-clip,edge-mosaic,package,package-polygons,package-points,package-lines,schema-map,schema-refactor,schema-join,schema-fill,code-create,code-update}.md` for their behavior contracts.

**Stack:** Astro 7 (static site) + Starlight (`/tools/docs/`) + Svelte 5 (interactive islands) + DuckDB WASM (spatial SQL engine) + MapLibre GL (map rendering)

### Key design decisions

- All geospatial logic is SQL, run inside DuckDB's spatial extension, not JavaScript. See `docs/explanation/edge-extend.md` for the 5-stage Voronoi pipeline.
- DuckDB WASM runs single-threaded with no COEP/COOP — see `docs/explanation/performance.md` for the memory model this implies and why COEP stays off.
- **Tool layout convention:** each tool lives at `src/lib/tools/<slug>/` (its `App.svelte` + a `pipeline/` directory if it has one) and has a route at `src/pages/tools/<slug>.astro` (wrapped in `src/layouts/ToolLayout.astro`, which adds the site bar and sizes the app to `--app-height`). Shared infrastructure stays in `src/lib/db/` (DuckDB singleton + loader + export, plus `assignOne.ts`/`clipEngine.ts`/`clipTiling.ts` — assign-one and clip logic shared between Clip and Mosaic) and `src/lib/components/` (DropZone, InputStep, MapView, IssueMapView, MapPopup, DownloadMenu, PrivacyNote, ToolCard, CheckApp, IssueTable). Adding a tool = new folder under `tools/`, new entry in `src/lib/tools.ts`, new page, optionally an icon under `public/icons/tools/`. No infrastructure changes. Sidebar order: inputs (`<InputStep>`, folded once a result arrives in multi-input tools), settings, `<AdvancedOptions>` (always starts closed), status/errors, results, downloads, `<PrivacyNote>`. Every `<DropZone>` takes a `urlParam` (`url`, `old`/`new`, `input`/`join`, `input`/`overlay`, `crosswalk`), the query-string key for its URL input.
- Svelte 5 runes (`$state()`, `$effect()`, `untrack()`) — not legacy Svelte reactivity.
- Path alias `$lib` resolves to `src/lib/` (Vite alias in `astro.config.mjs` and the `paths` map in `tsconfig.json`).

## Reference Docs

- `docs/reference/` — behavior contracts per tool (`shared.md` for common settings/formats/gates)
- `docs/explanation/topo-clean.md` — defect detection, `ST_CoverageClean` semantics, gap-fill modes
- `docs/explanation/edge-extend.md` — Voronoi-extension algorithm, stage-by-stage detail, point-spacing derivation
- `docs/explanation/edge-match.md` — assignment algorithm, per-group extension, cross-group seams
- `docs/explanation/change.md` — overlap/classification algorithm, union-find, output schema
- `docs/explanation/edge-stitch.md` — whole-table CoverageClean seam-closing pass, gap-only issues report
- `docs/explanation/topo-detect.md` — read-only gap/overlap scan, shared with Topology Cleaner's own detection stage
- `docs/explanation/edge-clip.md` — assign-one majority vote, per-parent clip, single-winner-parent scope in this app
- `docs/explanation/edge-mosaic.md` — thin assign-one -> clip -> stitch orchestrator, no re-extension
- `docs/explanation/package.md`: thin package-polygons/points/lines orchestrator, no table-name collisions
- `docs/explanation/package-polygons.md`: per-level group-by dissolve, auto column keep/sum/drop, gap-only issues report
- `docs/explanation/package-points.md`: one representative point per level, generalizable-columns gate
- `docs/explanation/package-lines.md`: shared/exterior boundary extraction, coarsest-divergence classification
- `docs/explanation/schema-map.md`: one page over infer, in-table edit, and apply, geometry drawn once; structural admin-hierarchy inference, no name/vocabulary matching
- `docs/explanation/schema-refactor.md`: Schema Map's apply step, crosswalk-driven column rename/drop, no geometry touch
- `docs/explanation/schema-join.md`: QGIS-style join by location (largest overlap), copies join-layer hierarchy columns, conflicting values as numbered siblings
- `docs/explanation/schema-fill.md`: cascades admin-hierarchy column families down, stamps a pre-fill depth column, attribute-only
- `docs/explanation/code.md`: shared hierarchical-code primitive, cascade/rewrite/detect-format functions
- `docs/explanation/code-create.md`: chained per-level cascade cold-starting a code from root (replace, embed or copy source codes), overflow issues report
- `docs/explanation/code-update.md`: per-level dissolve/classify/reparent/assign loop, retention policy over `change`'s relationship classes
- `docs/explanation/performance.md` — WASM memory model, SPATIAL_JOIN behaviour, connection settings, pipeline phase memory profile
- `.claude/skills/at-scale-testing/` (portolan catalog layout, picking a file or old/new pair for a real-scale test)
- `docs/adr/README.md` — how to decide whether a fact belongs in an ADR vs. `docs/explanation/` vs. this file
- `docs/adr/` — immutable decision records behind the WASM-GEOS robustness workarounds referenced above

## Test Datasets

A full portolan catalog (real, large-scale admin boundary data, multiple
countries and admin levels, some with multiple historical versions) is
available for at-scale/real-data stress testing in the browser (drop a file
in via the tool's DropZone):

- **Local copy**: `/Users/computer/GitHub/OCHA-DAP/hdx-scraper-cod-ab-global/portolan`
- **Live/canonical source**: [source.coop/hdx/cod-ab](https://source.coop/hdx/cod-ab),
  STAC root catalog at `https://data.source.coop/hdx/cod-ab/catalog.json`
  (`id: portolan`; per-country `child` links, e.g. `./chl/catalog.json`)

**HARD RULE — the portolan catalog is read-only.** Never write, modify,
move, rename, or delete anything under
`/Users/computer/GitHub/OCHA-DAP/hdx-scraper-cod-ab-global/portolan` (or its
canonical source.coop source). Only ever read from it — drop copies of its
files into tool DropZones, never point a write/export/cleanup operation at
it, and never run shell commands there beyond read-only listing/inspection.

See the `at-scale-testing` skill for the STAC layout and how to pick a
file (or an old/new comparison pair, for `change`) from the catalog.
