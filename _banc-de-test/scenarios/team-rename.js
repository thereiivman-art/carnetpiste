// Fiche d'un Team : une seule fenêtre d'édition (engrenage = Modifier),
// nom (doublon refusé), type, couverture recadrable, Enregistrer unique,
// confirmation avant de perdre des changements.
const { chromium, BASE } = require('../lib');
(async () => {
  const lang = process.argv[2] || 'fr';
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 380, height: 1000 } });
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  const open = async (hash) => {
    await p.goto('about:blank'); await p.goto(BASE + 'index.html#lang=' + lang + (hash || '')); await p.waitForTimeout(1600);
    await p.click('.bottom-nav-btn:nth-child(3)'); await p.waitForTimeout(400);
    await p.click('.subnav-btn[data-view="team"]'); await p.waitForTimeout(400);
    await p.getByText('Team Piste').first().click(); await p.waitForTimeout(700);
    await p.click('[data-action="team-settings-open"]'); await p.waitForTimeout(400);
  };
  await open();
  console.log('éditeur unique:', await p.$$eval('.look-editor', e => e.length), '| boutons média:', await p.$$eval('.look-team-media button', e => e.map(x => x.innerText).join(' / ')));
  console.log('confidentialité dans la fiche:', !!(await p.$('#look-team-vis')), '| zone sensible:', !!(await p.$('.look-team-extra [data-action="team-delete-request"]')), '| un seul Enregistrer:', await p.$$eval('[data-action="look-save"]', e => e.length));
  console.log('une ligne:', await p.$eval('.look-team-media', e => { const ys = [...e.querySelectorAll('button')].map(b => Math.round(b.getBoundingClientRect().top)); return new Set(ys).size === 1; }));
  await p.fill('#look-team-name', 'Mototeam95'); await p.click('[data-action="look-save"]'); await p.waitForTimeout(500);
  console.log('duplicate ->', (await p.$$eval('.toast', e => e.map(x => x.innerText))).pop());
  console.log('toujours ouvert après le refus:', !!(await p.$('.look-editor')));
  p.once('dialog', d => d.accept());
  await p.click('[data-action="look-cancel"]'); await p.waitForTimeout(300);
  await p.click('[data-action="team-settings-open"]'); await p.waitForTimeout(400);
  await p.fill('#look-team-name', '  Team   Piste  Sud '); await p.selectOption('#look-team-kind', 'photographes'); await p.selectOption('#look-team-vis', 'all');
  // Quitter sans enregistrer : confirmation (on reste).
  let asked = ''; p.once('dialog', d => { asked = d.message().slice(0, 30); d.dismiss(); });
  await p.click('[data-action="look-cancel"]'); await p.waitForTimeout(300);
  console.log('confirmation:', asked, '| toujours dans l\'éditeur:', !!(await p.$('.look-editor')));
  // Couverture : choisie puis recadrée, gardée dans le brouillon.
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR42mP8z8DwnwEIGBgAHgQCAQwG7XcAAAAASUVORK5CYII=';
  const [fc] = await Promise.all([p.waitForEvent('filechooser'), p.click('[data-action="team-cover-pick"]')]);
  await fc.setFiles({ name: 'c.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') }); await p.waitForTimeout(900);
  console.log('recadrage ouvert:', await p.$$eval('h2', e => e.map(x => x.innerText).filter(t => /Recadrer|Crop/.test(t)).join()));
  const saveBtn = await p.$('#crop-save-btn');
  console.log('bouton valider recadrage:', !!saveBtn); if (saveBtn) { await saveBtn.click(); await p.waitForTimeout(900); }
  console.log('bouton Recadrer:', !!(await p.$('[data-action="team-cover-recrop"]')));
  await p.click('[data-action="look-save"]'); await p.waitForTimeout(700);
  console.log('stored:', await p.evaluate(() => Object.values(window.__MOCK_DATA.teams).map(t => t.name + ':' + (t.kind || '-') + ':' + (t.visibility || '-') + ':' + !!(t.look && t.look.coverPhoto)).join(', ')));
  await p.screenshot({ path: 'team-rename-' + lang + '.png' });
  console.log('errs', JSON.stringify(errs)); await b.close();
})();
