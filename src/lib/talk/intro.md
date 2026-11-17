<!-- `---` starts a new slide. Headings, lists, tables and images are the slide; plain paragraphs are speaker notes. A slide that starts with `#` gets the title-slide style. -->

# COD-AB: a common map for humanitarian response

### Administrative boundaries, the shared standard, and the tools that build them

Every humanitarian response depends on partners agreeing where places are and what they're called. This talk covers four things: what COD-ABs are and why they matter, the problems with how boundary data is produced today, how UN agencies are growing COD-AB into one shared standard, and the tools OCHA built to clean and package boundaries to that standard. The tools run in the browser with nothing to install, so the demos are live.

The notes are written to be read as is, so anyone can present this deck. Press P for presentation mode and use the arrow keys to move between slides.

---

# Part 1: COD-ABs and what they're used for

---

## COD-ABs: the common map of a humanitarian response

![Cameroon's COD-AB at three levels, 10, 58 and 360 units, with one unit highlighted at each: Centre (CMR.002), Mbam-et-Kim (CMR.002.004) and Yoko (CMR.002.004.005)](/talk/cmr-admin-levels.svg)

- Admin boundaries form a common operational picture of humanitarian activities, sourced from national authorities if possible
- P-codes: a stable code for every unit, down to the lowest level available
- Maintained by OCHA for the countries where it operates

COD-AB stands for Common Operational Dataset for Administrative Boundaries. In a crisis, everyone responding needs to agree on where the provinces and districts are and what they're called. The COD-AB is that shared reference, endorsed in-country and published openly. In Cameroon, each P-code extends its parent's: Yoko is CMR.002.004.005, inside Mbam-et-Kim (CMR.002.004), inside Centre (CMR.002).

OCHA maintains COD-ABs for 114 of 248 countries and territories, including every country with an active humanitarian response plan this year.

---

## HDX: the Humanitarian Data Exchange

<!-- wide -->

![Two bar charts. Left: the ten most downloaded datasets on HDX of all time, five of them COD-ABs (Philippines, Bangladesh, Thailand, Ethiopia and Pakistan). Right: the ten files people downloaded most from the HDX website in one month, all of them COD-ABs](/talk/hdx-downloads.svg)

- OCHA's open data platform since 2014, run by the Centre for Humanitarian Data
- 28,000 datasets from 233 organizations
- More than 500,000 users a month
- COD-ABs: less than 1% of datasets, ~10% of downloads

HDX is where organizations share data across crises. Most of its traffic is programmatic: in a month, 555,000 unique users made 1.48 million downloads. The 170 COD-AB datasets account for 1.2 million of its 13.4 million all-time downloads, and five of the ten most downloaded datasets are COD-ABs. About 35,000 users a month browse HDX as people, and when they download from the website, they download boundaries: the ten most downloaded files in a month are all COD-ABs, and eight of the ten datasets with the most notification subscribers are COD-ABs too.

All-time counts are from HDX's public API in October 2026, and monthly figures from HDX's September 2026 analytics report. The all-time top ten leaves out a repository of PDF files, which has the most downloads but is a file store, not a dataset.

---

## Tabular data on HDX joins on COD-ABs

| Category             | Examples                                                   |
| -------------------- | ---------------------------------------------------------- |
| Population           | Baseline population, displaced people, refugees, returnees |
| Situation and needs  | Needs assessments, food security, market prices, poverty   |
| Risk                 | Rainfall, vegetation, national risk                        |
| Services             | Who does what, where                                       |
| Funding              | Humanitarian funding                                       |
| Appeals, emergencies | Response plans, emergency declarations                     |
| Protection           | Protection risks and incidents                             |

These are the kinds of tabular data on HDX, and they all locate their rows by admin unit through COD-AB P-codes. HAPI, the HDX Humanitarian API, standardizes indicators from many organizations into one schema. Nine of its thirteen indicators are reported by admin unit, and they line up only because they share COD-AB P-codes. It also showed that standardizing other people's data after the fact doesn't scale.

The Humanitarian Data Model replaces it, and its draft is being agreed across agencies. Most of HAPI's data carries over into the model's domains, and the model adds new ones. Every domain locates its data through the Location domain, which holds the admin boundaries.

---

## Boundaries are how people get counted

![Map of Afghanistan by district, shaded by the share of the population in need in 2025, from under 40% to over 70%](/talk/afg-people-in-need.svg)

People in need are counted by district, against a baseline population for that district, and that's how aid gets targeted. Here it's Afghanistan in 2025: 22.9 million people in need out of 46 million.

400 of the 401 districts in the needs data join to the COD-AB on their P-code. The one that doesn't is Khulm, coded AF2110 in the needs data and AF2008 in the boundaries, so a plain join silently drops it.

---

# Part 2: Competing boundaries and slow updates

---

## Each agency keeps its own global boundaries

![World map with a dot in each of the 40 countries where OCHA has a country office, regional office or humanitarian advisory team](/talk/ocha-presence.svg)

- OCHA, WFP, UNICEF, UNHCR and IOM each maintain one, and so do FAO, the World Bank and others, often for internal enterprise systems
- Their field presence is complementary: they overlap in some countries, and in others only one agency is there

Each dot is a country where OCHA has a country office, a regional office or a humanitarian advisory team. That's where OCHA has people with local knowledge of the boundaries.

The other agencies each have their own map like this, and their own global boundary dataset built from it. Where they overlap, there are competing versions. Where they don't, one agency may hold the only good data.

---

## Sources often disagree on the geography

<!-- explorer -->

These maps come from the HDX Boundaries Explorer, which compares admin boundaries from seven sources. For six African countries, they show OCHA's COD-AB, then another source, with the units that differ from OCHA's in red.

In the Central African Republic, Mali and Ghana, the COD-AB has more admin 1 units than the other source: 20 against FAO's 7, 20 against WFP's 10 from 2023, and 16 against UNICEF's 10. Madagascar is the extreme case, 24 against the World Bank's 6. Burkina Faso's 2025 release has 17 regions with new names, where UNICEF still has the old 13. South Sudan goes the other way: the World Bank has 12 units because it counts Ruweng and Pibor as their own areas, and OCHA has 10.

---

## Even where the geography matches, the codes differ

| Source   | Code for Kabul     |
| -------- | ------------------ |
| Source A | `AF0101`           |
| Source B | `1044590`          |
| Source C | `AFG_0014_0009_V1` |
| Source D | `21AFG001001`      |

The same city, with the same boundary, carries a different code in each source. So data gets re-coded every time it moves between agencies, and joins break when a code is mapped wrong.

---

## A COD-AB gets built in round trips between field and HQ

![Two circles, Field (ground truth) and HQ (data quality), joined in a loop: candidate data goes from Field to HQ, and questions come back](/talk/field-hq-loop.svg)

- Field teams know the ground truth: which boundary is correct, how many divisions there are at each level, and what places are called
- HQ knows data quality: cleaning topology, keeping codes and versions consistent, and catching name encoding errors
- A question one side can't answer goes to the other, and each trip adds friction

Country offices and national agencies know the ground, but the cleaning and coding happen centrally. A dataset needs both, so files go back and forth until it's right.

---

# Part 3: One standard across UN agencies

---

## UN80 brought the agencies to the same table

![Geospatial workshop participants at WFP in Rome](/talk/rome.jpg)

- UN80: reform across the UN system to bring efficiency, with one evidence base for humanitarian data
- Rome, June 2026: five UN humanitarian agencies agreed one P-code standard, one update process, and a global COD-AB by the end of 2026
- Then the broader humanitarian community from 2027

UN80 is the reform effort across the UN system. Its report commits to a Humanitarian Data Collaborative so that all actors can work from one evidence base.

For boundaries, that meant getting the five agencies in a room. Over three days in Rome, they agreed the P-code specification, the governance process for updates, and the roadmap. The rollout starts with OCHA's own process, then the five agencies, then partners like FAO and the World Bank.

---

## A standard only works if it's easy to follow

![Three boxes joined by arrows: Standard (P-code format and fields), Tools (Python CLI and web app), and Check (Package checks schema, topology, codes and names)](/talk/standard-tools-check.svg)

- The tools were built alongside the standard and tested on real COD-ABs while it was still being agreed
- Field teams run the same checks as HQ, so problems are caught before data is sent, with fewer round trips
- Built for staff who don't use code: everything also runs in a web browser

A standard written only as a document tends to get read once and followed loosely. When the rules are built into the tools people already use, following the standard is simply what the tools do, and the check tells you right away if something's off.

The tools also use open, widely used formats and P-codes that follow UN Secretariat conventions, so nothing locks partners in.

---

# Part 4: The tools

---

## Cleaning in six steps

<!-- steps -->

Every boundary update goes through the same six steps: map the source schema, clean the topology, match the edges to the international boundary, carry the codes over from the last release, clean the names, and package the result.

Each demo later in the talk is one of these steps.

---

## Two tools, starting with the CLI

<!-- duckdb -->

- The Python CLI came first, because it's faster to iterate on and handles big data
- The web app was developed alongside it, porting the logic to WASM and building a UI on top

Each step is DuckDB spatial SQL, with GeoParquet between steps, so any intermediate result can be opened and checked. Because the logic lives in SQL, the same queries run in the browser.

---

## Building the CLI: tools, then docs, then skills

![Three stacked layers: Tools at the base (institutional knowledge, made deterministic), Docs on top (how to use the CLI), and an optional Skills layer on top of that (agents drive the CLI)](/talk/tools-docs-skills.svg)

- The CLI commands came first: institutional knowledge made deterministic
- Docs came next: goal-oriented Diátaxis how-to guides, one per step, chained from raw data to release
- Skills came last, so agents can follow the docs and run the CLI

The skills are optional. They open the CLI up to colleagues who are comfortable with data but aren't software developers. OCHA's Field Information Services team works this way in VS Code on Windows.

---

## Validated on every COD-AB, then ported to the browser

![A terminal running topo-tools topo-clean on admin2.parquet with the Python CLI on DuckDB, and an arrow labelled same SQL to a browser window with the same file in a drop zone, the web app on DuckDB-WASM](/talk/cli-to-browser.svg)

- OCHA converted its COD-AB catalog to a Portolan catalog to test against, then ran every dataset from raw to cleaned
- The hard algorithmic work happens in Python, then ports to JS with the UI added on top, so both stay at feature parity
- Field teams get the same tools HQ uses, in a browser with nothing to install
- Files stay on the local machine, so nothing has to be uploaded over a slow connection

Some partners don't have Python or an AI subscription, and some can't install software at all. The browser app is a static site with no server, built with Astro, Svelte and MapLibre. Most of the work went into making the UI easy to use.

The demo uses Netherlands admin boundaries. Each of the next slides embeds one tool, live, with its demo file loaded.
