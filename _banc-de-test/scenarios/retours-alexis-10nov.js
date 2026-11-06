// Retours Alexis (10 nov) : météo du jour dans Infos, niveau selon moto /
// voiture / les deux, tri « Mes circuits », incident depuis le chrono d'un
// ami, carte d'incident selon le thème, tracés Mas du Clos et Clastres.
const { chromium, BASE } = require('../lib');
(async () => { const b = await chromium.launch(); const errs = []; const lang = process.argv[2] || 'fr';
  const p = await b.newPage({ viewport: { width: 390, height: 900 }, colorScheme: 'dark' }); p.on('pageerror', e => errs.push(e.message));
  await p.goto(BASE + 'index.html#lang=' + lang); await p.waitForTimeout(1600);
  await p.click('.bottom-nav-btn:nth-child(1)'); await p.waitForTimeout(300);
  await p.click('.subnav-btn[data-view="circuit"]'); await p.waitForTimeout(400);
  await p.locator('[data-pill-group="circuit"][data-pill="infos"]:visible').first().click().catch(() => {}); await p.waitForTimeout(1500);
  console.log('ordre des cartes:', await p.$$eval('#root .card .section-title', e => e.map(x => x.innerText).filter(t => /Météo|Weather|Niveau|Level/.test(t)).join(' > ')));
  console.log('niveau (moto seul):', await p.$$eval('.circuit-lg .lvl-row', r => r.map(x => x.querySelectorAll('.lvl-who').length).join(' + ')));
  await p.evaluate(() => { /* je roule dans les deux */ });
  console.log('tri:', await p.$$eval('#circuit-sort option', o => o.map(x => x.textContent).join(' / ')));
  await p.selectOption('#circuit-sort', 'mes'); await p.waitForTimeout(400);
  console.log('groupes Mes circuits:', await p.$$eval('#root select optgroup', g => g.map(x => x.label + ' (' + x.children.length + ')').slice(0, 3).join(' | ')));
  // Tracés ajoutés
  console.log('tracés:', JSON.stringify(await p.evaluate(() => Promise.all(['Mas%20du%20Clos', 'Clastres'].map(n => new Promise(r => { const i = new Image(); i.onload = () => r(n + ' ' + i.naturalWidth); i.onerror = () => r(n + ' KO'); i.src = 'circuit-outlines/' + n + '.png'; }))))));
  // Incident depuis le chrono d'un ami
  await p.goto('about:blank'); await p.goto(BASE + 'index.html#lang=' + lang + '&jourj=1'); await p.waitForTimeout(1600);
  await p.click('.bottom-nav-main').catch(() => {}); await p.waitForTimeout(500);
  console.log('onglet Chrono (pilote):', await p.$$eval('.chrono-friend-row button', e => e.map(x => x.innerText).join(' / ')));
  const live = await p.$('[data-action="incident-live"]');
  if (live) { await live.click(); await p.waitForTimeout(300); console.log('incident en cours, pour qui:', await p.$$eval('[data-inc-who]', e => e.map(x => x.innerText).join(' / '))); await p.evaluate(() => document.querySelectorAll('.mini-sheet-overlay').forEach(o => o.remove())); }
  const cp2 = p.locator('[data-action="chrono-proposal"]:visible, [data-jj="propose"]:visible');
  console.log('bouton chrono d\'un ami:', await cp2.count());
  if (await cp2.count()) {
    await cp2.first().click(); await p.waitForTimeout(400);
    await p.fill('#cp-circuit', 'Mugello');
    const to = await p.$eval('#cp-to', s => s.value);
    await p.click('[data-cp="incident"]'); await p.waitForTimeout(400);
    console.log('incident pour:', await p.$eval('[data-inc-who][aria-pressed="true"]', e => e.innerText).catch(() => '?'), '(ami choisi :', to + ')');
    console.log('plan sombre:', await p.$eval('.incident-map img', e => getComputedStyle(e).filter).catch(() => 'pas de plan'));
    await p.click('[data-inc-type="chute"]'); await p.click('[data-inc="ok"]'); await p.waitForTimeout(700);
    const post = await p.evaluate(() => Object.values(window.__MOCK_DATA.wallPosts).filter(w => w.incident && w.incident.subject).map(w => w.text)[0]);
    console.log('publié:', post);
  }
  console.log('errs', JSON.stringify(errs)); await b.close(); })();
