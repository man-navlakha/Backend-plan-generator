# Deploying to Vercel

How to push this repository to GitHub and get a working URL, without the build failing.

Four things would have broken a deploy before today. All four are fixed in the repo — this document
says what they were, so nobody reintroduces them.

---

## What was wrong, and what fixed it

### 1. There was no Vercel entrypoint at all

`src/server.js` calls `app.listen()`. Vercel does not run a long-lived process — it imports a module
and calls the exported handler once per request. With no entrypoint, the deploy would have produced a
site with **no functions**: every request a 404.

**Fixed:** [api/index.js](api/index.js) exports the Express app, and [vercel.json](vercel.json)
rewrites every path to it.

```js
// api/index.js
module.exports = require('../src/app');
```

`src/server.js` is still what you run locally and on any host with a real process (Railway, Render, a
VM). Both entrypoints share `src/app.js`, so routing is defined once.

### 2. The build imported Excel files that are not in the repository

`vercel-build` ran four SQLite import scripts. Those need nine workbooks. **Only three are committed**
— Cinema, Radio and Transit. The other six (btl, digital, digital_pr, magazine, newspaper, tv) are
not in git, so `import-other-masters.js` would have failed and taken the build with it.

**Fixed:** `vercel-build` is now a no-op. The catalog lives in Postgres; Vercel has no reason to
rebuild it from Excel.

```json
"vercel-build": "echo \"No build step: the catalog lives in Postgres.\""
```

This also removes a second problem that was coming: those imports produce **154 MB** of `.db` files,
against a 250 MB serverless bundle limit. One more master and the deploy would have failed on size.

Use `npm run db:import:all` locally when a workbook changes, then `npm run db:migrate` to push the
result to Postgres. Neither runs on Vercel.

### 3. Health checks reported a correct deployment as broken

`/health/ready` returned **503** when the SQLite catalogs were missing — which is exactly the state
Vercel is now in, by design.

**Fixed:** a missing catalog reports `not_built` and does not affect readiness. A catalog that exists
but fails to answer is still `down`, because that is a real fault.

Verified with the SQLite paths pointed at an empty directory:

```
ready: ready | HTTP 200
   transitDatabase        not_built
   postgres               up
   planStorage            up
```

And a plan generated in that same state: **HTTP 201, workbook downloaded, 103,962 bytes.** The plan
generator does not touch SQLite.

### 4. No Node version was pinned

**Fixed:** `"engines": { "node": ">=20.x" }`. Vercel otherwise picks its current default, which moves.

---

## The one thing you must check yourself

**`maxDuration` is set to 300 seconds. That only works on a Pro plan.**

| Plan | Max duration | This API |
|---|---|---|
| Hobby | 60s | Transit plans (~40s) fit. **Cinema took 96s — it will time out.** |
| Pro | 300s | Everything measured fits |

Measured: transit 38–40s, bus 56s, cinema 59–96s. Most of it is the model call.

Three options:

1. **Pro plan.** Nothing to change.
2. **Hobby, accepting the risk.** Lower `maxDuration` to `60`. Simple briefs work; complex ones
   return a Vercel timeout, not a JSON error — the client sees a 504 with no explanation.
3. **Make it asynchronous.** `POST /plans` returns `202 { plan_id }` immediately and the work
   continues elsewhere. This is the right answer eventually and is listed as a known gap in
   [FLOW.md](FLOW.md). It is real work, not a config change.

If you are on Hobby and not ready to do (3), set `maxDuration` to `60` — a config that claims 300 on
a plan that allows 60 is rejected at deploy time.

---

## Environment variables

Set these in **Vercel → Project → Settings → Environment Variables**, for Production, Preview and
Development.

| Variable | Notes |
|---|---|
| `DB_URL` | Postgres connection string |
| `DB_POOL_MAX` | Set to **3** on Vercel, not the default 5 (see below) |
| `OPENAI_API_KEY` | Without it, plans are built by the deterministic selector |
| `OPENAI_MODEL` | Optional, defaults to `gpt-5-mini` |
| `APPWRITE_ENDPOINT` | `https://<region>.cloud.appwrite.io/v1` |
| `APPWRITE_PROJECT_ID` | |
| `APPWRITE_API_KEY` | Needs `files.read` **and** `files.write` |
| `APPWRITE_PLANS_BUCKET_ID` | |

Do **not** set `PORT` — Vercel manages it.

**Why `DB_POOL_MAX=3`:** every warm serverless instance holds its own pool. Ten concurrent instances
at 5 connections each is 50 connections, and Railway's Postgres caps well below where that becomes
comfortable. If you start seeing `too many connections`, this is the cause.

**`.env` must never be committed.** It is already in `.gitignore`. Verify before your first push:

