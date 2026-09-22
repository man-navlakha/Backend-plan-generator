const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const formatIndex = require('../assets/formats/format_index.json');
const { loadRules } = require('../rules');
const { resolveField } = require('./resolvers');
const S = require('./style');

const ASSETS = path.join(__dirname, '..', 'assets');
const LOGO_PATH = path.join(ASSETS, 'logo_ep.png');

/** format.json for a media slug or display name. */
function loadSpec(media) {
  const needle = String(media).toLowerCase();
  for (const [name, meta] of Object.entries(formatIndex.media_types)) {
    if (name.toLowerCase() === needle || meta.slug.toLowerCase() === needle) {
      return { name, ...meta, spec: JSON.parse(fs.readFileSync(path.join(ASSETS, '..', meta.spec), 'utf8')) };
    }
  }
  throw new Error(`Unknown media "${media}"`);
}

function addLogo(workbook, sheet, lastCol) {
  sheet.mergeCells(S.LOGO_BAND.first, 1, S.LOGO_BAND.last, lastCol);
  if (!fs.existsSync(LOGO_PATH)) return;
  const imageId = workbook.addImage({ filename: LOGO_PATH, extension: 'png' });
  sheet.addImage(imageId, {
    tl: { col: 0, row: 0 },
    ext: { width: S.LOGO.width, height: S.LOGO.height },
    editAs: 'oneCell'
  });
}

function applyRowHeights(sheet, lastDataRow) {
  for (const row of [1, 2, 3, 4]) sheet.getRow(row).height = S.ROW_HEIGHT[row];
  sheet.getRow(S.TITLE_ROW).height = S.ROW_HEIGHT[S.TITLE_ROW];
  sheet.getRow(S.HEADER_ROW).height = S.ROW_HEIGHT[S.HEADER_ROW];
  for (let r = S.FIRST_DATA_ROW; r <= lastDataRow; r += 1) sheet.getRow(r).height = S.ROW_HEIGHT.data;
}

function styleCell(cell, style) {
  if (style.font) cell.font = style.font;
  if (style.fill) cell.fill = style.fill;
  if (style.alignment) cell.alignment = style.alignment;
  if (style.border) cell.border = style.border;
  if (style.numFmt) cell.numFmt = style.numFmt;
}

/** One medium's rate card: the sheet the client reads. */
function addMediaSheet(workbook, leg) {
  const { spec } = loadSpec(leg.media);
  const columns = spec.columns;
  const lastCol = columns.length;
  const sheet = workbook.addWorksheet(spec.sheet_name, {
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 }
  });

  columns.forEach((col, i) => {
    sheet.getColumn(i + 1).width = col.width || 14;
  });

  addLogo(workbook, sheet, lastCol);

  sheet.mergeCells(S.TITLE_ROW, 1, S.TITLE_ROW, lastCol);
  const title = sheet.getCell(S.TITLE_ROW, 1);
  title.value = spec.title;
  styleCell(title, S.titleStyle());

  columns.forEach((col, i) => {
    const cell = sheet.getCell(S.HEADER_ROW, i + 1);
    cell.value = col.header;
    styleCell(cell, S.headerStyle());
  });

  leg.lines.forEach((line, index) => {
    const rowNumber = S.FIRST_DATA_ROW + index;
    columns.forEach((col, i) => {
      const cell = sheet.getCell(rowNumber, i + 1);
      cell.value = resolveField(col.field, line, { index, leg });
      styleCell(cell, S.dataStyle(col.type));
    });
  });

  const lastDataRow = S.FIRST_DATA_ROW + leg.lines.length - 1;
  const totalRow = lastDataRow + 1;

  columns.forEach((col, i) => {
    const cell = sheet.getCell(totalRow, i + 1);
    if (i === 0) {
      cell.value = 'Total';
      styleCell(cell, S.totalStyle(null));
      return;
    }
    if (S.SUMMABLE.has(col.field) && leg.lines.length) {
      const letter = sheet.getColumn(i + 1).letter;
      // `result` caches the value so viewers that do not recalculate — Gmail
      // preview, Google Sheets, Numbers — still show a number, not a blank.
      const result = leg.lines.reduce(
        (sum, line, index) => sum + (Number(resolveField(col.field, line, { index, leg })) || 0),
        0
      );
      cell.value = { formula: `SUM(${letter}${S.FIRST_DATA_ROW}:${letter}${lastDataRow})`, result };
      styleCell(cell, S.totalStyle(col.type));
    } else {
      styleCell(cell, S.totalStyle(null));
    }
  });

  applyRowHeights(sheet, totalRow);
  sheet.views = [{ state: 'frozen', ySplit: S.HEADER_ROW }];

  // Per-sheet notes sit under the total so the desk sees them in context.
  let noteRow = totalRow + 2;
  for (const note of leg.notes || []) {
    sheet.mergeCells(noteRow, 1, noteRow, lastCol);
    const cell = sheet.getCell(noteRow, 1);
    cell.value = note;
    cell.font = { size: 10, italic: true };
    cell.alignment = { horizontal: 'left', vertical: 'middle', wrapText: true };
    noteRow += 1;
  }

  return { sheetName: spec.sheet_name, totalRow, columns, label: spec.label };
}

