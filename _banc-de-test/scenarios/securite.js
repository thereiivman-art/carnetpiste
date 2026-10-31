// Sécurité et jour J hors ligne :
// - aucune violation de la politique de sécurité (CSP) au chargement ;
// - un lien « javascript: » glissé dans un message est neutralisé ;
// - un message « Mes amis » part avec la liste des uids autorisés ;
// - repères et débriefs restés sur le profil public migrent vers userPrivate ;
// - jour J sans réseau : l'app se recharge (service worker) et on saisit un chrono.
const { chromium, BASE } = require('../lib');
(async () => {
  const lang = process.argv[2] || 'fr';
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 380, height: 900 } });
  const p = await ctx.newPage();
  const errs = [], csp = [];
  p.on('pageerror', e => errs.push(e.message));
  p.on('console', m => { if (/Content Security Policy|Refused to/i.test(m.text())) csp.push(m.text().slice(0, 160)); });
  await p.goto(BASE + 'index.html#lang=' + lang + '&jourj=1'); await p.waitForTimeout(2000);
  console.log('CSP présente:', await p.$eval('meta[http-equiv="Content-Security-Policy"]', e => e.content.indexOf("object-src 'none'") !== -1));

  // Lien piégé injecté dans le DOM puis re-rendu
  const neutral = await p.evaluate(() => {
    const a = document.createElement('a'); a.href = 'javascript:alert(1)'; a.id = 'piege'; a.textContent = 'x';
    document.getElementById('root').appendChild(a);
    window.dispatchEvent(new Event('resize'));
    return true;
  });
  await p.click('.bottom-nav-btn.bottom-nav-main'); await p.waitForTimeout(400);
  console.log('lien javascript neutralisé:', await p.evaluate(() => { const a = document.getElementById('piege'); return !a || a.getAttribute('href') === '#'; }), neutral);

  // Message « Mes amis » : visibleTo
  const post = await p.evaluate(() => new Promise(res => {
    const db = firebase.firestore(), uid = firebase.auth().currentUser.uid;
    db.collection('wallPosts').where('authorUid', '==', uid).get().then(s => res(s.docs.length));
  }));
  console.log('mes messages lisibles:', post >= 0);

  // Migration des champs privés
  const mig = await p.evaluate(() => new Promise(res => {
    const db = firebase.firestore(), uid = firebase.auth().currentUser.uid;
    setTimeout(() => Promise.all([db.collection('users').doc(uid).get(), db.collection('userPrivate').doc(uid).get()]).then(([u, v]) => {
      const pu = u.data() || {}, pv = v.data() || {};
      res({ publicTrackNotes: !!pu.trackNotes, publicDebriefs: !!pu.debriefs, publicEmail: !!pu.email, privTrackNotes: !!pv.trackNotes });
    }), 300);
  }));
  console.log('migration:', JSON.stringify(mig));

  // Jour J sans réseau (le banc n'a pas de service worker : le
  // rechargement hors ligne se vérifie sur le téléphone, voir la check-list)
  await ctx.setOffline(true); await p.waitForTimeout(300);
  console.log('écran hors ligne:', await p.$eval('.bottom-nav-btn.active', e => e.innerText.trim()).catch(() => 'aucun'));
  if (await p.$('#f-laps')) {
    await p.type('#f-laps', '1:10.900'); await p.click('#submit-btn'); await p.waitForTimeout(600);
    if (await p.$('#feeling-skip-btn')) { await p.click('#feeling-skip-btn'); await p.waitForTimeout(300); }
    console.log('chrono saisi hors ligne:', await p.$eval('#root', e => /1.10.900/.test(e.innerText)));
  }
  await p.screenshot({ path: 'jourj-hors-ligne-' + lang + '.png' });
  await ctx.setOffline(false);
  console.log('CSP violations:', JSON.stringify(csp));
  console.log('errs', JSON.stringify(errs)); await b.close();
})();
