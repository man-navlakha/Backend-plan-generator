/**
 * EP house style, read off the blank templates in assets/formats so a generated
 * sheet and a hand-made one look identical.
 */

const MAROON = 'FF510C3C';
const TOTAL_BAND = 'FFFCF7F3';
const WHITE = 'FFFFFFFF';
const BLACK = 'FF000000';

// Row layout, matching Bus.xlsx: logo band 1-4, title 5, headers 6, data from 7.
const LOGO_BAND = { first: 1, last: 4 };
const TITLE_ROW = 5;
const HEADER_ROW = 6;
const FIRST_DATA_ROW = 7;

const ROW_HEIGHT = { 1: 30, 2: 30, 3: 30, 4: 24, [TITLE_ROW]: 25.25, [HEADER_ROW]: 45, data: 21 };

// Logo is 608x531; scale to sit inside the 114pt band without distortion.
const LOGO = { width: 131, height: 114 };

const NUM_FMT = {
  sr: '0',
  int: '#,##0',
  money: '#,##0',
  money2: '#,##0.00',
  text: '@'
};

// Columns that mean something when added up. Rates and per-unit figures do not.
const SUMMABLE = new Set(['qty', 'net', 'gst', 'total', 'cost', 'total_seconds']);

const THIN = { style: 'thin', color: { argb: 'FFBFBFBF' } };
const BORDER = { top: THIN, left: THIN, bottom: THIN, right: THIN };

function fill(argb) {
  return { type: 'pattern', pattern: 'solid', fgColor: { argb } };
}

// Excel character-width -> pixel conversion for the default Calibri 11 font
// (max digit width 7px): the same formula Excel itself uses to lay out columns.
function colWidthToPx(width) {
  return Math.round((width || 8.43) * 7 + 5);
}

// 1 point = 4/3 px at 96 DPI.
function rowHeightToPx(height) {
  return (height || 15) * (96 / 72);
}

/**
 * Band-relative anchor {col, row} that centers a fixed-size image inside a
 * run of columns/rows. Both values are in ExcelJS's own oneCellAnchor units,
 * where the integer part is a 0-based index into the band and the fractional
 * part is how far across that one column/row the image starts — so callers
 * add their band's starting column/row (0-based) to get the sheet anchor.
 */
function centerImageAnchor({ colWidths, rowHeights, imageWidth, imageHeight }) {
  const offsetWithin = (sizesPx, targetPx) => {
    let consumed = 0;
    for (let i = 0; i < sizesPx.length; i += 1) {
      const size = sizesPx[i];
      const isLast = i === sizesPx.length - 1;
      if (isLast || targetPx < consumed + size) {
        const within = size > 0 ? Math.min(1, Math.max(0, (targetPx - consumed) / size)) : 0;
        return i + within;
      }
      consumed += size;
    }
    return 0;
  };

  const colPx = colWidths.map(colWidthToPx);
  const rowPx = rowHeights.map(rowHeightToPx);
  const bandWidth = colPx.reduce((a, b) => a + b, 0);
  const bandHeight = rowPx.reduce((a, b) => a + b, 0);
  const left = Math.max(0, (bandWidth - imageWidth) / 2);
  const top = Math.max(0, (bandHeight - imageHeight) / 2);

  return { col: offsetWithin(colPx, left), row: offsetWithin(rowPx, top) };
}

function titleStyle() {
  return {
    font: { bold: true, size: 16, color: { argb: WHITE } },
    fill: fill(MAROON),
    alignment: { horizontal: 'center', vertical: 'middle' }
  };
}

function headerStyle() {
  return {
    font: { bold: true, size: 12, color: { argb: WHITE } },
    fill: fill(MAROON),
    alignment: { horizontal: 'center', vertical: 'middle', wrapText: true },
    border: BORDER
  };
}

function dataStyle(type) {
  const numeric = type !== 'text';
  return {
    font: { size: 11 },
    alignment: {
      horizontal: type === 'sr' ? 'center' : numeric ? 'right' : 'center',
      vertical: 'middle',
      wrapText: type === 'text'
    },
    border: BORDER,
    numFmt: NUM_FMT[type] || NUM_FMT.text
  };
}

function totalStyle(type) {
  return {
    font: { bold: true, size: type ? 11 : 12, color: { argb: BLACK } },
    fill: fill(TOTAL_BAND),
    alignment: { horizontal: type ? 'right' : 'left', vertical: 'middle' },
    border: BORDER,
    numFmt: type ? NUM_FMT[type] || NUM_FMT.money : NUM_FMT.text
  };
}

function sectionStyle(size = 12) {
  return {
    font: { bold: true, size, color: { argb: WHITE } },
    fill: fill(MAROON),
    alignment: { horizontal: 'left', vertical: 'middle' }
  };
}

module.exports = {
  MAROON, TOTAL_BAND, WHITE, BLACK,
  LOGO_BAND, TITLE_ROW, HEADER_ROW, FIRST_DATA_ROW, ROW_HEIGHT, LOGO,
  NUM_FMT, SUMMABLE, BORDER,
  fill, titleStyle, headerStyle, dataStyle, totalStyle, sectionStyle,
  colWidthToPx, rowHeightToPx, centerImageAnchor
};
