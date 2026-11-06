// PC mode sombre : plan agrandi (Dessin et Repères) sans fond blanc.
const { chromium, BASE } = require('../lib');
(async () => { const b = await chromium.launch(); const errs = [];
  const p = await b.newPage({ viewport: { width: 1400, height: 900 }, colorScheme: 'dark' }); p.on('pageerror', e => errs.push(e.message));
  await p.goto(BASE + 'index.html#lang=' + (process.argv[2] || 'fr')); await p.waitForTimeout(1800);
  await p.locator('[data-view="carnet"]:visible').first().click().catch(() => {}); await p.waitForTimeout(300);
  await p.locator('.subnav-btn[data-view="circuit"]:visible').first().click(); await p.waitForTimeout(1200);
  const white = async (nom) => { await p.waitForTimeout(900); await p.screenshot({ path: __dirname + '/../.sortie/plan-pc-' + nom + '.png' });
    const r = await p.evaluate(() => { const ov = [...document.querySelectorAll('.annot-overlay.open, .track-notes-overlay, [class*="notes-overlay"], .tn-overlay')].filter(o => o.offsetParent || getComputedStyle(o).display !== 'none')[0]; if (!ov) return 'pas ouvert';
      return [...ov.querySelectorAll('*')].filter(e => { const c = getComputedStyle(e).backgroundColor; return /rgb\(255, 255, 255\)|rgb\(24[0-9], 24[0-9], 24[0-9]\)/.test(c) && e.offsetWidth > 100; }).map(e => e.tagName + '.' + String(e.className).split(' ').join('.')).slice(0, 5).join(', ') || 'aucun fond blanc'; });
    console.log(nom, ':', r); };
  await p.locator('button:has-text("Repères"):visible').first().click().catch(() => {}); await white('reperes');
  await p.keyboard.press('Escape'); await p.evaluate(() => document.querySelectorAll('.track-notes-overlay').forEach(o => o.remove()));
  await p.goto(BASE + 'index.html#lang=fr'); await p.waitForTimeout(1600);
  await p.locator('[data-view="carnet"]:visible').first().click().catch(() => {}); await p.waitForTimeout(300);
  await p.locator('.subnav-btn[data-view="circuit"]:visible').first().click(); await p.waitForTimeout(1200);
  await p.locator('button:has-text("Dessin"):visible').first().click().catch(() => {}); await white('dessin');
  await p.locator('.map-mode-switch button').nth(1).click().catch(() => {}); await white('reperes-switch');
  console.log('errs', JSON.stringify(errs)); await b.close(); })();
