const state = { controller: null };
const el = Object.fromEntries(['filter-form','search','city','language','tier','problem','sort','reset','inventory','result-label','tier-strip','drawer-shell','drawer','drawer-content'].map((id) => [id.replaceAll('-', '_'), document.getElementById(id)]));
const currency = new Intl.NumberFormat('en-IN',{style:'currency',currency:'INR',maximumFractionDigits:2});
const integer = new Intl.NumberFormat('en-IN');

async function initialize() {
  bindEvents();
  const [stats,filters] = await Promise.all([json('/api/radio/stats'),json('/api/radio/filters')]);
  renderStats(stats); renderFilters(filters,stats.tiers); await loadProducts();
  const product = Number.parseInt(new URLSearchParams(location.search).get('product'),10);
  if(Number.isInteger(product)&&product>0) await openDrawer(product,false);
}
function bindEvents(){
  let timer; el.search.addEventListener('input',()=>{clearTimeout(timer);timer=setTimeout(loadProducts,260)});
  for(const input of [el.city,el.language,el.tier,el.problem,el.sort]) input.addEventListener('change',()=>{loadProducts();syncChips()});
  el.filter_form.addEventListener('submit',(event)=>{event.preventDefault();loadProducts()});
  el.reset.addEventListener('click',()=>{el.filter_form.reset();syncChips();loadProducts()});
  document.getElementById('drawer-close').addEventListener('click',closeDrawer);
  document.getElementById('drawer-scrim').addEventListener('click',closeDrawer);
  document.addEventListener('keydown',(event)=>{if(event.key==='Escape')closeDrawer()});
}
function renderStats(stats){
  document.getElementById('stat-products').textContent=integer.format(stats.products);
  document.getElementById('stat-options').textContent=integer.format(stats.price_options);
  document.getElementById('stat-variants').textContent=integer.format(stats.variants);
  document.getElementById('stat-issues').textContent=integer.format(stats.issues);
  document.getElementById('quality-issues').textContent=integer.format(stats.issues);
  document.getElementById('quality-products').textContent=integer.format(stats.affected_products);
  document.getElementById('last-sync').textContent=stats.imported_at?`Synced ${new Date(stats.imported_at).toLocaleDateString('en-IN',{day:'2-digit',month:'short'})}`:'Awaiting import';
}
function renderFilters(filters,tiers){
  for(const value of filters.cities) el.city.add(new Option(value,value));
  for(const value of filters.languages) el.language.add(new Option(value,value));
  for(const value of filters.tiers) el.tier.add(new Option(value,value));
  el.tier_strip.replaceChildren(...tiers.map((item)=>{const button=document.createElement('button');button.type='button';button.className='media-chip';button.dataset.value=item.name;button.innerHTML=`${escapeHtml(item.name)} <b>${integer.format(item.count)}</b>`;button.addEventListener('click',()=>{el.tier.value=el.tier.value===item.name?'':item.name;syncChips();loadProducts()});return button}));
}
function syncChips(){for(const chip of el.tier_strip.children)chip.classList.toggle('active',chip.dataset.value===el.tier.value)}
async function loadProducts(){
  if(state.controller)state.controller.abort();state.controller=new AbortController();el.inventory.replaceChildren(document.getElementById('loading-template').content.cloneNode(true));
  const query=new URLSearchParams({show_all:1,sort:el.sort.value});
  for(const [key,input] of [['search',el.search],['city',el.city],['language',el.language],['tier',el.tier],['problem',el.problem]])if(input.value.trim())query.set(key,input.value.trim());
  try{const result=await json(`/api/radio/products?${query}`,state.controller.signal);el.inventory.replaceChildren(...(result.data.length?result.data.map(productRow):[emptyState()]));el.result_label.textContent=`${integer.format(result.pagination.total)} stations · all shown`}catch(error){if(error.name!=='AbortError')el.inventory.innerHTML='<div class="error-state"><b>Radio database unavailable</b></div>'}
}
function productRow(product){
  const button=document.createElement('button');button.type='button';button.className='inventory-row';button.addEventListener('click',()=>openDrawer(product.id));
  const image=product.image?`/radio-images/${encodeURIComponent(product.image)}`:'';const client=money(product.min_rate);const buying=money(product.min_buying_rate);
  button.innerHTML=`<span class="asset"><span class="asset-image" data-code="FM">${image?`<img src="${image}" alt="" loading="lazy">`:''}</span><span class="asset-copy"><strong>${escapeHtml(product.name)}</strong><span class="asset-flags"><small class="sku">${escapeHtml(product.sku)}</small>${product.issue_count?`<span class="issue-badge ${product.error_count?'':'warning'}">${product.issue_count} note${product.issue_count===1?'':'s'}</span>`:''}</span></span></span><span class="radio-frequency">${product.frequency??'—'} FM<small>${escapeHtml(product.city||'City missing')} · ${escapeHtml(product.tier||'No tier')}</small></span><span class="language-line">${escapeHtml(product.language||'Language missing')}<small>${escapeHtml(product.audience||'Audience not set')} · Rank ${product.rank??'—'}</small></span><span class="rate"><strong>${client}</strong><small>client · buying from ${buying}</small>${product.loss_price_count?`<span class="loss-note">${product.loss_price_count} below cost</span>`:''}</span><span class="row-arrow">↗</span>`;
  const img=button.querySelector('img');if(img)img.addEventListener('error',()=>img.parentElement.classList.add('is-fallback'));else button.querySelector('.asset-image').classList.add('is-fallback');return button;
}
function emptyState(){const div=document.createElement('div');div.className='empty-state';div.innerHTML='<b>No station found</b><span>Try another city, language or problem filter.</span>';return div}
async function openDrawer(id,update=true){el.drawer_shell.hidden=false;document.body.style.overflow='hidden';if(update){const url=new URL(location.href);url.searchParams.set('product',id);history.replaceState(null,'',url)}el.drawer_content.innerHTML='<div class="drawer-loading">Tuning station…</div>';el.drawer.focus();try{renderDrawer(await json(`/api/radio/products/${id}`))}catch{el.drawer_content.innerHTML='<div class="error-state"><b>Station unavailable</b></div>'}}
function closeDrawer(){if(el.drawer_shell.hidden)return;el.drawer_shell.hidden=true;document.body.style.overflow='';const url=new URL(location.href);url.searchParams.delete('product');history.replaceState(null,'',url)}
function renderDrawer(product){
  const errors=product.issues.filter((issue)=>issue.severity==='error').length;const lossCount=product.issues.filter((issue)=>issue.code.includes('SELLING_BELOW')).length;const image=product.image?`/radio-images/${encodeURIComponent(product.image)}`:'';
  const issues=product.issues.map((issue)=>`<div class="issue-item ${issue.severity}"><b>${escapeHtml(issue.code.replaceAll('_',' '))} · ${escapeHtml(issue.source_sheet)} row ${issue.source_row}</b><p>${escapeHtml(issue.message)}</p><span class="issue-fix">${escapeHtml(issue.field)}: “${escapeHtml(issue.current_value??'blank')}” → <strong>${escapeHtml(issue.suggested_value||'review')}</strong></span></div>`).join('');
  const cards=product.price_options.map((option)=>{
    const units=option.units.map((unit)=>`<div class="configuration-row"><div><b>${escapeHtml(unit.unit_name)}</b><small>${escapeHtml(unit.code||'')}</small></div><span>Range ${range(unit.minimum,unit.maximum)}</span><span>Step ${unit.step??'—'}</span></div>`).join('');
    const attrs=option.attributes.map((attribute)=>`<div class="configuration-row"><div><b>${escapeHtml(attribute.name)}</b><small>${escapeHtml(attribute.type||'Attribute')}</small></div><div class="value-list">${attribute.values.map((value)=>`<span>${escapeHtml(value.value)}</span>`).join('')}</div></div>`).join('');
    const variants=option.variants.map((variant)=>{const effective=variant.discounted_price??variant.price;const margin=effective===null||variant.specific_buying_rate===null?null:effective-variant.specific_buying_rate;const loss=margin!==null&&margin<0;return `<div class="variant-row ${loss?'loss':''}"><b>${escapeHtml(variant.name)}</b><span>${money(variant.price)}</span><span>${money(variant.discounted_price)}</span><span>${money(variant.specific_buying_rate)}</span><span>${money(margin)}</span></div>`}).join('');
    const sample=safeUrl(option.media_gallery)?`<a class="audio-link" href="${escapeHtml(option.media_gallery)}" target="_blank" rel="noreferrer">▶ Listen to audio sample</a>`:'';
    return `<article class="price-card ${option.has_loss?'has-loss':''}"><div class="price-card-head"><div><small>Format · ${escapeHtml(option.sku)}</small><h5>${escapeHtml(option.name)}</h5></div><div class="format-price"><small>Effective client price</small><div class="money">${money(option.effective_client_rate)}</div>${option.has_loss?'<b class="loss-chip">Below buying cost</b>':''}</div></div>${sample}<div class="price-matrix"><div><small>Offer rate</small><b>${money(option.offer_rate)}</b></div><div><small>Discounted rate</small><b>${money(option.discounted_rate)}</b></div><div class="client-price"><small>Effective client</small><b>${money(option.effective_client_rate)}</b></div><div><small>Buying cost</small><b>${money(option.specific_buying_rate)}</b></div><div class="${option.effective_margin<0?'loss':'profit'}"><small>Margin</small><b>${money(option.effective_margin)}</b></div><div><small>Minimum billing</small><b>${money(option.minimum_billing)}</b></div><div><small>Pricing unit</small><b>${escapeHtml(option.pricing_unit||'—')}</b></div><div><small>GST</small><b>${option.gst??'—'}%</b></div><div><small>On request</small><b>${option.on_request==='Y'?'Yes':'No'}</b></div></div><div class="configuration-groups">${units?`<section><h6>Campaign quantity rules</h6>${units}</section>`:''}${attrs?`<section><h6>Time-band attributes</h6>${attrs}</section>`:''}${variants?`<section><h6>All time-band price variants</h6><div class="variant-table"><div class="variant-head"><span>Variant</span><span>Price</span><span>Discounted</span><span>Buying</span><span>Margin</span></div>${variants}</div></section>`:''}</div></article>`;
  }).join('');
  const locationRow=product.locations[0]||{};
  el.drawer_content.innerHTML=`<div class="planning-status ${errors?'needs-review':'ready'}"><div><small>Radio plan status</small><b>${errors?'Review before client plan':'Ready for client plan'}</b></div><span>${errors} errors · ${product.issues.length-errors} notes${lossCount?` · ${lossCount} loss risks`:''}</span></div><section class="product-showcase drawer-hero"><div class="showcase-media">${image?`<img src="${image}" alt="${escapeHtml(product.name)}">`:'<div class="showcase-placeholder">No station image</div>'}</div><div class="showcase-copy"><p class="eyebrow">${escapeHtml(product.station||'Radio')} · ${product.frequency??'—'} FM</p><h3 id="drawer-title">${escapeHtml(product.name)}</h3><div class="showcase-price"><small>Client rate from</small><strong>${money(Math.min(...product.price_options.map((item)=>item.effective_client_rate).filter((value)=>value!==null)))}</strong><span>${product.price_options.reduce((sum,item)=>sum+item.variants.length,0)} time-band variants</span></div><p class="drawer-description">${escapeHtml(product.short_description||'No description supplied.')}</p><div class="drawer-meta"><div><small>Market</small><strong>${escapeHtml(locationRow.city||'—')}, ${escapeHtml(locationRow.state||'—')}</strong></div><div><small>Language</small><strong>${escapeHtml(product.language||'—')}</strong></div><div><small>Audience</small><strong>${escapeHtml(product.audience||'—')}</strong></div></div></div></section>${issues?`<section class="issue-panel"><div class="issue-panel-head"><b>Problems & planner notes</b><span>${product.issues.length} items</span></div>${issues}</section>`:'<div class="clean-note">No data-quality problems detected for this station.</div>'}<div class="drawer-section-title"><h4>All radio prices & options</h4><span>${product.price_options.length} formats</span></div>${cards}`;
  const img=el.drawer_content.querySelector('.showcase-media img');if(img)img.addEventListener('error',()=>img.closest('.showcase-media').classList.add('image-missing'));
}
function money(value){return value===null||value===undefined||!Number.isFinite(Number(value))?'—':currency.format(value)}
function range(min,max){if(min===null&&max===null)return'—';return max===null?`min ${integer.format(min)}`:`${integer.format(min)}–${integer.format(max)}`}
function safeUrl(value){if(!value)return false;try{return ['http:','https:'].includes(new URL(value).protocol)}catch{return false}}
async function json(url,signal){const response=await fetch(url,{signal});if(!response.ok)throw new Error(response.status);return response.json()}
function escapeHtml(value){return String(value??'').replace(/[&<>'"]/g,(char)=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'})[char])}
initialize().catch((error)=>{console.error(error);el.inventory.innerHTML='<div class="error-state"><b>Could not initialize Radio Master</b></div>'});
