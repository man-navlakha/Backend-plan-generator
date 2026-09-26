/**
 * Choosing what goes in the plan.
 *
 * This is the one step a model is meant to do: read the brief and the
 * shortlist, and say which SKUs, how many units, for how long. It returns
 * selections only -- {price_option_id, qty, months} -- never money. Costing
 * happens afterwards in cost.js from rates that came out of the master.
 *
 * Until OPENAI_API_KEY is set, `selectLines` falls back to a deterministic
 * strategy. That is not a placeholder to be embarrassed about: it makes the
 * whole pipeline runnable and testable today, and it is the baseline a model
 * has to beat. If the model's plan is worse than this, that is worth knowing.
 */

const { chooseRate, quantityFloor, unitsForBudget, costLine } = require('./cost');
const { isInventory } = require('./mode');
const { selectWithModel, MODEL } = require('./model');
const { loadRules } = require('../rules');
const log = require('../log');

// How the budget is split when a brief covers several media. Front-loading the
// first medium reflects how the desk actually buys: one medium carries the
// campaign and the rest add reach.
const SPLIT = [0.55, 0.25, 0.12, 0.08];

function isModelConfigured() {
  return Boolean(process.env.OPENAI_API_KEY);
}

/**
 * Picks the strongest price option for a product.
 *
 * "Strongest" means the dearest option that the budget can still buy a sensible
 * quantity of -- a plan built from the cheapest option of everything reads as a
 * cheap plan, and the desk will not send it.
 */
function bestOption(product, budget, months) {
  const options = (product.price_options || []).filter((o) => {
    const { rate } = chooseRate(o);
    return rate !== null && rate > 0;
  });
  if (options.length === 0) return null;

  const affordable = options.filter((o) => unitsForBudget(o, budget, months) >= 1);
  const pool = affordable.length ? affordable : options;

  return pool.reduce((best, option) => {
    const { rate } = chooseRate(option);
    const { rate: bestRate } = chooseRate(best);
    return rate > bestRate ? option : best;
  }, pool[0]);
}

/**
 * Duration for a medium, in months.
 *
 * Outdoor and transit work on repeat exposure and are not worth buying for less
 * than two months; broadcast and digital are bought by the burst. The brief can
 * override with `duration_months`.
 */
function monthsFor(mediaType, brief) {
  const weeks = Number(brief.duration_weeks);
  if (/cinema/.test(mediaType) && Number.isFinite(weeks) && weeks > 0) {
    return Math.trunc(weeks);
  }
  const stated = Number(brief.duration_months);
  if (Number.isFinite(stated) && stated > 0) return Math.trunc(stated);
  if (/train|bus|auto|rickshaw|tricycle|cab|van|metro/.test(mediaType)) return 2;
  return 1;
}

function cinemaCreativePreference(brief = {}) {
  const text = [brief.remarks_for_media, brief.client_brief].filter(Boolean).join(' ').toLowerCase();
  if (/creative(?:\s+type)?[^:\n.]*[:\-]\s*(?:feature\s+)?video\b/.test(text)) return 'video';
  if (/creative(?:\s+type)?[^:\n.]*[:\-]\s*(?:slide\s*show|slide|static)\b/.test(text)) return 'slide';
  if (/\b(?:video|ad\s*film)\b/.test(text)) return 'video';
  if (/\b(?:slide\s*show|slide|static)\b/.test(text)) return 'slide';
  return null;
}

function cinemaScreenKey(product, option) {
  const match = /\bSCREEN[-_\s]*(\d+)/i.exec(option?.name || option?.sku || '');
  return match ? `${product.id}:${match[1]}` : `${product.id}:${option.id}`;
}

function cinemaFormatScore(option, preference) {
  const text = `${option?.template || ''} ${option?.name || ''} ${option?.sku || ''}`.toLowerCase();
  const video = /ad\s*film|adfilm|video/.test(text);
  const slide = /slide|static/.test(text);
  if (preference === 'video') return video ? 3 : slide ? 0 : 1;
  if (preference === 'slide') return slide ? 3 : video ? 0 : 1;
  return video ? 2 : slide ? 1 : 0;
}

function cinemaProductionGross() {
  const billing = loadRules('Cinema').billing || {};
  const net = (Number(billing.making_conversion_cost_per_creative) || 0) *
    Math.max(1, Math.trunc(Number(billing.default_creatives) || 1));
  return net * (1 + (Number(billing.gst_rate) || 18) / 100);
}

