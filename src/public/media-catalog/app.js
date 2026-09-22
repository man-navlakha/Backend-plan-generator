const PAGE = document.body.dataset.media;
const slug = PAGE === 'digital-pr' ? 'digital_pr' : PAGE;
const api = `/api/masters/${slug}`;
const media = {
  btl: {
    noun: 'placements', type: 'Media Option',
    facets: [['Media Option','Format'],['Target Audience','Audience'],['Class','Audience class']],
    preview: ['Media Option','Target Audience','Class'],
    stats: [['products','Placements','on-ground inventory'],['price_options','Booking formats','rates and units'],['price_units','Quantity rules','minimums and steps'],['variants','Creative choices','variants in source']],
    detail: ['Media Option','Tier Preference','Target Audience','Class','Footfall','Size'],
    choice: 'Placement choices',
    note: 'Check target audience, site class, booking unit and execution scope before this placement enters a client plan.'
  },
  digital: {
    noun: 'platforms', type: 'Pricing Model (Multiple)',
    facets: [['Pricing Model (Multiple)','Pricing model'],['Category (Multiple)','Category'],['Language (Multiple)','Language']],
    preview: ['Pricing Model (Multiple)','Category (Multiple)','REACH/ IMPRESSIONS'],
    stats: [['products','Platforms','digital inventory'],['price_options','Placements','client rate options'],['variants','Variants','placement combinations'],['issues','Findings','data review']],
    detail: ['Pricing Model (Multiple)','Category (Multiple)','Language (Multiple)','REACH/ IMPRESSIONS'],
    choice: 'Targeting and placement choices',
    note: 'Confirm the buying metric, impression or reach estimate, placement and campaign minimum before budgeting.'
  },
  digital_pr: {
    noun: 'publishers', type: 'Genre',
    facets: [['Genre','Genre'],['Language','Language'],['Price Model','Price model']],
    preview: ['Genre','Language','DA'],
    stats: [['products','Publishers','outlet inventory'],['price_options','Article formats','booking options'],['price_units','Quantity rules','article counts'],['issues','Findings','data review']],
    detail: ['Genre','Language','Price Model','Website URL','Backlink','DA'],
    choice: 'Publication choices',
    note: 'Verify the publisher URL, authority, backlink terms and article deliverable before including the placement in a PR plan.'
  },
  magazine: {
    noun: 'titles', type: 'Category',
    facets: [['Category','Category'],['Frequency','Frequency'],['Language (Multiple)','Language']],
    preview: ['Category','Frequency','Circulation'],
    stats: [['products','Titles','magazine inventory'],['price_options','Insertion formats','base rates'],['variants','Positions','priced variants'],['price_units','Quantity rules','insertion counts']],
    detail: ['Category','Frequency','Language (Multiple)','Country','Edition','Circulation'],
    choice: 'Ad positions and sizes',
    note: 'Check circulation, issue frequency, ad position, insertion count and artwork requirements before quoting.'
  },
  newspaper: {
    noun: 'publications', type: 'Publication (Multiple)',
    facets: [['Publication (Multiple)','Publication'],['Language (Multiple)','Language'],['__city','City']],
    preview: ['Publication (Multiple)','Language (Multiple)','Circulation'],
    stats: [['products','Publications','newspaper inventory'],['locations','Market rows','cities and localities'],['price_options','Rate options','in source workbook'],['issues','Findings','data review']],
    detail: ['Publication (Multiple)','Language (Multiple)','Circulation'],
    choice: 'Ad formats',
    note: 'This workbook has no price-option sheet. A verified rate card and insertion specification are needed for a costed newspaper plan.'
  },
  tv: {
    noun: 'channels', type: 'Channel Genre',
    facets: [['Channel Genre','Genre'],['Language (Multiple)','Language']],
    preview: ['Channel Genre','Language (Multiple)'],
    stats: [['products','Channels','television inventory'],['price_options','Ad formats','video and airtime'],['price_units','Quantity rules','seconds and insertions'],['issues','Findings','data review']],
    detail: ['Channel Genre','Language (Multiple)'],
    choice: 'Time bands and audience choices',
    note: 'Confirm ad length, time band, frequency, language and campaign minimum before a channel is costed.'
  }
}[slug];

