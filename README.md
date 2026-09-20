# Backend Plan Generator

Express backend service.

## Setup

```bash
npm install
npm start
```

Server listens on port `3000` by default; override with the `PORT` environment variable.

## Scripts

| Script | Description |
| --- | --- |
| `npm start` | Start the server |
| `npm run dev` | Start with file watching |
| `npm run db:import` | Rebuild the SQLite transit database from `transitmaster.xlsx` |
| `npm run db:audit` | Print data-quality counts from the imported master |
| `npm run db:import:radio` | Rebuild the SQLite radio database from `radiomaster.xlsx` |

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
when both Transit and Radio SQLite checks pass and `503` if either fails.

The response includes the database status and probe latency:

```js
"checks": {
  "transitDatabase": { "status": "up", "latencyMs": 0 },
  "radioDatabase": { "status": "up", "latencyMs": 0 }
}
```

The `probe` helper wraps each check in a timeout (2s by default) so a hung
dependency cannot stall the probe itself.

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

## Project structure

```
src/
  app.js            Express app, middleware, error handlers
  server.js         HTTP listener, graceful shutdown
  routes/health.js  Health and readiness endpoints
  routes/brief.js   Deal brief intake and validation
```
