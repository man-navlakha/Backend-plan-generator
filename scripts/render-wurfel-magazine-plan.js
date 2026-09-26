const assert = require('node:assert/strict');
const path = require('node:path');
const ExcelJS = require('exceljs');

const referencePath = path.join(
  __dirname,
  '../output/Magazine New Proposal - Wurfel Kuche - 02.09.2026 (1).xlsx'
);
const outputPath = path.join(
  __dirname,
  '../output/18468-Wurfel-Kuche-Magazine-Proposal-Revised.xlsx'
);

async function main() {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(referencePath);
  const sheet = workbook.getWorksheet('Magazine');
  assert.ok(sheet, 'The approved reference workbook has no Magazine sheet');

  const proposalRows = [8, 9, 10, 11, 12].map((rowNumber) => ({
    publication: sheet.getCell(rowNumber, 2).value,
    adSize: sheet.getCell(rowNumber, 5).value,
    pagePosition: sheet.getCell(rowNumber, 6).value
  }));

  for (const requested of ['India Today Home', 'Forbes India', 'Good Homes']) {
    assert.ok(
      proposalRows.some((row) => row.publication === requested),
      `The client-requested ${requested} row is missing`
    );
  }
  for (const row of proposalRows) {
    assert.ok(row.adSize, `${row.publication}: advertisement size is blank`);
    assert.ok(row.pagePosition, `${row.publication}: page position is blank`);
  }

  workbook.subject = 'Sub-deal 18468 - Wurfel Kuche Magazine proposal';
  workbook.keywords = 'Wurfel Kuche, Magazine, India Today Home, Forbes India, Good Homes';
  workbook.modified = new Date();
  await workbook.xlsx.writeFile(outputPath);

  console.log(outputPath);
  console.table(proposalRows);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
