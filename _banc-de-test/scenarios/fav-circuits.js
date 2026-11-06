// Fiche › Circuits préférés : chaque nom sur une ligne lisible (pas une lettre par ligne).
const { chromium, BASE } = require('../lib');
(async () => { const b = await chromium.launch(); const errs = [];
  for (const w of [390, 1280]) {
    const p = await b.newPage({ viewport: { width: w, height: 900 } }); p.on('pageerror', e => errs.push(e.message));
    await p.goto(BASE + 'index.html#lang=' + (process.argv[2] || 'fr')); await p.waitForTimeout(1600);
    await p.evaluate(() => { const a = document.querySelector('[data-person-link="Alex"], [data-person="Alex"]'); if (a) a.click(); }); await p.waitForTimeout(700);
    await p.locator('[data-action="look-edit"]:visible').first().click({ timeout: 4000 }).catch(() => {}); await p.waitForTimeout(600);
    await p.locator('text=Circuits préférés').first().scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
    await p.waitForTimeout(500);
    for (const c of ['Mugello', 'Jerez', 'Le Mans']) { const i = await p.$('#fav-circ-input'); if (!i) break; await i.fill(c); await p.waitForTimeout(300); }
    const rows = await p.$$eval('.fav-circ-row strong', e => e.map(x => x.innerText + ' (' + Math.round(x.getBoundingClientRect().width) + 'x' + Math.round(x.getBoundingClientRect().height) + ')'));
    console.log(w + 'px:', rows.join(' | ') || 'éditeur introuvable');
    console.log(await p.evaluate(() => { const r = document.querySelector('.fav-circ-row'); if (!r) return ''; return 'row ' + Math.round(r.getBoundingClientRect().width) + ' display=' + getComputedStyle(r).display + ' | ' + [...r.children].map(c => c.tagName + '.' + c.className + ' w=' + Math.round(c.getBoundingClientRect().width) + ' flex=' + getComputedStyle(c).flex).join(' ; '); }));
    const r = await p.$('.fav-circ-row'); if (r) await (await r.$('xpath=..')).screenshot({ path: __dirname + '/../.sortie/fav-' + w + '.png' });
    await p.close();
  }
  console.log('errs', JSON.stringify(errs)); await b.close(); })();
