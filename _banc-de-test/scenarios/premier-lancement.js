// Premier lancement : questions selon le rôle, taille du texte, pneus.
const { chromium, BASE } = require('../lib');
(async () => {
  const lang = process.argv[2] || 'fr';
  const b = await chromium.launch(); const errs = [];
  for (const role of ['', '&role=acc', '&role=orga']) {
    const p = await b.newPage({ viewport: { width: 380, height: 800 } }); p.on('pageerror', e => errs.push(e.message));
    await p.goto(BASE + 'index.html#lang=' + lang + '&premier=1' + role); await p.waitForTimeout(1600);
    const titles = [];
    for (let i = 0; i < 8; i++) {
      const t = await p.$eval('.onb-modal .section-title', e => e.innerText).catch(() => null);
      if (!t) break; titles.push(t);
      if (i === 0 && !role) await p.screenshot({ path: 'premier-' + lang + '.png' });
      if (await p.$('#onb-bike')) await p.fill('#onb-bike', 'Honda CBR600RR');
      if (await p.$('[data-onb-size="grand"]')) await p.click('[data-onb-size="grand"]');
      await p.click('[data-onb-go="1"]'); await p.waitForTimeout(250);
    }
    const saved = await p.evaluate(() => { const u = window.__MOCK_DATA.users.u1; return [u.role, u.bike, u.tutorialSeen].join(' | '); });
    console.log((role || 'pilote') + ':', titles.join(' > '), '| fini:', !(await p.$('.onb-modal')), '| profil:', saved, '| texte grand:', await p.evaluate(() => document.documentElement.classList.contains('text-lg')));
    await p.close();
  }
  console.log('errs', JSON.stringify(errs)); await b.close();
  if (errs.length) process.exit(1);
})();