function cinemaPreferenceScore(product, brief, modelScreens, screen) {
  let score = modelScreens.has(screen) ? 1000 : 0;
  const productText = `${product.name || ''} ${product.locality || ''} ` +
    `${product.attrs?.cinema_chain || ''}`.toLowerCase();
  const requestedText = [
    ...(brief.preferred_catchments || []),
    brief.remarks_for_media,
    brief.client_brief
  ].filter(Boolean).join(' ').toLowerCase();

  for (const chain of ['pvr', 'inox', 'cinepolis', 'miraj']) {
    if (requestedText.includes(chain) && productText.includes(chain)) score += 80;
  }
  for (const catchment of brief.preferred_catchments || []) {
    const words = String(catchment).toLowerCase().match(/[a-z0-9]+/g) || [];
    score += words.filter((word) => word.length >= 4 && productText.includes(word)).length * 12;
  }
  if (/icon|platinum/i.test(product.attrs?.audience_class || '')) score += 8;
  else if (/gold/i.test(product.attrs?.audience_class || '')) score += 4;
  return score;
}

/**
 * A server-checked Cinema recommendation.
 *
 * The model supplies judgement and ranking, but its rough arithmetic can miss
 * minimum billing or omit a requested city. Build a balanced set from the same
 * shortlist, giving the model's screens first preference, then stop below the
 * GST-inclusive budget after reserving the mandatory production charge.
 */
function selectBalancedCinema(brief, prefetch, modelSelections = []) {
  const budget = Number(brief.budget) || 0;
  if (budget <= 0) return null;
  const products = (prefetch.candidates || []).filter((product) =>
    /cinema/.test(String(product.media_type || '').toLowerCase())
  );
  if (!products.length || products.length !== (prefetch.candidates || []).length) return null;

  const byProduct = new Map(products.map((product) => [Number(product.id), product]));
  const modelScreens = new Set();
  for (const pick of modelSelections || []) {
    const product = byProduct.get(Number(pick.product_id));
    const option = product?.price_options?.find((item) => Number(item.id) === Number(pick.price_option_id));
    if (product && option) modelScreens.add(cinemaScreenKey(product, option));
  }

  const preference = cinemaCreativePreference(brief);
  const qty = Math.max(1, Math.trunc(Number(brief.creative_duration_seconds) || 10));
  const candidates = [];
  for (const product of products) {
    const grouped = new Map();
    for (const option of product.price_options || []) {
      const key = cinemaScreenKey(product, option);
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(option);
    }
    for (const [screen, options] of grouped) {
      const option = [...options].sort((a, b) => {
        const format = cinemaFormatScore(b, preference) - cinemaFormatScore(a, preference);
        if (format) return format;
        return (chooseRate(a).rate || Infinity) - (chooseRate(b).rate || Infinity);
      })[0];
      const months = monthsFor(product.media_type, brief);
      const line = costLine(option, { qty, months, product });
      if (line.error) continue;
      candidates.push({
        product,
        option,
        screen,
        gross: Number(line.total) || 0,
        score: cinemaPreferenceScore(product, brief, modelScreens, screen),
        pick: {
          product_id: Number(product.id),
          price_option_id: Number(option.id),
          media_type: product.media_type,
          qty,
          months,
          why: 'Balanced Cinema recommendation across the client requested locations.'
        }
      });
    }
  }

  const resolved = (prefetch.locations || []).filter((location) => location.match !== 'none');
  const marketCity = (value) => String(value || '').toLowerCase().replace(/^gurgaon$/, 'gurugram');
  const locationKey = (location) => `${marketCity(location.city)}|${String(location.state || '').toLowerCase()}`;
  const candidateLocation = (candidate) => `${marketCity(candidate.product.city)}|${String(candidate.product.state || '').toLowerCase()}`;
  const pools = resolved.map((location) => ({
    location,
    candidates: candidates
      .filter((candidate) => {
        if (location.city && marketCity(candidate.product.city) !== marketCity(location.city)) return false;
        if (location.state && String(candidate.product.state).toLowerCase() !== String(location.state).toLowerCase()) return false;
        return true;
      })
      .sort((a, b) => b.score - a.score || a.gross - b.gross)
  }));
  if (!pools.length) {
    pools.push({ location: null, candidates: [...candidates].sort((a, b) => b.score - a.score || a.gross - b.gross) });
  }

  const selected = [];
  const used = new Set();
  let gross = cinemaProductionGross();
  const ceiling = budget * 0.97;
  const addFirstFitting = (pool, required = false) => {
    const ordered = required
      ? [...pool.candidates].sort((a, b) => a.gross - b.gross || b.score - a.score)
      : pool.candidates;
    const candidate = ordered.find((item) =>
      !used.has(item.screen) && gross + item.gross <= (required ? budget : ceiling)
    );
    if (!candidate) return false;
    used.add(candidate.screen);
    selected.push(candidate);
    gross += candidate.gross;
    return true;
  };

  // First guarantee one affordable screen in every requested city.
  for (const pool of pools) addFirstFitting(pool, true);

  // Then add a round-robin spread so one large market cannot consume the plan.
  let added = true;
  while (added) {
    added = false;
    for (const pool of pools) {
      if (addFirstFitting(pool)) added = true;
    }
  }

  if (!selected.length) return null;
  const covered = new Set(selected.map(candidateLocation));
  const missing = pools
    .filter((pool) => pool.location && !covered.has(locationKey(pool.location)))
    .map((pool) => pool.location.requested);
  const reasoning = [
    `Server-balanced Cinema recommendation: ${selected.length} screen(s), including mandatory production charges, within the GST-inclusive budget.`,
    ...(missing.length ? [`Budget could not cover a screen in: ${missing.join(', ')}.`] : [])
  ];
  return { selections: selected.map((candidate) => candidate.pick), reasoning };
}

