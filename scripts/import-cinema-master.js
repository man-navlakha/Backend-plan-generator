/**
 * Loads the PAN-India cinema rate cards into Postgres as the Cinema catalog.
 *
 *   node --env-file=.env scripts/import-cinema-master.js [--dry]
 *
 * Two workbooks, one catalog (`cinema`, media_type `cinema`):
 *
 *   pan_india_2025  src/assets/Masters/Cinema/Cinema PAN India 07-04-2025 old.xlsx
 *                   26 state sheets, 10,118 screens. Fields almost complete. The only
 *                   source for UFO (3,993 screens) and Khushi (5).
 *
 *   from_csvs_2026  src/assets/Masters/Cinema/Cinema_PAN_India_From_CSVs.xlsx
 *                   33 state sheets, 10,547 screens, generated from the current master
 *                   CSVs. Newer rates and 8 more states, but sparse: 97% have no
 *                   locality, 45% no pincode, 48% no audi type, 30% no seats.
 *
 * Nothing is dropped and nothing is skipped for being incomplete. Every row of both
 * workbooks becomes a row here, because the point is to have somewhere to fix them:
 * a blank field is recorded as a finding in masters.data_quality_issues, so the desk
 * can list what is missing, fill it in the workbook, and re-import.
 *
 * Where the same screen is in both workbooks (matched on screen code) the rows are
 * linked rather than merged:
 *
 *   - Blanks are filled across the link. Only blanks -- a stated value is never
 *     overwritten, and every fill is recorded in attrs.filled_from so it is obvious
 *     which workbook a value came from.
 *   - The newer row stays quotable (`status = 1`). The older one is kept but set
 *     `status = 0`, which every search already filters on, so a plan cannot quote
 *     the same screen twice at two prices. It stays visible for comparison and can
 *     be promoted by changing one column.
 *   - Where the two disagree on the rate they are quoting -- which they do on
 *     virtually every shared screen -- that is recorded as a finding rather than
 *     silently resolved.
 *
 * Rates. Both workbooks' rate column is a price for ten seconds for one week, and the
 * costing engine multiplies rate x seconds x weeks, so offer_rate is the column
 * divided by ten (per second per week) exactly as the `cinema` master stores it. The
 * printed figure is kept in attrs.rate_10s_week.
 *
 * One honest wart, verified against the source CSVs: from_csvs_2026's column is headed
 * "A/V Slide" but 99.5% of its rates are the master's **Ad Film** offer rate x 10, not
 * the Slide rate. Ad Film costs more. The rows are therefore stored with
 * template 'Ad Film (labelled A/V Slide in source)' rather than pretending otherwise.
 *
 * The script is re-runnable and scoped: it rebuilds `cinema` inside one
 * transaction and touches no other catalog and nothing in app.*.
 */

const path = require('path');
const { getPool, query, close } = require('../src/pg');
const { readCinemaSheetWorkbook } = require('./lib/read-cinema-sheet-workbook');

const DRY = process.argv.includes('--dry');

const CATALOG = 'cinema';
const LABEL = 'Cinema (PAN India)';
const FAMILY = 'cinema';
const MEDIA_TYPE = 'cinema';
const MEDIA_LABEL = 'Cinema';

const MASTERS = path.join(__dirname, '..', 'src', 'assets', 'Masters', 'Cinema');

/**
 * The workbooks, oldest first. `precedence` decides which row stays quotable when the
 * same screen is in both: higher wins. Ids are offset per source so a re-import lands
 * on the same ids and a stored plan keeps pointing at the row it was priced from.
 */
