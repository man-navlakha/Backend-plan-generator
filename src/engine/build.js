/**
 * Brief in, plan out.
 *
 *   prefetch  -> shortlist from the catalog
 *   select    -> which SKUs, how many, how long   (model's job)
 *   cost      -> what that costs                  (never the model's job)
 *   evaluate  -> what is wrong with the result    (rules engine)
 *
 * The object this returns is the same shape scripts/render-demo-plan.js builds
 * by hand. That fixture was written before the engine existed precisely so the
 * renderer would not have to change when the engine arrived, and it has not.
 *
 * A plan with blocking flags is still returned. The desk would rather have a
 * priced plan that names its five problems than no plan at all -- and a plan
 * that quietly dropped the problems would be worse than both.
 */

const { prefetchForBrief } = require('../catalog/prefetch');
const { getProduct } = require('../catalog/search');
const { selectLines } = require('./select');
const { costLine, totalPlan, round2 } = require('./cost');
const { loadRules } = require('../rules');
const { applyConstraints } = require('../rules/evaluate');
const formatIndex = require('../assets/formats/format_index.json');

/** Slug -> the display name the renderer's format specs are keyed by. */
const DISPLAY_NAME = new Map();
for (const [name, meta] of Object.entries(formatIndex.media_types)) {
  DISPLAY_NAME.set(meta.slug, name);
}

function displayName(mediaType) {
  return DISPLAY_NAME.get(mediaType) || mediaType;
}

/**
 * What the duration multiplier is actually counting.
 *
 * `months` is a generic multiplier on the rate, but the rate is not always per
 * month. Cinema sells per week per second, radio per second, some BTL per day.
 * Labelling a five-week cinema buy "5 Months" puts a number in front of a
 * client that is wrong by a factor of four, so the label follows the pricing
 * unit the master stated rather than assuming months.
 */
function durationLabel(count, pricingUnit) {
  const unit = String(pricingUnit || '').toLowerCase();
  const plural = (word) => (count > 1 ? `${count} ${word}s` : `1 ${word}`);

  if (/week/.test(unit)) return plural('Week');
  if (/\bday/.test(unit)) return plural('Day');
  if (/month/.test(unit)) return plural('Month');
  // No duration in the unit at all (per bus, per auto, per ATM): the master
  // prices the placement and the multiplier is months by convention.
  return plural('Month');
}

/**
 * Builds a plan.
 *
 * `brief` is the parsed brief from /brief. Everything else is optional and
 * exists for testing: `strategy` forces the deterministic selector, `prefetch`
 * lets a caller supply a shortlist it already has.
 */
