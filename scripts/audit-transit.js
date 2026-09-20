const fs = require('fs');
const path = require('path');
const { db } = require('../src/db');

const imageDirectory = path.resolve(__dirname, '../src/assets/Masters/Transit/product-images');
const all = (sql) => db.prepare(sql).all();

console.log('Product field gaps', all(`
  SELECT SUM(image IS NULL) image, SUM(media_type IS NULL) media,
    SUM(tier IS NULL) tier, SUM(size_dimension IS NULL) size,
    SUM(short_description IS NULL) description
  FROM products
`));
console.log('Price-option field gaps', all(`
  SELECT SUM(image IS NULL) image, SUM(minimum_billing IS NULL) minimum_billing,
    SUM(offer_rate IS NULL) offer_rate, SUM(specific_buying_rate IS NULL) buying_rate,
    SUM(pricing_unit IS NULL) pricing_unit, SUM(gst IS NULL) gst
  FROM price_options
`));
console.log('Duplicate product SKUs', all(`
  SELECT sku, COUNT(*) count, GROUP_CONCAT(name, ' | ') names
  FROM products GROUP BY sku HAVING count > 1
`));
console.log('Duplicate price-option SKUs', all(`
  SELECT sku, COUNT(*) count, GROUP_CONCAT(product_name, ' | ') names
  FROM price_options GROUP BY sku HAVING count > 1
`));
console.log('Products without price options', all(`
  SELECT COUNT(*) count FROM products p
  LEFT JOIN price_options po ON po.product_id = p.id
  WHERE po.id IS NULL
`));
console.log('Invalid SKUs', {
  products: all("SELECT COUNT(*) count FROM products WHERE sku GLOB '*[^A-Za-z0-9]*'")[0].count,
  priceOptions: all("SELECT COUNT(*) count FROM price_options WHERE sku GLOB '*[^A-Za-z0-9]*'")[0].count
});
console.log('Non-positive rates', all(`
  SELECT SUM(offer_rate <= 0) offer, SUM(minimum_billing <= 0) billing,
    SUM(specific_buying_rate <= 0) buying
  FROM price_options
`));
console.log('Client rates below buying cost', all(`
  SELECT COUNT(*) price_options, COUNT(DISTINCT product_id) affected_products
  FROM price_options
  WHERE specific_buying_rate IS NOT NULL AND (
    (offer_rate IS NOT NULL AND offer_rate < specific_buying_rate) OR
    (discounted_rate IS NOT NULL AND discounted_rate < specific_buying_rate)
  )
`));

const productImages = all('SELECT id, image FROM products WHERE image IS NOT NULL');
const priceOptionImages = all('SELECT id, image FROM price_options WHERE image IS NOT NULL');
console.log('Missing image files', {
  products: productImages.filter(({ image }) => !fs.existsSync(path.join(imageDirectory, image))).length,
  priceOptions: priceOptionImages.filter(({ image }) => !fs.existsSync(path.join(imageDirectory, image))).length,
  totalProductReferences: productImages.length,
  totalPriceOptionReferences: priceOptionImages.length
});
console.log('Media types', all('SELECT media_type, COUNT(*) count FROM products GROUP BY media_type'));
