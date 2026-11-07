// Réaction triste, masquer une carte du fil, date d'un incident, tri de la
// recherche sur sa ligne, vidéo de story : champ qui survit au redessin et
// « Réessayer » sans repasser par l'album.
const { chromium, BASE } = require('../lib');
const openIncident = require('./_incident-helper');
(async () => { const b = await chromium.launch(); const errs = []; const lang = process.argv[2] || 'fr';
  const p = await b.newPage({ viewport: { width: 390, height: 900 } }); p.on('pageerror', e => errs.push(e.message));
  await p.goto(BASE + 'index.html#lang=' + lang + '&admin=1'); await p.waitForTimeout(1600);
  await p.click('.bottom-nav-btn:nth-child(3)'); await p.waitForTimeout(500);
  console.log('emoji triste:', await p.$$eval('.reaction-picker', e => e.length && e[0].innerText.includes('😢')));
  await p.screenshot({ path: __dirname + '/../.sortie/lot9-fil.png' });
  const n0 = await p.$$eval('.feed-card', e => e.length);
  const hb = await p.$('.feed-card .feed-hide');
  console.log('croix Masquer:', !!hb, '| cartes:', n0);
  if (hb) {
    const key = await hb.getAttribute('data-feed-hide');
    await hb.click(); await p.waitForTimeout(400);
    console.log('masquée:', !(await p.$('[data-feed-hide="' + key + '"]')), '| sur le compte:', await p.evaluate(() => firebase.firestore().collection('userPrivate').doc(firebase.auth().currentUser.uid).get().then(d => Object.keys((d.data() || {}).hiddenFeed || {}).length)));
  }
  // Recherche : tri sur sa ligne
  await p.locator('#search-toggle:visible').first().click(); await p.waitForTimeout(300);
  await p.fill('#gsearch-q', 'mu'); await p.waitForTimeout(300);
  console.log('filtres fermés au départ:', !(await p.$('.gsearch-filters')), '| engrenage:', !!(await p.$('[data-gs-adv]')));
  await p.click('[data-gs-adv]'); await p.waitForTimeout(200);
  const lay = await p.evaluate(() => { const f = document.querySelector('.gsearch-filters').getBoundingClientRect(), s = document.querySelector('.gsearch-sort').getBoundingClientRect(); return { sousLesFiltres: s.top >= f.bottom - 1, gauche: Math.round(s.left - f.left) }; });
  console.log('tri:', JSON.stringify(lay));
  await p.screenshot({ path: __dirname + '/../.sortie/lot9-recherche.png' });
  await p.evaluate(() => document.querySelectorAll('.mini-sheet-overlay').forEach(o => o.remove())); await p.waitForTimeout(200);
  console.log('après Échap:', await p.evaluate(() => [...document.body.children].filter(e => e.id !== 'root' && getComputedStyle(e).position === 'fixed' && e.offsetHeight > 300).map(e => e.className || e.id).join(',')));
  // Story vidéo illisible → panneau d'échec avec Réessayer
  const inp = await p.$('#story-input');
  console.log('champ story hors de #root:', await p.evaluate(() => { const i = document.getElementById('story-input'); return !!i && !document.getElementById('root').contains(i); }));
  await p.evaluate(() => { window.__rr = 0; });
  await p.setInputFiles('#story-input', { name: 'clip.mp4', mimeType: 'video/mp4', buffer: Buffer.alloc(3500000, 7) });
  await p.waitForSelector('[data-prep="retry"]', { timeout: 40000 }).catch(() => {});
  console.log('overlay:', await p.$$eval('.story-overlay', o => o.map(x => x.innerText.replace(/\n/g, ' ').slice(0, 80)).join(' | ')));
  const prep = await p.$('[data-prep="retry"]');
  const toasts = await p.$$eval('.toast', t => t.map(x => x.innerText).join(' | '));
  console.log('échec affiché:', await p.$eval('.story-prep-err', e => e.innerText.slice(0, 60)).catch(() => '(non) ' + toasts), '| Réessayer:', !!prep);
  if (prep) { await prep.click(); await p.waitForTimeout(400); console.log('réessai lancé:', !!(await p.$('#story-prep, .story-prep-err'))); }
  await p.evaluate(() => document.querySelectorAll('.story-overlay').forEach(o => o.remove()));
  // Incident d'un ami avec une date, puis modifiée
  await p.click('.bottom-nav-btn:nth-child(1)'); await p.waitForTimeout(300);
  await p.click('.subnav-btn[data-view="carnet"]'); await p.waitForTimeout(300);
  await p.locator('[data-cards-mode="passees"]:visible').first().click().catch(() => {}); await p.waitForTimeout(400);
  await p.locator('#root [data-outing-event]:visible').first().click({ position: { x: 30, y: 14 } }); await p.waitForTimeout(700);
  await openIncident(p, 'Mugello', null, 'e2');
  const who = await p.$$eval('[data-inc-who]', e => e.map(x => x.getAttribute('data-inc-who')));
  await p.click('[data-inc-who="' + who[who.length - 1] + '"]'); await p.waitForTimeout(200);
  console.log('champ date pour un ami:', await p.$eval('#inc-date', e => e.value).catch(() => 'absent'));
  await p.fill('#inc-date', '2026-09-14'); await p.click('[data-inc="ok"]'); await p.waitForTimeout(700);
  const post = await p.evaluate(() => Object.values(window.__MOCK_DATA.wallPosts).filter(w => w.incident && w.incident.subject)[0]);
  console.log('publié:', post && post.text, '|', post && post.incident.date);
  await p.click('.bottom-nav-btn:nth-child(3)'); await p.waitForTimeout(500);
  const db2 = await p.$('[data-action="incident-date"]');
  console.log('bouton Date:', !!db2);
  console.log('lieu précis:', await p.$eval('.post-place', e => e.innerText + ' → ' + decodeURIComponent(e.href)).catch(() => 'absent'));
  if (db2) { await db2.click(); await p.waitForTimeout(300); await p.fill('#inc-date-edit', '2026-09-20'); await p.click('[data-inc-date="ok"]'); await p.waitForTimeout(500);
    console.log('modifié:', await p.evaluate((id) => window.__MOCK_DATA.wallPosts[id].text + ' | ' + window.__MOCK_DATA.wallPosts[id].incident.date, post.id)); }
  console.log('errs', JSON.stringify(errs)); await b.close(); })();
