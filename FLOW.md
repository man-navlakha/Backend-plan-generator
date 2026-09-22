# Plan Generator — How It Works

A brief goes in, a priced media plan comes out as an Excel workbook with a download URL.

```
POST /plans  ──▶  prefetch  ──▶  select  ──▶  cost  ──▶  rules  ──▶  render  ──▶  upload  ──▶  URL
                  (SQL)         (GPT-5)     (pure JS)   (JSON)     (ExcelJS)   (Appwrite)
```

Everything except **select** is deterministic. That is the central design decision and the rest of
this document mostly explains its consequences.

---

## The one rule that matters

**The model never produces a number that reaches a client.**

It returns four fields per line — `product_id`, `price_option_id`, `qty`, `months`. Nothing else.
Every rupee figure is computed in [src/engine/cost.js](src/engine/cost.js) from a rate that was read
out of the master catalog.

This is enforced in code, not in the prompt:

| Guard | Where | What it stops |
|---|---|---|
| The JSON schema has no rate field | [src/engine/model.js](src/engine/model.js) | The model cannot return a price even if it tries |
| Every id is re-read from the catalog before costing | [src/engine/build.js](src/engine/build.js) | An invented `price_option_id` becomes a flag, not a line |
| Option must belong to the product it claims | [src/engine/select.js](src/engine/select.js) | A real rate charged against the wrong inventory |

If the model fails or returns nothing usable, a deterministic selector runs instead and the response
says which one ran, in `strategy`. A plan that claims to be model-built and is not would be worse
than either.

---

## The six stages

### 1. Prefetch — narrowing 47,576 rows to about 40

[src/catalog/prefetch.js](src/catalog/prefetch.js)

The catalog cannot go in a prompt. Auto alone has 1,453 price options. So SQL narrows first: by the
media the brief named, by the cities it named, and by a rate ceiling derived from the budget.

A brief naming a **family** ("Transit") expands to its ten media. A brief naming one medium ("Bus")
stays as one.

What comes back is three things, and the last two matter as much as the first:

```js
{
  candidates,  // products with their full price options attached
  coverage,    // which media x city combinations found nothing
  notes        // what the brief asked for that the catalog cannot answer
}
```

A model shown only what exists will quietly plan around a missing city. A model told *"Bus has no
inventory in Kanpur"* can say so in the plan.

**Measured shortlist sizes:** 321 tokens (one BTL medium, one city) to 8,900 tokens (Delhi cinema).

**Deliberate behaviour worth knowing:** if the brief names cities and *none* of them carry the
medium, prefetch returns **zero candidates** — it does not fall back to national inventory. That
fallback is how a Gangtok brief ends up quoting Kolkata buses.

### 2. Select — the model's only job

[src/engine/model.js](src/engine/model.js) · [src/engine/select.js](src/engine/select.js)

`gpt-5-mini` receives the brief, the shortlist and the catalog notes, and returns selections under a
strict JSON schema.

When the shortlist is not enough it calls tools — the same catalog functions the rest of the codebase
uses:

| Tool | Use |
|---|---|
| `search_products` | Another city, another medium, a different price tier |
| `get_price_options` | Every option on one product, including ones the search trimmed |
| `cities_for_media` | Where a medium actually exists, when the brief's city has none |

Capped at 6 rounds (`PLAN_MAX_TOOL_ROUNDS`). On the last round the tools are withdrawn so the model
must answer.

### 3. Cost — money

[src/engine/cost.js](src/engine/cost.js)

No network, no model, no database. Price option in, cost out. It handles:

- **Rate choice.** Offer, discounted or buying. A discounted rate *below* the buying rate is a loss,
  not a discount, and is refused — the Lucknow auto line is exactly that case (630 offered against a
  650 buying rate).
- **Quantity floors.** "200 autos or nothing." The line is lifted and the lift is recorded.
- **Minimum billing.** A floor on the line, not on the unit rate. When it bites, the sheet shows a
  rate that still multiplies out to the total, so a client sheet never fails to add up.
- **Add-ons.** Printing, mounting, union charges — a lump per line. Where the master holds nothing,
  that becomes a flag rather than an assumed zero.
- **GST.** From the master, defaulting to 18%.

