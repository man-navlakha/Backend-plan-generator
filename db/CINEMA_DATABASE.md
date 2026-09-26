# Cinema (PAN India) catalog

One catalog built from two workbooks, holding every screen either of them lists —
including the incomplete rows, on purpose, so they can be found and fixed.

## Build and ownership

| | |
| --- | --- |
| Catalog slug | `cinema` in Postgres `masters.*` |
| Media type | `cinema` |
| Rebuild | `npm run db:import:cinema` (`:dry` to parse without writing) |
| Verify | `npm run db:smoke:cinema` |
| Portable copy | `npm run db:export:cinema` → `src/data/cinema-catalog.db` |
| Importer | `scripts/import-cinema-master.js` |
| Workbook reader | `scripts/lib/read-cinema-sheet-workbook.js` |
| Exporter | `scripts/export-cinema-db.js` |
| Format index entry | `Cinema` |

### Sources

| Key | Workbook | Sheets | Screens | Character |
| --- | --- | ---: | ---: | --- |
| `pan_india_2025` | `Cinema PAN India 07-04-2025 old.xlsx` | 26 | 10,118 | Fields almost complete. The only source of UFO (3,993) and Khushi (5). Older, lower rates. |
| `from_csvs_2026` | `Cinema_PAN_India_From_CSVs.xlsx` | 33 | 10,547 | Generated from the current master CSVs. Newer rates, 8 more states. Sparse: 97% no locality, 45% no pincode, 48% no audi type, 30% no seats. |

Both live in `src/assets/Masters/Cinema/`. They are the source of truth; the catalog is
generated and the importer is re-runnable, rebuilding only `cinema` inside one
transaction and touching no other catalog and nothing in `app.*`.

Product ids are deterministic per source (`80,000,000 +` row for `pan_india_2025`,
`81,000,000 +` row for `from_csvs_2026`), so a re-import leaves a stored plan pointing
at the row it was priced from.

This catalog does not come from a SQLite file, so `npm run db:migrate` does not rebuild
it. That script used to run `TRUNCATE masters.catalogs CASCADE`, which would have
deleted this catalog silently on every full rebuild; it now deletes only the eight
catalogs it owns.

Last verified import: 26 September 2026.

## Reading the second workbook

`Cinema_PAN_India_From_CSVs.xlsx` is valid SpreadsheetML that ExcelJS refuses
to open — it namespaces the whole document with an `x:` prefix and uses opaque
relationship ids (`Rd0f3db0cab284be4` rather than `rId1`), and ExcelJS fails with
"Cannot read properties of undefined (reading 'sheets')".

`scripts/lib/read-cinema-sheet-workbook.js` therefore tries ExcelJS and, when it
throws, reads the sheet XML out of the zip directly. Both paths return the same shape.
The direct path is only safe because these workbooks are as simple as spreadsheets get
— no shared string table, no formulas in the data rows, every value inline — and it
should not grow into a general xlsx reader.

The header row is found by its `Sr. No.` marker rather than assumed: row 14 on most
sheets, row 15 on Arunachal Pradesh, row 31 on Uttar Pradesh. A data row is one whose
`Sr. No.` is a positive integer that also names a screen or a theatre, which removes
the six footer rows without needing to know where the data stops.

## Nothing is dropped

Every row of both workbooks is in the catalog — 20,665 of them — whether or not it is
complete. A blank field does not disqualify a row; it produces a finding.

```text
masters.products             20,665   one per workbook row
  quotable (status = 1)      16,268
  superseded (status = 0)     4,397   kept, not quotable — see below
masters.price_options        20,665   one per product
masters.data_quality_issues  28,421   the worklist
```

That register is the point. `masters.data_quality_issues` says which field is blank on
which screen in which workbook at which row, so the desk can list the gaps, fill them
in the workbook, and re-import. What was fixed disappears from the register.

```sql
-- what to go and fill, worst first
select field, count(*) as screens
  from masters.data_quality_issues
 where catalog = 'cinema' and code like 'MISSING_%'
 group by 1 order by 2 desc;
```

| Field | Screens missing it |
| --- | ---: |
| Locality | 6,107 |
| Audi Type | 5,068 |
| Pincode | 3,286 |
| Seating Capacity | 3,135 |
| Capacity Preference | 3,129 |
| Theatre Type | 195 |
| Rate | 1 |

Only the last one stops a screen being quotable. The rest are cosmetic gaps in the
client sheet, and 16,267 of 16,268 quotable screens carry a usable rate.

