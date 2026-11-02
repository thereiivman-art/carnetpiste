// Commentaires façon TikTok : J'aime (cœur) sur un commentaire, Répondre
// (réponse rangée sous le commentaire, « Voir la réponse »), et bouton
// Partager en haut à droite d'une publication.
const { chromium, BASE } = require('../lib');
(async () => { const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 390, height: 900 } });
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto(BASE + 'index.html#lang=' + (process.argv[2] || 'fr')); await p.waitForTimeout(1600);
  await p.evaluate(() => Promise.all([firebase.firestore().collection('wallPosts').doc('w2').update({ audience: 'all', authorUid: 'u2' }), firebase.firestore().collection('postComments').doc('c1').update({ public: true })]));
  await p.waitForTimeout(500);
  const post = '.feed-card:has([data-action="share-post"][data-id="w2"])';
  console.log('bouton partager:', await p.$$eval('[data-action="share-post"]', e => e.length));
  await p.click(post + ' [data-action="comments-toggle"]'); await p.waitForTimeout(300);
  await p.click(post + ' [data-action="like-comment"]'); await p.waitForTimeout(300);
  console.log('j\'aime:', await p.$eval(post + ' .comment-like', e => e.className + ' ' + e.innerText), '|', await p.evaluate(() => firebase.firestore().collection('postComments').doc('c1').get().then(d => JSON.stringify(d.data().likes))));
  await p.click(post + ' [data-action="reply-comment"]'); await p.waitForTimeout(300);
  console.log('mode réponse:', await p.$eval(post + ' .comment-reply-tag', e => e.innerText.replace(/\n/g, ' ')).catch(() => 'aucun'));
  await p.fill(post + ' [data-comment-text]', 'Moi aussi !'); await p.press(post + ' [data-comment-text]', 'Enter'); await p.waitForTimeout(400);
  console.log('réponse stockée:', JSON.stringify(await p.evaluate(() => firebase.firestore().collection('postComments').get().then(s => s.docs.map(d => d.data()).filter(c => c.parentId).map(c => [c.parentId, c.replyTo, c.text])))));
  console.log('fil des commentaires:', await p.$$eval(post + ' .post-comment', e => e.map(x => (x.classList.contains('is-reply') ? '  ↳ ' : '') + x.querySelector('.post-comment-bubble').innerText).join(' / ')));
  await p.screenshot({ path: 'commentaires.png' });
  await p.click(post + ' [data-action="share-post"]'); await p.waitForTimeout(300);
  console.log('partage:', await p.$$eval('[data-share-to]', e => e.map(x => x.innerText).join(', ')));
  await p.screenshot({ path: 'partage.png' });
  console.log('errs', JSON.stringify(errs)); await b.close(); })();
