const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const formatIndex = require('../assets/formats/format_index.json');
const { loadRules } = require('../rules');
const { resolveField } = require('./resolvers');
const S = require('./style');
const log = require('../log');

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

// Layout taken from "Cinema PAN India 07-04-2025 old.xlsx". The
// supplied workbook is a 26-sheet inventory book, so generated plans reproduce
// its compact client-facing table rather than copying thousands of unused rows.
const CINEMA_LAYOUT = {
  firstCol: 2, // B
  lastCol: 18, // R
  logoFirstRow: 5,
  logoLastRow: 9,
  titleRow: 13,
  headerRow: 14,
  firstDataRow: 15,
  maroon: 'FF510C2C',
  yellow: 'FFFFFF00'
};

const CINEMA_THIN = { style: 'thin', color: { argb: 'FF000000' } };
const CINEMA_MEDIUM = { style: 'medium', color: { argb: 'FF000000' } };

function cinemaBorder(column, { top = 'thin', bottom = 'thin', lastCol = CINEMA_LAYOUT.lastCol } = {}) {
  return {
    left: column === CINEMA_LAYOUT.firstCol ? CINEMA_MEDIUM : CINEMA_THIN,
    right: column === lastCol ? CINEMA_MEDIUM : CINEMA_THIN,
    top: top === 'medium' ? CINEMA_MEDIUM : CINEMA_THIN,
    bottom: bottom === 'medium' ? CINEMA_MEDIUM : CINEMA_THIN
  };
}

function cinemaDataStyle(type, column, lastCol = CINEMA_LAYOUT.lastCol) {
  return {
    font: { name: 'Calibri', size: 11, color: { argb: 'FF000000' } },
    alignment: { horizontal: 'center', vertical: 'middle', wrapText: true },
    border: cinemaBorder(column, { lastCol }),
    numFmt: type === 'money' ? '"₹" #,##0' : type === 'int' || type === 'sr' ? '#,##0' : '@'
  };
}

function addCinemaLogo(workbook, sheet, lastCol = CINEMA_LAYOUT.lastCol) {
  sheet.mergeCells(
    CINEMA_LAYOUT.logoFirstRow,
    CINEMA_LAYOUT.firstCol,
    CINEMA_LAYOUT.logoLastRow,
    lastCol
  );
  const band = sheet.getCell(CINEMA_LAYOUT.logoFirstRow, CINEMA_LAYOUT.firstCol);
  band.fill = S.fill('FFFFFFFF');
  band.alignment = { horizontal: 'center', vertical: 'middle' };
  band.border = { top: CINEMA_MEDIUM, left: CINEMA_MEDIUM, right: CINEMA_MEDIUM };

  if (!fs.existsSync(LOGO_PATH)) return;
  const imageId = workbook.addImage({ filename: LOGO_PATH, extension: 'png' });
  sheet.addImage(imageId, {
    tl: { col: 9, row: 4.35 },
    ext: { width: 98, height: 86 },
    editAs: 'oneCell'
  });
}

function cinemaActivitySeconds(lines) {
  const values = [...new Set((lines || []).map((line) => Number(line.qty)).filter((n) => n > 0))];
  if (!values.length) return 10;
  if (values.length === 1) return values[0];
  return `${Math.min(...values)}-${Math.max(...values)}`;
}

function sumLines(lines, field) {
  return (lines || []).reduce((sum, line) => sum + (Number(line[field]) || 0), 0);
}

