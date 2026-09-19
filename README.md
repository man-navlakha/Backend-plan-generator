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
when every dependency check passes and `503` when any fails. `checks` is empty
until dependencies are added.

Register a dependency by adding it to the handler in `src/routes/health.js`:

```js
checks.database = await probe('database', () => db.query('SELECT 1'));
```

The `probe` helper wraps each check in a timeout (2s by default) so a hung
dependency cannot stall the probe itself.

## Project structure

```
src/
  app.js            Express app, middleware, error handlers
  server.js         HTTP listener, graceful shutdown
  routes/health.js  Health and readiness endpoints
```