const $ = (id) => document.getElementById(id);
const count = new Intl.NumberFormat('en-IN');
const currency = new Intl.NumberFormat('en-IN', { style:'currency', currency:'INR', maximumFractionDigits:2 });
const money = (value) => value == null || value === '' ? '—' : currency.format(Number(value));
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (character) =>
  ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[character]);
function textOnly(value) {
  const textarea = document.createElement('textarea');
  textarea.innerHTML = String(value ?? '').replace(/<[^>]*>/g, ' ');
  return textarea.value.replace(/\s+/g, ' ').trim();
}
function clipped(value, limit = 150) { const text = textOnly(value); return text.length > limit ? `${text.slice(0, limit).trim()}…` : text; }
async function get(url, signal) {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`Catalog request failed (${response.status})`);
  return response.json();
}

const state = { page:1, pages:1, total:0, loading:false, token:0, values:{}, summary:null, drawerToken:0 };
const observer = new IntersectionObserver((entries) => {
  if (entries.some((entry) => entry.isIntersecting)) loadNextPage();
}, { rootMargin:'850px' });

function renderNav() {
  const links = [
    ['transit','Transit'],['radio','Radio'],['cinema','Cinema'],['btl','BTL'],
    ['digital','Digital'],['digital-pr','Digital PR'],['magazine','Magazine'],
    ['newspaper','Newspaper'],['tv','TV']
  ];
  $('master-nav').innerHTML = links.map(([path,label]) =>
    `<a href="/${path}/" class="${PAGE === path ? 'active' : ''}">${esc(label)}</a>`).join('');
}

function renderStats(stats) {
  $('stats').innerHTML = media.stats.map(([key,label,hint]) =>
    `<article class="stat"><span>${esc(label)}</span><strong>${count.format(stats[key] || 0)}</strong><small>${esc(hint)}</small></article>`).join('');
  $('quality-count').textContent = count.format(stats.issues || 0);
  $('quality-copy').textContent = `${count.format(stats.affected_products || 0)} ${media.noun} need review. Source rows, current values and suggested fixes are included in the repair sheet.`;
}

function renderFilters(filters, summary) {
  state.values = filters.facets;
  $('media-filters').innerHTML = media.facets.map(([field,label], index) =>
    `<label><span>${esc(label)}</span><select data-field="${esc(field)}" id="facet-${index}"><option value="">All ${esc(label.toLowerCase())}</option></select></label>`).join('');
  media.facets.forEach(([field], index) => {
    const values = field === '__city' ? filters.cities : filters.facets[field] || [];
    const select = $(`facet-${index}`);
    values.forEach((value) => select.add(new Option(value, value)));
    select.addEventListener('change', () => { syncChips(); restart(); });
  });
  const choices = [['','All records'],['margin','Selling below buying'],['any','Any problem'],
    ['clean','Clean records'],['error','Blocking errors'],['warning','Warnings']];
  for (const item of summary.by_code) choices.push([item.code,
    `${item.code.toLowerCase().replaceAll('_',' ')} (${count.format(item.count)})`]);
  $('problem').innerHTML = choices.map(([value,label]) => `<option value="${esc(value)}">${esc(label)}</option>`).join('');
  renderQuickFilters(filters);
}

function renderQuickFilters(filters) {
  const [field] = media.facets[0];
  const values = (field === '__city' ? filters.cities : filters.facets[field] || []).slice(0, 10);
  $('facet-strip').innerHTML = values.map((value) =>
    `<button class="facet-chip" type="button" data-value="${esc(value)}">${esc(value)}</button>`).join('');
  $('facet-strip').querySelectorAll('button').forEach((button) => button.addEventListener('click', () => {
    const select = $('facet-0');
    select.value = select.value === button.dataset.value ? '' : button.dataset.value;
    syncChips(); restart();
  }));
}
function syncChips() {
  $('facet-strip').querySelectorAll('button').forEach((button) =>
    button.classList.toggle('active', button.dataset.value === $('facet-0').value));
}

function query() {
  const params = new URLSearchParams({ page:state.page, page_size:200, sort:$('sort').value });
  if ($('search').value.trim()) params.set('search', $('search').value.trim());
  if ($('problem').value) params.set('problem', $('problem').value);
  media.facets.forEach(([field], index) => {
    const value = $(`facet-${index}`).value;
    if (!value) return;
    if (field === '__city') params.set('city', value);
    else { params.set(`facet_${index + 1}`, field); params.set(`facet_value_${index + 1}`, value); }
  });
  return params;
}

