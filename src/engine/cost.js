/**
 * Money.
 *
 * Nothing in this file talks to a model, a database or the network. It takes a
 * price option exactly as the catalog stored it, a quantity and a duration, and
 * returns what the line costs. That is the whole job.
 *
 * It is separate from selection on purpose. A model may choose *which* SKU and
 * *how many*; it must never produce a rupee figure. Every number a client sees
 * is computed here from a rate that came out of the master, so any line in any
 * plan can be traced back to a row someone can open.
 *
 * Rounding is to paise at each step and to the rupee only when presenting, so a
 * 250-unit line does not drift the way it would if each unit were rounded.
 */

const DEFAULT_GST = 18;

function round2(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

/**
 * A number, or null when the master held nothing.
 *
 * The null checks are not defensive clutter. `Number(null)` is 0 and
 * `Number('')` is 0, so a plain Number() turns "the master has no buying rate"
 * into "the buying rate is zero" -- which silently passes every margin check,
 * and turns a missing GST into a line billed at 0% tax. The distinction between
 * absent and zero has to survive all the way to the flags.
 */
function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Which rate to quote.
 *
 * The master carries up to three: offer (list), discounted, and the buying rate
 * we pay. The discounted rate is only usable when it still clears what we pay --
 * a discount below the buying rate is a loss, not a discount, and the Lucknow
 * auto line in the demo plan is exactly that case (630 offered against a 650
 * buying rate).
 */
function chooseRate(option, { allowDiscount = true } = {}) {
  const offer = num(option.offer_rate);
  const discounted = num(option.discounted_rate);
  const buying = num(option.buying_rate);

  if (allowDiscount && discounted !== null && discounted > 0) {
    if (buying === null || discounted >= buying) {
      return { rate: discounted, basis: 'discounted', buying };
    }
    return {
      rate: offer,
      basis: 'offer',
      buying,
      note:
        `Discounted rate ${discounted} sits below the buying rate ${buying}; ` +
        'the offer rate was used instead.'
    };
  }

  return { rate: offer, basis: 'offer', buying };
}

/**
 * The quantity floor a price option imposes.
 *
 * Price units carry a minimum ("200 autos or nothing"). Quoting under it
 * produces a plan the vendor will not honour, so the line is lifted and the
 * lift is recorded rather than silently applied.
 */
function quantityFloor(option) {
  const units = Array.isArray(option.units) ? option.units : [];
  let floor = null;
  let unitName = null;
  for (const unit of units) {
    const minimum = num(unit.minimum);
    if (minimum !== null && minimum > 1 && (floor === null || minimum > floor)) {
      floor = minimum;
      unitName = unit.unit || unit.code || null;
    }
  }
  return { floor, unitName };
}

/**
 * Costs one line.
 *
 *   option   a price option row as searchProducts returns it
 *   qty      units (buses, autos, screens, spots)
 *   months   duration multiplier; 1 for media that do not price by month
 *
 * Returns the line in the shape the renderer expects, plus `adjustments`
 * describing anything that changed the arithmetic. The adjustments are what a
 * flag or a desk note is written from -- they are not cosmetic.
 */
function costLine(option, { qty, months = 1, product = {}, allowDiscount = true, addonTotal = null } = {}) {
  const adjustments = [];

  const { rate, basis, buying, note } = chooseRate(option, { allowDiscount });
  if (note) adjustments.push({ type: 'rate_choice', message: note });

  if (rate === null || rate <= 0) {
    return {
      error: 'no_rate',
      message: `Price option "${option.name}" has no usable rate.`,
      sku: option.sku,
      product_name: product.name || null
    };
  }

  // Quantity floor.
  let quantity = Math.max(1, Math.trunc(Number(qty) || 0));
  const { floor, unitName } = quantityFloor(option);
  if (floor !== null && quantity < floor) {
    adjustments.push({
      type: 'quantity_floor',
      message:
        `Quantity raised from ${quantity} to the minimum of ${floor}` +
        `${unitName ? ` ${unitName}` : ''} for "${option.name}".`
    });
    quantity = floor;
  }

  const duration = Math.max(1, Math.trunc(Number(months) || 1));
  const units = quantity * duration;

  let net = round2(rate * units);

  // Minimum billing is a floor on the line, not on the unit rate. When it bites,
  // the sheet must show a rate that still multiplies out to the total, which is
  // what the `rate` resolver in the renderer does off `min_billing_applied`.
  const minimumBilling = num(option.minimum_billing);
  let minBillingApplied = false;
  if (minimumBilling !== null && minimumBilling > net) {
    adjustments.push({
      type: 'minimum_billing',
      message:
        `Line lifted from ${Math.round(net).toLocaleString('en-IN')} to the minimum billing of ` +
        `${Math.round(minimumBilling).toLocaleString('en-IN')} for "${option.name}".`
    });
    net = round2(minimumBilling);
    minBillingApplied = true;
  }

  // Printing, mounting, union charges: a lump on the line, not a per-unit rate.
  const addon = num(addonTotal) ?? addonFromOption(option, quantity);
  if (addon !== null && addon > 0) net = round2(net + addon);

  const gstRate = num(option.gst) ?? DEFAULT_GST;
  const gst = round2((net * gstRate) / 100);

  if (buying !== null && rate < buying) {
    adjustments.push({
      type: 'below_buying',
      severity: 'block',
      message: `Quoted rate ${rate} is below the buying rate ${buying}. This line loses money.`
    });
  }
  if (buying === null) {
    adjustments.push({
      type: 'margin_unknown',
      severity: 'warn',
      message: `No buying rate in the master for "${option.name}"; margin cannot be checked.`
    });
  }

  return {
    // Fields the renderer and its resolvers read.
    product_name: product.name || option.product_name || null,
    sku: option.sku,
    state: product.state || null,
    market: product.city || null,
    price_option: option.name,
    qty: quantity,
    months: duration,
    rate,
    addon_total: addon,
    minimum_billing: minimumBilling,
    buying_rate: buying,
    net,
    gst,
    total: round2(net + gst),

    // Provenance, kept so a plan can be audited without re-querying.
    price_option_id: option.id,
    product_id: product.id ?? null,
    pricing_unit: option.pricing_unit || null,
    rate_basis: basis,
    gst_rate: gstRate,
    min_billing_applied: minBillingApplied,
    adjustments
  };
}

/**
 * An add-on the master prices per unit (printing at so much a square foot).
 * Returns null when the master holds nothing -- which is common, and is a gap
 * the plan should flag rather than a zero it should assume.
 */
function addonFromOption(option, quantity) {
  const addons = Array.isArray(option.addons) ? option.addons : [];
  let total = 0;
  let found = false;
  for (const addon of addons) {
    const price = num(addon.modify_price);
    if (price === null || price === 0) continue;
    found = true;
    total += /per/i.test(addon.modify_type || '') ? price * quantity : price;
  }
  return found ? round2(total) : null;
}

/** Totals across every line in a plan, with reserves counted against budget. */
function totalPlan(legs, reserves = []) {
  let net = 0;
  let gst = 0;
  for (const leg of legs) {
    for (const line of leg.lines || []) {
      net += Number(line.net) || 0;
      gst += Number(line.gst) || 0;
    }
  }
  const reserveTotal = reserves.reduce((sum, r) => sum + (Number(r.amount) || 0), 0);
  return {
    net: round2(net),
    gst: round2(gst),
    reserves: round2(reserveTotal),
    total: round2(net + gst + reserveTotal)
  };
}

/**
 * How many units of `option` a budget buys, respecting the quantity floor.
 * Used by the deterministic selector; a model-driven selector would pass its
 * own quantity and this would only sanity-check it.
 */
function unitsForBudget(option, budget, months = 1) {
  const { rate } = chooseRate(option);
  if (!rate || rate <= 0) return 0;
  const { floor } = quantityFloor(option);
  const affordable = Math.floor(Number(budget) / (rate * Math.max(1, months)));
  if (floor !== null && affordable < floor) return 0; // cannot meet the floor
  return Math.max(0, affordable);
}

module.exports = {
  costLine,
  totalPlan,
  chooseRate,
  quantityFloor,
  unitsForBudget,
  round2,
  DEFAULT_GST
};
