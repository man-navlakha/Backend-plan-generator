const state = { loading: false, controller: null };
const elements = {
  form: document.querySelector('#filter-form'),
  search: document.querySelector('#search'),
  mediaType: document.querySelector('#media-type'),
  tier: document.querySelector('#tier'),
  problem: document.querySelector('#problem'),
  sort: document.querySelector('#sort'),
  reset: document.querySelector('#reset'),
  inventory: document.querySelector('#inventory'),
  resultLabel: document.querySelector('#result-label'),
  mediaStrip: document.querySelector('#media-strip'),
  drawerShell: document.querySelector('#drawer-shell'),
  drawer: document.querySelector('#drawer'),
  drawerContent: document.querySelector('#drawer-content')
};

const currency = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
const integer = new Intl.NumberFormat('en-IN');

async function initialize() {
  bindEvents();
  try {
    const [stats, filters] = await Promise.all([getJson('/api/transit/stats'), getJson('/api/transit/filters')]);
    renderStats(stats);
    renderFilters(filters, stats.media);
  } catch (error) {
    console.error(error);
  }
  await loadProducts();
  const sharedProductId = Number.parseInt(new URLSearchParams(window.location.search).get('product'), 10);
  if (Number.isInteger(sharedProductId) && sharedProductId > 0) await openDrawer(sharedProductId, false);
}

function bindEvents() {
  let searchTimer;
  elements.search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => loadProducts(), 260);
  });
  for (const input of [elements.mediaType, elements.tier, elements.problem, elements.sort]) {
    input.addEventListener('change', () => { loadProducts(); syncChips(); });
  }
  elements.form.addEventListener('submit', (event) => { event.preventDefault(); loadProducts(); });
  elements.reset.addEventListener('click', () => {
    elements.form.reset();
    syncChips();
    loadProducts();
  });
  document.querySelector('#drawer-close').addEventListener('click', closeDrawer);
  document.querySelector('#drawer-scrim').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeDrawer(); });
}

function renderStats(stats) {
  document.querySelector('#stat-products').textContent = integer.format(stats.products);
  document.querySelector('#stat-options').textContent = integer.format(stats.price_options);
  document.querySelector('#stat-units').textContent = integer.format(stats.price_units);
  document.querySelector('#stat-media').textContent = integer.format(stats.media_types);
  document.querySelector('#quality-issues').textContent = integer.format(stats.issues);
  document.querySelector('#quality-products').textContent = integer.format(stats.affected_products);
  document.querySelector('#last-sync').textContent = stats.imported_at
    ? `Synced ${new Date(stats.imported_at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })}`
    : 'Awaiting import';
}

function renderFilters(filters, media) {
  for (const value of filters.media_types) elements.mediaType.add(new Option(value, value));
  for (const value of filters.tiers) elements.tier.add(new Option(value, value));
  elements.mediaStrip.replaceChildren(...media.map((item) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'media-chip';
    button.dataset.value = item.name;
    button.append(item.name, Object.assign(document.createElement('b'), { textContent: integer.format(item.count) }));
    button.addEventListener('click', () => {
      elements.mediaType.value = elements.mediaType.value === item.name ? '' : item.name;
      syncChips();
      loadProducts();
    });
    return button;
  }));
}

function syncChips() {
  for (const chip of elements.mediaStrip.children) chip.classList.toggle('active', chip.dataset.value === elements.mediaType.value);
}

async function loadProducts() {
  if (state.controller) state.controller.abort();
  state.controller = new AbortController();
  state.loading = true;
  elements.inventory.replaceChildren(document.querySelector('#loading-template').content.cloneNode(true));
  const query = new URLSearchParams({ show_all: 1, sort: elements.sort.value });
  if (elements.search.value.trim()) query.set('search', elements.search.value.trim());
  if (elements.mediaType.value) query.set('media_type', elements.mediaType.value);
  if (elements.tier.value) query.set('tier', elements.tier.value);
  if (elements.problem.value) query.set('problem', elements.problem.value);

  try {
    const result = await getJson(`/api/transit/products?${query}`, state.controller.signal);
    renderProducts(result.data);
    elements.resultLabel.textContent = `${integer.format(result.pagination.total)} products · all shown`;
  } catch (error) {
    if (error.name !== 'AbortError') {
      elements.inventory.innerHTML = '<div class="error-state"><b>Database unavailable</b><span>Could not load transit inventory. Try again shortly.</span></div>';
      console.error(error);
    }
  } finally {
    state.loading = false;
  }
}

function renderProducts(products) {
  if (!products.length) {
    elements.inventory.innerHTML = '<div class="empty-state"><b>No route found</b><span>Try another city, SKU or network filter.</span></div>';
    return;
  }
  elements.inventory.replaceChildren(...products.map(productRow));
}

