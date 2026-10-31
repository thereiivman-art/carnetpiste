// Revenir en arrière : depuis le fil, ouvrir un circuit puis revenir (bouton
// « ‹ Retour », retour du navigateur) à la même position de défilement ;
// « Bientôt sur la piste » ouvre le roulage ; glisser depuis le bord.
const { chromium, BASE } = require('../lib');
(async () => {
  const lang = process.argv[2] || 'fr';
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 380, height: 800 }, hasTouch: true });
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto(BASE + 'index.html#lang=' + lang); await p.waitForTimeout(1700);
  await p.click('.bottom-nav-btn:nth-child(3)'); await p.waitForTimeout(400);
  await p.click('[data-pill-group="social"][data-pill="fil"]'); await p.waitForTimeout(300);
  // Bientôt sur la piste → le roulage, puis retour
  await p.click('.feed-upcoming-open >> nth=1'); await p.waitForTimeout(600);
  console.log('bientôt → page:', await p.$eval('.page-title-row, h1, .outing-title', e => e.innerText.split('\n')[0]).catch(() => '?'));
  await p.click('.back-chevron'); await p.waitForTimeout(500);
  console.log('retour → fil:', !!(await p.$('.composer-teaser')));
  // Défiler, ouvrir un circuit, revenir
  await p.evaluate(() => { const c = document.querySelectorAll('.feed-card .feed-ride-circuit'); c[c.length - 1].scrollIntoView(); });
  await p.waitForTimeout(300);
  const y0 = await p.evaluate(() => Math.round(scrollY));
  await p.evaluate(() => { const c = document.querySelectorAll('.feed-card .feed-ride-circuit'); c[c.length - 1].click(); });
  await p.waitForTimeout(600);
  console.log('circuit:', await p.$eval('.subnav-btn.active', e => e.innerText), '| bouton retour:', !!(await p.$('.nav-back-btn')));
  await p.click('.nav-back-btn'); await p.waitForTimeout(700);
  console.log('retour (bouton): fil', !!(await p.$('.composer-teaser')), '| défilement', y0, '→', await p.evaluate(() => Math.round(scrollY)));
  // Retour du navigateur (téléphone)
  await p.evaluate(() => { const c = document.querySelectorAll('.feed-card .feed-ride-circuit'); c[c.length - 1].click(); });
  await p.waitForTimeout(500);
  await p.goBack(); await p.waitForTimeout(700);
  console.log('retour (téléphone): fil', !!(await p.$('.composer-teaser')), '| défilement', await p.evaluate(() => Math.round(scrollY)));
  // Glisser depuis le bord gauche
  await p.evaluate(() => { const c = document.querySelectorAll('.feed-card .feed-ride-circuit'); c[0].click(); });
  await p.waitForTimeout(500);
  await p.evaluate(() => {
    const t = (x) => new Touch({ identifier: 1, target: document.body, clientX: x, clientY: 400 });
    document.dispatchEvent(new TouchEvent('touchstart', { touches: [t(10)], changedTouches: [t(10)] }));
    document.dispatchEvent(new TouchEvent('touchend', { touches: [], changedTouches: [t(160)] }));
  });
  await p.waitForTimeout(700);
  console.log('retour (glissé): fil', !!(await p.$('.composer-teaser')));
  console.log('errs', JSON.stringify(errs)); await b.close();
})();
