/**
 * Reading the unified master.
 *
 * These are the functions the model will eventually reach through tool calls,
 * but nothing here knows that. They are plain catalog queries -- a route, a
 * script or the prefetch step can call them just as well.
 *
 * Two rules hold throughout:
 *
 *   1. A product is only returned with its price options attached. A rate
 *      without its unit, its minimum billing and the spec it belongs to is not
 *      quotable, and handing back half of one invites a plan that quotes the
 *      other half.
 *   2. Nothing unpriced comes back by default. Plenty of rows carry a product
 *      and no rate; returning them would look like inventory. The newspaper
 *      master was the extreme case -- 552 products, zero rates -- and is now
 *      left out of the import entirely.
 */

const { rows, one } = require('../pg');

const DEFAULT_LIMIT = 40;
const MAX_LIMIT = 500;
const OPTIONS_PER_PRODUCT = 6;

/** Always an array of trimmed strings, whatever the caller passed. */
function list(value) {
  if (value === null || value === undefined) return null;
  const arr = Array.isArray(value) ? value : [value];
  const cleaned = arr.map((v) => String(v).trim()).filter(Boolean);
  return cleaned.length ? cleaned : null;
}

function lower(value) {
  const arr = list(value);
  return arr ? arr.map((v) => v.toLowerCase()) : null;
}

function clamp(value, fallback, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.trunc(n), max);
}

/**
 * The price options attached to each returned product, as a JSON array.
 *
 * Built as a correlated subquery rather than a join so the outer LIMIT counts
 * products, not product-option pairs -- asking for 40 results should give 40
 * products, not 40 rows that turn out to be six products.
 */
function optionsSubquery({ filtered = true, limit = OPTIONS_PER_PRODUCT } = {}) {
  // getProduct wants every option, unfiltered; search wants the cheapest few
  // that survive the caller's rate ceiling.
  const conditions = filtered
    ? `and (not $priced_only or (po.offer_rate is not null and po.offer_rate > 0))
           and ($max_rate::numeric is null or po.offer_rate <= $max_rate::numeric)
           and ($min_rate::numeric is null or po.offer_rate >= $min_rate::numeric)`
    : '';

  return `
  (
    select coalesce(json_agg(o order by o.offer_rate), '[]'::json)
      from (
        select po.id, po.sku, po.name, po.template, po.offer_rate, po.buying_rate,
               po.discounted_rate, po.minimum_billing, po.pricing_unit,
               po.gst, po.on_request, po.attrs, po.units, po.addons
          from masters.price_options po
         where po.product_id = p.id
           and po.status = 1
           ${conditions}
         order by po.offer_rate nulls last
         limit ${limit}
      ) o
  ) as price_options`;
}

/**
 * Finds products.
 *
 * `q` is matched two ways at once: a trigram similarity that survives typos and
 * word order, and a plain substring match for when the caller already knows the
 * exact name. Both ride the same GIN index. Filters are all optional and all
 * AND-ed; passing none returns the highest-inventory products first.
 *
 *   searchProducts({ q: 'auto branding', city: 'Lucknow', maxRate: 1000 })
 */
