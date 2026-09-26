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

const { prefetchForBrief, fetchCompleteCinemaInventory } = require('../catalog/prefetch');
const { getProduct } = require('../catalog/search');
const { selectLines } = require('./select');
const { costLine, totalPlan, round2 } = require('./cost');
const { loadRules } = require('../rules');
const { planMode, INVENTORY } = require('./mode');
const { applyConstraints } = require('../rules/evaluate');
const formatIndex = require('../assets/formats/format_index.json');

/** Slug -> the display name the renderer's format specs are keyed by. */
const DISPLAY_NAME = new Map();
for (const [name, meta] of Object.entries(formatIndex.media_types)) {
  DISPLAY_NAME.set(meta.slug, name);
}

function displayName(mediaType) {
  const value = String(mediaType || '').trim();
  const canonical = value.toLowerCase();
  if (canonical === 'cinema') return 'Cinema';
  return DISPLAY_NAME.get(canonical) || value;
}

function publicationKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/^magazine\s+advertising\s+in\s+/, '')
    .replace(/[\u2019']s\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function requestedMagazinePublications(brief) {
  if (String(brief?.service || '').toLowerCase() !== 'magazine') return [];
  const values = Array.isArray(brief.requested_publications)
    ? brief.requested_publications
    : [];
  const seen = new Set();
  return values
    .map((value) => String(value || '').trim().replace(/[\u2019']s\s*$/i, ''))
    .filter((value) => {
      const key = publicationKey(value);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function fullPageOption(product) {
  const options = product?.price_options || [];
  return options.find((option) => {
    const position = option?.attrs?.Position || option?.attrs?.position || '';
    return /full\s*page/i.test(`${position} ${option?.name || ''}`);
  }) || options[0] || null;
}

function requestedMagazinePlaceholder(publication) {
  return {
    product_name: publication,
    publication,
    circulation: null,
    frequency: null,
    Position: 'Full Page',
    ad_size: 'Full Page',
    page_position: 'Inside Page',
    price_option: null,
    sku: null,
    qty: 1,
    months: 1,
    rate: null,
    net: null,
    gst: null,
    total: null,
    pricing_unit: 'per Insertion',
    requested_from_brief: true,
    catalog_match: false,
    adjustments: []
  };
}

/**
 * Named Magazine titles are requirements, not model preferences. Add any title
 * the selector missed; when the current master has no exact title, leave its
 * catalog facts blank so the request stays visible without inventing a rate or
 * silently substituting a similarly named publication.
 */
function ensureRequestedMagazineRows(legs, brief, prefetch, flags, deskActions, inventory) {
  const requested = requestedMagazinePublications(brief);
  if (!requested.length) return [];

  let leg = legs.find((item) => String(item.media).toLowerCase() === 'magazine');
  if (!leg) {
    leg = {
      media: 'Magazine',
      scope: '',
      duration_label: '1 Month',
      lines: [],
      notes: []
    };
    legs.push(leg);
  }

  const existing = new Set(
    leg.lines.map((line) => publicationKey(line.publication || line.product_name)).filter(Boolean)
  );
  const missingFromCatalog = [];

  for (const publication of requested) {
    const key = publicationKey(publication);
    if (existing.has(key)) continue;

    const product = (prefetch?.candidates || []).find(
      (candidate) => publicationKey(candidate.name) === key
    );
    const option = fullPageOption(product);
    let line = null;
    if (product && option) {
      const costed = costLine(option, {
        qty: 1,
        months: 1,
        product,
        applyMinimumBilling: !inventory
      });
      if (!costed.error) {
        line = {
          ...costed,
          publication: product.name,
          ad_size: costed.ad_size || 'Full Page',
          page_position: costed.page_position || 'Inside Page',
          requested_from_brief: true,
          catalog_match: true
        };
      }
    }

    if (!line) {
      line = requestedMagazinePlaceholder(publication);
      missingFromCatalog.push(publication);
    }
    leg.lines.push(line);
    existing.add(key);
  }

  leg.scope = leg.lines
    .map((line) => line.publication || line.product_name)
    .filter(Boolean)
    .join('; ')
    .slice(0, 300);

  if (missingFromCatalog.length) {
    const names = missingFromCatalog.join(', ');
    flags.push({
      severity: inventory ? 'warn' : 'block',
      id: 'magazine.requested_publication_missing_catalog',
      message:
        `${names} ${missingFromCatalog.length === 1 ? 'was' : 'were'} requested in the brief but ` +
        'not found as an exact title in the Magazine master. The row is included with catalog fields blank.',
      source: 'client_brief'
    });
    deskActions.push(`Confirm availability and rate for the requested publication(s): ${names}.`);
    leg.notes = [...new Set([
      ...(leg.notes || []),
      `Requested publication(s) not found in the current master: ${names}. Blank cells require desk confirmation.`
    ])];
  }

  return missingFromCatalog;
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
 * Enforce the brief's duration in the unit the selected rate actually uses.
 * The model-facing field is historically named `months`, but Cinema rates are
 * per week. This server-side boundary prevents a four-week brief from being
 * costed as one week even when the model misinterprets the legacy name.
 */
function billingPeriods(option, pick, brief) {
  const unit = String(option?.pricing_unit || '').toLowerCase();
  const weeks = Number(brief?.duration_weeks);
  const months = Number(brief?.duration_months);

  if (/week/.test(unit) && Number.isFinite(weeks) && weeks > 0) return Math.trunc(weeks);
  if (/month/.test(unit) && Number.isFinite(months) && months > 0) return Math.trunc(months);
  return Math.max(1, Math.trunc(Number(pick?.months) || 1));
}

/**
 * Cinema's supplied planning format is explicitly based on a 10-second A/V
 * creative. A brief may override that length, but the model cannot lengthen an
 * ad merely to consume budget.
 */
function billingQuantity(product, pick, brief) {
  // Cinema quantity is creative seconds, not a screen count. Reading it as a
  // screen count would let a budget buy 40 "screens" of one audi.
  if (!/cinema/.test(String(product?.media_type || '').toLowerCase())) {
    return Math.max(1, Math.trunc(Number(pick?.qty) || 1));
  }

  const stated = Number(brief?.creative_duration_seconds);
  if (Number.isInteger(stated) && stated > 0) return stated;

  const rules = loadRules('Cinema');
  return Math.max(1, Math.trunc(Number(rules.billing?.default_activity_seconds) || 10));
}

/**
 * The screen a price option sells, where the master names one.
 *
 * Cinema carries an option per screen per creative format -- SCREEN-3ADFILM and
 * SCREEN-3SLIDE are one audi sold two ways. A costed plan buys one of them, so
 * the pair never collides. An inventory sheet lists what exists, and listing
 * both puts the same seat twice on a page the client is choosing from.
 *
 * Returns null when no screen is named, which means "cannot tell" -- and rows
 * that cannot be told apart are left alone rather than merged on a guess.
 */
function screenKey(product, option) {
  const match = /\bSCREEN[-_\s]*(\d+)/i.exec(option?.name || option?.sku || '');
  return match ? `${product.id}:${match[1]}` : null;
}

function requestedCinemaCreative(brief = {}) {
  const text = [brief.remarks_for_media, brief.client_brief]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  // Prefer an explicit value over words that may only name the two choices,
  // such as "Slide Show or Feature Video: Video".
  if (/creative(?:\s+type)?[^:\n.]*[:\-]\s*(?:feature\s+)?video\b/.test(text)) return 'video';
  if (/creative(?:\s+type)?[^:\n.]*[:\-]\s*(?:slide\s*show|slide|static)\b/.test(text)) return 'slide';
  if (/\b(?:video|ad\s*film)\b/.test(text)) return 'video';
  if (/\b(?:slide\s*show|slide|static)\b/.test(text)) return 'slide';
  return null;
}

function cinemaOptionScore(option, creative) {
  const text = `${option?.template || ''} ${option?.name || ''} ${option?.sku || ''}`.toLowerCase();
  const video = /ad\s*film|adfilm|video/.test(text);
  const slide = /slide|static/.test(text);
  if (creative === 'video') return video ? 3 : slide ? 0 : 1;
  if (creative === 'slide') return slide ? 3 : video ? 0 : 1;
  // A moving creative is the safer default for the recommendation sheet; the
  // source row remains visible through its SKU and format fields.
  return video ? 2 : slide ? 1 : 0;
}

/** One correctly priced row per matching Cinema screen for the client options sheet. */
function buildCompleteCinemaLeg(products, brief) {
  const cinemaProducts = (products || []).filter((product) =>
    /cinema/i.test(String(product?.media_type || ''))
  );
  if (!cinemaProducts.length) return null;

  const creative = requestedCinemaCreative(brief);
  const entries = [];
  for (const product of cinemaProducts) {
    const byScreen = new Map();
    for (const option of product.price_options || []) {
      const key = screenKey(product, option) || `${product.id}:${option.id}`;
      if (!byScreen.has(key)) byScreen.set(key, []);
      byScreen.get(key).push(option);
    }

    for (const options of byScreen.values()) {
      const option = [...options].sort(
        (a, b) => cinemaOptionScore(b, creative) - cinemaOptionScore(a, creative)
      )[0];
      if (!option) continue;
      const pick = {
        qty: billingQuantity(product, {}, brief),
        months: billingPeriods(option, {}, brief)
      };
      const line = costLine(option, {
        ...pick,
        product,
        // This is an options list, not a booking. Show the catalog flight
        // price without lifting a cheap screen to the minimum invoice value.
        applyMinimumBilling: false
      });
      if (!line.error) entries.push({ line, product, option, pick });
    }
  }

  if (!entries.length) return null;
  const months = entries[0].pick.months;
  const format = creative === 'video' ? 'video/ad-film' : creative === 'slide' ? 'slide' : 'available';
  return {
    media: displayName(cinemaProducts[0].media_type || 'cinema'),
    scope: `All matching Cinema ${format} rates in the requested locations`,
    duration_label: durationLabel(months, entries[0].option.pricing_unit),
    lines: entries.map((entry) => entry.line),
    notes: [`All ${entries.length} matching priced screen(s) are shown; the Recommended Plan sheet contains the proposed buy.`]
  };
}

/** Taxable non-inventory charges required by a medium's approved billing rules. */
function buildCharges(legs) {
  const charges = [];
  for (const leg of legs) {
    let rules;
    try {
      rules = loadRules(leg.media);
    } catch {
      continue;
    }

    const unitRate = Number(rules.billing?.making_conversion_cost_per_creative);
    if (!Number.isFinite(unitRate) || unitRate <= 0) continue;
    const quantity = Math.max(1, Math.trunc(Number(rules.billing?.default_creatives) || 1));
    const gstRate = Number(rules.billing?.gst_rate) || 18;
    const net = round2(unitRate * quantity);
    const gst = round2((net * gstRate) / 100);
    charges.push({
      id: `${String(leg.media).toLowerCase()}.making_conversion`,
      media: leg.media,
      label: 'Making & Conversion Cost per Creative',
      quantity,
      unit_rate: unitRate,
      gst_rate: gstRate,
      net,
      gst,
      total: round2(net + gst),
      source: rules.billing.source || `rules:${rules.key}`
    });
  }
  return charges;
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
  const mode = planMode(brief);
  const inventory = mode === INVENTORY;
  const requestedPublications = requestedMagazinePublications(brief);

  // 1. Shortlist.
  const prefetch = options.prefetch || (await prefetchForBrief(brief));
  trace.push({
    step: 'prefetch',
    products: prefetch.stats.products,
    price_options: prefetch.stats.price_options,
    ms: Date.now() - started
  });

  if (prefetch.candidates.length === 0 && requestedPublications.length === 0) {
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

  const cinemaBrief = /cinema/i.test(String(brief.service || ''));
  const completeCinemaInventoryPromise = cinemaBrief
    ? Promise.resolve(options.completeCinemaInventory || fetchCompleteCinemaInventory(brief, prefetch))
    : Promise.resolve([]);

  // 2. Selection -- the only step that may be a model.
  const selection = await selectLines(brief, prefetch, options);
  trace.push({ step: 'select', strategy: selection.strategy, lines: selection.selections.length });

  if (selection.selections.length === 0 && requestedPublications.length === 0) {
    return {
      status: 'blocked',
      plan: null,
      flags: [
        {
          severity: 'block',
          id: 'engine.nothing_selected',
          message: inventory
            ? 'The catalog had inventory but nothing could be listed from it.'
            : 'The catalog had inventory but nothing could be selected within the budget.',
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

  // Picks cluster heavily on a few venues -- an inventory sheet lists a dozen
  // screens from one multiplex -- and each lookup is a round trip.
  const productCache = new Map();
  const loadProduct = async (id) => {
    if (!productCache.has(id)) productCache.set(id, await getProduct(id));
    return productCache.get(id);
  };
  const listedScreens = new Set();
  let duplicateScreens = 0;

  for (const pick of selection.selections) {
    const product = await loadProduct(pick.product_id);
    const option = product?.price_options?.find((o) => o.id === pick.price_option_id);

    if (inventory && product && option) {
      const key = screenKey(product, option);
      if (key !== null) {
        if (listedScreens.has(key)) { duplicateScreens += 1; continue; }
        listedScreens.add(key);
      }
    }

    if (!product || !option) {
      flags.push({
        severity: 'block',
        id: 'engine.unknown_sku',
        message: `Selected price option ${pick.price_option_id} is not in the catalog.`,
        source: selection.strategy
      });
      continue;
    }

    const effectivePick = {
      ...pick,
      qty: billingQuantity(product, pick, brief),
      months: billingPeriods(option, pick, brief)
    };
    const line = costLine(option, {
      qty: effectivePick.qty,
      months: effectivePick.months,
      product,
      applyMinimumBilling: !inventory
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
    byMedia.get(media).push({ line, product, option, pick: effectivePick });
  }

  if (byMedia.size === 0 && requestedPublications.length === 0) {
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

  ensureRequestedMagazineRows(legs, brief, prefetch, flags, deskActions, inventory);

  const completeCinemaProducts = await completeCinemaInventoryPromise;
  const completeCinemaLeg = cinemaBrief
    ? buildCompleteCinemaLeg(
        completeCinemaProducts.length ? completeCinemaProducts : prefetch.candidates,
        brief
      )
    : null;
  const clientOptionsLegs = completeCinemaLeg ? [completeCinemaLeg] : [];

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
  const reserves = [];
  const charges = inventory ? [] : buildCharges(legs);
  const totals = totalPlan(legs, reserves, charges);
  const budget = Number(brief.budget) || 0;
  if (!inventory && budget > 0 && totals.total > budget) {
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
  if (!inventory && budget > 0 && unspent > budget * 0.15) {
    const severelyUnderspent = unspent > budget * 0.30;
    flags.push({
      severity: severelyUnderspent ? 'block' : 'warn',
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
  if (duplicateScreens) {
    selection.reasoning.push(
      `${duplicateScreens} row(s) were dropped: the same screen was offered in more than one ` +
      'creative format, and an inventory sheet lists each screen once.'
    );
  }

  const deduped = dedupeFlags(flags);

  const plan = {
    deal_id: brief.deal_id,
    mode,
    title: `Media Plan - ${brief.company}${brief.target_locations?.[0] ? `, ${brief.target_locations[0]}` : ''}`,
    client_name: brief.company,
    client_based_at: brief.target_locations?.[0] || null,
    budget,
    budget_includes_gst: true,
    gst_rate: 18,
    objective: brief.campaign_objective || null,
    target_location: (brief.target_locations || []).join(', ') || null,
    legs,
    client_options_legs: clientOptionsLegs,
    charges,
    reserves,
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
  for (const { line, option, product } of entries) {
    const needsPhysicalProduction = ['transit', 'outdoor', 'btl'].includes(product.family);
    if (line.addon_total === null && needsPhysicalProduction) {
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

module.exports = {
  buildPlan,
  billingPeriods,
  billingQuantity,
  buildCharges,
  publicationKey,
  requestedMagazinePublications,
  ensureRequestedMagazineRows,
  requestedCinemaCreative,
  buildCompleteCinemaLeg
};
