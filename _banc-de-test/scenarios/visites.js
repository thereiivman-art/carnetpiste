// Circuits › Visités : chaque roulage ouvre SA page ; un circuit visité sans y
// rouler (GP en spectateur) s'ajoute à la main et s'affiche aussi.
// Lien de partage d'un team : ?team=<id> ouvre le team.
const { chromium, BASE } = require('../lib');
(async () => { const b = await chromium.launch(); const lang = process.argv[2] || 'fr'; const errs = [];
  let p = await b.newPage({ viewport: { width: 390, height: 900 } }); p.on('pageerror', e => errs.push(e.message));
  await p.goto(BASE + 'index.html#lang=' + lang + '&role=acc'); await p.waitForTimeout(1600);
  await p.click('.bottom-nav-btn:nth-child(1)'); await p.waitForTimeout(300);
  await p.click('.subnav-btn[data-view="circuit"]'); await p.waitForTimeout(400);
  await p.click('[data-pill-group="circuit"][data-pill="visites"]'); await p.waitForTimeout(500);
  const ev = await p.$('.visited-ev[data-outing-event]');
  const want = ev ? await ev.getAttribute('data-outing-event') : null;
  console.log('pastilles de roulage:', await p.$$eval('.visited-ev[data-outing-event]', e => e.length));
  if (ev) { await ev.click(); await p.waitForTimeout(600); console.log('page ouverte:', await p.evaluate(() => !!document.querySelector('.outing-page')), '| roulage voulu:', want); }
  await p.goBack().catch(() => {}); await p.waitForTimeout(500);
  await p.click('.subnav-btn[data-view="circuit"]').catch(() => {}); await p.waitForTimeout(300);
  await p.click('[data-pill-group="circuit"][data-pill="visites"]').catch(() => {}); await p.waitForTimeout(400);
  await p.click('[data-action="extra-visit-open"]'); await p.waitForTimeout(300);
  await p.selectOption('#extra-visit-circuit', 'Sepang'); await p.selectOption('#extra-visit-year', '2019');
  await p.click('[data-action="extra-visit-add"]'); await p.waitForTimeout(500);
  console.log('visité sans rouler:', await p.$$eval('.visited-tile', e => e.filter(x => /Sepang/.test(x.innerText)).map(x => x.innerText.replace(/\n/g, ' ')).join()));
  await p.screenshot({ path: 'visites-' + lang + '.png' });
  await p.close();
  p = await b.newPage({ viewport: { width: 390, height: 900 } }); p.on('pageerror', e => errs.push(e.message));
  const tid = await (async () => { await p.goto(BASE + 'index.html#lang=' + lang); await p.waitForTimeout(1200); return p.evaluate(() => Object.keys(window.__MOCK_DATA.teams)[0]); })();
  await p.goto(BASE + 'index.html?team=' + tid + '#lang=' + lang); await p.waitForTimeout(1800);
  console.log('team ouvert par le lien:', await p.evaluate(() => !!document.querySelector('[data-action="team-tile-close"], .team-hero')));
  console.log('errs', JSON.stringify(errs)); await b.close(); })();