```bash
git check-ignore -v .env     # must print a match
git ls-files | grep -i "^\.env$"   # must print nothing
```

If `.env` was ever committed, rotate every key in it. Removing the file in a later commit does not
remove it from history.

---

## First deploy

```bash
# 1. Confirm no secrets are staged
git status --porcelain | grep -i "\.env" && echo "STOP" || echo "clean"

# 2. Confirm the app boots and the entrypoint is a handler
node -e "const a=require('./api/index.js'); if(typeof a!=='function') throw new Error('not a handler'); console.log('entrypoint ok')"

# 3. Confirm the catalog is reachable and correct
npm run db:smoke:pg          # expect: All 13 checks passed

# 4. Push
git add -A
git commit -m "Postgres catalog, plan generator, Vercel entrypoint"
git push origin main
```

Then in Vercel: **Add New → Project → import the repository**. Framework preset **Other**. Add the
environment variables above *before* the first build, then deploy.

---

## Verifying the deployment

```bash
BASE=https://your-project.vercel.app

curl -s $BASE/health | jq .status
# "ok"

curl -s $BASE/health/ready | jq '.status, .checks.postgres.status, .checks.planStorage.status'
# "ready"  "up"  "up"

curl -s "$BASE/brief/media-types" | jq '.available, .coming_soon | length'
# 23  12

curl -s -X POST $BASE/plans -H "Content-Type: application/json" \
  -d '{"deal_id":"SMOKE-1","company":"Test","service":"Bus","budget":900000,"target_locations":["Mumbai"]}' \
  | jq '.status, .download_url'
```

Then open the `download_url`. If it returns an xlsx, the whole chain works — Postgres, OpenAI,
Appwrite, the renderer and the proxy.

---

## If it fails

| Symptom | Cause | Fix |
|---|---|---|
| 404 on every path | `api/index.js` missing, or `rewrites` removed from `vercel.json` | Restore both |
| `/api/transit` 404s but `/plans` works | Vercel matched the filesystem under `api/` before the rewrite | Verify first; if real, rename the browse routes off the `/api` prefix |
| 504 after ~60s | `maxDuration` above your plan's limit, or a genuinely slow brief | See the duration section |
| `too many connections` | Pool size × warm instances | `DB_POOL_MAX=3` |
| `OPENAI_API_KEY is not set` in logs, plans still build | Variable missing in Vercel | Add it; `strategy` in the response tells you which selector ran |
| Download returns 401 | `APPWRITE_API_KEY` lacks `files.read` | The proxy reads through the server key; write alone is not enough |
| `Cannot find module 'better-sqlite3'` | Native module failed to install | Only the legacy `/api/*` routes need it. It ships prebuilt binaries for Node 20; if it keeps failing, those routes can be dropped |
| Build fails on a missing `.xlsx` | `vercel-build` was changed back to the import scripts | Keep it a no-op |

Vercel logs: **Project → Deployments → the deployment → Functions**.

---

## Routing, and the one risk I could not test locally

`vercel.json` rewrites `/(.*)` to `/api`, and the app also serves routes under `/api/transit`,
`/api/radio`, `/api/cinema`, `/api/masters`.

Vercel resolves the filesystem before rewrites. `/api/transit` has no matching file, so it should
fall through to the rewrite and reach Express with its original path intact. That is the standard
Express-on-Vercel arrangement and it should work.

**But it depends on Vercel's routing order, which cannot be verified without deploying.** Check
`/api/transit/stats` on the first deploy. If it 404s while `/plans` works, the collision is real, and
the fix is to move those browse routes off the `/api` prefix — for example to `/catalog/transit` — in
`src/app.js`. The plan generator is unaffected either way.

---

## Keeping it working

**Changing a rate card**

```bash
npm run db:import:all      # Excel -> SQLite (needs the workbooks locally)
npm run db:migrate         # SQLite -> Postgres
npm run db:smoke:pg        # 13 checks
```

No deploy needed. The catalog is data, not code — that is the main thing the Postgres move bought.

**Changing code**

Push to `main`. Vercel builds automatically. The build step does nothing, so it is fast and there is
very little left that can fail in it.

**Before any push**

```bash
npm run db:smoke:pg && node -e "require('./api/index.js'); console.log('boots')"
```

---

## What still needs doing

1. **Async plan generation.** The 40–96s synchronous POST is the weakest point of this deployment.
2. **The six missing workbooks.** Not needed for Vercel any more, but `npm run db:import:all` cannot
   be run by anyone who does not already have them. They belong in the repo or in shared storage.
3. **`app.tool_calls` is never written.** Without it, a wrong SKU in a plan cannot be traced back to
   what the model searched for.
