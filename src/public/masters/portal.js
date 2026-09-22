const media = {
  btl: ['BTL & Non-Traditional', 'On-ground placements, audiences and execution options', '/btl/'],
  cinema: ['Cinema', 'Venues, screens and ad-film formats', '/cinema/'],
  digital: ['Digital', 'Platforms, pricing models and placement variants', '/digital/'],
  digital_pr: ['Digital PR', 'Publishers, authority and article bookings', '/digital-pr/'],
  magazine: ['Magazine', 'Titles, readership and page positions', '/magazine/'],
  newspaper: ['Newspaper', 'Publications, languages and local markets', '/newspaper/'],
  radio: ['Radio', 'Stations, time bands and audio spots', '/radio/'],
  transit: ['Transit', 'Moving media, quantity rules and routes', '/transit/'],
  tv: ['Television', 'Channels, airtime and time bands', '/tv/']
};
const count = new Intl.NumberFormat('en-IN');
fetch('/api/masters').then((response) => response.json()).then(({ catalogs }) => {
  document.getElementById('portal-grid').innerHTML = catalogs.map((item, index) => {
    const [label, description, href] = media[item.slug];
    return `<a class="portal-card" href="${href}"><small>${String(index + 1).padStart(2,'0')} / MASTER DESK</small>
      <h3>${label}</h3><p>${description}</p><div><strong>${count.format(item.products)} <small>products</small></strong><span>Open desk ↗</span></div></a>`;
  }).join('');
}).catch(() => { document.getElementById('portal-grid').textContent = 'Catalog directory unavailable. Check the database import.'; });