const SOURCES = [
  {
    key: 'pan_india_2025',
    label: 'PAN India card, 07-04-2025',
    file: path.join(MASTERS, 'Cinema PAN India 07-04-2025 old.xlsx'),
    offset: 80_000_000,
    precedence: 1,
    template: '10 Sec A/V Slide',
    rate_basis: 'workbook column "Rates for 10 Sec :A/V Slide  (1 Week)"'
  },
  {
    key: 'from_csvs_2026',
    label: 'Generated from current master CSVs, 2026',
    file: path.join(MASTERS, 'Cinema_PAN_India_From_CSVs.xlsx'),
    offset: 81_000_000,
    precedence: 2,
    template: 'Ad Film (labelled A/V Slide in source)',
    rate_basis: 'workbook column "Rates for 10 Sec :A/V Slide  (1 Week)", '
      + 'verified to be the master Ad Film offer rate x 10'
  }
];

const ACTIVITY_SECONDS = 10;
const GST = 18;

/** Column positions, identical in both workbooks. Column A is a spacer. */
const COLS = {
  sr: 2, state: 3, city: 4, screen_code: 5, locality: 6, pincode: 7,
  theatre_type: 8, multiplex: 9, address: 10, tier: 11, capacity_pref: 12,
  total_screen: 13, audi_no: 14, audi_type: 15, chain: 16, seats: 17, rate: 18
};

/** Fields a row can be missing, with the client-sheet heading each one feeds. */
const FILLABLE = {
  city: 'City',
  locality: 'Locality',
  pincode: 'Pincode',
  theatre_type: 'Theatre Type',
  address: 'Address',
  tier: 'TIER',
  capacity_pref: 'Capacity Preference',
  total_screen: 'Total Screen',
  audi_no: 'Audi No',
  audi_type: 'Audi Type',
  chain: 'Cinema Chain',
  seats: 'Seating Capacity',
  rate: 'Rates for 10 Sec :A/V Slide  (1 Week)'
};

/** Fields whose absence stops the row being quotable or placeable. */
const SEVERITY = { rate: 'error', city: 'error', chain: 'warning' };

const ZONE = {
  'andaman and nicobar islands': 'South', 'andaman nicobar': 'South',
  'andhra pradesh': 'South', 'arunachal pradesh': 'North East', assam: 'North East',
  bihar: 'East', chandigarh: 'North', chhattisgarh: 'Central',
  'daman and diu': 'West', delhi: 'North', goa: 'West', gujarat: 'West',
  haryana: 'North', 'himachal pradesh': 'North', 'jammu and kashmir': 'North',
  jharkhand: 'East', karnataka: 'South', kerala: 'South', ladakh: 'North',
  'madhya pradesh': 'Central', maharashtra: 'West', manipur: 'North East',
  meghalaya: 'North East', mizoram: 'North East', nagaland: 'North East',
  odisha: 'East', puducherry: 'South', punjab: 'North', rajasthan: 'North',
  sikkim: 'North East', 'tamil nadu': 'South', telangana: 'South',
  tripura: 'North East', uttarakhand: 'North', 'uttar pradesh': 'North',
  'west bengal': 'East'
};

const STATE_ALIAS = {
  tamilnadu: 'Tamil Nadu',
  'j&k': 'Jammu and Kashmir',
  'j k': 'Jammu and Kashmir',
  'jammu & kashmir': 'Jammu and Kashmir',
  'jammu and kashmir': 'Jammu and Kashmir',
  chhatisgarh: 'Chhattisgarh',
  mp: 'Madhya Pradesh',
  orissa: 'Odisha',
  pondicherry: 'Puducherry',
  'andaman & nicobar': 'Andaman and Nicobar Islands',
  'andaman and nicobar': 'Andaman and Nicobar Islands'
};

const CHAIN_ALIAS = {
  'pvr-inox': 'PVR-INOX', 'pvr inox': 'PVR-INOX', pvrinox: 'PVR-INOX',
  kss: 'KSS', ufo: 'UFO', qube: 'Qube', cinepolis: 'Cinepolis',
  miraj: 'Miraj', ny: 'NY', khushi: 'Khushi'
};

