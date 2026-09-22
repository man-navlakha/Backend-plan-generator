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

const { chooseRate, quantityFloor, unitsForBudget } = require('./cost');
const { selectWithModel } = require('./model');

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
  const stated = Number(brief.duration_months);
  if (Number.isFinite(stated) && stated > 0) return Math.trunc(stated);
  if (/train|bus|auto|rickshaw|tricycle|cab|van|metro/.test(mediaType)) return 2;
  return 1;
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

  media.forEach(([mediaType, products], index) => {
    const share = budget * (SPLIT[index] ?? SPLIT[SPLIT.length - 1]);
    const months = monthsFor(mediaType, brief);

    // Most price options on the strongest product in this medium.
    const product = products.reduce((best, p) =>
      (p.price_options?.length || 0) > (best.price_options?.length || 0) ? p : best
    , products[0]);

    const option = bestOption(product, share, months);
    if (!option) {
      reasoning.push(`${mediaType}: no option with a usable rate; skipped.`);
      return;
    }

    const { rate } = chooseRate(option);
    const { floor } = quantityFloor(option);
    let qty = Math.floor(share / (rate * months));

    if (floor !== null && qty < floor) {
      // The floor costs more than the share. Take it anyway if the whole budget
      // covers it -- a medium is either bought properly or not at all.
      const floorCost = rate * floor * months;
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
    const result = selectDeterministic(brief, prefetch);
    if (!isModelConfigured() && options.strategy !== 'deterministic') {
      result.reasoning.unshift(
        'OPENAI_API_KEY is not set, so the deterministic selector ran instead of the model.'
      );
    }
    return result;
  }

  /*
   * Model path. A failure here falls back to the deterministic selector rather
   * than failing the request: a plan built by the simpler strategy is worth far
   * more to the desk than a 500, and the fallback is recorded so nobody mistakes
   * one for the other.
   */
  try {
    const result = await selectWithModel(brief, prefetch, options);
    const checked = validateSelections(result.selections, prefetch);

    if (checked.rejected.length) {
      result.reasoning.push(
        ...checked.rejected.map((r) => `Rejected a selection: ${r.reason}`)
      );
    }

    if (checked.valid.length === 0) {
      const fallback = selectDeterministic(brief, prefetch);
      fallback.reasoning.unshift(
        'The model returned no usable selections; the deterministic selector ran instead.'
      );
      fallback.strategy = 'deterministic_after_model';
      fallback.model_output = result;
      return fallback;
    }

    return { ...result, selections: checked.valid };
  } catch (error) {
    console.error('[select] model selection failed:', error.message);
    const fallback = selectDeterministic(brief, prefetch);
    fallback.reasoning.unshift(
      `Model selection failed (${error.message}); the deterministic selector ran instead.`
    );
    fallback.strategy = 'deterministic_after_error';
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

module.exports = { selectLines, selectDeterministic, validateSelections, isModelConfigured, monthsFor, bestOption };