/** Totals across every medium, so a bus + cab + auto plan reads as one buy. */
function addSummarySheet(workbook, plan, placements) {
  const HEADERS = ['Sr.No.', 'Medium', 'Product / Scope', 'Units', 'Duration', 'Net', 'GST @ 18%', 'Total'];
  const WIDTHS = [8, 18, 52, 10, 14, 16, 14, 18];
  const lastCol = HEADERS.length;
  const sheet = workbook.addWorksheet('Summary', {
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 }
  });

  WIDTHS.forEach((w, i) => { sheet.getColumn(i + 1).width = w; });
  addLogo(workbook, sheet, lastCol);

  sheet.mergeCells(S.TITLE_ROW, 1, S.TITLE_ROW, lastCol);
  const title = sheet.getCell(S.TITLE_ROW, 1);
  title.value = plan.title || `Media Plan — ${plan.client_name || ''}`.trim();
  styleCell(title, S.titleStyle());

  HEADERS.forEach((header, i) => {
    const cell = sheet.getCell(S.HEADER_ROW, i + 1);
    cell.value = header;
    styleCell(cell, S.headerStyle());
  });

  let row = S.FIRST_DATA_ROW;
  plan.legs.forEach((leg, index) => {
    const placement = placements[index];
    const values = [
      index + 1,
      leg.media,
      leg.scope || leg.lines.map((l) => l.product_name).filter(Boolean).join('; '),
      crossSum(placement, 'qty', leg),
      leg.duration_label || null,
      crossSum(placement, 'net', leg),
      crossSum(placement, 'gst', leg),
      crossSum(placement, 'total', leg)
    ];
    const types = ['sr', 'text', 'text', 'int', 'text', 'money', 'money', 'money'];
    values.forEach((value, i) => {
      const cell = sheet.getCell(row, i + 1);
      cell.value = value;
      styleCell(cell, S.dataStyle(types[i]));
    });
    row += 1;
  });

  const lastDataRow = row - 1;

  // Reserves (printing, permissions) are real money against the budget, shown
  // as their own lines so the client sees what is and is not yet quoted.
  for (const reserve of plan.reserves || []) {
    const cells = [null, 'Reserve', reserve.label, null, null, null, null, reserve.amount];
    cells.forEach((value, i) => {
      const cell = sheet.getCell(row, i + 1);
      cell.value = value;
      styleCell(cell, S.dataStyle(i === 7 ? 'money' : 'text'));
      if (i === 7) cell.font = { size: 11, italic: true };
    });
    row += 1;
  }

  const sumField = (field) => plan.legs.reduce(
    (sum, leg) => sum + leg.lines.reduce((s, line) => s + (Number(line[field]) || 0), 0),
    0
  );
  const reserveTotal = (plan.reserves || []).reduce((s, r) => s + (Number(r.amount) || 0), 0);
  const totals = { net: sumField('net'), gst: sumField('gst'), total: sumField('total') + reserveTotal };

  const totalRow = row;
  ['Total', null, null, null, null, 'net', 'gst', 'total'].forEach((marker, i) => {
    const cell = sheet.getCell(totalRow, i + 1);
    if (i === 0) {
      cell.value = 'Total';
    } else if (marker) {
      const letter = sheet.getColumn(i + 1).letter;
      cell.value = {
        formula: `SUM(${letter}${S.FIRST_DATA_ROW}:${letter}${row - 1})`,
        result: totals[marker]
      };
    }
    styleCell(cell, S.totalStyle(marker && i > 0 ? 'money' : null));
  });

  // Budget reconciliation, the question every client asks first.
  let r = totalRow + 2;
  const budgetFirstRow = r;
  const budgetRows = [
    ['Budget', plan.budget],
    ['Budget basis', plan.budget_includes_gst ? 'Inclusive of 18% GST' : 'Exclusive of GST'],
    ['Plan total (incl. GST)', { formula: `H${totalRow}`, result: totals.total }],
    ['Balance', { formula: `B${budgetFirstRow} - H${totalRow}`, result: plan.budget - totals.total }]
  ];
  for (const [label, value] of budgetRows) {
    const labelCell = sheet.getCell(r, 1);
    labelCell.value = label;
    labelCell.font = { bold: true, size: 11 };
    const valueCell = sheet.getCell(r, 2);
    valueCell.value = value;
    valueCell.numFmt = typeof value === 'string' ? '@' : S.NUM_FMT.money;
    valueCell.font = { size: 11 };
    r += 1;
  }

  applyRowHeights(sheet, totalRow);
  sheet.views = [{ state: 'frozen', ySplit: S.HEADER_ROW }];
  return sheet;
}

