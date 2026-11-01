// Inscription : choix « Je roule en Moto / Voiture », enregistré sur le profil.
const { chromium, BASE } = require('../lib');
(async () => {
  const lang = process.argv[2] || 'fr';
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 380, height: 900 } });
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto(BASE + 'index.html#lang=' + lang + '&nouveau=1'); await p.waitForTimeout(1500);
  await p.locator('button, a', { hasText: /Créer un compte|Create an account|S'inscrire|Sign up/ }).first().click().catch(() => {}); await p.waitForTimeout(400);
  console.log('formulaire:', !!(await p.$('#signup-form')));
  console.log('choix:', await p.$$eval('input[name="au-discipline"]', e => e.map(x => x.parentNode.innerText.trim() + (x.checked ? '✓' : '')).join(' / ')), '|', await p.$eval('input[name="au-discipline"]', e => e.closest('.auth-role-choice').previousElementSibling.innerText).catch(() => '?'));
  await p.fill('#au-name', 'Lena');
  await p.check('input[name="au-discipline"][value="auto"]');
  await p.fill('#au-email', 'lena@example.com'); await p.fill('#au-password', 'secret123');
  await p.check('#au-consent'); await p.check('#au-age');
  await p.click('#signup-form button[type="submit"]'); await p.waitForTimeout(1200);
  const doc = await p.evaluate(() => firebase.firestore().collection('users').doc('unew').get().then(d => d.exists ? d.data() : null));
  console.log('profil créé:', doc ? doc.name + ' · ' + (doc.discipline || 'moto') : 'aucun');
  console.log('errs', JSON.stringify(errs)); await b.close();
})();
