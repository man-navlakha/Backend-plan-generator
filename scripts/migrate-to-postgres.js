/**
 * Loads the four SQLite catalogs into Postgres as one unified master.
 *
 *   node --env-file=.env scripts/migrate-to-postgres.js [--dry] [--catalog=transit]
 *
 * Source of truth per catalog:
 *
 *   transit.db        typed import  -> catalog 'transit'  (10 media types)
 *   radio.db          typed import  -> catalog 'radio'
 *   cinema.db         typed import  -> catalog 'cinema'
 *   other-masters.db  generic       -> btl, digital, digital_pr, magazine, tv
 *                                      (newspaper is skipped -- see main())
 *
 * other-masters.db also holds transit/radio/cinema, but generically -- every
 * field flattened into fields_json. Where a dedicated importer exists it parsed
 * the workbook better, so it wins and the generic copy is skipped.
 *
 * The script is destructive and re-runnable: it truncates masters.* and rebuilds.
 * app.* is never touched.
 */

const path = require('path');
const Database = require('better-sqlite3');
const formatIndex = require('../src/assets/formats/format_index.json');
const { query, getPool, close } = require('../src/pg');

const DRY = process.argv.includes('--dry');
const catalogArg = process.argv.find((arg) => arg.startsWith('--catalog='));
const SELECTED_CATALOG = catalogArg ? catalogArg.slice('--catalog='.length) : null;
const DATA = path.join(__dirname, '..', 'src', 'data');

// Ids are deterministic (offset + source id) so a re-import leaves a stored
// plan pointing at the same rows it was priced from.
const OFFSET = {
  transit: 10_000_000,
  radio: 20_000_000,
  cinema: 30_000_000,
  btl: 40_000_000,
  digital: 50_000_000,
  digital_pr: 60_000_000,
  magazine: 70_000_000,
  tv: 90_000_000
};

const FAMILY = {
  transit: 'transit',
  radio: 'radio',
  cinema: 'cinema',
  btl: 'btl',
  digital: 'digital',
  digital_pr: 'digital',
  magazine: 'print',
  tv: 'tv'
};

// Display name -> canonical slug, taken from the format index so the slugs the
// renderer already uses are the slugs the database stores.
const MEDIA_SLUG = new Map();
for (const [name, meta] of Object.entries(formatIndex.media_types)) {
  MEDIA_SLUG.set(name.toLowerCase(), meta.slug);
}

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}

/** 'Metro Train' -> 'metro_train'; unknown labels still get a usable slug. */
function mediaSlug(label, fallback) {
  if (!label) return fallback;
  return MEDIA_SLUG.get(String(label).trim().toLowerCase()) || slugify(label) || fallback;
}

