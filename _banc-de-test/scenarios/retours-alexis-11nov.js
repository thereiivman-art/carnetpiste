// Retours Alexis (11 nov) : Autour du circuit, météo du jour (ville, icône),
// Tour de piste, infos du circuit dans le roulage, agenda avec icône, X en lecteur,
// carte d'incident agrandie et dessin en mode sombre.
const { chromium, BASE } = require('../lib');
(async () => { const b = await chromium.launch(); const errs = []; const lang = process.argv[2] || 'fr';
  const p = await b.newPage({ viewport: { width: 390, height: 900 }, colorScheme: 'dark' }); p.on('pageerror', e => errs.push(e.message));
  await p.route('https://api.open-meteo.com/**', r => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ current: { temperature_2m: 14.2, weather_code: 61, wind_speed_10m: 12 }, hourly: { precipitation: [0, 0.4, 0.6, 0, 0, 0.1, 0] }, daily: { weather_code: [61], temperature_2m_max: [16], temperature_2m_min: [8], precipitation_probability_max: [70] } }) }));
  await p.goto(BASE + 'index.html#lang=' + lang); await p.waitForTimeout(1600);
  await p.click('.bottom-nav-btn:nth-child(1)'); await p.waitForTimeout(300);
  await p.click('.subnav-btn[data-view="circuit"]'); await p.waitForTimeout(400);
  await p.locator('[data-pill-group="circuit"][data-pill="infos"]:visible').first().click(); await p.waitForTimeout(2500);
  console.log('météo:', await p.$eval('.today-wx', e => e.querySelector('.section-title').innerText + ' | icône:' + !!e.querySelector('.wx-ico') + ' | lien:' + !!e.querySelector('.wx-more')).catch(() => 'absente'));
  console.log('autour:', await p.$$eval('.circuit-around a', a => a.length + ' liens, ex. ' + decodeURIComponent(a[0].href).slice(0, 70)));
  // Dessin en mode sombre
  await p.locator('[data-pill-group="circuit"][data-pill="plan"]:visible').first().click(); await p.waitForTimeout(500);
  await p.locator('[data-action="open-annot"], button:has-text("Dessin")').first().click().catch(() => {}); await p.waitForTimeout(800);
  console.log('dessin sombre:', await p.$eval('#annot-canvas-wrap', w => w.classList.contains('outline-base') + ' fond=' + getComputedStyle(w).backgroundColor + ' filtre=' + getComputedStyle(w.querySelector('.annot-basemap')).filter).catch(() => 'pas ouvert'));
  await p.evaluate(() => { const o = document.getElementById('annot-overlay'); if (o) o.classList.remove('open'); });
  // Roulage : onglet Infos › Circuit, Tour de piste, agenda
  await p.goto('about:blank'); await p.goto(BASE + 'index.html#lang=' + lang); await p.waitForTimeout(1600);
  await p.click('.bottom-nav-btn:nth-child(1)'); await p.waitForTimeout(300);
  await p.click('.subnav-btn[data-view="carnet"]').catch(() => {}); await p.waitForTimeout(300);
  await p.locator('#root [data-outing-event]:visible').first().click({ position: { x: 30, y: 14 } }); await p.waitForTimeout(700);
  await p.locator('[data-pill-group="outing"][data-pill="infos"]:visible, [data-pill="infos"]:visible').first().click().catch(() => {}); await p.waitForTimeout(500);
  console.log('liens roulage:', await p.$$eval('.circuit-links a', a => a.map(x => x.innerText.replace(' ↗', '')).join(' / ')).catch(() => '-'));
  console.log('pastilles roulage:', await p.$$eval('[data-pill-group]', a => [...new Set(a.map(x => x.getAttribute('data-pill-group') + ':' + x.getAttribute('data-pill')))].join(' ')));
  await p.locator('[data-pill="circuit"]:visible').first().click().catch(() => {}); await p.waitForTimeout(400);
  console.log('onglet Circuit:', await p.$$eval('#root .section-title', t => t.map(x => x.innerText).filter(x => /Niveau|Autour|Records/.test(x)).join(' / ')));
  console.log('pastilles infos:', await p.$$eval('[data-pill-group="outinfo"]', a => a.map(x => x.innerText).join(' / ')));
  console.log('agenda icône:', await p.$$eval('[data-action="add-to-calendar"] svg', s => s.length));
  // Publication avec un lien X
  await p.evaluate(() => firebase.firestore().collection('wallPosts').doc('xpost').set({ id: 'xpost', author: 'Sam', authorUid: 'u-sam', audience: 'all', text: 'Regarde', linkUrl: 'https://x.com/i/status/2118717665342619697', createdAt: Date.now() }));
  await p.click('.bottom-nav-btn[data-nav-tab="communaute"]'); await p.waitForTimeout(800);
  console.log('X:', await p.$eval('.link-player-face[data-url*="x.com"]', f => f.getAttribute('data-embed')).catch(() => 'pas de lecteur'));
  await p.locator('.link-player.is-x').first().scrollIntoViewIfNeeded().catch(() => {}); await p.waitForTimeout(900);
  console.log('X affiché tout seul:', !!(await p.$('.inline-player.is-x iframe[src*="platform.twitter.com"]')));
  console.log('errs', JSON.stringify(errs)); await b.close(); })();
