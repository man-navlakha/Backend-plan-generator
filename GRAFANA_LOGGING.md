# Grafana / Loki logging

The application writes one JSON object per line to stdout. Railway, Vercel, an
OpenTelemetry Collector, or Grafana Alloy can collect that stream. It can also
push the same entries directly to a Grafana Loki HTTP endpoint.

## Delivery options

### Platform log drain (recommended for serverless)

Keep `GRAFANA_LOKI_URL` empty and configure the hosting platform's log drain to
send stdout to Grafana. This avoids making a second network request inside each
Vercel invocation. Every line is already valid JSON.

### Direct Loki push

Set these secrets in Railway or Vercel:

```text
GRAFANA_LOKI_URL=https://<logs-host>/loki/api/v1/push
GRAFANA_LOKI_USER=<Grafana logs instance/user ID>
GRAFANA_LOKI_API_KEY=<access-policy token with logs:write>
```

For self-hosted multi-tenant Loki, also set:

```text
GRAFANA_LOKI_TENANT_ID=<tenant>
```

The exporter batches logs on a long-running server. On Vercel it automatically
uses a batch size of one. Export failure is recorded as
`observability.loki_export_failed` on stdout and never fails a client request.

`GET /health` reports whether Loki is configured, but never returns its URL,
username, or token.

## Runtime controls

```text
SERVICE_NAME=backend-plan-generator
LOG_LEVEL=info                 # debug, info, warn, error
LOG_DB_QUERIES=0               # set to 1 temporarily for successful SQL timings
DB_SLOW_QUERY_MS=750           # slow queries are always warnings
GRAFANA_LOKI_BATCH_SIZE=25
GRAFANA_LOKI_FLUSH_MS=1000
GRAFANA_LOKI_TIMEOUT_MS=5000
```

Do not leave `LOG_DB_QUERIES=1` enabled unless the extra volume is useful.
Queries log only operation, target table, parameter count, row count, and
duration. SQL parameter values are never logged.

## Correlation

Every non-health HTTP response includes `X-Request-Id`. Supply your own safe ID
with the `X-Request-Id` request header or use the generated value from the
response. During plan generation, all downstream PostgreSQL, AI, workbook, and
storage logs inherit the same `request_id`, `plan_id`, `deal_id`, and `service`.

The Loki exporter uses only three low-cardinality stream labels:

```text
service, environment, level
```

Everything else remains in the JSON log line and is parsed at query time.

## Useful LogQL queries

All application errors:

```logql
{service="backend-plan-generator", level="error"} | json
```

One request from API entry through database, AI, workbook, and upload:

```logql
{service="backend-plan-generator"} | json | request_id="<X-Request-Id>"
```

One generated plan:

```logql
{service="backend-plan-generator"} | json | plan_id="31"
```

Workbook failures:

```logql
{service="backend-plan-generator"} | json | event="workbook.render.failed"
```

Slow PostgreSQL calls:

```logql
{service="backend-plan-generator"} | json | event="postgres.query.slow"
```

Failed plans in the last hour:

```logql
sum(count_over_time({service="backend-plan-generator"} | json | event="plan.generation.failed" [1h]))
```

95th percentile request time:

```logql
quantile_over_time(0.95, {service="backend-plan-generator"} | json | unwrap duration_ms [5m])
```

## Main diagnostic events

| Area | Events |
| --- | --- |
| HTTP | `http.request.started`, `http.request.completed`, `http.request.aborted`, `http.request.failed` |
| Plan | `plan.generation.started`, `plan.build.completed`, `plan.generation.completed`, `plan.generation.blocked`, `plan.generation.failed` |
| Brief AI | `plan.brief_review.started`, `plan.brief_review.completed`, `plan.brief_review.rejected`, `plan.brief_review.failed` |
| Selection AI | `selection.model.started`, `selection.model.completed`, `selection.model.tool.completed`, `selection.model.fallback`, `selection.model.failed` |
| Database | `postgres.pool.creating`, `postgres.query.slow`, `postgres.query.failed`, transaction events |
| Workbook | `workbook.render.started`, `workbook.render.completed`, `workbook.render.failed`, duplicate/ignored-leg warnings |
| Storage | `storage.upload.*`, `storage.download.*`, `plan.upload.completed` |
| Process | `server.started`, `server.shutdown.started`, `process.warning`, `process.uncaught_exception` |

## Data safety

Authorization headers, cookies, database URLs, API keys, passwords, tokens, and
similarly named nested fields are replaced with `[REDACTED]`. Full client briefs,
OpenAI prompts, SQL parameter values, and workbook bytes are not logged. Long
error messages and stacks are truncated to stay below Loki line-size limits.
