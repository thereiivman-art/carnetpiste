// Social : amis à la suite des stories avec pastille (vert en ligne,
// orange < 2 h, gris sinon) et bandeau « Ajoute des amis » repliable.
const { chromium, BASE } = require('../lib');
(async () => { const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 390, height: 900 } });
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto(BASE + 'index.html#lang=' + (process.argv[2] || 'fr')); await p.waitForTimeout(1500);
  await p.evaluate(() => { const db = firebase.firestore(), n = Date.now(); return Promise.all([db.collection('users').doc('u3').update({ lastSeen: n - 60000 }), db.collection('users').doc('u4').update({ lastSeen: n - 3600000 }).catch(() => {}), db.collection('users').doc('u20').set({ uid: 'u20', name: 'Max', role: 'pilote', bike: 'R1' })]); });
  await p.waitForTimeout(500);
  console.log('amis après les stories:', await p.$$eval('.friend-bubble', e => e.map(x => x.querySelector('.story-name').innerText + ':' + x.querySelector('.presence-dot').className.replace('presence-dot ', '')).join(', ')));
  console.log('bandeau:', await p.$eval('.fsug-head', e => e.innerText.replace(/\n/g, ' ')).catch(() => 'absent'), '| cartes:', await p.$$eval('.fsug-card strong', e => e.map(x => x.innerText).join(', ')));
  console.log('demande de Luca en premier:', await p.$eval('.fsug-card', e => e.classList.contains('fsug-request') + ' ' + e.querySelector('strong').innerText));
  await p.screenshot({ path: 'amis-social.png' });
  await p.click('.fsug-card [data-fsug-add]'); await p.waitForTimeout(400);
  await p.click('.fsug-request [data-action="accept-friend"]'); await p.waitForTimeout(500);
  console.log('Luca accepté:', await p.evaluate(() => firebase.firestore().collection('friendRequests').doc('f2').get().then(d => d.data().status)));
  console.log('demande envoyée:', await p.evaluate(() => firebase.firestore().collection('friendRequests').get().then(s => s.docs.map(d => d.data()).filter(r => r.from === 'Alex' && r.status === 'pending').map(r => r.to).join(','))));
  await p.click('[data-action="fsug-toggle"]'); await p.waitForTimeout(300);
  console.log('replié:', !!(await p.$('.fsug.closed')), '| après rechargement:', await (async () => { await p.reload(); await p.waitForTimeout(1500); return !!(await p.$('.fsug.closed')); })());
  console.log('errs', JSON.stringify(errs)); await b.close(); })();