## How the two workbooks are joined

Where the same screen is in both, the rows are **linked, not merged**. 4,397 links were
made, on screen code, and only where the code occurs exactly once in each workbook —
codes get reused, and a reused code is not evidence of the same screen, so 1,675
ambiguous rows are left unlinked and flagged instead of guessed at.

A link must also stay inside one state. Every link today already does: checked 4,397 of
4,397 same-state, with 4,203 also agreeing closely on the theatre name and the
remainder being plain naming variants (`Ab Lounge` / `Ab Lounge (Satellite Road)`,
`NY Cinemas` / `NY Cinemas Bhuj`). The guard exists so a future workbook cannot quietly
marry two unrelated screens that happen to share an aggregator code.

### Blanks are filled across the link

5,617 blank fields were filled from the other workbook. **Only blanks** — a stated
value is never overwritten — and every fill is recorded in `attrs.filled_from` as
`field → workbook`, so it is always visible where a value came from. This is what
brings the sparse 2026 rows up to something printable: it recovered 4,119 localities
alone, and filled the rate on two screens that had none.

### One screen, one quotable row

The newer row stays quotable. The older one is kept but set `status = 0`, which every
search already filters on (`searchProducts` enforces `p.status = 1`), so a plan cannot
quote the same audi twice at two prices. It stays fully visible for comparison and can
be promoted by changing one column.

This is why UFO shows 3,375 quotable screens rather than 3,993: 618 UFO screens also
appear in the 2026 workbook, so they are quoted from the newer row. **No UFO inventory
was lost** — those screens are still bookable, at their newer rate, and now under
whichever network delivers them today.

### Rates disagree, and that is recorded rather than resolved

4,376 of the 4,397 linked screens disagree on the rate, often by a factor of four
(the 2026 card's median printed rate is 12,000 against the 2025 card's 3,000). The
newer figure is the one quoted; the other is kept in
`attrs.other_source_rate_10s_week` and raises a `RATE_DISAGREES_ACROSS_SOURCES`
finding. Nothing is averaged and nothing is silently picked.

### Chains change hands

635 linked screens have a different `Cinema Chain` in each workbook — `UFO` in 2025,
`Qube` or `KSS` in 2026, for the same theatre at the same address. The chain here is
the **ad-delivery network**, not the exhibitor brand, and several theatres moved
between the two cards. This is recorded as `CHAIN_CHANGED_ACROSS_SOURCES` because a
desk comparing the cards will want to know, but it is not a fault and does not block a
link.

## Rates: the one thing that must not be got wrong

Both workbooks' rate column is headed **"Rates for 10 Sec :A/V Slide (1 Week)"** — a
price for ten seconds, for one week.

The costing engine multiplies `rate x seconds x weeks`: for cinema,
`engine/build.js billingQuantity` sets the quantity to the creative length in seconds
(10 by default) and `billingPeriods` sets the multiplier to weeks. The live `cinema`
master stores its rate **per second per week** to suit that. So both cards are stored
divided by ten:

```text
offer_rate            = printed column / 10     per second per week
pricing_unit          = 'per week per second'
attrs.rate_10s_week   = the printed column, untouched
```

Storing the column as printed would overcharge every plan by 10x and nothing
downstream would complain. The smoke test re-derives the division on both workbooks.

The round trip is exact:

```text
offer_rate 600  x  10 seconds  x  4 weeks   = net 24,000
renderer cinema_weekly_rate = net / weeks   = 6,000   <- the printed figure
```

### One honest wart in the 2026 workbook

Its column is headed "A/V Slide", but its rates are the master's **Ad Film** offer
rate × 10, not the Slide rate. Verified against `src/assets/Masters/Cinema/price
option.csv`: of 816 rows matched by theatre name, 99.5% equal an Ad Film offer rate
× 10 and only 73.9% equal a Slide rate — and that 73.9% is the subset where the master
prices Ad Film and Slide identically. Worked example, `City Gold: Ashram Road`, which
prices them differently: the CSV has Ad Film 2,733 and Slide 2,267 per second per
week, and the workbook prints 27,330.

Ad Film costs more than a slide, so this matters. Those rows are stored with
`template = 'Ad Film (labelled A/V Slide in source)'` rather than pretending
otherwise. The 2025 card's rows keep `template = '10 Sec A/V Slide'`.

