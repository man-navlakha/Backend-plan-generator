const ids = ['filter-form','search','chain','city','tier','problem','sort','reset','inventory',
  'result-label','chain-strip','load-marker','load-note','drawer-shell','drawer','drawer-content'];
const el = Object.fromEntries(ids.map((id) => [id.replaceAll('-', '_'), document.getElementById(id)]));
const currency = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 });
const integer = new Intl.NumberFormat('en-IN');
const state = { controller: null, products: [], rendered: 0, drawerRequest: 0 };

const observer = new IntersectionObserver((entries) => {
  if (entries.some((entry) => entry.isIntersecting)) renderNextChunk();
}, { rootMargin: '1100px' });

async function initialize() {
  bindEvents();
  observer.observe(el.load_marker);
  try {
    const [stats, filters] = await Promise.all([getJson('/api/cinema/stats'), getJson('/api/cinema/filters')]);
    renderStats(stats);
    renderFilters(filters, stats.chains);
  } catch (error) { console.error('Cinema metadata failed to load', error); }
  await loadProducts();
  const sharedId = Number.parseInt(new URLSearchParams(location.search).get('product'), 10);
  if (Number.isInteger(sharedId) && sharedId > 0) await openDrawer(sharedId, false);
}

function bindEvents() {
  let timer;
  el.search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(loadProducts, 260); });
  for (const input of [el.chain, el.city, el.tier, el.problem, el.sort])
    input.addEventListener('change', () => { syncChips(); loadProducts(); });
  el.filter_form.addEventListener('submit', (event) => { event.preventDefault(); loadProducts(); });
  el.reset.addEventListener('click', () => { el.filter_form.reset(); syncChips(); loadProducts(); });
  document.getElementById('drawer-close').addEventListener('click', closeDrawer);
  document.getElementById('drawer-scrim').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeDrawer(); });
}

function renderStats(stats) {
  document.getElementById('stat-products').textContent = integer.format(stats.products);
  document.getElementById('stat-options').textContent = integer.format(stats.price_options);
  document.getElementById('stat-units').textContent = integer.format(stats.price_units);
  document.getElementById('stat-chains').textContent = integer.format(stats.chain_count);
  document.getElementById('quality-issues').textContent = integer.format(stats.issues);
  document.getElementById('quality-products').textContent = integer.format(stats.affected_products);
  document.getElementById('last-sync').textContent = stats.imported_at
    ? `Synced ${new Date(stats.imported_at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })}` : 'Awaiting import';
}

function renderFilters(filters, chains) {
  for (const value of filters.chains) el.chain.add(new Option(value, value));
  for (const value of filters.cities) el.city.add(new Option(value, value));
  for (const value of filters.tiers) el.tier.add(new Option(value, value));
  el.chain_strip.replaceChildren(...chains.map((item) => {
    const chip = document.createElement('button');
    chip.type = 'button'; chip.className = 'media-chip'; chip.dataset.value = item.name;
    chip.innerHTML = `${escapeHtml(item.name)} <b>${integer.format(item.count)}</b>`;
    chip.addEventListener('click', () => { el.chain.value = el.chain.value === item.name ? '' : item.name; syncChips(); loadProducts(); });
    return chip;
  }));
}
function syncChips() { for (const chip of el.chain_strip.children) chip.classList.toggle('active', chip.dataset.value === el.chain.value); }

async function loadProducts() {
  if (state.controller) state.controller.abort();
  const controller = new AbortController(); state.controller = controller;
  state.products = []; state.rendered = 0;
  el.inventory.replaceChildren(document.getElementById('loading-template').content.cloneNode(true));
  el.result_label.textContent = 'Loading venues…';
  const query = new URLSearchParams({ sort: el.sort.value });
  for (const [name, input] of [['search',el.search],['chain',el.chain],['city',el.city],['tier',el.tier],['problem',el.problem]])
    if (input.value.trim()) query.set(name, input.value.trim());
  try {
    const result = await getJson(`/api/cinema/products?${query}`, controller.signal);
    if (controller !== state.controller) return;
    state.products = result.data;
    el.inventory.replaceChildren();
    el.result_label.textContent = `${integer.format(result.data.length)} venues · one page`;
    if (!result.data.length) {
      el.inventory.innerHTML = '<div class="empty-state"><b>No cinema found</b><span>Try a different city, chain or quality filter.</span></div>';
    } else renderNextChunk();
  } catch (error) {
    if (error.name !== 'AbortError') {
      console.error(error);
      el.inventory.innerHTML = '<div class="error-state"><b>Cinema database unavailable</b><span>Could not load venues. Try again.</span></div>';
    }
  }
}