async function buildPlan(brief, options = {}) {
  const started = Date.now();
  const trace = [];

  // 1. Shortlist.
  const prefetch = options.prefetch || (await prefetchForBrief(brief));
  trace.push({
    step: 'prefetch',
    products: prefetch.stats.products,
    price_options: prefetch.stats.price_options,
    ms: Date.now() - started
  });

  if (prefetch.candidates.length === 0) {
    return {
      status: 'blocked',
      plan: null,
      flags: [
        {
          severity: 'block',
          id: 'catalog.no_inventory',
          message:
            `Nothing in the catalog matches this brief (${brief.service}` +
            `${brief.target_locations?.length ? ` in ${brief.target_locations.join(', ')}` : ''}).`,
          source: 'prefetch'
        }
      ],
      notes: prefetch.notes,
      trace
    };
  }

  // 2. Selection -- the only step that may be a model.
  const selection = await selectLines(brief, prefetch, options);
  trace.push({ step: 'select', strategy: selection.strategy, lines: selection.selections.length });

  if (selection.selections.length === 0) {
    return {
      status: 'blocked',
      plan: null,
      flags: [
        {
          severity: 'block',
          id: 'engine.nothing_selected',
          message: 'The catalog had inventory but nothing could be selected within the budget.',
          source: selection.strategy
        }
      ],
      notes: [...prefetch.notes, ...selection.reasoning],
      trace
    };
  }

  // 3. Costing. Selections carry ids; the rows are re-read from the catalog so
  //    a rate can never arrive from anywhere but the master.
  const byMedia = new Map();
  const flags = [];
  const deskActions = [];

  for (const pick of selection.selections) {
    const product = await getProduct(pick.product_id);
    const option = product?.price_options?.find((o) => o.id === pick.price_option_id);

    if (!product || !option) {
      flags.push({
        severity: 'block',
        id: 'engine.unknown_sku',
        message: `Selected price option ${pick.price_option_id} is not in the catalog.`,
        source: selection.strategy
      });
      continue;
    }

    const line = costLine(option, {
      qty: pick.qty,
      months: pick.months,
      product
    });

    if (line.error) {
      flags.push({
        severity: 'block',
        id: `engine.${line.error}`,
        message: line.message,
        source: option.sku
      });
      continue;
    }

    // Adjustments become flags so nothing that changed the arithmetic is silent.
    for (const adjustment of line.adjustments) {
      if (!adjustment.severity) continue;
      flags.push({
        severity: adjustment.severity,
        id: `line.${adjustment.type}`,
        message: adjustment.message,
        source: option.sku
      });
    }
    for (const adjustment of line.adjustments) {
      if (adjustment.type === 'minimum_billing' || adjustment.type === 'quantity_floor') {
        deskActions.push(adjustment.message);
      }
    }

    // From the product, not from the selection. The model's schema has no
    // media_type field, so trusting the pick put `null` on every leg -- and a
    // leg with no medium cannot find its renderer template.
    const media = displayName(product.media_type || pick.media_type);
    if (!byMedia.has(media)) byMedia.set(media, []);
    byMedia.get(media).push({ line, product, option, pick });
  }

  if (byMedia.size === 0) {
    return {
      status: 'blocked',
      plan: null,
      flags,
      notes: [...prefetch.notes, ...selection.reasoning],
      trace
    };
  }

  // 4. Legs, one per medium, in the shape the renderer reads.
  const legs = [];
  for (const [media, entries] of byMedia) {
    const months = entries[0].pick.months;
    legs.push({
      media,
      scope: entries
        .map((e) => `${e.product.name} - ${e.option.name}`)
        .join('; ')
        .slice(0, 300),
      duration_label: durationLabel(months, entries[0].option.pricing_unit),
      lines: entries.map((e) => e.line),
      notes: buildLegNotes(entries)
    });
  }

  // 5. Rules. They judge costed lines; running them earlier would be judging
  //    numbers that do not exist yet.
  for (const leg of legs) {
    let rules;
    try {
      rules = loadRules(leg.media);
    } catch {
      continue; // no rules file for this medium yet
    }
    const verdict = applyConstraints(leg.lines, rules);
    for (const violation of verdict.violations || []) {
      flags.push({
        severity: violation.severity || 'warn',
        id: violation.id || 'rules.violation',
        message: violation.message,
        source: `rules:${rules.key}`
      });
    }
  }

  // 6. Budget.
  const totals = totalPlan(legs);
  const budget = Number(brief.budget) || 0;
  if (budget > 0 && totals.total > budget) {
    flags.push({
      severity: 'block',
      id: 'budget.exceeded',
      message:
        `Plan totals ${Math.round(totals.total).toLocaleString('en-IN')} against a budget of ` +
        `${Math.round(budget).toLocaleString('en-IN')}.`,
      source: 'engine'
    });
  }

  const unspent = round2(budget - totals.total);
  if (budget > 0 && unspent > budget * 0.15) {
    flags.push({
      severity: 'warn',
      id: 'budget.underspent',
      message:
        `${Math.round(unspent).toLocaleString('en-IN')} of the budget is unspent ` +
        `(${Math.round((unspent / budget) * 100)}%).`,
      source: 'engine'
    });
  }

  /*
   * One rule firing on five lines is one problem, not five. The desk reads
   * this list to decide what to fix, and a list padded with the same sentence
   * repeated buries the flags that differ. The count is kept so a reader can
   * still tell a one-line issue from a plan-wide one.
   */
  const deduped = dedupeFlags(flags);

  const plan = {
    deal_id: brief.deal_id,
    title: `Media Plan - ${brief.company}${brief.target_locations?.[0] ? `, ${brief.target_locations[0]}` : ''}`,
    client_name: brief.company,
    client_based_at: brief.target_locations?.[0] || null,
    budget,
    budget_includes_gst: true,
    gst_rate: 18,
    objective: brief.campaign_objective || null,
    target_location: (brief.target_locations || []).join(', ') || null,
    legs,
    reserves: [],
    flags: deduped,
    desk_actions: [...new Set(deskActions)],
    guidance: [...prefetch.notes, ...selection.reasoning],
    totals,
    generated_at: new Date().toISOString(),
    strategy: selection.strategy
  };

  trace.push({ step: 'cost', legs: legs.length, total: totals.total, ms: Date.now() - started });

  return {
    status: deduped.some((f) => f.severity === 'block') ? 'blocked' : 'ready',
    plan,
    flags: deduped,
    notes: prefetch.notes,
    trace
  };
}

/**
 * Collapses identical flags, keeping a count and every source that raised it.
 * Blocks stay ahead of warnings so the list reads worst-first.
 */
function dedupeFlags(flags) {
  const byKey = new Map();
  for (const flag of flags) {
    const key = `${flag.severity}|${flag.id}|${flag.message}`;
    const seen = byKey.get(key);
    if (seen) {
      seen.count += 1;
      if (flag.source && !seen.sources.includes(flag.source)) seen.sources.push(flag.source);
      continue;
    }
    byKey.set(key, { ...flag, count: 1, sources: flag.source ? [flag.source] : [] });
  }

  const rank = { block: 0, warn: 1, info: 2 };
  return [...byKey.values()]
    .map((f) => (f.count > 1 ? { ...f, message: `${f.message} (affects ${f.count} lines)` } : f))
    .sort((a, b) => (rank[a.severity] ?? 3) - (rank[b.severity] ?? 3));
}

/** Per-sheet notes: what the master could not answer for these lines. */
function buildLegNotes(entries) {
  const notes = [];
  for (const { line, option } of entries) {
    if (line.addon_total === null) {
      notes.push(
        `Printing and mounting is not priced in the master for "${option.name}" and is quoted separately.`
      );
    }
    for (const adjustment of line.adjustments) {
      notes.push(adjustment.message);
    }
  }
  return [...new Set(notes)];
}

module.exports = { buildPlan };
