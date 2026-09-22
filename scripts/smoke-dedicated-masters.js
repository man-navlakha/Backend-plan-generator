const assert = require('node:assert/strict');
const app = require('../src/app');

const media = [
  ['btl', 'btl'], ['digital', 'digital'], ['digital-pr', 'digital_pr'],
  ['magazine', 'magazine'], ['newspaper', 'newspaper'], ['tv', 'tv']
];

(async () => {
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  async function json(path) {
    const response = await fetch(`${base}${path}`);
    assert.equal(response.status, 200, `${path}: ${response.status}`);
    return response.json();
  }
  try {
    for (const [path, slug] of media) {
      const page = await fetch(`${base}/${path}/`);
      assert.equal(page.status, 200);
      const html = await page.text();
      assert.match(html, new RegExp(`data-media="${path}"`));
      const stats = await json(`/api/masters/${slug}/stats`);
      assert.ok(stats.products > 0, `${slug} has no products`);
      const filters = await json(`/api/masters/${slug}/filters`);
      assert.ok(Object.keys(filters.facets).length > 0);
      const results = await json(`/api/masters/${slug}/products?page_size=2`);
      assert.equal(results.pagination.total, stats.products);
      const detail = await json(`/api/masters/${slug}/products/${results.data[0].id}`);
      assert.ok(detail.fields && detail.rows);
      const problems = await json(`/api/masters/${slug}/problems/summary`);
      assert.equal(problems.issues, stats.issues);
      const csv = await fetch(`${base}/api/masters/${slug}/problems.csv`);
      assert.equal(csv.status, 200);
      console.log(`${path}: ${stats.products} products, ${stats.price_options} options, ${stats.issues} findings`);
    }
    const digital = await json('/api/masters/digital/products?facet_1=Pricing%20Model%20(Multiple)&facet_value_1=CPM&facet_2=Category%20(Multiple)&facet_value_2=Entertainment&page_size=1');
    assert.ok(digital.pagination.total > 0, 'multi-facet filtering failed');
    const newspaper = await json('/api/masters/newspaper/products?city=Ahmedabad&page_size=1');
    assert.ok(newspaper.pagination.total > 0, 'city filtering failed');
    const assets = await fetch(`${base}/media-catalog/styles.css`);
    assert.equal(assets.status, 200);
    console.log('Dedicated pages, media filters, details, and CSV exports: OK');
  } finally { server.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
