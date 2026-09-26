-- Unified master catalog + plan store.
--
-- Two schemas, two lifecycles:
--   masters.*  rebuilt wholesale from the Excel workbooks. Read-heavy. Safe to drop.
--   app.*      written at runtime - briefs, plans, model traces. Never dropped.
--
-- Apply with:  npm run db:setup

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE SCHEMA IF NOT EXISTS masters;
CREATE SCHEMA IF NOT EXISTS app;

-- =============================== masters ===============================

-- One row per source workbook, so a plan can say which import it was priced from.
CREATE TABLE IF NOT EXISTS masters.catalogs (
  slug         TEXT PRIMARY KEY,
  label        TEXT NOT NULL,
  family       TEXT NOT NULL,
  workbook     TEXT,
  imported_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  row_counts   JSONB NOT NULL DEFAULT '{}'::jsonb
);

/*
 * Every bookable thing across all nine masters.
 *
 * `id` is assigned by the importer (catalog offset + source id), not a sequence,
 * so a re-import lands on the same ids and a stored plan keeps pointing at the
 * same product.
 *
 * Media-specific columns do not belong here - a cinema seat count and a radio
 * frequency have nothing to say to each other. They live in `attrs`.
 */
CREATE TABLE IF NOT EXISTS masters.products (
  id            BIGINT PRIMARY KEY,
  catalog       TEXT NOT NULL REFERENCES masters.catalogs(slug) ON DELETE CASCADE,
  family        TEXT NOT NULL,              -- transit | radio | cinema | btl | digital | print | tv
  media_type    TEXT NOT NULL,              -- canonical slug: auto, bus, fm_radio, cinema, wall_painting
  media_label   TEXT,                       -- what the master called it: 'Auto', 'ATM Branding'
  source_row    INTEGER,
  sku           TEXT,
  name          TEXT NOT NULL,
  description   TEXT,
  image_url     TEXT,
  status        INTEGER NOT NULL DEFAULT 1,
  sort_order    INTEGER,

  -- Normalised location. Not every master carries one; see location_source.
  country       TEXT,
  state         TEXT,
  city          TEXT,
  locality      TEXT,
  zone          TEXT,
  -- 'master'  the workbook had a Location sheet - trust it
  -- 'name'    parsed out of the product name - good, not certain
  -- 'none'    no location (trains, national digital inventory)
  location_source TEXT NOT NULL DEFAULT 'none',

  attrs         JSONB NOT NULL DEFAULT '{}'::jsonb,
  search_text   TEXT NOT NULL DEFAULT ''
);

/*
 * One row per quotable line item - this is the grain the plan engine works at
 * and the grain a tool call returns.
 *
 * Units, attributes, add-ons and variants are folded in as JSONB rather than
 * four child tables. A price option is only useful whole: the rate means
 * nothing without its unit, its minimum and the spec it is attached to. One
 * fetch, one complete object, nothing left to re-join.
 */
CREATE TABLE IF NOT EXISTS masters.price_options (
  id               BIGINT PRIMARY KEY,
  product_id       BIGINT NOT NULL REFERENCES masters.products(id) ON DELETE CASCADE,
  -- Denormalised so the common filter (media + city + budget) never needs the join.
  catalog          TEXT NOT NULL,
  family           TEXT NOT NULL,
  media_type       TEXT NOT NULL,
  source_row       INTEGER,

  sku              TEXT,
  name             TEXT NOT NULL,
  template         TEXT,

  minimum_billing  NUMERIC,
  offer_rate       NUMERIC,
  buying_rate      NUMERIC,
  discounted_rate  NUMERIC,
  pricing_unit     TEXT,
  gst              NUMERIC,
  on_request       BOOLEAN NOT NULL DEFAULT FALSE,

  status           INTEGER NOT NULL DEFAULT 1,
  sort_order       INTEGER,
  image_url        TEXT,

  units            JSONB NOT NULL DEFAULT '[]'::jsonb,  -- [{unit,code,step,minimum,maximum}]
  attrs            JSONB NOT NULL DEFAULT '{}'::jsonb,  -- {"Media Type":"All 3 Sides"}
  addons           JSONB NOT NULL DEFAULT '[]'::jsonb,  -- printing/mounting and friends
  variants         JSONB NOT NULL DEFAULT '[]'::jsonb,  -- radio time slots, magazine positions
  rate_sources     JSONB NOT NULL DEFAULT '[]'::jsonb   -- cinema: how the offer rate was derived
);

-- Carried over from the imports so the desk (and the rules engine) can see what
-- the master got wrong before a plan quotes it.
CREATE TABLE IF NOT EXISTS masters.data_quality_issues (
  id               BIGSERIAL PRIMARY KEY,
  catalog          TEXT NOT NULL,
  entity_type      TEXT NOT NULL,
  product_id       BIGINT REFERENCES masters.products(id) ON DELETE CASCADE,
  price_option_id  BIGINT REFERENCES masters.price_options(id) ON DELETE CASCADE,
  source_sheet     TEXT,
  source_row       INTEGER,
  severity         TEXT NOT NULL CHECK (severity IN ('error','warning')),
  code             TEXT NOT NULL,
  field            TEXT,
  current_value    TEXT,
  suggested_value  TEXT,
  message          TEXT NOT NULL
);