> **A bug worth remembering.** `Number(null)` is `0` in JavaScript, not `NaN`. An early version of
> the `num()` helper therefore turned every missing value into zero: a null buying rate silently
> passed every margin check, and a null GST billed the line at **0% tax**. The distinction between
> *absent* and *zero* has to survive all the way to the flags.

### 4. Rules — judging the result

[src/rules/](src/rules/) · [src/assets/rules/](src/assets/rules/)

JSON rule files, merged along an `extends` chain (`transit_bus` → `transit` → `global`). They run on
**costed** lines — running them earlier would be judging numbers that do not exist yet.

Identical flags are collapsed: one rule firing on five lines is one problem, shown as
`"... (affects 5 lines)"`.

### 5. Render — the workbook

[src/render/index.js](src/render/index.js) · [src/assets/formats/](src/assets/formats/)

Column layouts come from each medium's `format.json`. Three sheets per medium:

| Sheet | Contents |
|---|---|
| `<Medium>` | The rate card the client reads |
| `T&C - <Medium>` | Terms |
| `Notes (Internal)` | Flags, the model's reasoning, what the desk must check |

The plan object the renderer consumes is the same shape
[scripts/render-demo-plan.js](scripts/render-demo-plan.js) builds by hand. That fixture was written
before the engine existed so the renderer would not have to change when the engine arrived — and it
did not.

### 6. Upload — and why the URL is ours

[src/storage/appwrite.js](src/storage/appwrite.js)

The workbook goes to Appwrite Storage. But the URL handed back is **this API's**, not Appwrite's.

Appwrite's `/download` URL returns **401** — the bucket grants read to nobody, which is correct for
client quotations. So `GET /plans/:id/download` streams the file using the server key. The bucket
stays private and the workbook never becomes readable to whoever guesses a file id.

---

## Endpoints

### `POST /plans` — the whole flow

```bash
curl -X POST http://localhost:3000/plans \
  -H "Content-Type: application/json" \
  -d '{
    "deal_id": "DEAL-1042",
    "company": "Awadh Foods Pvt. Ltd.",
    "service": "Transit",
    "budget": 1500000,
    "campaign_objective": "Branding and awareness",
    "target_locations": ["Lucknow"]
  }'
```

```json
{
  "status": "ready",
  "plan_id": 2,
  "strategy": "model",
  "download_url": "http://localhost:3000/plans/2/download",
  "totals": { "net": 1176000, "gst": 211680, "total": 1387680 },
  "budget": 1500000,
  "legs": [{ "media": "Bus", "duration": "2 Months", "lines": 1, "net": 1176000 }],
  "flags": [
    { "severity": "warn", "id": "line.margin_unknown",
      "message": "No buying rate in the master for \"Bus Branding\"; margin cannot be checked." }
  ],
  "desk_actions": [],
  "trace": [{ "step": "prefetch", "ms": 4199 }, { "step": "select", "strategy": "model" }]
}
```

`service` accepts a medium (`Bus`) or a family (`Transit`). Query-string form works too, for curl.
Add `?strategy=deterministic` to skip the model.

**Status values**

| Status | HTTP | Meaning |
|---|---|---|
| `ready` | 201 | Plan built, no blocking problems |
| `blocked` | 201 / 200 | Plan built but something must be fixed before it goes out — over budget, a rate below the buying rate, an unpriceable line. **The workbook is still generated.** |
| `coming_soon` | 200 | Real medium, no rate card in the catalog yet |
| `error` | 400 | Bad or missing input |

`blocked` still returns a file on purpose. The desk would rather have a priced plan that names its
problems than no plan at all.

### `GET /plans/:id/download`

The workbook. `Content-Type` is the xlsx MIME type, `Content-Disposition` carries the filename.

### `GET /plans/:id` · `GET /plans?limit=20`

One stored plan (full JSON, flags, file details) or the recent list.

### `GET /brief` — parse and validate without building

```bash
curl "http://localhost:3000/brief?deal_id=D1&company=Acme&service=Bus&budget=800000&locations=Mumbai"
```

Returns `coming_soon` for a medium with no rates, with the reason and a list of what *is* live.

### `GET /brief/media-types`

Every medium with `available` / `coming_soon` and, for the missing ones, why.

---

## What is in the catalog

**20,285 products · 47,576 price options · 8 catalogs · 55 media types**