`minimum_billing` is null on both — neither card states one, and the live master's flat
10,000 would inflate small plans. `buying_rate` is null because both cards carry one
rate column and it is a sell rate, so a plan off this catalog correctly raises
`line.margin_unknown`.

## One Cinema identity

These two cards are the only planning inventory for Cinema. The catalog slug, family,
media type, format-index slug, and service name all resolve to `cinema`. The older sparse
SQLite importer is retained only for the legacy `/api/cinema` browser and is excluded
from `db:migrate`, so it cannot overwrite this Railway catalog.

## Grain: one product per audi

One workbook row is one audi, and the client sheet prints one row per audi, so the
quotable unit and the printed line are the same thing. Each product carries exactly one
price option.

Grouping audis under a venue product was rejected because `searchProducts` attaches at
most six price options per product and these cards have venues with up to 26 screens,
so inventory would be silently hidden. Venue rollups are available instead through
`attrs.venue_key` (`state|city|multiplex|pincode`, normalised) — 12,799 venues.

### Product attributes

`attrs` keys are the ones `render/resolvers.js` looks for first, because
`engine/cost.js lineCatalogFields` spreads product attrs straight onto the plan line.
All 17 columns of the Cinema client template are therefore filled from the catalog
rather than inferred from a SKU:

`screen_code`, `multiplex_name`, `address`, `pincode`, `theatre_type`, `tier`,
`capacity_preference`, `total_screen`, `audi_no`, `audi_type`, `cinema_chain`,
`seating_capacity`

Plus provenance: `rate_10s_week`, `activity_seconds`, `source_file`, `source_sheet`,
`venue_key`, `filled_from`, `superseded`, `linked_screen_code`,
`other_source_rate_10s_week`.

## Coverage

34 states and union territories (up from 27 on the 2025 card alone), all six zones.

Quotable screens by chain:

| Chain | Screens | |
| --- | ---: | --- |
| Qube | 8,212 | |
| UFO | 3,375 | only source is the 2025 card |
| PVR-INOX | 2,535 | |
| Cinepolis | 1,071 | |
| KSS | 652 | |
| Miraj | 354 | |
| NY | 64 | |
| Khushi | 5 | only source is the 2025 card |

States the 2026 workbook added: Jammu and Kashmir, Meghalaya, Tripura, Manipur,
Andaman and Nicobar Islands, Nagaland, Daman and Diu, Ladakh.

Zones are not in either workbook and are applied from a state-to-zone map. State
spellings are normalised the same way (`Tamilnadu` → `Tamil Nadu`, `J&K` →
`Jammu and Kashmir`, `MP` → `Madhya Pradesh`, `Andaman & Nicobar` → `Andaman and
Nicobar Islands`), as are chain names (`PVR-Inox`/`PVR-INOX`, `Kss`/`KSS`).

City values are exact strings and are **not** deduplicated, exactly as in the live
master: `Bangalore` and `Bengaluru` remain separate values.

## Findings register

28,421 findings in `masters.data_quality_issues` under catalog `cinema`.

| Severity | Code | Count | Meaning |
| --- | --- | ---: | --- |
| warning | MISSING_LOCALITY | 6,107 | Locality blank |
| warning | MISSING_AUDI_TYPE | 5,068 | Audi Type blank |
| warning | RATE_DISAGREES_ACROSS_SOURCES | 4,376 | The two cards quote different rates for this screen |
| warning | MISSING_PINCODE | 3,286 | Pincode blank |
| warning | MISSING_SEATS | 3,135 | Seating Capacity blank |
| warning | MISSING_CAPACITY_PREF | 3,129 | Capacity Preference blank |
| warning | AMBIGUOUS_SCREEN_CODE | 1,675 | Code is in both workbooks but not unique in one, so the rows could not be linked and may duplicate a screen |
| warning | DUPLICATE_SCREEN_CODE | 807 | Code repeats another row in the same workbook |
| warning | CHAIN_CHANGED_ACROSS_SOURCES | 635 | Delivery network changed between the cards — not a fault |
| warning | MISSING_THEATRE_TYPE | 195 | Theatre Type blank |
| warning | INVALID_CAPACITY_PREFERENCE | 4 | Not in S1-S16 form |
| warning | INVALID_TIER | 2 | Tier holds a capacity code; the two columns look transposed |
| error | MISSING_RATE | 1 | No rate in either card, so this screen cannot be quoted |
| warning | INVALID_PINCODE | 1 | Present but not six digits |

