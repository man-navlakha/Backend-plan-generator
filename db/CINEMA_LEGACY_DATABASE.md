# Cinema master database

## Build and ownership

- Source workbook: `src/assets/Masters/Cinema/cinema.xlsx`
- Generated SQLite database: `src/data/cinema.db`
- Current generated size: 24,092,672 bytes (about 23 MiB)
- Rebuild command: `npm run db:import:cinema`
- Importer: `scripts/import-cinema-master.js`
- Schema/runtime connection: `src/cinema-db.js`
- API: `src/routes/cinema.js`
- Browser desk: `/cinema/`

The workbook is the source of truth. The SQLite file is generated, is ignored by
Git, and is rebuilt during the Vercel build. Corrections should be made in the
workbook and then re-imported.

The Cinema projection in `src/data/other-masters.db` is also populated from this
typed database for the shared `/api/masters/cinema` view. Its verified Cinema
counts and findings match the dedicated database.

Last verified import: 25 September 2026. The exact UTC import timestamp is stored
in `import_metadata` and changes on every rebuild. SQLite integrity and
foreign-key checks passed.

## Workbook inventory

The workbook has four visible sheets. Data begins on row 5; rows 1-4 contain
groups, field names, instructions, and required-field markers.

| Sheet | Data rows | Columns | Purpose |
| --- | ---: | ---: | --- |
| Product | 6,238 | 19 | One cinema venue per row |
| Location | 6,238 | 9 | One normalized location per cinema |
| Price Option | 21,094 | 18 | Ad Film and Slide rates per screen |
| Price Unit | 42,178 | 11 | Seconds and weeks constraints per price option |

The workbook does not contain the optional `Offer Rate Source` or `Qube Rate
Card` sheets. Their database tables therefore contain zero rows.

### Source fields

**Product:** Delete, Product Name, Sku, Short Description, Meta Title, Meta
Description, Meta Keywords, Image, Sort Order, Status, Cinema Chain, Screen
Recomend, Audience Class, Tier Preference, Seats, Screen, Rank, Total Screen,
Google Map Location.

**Location:** Delete, Product Name, Product Sku, Type, Zone, State, City,
Locality, PIN Code.

**Price Option:** Delete, Product Name, Product Sku, Price Option Name, Price
Option Sku, Pricing Template Name, Minimum Billing, Offer Rate, Specific Buying
Rate, Discounted Rate, Pricing Unit, GST, On Request, Description, Media
Gallery, Image, Sort Order, Status.

**Price Unit:** Delete, Product Name, Product Sku, Price Option Name, Price
Option Sku, Unit Name, Code, Step, Minimum, Maximum, Sort Order.

## Database model

```text
products (6,238)
  |-- locations (6,238)             one location per product
  `-- price_options (21,094)        2-32 options per product
        |-- price_units (42,178)    normally two units per option
        `-- offer_rate_sources (0)  optional source sheet

qube_rate_card (0)                  optional standalone lookup
data_quality_issues (3,164)         workbook repair register
import_metadata (3)                 source path, import time, row counts
```

All 6,238 product SKUs and all 21,094 price-option SKUs are unique. There are no
orphan locations, price options, or units. Every product has exactly one
location and at least two price options.

The schema creates indexes for product SKU and chain, location product and
city, price-option product and SKU, unit/source foreign keys, rate-card section,
and issue product/code.

## Master coverage

### Cinema chains

| Chain | Venues |
| --- | ---: |
| Qube | 5,109 |
| Pvr-inox | 478 |
| Kss | 394 |
| Cinepolis | 144 |
| Miraj | 100 |
| Ny | 13 |

### Geography

- 6 zones, 34 states/union territories, and 2,182 distinct city strings.
- Zone totals: South 3,249; North 948; West 929; East 643; Central 308;
  North East 161.
- Largest state inventories: Andhra Pradesh 1,010; Tamil Nadu 815;
  Maharashtra 526; Karnataka 475; Telangana 465; Kerala 464; Gujarat 391;
  Uttar Pradesh 314; West Bengal 314.