-- Cinema's standalone print/handling rate card. Not a product; a lookup.
CREATE TABLE IF NOT EXISTS masters.qube_rate_card (
  id          BIGSERIAL PRIMARY KEY,
  source_row  INTEGER,
  section     TEXT NOT NULL,
  name        TEXT NOT NULL,
  rate        NUMERIC NOT NULL
);

CREATE INDEX IF NOT EXISTS products_media_idx     ON masters.products (media_type);
CREATE INDEX IF NOT EXISTS products_family_idx    ON masters.products (family);
CREATE INDEX IF NOT EXISTS products_city_idx      ON masters.products (lower(city));
CREATE INDEX IF NOT EXISTS products_state_idx     ON masters.products (lower(state));
CREATE INDEX IF NOT EXISTS products_status_idx    ON masters.products (status);
CREATE INDEX IF NOT EXISTS products_sku_idx       ON masters.products (sku);
CREATE INDEX IF NOT EXISTS products_attrs_idx     ON masters.products USING gin (attrs);
-- The index that makes search_products() tolerant of how the model phrases things.
CREATE INDEX IF NOT EXISTS products_search_trgm   ON masters.products USING gin (search_text gin_trgm_ops);

CREATE INDEX IF NOT EXISTS po_product_idx         ON masters.price_options (product_id);
CREATE INDEX IF NOT EXISTS po_media_idx           ON masters.price_options (media_type);
CREATE INDEX IF NOT EXISTS po_rate_idx            ON masters.price_options (offer_rate);
CREATE INDEX IF NOT EXISTS po_sku_idx             ON masters.price_options (sku);
CREATE INDEX IF NOT EXISTS po_attrs_idx           ON masters.price_options USING gin (attrs);

CREATE INDEX IF NOT EXISTS dqi_product_idx        ON masters.data_quality_issues (product_id);
CREATE INDEX IF NOT EXISTS dqi_po_idx             ON masters.data_quality_issues (price_option_id);
CREATE INDEX IF NOT EXISTS dqi_code_idx           ON masters.data_quality_issues (code);

-- ================================= app =================================

-- The brief exactly as it arrived, before anything interpreted it.
CREATE TABLE IF NOT EXISTS app.briefs (
  id                 BIGSERIAL PRIMARY KEY,
  deal_id            TEXT NOT NULL,
  company            TEXT NOT NULL,
  service            TEXT NOT NULL,
  -- Null means the CRM did not state a campaign budget. The generator then
  -- produces an inventory/options proposal instead of inventing a ceiling.
  budget             NUMERIC,
  campaign_objective TEXT,
  target_audience    TEXT,
  target_locations   TEXT[] NOT NULL DEFAULT '{}',
  remarks_for_media  TEXT,
  raw                JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS briefs_deal_idx ON app.briefs (deal_id);

/*
 * A generated plan: the JSON the renderer consumes, plus where the workbook
 * ended up and what it cost to produce.
 *
 * `plan` is the same object scripts/render-demo-plan.js builds by hand - that
 * fixture is the contract.
 */
CREATE TABLE IF NOT EXISTS app.plans (
  id             BIGSERIAL PRIMARY KEY,
  brief_id       BIGINT REFERENCES app.briefs(id) ON DELETE SET NULL,
  deal_id        TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','running','ready','blocked','failed')),
  plan           JSONB,
  flags          JSONB NOT NULL DEFAULT '[]'::jsonb,
  grand_total    NUMERIC,

  file_id        TEXT,
  file_name      TEXT,
  file_url       TEXT,

  model          TEXT,
  prompt_tokens  INTEGER,
  output_tokens  INTEGER,
  error          TEXT,

  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS plans_deal_idx   ON app.plans (deal_id);
CREATE INDEX IF NOT EXISTS plans_status_idx ON app.plans (status);
CREATE INDEX IF NOT EXISTS plans_flags_idx  ON app.plans USING gin (flags);

/*
 * Every tool call the model made while building a plan.
 *
 * This is not optional instrumentation. When a plan quotes the wrong SKU the
 * only way to find out why is to see what the model searched for and what came
 * back. Without it, debugging is guesswork.
 */
CREATE TABLE IF NOT EXISTS app.tool_calls (
  id            BIGSERIAL PRIMARY KEY,
  plan_id       BIGINT REFERENCES app.plans(id) ON DELETE CASCADE,
  seq           INTEGER NOT NULL,
  tool          TEXT NOT NULL,
  args          JSONB NOT NULL DEFAULT '{}'::jsonb,
  rows_returned INTEGER,
  duration_ms   INTEGER,
  error         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tool_calls_plan_idx ON app.tool_calls (plan_id, seq);