/** Cinema rate card in the exact B:R structure used by the supplied PAN-India workbook. */
function addCinemaMediaSheet(workbook, leg, plan, spec, renderOptions = {}) {
  /*
   * An inventory sheet is the same sheet with the buying taken out of it: the
   * columns that describe a booking go, the rate covers the whole flight
   * instead of one week of it, and the cost footer has nothing to total.
   */
  const inventoryLayout = renderOptions.inventory ?? (plan.mode === 'inventory');
  const variant = inventoryLayout ? (spec.inventory_layout || {}) : null;
  const omitted = new Set(variant?.omit_fields || []);
  const columns = spec.columns.filter((column) => !omitted.has(column.field));
  const lastCol = CINEMA_LAYOUT.firstCol + columns.length - 1;
  const sheetName = renderOptions.sheetName || spec.sheet_name;
  const sheet = workbook.addWorksheet(sheetName, {
    pageSetup: {
      orientation: 'landscape',
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
      margins: { left: 0.7, right: 0.7, top: 0.75, bottom: 0.75, header: 0.3, footer: 0.3 }
    }
  });

  columns.forEach((column, index) => {
    sheet.getColumn(CINEMA_LAYOUT.firstCol + index).width = column.width || 8.43;
  });

  sheet.getRow(4).height = 15.75;
  sheet.getRow(8).height = 34.15;
  sheet.getRow(9).height = 59.45;
  sheet.getRow(10).height = 14.45;
  sheet.getRow(11).height = 11.45;
  sheet.getRow(12).height = 9.6;
  sheet.getRow(CINEMA_LAYOUT.titleRow).height = 18.75;
  sheet.getRow(CINEMA_LAYOUT.headerRow).height = 47.25;

  addCinemaLogo(workbook, sheet, lastCol);

  const activitySeconds = cinemaActivitySeconds(leg.lines);
  const activity = sheet.getCell('C10');
  activity.value = `Activity : ${activitySeconds} Sec A/V Format`;
  activity.font = { name: 'Calibri', size: 11, bold: true };
  activity.alignment = { horizontal: 'center', vertical: 'middle' };

  const duration = sheet.getCell('C11');
  duration.value = `Duration : ${leg.duration_label || ''}`.trim();
  duration.font = { name: 'Calibri', size: 11, bold: true, color: { argb: 'FF00B0F0' } };
  duration.alignment = { horizontal: 'center', vertical: 'middle' };

  sheet.mergeCells(`E10:${numberToLetter(lastCol)}12`);
  const client = sheet.getCell('E10');
  client.value = [
    plan.client_name ? `Client : ${plan.client_name}` : null,
    plan.objective ? `Objective : ${plan.objective}` : null,
    plan.target_location ? `Location : ${plan.target_location}` : null
  ].filter(Boolean).join('\n');
  client.font = { name: 'Calibri', size: 10, bold: true };
  client.alignment = { horizontal: 'left', vertical: 'middle', wrapText: true };
  client.border = { top: CINEMA_MEDIUM, right: CINEMA_MEDIUM };

  sheet.mergeCells(
    CINEMA_LAYOUT.titleRow,
    CINEMA_LAYOUT.firstCol,
    CINEMA_LAYOUT.titleRow,
    lastCol
  );
  const title = sheet.getCell(CINEMA_LAYOUT.titleRow, CINEMA_LAYOUT.firstCol);
  title.value = renderOptions.title || spec.title;
  title.font = { name: 'Calibri', size: 14, bold: true, color: { argb: 'FFFFFFFF' } };
  title.fill = S.fill(CINEMA_LAYOUT.maroon);
  title.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
  title.border = { left: CINEMA_MEDIUM, right: CINEMA_MEDIUM };

  const rateHeader = variant?.rate_header
    ? variant.rate_header
        .replace('{seconds}', activitySeconds)
        .replace('{duration}', leg.duration_label || '1 Week')
    : `Rates for ${activitySeconds} Sec :A/V Slide  (1 Week)`;

  columns.forEach((column, index) => {
    const columnNumber = CINEMA_LAYOUT.firstCol + index;
    const cell = sheet.getCell(CINEMA_LAYOUT.headerRow, columnNumber);
    cell.value = column.field === 'cinema_weekly_rate' ? rateHeader : column.header;
    cell.font = { name: 'Calibri', size: 12, bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = S.fill(CINEMA_LAYOUT.maroon);
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    cell.border = cinemaBorder(columnNumber, { lastCol });
  });

  leg.lines.forEach((line, index) => {
    const rowNumber = CINEMA_LAYOUT.firstDataRow + index;
    sheet.getRow(rowNumber).height = 28.9;
    columns.forEach((column, columnIndex) => {
      const columnNumber = CINEMA_LAYOUT.firstCol + columnIndex;
      const cell = sheet.getCell(rowNumber, columnNumber);
      const field = column.field === 'cinema_weekly_rate' && variant?.rate_field
        ? variant.rate_field
        : column.field;
      cell.value = resolveField(field, line, { index, leg });
      styleCell(cell, cinemaDataStyle(column.type, columnNumber, lastCol));
    });
  });

  const lastDataRow = CINEMA_LAYOUT.firstDataRow + leg.lines.length - 1;
  const footerStart = lastDataRow + 1;
  const weeks = Math.max(1, Number(leg.lines[0]?.months) || 1);
  const weeklyTotal = leg.lines.reduce(
    (sum, line, index) => sum + (Number(resolveField('cinema_weekly_rate', line, { index, leg })) || 0),
    0
  );
  const mediaCharges = (plan.charges || []).filter((charge) => charge.media === leg.media);
  const conversionNet = mediaCharges.reduce((sum, charge) => sum + (Number(charge.net) || 0), 0);
  const conversionGst = mediaCharges.reduce((sum, charge) => sum + (Number(charge.gst) || 0), 0);
  const actualNet = sumLines(leg.lines, 'net');
  const subTotal = actualNet + conversionNet;
  const gst = sumLines(leg.lines, 'gst') + conversionGst;
  const total = subTotal + gst;

  const footerRows = variant ? [] : [
    {
      label: `Total Screens : ${leg.lines.length}`,
      value: { formula: `SUM(R${CINEMA_LAYOUT.firstDataRow}:R${lastDataRow})`, result: weeklyTotal }
    },
    {
      label: `Actual Cost : ${leg.duration_label || `${weeks} Weeks`}`,
      value: { formula: `R${footerStart}*${weeks}`, result: actualNet },
      yellow: true
    },
    { label: 'Making & Conversion Cost per Creative', value: conversionNet },
    {
      label: 'Sub Total',
      value: { formula: `R${footerStart + 1}+R${footerStart + 2}`, result: subTotal }
    },
    { label: 'GST @ 18%', value: { formula: `R${footerStart + 3}*18%`, result: gst } },
    {
      label: 'Total Cost',
      value: { formula: `R${footerStart + 4}+R${footerStart + 3}`, result: total },
      total: true
    }
  ];

  footerRows.forEach((item, index) => {
    const rowNumber = footerStart + index;
    sheet.mergeCells(rowNumber, CINEMA_LAYOUT.firstCol, rowNumber, lastCol - 1);
    const label = sheet.getCell(rowNumber, CINEMA_LAYOUT.firstCol);
    label.value = item.label;
    label.font = {
      name: 'Calibri',
      size: 11,
      bold: true,
      italic: true,
      color: { argb: item.total ? 'FFFFFFFF' : 'FF000000' }
    };
    label.fill = item.total ? S.fill(CINEMA_LAYOUT.maroon) : S.fill('FFFFFFFF');
    label.alignment = { horizontal: 'left', vertical: 'middle', wrapText: true };
    label.border = {
      left: CINEMA_MEDIUM,
      top: CINEMA_THIN,
      bottom: item.total ? CINEMA_MEDIUM : CINEMA_THIN
    };

    const value = sheet.getCell(rowNumber, lastCol);
    value.value = item.value;
    value.numFmt = '"₹" #,##0.00';
    value.font = { name: 'Calibri', size: 11, italic: item.total };
    value.fill = S.fill(item.yellow ? CINEMA_LAYOUT.yellow : 'FFFFFFFF');
    value.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    value.border = cinemaBorder(lastCol, {
      lastCol,
      bottom: item.total ? 'medium' : 'thin'
    });
  });

  sheet.views = [{ state: 'normal', showGridLines: true, zoomScale: 80 }];
  return {
    sheetName,
    totalRow: footerRows.length ? footerStart + footerRows.length - 1 : null,
    columns,
    label: spec.label,
    firstDataRow: CINEMA_LAYOUT.firstDataRow
  };
}

/** One medium's rate card: the sheet the client reads. */
function addMediaSheet(workbook, leg, plan, renderOptions = {}) {
  const { spec } = loadSpec(leg.media);
  if (spec.layout === 'cinema_pan_india_2025') {
    return addCinemaMediaSheet(workbook, leg, plan, spec, renderOptions);
  }
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

  for (const charge of plan.charges || []) {
    const cells = [
      null,
      charge.media || 'Charge',
      charge.label,
      charge.quantity || null,
      null,
      charge.net,
      charge.gst,
      charge.total
    ];
    const types = ['sr', 'text', 'text', 'int', 'text', 'money', 'money', 'money'];
    cells.forEach((value, i) => {
      const cell = sheet.getCell(row, i + 1);
      cell.value = value ?? null;
      styleCell(cell, S.dataStyle(types[i]));
      cell.font = { size: 11, italic: true };
    });
    row += 1;
  }

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
  const chargeField = (field) => (plan.charges || [])
    .reduce((sum, charge) => sum + (Number(charge[field]) || 0), 0);
  const reserveTotal = (plan.reserves || []).reduce((s, r) => s + (Number(r.amount) || 0), 0);
  const totals = {
    net: sumField('net') + chargeField('net'),
    gst: sumField('gst') + chargeField('gst'),
    total: sumField('total') + chargeField('total') + reserveTotal
  };

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
  const columnIndex = placement.columns.findIndex((column) => column.field === field);
  const result = (leg ? leg.lines : []).reduce(
    (sum, line, index) => sum + (Number(resolveField(field, line, { index, leg })) || 0),
    0
  );
  // Some client rate-card templates do not expose qty/net/GST/total columns.
  // In that case a cross-sheet formula would incorrectly point at column A;
  // use the calculated value directly instead.
  if (columnIndex < 0) return result;
  const letter = columnLetterFor(placement, field);
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
 * One worksheet per medium.
 *
 * Model-backed or historical plans can contain repeated legs whose media names
 * differ only in case (for example `Auto` and `AUTO`). Excel worksheet names
 * are case-insensitive, so rendering those legs separately throws before the
 * workbook can be uploaded. Merge by the canonical format sheet name and keep
 * every priced line.
 */
function mergeLegsForWorkbook(legs = []) {
  const bySheet = new Map();
  for (const leg of legs) {
    const { spec } = loadSpec(leg.media);
    const key = String(spec.sheet_name).toLowerCase();
    const existing = bySheet.get(key);
    if (!existing) {
      bySheet.set(key, {
        ...leg,
        lines: [...(leg.lines || [])],
        notes: [...new Set(leg.notes || [])]
      });
      continue;
    }

    existing.lines.push(...(leg.lines || []));
    existing.notes = [...new Set([...(existing.notes || []), ...(leg.notes || [])])];
    existing.scope = [...new Set([existing.scope, leg.scope].filter(Boolean))]
      .join('; ')
      .slice(0, 300);
  }
  return [...bySheet.values()];
}

function duplicateWorksheetLegs(legs = []) {
  const groups = new Map();
  for (const leg of legs) {
    const { spec } = loadSpec(leg.media);
    const key = String(spec.sheet_name).toLowerCase();
    const group = groups.get(key) || { sheet_name: spec.sheet_name, media: [], lines: 0 };
    group.media.push(leg.media);
    group.lines += (leg.lines || []).length;
    groups.set(key, group);
  }
  return [...groups.values()].filter((group) => group.media.length > 1);
}

function renderContext(context = {}) {
  return {
    request_id: context.requestId,
    plan_id: context.planId,
    deal_id: context.dealId
  };
}

/**
 * One workbook for the whole plan. Multi-media briefs (bus + cab + auto) get a
 * Summary sheet, a rate card per medium, terms per medium and internal notes.
 */
async function buildPlanWorkbook(plan, context = {}) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Excellent Publicity';
  workbook.created = new Date();

  const renderLegs = mergeLegsForWorkbook(plan.legs || []);
  const allClientOptionsLegs = mergeLegsForWorkbook(plan.client_options_legs || []);
  const clientOptionsLegs = allClientOptionsLegs.filter((leg) =>
    loadSpec(leg.media).spec.layout === 'cinema_pan_india_2025'
  );
  const renderPlan = { ...plan, legs: renderLegs, client_options_legs: clientOptionsLegs };
  const duplicateLegs = [
    ...duplicateWorksheetLegs(plan.legs || []),
    ...duplicateWorksheetLegs(plan.client_options_legs || [])
  ];

  if (duplicateLegs.length) {
    log.warn('workbook.duplicate_legs_merged', {
      ...renderContext(context),
      groups: duplicateLegs
    });
  }

  const ignoredClientOptions = allClientOptionsLegs.filter((leg) => !clientOptionsLegs.includes(leg));
  if (ignoredClientOptions.length) {
    log.warn('workbook.non_cinema_options_ignored', {
      ...renderContext(context),
      media: ignoredClientOptions.map((leg) => leg.media)
    });
  }

  // Placements are known before the sheets exist: the sheet name comes from the
  // spec and the total row from the line count. That lets Summary be created
  // first — in front of the rate cards — while still referencing them.
  const optionMedia = new Set(clientOptionsLegs.map((leg) => String(leg.media).toLowerCase()));
  const placements = renderLegs.map((leg) => {
    const { spec } = loadSpec(leg.media);
    const hasOptionsSheet = optionMedia.has(String(leg.media).toLowerCase()) &&
      spec.layout === 'cinema_pan_india_2025';
    return {
      sheetName: hasOptionsSheet ? 'Recommended Plan' : spec.sheet_name,
      label: spec.label,
      columns: spec.columns,
      totalRow: S.FIRST_DATA_ROW + leg.lines.length
    };
  });

  /*
   * A single-medium workbook still needs budget, quantities and totals. Without
   * Summary, rate-card formats such as Cinema look empty and do not reconcile
   * the generated plan to the client budget.
   *
   * An inventory sheet has no budget to reconcile to and nothing bought to
   * total. A Summary over it would add up every screen on the list and present
   * the sum as the cost of the campaign, which is not what the client is being
   * offered -- they are being asked to choose from it. So it is left out.
  */
  if (renderPlan.mode !== 'inventory') addSummarySheet(workbook, renderPlan, placements);
  for (const leg of clientOptionsLegs) {
    addMediaSheet(workbook, leg, renderPlan, {
      inventory: true,
      sheetName: 'Plan',
      title: 'ALL MATCHING CINEMA OPTIONS'
    });
  }
  for (const leg of renderLegs) {
    const recommended = optionMedia.has(String(leg.media).toLowerCase());
    addMediaSheet(workbook, leg, renderPlan, recommended ? {
      inventory: renderPlan.mode === 'inventory',
      sheetName: 'Recommended Plan',
      title: 'RECOMMENDED CINEMA PLAN'
    } : {});
  }
  for (const leg of renderLegs) addTermsSheet(workbook, leg);
  addNotesSheet(workbook, renderPlan);

  return workbook;
}

async function writePlanWorkbook(plan, outPath, context = {}) {
  const workbook = await buildPlanWorkbook(plan, context);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  await workbook.xlsx.writeFile(outPath);
  return outPath;
}

/**
 * The same workbook as bytes. This is what goes to Appwrite and what an HTTP
 * response streams — on Vercel the filesystem is read-only, so a plan must
 * never need a file on the way out.
 */
async function planWorkbookBuffer(plan, context = {}) {
  const started = Date.now();
  log.info('workbook.render.started', {
    ...renderContext(context),
    mode: plan.mode || 'plan',
    leg_count: (plan.legs || []).length,
    client_option_leg_count: (plan.client_options_legs || []).length
  });

  try {
    const workbook = await buildPlanWorkbook(plan, context);
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    log.info('workbook.render.completed', {
      ...renderContext(context),
      sheets: workbook.worksheets.map((sheet) => sheet.name),
      bytes: buffer.length,
      duration_ms: Date.now() - started
    });
    return buffer;
  } catch (error) {
    log.error('workbook.render.failed', {
      ...renderContext(context),
      duration_ms: Date.now() - started,
      error: log.errorDetails(error)
    });
    throw error;
  }
}

module.exports = {
  buildPlanWorkbook,
  writePlanWorkbook,
  planWorkbookBuffer,
  loadSpec,
  mergeLegsForWorkbook
};
