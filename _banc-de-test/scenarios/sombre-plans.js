// Mode sombre : plan du circuit (fond uni), mode dessin, carte d'incident agrandie.
const { chromium, BASE } = require('../lib');
(async () => { const b = await chromium.launch(); const errs = [];
  const p = await b.newPage({ viewport: { width: 1400, height: 900 }, colorScheme: 'dark' }); p.on('pageerror', e => errs.push(e.message));
  await p.goto(BASE + 'index.html#lang=' + (process.argv[2] || 'fr')); await p.waitForTimeout(1800);
  await p.evaluate(() => { location.hash = ''; }); await p.locator('.side-nav [data-view="carnet"], [data-view="carnet"]:visible').first().click().catch(() => {}); await p.waitForTimeout(400); await p.locator('.subnav-btn[data-view="circuit"]:visible').first().click(); await p.waitForTimeout(1500);
  await p.screenshot({ path: __dirname + '/../.sortie/sombre-plan.png' });
  const open = p.locator('.circuit-info-map-full, [data-action="open-annot"], .circuit-visual').first();
  console.log(await p.evaluate(() => { const i = document.querySelector('#root img[data-track-plan]'); let a = i, out = []; for (let k = 0; a && k < 6; k++, a = a.parentElement) { const c = getComputedStyle(a); out.push(a.tagName + '.' + String(a.className).split(' ').join('.') + ' bg=' + c.backgroundColor + ' pad=' + c.padding + ' border=' + c.borderWidth + ' ' + c.borderColor); } return out.join('\n'); }));
  console.log('plan:', await open.count());
  console.log('errs', JSON.stringify(errs)); await b.close(); })();
