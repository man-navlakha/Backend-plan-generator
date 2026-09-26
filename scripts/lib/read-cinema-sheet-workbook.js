/**
 * Reads a one-tab-per-state cinema plan workbook into flat rows.
 *
 * Both PAN-India cards share a layout -- 26 or 33 state sheets, a header
 * row marked "Sr. No.", data in columns B:R -- but not a writer:
 *
 *   Cinema PAN India 07-04-2025 old.xlsx   Excel, reads fine in ExcelJS
 *   Cinema_PAN_India_From_CSVs.xlsx        generated, ExcelJS throws
 *
 * The generated one is valid SpreadsheetML that ExcelJS will not open: it puts the
 * whole document in an `x:` namespace prefix and uses opaque relationship ids
 * (`Rd0f3db0cab284be4` rather than `rId1`), and ExcelJS's workbook parser gives up
 * with "Cannot read properties of undefined (reading 'sheets')".
 *
 * So: try ExcelJS, and when it throws, read the sheet XML out of the zip directly.
 * Both paths return the same shape, so a caller cannot tell which ran.
 *
 * The direct path is safe here because these workbooks are as simple as
 * spreadsheets get -- no shared string table, no formulas in the data rows, every
 * value inline. It is not a general xlsx reader and should not grow into one.
 */

const fs = require('fs');
const ExcelJS = require('exceljs');
const JSZip = require('jszip');

/** 1-based column index from a cell reference: 'B15' -> 2, 'AA3' -> 27. */
function columnOf(ref) {
  const letters = /^([A-Z]+)/.exec(ref);
  if (!letters) return null;
  let n = 0;
  for (const ch of letters[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

function rowOf(ref) {
  const digits = /(\d+)$/.exec(ref);
  return digits ? Number(digits[1]) : null;
}

const ENTITIES = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'"
};

function unescapeXml(value) {
  return value
    .replace(/&(?:amp|lt|gt|quot|apos);/g, (m) => ENTITIES[m])
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)));
}

/** A cell's text, whatever ExcelJS wrapped it in (formula, rich text, hyperlink). */
function cellText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') {
    if (value.result !== undefined) return cellText(value.result);
    if (Array.isArray(value.richText)) return value.richText.map((t) => t.text).join('');
    if (value.text !== undefined) return String(value.text);
    if (value.hyperlink) return String(value.hyperlink);
    return '';
  }
  return String(value);
}

// ───────────────────────────── the ExcelJS path ─────────────────────────────

async function readWithExcelJs(file) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(file);

  return workbook.worksheets.map((sheet) => {
    const rows = new Map();
    sheet.eachRow({ includeEmpty: false }, (row, r) => {
      const cells = new Map();
      row.eachCell({ includeEmpty: false }, (cell, c) => {
        const text = cellText(cell.value).replace(/\s+/g, ' ').trim();
        if (text !== '') cells.set(c, text);
      });
      if (cells.size) rows.set(r, cells);
    });
    return { name: sheet.name, rows };
  });
}

// ─────────────────────────── the direct XML path ───────────────────────────

/**
 * Sheet name -> sheet XML path, in workbook order.
 *
 * The relationship ids are opaque, so the nth <sheet> in workbook.xml is matched to
 * the nth worksheet part rather than resolved through the rels file. These workbooks
 * are written in order and the counts agree, which is asserted below.
 */
async function sheetOrder(zip) {
  const workbookXml = await zip.file('xl/workbook.xml').async('string');
  const names = [...workbookXml.matchAll(/<(?:\w+:)?sheet\s[^>]*name="([^"]*)"/g)]
    .map((m) => unescapeXml(m[1]));

  const parts = Object.keys(zip.files)
    .filter((entry) => /^xl\/worksheets\/sheet\d+\.xml$/.test(entry))
    .sort((a, b) => Number(/(\d+)/.exec(a)[1]) - Number(/(\d+)/.exec(b)[1]));

  if (names.length !== parts.length) {
    throw new Error(
      `${names.length} sheet names but ${parts.length} worksheet parts; cannot match them by order`
    );
  }
  return names.map((name, i) => ({ name, part: parts[i] }));
}

function readSheetXml(xml) {
  const rows = new Map();

  for (const rowMatch of xml.matchAll(/<(?:\w+:)?row\s[^>]*\br="(\d+)"[^>]*>([\s\S]*?)<\/(?:\w+:)?row>/g)) {
    const rowNumber = Number(rowMatch[1]);
    const cells = new Map();

    for (const cellMatch of rowMatch[2].matchAll(
      /<(?:\w+:)?c\s[^>]*\br="([A-Z]+\d+)"[^>]*?(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g
    )) {
      const body = cellMatch[2];
      if (!body) continue; // self-closing cell: styled but empty
      const value = /<(?:\w+:)?(?:v|t)>([\s\S]*?)<\/(?:\w+:)?(?:v|t)>/.exec(body);
      if (!value) continue;
      const text = unescapeXml(value[1]).replace(/\s+/g, ' ').trim();
      if (text === '') continue;
      const column = columnOf(cellMatch[1]);
      if (column) cells.set(column, text);
    }

    if (cells.size) rows.set(rowNumber, cells);
  }

  return rows;
}

async function readWithXml(file) {
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  const sheets = await sheetOrder(zip);
  return Promise.all(sheets.map(async ({ name, part }) => ({
    name,
    rows: readSheetXml(await zip.file(part).async('string'))
  })));
}

// ───────────────────────────── the public call ─────────────────────────────

/**
 * Every sheet in the workbook as `{ name, rows }`, where `rows` is a Map of
 * 1-based row number -> Map of 1-based column number -> trimmed string.
 *
 * Only non-empty cells are present, so a missing field is an absent key rather
 * than an empty string. That distinction is the point: these cards leave fields
 * blank and the importer has to keep the row anyway.
 */
async function readCinemaSheetWorkbook(file) {
  if (!fs.existsSync(file)) throw new Error(`Workbook not found: ${file}`);
  try {
    return { sheets: await readWithExcelJs(file), reader: 'exceljs' };
  } catch (error) {
    return { sheets: await readWithXml(file), reader: `xml (exceljs: ${error.message})` };
  }
}

module.exports = { readCinemaSheetWorkbook, columnOf, rowOf, cellText, unescapeXml };
