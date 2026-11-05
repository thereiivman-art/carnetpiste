// Idées des amis :
// - fiche d'un pilote : Fil d'abord, puis Fiche, Bientôt en piste, Saisons ;
// - coche de vérification / C+ : un appui ouvre l'espace Carnet+ ;
// - images de profil prêtes, bouton « Bannière », présentation 250 car. ;
// - logos des réseaux sociaux ;
// - fiche privée (amis) et abonnés/abonnements masqués ;
// - Découvrir : teams PRO seulement ;
// - couleur de fiche piégée neutralisée.
const { chromium, BASE } = require('../lib');
(async () => {
  const lang = process.argv[2] || 'fr';
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 390, height: 900 } });
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto(BASE + 'index.html#lang=' + lang); await p.waitForTimeout(1600);
  const openPerson = async (n) => {
    await p.evaluate((n) => { const s = document.createElement('span'); s.className = 'mini-avatar'; s.setAttribute('data-person', n); s.id = 'tmp-person'; document.getElementById('root').appendChild(s); }, n);
    await p.click('#tmp-person'); await p.waitForTimeout(600);
  };
  await p.evaluate(() => Promise.all([firebase.firestore().collection('teams').doc('t2').update({ visibility: 'all' }), firebase.firestore().collection('teams').doc('t3').set({ id: 't3', name: 'Les Copains', visibility: 'all' })]));
  await p.evaluate(() => firebase.firestore().collection('users').doc('u2').update({ certified: true, look: { color: '#c8261f;background:url(https://evil.example/t.png)', cover: 'vibreur', bio: 'Pistard', links: [{ url: 'https://instagram.com/sam' }, { url: 'https://youtube.com/@sam' }] } }));
  await p.waitForTimeout(400);
  await openPerson('Sam');
  console.log('onglets fiche Sam:', await p.$$eval('[data-pill-group="person"]', e => e.map(x => x.innerText + (x.classList.contains('active') ? '✓' : '')).join(' / ')));
  console.log('couleur piégée:', await p.$eval('.person-hero', e => e.getAttribute('style')).catch(() => 'pas de bannière'));
  await p.click('[data-pill-group="person"][data-pill="fiche"]'); await p.waitForTimeout(400);
  console.log('logos:', await p.$$eval('.ph-link .brand-logo', e => e.map(x => x.className.replace('brand-logo ', '')).join(', ')));
  await p.click('.certified-badge'); await p.waitForTimeout(500);
  console.log('coche → espace:', await p.$eval('[data-profile-tab].active', e => e.innerText).catch(() => '?'), '|', !!(await p.$('.cp-status')));
  // Fiche privée de Luca (pas ami)
  await p.evaluate(() => firebase.firestore().collection('users').doc('u9').update({ profileVisibility: 'friends', listsVisibility: 'private' }));
  await p.waitForTimeout(400);
  await p.goto(BASE + 'index.html#lang=' + lang); await p.waitForTimeout(1500);
  await p.evaluate(() => firebase.firestore().collection('users').doc('u9').update({ profileVisibility: 'friends', listsVisibility: 'private' }));
  await p.waitForTimeout(400);
  await openPerson('Luca');
  console.log('fiche Luca:', await p.$eval('.person-page', e => (e.innerText.match(/Fiche privée[^\n]*|Private profile[^\n]*/) || ['visible'])[0]), '| compteurs abonnés:', await p.$$eval('.social-counts .social-count', e => e.length));
  // Mon profil : bannière, images prêtes, présentation
  await p.click('.bottom-nav-btn:nth-child(3)'); await p.waitForTimeout(400);
  await p.click('#profile-toggle'); await p.waitForTimeout(400);
  console.log('mon profil, onglets:', await p.$$eval('[data-pill-group="person"]', e => e.map(x => x.innerText + (x.classList.contains('active') ? '✓' : '')).join(' / ')), '| bouton Bannière:', !!(await p.$('[data-action="pick-cover"]')), '| trophées près du nom:', await p.$$eval('.mini-vitrine .trophy-ico', e => e.length), '| carte Vitrine:', await p.$$eval('.ph-vitrine', e => e.length));
  await p.click('.mini-vitrine').catch(() => {}); await p.waitForTimeout(700);
  console.log('appui → trophées:', await p.$eval('[data-pill-group="person"].active', e => e.innerText).catch(() => '?'), '|', await p.evaluate(() => { const c = document.querySelector('.achievements-card'); if (!c) return 'absente'; const r = c.getBoundingClientRect(); return (r.top < innerHeight && r.bottom > 0 ? 'à l\'écran' : 'hors écran') + (c.querySelector('details[open], .open') ? ', ouverte' : ''); }));
  await p.click('[data-action="look-edit"]'); await p.waitForTimeout(400);
  console.log('présentation:', await p.$eval('#look-bio', e => e.maxLength), '|', await p.$eval('#look-bio-count', e => e.innerText));
  // Images prêtes : dans l'éditeur de fiche (Social).
  console.log('images prêtes:', await p.$$eval('.avatar-preset', e => e.length));
  await p.click('.avatar-preset >> nth=1'); await p.waitForTimeout(500);
  console.log('photo enregistrée:', await p.evaluate(() => firebase.firestore().collection('users').doc(firebase.auth().currentUser.uid).get().then(d => (d.data().photoURL || '').slice(0, 26))));
  // Réglages › Confidentialité
  await p.click('#settings-toggle'); await p.waitForTimeout(400);
  await p.click('[data-settings-go="confidentialite"]').catch(() => {}); await p.waitForTimeout(300);
  await p.selectOption('#profile-visibility', 'friends').catch(e => console.log('pas de choix fiche'));
  await p.selectOption('#lists-visibility', 'private').catch(e => console.log('pas de choix listes'));
  await p.waitForTimeout(400);
  console.log('confidentialité:', await p.evaluate(() => firebase.firestore().collection('users').doc(firebase.auth().currentUser.uid).get().then(d => d.data().profileVisibility + ' / ' + d.data().listsVisibility)));
  // Découvrir des teams : PRO seulement
  await p.click('.bottom-nav-btn:nth-child(3)'); await p.waitForTimeout(300);
  await p.click('.subnav-btn[data-view="team"]').catch(() => {}); await p.waitForTimeout(400);
  await p.click('[data-pill-group="teams"][data-pill="discover"]').catch(() => {}); await p.waitForTimeout(400);
  console.log('teams à découvrir:', await p.evaluate(() => { const g = document.querySelectorAll('.team-tile-grid > *'); return g.length ? [...g].map(x => x.innerText.split('\n')[0]).join(', ') : ((document.querySelector('#root .empty-state') || {}).innerText || '?'); }));
  await p.screenshot({ path: 'idees-amis-' + lang + '.png' });
  console.log('errs', JSON.stringify(errs)); await b.close();
})();
