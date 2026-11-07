// Story : Publier atteignable avec un petit écran (clavier ouvert),
// circuit épinglé avec !Jerez (suggestions), recadrage photo 9:16.
const { chromium, BASE } = require('../lib');
(async () => { const b = await chromium.launch(); const errs = [];
  const p = await b.newPage({ viewport: { width: 390, height: 480 } }); p.on('pageerror', e => errs.push(e.message));
  await p.goto(BASE + 'index.html#lang=' + (process.argv[2] || 'fr')); await p.waitForTimeout(1600);
  await p.click('.bottom-nav-btn[data-nav-tab="communaute"]'); await p.waitForTimeout(400);
  const img = await p.evaluate(() => { const c = document.createElement('canvas'); c.width = 1200; c.height = 800; const x = c.getContext('2d'); x.fillStyle = '#2a6'; x.fillRect(0, 0, 1200, 800); x.fillStyle = '#c22'; x.fillRect(500, 300, 200, 200); return c.toDataURL('image/png').split(',')[1]; });
  await p.setInputFiles('#story-input', { name: 'p.png', mimeType: 'image/png', buffer: Buffer.from(img, 'base64') }); await p.waitForTimeout(1200);
  await p.click('.story-text-input'); await p.keyboard.type('Top !Jer'); await p.waitForTimeout(300);
  console.log('suggestions:', await p.$$eval('.story-compose .mention-circuit', e => e.map(x => x.innerText.replace(/\n/g, ' ')).join(' | ')));
  await p.click('.story-compose .mention-circuit'); await p.waitForTimeout(200);
  console.log('texte:', await p.$eval('.story-text-input', e => e.value));
  await p.click('.story-crop-btn'); await p.waitForTimeout(300);
  const box = await p.$eval('.story-compose-media', e => { const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: Math.round(r.width), h: Math.round(r.height) }; });
  console.log('cadre 9:16:', box.w + '×' + box.h);
  await p.mouse.move(box.x, box.y); await p.mouse.down(); await p.mouse.move(box.x + 60, box.y, { steps: 5 }); await p.mouse.up();
  // Publier : visible en faisant défiler la fenêtre (écran de 480 px de haut)
  const pub = await p.$('.story-publish'); await pub.scrollIntoViewIfNeeded();
  const r = await pub.boundingBox(); console.log('Publier dans l\'écran:', r.y >= 0 && r.y + r.height <= 480);
  await pub.click(); await p.waitForTimeout(800);
  const post = await p.evaluate(() => Object.values(window.__MOCK_DATA.wallPosts).filter(w => w.story && /Top/.test(w.text || '')).map(w => ({ place: w.place, size: w.photoURL.length, jpeg: w.photoURL.indexOf('image/jpeg') > 0 }))[0]);
  console.log('story:', JSON.stringify(post));
  const dims = await p.evaluate(() => new Promise(res => { const w = Object.values(window.__MOCK_DATA.wallPosts).filter(w => w.story && /Top/.test(w.text || ''))[0]; const i = new Image(); i.onload = () => res(i.naturalWidth + '×' + i.naturalHeight); i.src = w.photoURL; }));
  console.log('photo cuite:', dims);
  await p.setViewportSize({ width: 390, height: 844 }); await p.waitForTimeout(300);
  await p.evaluate(() => window.scrollTo(0, 0));
  await p.locator('.story-me-btn, [data-action="open-story"]').first().click(); await p.waitForTimeout(800);
  console.log('viewer:', await p.$eval('.story-overlay', o => ({ pin: !!o.querySelector('.story-place'), lien: !!o.querySelector('.story-caption .circuit-tag') })).then(JSON.stringify).catch(() => 'pas ouvert'));
  await p.screenshot({ path: __dirname + '/../.sortie/story-pin.png' });
  const pin = await p.$('.story-place');
  if (pin) { await pin.click(); await p.waitForTimeout(500); console.log('ouvre le circuit:', await p.evaluate(() => !document.querySelector('.story-overlay')) , await p.$eval('#root', r => /Jerez/.test(r.innerText))); }
  console.log('errs', JSON.stringify(errs)); await b.close(); })();
