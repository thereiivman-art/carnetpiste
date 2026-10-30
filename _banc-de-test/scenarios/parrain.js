// Gestion des comptes (admin) : corriger le parrain d'un compte.
const { chromium, BASE } = require('../lib');
(async () => {
  const lang = process.argv[2] || 'fr';
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 360, height: 1000 } });
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  const sam = () => p.evaluate(() => Object.values(window.__MOCK_DATA.users).filter(u => u.name === 'Sam').map(u => u.referredBy === undefined ? '(aucun)' : u.referredBy)[0]);
  const toast = async () => { const t = await p.$$eval('.toast', e => e.map(x => x.innerText)); return t[t.length - 1]; };
  await p.goto(BASE + 'index.html#lang=' + lang + '&admin=1'); await p.waitForTimeout(1600);
  await p.click('#settings-toggle'); await p.waitForTimeout(400);
  await p.getByText(lang === 'fr' ? 'Compte' : 'Account', { exact: true }).first().click(); await p.waitForTimeout(400);
  await p.click('#account-manager-toggle'); await p.waitForTimeout(800);
  const input = '[data-action="set-referrer"]';
  console.log('rows:', await p.$$eval(input, e => e.length), 'candidates:', await p.$$eval('#account-names option', e => e.map(o => o.value).join(', ')));
  await p.fill(input, 'Inconnu'); await p.press(input, 'Tab'); await p.waitForTimeout(400);
  console.log('unknown ->', await toast(), '| sam:', await sam());
  await p.fill(input, 'sam'); await p.press(input, 'Tab'); await p.waitForTimeout(400);
  console.log('self ->', await toast(), '| sam:', await sam());
  await p.fill(input, 'alex'); await p.press(input, 'Tab'); await p.waitForTimeout(600);
  console.log('set ->', await toast(), '| sam:', await sam(), '| field:', await p.$eval(input, e => e.value));
  await p.screenshot({ path: 'parrain-' + lang + '.png' });
  await p.fill(input, ''); await p.press(input, 'Tab'); await p.waitForTimeout(600);
  console.log('clear ->', await toast(), '| sam:', await sam());
  console.log('errs', JSON.stringify(errs)); await b.close();
})();
