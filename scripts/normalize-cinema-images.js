'use strict';

/**
 * Normalize the Cinema master's image references to one image per cinema chain.
 *
 * Every `Image` cell (Product column H, Price Option column P) is rewritten to the
 * chain's file in Masters/Cinema/Images. Any chain with no mapping, or whose mapped
 * file is missing from disk, falls back to placeholder.webp.
 *
 * Re-runnable: writes the same result whatever state the workbook is in.
 */

const path = require('path');
const fs = require('fs');
const ExcelJS = require('exceljs');

const CINEMA_DIR = path.join(__dirname, '..', 'src', 'assets', 'Masters', 'Cinema');
const MASTER_PATH = path.join(CINEMA_DIR, 'cinema.xlsx');
const IMAGES_DIR = path.join(CINEMA_DIR, 'Images');
const PLACEHOLDER = 'placeholder.webp';

// Cinema Chain (as spelled in Product column K) -> file in Images/
const CHAIN_IMAGES = {
  Qube: 'qube.jpeg',
  'Pvr-inox': 'pvr-inox.webp',
  Cinepolis: 'cinepolis.png',
  Miraj: 'miraj.png',
  Kss: 'kss.webp',
  Ny: 'ny.jpg',
};

const FIRST_DATA_ROW = 5;
const COL = { productSku: 3, productImage: 8, productChain: 11, optionProductSku: 3, optionImage: 16 };

const exists = new Map();
function onDisk(file) {
  if (!exists.has(file)) exists.set(file, fs.existsSync(path.join(IMAGES_DIR, file)));
  return exists.get(file);
}

const fallbacks = new Map();
function imageForChain(chain) {
  const mapped = CHAIN_IMAGES[chain];
  if (mapped && onDisk(mapped)) return mapped;
  const reason = !mapped ? `unmapped chain "${chain || '(blank)'}"` : `missing file ${mapped}`;
  fallbacks.set(reason, (fallbacks.get(reason) || 0) + 1);
  return PLACEHOLDER;
}

async function main() {
  if (!onDisk(PLACEHOLDER)) {
    throw new Error(`${PLACEHOLDER} not found in ${IMAGES_DIR} — the fallback needs it.`);
  }

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(MASTER_PATH);

  const products = workbook.getWorksheet('Product');
  const priceOptions = workbook.getWorksheet('Price Option');
  const chainBySku = new Map();
  let productWrites = 0;
  let optionWrites = 0;

  for (let r = FIRST_DATA_ROW; r <= products.rowCount; r++) {
    const row = products.getRow(r);
    const sku = row.getCell(COL.productSku).value;
    if (!sku) continue;
    const chain = row.getCell(COL.productChain).value;
    const key = chain ? String(chain).trim() : '';
    chainBySku.set(String(sku).trim(), key);

    const image = imageForChain(key);
    const current = row.getCell(COL.productImage).value;
    if (current == null || String(current).trim() !== image) {
      row.getCell(COL.productImage).value = image;
      productWrites++;
    }
  }

  for (let r = FIRST_DATA_ROW; r <= priceOptions.rowCount; r++) {
    const row = priceOptions.getRow(r);
    const productSku = row.getCell(COL.optionProductSku).value;
    if (!productSku) continue;

    const image = imageForChain(chainBySku.get(String(productSku).trim()));
    const current = row.getCell(COL.optionImage).value;
    if (current == null || String(current).trim() !== image) {
      row.getCell(COL.optionImage).value = image;
      optionWrites++;
    }
  }

  await workbook.xlsx.writeFile(MASTER_PATH);

  console.log(`Product     Image (H): ${productWrites} rewritten`);
  console.log(`PriceOption Image (P): ${optionWrites} rewritten`);
  if (fallbacks.size === 0) {
    console.log(`placeholder fallbacks: none — every row resolved to a real file`);
  } else {
    console.log(`placeholder fallbacks (-> ${PLACEHOLDER}):`);
    for (const [reason, count] of fallbacks) console.log(`  ${String(count).padStart(6)}  ${reason}`);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