function restart() {
  state.token++;
  state.page = 1;
  state.pages = 1;
  state.loading = false;
  $('inventory').innerHTML = '<div class="empty-state">Loading inventory…</div>';
  $('result-label').textContent = `Loading ${media.noun}…`;
  loadNextPage();
}

async function loadNextPage() {
  if (!$('facet-0') || state.loading || state.page > state.pages) return;
  state.loading = true;
  const token = state.token;
  try {
    const result = await get(`${api}/products?${query()}`);
    if (token !== state.token) return;
    state.pages = result.pagination.pages;
    state.total = result.pagination.total;
    if (state.page === 1) $('inventory').replaceChildren();
    if (!result.data.length && state.page === 1) $('inventory').innerHTML =
      '<div class="empty-state"><b>No matches found</b>Try another search or filter.</div>';
    else $('inventory').insertAdjacentHTML('beforeend', result.data.map(card).join(''));
    $('result-label').textContent = `${count.format(state.total)} ${media.noun} · ${count.format(Math.min(state.page * 200, state.total))} shown`;
    $('load-note').textContent = state.page < state.pages
      ? `Scroll to load more ${media.noun}.` : `All ${count.format(state.total)} matching ${media.noun} are on this page.`;
    state.page++;
  } catch (error) {
    if (token === state.token) $('inventory').innerHTML = `<div class="empty-state"><b>Inventory unavailable</b>${esc(error.message)}</div>`;
  } finally { if (token === state.token) state.loading = false; }
}

function card(product) {
  const fields = product.fields || {};
  const badge = product.error_count ? `${product.error_count} errors` : product.issue_count ? `${product.issue_count} notes` : 'Plan ready';
  const facts = media.preview.map((key) => fields[key] ? `<span>${esc(clipped(fields[key], 43))}</span>` : '').join('');
  return `<article class="card" tabindex="0" role="button" data-id="${product.id}" aria-label="View ${esc(product.name)}">
    <div class="card-media">${product.image_url ? `<img loading="lazy" src="${esc(product.image_url)}" alt="${esc(product.name)}">` : `<span class="initial">${esc((product.name || 'M').slice(0, 2))}</span>`}
      <div class="card-status"><span>${product.status === 1 ? 'Active' : 'Inactive'}</span><span class="${product.issue_count ? 'issue' : 'ready'}">${esc(badge)}</span></div></div>
    <div class="card-body"><span class="card-type">${esc(clipped(fields[media.type] || product.sku || 'Source record', 65))}</span>
      <h3>${esc(product.name || 'Untitled product')}</h3>
      <p class="card-description">${esc(clipped(product.description || fields['Meta Description'] || 'Description needed for a client-ready plan.'))}</p>
      <div class="card-facts">${facts}<span>${product.price_option_count ? `${product.price_option_count} booking options` : 'Rate card needed'}</span></div></div>
    <div class="card-footer"><div><small>${product.min_price == null ? 'PRICE NOT PROVIDED' : 'CLIENT PRICE FROM'}</small><strong>${money(product.min_price)}</strong></div><button type="button">Inspect ↗</button></div>
  </article>`;
}

