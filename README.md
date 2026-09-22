# Backend Plan Generator

Express backend service.

## Setup

```bash
npm install
npm start
```

Server listens on port `3000` by default; override with the `PORT` environment variable.

Copy `.env.example` to `.env` for the Appwrite credentials, then run with
`node --env-file=.env src/server.js`. The service starts without them — only
plan upload needs them.

## Scripts

| Script | Description |
| --- | --- |
| `npm start` | Start the server |
| `npm run dev` | Start with file watching |
| `npm run db:import` | Rebuild the SQLite transit database from `transitmaster.xlsx` |
| `npm run db:audit` | Print data-quality counts from the imported master |
| `npm run db:import:radio` | Rebuild the SQLite radio database from `radiomaster.xlsx` |
| `npm run db:import:cinema` | Rebuild the SQLite cinema database from `New Cinema Master Final.xlsx` |
| `npm run db:import:others` | Rebuild the shared SQLite database for all nine master workbooks |
| `npm run db:import:all` | Rebuild Transit, Radio, Cinema, and the shared catalog in dependency order |
| `npm run db:smoke:masters` | Check every master catalog, detail API, filters, and CSV export |
| `npm run db:smoke:dedicated` | Check the six dedicated master pages and their media-specific filters |
| `npm run plan:demo` | Render the demo plan workbook to `output/` |
| `npm run plan:upload` | Render it and upload the workbook to the Appwrite bucket |

## All masters, one page

Run `npm run db:import:all`, start the server, then open
`http://localhost:3000/masters/` to choose a dedicated master desk. The six
new pages are `/btl/`, `/digital/`, `/digital-pr/`, `/magazine/`, `/newspaper/`,
and `/tv/`; the existing `/transit/`, `/radio/`, and `/cinema/` pages remain.
Each page presents its own relevant fields, filters, booking options,
plan-readiness findings, product details, and repair CSV. Product rows load as
you scroll. Newspaper has no pricing sheet, so its page marks rates as missing
instead of inventing them.

The dedicated audits also check BTL audience fields, Digital reach/category,
Digital PR publisher authority and website URLs, Magazine circulation and
quantity rules, Newspaper circulation and missing rates, and TV quantity
rules. Where a workbook does not supply a buying cost, the option detail says
that its margin cannot be verified.

The six new desks use `src/data/other-masters.db`; Transit, Radio, and Cinema
retain their dedicated databases and their specialized audit findings are also
available through the shared API. The `/masters/` route is only a directory,
not a combined product catalog.

Shared API endpoints: `GET /api/masters`, `GET /api/masters/:slug/filters`,
`GET /api/masters/:slug/products`, `GET /api/masters/:slug/products/:id`,
`GET /api/masters/:slug/problems/summary`,
`GET /api/masters/:slug/problems.csv`, and
`GET /api/masters/problems.csv` for one combined repair file.

The master workbook itself remains the source of truth. The SQLite data and
CSV are a read-only review and repair aid; corrections should be made in the
source workbook, then imported again.

## Transit master catalog

The transit Excel master is imported into a normalized SQLite database at
`src/data/transit.db`. Re-run the import whenever the workbook changes:

```bash
npm run db:import
npm start
```

Open `http://localhost:3000/transit/` for the HTML/CSS inventory view. It
shows every matching record on one page and supports text search, media, tier
and data-quality filters, sorting, product images, and a detailed view of
linked pricing units, attributes, options and detected source-data problems.
The **Download all problems** action exports a repair-ready CSV with workbook
sheet and row, current values, suggested fixes and problem descriptions.
The pricing audit also flags client offer or discounted rates below the buying
cost. Product details show every source price, effective margin, quantity rule,
planning attribute and price modifier before a product is used in a plan.

Transit API endpoints:

| Endpoint | Description |
| --- | --- |
| `GET /api/transit/stats` | Imported record totals and media-type counts |
| `GET /api/transit/filters` | Available media and tier filters |
| `GET /api/transit/products` | Products; accepts `search`, `media_type`, `tier`, `problem`, `sort`, and `show_all` |
| `GET /api/transit/products/:id` | Product with all linked pricing data |
| `GET /api/transit/problems/summary` | Problem totals grouped by quality rule |
| `GET /api/transit/problems.csv` | Download every detected problem as a repair CSV |

## Radio master catalog

Run `npm run db:import:radio`, start the server, and open
`http://localhost:3000/radio/`. The Radio catalog shows every station on one
page with city, language, audience, frequency, full base pricing, time-band
variants, buying-cost margins, quantity rules and the workbook's Pending Fixes.
Problems can be downloaded from `GET /api/radio/problems.csv`; the other Radio
endpoints mirror Transit under `/api/radio`.

## Cinema master catalog

Run `npm run db:import:cinema`, start the server, and open
`http://localhost:3000/cinema/`. The single-page Cinema catalog covers venues,
chains, cities, tiers, seats, screens, ad-film and slide formats, all selling and
buying rates, and campaign quantity rules. Rows render progressively as you
scroll so the 6,000+ venue directory stays responsive. Product details also
show offer-rate provenance where the workbook provides it.

The data-quality filter checks pricing and margin, images, location, seat and
screen counts, quantity rules, and rate-source consistency. Download the repair
CSV at `GET /api/cinema/problems.csv`. Other endpoints are
`GET /api/cinema/stats`, `GET /api/cinema/filters`,
`GET /api/cinema/products`, `GET /api/cinema/products/:id`, and
`GET /api/cinema/problems/summary`.

