// Captures de l'appli de démo pour le guide (appelé par faire-guide.js).
const path = require('path');
const { chromium } = require('../lib');

async function captures(base, dir, lang) {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 390, height: 760 }, deviceScaleFactor: 2 });
  const p = await ctx.newPage();
  const out = {};
  // L'appli rouvre le dernier onglet : on revient toujours sur Carnet › Chronos.
  async function go(hash) {
    await p.goto('about:blank'); await p.goto(base + 'index.html#lang=' + lang + (hash || '')); await p.waitForTimeout(1600);
    await p.click('.bottom-nav-btn[data-view^="carnet"], .bottom-nav-btn:nth-child(1)'); await p.waitForTimeout(400);
    const sub = await p.$('.subnav-btn[data-view="carnet"]'); if (sub) { await sub.click(); await p.waitForTimeout(400); }
  }
  async function shot(name, sel, offset) {
    if (sel) await p.evaluate(([s, o]) => { const e = document.querySelector(s); if (e) window.scrollTo(0, e.getBoundingClientRect().top + window.scrollY - (o || 0)); }, [sel, offset || 0]);
    await p.evaluate(() => document.querySelectorAll('.toast').forEach(t => t.remove()));
    await p.waitForTimeout(250);
    const f = path.join(dir, lang + '-' + name + '.png');
    await p.screenshot({ path: f });
    out[name] = f;
  }
  // Ma journée, session par session (roulage passé)
  await go();
  await p.getByText('Mugello').first().click(); await p.waitForTimeout(900);
  await shot('journee', '.day-prog-chart', 150);
  // Prochain roulage
  await go();
  await p.click('.bottom-nav-btn:nth-child(2)'); await p.waitForTimeout(800);
  await shot('prochain');
  // Podium entre potes (Carnet › Stats › Podium)
  await go();
  await p.click('.subnav-btn[data-view="stats"]'); await p.waitForTimeout(500);
  await p.click('[data-pill-group="stats"][data-pill="podium"]'); await p.waitForTimeout(600);
  await shot('potes', '.podium-head', 140);
  // Trophées
  await go();
  await p.click('.subnav-btn[data-view="stats"]'); await p.waitForTimeout(500);
  await p.click('[data-pill-group="stats"][data-pill="trophees"]'); await p.waitForTimeout(500);
  await shot('records');
  await p.click('[data-pill-group="stats"][data-pill="records"]'); await p.waitForTimeout(300);
  // Mes pressions (deux relevés notés par le pilote)
  await p.click('.bottom-nav-btn:nth-child(2)'); await p.waitForTimeout(500); await p.click('[data-cpill-group="planning"][data-cpill="prepa"]'); await p.waitForTimeout(300); await p.click('[data-cpill-group="prepsub"][data-cpill="moto"]'); await p.waitForTimeout(300);
  for (const [c, fc, rc, cond] of [['Barcelone', '2,1', '1,8', lang === 'fr' ? 'Soleil' : 'Sunny'], ['Mugello', '2,2', '1,9', lang === 'fr' ? 'Couvert' : 'Overcast']]) {
    await p.click('[data-action="pressure-new"]'); await p.waitForTimeout(300);
    await p.fill('#pr-circuit', c); await p.fill('#pr-fc', fc); await p.fill('#pr-rc', rc); await p.fill('#pr-cond', cond);
    await p.click('.pressure-sheet [data-p="save"]'); await p.waitForTimeout(600);
  }
  await p.waitForTimeout(2500); // laisse partir les toasts
  await shot('pressions');
  // Budget : calendrier d'un Team importé, quelques roulages gardés
  await go('&admin=1');
  await p.click('#settings-toggle'); await p.waitForTimeout(300);
  await p.getByText(lang === 'fr' ? 'Aide' : 'Help', { exact: true }).first().click(); await p.waitForTimeout(300);
  await p.click('[data-pill-group="aide"][data-pill="admin"]'); await p.waitForTimeout(500);
  await p.click('[data-action="evimp-check"]'); await p.waitForTimeout(300);
  await p.click('[data-action="evimp-go"]'); await p.waitForTimeout(800);
  await p.click('.bottom-nav-btn[data-view^="carnet"]'); await p.waitForTimeout(500);
  await p.click('.subnav-btn[data-view="budget"]'); await p.waitForTimeout(500);
  await p.click('[data-budget-season="2027"]'); await p.waitForTimeout(400);
  await p.click('[data-pill-group="budget"][data-pill="others"]'); await p.waitForTimeout(300);
  const ids = await p.$$eval('.budget-row', rs => rs.map(r => [r.getAttribute('data-row'), r.querySelector('strong').textContent]));
  for (const n of ['Portim', 'Jerez', 'Mugello', 'Le Mans', 'Carole']) { const r = ids.find(x => new RegExp(n).test(x[1])); if (r) await p.click('#bud-' + r[0] + '-on'); }
  await p.click('[data-pill-group="budget"][data-pill="mine"]'); await p.waitForTimeout(300);
  const port = ids.find(x => /Portim/.test(x[1]))[0];
  await p.click('[data-row="' + port + '"] summary');
  await p.fill('#bud-' + port + '-travel', '320'); await p.fill('#bud-' + port + '-hotel', '400'); await p.fill('#bud-' + port + '-tyres', '450');
  await p.waitForTimeout(1200);
  await p.evaluate(() => document.activeElement && document.activeElement.blur());
  await p.click('[data-budget-season="2027"]'); await p.waitForTimeout(600);
  await shot('budget', '.budget-seasons', 80);
  await b.close();
  return out;
}
module.exports = { captures };