const FOOTER = /^(total screens|actual cost|making & conversion|sub total|gst @|total cost)/i;

// ───────────────────────────── helpers ─────────────────────────────

function num(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).replace(/[,\s]/g, '').replace(/₹/g, '');
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function int(value) {
  const n = num(value);
  return n === null ? null : Math.trunc(n);
}

function searchText(parts) {
  return parts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim().slice(0, 2000);
}

function titleCase(value) {
  return String(value || '').toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

function canonState(value) {
  if (!value) return null;
  const key = String(value).toLowerCase().replace(/\s+/g, ' ').trim();
  return STATE_ALIAS[key] || titleCase(value);
}

function canonChain(value) {
  if (!value) return null;
  return CHAIN_ALIAS[String(value).toLowerCase().trim()] || titleCase(value);
}

/** The key two workbooks are matched on. Screen codes differ only in case and spacing. */
function codeKey(value) {
  if (!value) return null;
  const k = String(value).toUpperCase().replace(/[^A-Z0-9]+/g, '');
  return k === '' ? null : k;
}

function venueKey(row) {
  return [row.state, row.city, row.multiplex, row.pincode]
    .map((v) => String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim())
    .join('|');
}

// ───────────────────────────── the read ─────────────────────────────

/**
 * Data rows of one workbook.
 *
 * The header row is found by its "Sr. No." marker rather than assumed -- across the
 * two files it sits on row 14, 15 or 31. A data row is one whose Sr. No. is a positive
 * integer that also names a screen or a theatre, which removes the six footer rows
 * without needing to know where the data stops.
 */
async function readSource(source) {
  const { sheets, reader } = await readCinemaSheetWorkbook(source.file);
  const rows = [];
  const perSheet = [];

  for (const sheet of sheets) {
    let headerRow = null;
    for (const [r, cells] of sheet.rows) {
      for (const [, value] of cells) {
        if (/sr\.?\s*no/i.test(value)) { headerRow = r; break; }
      }
      if (headerRow) break;
    }

    let kept = 0;
    let skipped = 0;
    for (const [r, cells] of sheet.rows) {
      if (headerRow && r <= headerRow) continue;

      const raw = {};
      for (const [key, col] of Object.entries(COLS)) raw[key] = cells.get(col) ?? null;

      const sr = num(raw.sr);
      const isData = sr !== null && Number.isInteger(sr) && sr > 0
        && (raw.screen_code || raw.multiplex);

      if (!isData) {
        if (!FOOTER.test(raw.sr || raw.state || '')) skipped += 1;
        continue;
      }

      rows.push({ ...raw, source: source.key, sheet: sheet.name, source_row: r, sr });
      kept += 1;
    }

    perSheet.push({ sheet: sheet.name, header_row: headerRow, rows: kept, skipped });
  }

  return { rows, perSheet, reader };
}

// ───────────────────────── linking and gap filling ─────────────────────────

/**
 * Links the same screen across the two workbooks and fills blanks across the link.
 *
 * Matching is on screen code, and only where the code occurs exactly once in each
 * workbook. Codes are reused -- 141 rows in the 2025 card repeat one -- and a reused
 * code is not evidence of the same screen, so an ambiguous code is left unlinked and
 * flagged rather than guessed at.
 *
 * A link must also stay inside one state. Every link this produces today already does
 * (checked: 4,397 of 4,397, with 4,203 also agreeing closely on the theatre name), so
 * the guard changes nothing now -- it is here so a future workbook cannot quietly
 * marry two unrelated screens that happen to share an aggregator code.
 *
 * Linked rows often disagree on the cinema chain, and that is not a mismatch: the
 * chain here is the ad-delivery network, and several theatres moved from UFO to Qube
 * or KSS between the two cards. Same screen, new distributor. It is recorded rather
 * than treated as an error.
 *
 * Returns the number of links made and mutates the rows: `linked_to`, `filled_from`
 * and `superseded` appear on the rows that earned them.
 */
function linkSources(bySource) {
  const [older, newer] = SOURCES.map((s) => bySource.get(s.key));

  const index = (rows) => {
    const map = new Map();
    for (const row of rows) {
      const key = codeKey(row.screen_code);
      if (!key) continue;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(row);
    }
    return map;
  };

  const oldIndex = index(older);
  const newIndex = index(newer);

  const stats = {
    linked: 0, ambiguous: 0, filled: 0, rateConflicts: 0,
    chainChanges: 0, crossState: 0
  };

  for (const [key, newRows] of newIndex) {
    const oldRows = oldIndex.get(key);
    if (!oldRows) continue;

    if (newRows.length !== 1 || oldRows.length !== 1) {
      // The code is in both workbooks but is not unique in at least one of them.
      for (const row of [...newRows, ...oldRows]) row.ambiguous_code = key;
      stats.ambiguous += newRows.length + oldRows.length;
      continue;
    }

    const newRow = newRows[0];
    const oldRow = oldRows[0];

    // Same code, different state: not the same screen. Leave both quotable and say so.
    if (canonState(newRow.state) !== canonState(oldRow.state)) {
      newRow.cross_state_code = key;
      oldRow.cross_state_code = key;
      stats.crossState += 2;
      continue;
    }

    const newChain = canonChain(newRow.chain);
    const oldChain = canonChain(oldRow.chain);
    if (newChain && oldChain && newChain !== oldChain) {
      newRow.chain_was = oldChain;
      oldRow.chain_now = newChain;
      stats.chainChanges += 1;
    }

    newRow.linked_to = oldRow;
    oldRow.linked_to = newRow;
    stats.linked += 1;

    // Fill blanks both ways. Only blanks.
    for (const field of Object.keys(FILLABLE)) {
      if (!newRow[field] && oldRow[field]) {
        newRow[field] = oldRow[field];
        (newRow.filled_from ||= {})[field] = oldRow.source;
        stats.filled += 1;
      } else if (!oldRow[field] && newRow[field]) {
        oldRow[field] = newRow[field];
        (oldRow.filled_from ||= {})[field] = newRow.source;
        stats.filled += 1;
      }
    }

    // The newer row is the one a plan may quote.
    oldRow.superseded = true;

    const a = num(oldRow.rate);
    const b = num(newRow.rate);
    if (a !== null && b !== null && a !== b) {
      newRow.rate_conflict = a;
      oldRow.rate_conflict = b;
      stats.rateConflicts += 1;
    }
  }

  return stats;
}

// ───────────────────────────── the transform ─────────────────────────────

/**
 * Turns linked workbook rows into `masters` rows.
 *
 * Product attribute names are the ones render/resolvers.js looks for first, because
 * engine/cost.js spreads product attrs straight onto the plan line. All 17 columns of
 * the Cinema client template are therefore filled from the catalog rather than inferred.
 */
function transform(bySource) {
  const products = [];
  const priceOptions = [];
  const issues = [];

  for (const source of SOURCES) {
    const rows = bySource.get(source.key);
    const seenCode = new Map();

    rows.forEach((row, index) => {
      const id = source.offset + index + 1;
      const state = canonState(row.state);
      const chain = canonChain(row.chain);
      const city = row.city ? titleCase(row.city) : null;
      const pincode = /^\d{6}$/.test(String(row.pincode || '').trim())
        ? int(row.pincode) : null;
      const seats = int(row.seats);
      const totalScreen = int(row.total_screen);
      const audiNo = int(row.audi_no);

      const printed = num(row.rate);
      const perSecond = printed !== null && printed > 0
        ? Math.round((printed / ACTIVITY_SECONDS) * 100) / 100
        : null;

      // A superseded row stays in the catalog but out of every search: status is what
      // searchProducts filters on, so this is how the same screen avoids being quoted
      // twice at two prices.
      const status = row.superseded ? 0 : 1;

      const name = audiNo && row.multiplex
        ? `${row.multiplex} - Audi ${audiNo}`
        : row.multiplex || row.screen_code;

      products.push({
        id,
        catalog: CATALOG,
        family: FAMILY,
        media_type: MEDIA_TYPE,
        media_label: MEDIA_LABEL,
        source_row: row.source_row,
        sku: row.screen_code,
        name,
        description: row.address,
        image_url: null,
        status,
        sort_order: row.sr,
        country: 'India',
        state,
        city,
        locality: row.locality,
        zone: state ? ZONE[state.toLowerCase()] || null : null,
        location_source: city ? 'master' : 'none',
        attrs: JSON.stringify({
          screen_code: row.screen_code,
          multiplex_name: row.multiplex,
          address: row.address,
          pincode,
          theatre_type: row.theatre_type,
          tier: row.tier,
          capacity_preference: row.capacity_pref,
          total_screen: totalScreen,
          audi_no: audiNo,
          audi_type: row.audi_type,
          cinema_chain: chain,
          seating_capacity: seats,
          // Provenance: which workbook, which row, what it printed, what was borrowed
          // from the other workbook, and what the other workbook quoted instead.
          rate_10s_week: printed,
          activity_seconds: ACTIVITY_SECONDS,
          source_file: source.key,
          source_sheet: row.sheet,
          venue_key: venueKey(row),
          filled_from: row.filled_from || null,
          superseded: row.superseded ? true : null,
          linked_screen_code: row.linked_to ? row.linked_to.screen_code : null,
          other_source_rate_10s_week: row.rate_conflict ?? null
        }),
        search_text: searchText([
          name, row.screen_code, chain, row.theatre_type, row.audi_type,
          city, state, row.locality, row.address, 'cinema'
        ])
      });

      priceOptions.push({
        id,
        product_id: id,
        catalog: CATALOG,
        family: FAMILY,
        media_type: MEDIA_TYPE,
        source_row: row.source_row,
        sku: row.screen_code ? `${row.screen_code}-${source.key}` : null,
        name: '10 Sec A/V Slide',
        template: source.template,
        // Neither card states a per-screen minimum billing, unlike the live cinema
        // master's flat 10,000. Inventing one would inflate small plans.
        minimum_billing: null,
        offer_rate: perSecond,
        buying_rate: null,
        discounted_rate: null,
        pricing_unit: 'per week per second',
        gst: GST,
        on_request: false,
        status,
        sort_order: row.sr,
        image_url: null,
        units: JSON.stringify([
          { unit: '#Second(s)', code: 'SECOND', step: 5, minimum: ACTIVITY_SECONDS, maximum: null },
          { unit: '#Week(S)', code: 'WEEK', step: 1, minimum: 1, maximum: null }
        ]),
        attrs: JSON.stringify({
          activity: '10 Sec A/V Format',
          quoted_duration: '4 Weeks',
          rate_10s_week: printed,
          source_file: source.key
        }),
        addons: '[]',
        variants: '[]',
        rate_sources: JSON.stringify(
          printed === null ? [] : [{
            basis: source.rate_basis,
            source_rate: printed,
            divide_by: ACTIVITY_SECONDS,
            offer_rate: perSecond
          }]
        )
      });

      const issue = (severity, code, field, current, message) => issues.push({
        catalog: CATALOG,
        entity_type: 'product',
        product_id: id,
        price_option_id: null,
        source_sheet: `${source.key}:${row.sheet}`,
        source_row: row.source_row,
        severity,
        code,
        field,
        current_value: current === null || current === undefined ? null : String(current),
        suggested_value: null,
        message
      });

      /*
       * Every blank field is registered, not just the ones that break costing.
       *
       * This is the register the desk works from: `select field, count(*) ... group by
       * field` says what to go and fill, and a re-import clears what was fixed. The
       * 2026 workbook is missing 26,522 field values, so leaving them unrecorded would
       * mean the gaps exist but nothing can find them.
       */
      for (const [field, heading] of Object.entries(FILLABLE)) {
        if (row[field]) continue;
        issue(
          SEVERITY[field] || 'warning',
          `MISSING_${field.toUpperCase()}`,
          heading,
          null,
          `${heading} is blank in ${source.key}`
            + (row.linked_to ? ' and in the linked row of the other workbook.' : '.')
        );
      }

      if (printed !== null && printed <= 0) {
        issue('error', 'INVALID_RATE', FILLABLE.rate, row.rate,
          'Rate is present but not a positive number, so this screen cannot be quoted.');
      }
      if (row.pincode && pincode === null) {
        issue('warning', 'INVALID_PINCODE', 'Pincode', row.pincode,
          'Pincode is present but not a six-digit number.');
      }
      if (row.seats && !(seats > 0)) {
        issue('warning', 'INVALID_SEATS', 'Seating Capacity', row.seats,
          'Seating capacity is present but not a positive number.');
      }
      if (row.tier && !/^T[1-4]$/i.test(row.tier)) {
        issue('warning', 'INVALID_TIER', 'TIER', row.tier,
          'Tier is not T1-T4; the Tier and Capacity Preference columns look transposed.');
      }
      if (row.capacity_pref && !/^S\d{1,2}$/i.test(row.capacity_pref)) {
        issue('warning', 'INVALID_CAPACITY_PREFERENCE', 'Capacity Preference',
          row.capacity_pref, 'Capacity preference is not in S1-S16 form.');
      }
      if (row.rate_conflict !== undefined && !row.superseded) {
        issue('warning', 'RATE_DISAGREES_ACROSS_SOURCES', FILLABLE.rate, printed,
          `The other workbook quotes ${row.rate_conflict} for this screen code. `
            + 'The newer figure is the one being quoted.');
      }
      if (row.ambiguous_code) {
        issue('warning', 'AMBIGUOUS_SCREEN_CODE', 'Screen Code', row.screen_code,
          'This screen code is in both workbooks but is not unique in one of them, '
            + 'so the rows could not be linked and may duplicate a screen.');
      }
      if (row.cross_state_code) {
        issue('warning', 'SCREEN_CODE_CROSSES_STATES', 'Screen Code', row.screen_code,
          'The other workbook uses this screen code in a different state, so the rows '
            + 'were not treated as the same screen.');
      }
      // Not a fault: the chain is the ad-delivery network and it does change hands.
      // Recorded because a desk comparing the two cards will want to know.
      if (row.chain_was) {
        issue('warning', 'CHAIN_CHANGED_ACROSS_SOURCES', 'Cinema Chain', chain,
          `The 2025 card delivered this screen through ${row.chain_was}.`);
      }

      const key = codeKey(row.screen_code);
      if (key) {
        const first = seenCode.get(key);
        if (first) {
          issue('warning', 'DUPLICATE_SCREEN_CODE', 'Screen Code', row.screen_code,
            `Screen code repeats ${first.sheet} row ${first.source_row} in the same workbook.`);
        } else {
          seenCode.set(key, row);
        }
      }
    });
  }

  return { products, priceOptions, issues };
}

// ───────────────────────────── the write ─────────────────────────────

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

const ISSUE_COLUMNS = [
  'catalog', 'entity_type', 'product_id', 'price_option_id', 'source_sheet',
  'source_row', 'severity', 'code', 'field', 'current_value', 'suggested_value', 'message'
];

/** Batched multi-row INSERT, sized to stay under the 65,535 bound parameter cap. */
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

function tally(rows, key) {
  const counts = new Map();
  for (const row of rows) {
    const value = typeof key === 'function' ? key(row) : row[key];
    const label = value === null || value === undefined ? '(blank)' : String(value);
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

async function main() {
  const bySource = new Map();

  for (const source of SOURCES) {
    const { rows, perSheet, reader } = await readSource(source);
    bySource.set(source.key, rows);
    const skipped = perSheet.reduce((n, s) => n + s.skipped, 0);
    console.log(
      `${source.key.padEnd(15)} ${String(rows.length).padStart(6)} screens  `
        + `${String(perSheet.length).padStart(2)} sheets  reader=${reader.split(' ')[0]}`
        + (skipped ? `  (${skipped} empty rows skipped)` : '')
    );
  }

  const link = linkSources(bySource);
  console.log(
    `\nLinked ${link.linked} screens across the two workbooks by screen code; `
      + `${link.ambiguous} rows left unlinked because the code is not unique.`
  );
  console.log(`Filled ${link.filled} blank fields across the link.`);
  console.log(`${link.rateConflicts} linked screens disagree on the rate; the newer figure wins.`);
  console.log(`${link.chainChanges} linked screens changed delivery network between the cards.`);
  if (link.crossState) {
    console.log(`${link.crossState} rows share a code across states and were not linked.`);
  }

  const { products, priceOptions, issues } = transform(bySource);

  const quotable = products.filter((p) => p.status === 1);
  const priced = priceOptions.filter((o) => o.status === 1 && o.offer_rate > 0);
  console.log(
    `\n${products.length} products (${quotable.length} quotable, `
      + `${products.length - quotable.length} superseded but kept), `
      + `${priced.length} priced and quotable.`
  );
  console.log(`${issues.length} data-quality findings.`);

  console.log('\nQuotable screens by source:');
  for (const [k, n] of tally(quotable, (p) => JSON.parse(p.attrs).source_file)) {
    console.log(`  ${k.padEnd(16)} ${n}`);
  }
  console.log('\nQuotable screens by chain:');
  for (const [k, n] of tally(quotable, (p) => JSON.parse(p.attrs).cinema_chain)) {
    console.log(`  ${k.padEnd(16)} ${n}`);
  }
  console.log('\nFindings by code:');
  for (const [k, n] of tally(issues, 'code')) console.log(`  ${k.padEnd(34)} ${n}`);

  if (DRY) {
    console.log('\n--dry: nothing written.');
    return;
  }

  const catalog = {
    slug: CATALOG,
    label: LABEL,
    family: FAMILY,
    workbook: SOURCES.map((s) => `Cinema/${path.basename(s.file)}`).join(' + '),
    row_counts: JSON.stringify({
      products: products.length,
      quotable: quotable.length,
      superseded: products.length - quotable.length,
      price_options: priceOptions.length,
      priced_options: priced.length,
      issues: issues.length,
      linked: link.linked,
      filled_fields: link.filled,
      sources: Object.fromEntries(SOURCES.map((s) => [s.key, bySource.get(s.key).length]))
    })
  };

  console.log('\nLoading into Postgres ...');
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM masters.data_quality_issues WHERE catalog=$1', [CATALOG]);
    await client.query('DELETE FROM masters.catalogs WHERE slug=$1', [CATALOG]);

    await insertRows(client, 'masters.catalogs',
      ['slug', 'label', 'family', 'workbook', 'row_counts'], [catalog], 'catalogs');
    await insertRows(client, 'masters.products', PRODUCT_COLUMNS, products, 'products');
    await insertRows(client, 'masters.price_options', PO_COLUMNS, priceOptions, 'price_options');
    await insertRows(client, 'masters.data_quality_issues', ISSUE_COLUMNS, issues, 'issues');

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
    select attrs->>'source_file' source,
           count(*)::int rows,
           count(*) filter (where status = 1)::int quotable,
           count(*) filter (where city is not null)::int with_city,
           count(distinct state)::int states
      from masters.products where catalog = $1
     group by 1 order by 1
  `, [CATALOG]);
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