- Largest city inventories: Chennai 142; Hyderabad 139; Mumbai 86; Bengaluru
  75; Bangalore 72; Kolkata 69; Ahmedabad 66; Surat 50; New Delhi 47; Pune 44.

City values are currently treated as exact strings. For example, `Bangalore`
and `Bengaluru`, and `Delhi` and `New Delhi`, remain separate values. `Mall`
also appears as a city on 37 records and should be reviewed.

### Classification

| Dimension | Values |
| --- | --- |
| Tier | Tier 3: 3,426; Tier 2: 1,768; Tier 1: 741; Tier 4: 303 |
| Audience class | Silver: 3,347; Gold: 2,352; Platinum: 328; Icon: 63; blank: 148 |
| Product status | 6,238 active; 0 inactive |
| Price status | 21,094 active; 0 inactive |

Seats range from 0 to 3,010 (average 519.19). Total screens range from 1 to 16
(average 1.69). Recommended screens range from 1 to 16.

## Pricing

- 10,547 Ad Film options and 10,547 Slide options.
- Every price option uses `per week per second` and GST 18.
- Every minimum billing value is 10,000.
- Offer rates: 50-15,000; average 1,270.62.
- Buying rates: 40-12,000; average 1,016.50.
- Discounted rates: 47.50-14,250; average 1,207.09.
- No missing or non-positive offer rates, buying rates, discounted rates, or
  minimum billing values.
- No option is marked On Request.
- Normal options have two quantity rules: `#Second(s)` (`SECOND`, step 5,
  minimum 10, maximum 156) and `#Week(S)` (`WEEK`, step 1, minimum 1,
  maximum 90).

## Data-quality findings

The import created 3,164 findings affecting 3,159 products:

| Severity | Code | Findings | Meaning |
| --- | --- | ---: | --- |
| Error | MISSING_PRICE_UNITS | 5 | Five options have no seconds/weeks rules |
| Warning | MISSING_PINCODE | 3,158 | 50.62% of locations have no valid six-digit PIN |
| Warning | INVALID_SEATS | 1 | One venue has zero seats |

The five price-option errors are:

1. Product `CINEMA000411`, Cinepolis BSR Sentosa Avenue, Chennai: workbook
   Price Option rows 3905 and 3906 (`SCREEN-8ADFILM`, `SCREEN-8SLIDE`).
2. Product `CINEMA000422`, Fun - Rushil Cinema (Dehgam), Gujarat: rows 4003
   and 4004 (`SCREEN-1ADFILM`, `SCREEN-1SLIDE`).
3. Product `CINEMA003532`, Aruna Theatre Arumbavur-1, Tamil Nadu: row 5297
   (`SCREEN-1ADFILM`).

The seat warning is Product row 1984, `CINEMA001980`, Qube Janagar Theatre,
Jayankondam, with Seats = 0.

Additional completeness observations not currently emitted as audit findings:

- 6,171 locations (98.93%) have a blank locality.
- 2,626 products (42.10%) have no Google Maps location.
- 148 products have no audience class.

## API surface

| Endpoint | Purpose |
| --- | --- |
| `GET /api/cinema/stats` | Totals, chain counts, import time |
| `GET /api/cinema/filters` | Chains, tiers, cities, zones |
| `GET /api/cinema/products` | Search/filter/sort venue list |
| `GET /api/cinema/products/:id` | Venue, location, rates, units, and findings |
| `GET /api/cinema/problems/summary` | Findings grouped by rule |
| `GET /api/cinema/problems.csv` | Repair-ready workbook issue export |

## Verification performed

- SQLite `integrity_check`: OK.
- SQLite `foreign_key_check`: no violations.
- Project tests: 16 passed, 0 failed.
- Dedicated-master smoke tests: passed.
- All-master directory/API smoke tests: passed.

The full shared-catalog rebuild currently stops after Cinema/Digital/Magazine
because the separately referenced Newspaper workbook is absent. This does not
affect either Cinema database; the shared Cinema transaction completed and was
verified before that later catalog was reached.
