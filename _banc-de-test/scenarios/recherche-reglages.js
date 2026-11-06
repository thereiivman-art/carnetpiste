// Recherche globale : « mode sombre », « aide », « audience » mènent au bon réglage.
const { chromium, BASE } = require('../lib');
(async () => { const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 390, height: 900 } });
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto(BASE + 'index.html#lang=' + (process.argv[2] || 'fr')); await p.waitForTimeout(1600);
  for (const [q, want] of [['mode sombre', 'affichage'], ['aide', 'aide'], ['audience', 'audience'], ['clair', 'affichage']]) {
    await p.locator('#search-toggle:visible').first().click();
    await p.waitForSelector('#gsearch-q', { timeout: 3000 });
    await p.fill('#gsearch-q', q); await p.waitForTimeout(300);
    const first = await p.$eval('#gsearch-results .gsearch-group', g => g.innerText.split('\n').slice(0, 2).join(' | ')).catch(() => '?');
    await p.click('#gsearch-results .gsearch-row'); await p.waitForTimeout(500);
    const title = await p.$eval('.settings-page-head .section-title', e => e.innerText).catch(() => '(pas de titre)');
    console.log(q, '->', first, '| page:', title);
  }
  console.log('errs', JSON.stringify(errs)); await b.close(); })();