function renderNextChunk() {
  if (state.rendered >= state.products.length) return;
  const chunk = state.products.slice(state.rendered, state.rendered + 120);
  el.inventory.append(...chunk.map(productRow));
  state.rendered += chunk.length;
  el.load_note.textContent = state.rendered < state.products.length
    ? `Showing ${integer.format(state.rendered)} of ${integer.format(state.products.length)} venues. Scroll for more.`
    : `All ${integer.format(state.products.length)} matching venues are shown.`;
}

function productRow(product) {
  const button = document.createElement('button');
  button.type = 'button'; button.className = 'inventory-row';
  button.addEventListener('click', () => openDrawer(product.id));
  const src = product.image ? `/cinema-images/${encodeURIComponent(product.image)}` : '';
  const market = [product.city, product.state].filter(Boolean).join(', ') || 'Market missing';
  button.innerHTML = `
    <span class="asset"><span class="asset-image" data-code="CINEMA">${src ? `<img src="${src}" alt="" loading="lazy">` : ''}</span>
      <span class="asset-copy"><strong>${escapeHtml(product.name)}</strong><span class="asset-flags"><small class="sku">${escapeHtml(product.sku)}</small>${product.issue_count ? `<span class="issue-badge ${product.error_count ? '' : 'warning'}">${product.issue_count} finding${product.issue_count === 1 ? '' : 's'}</span>` : ''}</span></span></span>
    <span class="cinema-market">${escapeHtml(market)}<small>${escapeHtml(product.cinema_chain || 'Chain missing')} · ${escapeHtml(product.tier || 'No tier')}</small></span>
    <span class="cinema-capacity"><b>${product.total_screen ?? '—'}</b> screens<small>${product.seats == null ? 'Seats unknown' : `${integer.format(product.seats)} seats`} · ${product.price_option_count} formats</small></span>
    <span class="rate"><strong>${money(product.min_rate)}</strong><small>client from · buying from ${money(product.min_buying_rate)}</small>${product.loss_price_count ? `<span class="loss-note">${product.loss_price_count} below cost</span>` : ''}</span>
    <span class="row-arrow">↗</span>`;
  const image = button.querySelector('img');
  if (image) image.addEventListener('error', () => image.parentElement.classList.add('is-fallback'));
  else button.querySelector('.asset-image').classList.add('is-fallback');
  return button;
}

async function openDrawer(id, updateUrl = true) {
  const requestId = ++state.drawerRequest;
  el.drawer_shell.hidden = false; document.body.style.overflow = 'hidden';
  el.drawer_content.innerHTML = '<div class="drawer-loading">Opening screen…</div>';
  el.drawer.focus();
  if (updateUrl) { const url = new URL(location.href); url.searchParams.set('product', id); history.replaceState(null, '', url); }
  try { const product = await getJson(`/api/cinema/products/${id}`); if (requestId === state.drawerRequest) renderDrawer(product); }
  catch (error) { if (requestId === state.drawerRequest) el.drawer_content.innerHTML = '<div class="error-state"><b>Venue details unavailable</b></div>'; }
}
function closeDrawer() {
  if (el.drawer_shell.hidden) return;
  state.drawerRequest += 1; el.drawer_shell.hidden = true; document.body.style.overflow = '';
  const url = new URL(location.href); url.searchParams.delete('product'); history.replaceState(null, '', url);
}