| Catalog | Products | With a city |
|---|---|---|
| btl | 7,256 | 6,703 |
| cinema | 6,238 | 6,238 |
| transit | 2,011 | 1,249 |
| magazine | 1,764 | 31 |
| radio | 964 | 962 |
| digital_pr | 837 | 0 |
| digital | 655 | 6 |
| tv | 560 | 8 |

Two Postgres tables, not nine. Units, attributes, add-ons and variants are folded into JSONB on
`masters.price_options`, because **a price option is only useful whole** — ₹15,000 means nothing
without "per bus", "All 3 Sides", "minimum billing 1,50,000". One fetch, one complete object.

### Location

Transit and BTL have no city columns at all; the city is only inside the product name. Three reads,
strongest first ([scripts/migrate-to-postgres.js](scripts/migrate-to-postgres.js)):

1. A trailing **state** anchors the segment before it as the city —
   `"ATM Branding, Mainaguri, West Bengal"`. This is the only read that works for the 4,800 BTL towns
   too small to appear in any other master.
2. The rightmost segment a city dictionary recognises — `"Auto Branding - Lucknow"`.
3. A known city at the end of an unpunctuated name.

Nothing else is accepted, so `"Ahimsa Express"` stays location-less rather than becoming a city.
75% overall; `location_source` on every row says which read was used.

### Two vocabularies

`format_index.json` and the database disagree on some slugs, and the gap is silent and expensive.
[src/catalog/media-map.js](src/catalog/media-map.js) bridges them:

| Brief says | Database has |
|---|---|
| `television` | `tv` |
| `balloon` | `sky_balloon_branding`, `hot_air_balloon_branding` |
| `leaflet_d2d` | `door_to_door_leaflet_distribution` |

Only aliases verified against real inventory are in that file. A medium the catalog genuinely lacks
stays unmapped and is reported honestly — mapping it to something approximate would quote the wrong
inventory, which is worse than saying "not yet".

---

## Known gaps

**Cinema plans are unreliable.** Cinema sells *per week per second*, so `qty` is seconds and `months`
is weeks. The model is inconsistent about this — two runs of the same brief gave 93% and 24% budget
use. The underspend flag catches it, so nothing wrong ships silently, but the prompt needs
per-unit-pricing guidance before cinema is trusted.

**12 media have no rate card.** Outdoor (no master imported), Newspaper (products but no rates),
Dealer Board, Wall Painting, and the per-platform digital media. `GET /brief/media-types` lists them
with reasons.

**`POST /plans` is synchronous**, 38–96 seconds measured. Fine for curl and a desk tool; it needs to
become a 202 with a job id before it can run under a short serverless timeout.

**`app.tool_calls` is not written yet.** The table exists and `selectWithModel` returns the calls,
but nothing persists them. Worth wiring — when a plan quotes the wrong SKU, the only way to find out
why is to see what the model searched for and what came back.

**The `/api/*` browse routes still read SQLite.** They are legacy and independent of the plan
generator, which is Postgres-only. A host without the SQLite files serves plans correctly and reports
those catalogs as `not_built`.

---

## Commands

```bash
npm run db:setup        # create the schema (once)
npm run db:migrate      # load SQLite masters into Postgres
npm run db:smoke:pg     # 13 checks on the loaded data
npm run catalog:try     # search + prefetch against seven sample briefs
npm run dev             # server with --watch
```

## Environment

```
DB_URL                      postgresql://...        Postgres
OPENAI_API_KEY              sk-...                  selection
OPENAI_MODEL                gpt-5-mini              optional
PLAN_MAX_TOOL_ROUNDS        6                       optional
APPWRITE_ENDPOINT           https://<region>.cloud.appwrite.io/v1
APPWRITE_PROJECT_ID
APPWRITE_API_KEY                                    needs files.read + files.write
APPWRITE_PLANS_BUCKET_ID
```

Without `OPENAI_API_KEY` the deterministic selector runs and `strategy` says so. Without `DB_URL`
nothing works.

## Map

```
src/
  catalog/      search.js  prefetch.js  availability.js  media-map.js
  engine/       cost.js  select.js  model.js  build.js
  rules/        index.js  evaluate.js  merge.js
  render/       index.js  resolvers.js  style.js
  storage/      appwrite.js
  routes/       plans.js  brief.js  health.js  + legacy /api/* browse routes
  pg.js         connection pool
db/schema.sql   masters.* and app.*
```
