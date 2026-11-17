---
title: Code assignment
summary: Codes are numbered in a fixed sort order within each parent, never renumbered and never reused. The source's own codes are kept alongside.
order: 2
---

## Code assignment

The procedure when P-codes are assigned to a country is as follows. Within each parent, sort all units by *adm[N]\_srcid*, then *adm[N]\_name*, then *adm[N]\_name1*, then *adm[N]\_name2*, then *adm[N]\_name3* (nulls sort last at each step; *adm[N]\_srcid* values made only of digits sort by numeric value, before all other values, which sort as text), and assign sequential integers in that order, starting at *001*, resetting per parent.

For updates this same cascade, sort by *adm[N]\_srcid*, then *adm[N]\_name*, then *adm[N]\_name1*–*name3*, governs every subsequent code assignment as well: when units are added under an existing parent, they are sorted using this cascade and assigned the next available sequential integers in that resulting order. Units that already hold a P-code are never re-sorted or renumbered. The number carries no meaning beyond “this is the Nth unit registered under this parent.” P-codes are never reused: no existing or historic code can be assigned to a new unit.

## Source codes

Previously, COD-AB P-codes were derived from national government coding systems. When a government changed its own codes, every OCHA dataset built on those codes required full re-keying, breaking all downstream joins.

P-codes are now assigned independently using a consistent format. The originating source ID (whether from a national government, WFP, or another authoritative system) is preserved in the level-specific source fields (*adm1\_srcid*, *adm2\_srcid*, etc.), enabling downstream users to join data back to whichever source system they work with. The P-code remains stable regardless of what any source system does with its own codes.

The default source is the national government's own coding system. Where a government code is not available, a third-party source (WFP, GADM, OSM, or another authoritative system) is accepted instead. *adm[N]\_srcid* is populated from whichever dataset supplies the code key for that unit at that version, government by default, third-party where no government code exists.
