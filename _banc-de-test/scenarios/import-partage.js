// Importer une publication d'un autre réseau (feuille de partage Android) :
// le service worker reçoit texte + lien + image sur /share-target, puis
// l'appli s'ouvre avec le formulaire de publication pré-rempli.
const { chromium, BASE } = require('../lib');
(async () => { const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 390, height: 900 } });
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto(BASE + 'index.html#lang=' + (process.argv[2] || 'fr')); await p.waitForTimeout(1600);
  const sw = await p.evaluate(() => navigator.serviceWorker ? Promise.race([navigator.serviceWorker.ready.then(r => !!r.active), new Promise(r => setTimeout(() => r(false), 3000))]).catch(() => false) : false);
  console.log('service worker actif:', sw);
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const res = await p.evaluate(async (png) => {
    const bin = Uint8Array.from(atob(png), c => c.charCodeAt(0));
    const fd = new FormData();
    fd.append('title', 'Sortie à Carole'); fd.append('text', 'Super journée sur le circuit ! https://facebook.com/share/p/abc'); fd.append('url', '');
    fd.append('media', new File([bin], 'photo.png', { type: 'image/png' }));
    const r = await Promise.race([fetch('share-target', { method: 'POST', body: fd, redirect: 'manual' }).catch(e => ({ type: 'err:' + e.message })), new Promise(res => setTimeout(() => res({ type: 'timeout' }), 4000))]);
    return r.type + ' ' + (r.status || '');
  }, png);
  console.log('envoi au service worker:', res);
  // Sans service worker dans le banc : on dépose ce qu'il aurait rangé.
  if (!sw) await p.evaluate(async (png) => {
    const bin = Uint8Array.from(atob(png), c => c.charCodeAt(0));
    const c = await caches.open('cdp-share-inbox');
    await c.put('./__share/data', new Response(JSON.stringify({ title: 'Sortie à Carole', text: 'Super journée sur le circuit ! https://facebook.com/share/p/abc', url: '' }), { headers: { 'Content-Type': 'application/json' } }));
    await c.put('./__share/media', new Response(new Blob([bin], { type: 'image/png' }), { headers: { 'Content-Type': 'image/png' } }));
  }, png);
  await p.goto(BASE + 'index.html?shared=1#lang=' + (process.argv[2] || 'fr')); await p.waitForTimeout(2200);
  console.log('formulaire ouvert:', !!(await p.$('#wall-post-form')), '| texte:', JSON.stringify(await p.$eval('#wall-post-text', e => e.value).catch(() => '')), '| lien:', await p.$eval('#wall-post-link', e => e.value).catch(() => ''), '| image:', !!(await p.$('.wall-post-photo-preview')));
  console.log('adresse nettoyée:', await p.evaluate(() => location.search === ''), '| boîte vidée:', await p.evaluate(() => caches.open('cdp-share-inbox').then(c => c.match('./__share/data')).then(r => !r)));
  await p.screenshot({ path: 'import-partage.png' });
  console.log('errs', JSON.stringify(errs)); await b.close(); })();