`AMBIGUOUS_SCREEN_CODE` is the one worth working through: those 1,675 rows may double a
screen, because they could not be linked and both copies stay quotable.

Known and deliberately left alone: `Theatre Type` and `Audi Type` carry case variants
(`7 Star` / `7 STAR`, `Normal` / `NORMAL`). These are display-only, never filters, and
both source workbooks print them the same mixed way on their own client-facing rows, so
the source wording is preserved rather than rewritten.

## The portable database file

`npm run db:export:cinema` writes `src/data/cinema-catalog.db` — about 15 MiB,
opens in any SQLite browser, and holds the whole combined card in the shape the client
sheet uses. Pass `--out=path` to write it elsewhere.

| Table | What is in it |
| --- | --- |
| `screens` | All 20,665 rows. The 17 client-sheet columns first, in template order, then provenance. Blanks stay blank. |
| `findings` | The worklist, per screen, per field. |
| `sources` | The two workbooks and what each contributed. |
| `import_metadata` | When it was built, from what, and the rate note. |

| View | What it gives |
| --- | --- |
| `plan_sheet` | Exactly the 17 columns, template order, quotable screens only — export straight back to the client format. |
| `quotable_screens` | One row per real screen; the superseded duplicates are excluded. |
| `missing_fields` | Field → how many screens are missing it, worst first. |

Every row also carries `blank_field_count`, so the most incomplete rows sort to the top:

```sql
select screen_code, city, multiplex_name, blank_field_count
  from quotable_screens order by blank_field_count desc limit 20;
```

`rate_10s_1week` is the figure the client sheet prints. `rate_per_second_week` is that
divided by ten, which is what the costing engine multiplies.

## The fix-it loop

This is the workflow the catalog is built for:

1. `select * from missing_fields` (or the Postgres query above) to see what is missing.
2. Fill it in the workbook under `src/assets/Masters/Cinema/`.
3. `npm run db:import:cinema` — rebuilds the catalog; fixed rows drop out of the
   register.
4. `npm run db:smoke:cinema` — confirms nothing else moved.
5. `npm run db:export:cinema` — refreshes the portable file.

Adding a third workbook is a matter of appending to `SOURCES` in the importer: give it a
key, an id offset and a precedence, and the linking, gap filling and superseding all
apply to it.

## Verification performed

- `npm run db:smoke:cinema` passes: row counts per workbook reconcile with what
  was read out of each file, no orphan options, the single Cinema identity is
  asserted, no linked screen quotable twice, superseded rows proven absent from search
  results, rate basis re-derived on both workbooks, all 17 client-sheet columns resolved.
- The 2026 rate basis verified against the source CSVs: 99.5% Ad Film offer rate × 10.
- Link quality checked: 4,397 of 4,397 same-state, 4,203 with strong name agreement,
  none with no agreement at all.
- Exported SQLite `integrity_check`: ok.
- Project tests: 25 passed, 0 failed.
- A deterministic brief for `Cinema` in Lucknow and Bengaluru builds and renders
  a workbook end to end.

A deterministic (no-model) cinema brief selects a single line and so raises
`budget.underspent`. This is pre-existing behaviour of the deterministic selector for
cinema, not a property of this catalog — the live `Cinema` master returns one line and
the same flag for an identical brief.

## Using it

```js
const { buildPlan } = require('./src/engine/build');

const out = await buildPlan({
  deal_id: '12345',
  company: 'Example',
  service: 'Cinema',
  budget: 800000,
  duration_weeks: 4,
  target_locations: ['Lucknow', 'Bengaluru']
});
```

```js
const { searchProducts } = require('./src/catalog/search');
await searchProducts({ mediaType: 'cinema', city: 'Mumbai', limit: 40 });
```

```sql
-- UFO inventory, which only the 2025 card carries
select p.city, p.name, (p.attrs->>'rate_10s_week')::numeric as weekly_10s
  from masters.products p
 where p.catalog = 'cinema'
   and p.status = 1
   and p.attrs->>'cinema_chain' = 'UFO'
   and lower(p.city) = 'lucknow';

-- where the two cards disagree on price
select p.attrs->>'screen_code' as screen, p.city,
       (p.attrs->>'rate_10s_week')::numeric        as quoting,
       (p.attrs->>'other_source_rate_10s_week')::numeric as other_card
  from masters.products p
 where p.catalog = 'cinema' and p.status = 1
   and p.attrs->>'other_source_rate_10s_week' is not null
 order by 3 desc;
```
