// Sous les onglets fixés : la suite (pastilles, cartes) commence sous le
// masque, rien n'est rogné, dans chaque onglet parent.
const { chromium, BASE } = require('../lib');
(async () => { const b = await chromium.launch(); const errs = [];
  const p = await b.newPage({ viewport: { width: 390, height: 900 }, colorScheme: 'dark' }); p.on('pageerror', e => errs.push(e.message));
  await p.goto(BASE + 'index.html#lang=' + (process.argv[2] || 'fr')); await p.waitForTimeout(1600);
  const check = async (nom) => { await p.waitForTimeout(400); await p.evaluate(() => window.scrollTo(0, 0)); await p.waitForTimeout(150);
    const r = await p.evaluate(() => { const n = document.querySelector('.subnav.main-subnav'); if (!n || !n.offsetParent) return 'pas de barre';
      const pt = n.nextElementSibling && n.nextElementSibling.classList.contains('pill-tabs') ? n.nextElementSibling : null;
      const bar = pt || n, gap = 8, maskBottom = bar.getBoundingClientRect().bottom + gap;
      let e = bar.nextElementSibling; while (e && !e.offsetHeight) e = e.nextElementSibling;
      if (!e) return 'rien après';
      const t = e.getBoundingClientRect().top; return (t >= maskBottom - 0.5 ? 'OK' : 'ROGNÉ de ' + Math.round(maskBottom - t) + ' px') + ' (' + e.className.split(' ')[0] + ')'; });
    console.log(nom.padEnd(22), r); };
  await p.click('.bottom-nav-btn:nth-child(1)'); await check('Carnet');
  for (const sel of ['[data-cards-mode="avenir"]', '[data-view="event"]', '[data-cards-mode="passees"]']) { await p.locator(sel + ':visible').first().click().catch(() => {}); await check('Roulages ' + sel.replace(/[^a-zé]+/g, ' ').trim()); }
  for (const v of ['circuit', 'stats', 'moi']) { const l = p.locator('.subnav-btn[data-view="' + v + '"]:visible'); if (await l.count()) { await l.first().click(); await check('Carnet › ' + v); } }
  await p.click('.bottom-nav-btn[data-nav-tab="communaute"]'); await check('Communauté');
  for (const v of ['social', 'dmbox', 'teams']) { const l = p.locator('.subnav-btn[data-view="' + v + '"]:visible'); if (await l.count()) { await l.first().click(); await check('Communauté › ' + v); } }
  console.log('errs', JSON.stringify(errs)); await b.close(); })();
