// Albums photos d'un roulage : un accompagnant (#role=acc) inscrit au
// roulage partage le lien de son album ; lien refusé s'il n'est pas une
// adresse web ; le pilote voit ensuite l'album dans l'onglet Photos.
const { chromium, BASE } = require('../lib');
(async () => {
  const lang = process.argv[2] || 'fr';
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 380, height: 1000 } });
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  const openE2 = async (hash) => {
    await p.goto('about:blank'); await p.goto(BASE + 'index.html#lang=' + lang + hash); await p.waitForTimeout(1600);
    if (await p.$('#jourj-overlay')) { await p.click('[data-jj="close"]'); await p.waitForTimeout(300); }
    await p.click('.bottom-nav-btn[data-view^="carnet"]'); await p.waitForTimeout(300);
    await p.click('.subnav-btn[data-view="carnet"]'); await p.waitForTimeout(300);
    const pp = await p.$('[data-pill="passes"]'); if (pp) { await pp.click(); await p.waitForTimeout(300); }
    console.log('ligne:', (await p.$eval('[data-outing-event="e2"]', e => e.innerText.replace(/\n/g, ' ')).catch(() => 'absente')));
    await p.click('[data-outing-event="e2"]'); await p.waitForTimeout(600);
    await p.click('.subnav-btn[data-view="infos"], [data-cpill="infos"], [data-pill="infos"]').catch(() => {}); await p.waitForTimeout(300);
    await p.click('[data-cpill="photos"]'); await p.waitForTimeout(300);
  };
  await openE2('&role=acc');
  await p.click('[data-action="edit-personal-media-link"]'); await p.waitForTimeout(300);
  await p.fill('#personal-media-link-input', 'pas un lien'); await p.click('[data-action="save-personal-media-link"]'); await p.waitForTimeout(300);
  console.log('refus:', (await p.$$eval('.toast', e => e.map(x => x.innerText))).pop());
  await p.fill('#personal-media-link-input', 'photos.app.goo.gl/AbCdEf'); await p.click('[data-action="save-personal-media-link"]'); await p.waitForTimeout(500);
  console.log('stocké:', JSON.stringify(await p.evaluate(() => window.__MOCK_DATA.events.e2.personalMediaLinks)));
  console.log('vue acc:', await p.$$eval('.album-row', e => e.map(x => x.innerText.replace(/\n/g, ' ')).join(' | ')));
  await p.screenshot({ path: 'albums-acc-' + lang + '.png' });
  console.log('errs', JSON.stringify(errs)); await b.close();
})();
