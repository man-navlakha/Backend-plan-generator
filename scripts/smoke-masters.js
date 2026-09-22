const assert = require('node:assert/strict');
const app = require('../src/app');

(async () => {
  const server = app.listen(0);
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    async function json(url) {
      const response = await fetch(`${base}${url}`);
      assert.equal(response.status, 200, `${url}: HTTP ${response.status}`);
      return response.json();
    }
    const { catalogs } = await json('/api/masters');
    assert.equal(catalogs.length, 9);
    for (const catalog of catalogs) {
      assert.ok(catalog.products > 0, `${catalog.slug} has no products`);
      const list = await json(`/api/masters/${catalog.slug}/products?page_size=1`);
      assert.equal(list.pagination.total, catalog.products);
      assert.equal(list.data.length, 1);
      const product = await json(`/api/masters/${catalog.slug}/products/${list.data[0].id}`);
      assert.equal(product.id, list.data[0].id);
      assert.ok(product.fields);
      const summary = await json(`/api/masters/${catalog.slug}/problems/summary`);
      assert.equal(summary.issues, catalog.issues);
      const csv = await fetch(`${base}/api/masters/${catalog.slug}/problems.csv`);
      assert.equal(csv.status, 200);
      assert.match(csv.headers.get('content-type'), /text\/csv/);
      const content = await csv.text();
      assert.match(content, /problem_code/);
      console.log(`${catalog.label}: ${catalog.products} products, ${catalog.issues} issues, ${summary.by_code.find((item) => item.code === 'SELLING_BELOW_BUYING')?.count || 0} margin issues`);
    }
    const facets = await json('/api/masters/digital/filters');
    assert.ok(facets.facets['Category (Multiple)'].length > 0);
    const filtered = await json('/api/masters/digital/products?facet=Category%20(Multiple)&facet_value=Entertainment&page_size=1');
    assert.ok(filtered.pagination.total > 0);
    const margin = await json('/api/masters/transit/products?problem=margin&page_size=1');
    assert.ok(margin.pagination.total > 0);
    const cinemaAnnex = await json('/api/masters/cinema/annex');
    assert.ok(cinemaAnnex.data.some((row) => row.sheet === 'Qube Rate Card'));
    const radioAnnex = await json('/api/masters/radio/annex');
    assert.ok(radioAnnex.data.some((row) => row.sheet === 'Pending Fixes'));
    const allCsv = await fetch(`${base}/api/masters/problems.csv`);
    assert.equal(allCsv.status, 200);
    assert.match(await allCsv.text(), /master,issue_id,severity/);
    const image = catalogs.find((item) => item.slug === 'digital');
    assert.ok(image);
    const digitalList = await json('/api/masters/digital/products?page_size=1');
    if (digitalList.data[0].image_url) {
      const asset = await fetch(`${base}${digitalList.data[0].image_url}`);
      assert.equal(asset.status, 200);
    }
    const sourceWorkbook = await fetch(`${base}/master-images/digital/digital-master-10-04-2026.xlsx`);
    assert.equal(sourceWorkbook.status, 404);
    const page = await fetch(`${base}/masters/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Master desks/);
    const ready = await json('/health/ready');
    assert.equal(ready.status, 'ready');
    console.log('Master directory, facets, details and repair CSV: OK');
  } finally { server.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