function columnLetterFor(placement, field) {
  const index = placement.columns.findIndex((c) => c.field === field);
  return index >= 0 ? numberToLetter(index + 1) : 'A';
}

function crossSum(placement, field, leg) {
  const letter = columnLetterFor(placement, field);
  const result = (leg ? leg.lines : []).reduce(
    (sum, line, index) => sum + (Number(resolveField(field, line, { index, leg })) || 0),
    0
  );
  return {
    formula: `SUM('${placement.sheetName}'!${letter}${S.FIRST_DATA_ROW}:${letter}${placement.totalRow - 1})`,
    result
  };
}

function numberToLetter(n) {
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - m) / 26);
  }
  return s;
}

/** Terms sheet, generated from the rules tree so wording never drifts. */
function addTermsSheet(workbook, leg) {
  const { spec } = loadSpec(leg.media);
  const rules = loadRules(leg.media);
  const approved = (rules.terms && rules.terms.approved) || [];
  const sheet = workbook.addWorksheet(`T&C - ${spec.label}`.slice(0, 31));
  const lastCol = 11;
  for (let i = 1; i <= lastCol; i += 1) sheet.getColumn(i).width = 12;

  sheet.mergeCells(1, 1, 2, lastCol);
  const head = sheet.getCell(1, 1);
  head.value = 'Terms & Conditions';
  styleCell(head, S.sectionStyle(12));

  let row = 3;
  approved.forEach((term, i) => {
    sheet.mergeCells(row, 1, row, lastCol);
    const cell = sheet.getCell(row, 1);
    cell.value = `${i + 1}. ${term}`;
    cell.alignment = { horizontal: 'left', vertical: 'middle', wrapText: true };
    cell.font = { size: 11 };
    row += 1;
  });

  const pending = (rules.terms && rules.terms.pending) || [];
  if (pending.length) {
    row += 1;
    sheet.mergeCells(row, 1, row, lastCol);
    const cell = sheet.getCell(row, 1);
    cell.value = 'Pending internal approval — not for client circulation';
    styleCell(cell, S.sectionStyle(11));
    row += 1;
    for (const term of pending) {
      sheet.mergeCells(row, 1, row, lastCol);
      const c = sheet.getCell(row, 1);
      c.value = term;
      c.font = { size: 10, italic: true };
      row += 1;
    }
  }
  return sheet;
}

