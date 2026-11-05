// Stories vidéo (Pitbook+) : 10 s max, recompressées, rangées dans storyMedia ;
// lecture à l'ouverture et « J'aime » sur la story d'un ami.
const { chromium, BASE } = require('../lib');
(async () => {
  const lang = process.argv[2] || 'fr';
  const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] }); const p = await b.newPage({ viewport: { width: 390, height: 800 } });
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto(BASE + 'index.html#lang=' + lang + ''); await p.waitForTimeout(1600);
  console.log('sans Pitbook+, accept:', await p.$eval('#story-input', e => e.accept));
  await p.goto(BASE + 'index.html#lang=' + lang + '&admin=1'); await p.reload(); await p.waitForTimeout(1600);
  console.log('avec Pitbook+, accept:', await p.$eval('#story-input', e => e.accept));
  // Vidéo de 14 s générée dans la page (1280x720)
  await p.evaluate(() => new Promise(res => {
    const c = document.createElement('canvas'); c.width = 1280; c.height = 720; const x = c.getContext('2d');
    const st = c.captureStream(30), r = new MediaRecorder(st, { mimeType: 'video/webm' }), ch = [];
    r.ondataavailable = e => ch.push(e.data); let t0 = performance.now();
    r.onstop = () => { const f = new File(ch, 'clip.webm', { type: 'video/webm' }); const dt = new DataTransfer(); dt.items.add(f); const inp = document.getElementById('story-input'); inp.files = dt.files; inp.dispatchEvent(new Event('change')); res(); };
    r.start(); (function loop() { const t = (performance.now() - t0) / 1000; x.fillStyle = 'hsl(' + (t * 40) + ',70%,45%)'; x.fillRect(0, 0, 1280, 720); x.fillStyle = '#fff'; x.font = 'bold 140px sans-serif'; x.fillText(t.toFixed(1) + ' s', 400, 400); if (t < 14) requestAnimationFrame(loop); else r.stop(); })();
  }));
  await p.waitForTimeout(1500);
  console.log('préparation:', await p.$eval('#story-prep', e => e.innerText).catch(() => 'absente'));
  await p.waitForSelector('.story-publish', { timeout: 30000 });
  console.log('aperçu vidéo:', !!(await p.$('.story-compose video')));
  await p.click('.story-publish'); await p.waitForTimeout(1500);
  const r = await p.evaluate(() => Promise.all([firebase.firestore().collection('storyMedia').get(), firebase.firestore().collection('wallPosts').get()]).then(([m, w]) => { const md = m.docs.map(d => d.data())[0]; const post = w.docs.map(d => d.data()).filter(x => x.video)[0]; return md ? { taille: md.video.length, mime: md.mime, post: !!post, duree: post && post.duration, miniature: post && post.photoURL.slice(0, 15) } : 'aucune'; }));
  console.log('enregistré:', JSON.stringify(r));
  // Story vidéo d'un ami : lecture et J'aime
  await p.evaluate(() => new Promise(res => {
    const c = document.createElement('canvas'); c.width = 320; c.height = 180; const x = c.getContext('2d');
    const r = new MediaRecorder(c.captureStream(20), { mimeType: 'video/webm' }), ch = []; let t0 = performance.now();
    r.ondataavailable = e => ch.push(e.data);
    r.onstop = () => { const fr = new FileReader(); fr.onload = () => { const db = firebase.firestore(); const now = Date.now();
      Promise.all([db.collection('storyMedia').doc('vs1').set({ authorUid: 'u2', postId: 'vs1', video: fr.result, mime: 'video/webm', createdAt: now }),
        db.collection('wallPosts').doc('vs1').set({ id: 'vs1', author: 'Sam', authorUid: 'u2', audience: 'all', story: true, video: true, mediaId: 'vs1', photoURL: c.toDataURL('image/jpeg'), createdAt: now, text: 'Premier tour' })]).then(res); }; fr.readAsDataURL(new Blob(ch, { type: 'video/webm' })); };
    r.start(); (function loop() { const t = (performance.now() - t0) / 1000; x.fillStyle = 'hsl(' + (t * 90) + ',70%,45%)'; x.fillRect(0, 0, 320, 180); if (t < 2) requestAnimationFrame(loop); else r.stop(); })();
  }));
  await p.waitForTimeout(800);
  const idx = await p.$$eval('.story-bubble[data-action="open-story"] .story-name', e => e.map(x => x.innerText).indexOf('Sam'));
  console.log('bulle Sam:', idx);
  await p.click('.story-bubble[data-action="open-story"] >> nth=' + idx); await p.waitForTimeout(1200);
  console.log('vidéo lue:', await p.$eval('.story-overlay video', v => !v.paused || v.ended).catch(() => 'pas de vidéo'), '| bouton J\'aime:', !!(await p.$('.story-like')));
  await p.click('.story-like'); await p.waitForTimeout(500);
  console.log('aimé:', await p.$eval('.story-like', e => e.classList.contains('on')), '| sur le message:', await p.evaluate(() => firebase.firestore().collection('wallPosts').doc('vs1').get().then(d => JSON.stringify(d.data().reactions || {}))), '| vue comptée:', await p.evaluate(() => firebase.firestore().collection('postViews').get().then(s => s.docs.some(d => d.data().postId === 'vs1'))));
  await p.click('.story-close'); await p.waitForTimeout(400);
  // Ma story : vues, J'aime reçus, publier dans le fil
  await p.evaluate(() => { const db = firebase.firestore(); return Promise.all([db.collection('wallPosts').doc('ms1').set({ id: 'ms1', author: 'Alex', authorUid: 'u1', audience: 'all', story: true, photoURL: 'icons/icon-192.png', createdAt: Date.now(), reactions: { Sam: '❤️', Tom: '❤️' } }), db.collection('postViews').doc('x1').set({ postId: 'ms1', owner: 'Alex', viewer: 'Sam', day: 'd' }), db.collection('postViews').doc('x2').set({ postId: 'ms1', owner: 'Alex', viewer: 'Tom', day: 'd' })]); });
  await p.waitForTimeout(800);
  const mi = await p.$$eval('.story-bubble[data-action="open-story"] .story-name', e => e.map(x => x.innerText).findIndex(t => /Moi|Me/.test(t)));
  await p.click('.story-bubble[data-action="open-story"] >> nth=' + mi); await p.waitForTimeout(700);
  console.log('ma story:', await p.$eval('.story-mine-foot', e => e.innerText.replace(/\n+/g, ' | ')).catch(() => 'absent'));
  // « Publier dans le fil » : seulement à la création (case du composeur).
  console.log('bouton fil sur une story publiée:', !!(await p.$('.story-to-feed')));
  await p.evaluate(() => firebase.firestore().collection('wallPosts').doc('ms1').update({ alsoInFeed: true }));
  await p.click('.story-close'); await p.waitForTimeout(600);
  console.log('carte dans le fil:', await p.$$eval('.feed-card .wall-post-media', e => e.length) > 0);
  await p.screenshot({ path: 'story-video-' + lang + '.png' });
  console.log('errs', JSON.stringify(errs)); await b.close();
})();