function productRow(product) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'inventory-row';
  button.addEventListener('click', () => openDrawer(product.id));

  const imageUrl = product.image ? `/transit-images/${encodeURIComponent(product.image)}` : '';
  const rate = product.min_rate === null ? 'On request' : currency.format(product.min_rate);
  const buying = product.min_buying_rate === null ? 'not set' : currency.format(product.min_buying_rate);
  const rateNote = `client from · buying from ${buying}`;
  button.innerHTML = `
    <span class="asset">
      <span class="asset-image" data-code="${escapeHtml(product.media_type || 'Transit')}">${imageUrl ? `<img src="${imageUrl}" alt="" loading="lazy">` : ''}</span>
      <span class="asset-copy"><strong>${escapeHtml(product.name)}</strong><span class="asset-flags"><small class="sku">${escapeHtml(product.sku)}</small>${product.issue_count ? `<span class="issue-badge ${product.error_count ? '' : 'warning'}">${product.issue_count} problem${product.issue_count === 1 ? '' : 's'}</span>` : ''}</span></span>
    </span>
    <span class="network-tag">${escapeHtml(product.media_type || 'Transit')}</span>
    <span class="spec"><strong>${escapeHtml(product.size_dimension || 'Not specified')}</strong><small>${escapeHtml(product.tier || 'No tier')}</small></span>
    <span class="rate"><strong>${rate}</strong><small>${rateNote}</small>${product.loss_price_count ? `<span class="loss-note">${product.loss_price_count} below cost</span>` : ''}</span>
    <span class="row-arrow">↗</span>`;
  const image = button.querySelector('img');
  if (image) image.addEventListener('error', () => image.parentElement.classList.add('is-fallback'));
  else button.querySelector('.asset-image').classList.add('is-fallback');
  return button;
}

async function openDrawer(id, updateUrl = true) {
  elements.drawerShell.hidden = false;
  document.body.style.overflow = 'hidden';
  if (updateUrl) {
    const url = new URL(window.location.href);
    url.searchParams.set('product', id);
    history.replaceState(null, '', url);
  }
  elements.drawerContent.innerHTML = '<div class="drawer-loading">Reading master…</div>';
  elements.drawer.focus();
  try {
    const product = await getJson(`/api/transit/products/${id}`);
    renderDrawer(product);
  } catch (error) {
    elements.drawerContent.innerHTML = '<div class="error-state"><b>Details unavailable</b><span>Please close this panel and try again.</span></div>';
  }
}

function closeDrawer() {
  if (elements.drawerShell.hidden) return;
  elements.drawerShell.hidden = true;
  document.body.style.overflow = '';
  const url = new URL(window.location.href);
  url.searchParams.delete('product');
  history.replaceState(null, '', url);
}