async function searchProducts(params = {}) {
  const q = params.q ? String(params.q).trim() : null;
  const limit = clamp(params.limit, DEFAULT_LIMIT, MAX_LIMIT);
  const optionsPerProduct = clamp(params.optionsPerProduct, OPTIONS_PER_PRODUCT, 200);
  const pricedOnly = params.pricedOnly !== false;

  const args = {
    q,
    media: list(params.mediaType),
    family: list(params.family),
    city: lower(params.city),
    state: lower(params.state),
    max_rate: params.maxRate ?? null,
    min_rate: params.minRate ?? null,
    priced_only: pricedOnly,
    limit
  };

  // Named placeholders keep the subquery above readable; pg wants positional,
  // so they are swapped out here in one place.
  const order = q
    ? 'score desc, priced_options desc, p.sort_order nulls last'
    : 'priced_options desc, p.sort_order nulls last, p.id';

  const sql = `
    select p.id, p.sku, p.name, p.media_type, p.media_label, p.family, p.catalog,
           p.city, p.state, p.locality, p.location_source, p.attrs, p.image_url,
           ${q ? 'greatest(similarity(p.search_text, $q), word_similarity($q, p.search_text))' : '0'} as score,
           (select count(*) from masters.price_options po
             where po.product_id = p.id and po.status = 1
               and po.offer_rate is not null and po.offer_rate > 0) as priced_options,
           ${optionsSubquery({ limit: optionsPerProduct })}
      from masters.products p
     where p.status = 1
       and ($media::text[]  is null or p.media_type = any($media::text[]))
       and ($family::text[] is null or p.family     = any($family::text[]))
       and ($city::text[]   is null or lower(p.city)  = any($city::text[]))
       and ($state::text[]  is null or lower(p.state) = any($state::text[]))
       ${q ? 'and (p.search_text % $q or p.search_text ilike $q_like)' : ''}
       and (
         not $priced_only
         or exists (
           select 1 from masters.price_options po
            where po.product_id = p.id and po.status = 1
              and po.offer_rate is not null and po.offer_rate > 0
              and ($max_rate::numeric is null or po.offer_rate <= $max_rate::numeric)
              and ($min_rate::numeric is null or po.offer_rate >= $min_rate::numeric)
         )
       )
     order by ${order}
     limit $limit
  `;

  return runNamed(sql, { ...args, q_like: q ? `%${q}%` : null });
}

/** One product with every price option it has, priced or not. */
async function getProduct(id) {
  const product = await one(
    `select p.*, ${optionsSubquery({ filtered: false, limit: 200 })}
       from masters.products p
      where p.id = $1`,
    [id]
  );
  return product || null;
}

/** Price options for a product, unfiltered -- the detail call after a search. */
async function getPriceOptions(productId) {
  return rows(
    `select po.*, p.name as product_name, p.city, p.state, p.media_type
       from masters.price_options po
       join masters.products p on p.id = po.product_id
      where po.product_id = $1 and po.status = 1
      order by po.offer_rate nulls last`,
    [productId]
  );
}

/** Which cities actually carry this medium -- used before promising coverage. */
async function citiesForMedia(mediaType, limit = 500) {
  return rows(
    `select p.city, p.state, count(distinct p.id) as products,
            min(po.offer_rate) as from_rate, max(po.offer_rate) as to_rate
       from masters.products p
       join masters.price_options po on po.product_id = p.id
      where p.media_type = any($1::text[]) and p.city is not null
        and po.offer_rate > 0 and p.status = 1
      group by p.city, p.state
      order by products desc
      limit $2`,
    [list(mediaType), limit]
  );
}

/** Every media type with priced inventory, for discovery and validation. */
async function listMediaTypes() {
  return rows(`
    select p.media_type, p.family, max(p.media_label) as label,
           count(distinct p.id) as products,
           count(distinct p.city) filter (where p.city is not null) as cities,
           count(po.id) as priced_options,
           min(po.offer_rate) as from_rate, max(po.offer_rate) as to_rate
      from masters.products p
      join masters.price_options po
        on po.product_id = p.id and po.offer_rate > 0 and po.status = 1
     where p.status = 1
     group by p.media_type, p.family
     order by priced_options desc
  `);
}

/**
 * Runs a query written with $name placeholders.
 *
 * Postgres only takes $1, $2 ... and the queries above are long enough that
 * counting positions by hand would be the first thing to break when a filter is
 * added. Longest names are substituted first so $max_rate is not eaten by a
 * prefix of $max.
 */
async function runNamed(sql, params) {
  const values = [];
  const seen = new Map();
  const names = Object.keys(params).sort((a, b) => b.length - a.length);

  let text = sql;
  for (const name of names) {
    const pattern = new RegExp(`\\$${name}\\b`, 'g');
    if (!pattern.test(text)) continue;
    if (!seen.has(name)) {
      values.push(params[name]);
      seen.set(name, values.length);
    }
    text = text.replace(new RegExp(`\\$${name}\\b`, 'g'), `$${seen.get(name)}`);
  }

  return rows(text, values);
}

module.exports = {
  searchProducts,
  getProduct,
  getPriceOptions,
  citiesForMedia,
  listMediaTypes,
  DEFAULT_LIMIT,
  MAX_LIMIT
};
