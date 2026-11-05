// Social : amis à la suite des stories avec pastille (vert en ligne,
// orange < 2 h, gris sinon) et bandeau « Qui suivre » repliable (plus de demande d'ami : on suit).
const { chromium, BASE } = require('../lib');
(async () => { const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 390, height: 900 } });
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto(BASE + 'index.html#lang=' + (process.argv[2] || 'fr')); await p.waitForTimeout(1500);
  await p.evaluate(() => { const db = firebase.firestore(), n = Date.now(); return Promise.all([db.collection('users').doc('u3').update({ lastSeen: n - 60000 }), db.collection('users').doc('u4').update({ lastSeen: n - 3600000 }).catch(() => {}), db.collection('users').doc('u20').set({ uid: 'u20', name: 'Max', role: 'pilote', bike: 'R1' })]); });
  await p.waitForTimeout(500);
  console.log('amis après les stories:', await p.$$eval('.friend-bubble', e => e.map(x => x.querySelector('.story-name').innerText + ':' + x.querySelector('.presence-dot').className.replace('presence-dot ', '')).join(', ')));
  console.log('bandeau:', await p.$eval('.fsug-head', e => e.innerText.replace(/\n/g, ' ')).catch(() => 'absent'), '| cartes:', await p.$$eval('.fsug-card strong', e => e.map(x => x.innerText).join(', ')));
  await p.screenshot({ path: 'amis-social.png' });
  await p.click('.fsug-card [data-action="quick-follow"]'); await p.waitForTimeout(500);
  console.log('suivi depuis le bandeau:', await p.evaluate(() => firebase.firestore().collection('follows').get().then(s => s.docs.map(d => d.data()).filter(f => f.follower === 'Alex' && f.followee === 'Max').length)));
  console.log('plus de demande d\'ami:', !(await p.$('[data-action="accept-friend"], [data-action="quick-add-friend"]')));
  await p.click('[data-action="fsug-close"]'); await p.waitForTimeout(300);
  console.log('choix:', await p.$$eval('[data-fsug-hide-mode]', e => e.map(x => x.innerText).join(' / ')));
  await p.click('[data-fsug-hide-mode="later"]'); await p.waitForTimeout(300);
  console.log('masqué:', !(await p.$('.fsug')));
  console.log('errs', JSON.stringify(errs)); await b.close(); })();
