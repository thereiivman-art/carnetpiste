// Échec d'envoi : le message reste affiché jusqu'à ce qu'on le ferme.
const { chromium, BASE } = require('../lib');
(async () => { const b = await chromium.launch(); const errs = [];
  const p = await b.newPage({ viewport: { width: 390, height: 900 } }); p.on('pageerror', e => errs.push(e.message));
  await p.goto(BASE + 'index.html#lang=' + (process.argv[2] || 'fr')); await p.waitForTimeout(1500);
  await p.evaluate(() => { const db = firebase.firestore(); const col = db.collection.bind(db);
    db.collection = (n) => { const c = col(n); if (n !== 'wallPosts') return c; const d0 = c.doc.bind(c); c.doc = (id) => { const d = d0(id); d.set = () => Promise.reject(new Error('réseau coupé')); return d; }; return c; };
    const bt = db.batch.bind(db); db.batch = () => { const x = bt(); x.commit = () => Promise.reject(new Error('réseau coupé')); return x; }; });
  await p.click('.bottom-nav-btn[data-nav-tab="communaute"]'); await p.waitForTimeout(400);
  await p.click('#wall-composer-toggle'); await p.waitForTimeout(300);
  await p.fill('#wall-post-text', 'Test échec');
  await p.click('#wall-post-form button[type="submit"]'); await p.waitForTimeout(800);
  await p.click('[data-mini-close]').catch(() => {});
  await p.waitForTimeout(7000);
  const t = await p.$('.toast.sticky');
  console.log('message encore là après 7 s:', !!t, t ? '| ' + (await t.innerText()).replace(/\n/g, ' ') : '');
  if (t) { await p.click('.toast.sticky .toast-close'); await p.waitForTimeout(200); console.log('fermé:', !(await p.$('.toast.sticky'))); }
  console.log('errs', JSON.stringify(errs)); await b.close(); })();