function facts(fields, keys) {
  return keys.filter((key) => fields[key] != null && fields[key] !== '')
    .map((key) => `<div class="fact"><small>${esc(key)}</small><b>${esc(textOnly(fields[key]))}</b></div>`).join('');
}
function fieldFacts(fields, omit = []) {
  return facts(fields, Object.keys(fields).filter((key) => !omit.includes(key)));
}
function rowChildren(product, sheet, optionId) {
  return (product.rows[sheet] || []).filter((row) => row.option_id === optionId);
}
function renderOption(product, option) {
  const f = option.fields;
  const units = rowChildren(product, 'Price Unit', option.id);
  const attrs = rowChildren(product, 'Attribute', option.id);
  const values = rowChildren(product, 'Attribute Value', option.id);
  const variants = rowChildren(product, 'Variant', option.id);
  const extraOptions = rowChildren(product, 'Option', option.id);
  const extraValues = rowChildren(product, 'Option Value', option.id);
  const client = option.discounted_rate ?? option.price;
  const loss = option.buying_rate != null && ((option.price != null && option.price < option.buying_rate)
    || (option.discounted_rate != null && option.discounted_rate < option.buying_rate));
  const renderUnits = units.length ? `<div class="option-subsection"><strong>Campaign quantity rules</strong>${units.map((row) =>
    `<div class="unit"><b>${esc(row.fields['Unit Name'] || 'Unit')}</b> · ${esc(row.fields.Code || '')} · step ${esc(row.fields.Step || '—')} · minimum ${esc(row.fields.Minimum || '—')} · maximum ${row.fields.Maximum === '0' ? 'not specified (0 in source)' : esc(row.fields.Maximum || 'open')}</div>`).join('')}</div>` : '';
  const renderChoices = attrs.length || extraOptions.length ? `<div class="option-subsection"><strong>${esc(media.choice)}</strong>
    ${attrs.map((row) => {
      const name = row.fields['Attribute Name'];
      const choices = values.filter((value) => value.fields['Attribute Name'] === name).map((value) => value.fields['Attribute Value']).filter(Boolean);
      return `<div class="choice"><b>${esc(name || 'Attribute')}</b> · ${esc(row.fields['Attribute Type'] || 'choice')}<br>${esc(choices.join(' · ') || 'No values supplied')}</div>`;
    }).join('')}
    ${extraOptions.map((row) => `<div class="choice"><b>${esc(row.fields['Option Name'] || row.name || 'Option')}</b> · ${esc(row.fields['Option Type'] || '')}</div>`).join('')}
    ${extraValues.map((row) => `<div class="choice">${esc(row.fields['Option Value'] || row.name || '')} ${row.fields.Price ? `· ${money(row.fields.Price)}` : ''}</div>`).join('')}</div>` : '';
  const renderVariants = variants.length ? `<div class="option-subsection"><strong>Priced variants</strong>${variants.map((row) =>
    `<div class="variant ${row.fields['Is Enable'] === '0' ? 'disabled' : ''}"><div><b>${esc(row.fields['Variant Name'] || 'Variant')}</b><small>${row.fields['Is Enable'] === '0' ? 'Disabled' : 'Available'} · source row ${row.source_row}</small></div><b>${money(row.price)}</b></div>`).join('')}</div>` : '';
  return `<article class="price-option"><div class="option-head"><div><h4>${esc(f['Price Option Name'] || 'Unnamed format')}</h4><small>${esc(option.option_sku || '')} · ${esc(option.pricing_unit || 'Unit missing')}</small></div><strong>${money(client)}</strong></div>
    <div class="price-grid"><div><small>Offer / selling</small><b>${money(option.price)}</b></div><div><small>Discounted</small><b>${money(option.discounted_rate)}</b></div><div class="${loss ? 'loss' : ''}"><small>Buying cost</small><b>${money(option.buying_rate)}</b></div><div><small>Minimum billing</small><b>${money(option.minimum_billing)}</b></div></div>
    ${option.buying_rate == null ? '<p class="cost-note">Buying cost is not in this source row; margin cannot be verified.</p>' : ''}
    ${loss ? '<div class="rate-missing"><b>Selling below buying</b><p>Do not add this option to a client plan until its price is corrected.</p></div>' : ''}
    ${option.image_url ? `<img class="option-photo" src="${esc(option.image_url)}" alt="${esc(f['Price Option Name'])}">` : ''}
    ${f.Description ? `<p class="option-copy">${esc(textOnly(f.Description))}</p>` : ''}
    ${renderUnits}${renderChoices}${renderVariants}
    <details class="source-details"><summary>All price-option source fields · row ${option.source_row}</summary><div class="fact-grid">${fieldFacts(f, ['Delete','Product Name','Product Sku'])}</div></details>
  </article>`;
}

