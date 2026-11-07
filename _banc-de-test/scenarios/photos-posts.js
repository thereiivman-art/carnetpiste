// Photos des publications rangées à part (postMedia) : la publication ne
// garde qu'une référence, la photo s'affiche quand même ; mes anciennes
// publications avec la photo dedans migrent toutes seules.
const { chromium, BASE } = require('../lib');
(async () => { const b = await chromium.launch(); const lang = process.argv[2] || 'fr'; const errs = [];
  const p = await b.newPage({ viewport: { width: 390, height: 900 } }); p.on('pageerror', e => errs.push(e.message));
  await p.goto(BASE + 'index.html#lang=' + lang); await p.waitForTimeout(1500);
  // Ancienne publication d'Alex avec une photo lourde dedans
  const uid = await p.evaluate(() => firebase.auth().currentUser.uid);
  await p.evaluate((u) => { const c = document.createElement('canvas'); c.width = 600; c.height = 400; const x = c.getContext('2d'); const d = x.createImageData(600, 400); for (let i = 0; i < d.data.length; i++) d.data[i] = (i * 2654435761 >>> 24) & 255; x.putImageData(d, 0, 0);
    return firebase.firestore().collection('wallPosts').doc('oldp').set({ id: 'oldp', author: 'Alex', authorUid: u, audience: 'all', text: 'Vieille photo', photoURL: c.toDataURL('image/jpeg', 0.9), createdAt: Date.now() - 3600e3 }); }, uid);
  await p.waitForTimeout(8000);
  const mig = await p.evaluate(() => Promise.all([firebase.firestore().collection('wallPosts').doc('oldp').get(), firebase.firestore().collection('postMedia').doc('oldp').get()]).then(([w, m]) => ({ photoDansPost: !!w.data().photoURL, ref: w.data().photoMedia, media: m.exists ? m.data().data.length : 0 })));
  console.log('migration:', JSON.stringify(mig));
  // Nouvelle publication avec photo
  await p.click('.bottom-nav-btn[data-nav-tab="communaute"]'); await p.waitForTimeout(400);
  await p.click('#wall-composer-toggle'); await p.waitForTimeout(300);
  await p.fill('#wall-post-text', 'Photo du jour');
  const img = await p.evaluate(() => { const c = document.createElement('canvas'); c.width = 900; c.height = 600; const x = c.getContext('2d'); const d = x.createImageData(900, 600); for (let i = 0; i < d.data.length; i++) d.data[i] = (i * 40503 >>> 8) & 255; x.putImageData(d, 0, 0); return c.toDataURL('image/png').split(',')[1]; });
  const [fc] = await Promise.all([p.waitForEvent('filechooser'), p.click('#wall-post-photo-btn')]);
  await fc.setFiles({ name: 'p.png', mimeType: 'image/png', buffer: Buffer.from(img, 'base64') }); await p.waitForTimeout(800);
  await p.click('#wall-post-form button[type="submit"]'); await p.waitForTimeout(900);
  await p.click('[data-mini-close]').catch(() => {}); await p.waitForTimeout(300);
  const nw = await p.evaluate(() => firebase.firestore().collection('wallPosts').get().then(s => s.docs.map(d => d.data()).filter(x => x.text === 'Photo du jour').map(x => ({ photoDansPost: !!x.photoURL, ref: !!x.photoMedia }))));
  console.log('nouvelle publication:', JSON.stringify(nw));
  await p.waitForTimeout(1500);
  console.log('photos affichées (depuis postMedia):', await p.$$eval('.wall-post-photo', e => e.filter(x => (x.getAttribute('src') || '').startsWith('data:image')).length));
  console.log('errs', JSON.stringify(errs)); await b.close(); })();
