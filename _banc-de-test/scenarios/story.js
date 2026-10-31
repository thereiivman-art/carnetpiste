// Publier une story : rond « Ta story » (logo de l'appli + +), photo, mot,
// visible en tête du fil (pas dans le fil lui-même), visionneuse.
const { chromium, BASE } = require('../lib');
(async () => { const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 380, height: 800 } });
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto(BASE + 'index.html#lang=' + (process.argv[2] || 'fr')); await p.waitForTimeout(1600);
  await p.click('.bottom-nav-btn:nth-child(3)'); await p.waitForTimeout(400);
  await p.click('[data-pill-group="social"][data-pill="fil"]'); await p.waitForTimeout(300);
  console.log('rangée:', await p.$$eval('.story-bubble', e => e.map(x => x.innerText.replace(/\n/g, ' ')).join(' | ')));
  await (await p.$('.stories-row')).screenshot({ path: 'stories-row.png' });
  await p.setInputFiles('#story-input', require('path').join(__dirname, '../../icons/icon-512.png')); await p.waitForTimeout(1200);
  console.log('composer:', !!(await p.$('.story-compose')));
  await p.fill('.story-text-input', 'Prêt pour Barcelone !');
  await p.screenshot({ path: 'story-compose.png' });
  await p.click('.story-publish'); await p.waitForTimeout(500);
  console.log('stocké:', JSON.stringify(await p.evaluate(() => Object.values(window.__MOCK_DATA.wallPosts).filter(w => w.story).map(w => [w.author, w.text, w.photoURL.slice(0, 15)]))));
  console.log('rangée après:', await p.$$eval('.story-bubble', e => e.map(x => x.innerText.replace(/\n/g, ' ')).join(' | ')), '| dans le fil:', await p.$$eval('.feed-card .wall-post-text', e => e.filter(x => /Barcelone !/.test(x.innerText)).length));
  await p.click('.story-bubble[data-index="0"]'); await p.waitForTimeout(400);
  console.log('ma story:', await p.$eval('.story-overlay', e => e.innerText.replace(/\n/g, ' | ')));
  console.log('errs', JSON.stringify(errs)); await b.close(); })();