/**
 * The deterministic selector.
 *
 * One product per medium, the best option on it, quantity sized to that
 * medium's slice of the budget. Deliberately simple and deliberately
 * explainable -- every choice here can be stated in one sentence, which is what
 * makes it a usable baseline.
 */
function selectDeterministic(brief, prefetch) {
  const byMedia = new Map();
  for (const product of prefetch.candidates) {
    if (!byMedia.has(product.media_type)) byMedia.set(product.media_type, []);
    byMedia.get(product.media_type).push(product);
  }

  // Media with the deepest inventory first -- that is where the plan has room.
  const media = [...byMedia.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, SPLIT.length);

  const budget = Number(brief.budget) || 0;
  const selections = [];
  const reasoning = [];
  const activeWeight = media.reduce(
    (sum, _entry, index) => sum + (SPLIT[index] ?? SPLIT[SPLIT.length - 1]),
    0
  );

  media.forEach(([mediaType, products], index) => {
    // SPLIT describes relative priority. Normalise it over the media that are
    // actually present so one-medium plans receive the whole budget instead
    // of only the first 55%, and two-medium plans do not strand the last 20%.
    const weight = SPLIT[index] ?? SPLIT[SPLIT.length - 1];
    const share = activeWeight > 0 ? budget * (weight / activeWeight) : 0;
    const months = monthsFor(mediaType, brief);

    // Prefer the highest-value option whose minimum purchasable quantity fits
    // the GST-inclusive share. This matters for Magazine, where each title
    // commonly has one option and the first catalog row may cost more than the
    // share even though many suitable titles are affordable.
    const affordable = [];
    for (const product of products) {
      for (const candidate of product.price_options || []) {
        const { rate: candidateRate } = chooseRate(candidate);
        if (!candidateRate || candidateRate <= 0) continue;
        const { floor: candidateFloor } = quantityFloor(candidate);
        const creativeQty = /cinema/.test(mediaType)
          ? Math.max(1, Math.trunc(Number(brief.creative_duration_seconds) || 10))
          : 1;
        const minimumQty = Math.max(candidateFloor || 1, creativeQty);
        const gst = candidate.gst === null || candidate.gst === undefined || candidate.gst === ''
          ? 18
          : Number(candidate.gst);
        const grossFactor = 1 + (Number.isFinite(gst) ? gst : 18) / 100;
        const minimumCost = candidateRate * months * minimumQty * grossFactor;
        if (minimumCost <= share) affordable.push({ product, option: candidate, rate: candidateRate });
      }
    }
    const choice = affordable.reduce(
      (best, candidate) => !best || candidate.rate > best.rate ? candidate : best,
      null
    );
    const product = choice?.product || products.reduce((best, p) =>
      (p.price_options?.length || 0) > (best.price_options?.length || 0) ? p : best
    , products[0]);
    const option = choice?.option || bestOption(product, share, months);
    if (!option) {
      reasoning.push(`${mediaType}: no option with a usable rate; skipped.`);
      return;
    }

    const { rate } = chooseRate(option);
    const { floor } = quantityFloor(option);
    const gst = option.gst === null || option.gst === undefined || option.gst === ''
      ? 18
      : Number(option.gst);
    const grossFactor = 1 + (Number.isFinite(gst) ? gst : 18) / 100;
    let qty = Math.floor(share / (rate * months * grossFactor));

    // Cinema quantity is creative seconds, not a scalable inventory count.
    // The renderer and server billing boundary use the approved 10-second
    // default unless the brief explicitly states a different creative length.
    if (/cinema/.test(mediaType)) {
      qty = Math.max(1, Math.trunc(Number(brief.creative_duration_seconds) || 10));
    }

    if (floor !== null && qty < floor) {
      // The floor costs more than the share. Take it anyway if the whole budget
      // covers it -- a medium is either bought properly or not at all.
      const floorCost = rate * floor * months * grossFactor;
      if (floorCost <= budget) {
        qty = floor;
        reasoning.push(
          `${mediaType}: raised to the ${floor}-unit minimum, which costs more than its budget share.`
        );
      } else {
        reasoning.push(
          `${mediaType}: the ${floor}-unit minimum costs more than the whole budget; skipped.`
        );
        return;
      }
    }

    if (qty < 1) {
      reasoning.push(`${mediaType}: budget share does not buy a single unit; skipped.`);
      return;
    }

    selections.push({
      product_id: product.id,
      price_option_id: option.id,
      media_type: mediaType,
      qty,
      months,
      why:
        `${qty} x ${option.name} at ${rate}/${option.pricing_unit || 'unit'}` +
        `${months > 1 ? ` for ${months} months` : ''}, sized to ${Math.round(share).toLocaleString('en-IN')} ` +
        `of the ${Math.round(budget).toLocaleString('en-IN')} budget.`
    });
  });

  return { selections, reasoning, strategy: 'deterministic' };
}