function detail(product) {
  const f = product.fields;
  const options = product.rows['Price Option'] || [];
  const locations = product.rows.Location || [];
  const link = f['Website URL'] && /^https?:\/\//i.test(f['Website URL'])
    ? `<a href="${esc(f['Website URL'])}" target="_blank" rel="noopener noreferrer">Open publisher website ↗</a>` : '';
  return `<div class="detail">
    <span class="detail-eyebrow">${esc(PAGE.toUpperCase())} MASTER / ROW ${product.source_row}</span>
    <h2 id="drawer-title">${esc(product.name || 'Untitled product')}</h2>
    <p class="detail-sub">SKU ${esc(product.sku || 'missing')} · ${product.status === 1 ? 'Active' : 'Inactive'} · ${product.issues.length} data-quality findings</p>
    <div class="detail-photo">${product.image_url ? `<img src="${esc(product.image_url)}" alt="${esc(product.name)}">` : '<span>Product image missing</span>'}</div>
    <p class="detail-intro">${esc(textOnly(product.description || f['Meta Description'] || 'No description available for a client-facing proposal.'))}</p>
    <section class="detail-section"><h3>Planning profile</h3><div class="fact-grid">${facts(f, media.detail)}</div>${link}</section>
    ${slug === 'newspaper' ? '<div class="rate-missing"><b>Rate card required</b><p>This newspaper workbook has no pricing options. Request a verified insertion rate, size and edition before producing a costed plan.</p></div>' : ''}
    <section class="detail-section"><h3>All booking options <small>${options.length} FORMATS</small></h3>
      ${options.length ? options.map((option) => renderOption(product, option)).join('') : '<p class="detail-intro">No price options were supplied in the source workbook.</p>'}</section>
    ${locations.length ? `<section class="detail-section"><h3>Available markets <small>${locations.length} ROWS</small></h3>${locations.map((row) =>
      `<div class="location">${esc([row.fields.City,row.fields.State,row.fields.Locality].filter(Boolean).join(' · ') || 'Location details missing')} <small>· row ${row.source_row}</small></div>`).join('')}</section>` : ''}
    <section class="detail-section"><h3>Problems & notes <small>${product.issues.length} FINDINGS</small></h3>
      ${product.issues.length ? product.issues.map((issue) => `<div class="finding ${esc(issue.severity)}"><strong>${esc(issue.code.replaceAll('_',' '))}</strong><p>${esc(issue.message)} ${issue.suggested_value ? `Suggested: ${issue.suggested_value}` : ''}</p><small>${esc(issue.sheet)} · row ${issue.source_row} · ${esc(issue.field)}${issue.current_value ? ` · Current: ${esc(issue.current_value)}` : ''}</small></div>`).join('') : '<p class="detail-intro">No detected issues. Verify rates and availability before quoting.</p>'}</section>
    <section class="detail-section"><h3>Planner note</h3><p class="detail-intro">${esc(media.note)}</p><details class="source-details"><summary>All product source fields</summary><div class="fact-grid">${fieldFacts(f, ['Delete'])}</div></details></section>
  </div>`;
}

async function openDrawer(id) {
  const token = ++state.drawerToken;
  $('drawer-shell').hidden = false;
  document.body.style.overflow = 'hidden';
  $('drawer-content').innerHTML = '<div class="detail">Loading product details…</div>';
  $('drawer-close').focus();
  try {
    const product = await get(`${api}/products/${id}`);
    if (token === state.drawerToken) $('drawer-content').innerHTML = detail(product);
  } catch (error) { if (token === state.drawerToken) $('drawer-content').innerHTML = `<div class="detail">${esc(error.message)}</div>`; }
}
function closeDrawer() { state.drawerToken++; $('drawer-shell').hidden = true; document.body.style.overflow = ''; }

function bind() {
  let timer;
  $('search').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(restart, 250); });
  $('filters').addEventListener('submit', (event) => { event.preventDefault(); restart(); });
  for (const id of ['problem','sort']) $(id).addEventListener('change', restart);
  $('reset').addEventListener('click', () => { $('filters').reset(); syncChips(); restart(); });
  $('inventory').addEventListener('click', (event) => { const card = event.target.closest('.card'); if (card) openDrawer(card.dataset.id); });
  $('inventory').addEventListener('keydown', (event) => { if (event.key !== 'Enter' && event.key !== ' ') return; const card = event.target.closest('.card'); if (card) { event.preventDefault(); openDrawer(card.dataset.id); } });
  $('drawer-close').addEventListener('click', closeDrawer);
  $('drawer-scrim').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeDrawer(); });
  observer.observe($('load-marker'));
}

(async () => {
  renderNav(); bind();
  try {
    const [stats, filters, summary] = await Promise.all([
      get(`${api}/stats`), get(`${api}/filters`), get(`${api}/problems/summary`)
    ]);
    renderStats(stats); renderFilters(filters, summary); restart();
    const sharedId = Number.parseInt(new URLSearchParams(location.search).get('product'), 10);
    if (Number.isInteger(sharedId) && sharedId > 0) openDrawer(sharedId);
  } catch (error) { $('inventory').innerHTML = `<div class="empty-state"><b>Catalog unavailable</b>${esc(error.message)}</div>`; }
})();