function renderDrawer(product) {
  const image = product.image ? `/cinema-images/${encodeURIComponent(product.image)}` : '';
  const locationRow = product.locations[0] || {};
  const rates = product.price_options.map((option) => option.effective_client_rate).filter((value) => value != null);
  const priceFrom = rates.length ? money(Math.min(...rates)) : 'On request';
  const errors = product.issues.filter((issue) => issue.severity === 'error').length;
  const lossCount = product.issues.filter((issue) => issue.code === 'SELLING_BELOW_BUYING').length;
  const mapLink = safeUrl(product.google_map_location)
    ? `<a class="map-link" href="${escapeHtml(product.google_map_location)}" target="_blank" rel="noopener noreferrer">↗ Open map location</a>` : '';
  const issues = product.issues.map((issue) => `<div class="issue-item ${issue.severity}">
    <b>${escapeHtml(issue.code.replaceAll('_', ' '))} · ${escapeHtml(issue.source_sheet)} row ${issue.source_row}</b>
    <p>${escapeHtml(issue.message)}</p>
    <span class="issue-fix">${escapeHtml(issue.field)}: “${escapeHtml(issue.current_value ?? 'blank')}” → <strong>${escapeHtml(issue.suggested_value || 'review')}</strong></span>
  </div>`).join('');
  const groups = new Map();
  for (const option of product.price_options) {
    const screen = option.name.match(/SCREEN\s*[-_]?\s*(\d+)/i)?.[1] || 'Other';
    const label = screen === 'Other' ? 'Other formats' : `Screen ${screen}`;
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(option);
  }
  const cards = [...groups].map(([name, options]) => `<section class="screen-group">
    <div class="screen-group-title"><h5>${escapeHtml(name)}</h5><span>${options.length} formats</span></div>
    ${options.map(priceCard).join('')}
  </section>`).join('');
  el.drawer_content.innerHTML = `
    <div class="planning-status ${errors ? 'needs-review' : 'ready'}"><div><small>Cinema plan status</small><b>${errors ? 'Review before client plan' : 'Ready for client plan'}</b></div><span>${errors} errors · ${product.issues.length - errors} notes${lossCount ? ` · ${lossCount} loss-risk formats` : ''}</span></div>
    <section class="product-showcase drawer-hero">
      <div class="showcase-media">${image ? `<img src="${image}" alt="${escapeHtml(product.cinema_chain || product.name)}">` : '<div class="showcase-placeholder">No cinema image</div>'}</div>
      <div class="showcase-copy"><p class="eyebrow">${escapeHtml(product.cinema_chain || 'Cinema')} · ${escapeHtml(product.sku)}</p>
        <h3 id="drawer-title">${escapeHtml(product.name)}</h3>
        <div class="showcase-price"><small>Client rate from</small><strong>${priceFrom}</strong><span>${product.price_options.length} screen formats · ${product.total_screen ?? '—'} total screens</span></div>
        <p class="drawer-description">${escapeHtml(product.description || 'No description supplied in the master.')}</p>
        <div class="drawer-meta"><div><small>Market</small><strong>${escapeHtml([locationRow.city,locationRow.state].filter(Boolean).join(', ') || '—')}</strong></div><div><small>Capacity</small><strong>${product.seats == null ? '—' : `${integer.format(product.seats)} seats`}</strong></div><div><small>Audience</small><strong>${escapeHtml(product.audience_class || '—')}</strong></div></div>
        <div class="cinema-facts"><span>Tier <b>${escapeHtml(product.tier || '—')}</b></span><span>Recommended screens <b>${product.screen_recommend ?? '—'}</b></span><span>Rank <b>${product.rank ?? '—'}</b></span><span>Zone <b>${escapeHtml(locationRow.zone || '—')}</b></span><span>Locality <b>${escapeHtml(locationRow.locality || '—')}</b></span><span>Status <b>${product.status ? 'Active' : 'Inactive'}</b></span></div>
        ${mapLink}
      </div>
    </section>
    ${issues ? `<section class="issue-panel"><div class="issue-panel-head"><b>Problems & planner notes</b><span>${product.issues.length} findings</span></div>${issues}</section>` : '<div class="clean-note">No data-quality problems detected for this cinema.</div>'}
    <div class="drawer-section-title"><h4>All screens & prices</h4><span>${product.price_options.length} formats</span></div>
    ${cards || '<div class="empty-state"><b>No price formats</b></div>'}`;
  const img = el.drawer_content.querySelector('.showcase-media img');
  if (img) img.addEventListener('error', () => img.closest('.showcase-media').classList.add('image-missing'));
}