/**
 * Why the plan looks the way it does: fired rules, desk actions and, for a
 * first-time advertiser, the guidance notes. Internal sheet — pull it before
 * the workbook goes to a client.
 */
function addNotesSheet(workbook, plan) {
  const sheet = workbook.addWorksheet('Notes (Internal)');
  const widths = [10, 16, 72, 44];
  widths.forEach((w, i) => { sheet.getColumn(i + 1).width = w; });

  sheet.mergeCells(1, 1, 1, 4);
  const head = sheet.getCell(1, 1);
  head.value = 'Internal notes — remove before sending to client';
  styleCell(head, S.sectionStyle(12));

  let row = 3;
  const section = (label) => {
    sheet.mergeCells(row, 1, row, 4);
    const cell = sheet.getCell(row, 1);
    cell.value = label;
    styleCell(cell, S.sectionStyle(11));
    row += 1;
  };
  const line = (a, b, c, d) => {
    [a, b, c, d].forEach((value, i) => {
      const cell = sheet.getCell(row, i + 1);
      cell.value = value ?? null;
      cell.font = { size: 10 };
      cell.alignment = { vertical: 'top', wrapText: true };
    });
    row += 1;
  };

  if ((plan.flags || []).length) {
    section('Flags — must be resolved before the plan is sent');
    line('Severity', 'Rule', 'What it says', 'Source');
    for (const flag of plan.flags) {
      line(flag.severity, flag.id || '', flag.message, flag.source || '');
    }
    row += 1;
  }

  if ((plan.desk_actions || []).length) {
    section('Desk must confirm');
    for (const action of plan.desk_actions) line('', '', action, '');
    row += 1;
  }

  if ((plan.guidance || []).length) {
    section('Client guidance');
    for (const note of plan.guidance) line('', '', note, '');
  }

  return sheet;
}

/**
 * One workbook for the whole plan. Multi-media briefs (bus + cab + auto) get a
 * Summary sheet, a rate card per medium, terms per medium and internal notes.
 */
async function buildPlanWorkbook(plan) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Excellent Publicity';
  workbook.created = new Date();

  // Placements are known before the sheets exist: the sheet name comes from the
  // spec and the total row from the line count. That lets Summary be created
  // first — in front of the rate cards — while still referencing them.
  const placements = plan.legs.map((leg) => {
    const { spec } = loadSpec(leg.media);
    return {
      sheetName: spec.sheet_name,
      label: spec.label,
      columns: spec.columns,
      totalRow: S.FIRST_DATA_ROW + leg.lines.length
    };
  });

  if (plan.legs.length > 1) addSummarySheet(workbook, plan, placements);
  for (const leg of plan.legs) addMediaSheet(workbook, leg);
  for (const leg of plan.legs) addTermsSheet(workbook, leg);
  addNotesSheet(workbook, plan);

  return workbook;
}

async function writePlanWorkbook(plan, outPath) {
  const workbook = await buildPlanWorkbook(plan);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  await workbook.xlsx.writeFile(outPath);
  return outPath;
}

/**
 * The same workbook as bytes. This is what goes to Appwrite and what an HTTP
 * response streams — on Vercel the filesystem is read-only, so a plan must
 * never need a file on the way out.
 */
async function planWorkbookBuffer(plan) {
  const workbook = await buildPlanWorkbook(plan);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

module.exports = { buildPlanWorkbook, writePlanWorkbook, planWorkbookBuffer, loadSpec };