function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(String(value).replace(/[,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function int(value) {
  const n = num(value);
  return n === null ? null : Math.trunc(n);
}

function text(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s === '' ? null : s;
}

function yes(value) {
  return /^(y|yes|1|true)$/i.test(String(value || '').trim());
}

function parseJson(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

// ───────────────────────────── location ─────────────────────────────

/**
 * City -> state, learned from the masters that carry a real Location sheet
 * (cinema, radio, newspaper). Transit and BTL have no location columns at all,
 * so their city has to be read out of the product name -- and a name fragment
 * is only a city if a master somewhere has already called it one.
 */
function buildCityDictionary(dbs) {
  const dict = new Map();
  const states = new Map();
  const add = (city, state) => {
    const stateName = text(state);
    if (stateName && stateName.length > 2) states.set(stateName.toLowerCase(), stateName);
    const key = text(city)?.toLowerCase();
    if (!key || key.length < 3) return;
    if (!dict.has(key) || (!dict.get(key).state && stateName)) {
      dict.set(key, { city: text(city), state: stateName });
    }
  };

  for (const table of ['locations']) {
    for (const db of [dbs.cinema, dbs.radio]) {
      if (!db) continue;
      try {
        for (const row of db.prepare(`select city, state from ${table}`).all()) add(row.city, row.state);
      } catch {
        /* table absent in this catalog */
      }
    }
  }

  // Location rows inside other-masters (newspaper carries 2408 of them).
  for (const row of dbs.other
    .prepare("select fields_json from related_rows where sheet = 'Location'")
    .all()) {
    const f = parseJson(row.fields_json, {});
    add(f.City || f.city, f.State || f.state);
  }

  dict.states = states;
  return dict;
}

/**
 * "ATM Branding, Chennai, Tamil Nadu" -> Chennai / Tamil Nadu
 * "Auto Branding - Lucknow"           -> Lucknow / Uttar Pradesh (state from dict)
 * "...digital screen Malad West Mumbai" -> Mumbai
 *
 * Three reads, strongest first:
 *
 *  1. A trailing segment that is a known *state* anchors the one before it as
 *     the city. This is the only read that works for the 4,800 BTL towns too
 *     small to appear in any other master -- Mainaguri, Basavakalyan, Sikkal.
 *  2. Otherwise, the rightmost segment the city dictionary recognises.
 *  3. Otherwise, a known city name sitting at the very end of an unpunctuated
 *     name.
 *
 * Nothing else is accepted, so "Ahimsa Express" stays location-less rather than
 * becoming a city.
 */
function locationFromName(name, dict) {
  const raw = String(name || '');
  const segments = raw
    .split(/\s*[,–—]\s*|\s+[-–—]\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

  // 1. <anything>, <city>, <state>
  for (let i = segments.length - 1; i >= 1; i -= 1) {
    if (dict.states.has(segments[i].toLowerCase())) {
      const city = segments[i - 1];
      // The segment before a state is the city unless it is another state.
      if (city && !dict.states.has(city.toLowerCase())) {
        return {
          city,
          state: dict.states.get(segments[i].toLowerCase()),
          locality: null,
          country: 'India'
        };
      }
    }
  }

  // 2. rightmost segment the dictionary knows
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    const hit = dict.get(segments[i].toLowerCase());
    if (hit) return { city: hit.city, state: hit.state, locality: null, country: 'India' };
  }

  // 3. trailing city in an unpunctuated name
  const words = raw.split(/\s+/);
  for (const size of [3, 2, 1]) {
    if (words.length < size) continue;
    const tail = words.slice(-size).join(' ').replace(/[^\w\s.&-]/g, '').trim();
    const hit = dict.get(tail.toLowerCase());
    if (hit) return { city: hit.city, state: hit.state, locality: null, country: 'India' };
  }

  return null;
}

// ───────────────────────────── bulk insert ─────────────────────────────

/**
 * Multi-row INSERT in batches.
 *
 * Postgres caps a statement at 65535 bound parameters, so the batch size is
 * derived from the column count rather than guessed.
 */
async function insertRows(client, table, columns, rows, label) {
  if (rows.length === 0) return 0;
  const perRow = columns.length;
  const batchSize = Math.max(1, Math.min(1000, Math.floor(60000 / perRow)));
  let done = 0;

  for (let start = 0; start < rows.length; start += batchSize) {
    const slice = rows.slice(start, start + batchSize);
    const params = [];
    const tuples = slice.map((row, r) => {
      const placeholders = columns.map((_, c) => `$${r * perRow + c + 1}`);
      for (const col of columns) params.push(row[col] ?? null);
      return `(${placeholders.join(',')})`;
    });

    await client.query(
      `INSERT INTO ${table} (${columns.join(',')}) VALUES ${tuples.join(',')}
       ON CONFLICT DO NOTHING`,
      params
    );
    done += slice.length;
    process.stdout.write(`\r  ${label}: ${done}/${rows.length}`);
  }
  process.stdout.write(`\r  ${label}: ${done}/${rows.length}\n`);
  return done;
}

// ───────────────────────────── extractors ─────────────────────────────

/** Rolls the child tables of a typed import up onto their price option. */
function groupBy(rows, key) {
  const map = new Map();
  for (const row of rows) {
    const k = row[key];
    if (k === null || k === undefined) continue;
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(row);
  }
  return map;
}

function searchText(parts) {
  return parts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim().slice(0, 2000);
}

function extractTransit(db, dict) {
  const off = OFFSET.transit;
  const products = [];
  const priceOptions = [];

  for (const p of db.prepare('select * from products').all()) {
    const loc = locationFromName(p.name, dict);
    const media = mediaSlug(p.media_type, 'transit');
    products.push({
      id: off + p.id,
      catalog: 'transit',
      family: 'transit',
      media_type: media,
      media_label: text(p.media_type),
      source_row: p.source_row,
      sku: text(p.sku),
      name: p.name,
      description: text(p.short_description),
      image_url: text(p.image),
      status: p.status ?? 1,
      sort_order: p.sort_order,
      country: loc?.country ?? null,
      state: loc?.state ?? null,
      city: loc?.city ?? null,
      locality: null,
      zone: null,
      location_source: loc ? 'name' : 'none',
      attrs: JSON.stringify({
        tier: text(p.tier),
        size_dimension: text(p.size_dimension),
        delete_flag: text(p.delete_flag)
      }),
      search_text: searchText([p.name, p.sku, p.media_type, loc?.city, loc?.state, p.tier])
    });
  }

  const units = groupBy(db.prepare('select * from price_units').all(), 'price_option_id');
  const attrVals = groupBy(db.prepare('select * from attribute_values').all(), 'price_option_id');
  const optVals = groupBy(db.prepare('select * from pricing_option_values').all(), 'price_option_id');

  for (const o of db.prepare('select * from price_options').all()) {
    const attrs = {};
    for (const av of attrVals.get(o.id) || []) {
      if (av.attribute_name) attrs[av.attribute_name] = av.value;
    }
    priceOptions.push({
      id: off + o.id,
      product_id: off + o.product_id,
      catalog: 'transit',
      family: 'transit',
      media_type: 'transit',
      source_row: o.source_row,
      sku: text(o.sku),
      name: o.name,
      template: text(o.pricing_template_name),
      minimum_billing: num(o.minimum_billing),
      offer_rate: num(o.offer_rate),
      buying_rate: num(o.specific_buying_rate),
      discounted_rate: num(o.discounted_rate),
      pricing_unit: text(o.pricing_unit),
      gst: num(o.gst),
      on_request: yes(o.on_request),
      status: o.status ?? 1,
      sort_order: o.sort_order,
      image_url: text(o.image),
      units: JSON.stringify(
        (units.get(o.id) || []).map((u) => ({
          unit: u.unit_name,
          code: u.code,
          step: num(u.step),
          minimum: num(u.minimum),
          maximum: num(u.maximum)
        }))
      ),
      attrs: JSON.stringify(attrs),
      addons: JSON.stringify(
        (optVals.get(o.id) || []).map((v) => ({
          name: v.option_name,
          value: v.value,
          modify_type: v.modify_type,
          modify_price: num(v.modify_price)
        }))
      ),
      variants: '[]',
      rate_sources: '[]'
    });
  }

  return { products, priceOptions, mediaFix: true };
}

function extractRadio(db, dict) {
  const off = OFFSET.radio;
  const products = [];
  const priceOptions = [];
  const locations = groupBy(db.prepare('select * from locations').all(), 'product_id');

  for (const p of db.prepare('select * from products').all()) {
    const loc = (locations.get(p.id) || [])[0];
    products.push({
      id: off + p.id,
      catalog: 'radio',
      family: 'radio',
      media_type: 'fm_radio',
      media_label: 'Radio',
      source_row: p.source_row,
      sku: text(p.sku),
      name: p.name,
      description: text(p.short_description),
      image_url: text(p.image),
      status: p.status ?? 1,
      sort_order: p.sort_order,
      country: text(loc?.country) || 'India',
      state: text(loc?.state),
      city: text(loc?.city),
      locality: text(loc?.locality),
      zone: null,
      location_source: loc?.city ? 'master' : 'none',
      attrs: JSON.stringify({
        tier: text(p.tier),
        station: text(p.station),
        language: text(p.language),
        audience: text(p.audience),
        frequency: num(p.frequency),
        rank: num(p.rank),
        listenership: text(p.listenership),
        show_timing: text(p.show_timing),
        coverage_area: text(p.coverage_area)
      }),
      search_text: searchText([p.name, p.sku, p.station, p.language, loc?.city, loc?.state, p.audience])
    });
  }

  const units = groupBy(db.prepare('select * from price_units').all(), 'price_option_id');
  const attrVals = groupBy(db.prepare('select * from attribute_values').all(), 'price_option_id');
  const variants = groupBy(db.prepare('select * from variants').all(), 'price_option_id');

  for (const o of db.prepare('select * from price_options').all()) {
    const attrs = {};
    for (const av of attrVals.get(o.id) || []) {
      if (av.attribute_name) attrs[av.attribute_name] = av.value;
    }
    priceOptions.push({
      id: off + o.id,
      product_id: off + o.product_id,
      catalog: 'radio',
      family: 'radio',
      media_type: 'fm_radio',
      source_row: o.source_row,
      sku: text(o.sku),
      name: o.name,
      template: text(o.pricing_template_name),
      minimum_billing: num(o.minimum_billing),
      offer_rate: num(o.offer_rate),
      buying_rate: num(o.specific_buying_rate),
      discounted_rate: num(o.discounted_rate),
      pricing_unit: text(o.pricing_unit),
      gst: num(o.gst),
      on_request: yes(o.on_request),
      status: o.status ?? 1,
      sort_order: o.sort_order,
      image_url: text(o.image),
      units: JSON.stringify(
        (units.get(o.id) || []).map((u) => ({
          unit: u.unit_name,
          code: u.code,
          step: num(u.step),
          minimum: num(u.minimum),
          maximum: num(u.maximum)
        }))
      ),
      attrs: JSON.stringify(attrs),
      addons: '[]',
      variants: JSON.stringify(
        (variants.get(o.id) || []).map((v) => ({
          name: v.name,
          enabled: Boolean(v.enabled),
          buying_rate: num(v.specific_buying_rate),
          price: num(v.price),
          discounted_price: num(v.discounted_price),
          attributes: parseJson(v.attributes_json, [])
        }))
      ),
      rate_sources: '[]'
    });
  }

  return { products, priceOptions };
}

function extractCinema(db) {
  const off = OFFSET.cinema;
  const products = [];
  const priceOptions = [];
  const locations = groupBy(db.prepare('select * from locations').all(), 'product_id');

  for (const p of db.prepare('select * from products').all()) {
    const loc = (locations.get(p.id) || [])[0];
    products.push({
      id: off + p.id,
      catalog: 'cinema',
      family: 'cinema',
      media_type: 'cinema',
      media_label: 'Cinema',
      source_row: p.source_row,
      sku: text(p.sku),
      name: p.name,
      description: text(p.description),
      image_url: text(p.image),
      status: p.status ?? 1,
      sort_order: p.sort_order,
      country: 'India',
      state: text(loc?.state),
      city: text(loc?.city),
      locality: text(loc?.locality),
      zone: text(loc?.zone),
      location_source: loc?.city ? 'master' : 'none',
      attrs: JSON.stringify({
        cinema_chain: text(p.cinema_chain),
        screen: text(p.screen),
        screen_recommend: int(p.screen_recommend),
        total_screen: int(p.total_screen),
        seats: int(p.seats),
        audience_class: text(p.audience_class),
        tier: text(p.tier),
        rank: int(p.rank),
        google_map_location: text(p.google_map_location)
      }),
      search_text: searchText([p.name, p.sku, p.cinema_chain, loc?.city, loc?.state, loc?.locality, p.screen])
    });
  }

  const units = groupBy(db.prepare('select * from price_units').all(), 'price_option_id');
  const sources = groupBy(db.prepare('select * from offer_rate_sources').all(), 'price_option_id');

  for (const o of db.prepare('select * from price_options').all()) {
    priceOptions.push({
      id: off + o.id,
      product_id: off + o.product_id,
      catalog: 'cinema',
      family: 'cinema',
      media_type: 'cinema',
      source_row: o.source_row,
      sku: text(o.sku),
      name: o.name,
      template: text(o.template),
      minimum_billing: num(o.minimum_billing),
      offer_rate: num(o.offer_rate),
      buying_rate: num(o.buying_rate),
      discounted_rate: num(o.discounted_rate),
      pricing_unit: text(o.pricing_unit),
      gst: num(o.gst),
      on_request: yes(o.on_request),
      status: o.status ?? 1,
      sort_order: o.sort_order,
      image_url: text(o.image),
      units: JSON.stringify(
        (units.get(o.id) || []).map((u) => ({
          unit: u.name,
          code: u.code,
          step: num(u.step),
          minimum: num(u.minimum),
          maximum: num(u.maximum)
        }))
      ),
      attrs: '{}',
      addons: '[]',
      variants: '[]',
      rate_sources: JSON.stringify(
        (sources.get(o.id) || []).map((s) => ({
          screen: s.screen,
          rate_source: s.rate_source,
          basis: s.basis,
          source_rate: num(s.source_rate),
          divide_by: num(s.divide_by),
          offer_rate: num(s.offer_rate)
        }))
      )
    });
  }

  return { products, priceOptions };
}

/**
 * The six catalogs with no dedicated importer. Everything arrives as
 * fields_json, so the mapping is by column name with a per-catalog hint for
 * which field carries the media type.
 */
const OTHER_MEDIA_FIELD = {
  btl: 'Media Option',
  digital: null,
  digital_pr: null,
  magazine: null,
  tv: null
};

function extractOther(db, slug, dict) {
  const off = OFFSET[slug];
  const family = FAMILY[slug];
  const products = [];
  const priceOptions = [];

  const productRows = db.prepare('select * from products where catalog_slug = ?').all(slug);
  const productIds = new Set(productRows.map((p) => p.id));

  // Location sheet, where this catalog has one.
  const locByProduct = new Map();
  for (const r of db
    .prepare("select product_id, fields_json from related_rows where catalog_slug = ? and sheet = 'Location'")
    .all(slug)) {
    if (!locByProduct.has(r.product_id)) locByProduct.set(r.product_id, parseJson(r.fields_json, {}));
  }

  for (const p of productRows) {
    const fields = parseJson(p.fields_json, {});
    const locRow = locByProduct.get(p.id);
    const fromMaster = locRow && (locRow.City || locRow.city);
    const loc = fromMaster
      ? { city: text(locRow.City || locRow.city), state: text(locRow.State || locRow.state), country: 'India' }
      : locationFromName(p.name, dict);

    const label = OTHER_MEDIA_FIELD[slug] ? text(fields[OTHER_MEDIA_FIELD[slug]]) : null;

    // Drop the columns already promoted to real columns; the rest is attrs.
    const attrs = { ...fields };
    for (const k of [
      'Delete',
      'Product Name',
      'Sku',
      'Short Description',
      'Meta Title',
      'Meta Description',
      'Meta Keywords',
      'Image',
      'Sort Order',
      'Status'
    ]) {
      delete attrs[k];
    }

    products.push({
      id: off + p.id,
      catalog: slug,
      family,
      media_type: label ? mediaSlug(label, slug) : slug,
      media_label: label,
      source_row: p.source_row,
      sku: text(p.sku),
      name: p.name || text(p.sku) || `${slug}-${p.id}`,
      description: text(p.description),
      image_url: text(p.image_url) || text(p.image),
      status: p.status ?? 1,
      sort_order: p.sort_order,
      country: loc?.country ?? null,
      state: loc?.state ?? null,
      city: loc?.city ?? null,
      locality: text(locRow?.Locality || locRow?.locality),
      zone: text(locRow?.Zone || locRow?.zone),
      location_source: fromMaster ? 'master' : loc ? 'name' : 'none',
      attrs: JSON.stringify(attrs),
      search_text: searchText([p.name, p.sku, label, loc?.city, loc?.state, ...Object.values(attrs).slice(0, 6)])
    });
  }

  // Child sheets hang off a Price Option via option_id.
  const child = (sheet) =>
    groupBy(
      db
        .prepare('select * from related_rows where catalog_slug = ? and sheet = ?')
        .all(slug, sheet),
      'option_id'
    );

  const units = child('Price Unit');
  const attrValues = child('Attribute Value');
  const variants = child('Variant');
  const optionValues = child('Option Value');
  const rateSources = child('Offer Rate Source');

  for (const o of db
    .prepare("select * from related_rows where catalog_slug = ? and sheet = 'Price Option'")
    .all(slug)) {
    if (!productIds.has(o.product_id)) continue; // orphan row in the workbook
    const f = parseJson(o.fields_json, {});
    const attrs = {};
    for (const av of attrValues.get(o.id) || []) {
      const vf = parseJson(av.fields_json, {});
      const name = text(vf['Attribute Name'] || vf.Attribute || av.name);
      const value = text(vf.Value || vf['Attribute Value'] || av.name);
      if (name) attrs[name] = value;
    }

    priceOptions.push({
      id: off + o.id,
      product_id: off + o.product_id,
      catalog: slug,
      family,
      media_type: slug,
      source_row: o.source_row,
      sku: text(o.option_sku) || text(f['Price Option Sku']),
      name: text(o.name) || text(f['Price Option Name']) || 'Price Option',
      template: text(f['Pricing Template Name']),
      minimum_billing: num(o.minimum_billing ?? f['Minimum Billing']),
      offer_rate: num(o.price ?? f['Offer Rate']),
      buying_rate: num(o.buying_rate ?? f['Specific Buying Rate']),
      discounted_rate: num(o.discounted_rate ?? f['Discounted Rate']),
      pricing_unit: text(o.pricing_unit || f['Pricing Unit']),
      gst: num(f.GST),
      on_request: yes(f['On Request']),
      status: int(f.Status) ?? 1,
      sort_order: int(f['Sort Order']),
      image_url: text(o.image_url),
      units: JSON.stringify(
        (units.get(o.id) || []).map((u) => {
          const uf = parseJson(u.fields_json, {});
          return {
            unit: text(uf['Unit Name'] || uf.Name || u.name),
            code: text(uf.Code),
            step: num(uf.Step),
            minimum: num(uf.Minimum),
            maximum: num(uf.Maximum)
          };
        })
      ),
      attrs: JSON.stringify(attrs),
      addons: JSON.stringify(
        (optionValues.get(o.id) || []).map((v) => {
          const vf = parseJson(v.fields_json, {});
          return {
            name: text(vf['Option Name'] || v.name),
            value: text(vf.Value),
            modify_type: text(vf['Modify Type']),
            modify_price: num(vf['Modify Price'])
          };
        })
      ),
      variants: JSON.stringify(
        (variants.get(o.id) || []).map((v) => {
          const vf = parseJson(v.fields_json, {});
          return {
            name: text(vf['Variant Name'] || v.name),
            enabled: !/^n$/i.test(String(vf.Enabled || 'Y')),
            price: num(v.price ?? vf.Price),
            buying_rate: num(v.buying_rate ?? vf['Specific Buying Rate']),
            discounted_price: num(v.discounted_rate ?? vf['Discounted Price'])
          };
        })
      ),
      rate_sources: JSON.stringify(
        (rateSources.get(o.id) || []).map((s) => parseJson(s.fields_json, {}))
      )
    });
  }

  return { products, priceOptions };
}

// ───────────────────────────── main ─────────────────────────────

const PRODUCT_COLUMNS = [
  'id', 'catalog', 'family', 'media_type', 'media_label', 'source_row', 'sku', 'name',
  'description', 'image_url', 'status', 'sort_order', 'country', 'state', 'city',
  'locality', 'zone', 'location_source', 'attrs', 'search_text'
];

const PO_COLUMNS = [
  'id', 'product_id', 'catalog', 'family', 'media_type', 'source_row', 'sku', 'name',
  'template', 'minimum_billing', 'offer_rate', 'buying_rate', 'discounted_rate',
  'pricing_unit', 'gst', 'on_request', 'status', 'sort_order', 'image_url',
  'units', 'attrs', 'addons', 'variants', 'rate_sources'
];

async function main() {
  if (SELECTED_CATALOG && !Object.hasOwn(FAMILY, SELECTED_CATALOG)) {
    throw new Error(`Unknown catalog: ${SELECTED_CATALOG}`);
  }
  const dbs = {
    transit: new Database(path.join(DATA, 'transit.db'), { readonly: true }),
    radio: new Database(path.join(DATA, 'radio.db'), { readonly: true }),
    cinema: new Database(path.join(DATA, 'cinema.db'), { readonly: true }),
    other: new Database(path.join(DATA, 'other-masters.db'), { readonly: true })
  };

  console.log('Building city dictionary ...');
  const dict = buildCityDictionary(dbs);
  console.log(`  ${dict.size} known cities\n`);

  const catalogs = [];
  const allProducts = [];
  const allPriceOptions = [];

  const otherCatalogs = dbs.other.prepare('select * from catalogs').all();
  const catalogMeta = new Map(otherCatalogs.map((c) => [c.slug, c]));

  const extracted = {};
  if (!SELECTED_CATALOG || SELECTED_CATALOG === 'transit') extracted.transit = extractTransit(dbs.transit, dict);
  if (!SELECTED_CATALOG || SELECTED_CATALOG === 'radio') extracted.radio = extractRadio(dbs.radio, dict);
  if (!SELECTED_CATALOG || SELECTED_CATALOG === 'cinema') extracted.cinema = extractCinema(dbs.cinema);

  /*
   * 'newspaper' is deliberately absent.
   *
   * Its workbook has a Product sheet and a Location sheet and no Price Option
   * sheet at all -- 552 products, not one rate. Loading it puts inventory in
   * the catalog that can never be quoted, and a search that returns it is
   * worse than one that returns nothing.
   *
   * Its Location rows are still read into the city dictionary above; those are
   * 2,408 real city/state pairs and they help resolve transit and BTL names.
   *
   * Put it back the day the master carries rates.
   */
  for (const slug of ['btl', 'digital', 'digital_pr', 'magazine', 'tv']) {
    if (!SELECTED_CATALOG || SELECTED_CATALOG === slug) {
      extracted[slug] = extractOther(dbs.other, slug, dict);
    }
  }

  for (const [slug, result] of Object.entries(extracted)) {
    const meta = catalogMeta.get(slug);
    catalogs.push({
      slug,
      label: meta?.label || slug,
      family: FAMILY[slug],
      workbook: meta?.workbook || null,
      row_counts: JSON.stringify({
        products: result.products.length,
        price_options: result.priceOptions.length
      })
    });
    allProducts.push(...result.products);
    allPriceOptions.push(...result.priceOptions);
    console.log(
      `${slug.padEnd(11)} ${String(result.products.length).padStart(6)} products  ` +
        `${String(result.priceOptions.length).padStart(6)} price options`
    );
  }

  // A price option inherits its product's media type -- the typed transit
  // import knows it only at product level.
  const mediaByProduct = new Map(allProducts.map((p) => [p.id, p.media_type]));
  for (const po of allPriceOptions) {
    const media = mediaByProduct.get(po.product_id);
    if (media) po.media_type = media;
  }

  const qube = !SELECTED_CATALOG || SELECTED_CATALOG === 'cinema'
    ? dbs.cinema.prepare('select * from qube_rate_card').all() : [];

  console.log(
    `\nTotal: ${allProducts.length} products, ${allPriceOptions.length} price options, ` +
      `${qube.length} qube rate rows`
  );

  const located = allProducts.filter((p) => p.city).length;
  console.log(
    `Location resolved: ${located}/${allProducts.length} ` +
      `(${Math.round((located / allProducts.length) * 100)}%)`
  );

  if (DRY) {
    console.log('\n--dry: nothing written.');
    return;
  }

  console.log('\nLoading into Postgres ...');
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    if (SELECTED_CATALOG) {
      await client.query('DELETE FROM masters.data_quality_issues WHERE catalog=$1', [SELECTED_CATALOG]);
      await client.query('DELETE FROM masters.catalogs WHERE slug=$1', [SELECTED_CATALOG]);
      if (SELECTED_CATALOG === 'cinema') await client.query('TRUNCATE masters.qube_rate_card');
    } else {
      await client.query('TRUNCATE masters.catalogs CASCADE');
      await client.query('TRUNCATE masters.qube_rate_card');
    }

    await insertRows(client, 'masters.catalogs',
      ['slug', 'label', 'family', 'workbook', 'row_counts'], catalogs, 'catalogs');
    await insertRows(client, 'masters.products', PRODUCT_COLUMNS, allProducts, 'products');
    await insertRows(client, 'masters.price_options', PO_COLUMNS, allPriceOptions, 'price_options');
    if (!SELECTED_CATALOG || SELECTED_CATALOG === 'cinema') {
      await insertRows(client, 'masters.qube_rate_card',
        ['source_row', 'section', 'name', 'rate'], qube, 'qube_rate_card');
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  await query('ANALYZE masters.products');
  await query('ANALYZE masters.price_options');

  const check = await query(`
    select catalog, count(*) as products,
           count(*) filter (where city is not null) as with_city
      from masters.products group by catalog order by catalog
  `);
  console.log('\nIn Postgres:');
  console.table(check.rows);
}

main()
  .then(() => close())
  .catch(async (error) => {
    console.error('\nFailed:', error.message);
    console.error(error.stack);
    await close();
    process.exit(1);
  });