function renderDrawer(product) {
  const imageUrl = product.image ? `/transit-images/${encodeURIComponent(product.image)}` : '';
  const lossCount = product.price_options.filter((option) => option.has_loss).length;
  const errorCount = product.issues.filter((issue) => issue.severity === 'error').length;
  const effectiveRates = product.price_options
    .map((option) => option.effective_client_rate)
    .filter((value) => value !== null);
  const clientPriceFrom = effectiveRates.length ? currency.format(Math.min(...effectiveRates)) : 'On request';

  const cards = product.price_options.map((option) => {
    const unitRows = option.units.map((unit) => `
      <div class="configuration-row">
        <div><b>${escapeHtml(unit.unit_name)}</b><small>${escapeHtml(unit.code || 'No code')}</small></div>
        <span>Range ${formatRange(unit.minimum, unit.maximum)}</span><span>Step ${unit.step ?? '—'}</span>
      </div>`).join('');
    const attributeRows = option.attributes.map((attribute) => `
      <div class="configuration-row">
        <div><b>${escapeHtml(attribute.name)}</b><small>${escapeHtml(attribute.type || 'Attribute')}</small></div>
        <div class="value-list">${attribute.values.map((value) => `<span>${escapeHtml(value.value)}</span>`).join('') || '<span>No values</span>'}</div>
      </div>`).join('');
    const optionRows = option.options.map((item) => `
      <div class="configuration-row">
        <div><b>${escapeHtml(item.name)}</b><small>${escapeHtml(item.type || 'Option')}</small></div>
        <div class="value-list">${item.values.map((value) => {
          const direction = value.modify_type === 'Decrement' ? '−' : '+';
          const modifier = value.modify_price ? ` ${direction}${currency.format(value.modify_price)}` : '';
          return `<span>${escapeHtml(value.value)}${escapeHtml(modifier)}</span>`;
        }).join('') || '<span>No values</span>'}</div>
      </div>`).join('');
    const marginClass = option.has_loss ? 'loss' : option.effective_margin === null ? '' : 'profit';

    return `
      <article class="price-card ${option.has_loss ? 'has-loss' : ''}">
        <div class="price-card-head">
          <div><small>Format · ${escapeHtml(option.sku)}</small><h5>${escapeHtml(option.name)}</h5></div>
          <div class="format-price"><small>Effective client price</small><div class="money">${moneyOrDash(option.effective_client_rate)}</div>${option.has_loss ? '<b class="loss-chip">Below buying cost</b>' : ''}</div>
        </div>
        ${option.description_html ? `<p class="option-description">${escapeHtml(stripHtml(option.description_html))}</p>` : ''}
        <div class="price-matrix">
          <div><small>Offer rate</small><b>${moneyOrDash(option.offer_rate)}</b></div>
          <div><small>Discounted rate</small><b>${moneyOrDash(option.discounted_rate)}</b></div>
          <div class="client-price"><small>Effective client</small><b>${moneyOrDash(option.effective_client_rate)}</b></div>
          <div><small>Buying cost</small><b>${moneyOrDash(option.specific_buying_rate)}</b></div>
          <div class="${marginClass}"><small>Effective margin</small><b>${moneyOrDash(option.effective_margin)}</b></div>
          <div><small>Minimum billing</small><b>${moneyOrDash(option.minimum_billing)}</b></div>
          <div><small>Pricing unit</small><b>${escapeHtml(option.pricing_unit || '—')}</b></div>
          <div><small>GST</small><b>${option.gst === null ? '—' : `${option.gst}%`}</b></div>
          <div><small>On request</small><b>${option.on_request === 'Y' ? 'Yes' : 'No'}</b></div>
        </div>
        <div class="configuration-groups">
          ${unitRows ? `<section><h6>Quantity & unit rules</h6>${unitRows}</section>` : ''}
          ${attributeRows ? `<section><h6>Planning attributes</h6>${attributeRows}</section>` : ''}
          ${optionRows ? `<section><h6>Add-ons & modifiers</h6>${optionRows}</section>` : ''}
          ${!unitRows && !attributeRows && !optionRows ? '<p class="no-configuration">No additional configuration for this format.</p>' : ''}
        </div>
      </article>`;
  }).join('');

  const issues = product.issues.map((issue) => `
    <div class="issue-item ${issue.severity}">
      <b>${escapeHtml(issue.code.replaceAll('_', ' '))} · ${escapeHtml(issue.source_sheet)} row ${issue.source_row}</b>
      <p>${escapeHtml(issue.message)}</p>
      <span class="issue-fix">${escapeHtml(issue.field)}: “${escapeHtml(issue.current_value ?? 'blank')}” → <strong>${escapeHtml(issue.suggested_value || 'review')}</strong></span>
    </div>`).join('');

  elements.drawerContent.innerHTML = `
    <div class="planning-status ${errorCount ? 'needs-review' : 'ready'}">
      <div><small>Plan creation status</small><b>${errorCount ? 'Review before client plan' : 'Ready for client plan'}</b></div>
      <span>${errorCount} errors · ${product.issues.length - errorCount} notes${lossCount ? ` · ${lossCount} loss-risk price${lossCount === 1 ? '' : 's'}` : ''}</span>
    </div>
    <section class="product-showcase drawer-hero">
      <div class="showcase-media">${imageUrl ? `<img src="${imageUrl}" alt="${escapeHtml(product.name)}">` : '<div class="showcase-placeholder">No product image</div>'}</div>
      <div class="showcase-copy">
        <p class="eyebrow">${escapeHtml(product.media_type || 'Transit')} · ${escapeHtml(product.sku)}</p>
        <h3 id="drawer-title">${escapeHtml(product.name)}</h3>
        <div class="showcase-price"><small>Client price from</small><strong>${clientPriceFrom}</strong><span>${product.price_options.length} available format${product.price_options.length === 1 ? '' : 's'}</span></div>
        <p class="drawer-description">${escapeHtml(product.short_description || 'No description supplied in the master.')}</p>
        <div class="drawer-meta">
          <div><small>Tier</small><strong>${escapeHtml(product.tier || '—')}</strong></div>
          <div><small>Dimensions</small><strong>${escapeHtml(product.size_dimension || '—')}</strong></div>
          <div><small>Status</small><strong>${product.status ? 'Active' : 'Inactive'}</strong></div>
        </div>
      </div>
    </section>
    ${issues ? `<section class="issue-panel"><div class="issue-panel-head"><b>Problems & planner notes</b><span>${product.issues.length} items</span></div>${issues}</section>` : '<div class="clean-note">No data-quality problems detected for this product.</div>'}
    <div class="drawer-section-title"><h4>All prices & options</h4><span>${product.price_options.length} selling formats</span></div>
    ${cards || '<div class="empty-state"><b>No price options</b><span>This product has no linked pricing rows.</span></div>'}`;

  const image = elements.drawerContent.querySelector('.drawer-hero img');
  if (image) image.addEventListener('error', () => image.closest('.showcase-media').classList.add('image-missing'));
}

function formatRange(minimum, maximum) {
  if (minimum === null && maximum === null) return '—';
  if (maximum === null) return `min ${integer.format(minimum)}`;
  return `${integer.format(minimum)}–${integer.format(maximum)}`;
}

function moneyOrDash(value) { return value === null ? '—' : currency.format(value); }

function stripHtml(value) {
  const parsed = new DOMParser().parseFromString(String(value), 'text/html');
  return parsed.body.textContent.replace(/\s+/g, ' ').trim();
}

async function getJson(url, signal) {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json();
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);
}

initialize();