function priceCard(option) {
  const units = option.units.map((unit) => `<div class="unit-cell"><b>${escapeHtml(unit.name || unit.code || 'Unit')}</b><span>${range(unit.minimum, unit.maximum)} · step ${unit.step ?? '—'}</span></div>`).join('');
  const sources = option.rate_sources.map((source) => `<div class="rate-source"><b>Offer-rate provenance</b><span>${escapeHtml(source.rate_source || 'Source not named')} · ${escapeHtml(source.basis || 'No basis')} · source ${money(source.source_rate)} ÷ ${source.divide_by ?? '—'} = ${money(source.offer_rate)}</span></div>`).join('');
  const description = option.description_html ? `<p class="option-description">${escapeHtml(stripHtml(option.description_html))}</p>` : '';
  const marginClass = option.effective_margin == null ? '' : option.effective_margin < 0 ? 'loss' : 'profit';
  return `<article class="price-card ${option.has_loss ? 'has-loss' : ''}">
    <div class="price-card-head"><div><small>Format · ${escapeHtml(option.sku)}</small><h5>${escapeHtml(option.name)}</h5><small>${escapeHtml(option.template || 'Cinema advertising')} · ${option.status ? 'Active' : 'Inactive'}</small></div><div class="format-price"><small>Effective client price</small><div class="money">${money(option.effective_client_rate)}</div>${option.has_loss ? '<b class="loss-chip">Below buying cost</b>' : ''}</div></div>
    ${description}
    <div class="price-matrix"><div><small>Offer rate</small><b>${money(option.offer_rate)}</b></div><div><small>Discounted rate</small><b>${money(option.discounted_rate)}</b></div><div class="client-price"><small>Effective client</small><b>${money(option.effective_client_rate)}</b></div><div><small>Buying cost</small><b>${money(option.buying_rate)}</b></div><div class="${marginClass}"><small>Effective margin</small><b>${money(option.effective_margin)}</b></div><div><small>Minimum billing</small><b>${money(option.minimum_billing)}</b></div><div><small>Pricing unit</small><b>${escapeHtml(option.pricing_unit || '—')}</b></div><div><small>GST</small><b>${option.gst == null ? '—' : `${option.gst}%`}</b></div><div><small>On request</small><b>${option.on_request === 'Y' ? 'Yes' : 'No'}</b></div></div>
    ${units ? `<div class="unit-grid">${units}</div>` : ''}${sources}
  </article>`;
}

function money(value) { return value == null || !Number.isFinite(Number(value)) ? '—' : currency.format(value); }
function range(minimum, maximum) { return `${minimum == null ? '—' : integer.format(minimum)}–${maximum == null ? '—' : integer.format(maximum)}`; }
function safeUrl(input) { try { return ['https:', 'http:'].includes(new URL(input).protocol); } catch { return false; } }
function stripHtml(input) { const parsed = new DOMParser().parseFromString(String(input), 'text/html'); return parsed.body.textContent.replace(/\s+/g, ' ').trim(); }
async function getJson(url, signal) { const response = await fetch(url, { signal }); if (!response.ok) throw new Error(`${response.status} ${response.statusText}`); return response.json(); }
function escapeHtml(input) { return String(input ?? '').replace(/[&<>'"]/g, (character) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' })[character]); }
initialize().catch((error) => { console.error(error); el.inventory.innerHTML = '<div class="error-state"><b>Could not initialize Cinema Master</b></div>'; });