## Endpoints

### `GET /health`

Liveness probe. Returns process uptime, version, environment and memory usage.
Intentionally cheap — it performs no dependency checks, so a slow database
cannot cause an orchestrator to restart an otherwise healthy process.

```json
{
  "status": "ok",
  "uptime": 3.7,
  "startedAt": "2026-09-19T10:09:26.436Z",
  "timestamp": "2026-09-19T10:09:26.548Z",
  "version": "1.0.0",
  "environment": "development",
  "memory": { "rssMb": 52.45, "heapUsedMb": 7.95, "heapTotalMb": 16.81 }
}
```

### `GET /health/ready`

Readiness probe — this is the one to wire to a load balancer. Returns `200`
when the Transit, Radio, Cinema, and shared master SQLite checks pass and `503`
if any fails.

The response includes the database status and probe latency:

```js
"checks": {
  "transitDatabase": { "status": "up", "latencyMs": 0 },
  "radioDatabase": { "status": "up", "latencyMs": 0 },
  "cinemaDatabase": { "status": "up", "latencyMs": 0 },
  "otherMastersDatabase": { "status": "up", "latencyMs": 0 },
  "planStorage": { "status": "up", "latencyMs": 180 }
}
```

`planStorage` calls the Appwrite bucket. Without credentials it reports
`not_configured` and lists the missing variables, and readiness still passes —
a local run with no Appwrite account is ready to serve the catalogs.

The `probe` helper wraps each check in a timeout (2s by default, 4s for the
bucket) so a hung dependency cannot stall the probe itself.

### `GET /brief`

Takes a deal brief as query parameters, validates it and returns the parsed
brief. Returns `200` with `status: "ok"` when valid, `400` with a list of
field errors when not.

| Parameter | Required | Aliases | Notes |
| --- | --- | --- | --- |
| `deal_id` | yes | `dealId`, `deal` | |
| `company` | yes | `client` | |
| `service` | yes | `media`, `media_type` | Media name or slug — see `/brief/media-types` |
| `budget` | yes | `amount` | Digits; `,`, spaces and `₹` are stripped |
| `campaign_objective` | no | `objective` | |
| `target_audience` | no | `audience` | |
| `target_locations` | no | `locations` | Comma-separated, returned as an array |
| `remarks_for_media` | no | `remarks` | |

```
GET /brief?deal_id=EP-2026-0142&company=Imprexive&service=Metro%20Train
    &budget=2,50,000&campaign_objective=Brand%20awareness
    &target_audience=Working%20professionals%2025-40
    &target_locations=Ahmedabad,Surat&remarks_for_media=Premium%20coaches%20only
```

```json
{
  "status": "ok",
  "receivedAt": "2026-09-19T13:08:13.889Z",
  "brief": {
    "deal_id": "EP-2026-0142",
    "company": "Imprexive",
    "service": "Metro Train",
    "media": {
      "slug": "metro_train",
      "family": "transit",
      "template": "assets/formats/transit/metro_train/Metro.xlsx"
    },
    "budget": 250000,
    "campaign_objective": "Brand awareness",
    "target_audience": "Working professionals 25-40",
    "target_locations": ["Ahmedabad", "Surat"],
    "remarks_for_media": "Premium coaches only"
  }
}
```

### `GET /brief/media-types`

Lists the accepted `service` values with their slug and family, read from
`src/assets/formats/format_index.json`.

## Plan storage (Appwrite)

A rendered plan is uploaded to an Appwrite Storage bucket. The workbook goes up
from memory — on Vercel the filesystem is read-only, and a plan that only
exists in `output/` is a plan nobody else can open.

| Variable | What it is |
| --- | --- |
| `APPWRITE_ENDPOINT` | e.g. `https://fra.cloud.appwrite.io/v1` |
| `APPWRITE_PROJECT_ID` | project the bucket lives in |
| `APPWRITE_API_KEY` | server key with `files.read` and `files.write` |
| `APPWRITE_PLANS_BUCKET_ID` | the bucket plan workbooks land in |

In the Appwrite console, the bucket must allow the `xlsx` extension and a
maximum file size above the workbook's — an empty extension list allows
everything, a list that omits `xlsx` rejects every plan.

```js
const { planWorkbookBuffer } = require('./src/render');
const { uploadPlan } = require('./src/storage/appwrite');

const stored = await uploadPlan(await planWorkbookBuffer(plan), { plan });
// -> { fileId, bucketId, name, size, mimeType, uploadedAt, downloadUrl, viewUrl }
```

The filename is built from the deal and client:
`deal-1042-awadh-foods-pvt-ltd-20260922-1431.xlsx`. Pass `filename`, `fileId`,
`folder` or `permissions` to override; with no `permissions` the file takes the
bucket's own.

The two URLs answer only to a role the file grants read to. On a private bucket
they need the API key, a session or a file token, so they are not links to paste
into a client email.

`npm run plan:upload` renders the demo plan and pushes it to the bucket — the
quickest way to prove the credentials and bucket settings are right.

## Project structure

```
src/
  app.js            Express app, middleware, error handlers
  server.js         HTTP listener, graceful shutdown
  routes/health.js  Health and readiness endpoints
  routes/brief.js   Deal brief intake and validation
  render/           Plan workbook renderer (file or buffer)
  storage/          Appwrite Storage: uploads the rendered plan
```