/**
 * The no-budget baseline: list what matches, do not choose between it.
 *
 * Used when the model is unavailable or its answer was unusable. It cannot
 * curate the way the model does, so it does the one honest thing a rule can do
 * -- take every priced option, nearest the top of the shortlist first, up to a
 * cap that keeps the sheet readable. The desk trims. Silently dropping venues
 * by some invented measure of quality would be worse than a long list.
 */
const INVENTORY_ROW_CAP = Number(process.env.PLAN_INVENTORY_ROW_CAP || 180);

function selectInventory(brief, prefetch) {
  const selections = [];
  const reasoning = [];
  let skippedUnpriced = 0;

  for (const product of prefetch.candidates) {
    const months = monthsFor(product.media_type, brief);
    const qty = /cinema/.test(product.media_type)
      ? Math.max(1, Math.trunc(Number(brief.creative_duration_seconds) || 10))
      : 1;

    for (const option of product.price_options || []) {
      if (selections.length >= INVENTORY_ROW_CAP) break;
      const { rate } = chooseRate(option);
      if (!rate || rate <= 0) { skippedUnpriced += 1; continue; }
      selections.push({
        product_id: product.id,
        price_option_id: option.id,
        media_type: product.media_type,
        qty,
        months,
        why: `Listed as available inventory: ${product.name} - ${option.name}.`
      });
    }
    if (selections.length >= INVENTORY_ROW_CAP) {
      reasoning.push(
        `Listing stopped at the ${INVENTORY_ROW_CAP}-row cap; the shortlist holds more inventory than that.`
      );
      break;
    }
  }

  if (skippedUnpriced) {
    reasoning.push(`${skippedUnpriced} option(s) were left out because the master carries no rate for them.`);
  }
  reasoning.push(`No budget was stated, so ${selections.length} matching screen(s) are listed with their rates rather than bought.`);

  return { selections, reasoning, strategy: 'inventory' };
}

/** The rule-based selector appropriate to the brief's mode. */
function selectWithoutModel(brief, prefetch) {
  if (isInventory(brief)) return selectInventory(brief, prefetch);
  const cinema = selectBalancedCinema(brief, prefetch);
  if (cinema) return { ...cinema, strategy: 'deterministic_cinema' };
  return selectDeterministic(brief, prefetch);
}

/**
 * Chooses the lines for a plan.
 *
 * Model-backed selection lands here when OPENAI_API_KEY is present; the
 * signature and the return shape are already what that call will produce, so
 * wiring it in does not disturb anything downstream.
 */
