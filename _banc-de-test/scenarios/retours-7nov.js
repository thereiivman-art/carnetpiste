// Lot du 7 nov : passés groupés, Liste/Mois accompagnant, podium Amis/Tous, recherche circuit, J'y étais annulable.
const { chromium, BASE } = require('../lib');
(async () => {
  const lang = process.argv[2] || 'fr';
  const b = await chromium.launch();
  const errs = [];
  const mk = async (hash) => { const p = await b.newPage({ viewport: { width: 380, height: 900 } }); p.on('pageerror', e => errs.push(e.message)); await p.goto(BASE + 'index.html#lang=' + lang + hash); await p.waitForTimeout(1600); return p; };
  // Pilote : Passés groupés par circuit
  let p = await mk('');
  await p.click('.bottom-nav-btn:nth-child(1)'); await p.waitForTimeout(300);
  await p.click('.pill-btn[data-cards-mode="passees"]').catch(() => {}); await p.waitForTimeout(400);
  await p.screenshot({ path: 'passes-groupes-' + lang + '.png' });
  console.log('groupes passés:', await p.$$eval('.outing-group-toggle', e => e.map(x => x.innerText).join(' | ')));
  await p.click('.pill-btn[data-cards-mode="avenir"]'); await p.waitForTimeout(300);
  console.log('autres roulages:', await p.$$eval('.event-row-dates', e => e.map(x => x.innerText).slice(0, 3).join(' | ')));
  // Podium
  await p.click('.subnav-btn[data-view="stats"]'); await p.waitForTimeout(400);
  console.log('podium scope:', await p.$$eval('[data-podium-scope]', e => e.map(x => x.innerText).join(' / ')), '| pastilles:', await p.$$eval('#moi-podium .verif-badge', e => e.length));
  // Circuits : recherche
  await p.click('.subnav-btn[data-view="circuits"], .subnav-btn[data-view="circuit"]').catch(() => {}); await p.waitForTimeout(400);
  const f = await p.$('#circuit-find'); console.log('recherche circuit:', !!f);
  if (f) { await p.fill('#circuit-find', 'mugel'); await p.press('#circuit-find', 'Enter'); await p.waitForTimeout(400); console.log('circuit choisi:', await p.$eval('#f-filter-circuit', e => e.value)); }
  // Team : roulages par circuit
  await p.close();
  // Accompagnant : Liste / Mois
  p = await mk('&role=acc');
  await p.click('.bottom-nav-btn:nth-child(1)'); await p.waitForTimeout(400);
  console.log('acc modes:', await p.$$eval('.avenir-modes button', e => e.map(x => x.innerText).join(' / ')));
  await p.click('.avenir-modes [data-pill="calendrier"]'); await p.waitForTimeout(400);
  console.log('acc mois pills:', await p.$$eval('.main-subnav-pills .pill-btn', e => e.map(x => x.innerText + (x.classList.contains('active') ? '*' : '')).join(' / ')));
  await p.click('.avenir-modes [data-pill="avenir"]'); await p.waitForTimeout(400);
  await p.click('[data-pill-group="compcarnet"][data-pill="passes"]').catch(() => {}); await p.waitForTimeout(400);
  console.log('acc passés groupés:', await p.$$eval('.outing-group-toggle', e => e.length));
  await p.click('.subnav-btn[data-view="circuits"], .subnav-btn[data-view="circuit"]').catch(() => {}); await p.waitForTimeout(400);
  await p.click('[data-pill-group="circuit"][data-pill="infos"]').catch(() => {}); await p.waitForTimeout(400);
  console.log('acc infos:', await p.$$eval('.circuit-info-list', e => e.map(x => x.innerText.split('\n').slice(0, 2).join(' ')).join('')));
  await p.close();
  console.log('errs', JSON.stringify(errs)); await b.close();
  if (errs.length) process.exit(1);
})();
