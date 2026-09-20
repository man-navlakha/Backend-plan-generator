'use strict';

/**
 * Collapse byte-identical duplicates in the master image folders.
 *
 * Each folder holds one file per SKU, but most are the same image saved under many
 * names. For every folder this keeps one file per distinct content (the shortest
 * existing filename in the group), repoints the owning master's `Image` column at it,
 * and deletes the redundant copies. Rows whose image cannot be resolved -- blank, or
 * naming a file that is not on disk -- fall back to placeholder.webp.
 *
 * Cinema is not handled here: it uses one image per cinema chain, see
 * normalize-cinema-images.js.
 *
 * Pass --dry-run to report without writing or deleting anything.
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const ExcelJS = require('exceljs');

const DRY_RUN = process.argv.includes('--dry-run');
const MASTERS = path.join(__dirname, '..', 'src', 'assets', 'Masters');
const PLACEHOLDER = 'placeholder.webp';
const FIRST_DATA_ROW = 5;

// one entry per master workbook; each target is a sheet whose Image column
// addresses its own folder of images
const WORKBOOKS = [
  {
    master: path.join(MASTERS, 'Transit', 'transitmaster.xlsx'),
    targets: [
      { label: 'Transit/product-images', dir: path.join(MASTERS, 'Transit', 'product-images'), sheet: 'Product', skuCol: 3, imageCol: 8 },
      { label: 'Transit/price-option-images', dir: path.join(MASTERS, 'Transit', 'price-option-images'), sheet: 'Price Option', skuCol: 5, imageCol: 16 },
    ],
  },
  {
    master: path.join(MASTERS, 'Radio', 'radiomaster.xlsx'),
    targets: [
      { label: 'Radio/product-images', dir: path.join(MASTERS, 'Radio', 'product-images', 'product'), sheet: 'Product', skuCol: 3, imageCol: 8 },
      { label: 'Radio/pricing-images', dir: path.join(MASTERS, 'Radio', 'pricing-images', 'pricing'), sheet: 'Price Option', skuCol: 5, imageCol: 16 },
    ],
  },
];

// Shortest name wins, alphabetical on ties -- stable across runs.
function pickCanonical(names) {
  return [...names].sort((a, b) => a.length - b.length || a.localeCompare(b))[0];
}

function buildCanonicalMap(dir) {
  const files = fs.readdirSync(dir).filter((f) => fs.statSync(path.join(dir, f)).isFile());
  if (!files.includes(PLACEHOLDER)) throw new Error(`${PLACEHOLDER} missing from ${dir}`);

  const groups = new Map();
  for (const file of files) {
    if (file === PLACEHOLDER) continue;
    const digest = crypto.createHash('md5').update(fs.readFileSync(path.join(dir, file))).digest('hex');
    if (!groups.has(digest)) groups.set(digest, []);
    groups.get(digest).push(file);
  }

  const canonicalOf = new Map();
  const redundant = [];
  for (const names of groups.values()) {
    const keep = pickCanonical(names);
    for (const name of names) {
      canonicalOf.set(name, keep);
      if (name !== keep) redundant.push(name);
    }
  }
  // filenames embed the SKU (e.g. airfmgold-radio10003adspots.webp), so rows with a
  // blank or dead Image can often be recovered by matching SKU to filename
  const bySku = new Map();
  for (const file of files) {
    if (file === PLACEHOLDER) continue;
    const stem = path.basename(file, path.extname(file)).toLowerCase();
    const whole = stem.replace(/[^a-z0-9]/g, '');
    const tail = stem.split('-').slice(1).join('-').replace(/[^a-z0-9]/g, '');
    if (whole && !bySku.has(whole)) bySku.set(whole, file);
    if (tail && !bySku.has(tail)) bySku.set(tail, file);
  }

  return { files, groups, canonicalOf, redundant, bySku };
}

function repoint(sheet, target, canonicalOf, bySku) {
  const stats = { rows: 0, repointed: 0, unchanged: 0, blank: 0, missing: 0, placeheld: 0, recovered: 0 };
  const missingNames = new Set();

  for (let r = FIRST_DATA_ROW; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    if (!row.getCell(target.skuCol).value) continue;
    stats.rows++;

    const cell = row.getCell(target.imageCol);
    const current = cell.value == null ? '' : String(cell.value).trim();

    const skuKey = String(row.getCell(target.skuCol).value).trim().toLowerCase().replace(/[^a-z0-9]/g, '');
    const recovered = bySku.get(skuKey);

    let next;
    if (!current) {
      if (recovered) { next = canonicalOf.get(recovered) || recovered; stats.recovered++; }
      else { next = PLACEHOLDER; stats.blank++; }
    } else if (current === PLACEHOLDER) {
      next = PLACEHOLDER;
      stats.placeheld++;
    } else if (canonicalOf.has(current)) {
      next = canonicalOf.get(current);
    } else if (recovered) {
      next = canonicalOf.get(recovered) || recovered;
      stats.recovered++;
      missingNames.add(current);
    } else {
      next = PLACEHOLDER;
      stats.missing++;
      missingNames.add(current);
    }

    if (next === current) stats.unchanged++;
    else {
      if (!DRY_RUN) cell.value = next;
      stats.repointed++;
    }
  }
  return { stats, missingNames };
}

async function main() {
  for (const book of WORKBOOKS) {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(book.master);
    const pending = [];

    for (const target of book.targets) {
      const { files, groups, canonicalOf, redundant, bySku } = buildCanonicalMap(target.dir);
      const sheet = workbook.getWorksheet(target.sheet);
      if (!sheet) throw new Error(`sheet "${target.sheet}" not found in ${book.master}`);
      const { stats, missingNames } = repoint(sheet, target, canonicalOf, bySku);
      pending.push({ target, redundant });

      console.log(`${DRY_RUN ? '[dry run] ' : ''}${target.label}`);
      console.log(`  files ${files.length} -> ${groups.size + 1} kept, ${redundant.length} duplicates removed`);
      console.log(`  ${target.sheet}: ${stats.rows} rows, ${stats.repointed} repointed, ${stats.unchanged} unchanged`);
      console.log(`  recovered by SKU match: ${stats.recovered}`);
      console.log(`  placeholder: ${stats.blank} blank, ${stats.missing} missing (${missingNames.size} names), ${stats.placeheld} already\n`);
    }

    if (!DRY_RUN) {
      await workbook.xlsx.writeFile(book.master);
      for (const { target, redundant } of pending) {
        for (const file of redundant) fs.unlinkSync(path.join(target.dir, file));
      }
    }
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