async function selectLines(brief, prefetch, options = {}) {
  if (prefetch.candidates.length === 0) {
    return {
      selections: [],
      reasoning: ['Prefetch returned no candidates; there is nothing to select from.'],
      strategy: 'none'
    };
  }

  if (options.strategy === 'deterministic' || !isModelConfigured()) {
    const started = Date.now();
    const result = selectWithoutModel(brief, prefetch);
    if (!isModelConfigured() && options.strategy !== 'deterministic') {
      result.reasoning.unshift(
        'OPENAI_API_KEY is not set, so the deterministic selector ran instead of the model.'
      );
    }
    log.info('selection.deterministic.completed', {
      strategy: result.strategy,
      candidate_count: prefetch.candidates.length,
      selection_count: result.selections.length,
      duration_ms: Date.now() - started
    });
    return result;
  }

  /*
   * Model path. A failure here falls back to the deterministic selector rather
   * than failing the request: a plan built by the simpler strategy is worth far
   * more to the desk than a 500, and the fallback is recorded so nobody mistakes
   * one for the other.
  */
  const started = Date.now();
  log.info('selection.model.started', {
    model: MODEL,
    candidate_count: prefetch.candidates.length,
    inventory_mode: isInventory(brief)
  });
  try {
    const result = await selectWithModel(brief, prefetch, options);
    const checked = validateSelections(result.selections, prefetch);

    log.info('selection.model.completed', {
      model: result.model || MODEL,
      proposed_count: result.selections.length,
      valid_count: checked.valid.length,
      rejected_count: checked.rejected.length,
      tool_call_count: (result.tool_calls || []).length,
      prompt_tokens: result.usage?.prompt_tokens || 0,
      completion_tokens: result.usage?.completion_tokens || 0,
      duration_ms: Date.now() - started
    });

    if (checked.rejected.length) {
      result.reasoning.push(
        ...checked.rejected.map((r) => `Rejected a selection: ${r.reason}`)
      );
    }

    if (checked.valid.length === 0) {
      const fallback = selectWithoutModel(brief, prefetch);
      fallback.reasoning.unshift(
        'The model returned no usable selections; the deterministic selector ran instead.'
      );
      fallback.strategy = 'deterministic_after_model';
      fallback.model_output = result;
      log.warn('selection.model.fallback', {
        reason: 'no_usable_selections',
        fallback_selection_count: fallback.selections.length
      });
      return fallback;
    }

    const cinema = selectBalancedCinema(brief, prefetch, checked.valid);
    if (cinema) {
      return {
        ...result,
        selections: cinema.selections,
        reasoning: [...result.reasoning, ...cinema.reasoning]
      };
    }

    return { ...result, selections: checked.valid };
  } catch (error) {
    log.error('selection.model.failed', {
      model: MODEL,
      duration_ms: Date.now() - started,
      error: log.errorDetails(error)
    });
    const fallback = selectWithoutModel(brief, prefetch);
    fallback.reasoning.unshift(
      `Model selection failed (${error.message}); the deterministic selector ran instead.`
    );
    fallback.strategy = 'deterministic_after_error';
    log.warn('selection.model.fallback', {
      reason: 'model_error',
      fallback_selection_count: fallback.selections.length
    });
    return fallback;
  }
}

/**
 * Keeps only selections that name a real price option on a real product.
 *
 * The model is told to use ids from the shortlist and the tool results, and it
 * largely does -- but an id it invented would otherwise become a line in a
 * client quotation, so every one is checked. A selection is also rejected when
 * its price option belongs to a different product than it claims: that pairing
 * would cost the right rate against the wrong inventory.
 *
 * Ids from tool results are not in the shortlist, so anything unrecognised is
 * held for a catalog lookup rather than rejected outright.
 */
function validateSelections(selections, prefetch) {
  const shortlist = new Map();
  for (const product of prefetch.candidates) {
    shortlist.set(product.id, new Set((product.price_options || []).map((o) => o.id)));
  }

  const valid = [];
  const rejected = [];

  for (const pick of selections || []) {
    const productId = Number(pick.product_id);
    const optionId = Number(pick.price_option_id);
    const qty = Math.trunc(Number(pick.qty));
    const months = Math.trunc(Number(pick.months) || 1);

    if (!Number.isFinite(productId) || !Number.isFinite(optionId)) {
      rejected.push({ pick, reason: 'product_id or price_option_id is not a number.' });
      continue;
    }
    if (!Number.isFinite(qty) || qty < 1) {
      rejected.push({ pick, reason: `quantity ${pick.qty} is not a positive whole number.` });
      continue;
    }

    const known = shortlist.get(productId);
    if (known && !known.has(optionId)) {
      rejected.push({
        pick,
        reason: `price option ${optionId} does not belong to product ${productId}.`
      });
      continue;
    }

    // Unknown product ids came from a tool result; build.js re-reads every
    // selection from the catalog before costing it, and drops what is not there.
    valid.push({
      product_id: productId,
      price_option_id: optionId,
      media_type: pick.media_type || null,
      qty,
      months: months > 0 ? months : 1,
      why: pick.why || null,
      from_shortlist: Boolean(known)
    });
  }

  return { valid, rejected };
}

module.exports = {
  selectLines,
  selectDeterministic,
  selectBalancedCinema,
  validateSelections,
  isModelConfigured,
  monthsFor,
  bestOption
};
