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
  fill, titleStyle, headerStyle, dataStyle, totalStyle, sectionStyle
};
