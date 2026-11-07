// Croix « Masquer » : ne recouvre rien et ne déforme pas les miniatures.
const { chromium, BASE } = require('../lib');
(async () => { const b = await chromium.launch(); const errs = [];
  for (const w of [390, 1280]) {
  const p = await b.newPage({ viewport: { width: w, height: 900 } }); p.on('pageerror', e => errs.push(e.message));
  await p.goto(BASE + 'index.html#lang=' + (process.argv[2] || 'fr')); await p.waitForTimeout(1600);
  await p.locator('.bottom-nav-btn[data-nav-tab="communaute"], .side-nav [data-view="social"]').first().click().catch(() => {}); await p.waitForTimeout(600);
  for (let i = 0; i < 4; i++) { await p.mouse.wheel(0, 3000); await p.waitForTimeout(400); }
  const r = await p.evaluate(() => [...document.querySelectorAll('.card.can-hide')].map(c => {
    const x = c.querySelector(':scope > .feed-hide').getBoundingClientRect();
    const hit = [...c.querySelectorAll('*')].filter(e => !e.closest('.feed-hide') && (e.tagName === 'svg' || (e.children.length === 0 && (e.innerText || e.tagName === 'IMG')))).filter(e => { const r = e.getBoundingClientRect(); return r.width && r.left < x.right && r.right > x.left && r.top < x.bottom && r.bottom > x.top; }).map(e => e.tagName + '.' + e.className);
    const th = c.querySelector('.outing-thumb img'); const tb = th && th.getBoundingClientRect(), pb = th && th.parentNode.getBoundingClientRect();
    return (c.className.replace('card ', '')) + ' | sous la croix: ' + (hit.join(',') || 'rien') + (th ? ' | miniature ' + Math.round(tb.width) + '/' + Math.round(pb.width) : '');
  }));
  console.log(w + 'px'); r.forEach(x => console.log('  ' + x));
  await p.close(); }
  console.log('errs', JSON.stringify(errs)); await b.close(); })();
