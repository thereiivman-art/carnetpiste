// Incident : plus sur l'écran de saisie du chrono ; il se note après coup,
// sur la page d'un roulage passé (petit bouton « Incident ») : type, endroit
// sur le plan, un mot, publié sur mon Social si coché, rangé sur ma session.
const { chromium, BASE } = require('../lib');
(async () => { const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 390, height: 900 } });
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto(BASE + 'index.html#lang=' + (process.argv[2] || 'fr') + '&jourj=1'); await p.waitForTimeout(1600);
  await p.click('.bottom-nav-main'); await p.waitForTimeout(400);
  console.log('plus de bouton sur la saisie:', !(await p.$('#cf-incident')));
  // Roulage passé (sans le mode jour J)
  await p.goto('about:blank'); await p.goto(BASE + 'index.html#lang=' + (process.argv[2] || 'fr')); await p.waitForTimeout(1600);
  await p.click('.bottom-nav-btn:nth-child(1)'); await p.waitForTimeout(300);
  await p.click('.subnav-btn[data-view="carnet"]'); await p.waitForTimeout(300);
  await p.locator('[data-cards-mode="passees"]:visible').first().click().catch(() => {}); await p.waitForTimeout(400);
  await p.locator('#root [data-outing-event]:visible').first().click({ position: { x: 30, y: 14 } }); await p.waitForTimeout(700);
  const btn = await p.$('[data-action="incident-past"]');
  console.log('bouton Incident:', btn ? await btn.innerText() : 'absent', '| largeur:', btn ? Math.round((await btn.boundingBox()).width) : 0);
  if (btn) {
    await btn.click(); await p.waitForTimeout(400);
    console.log('titre:', await p.$eval('#mini-sheet .section-title', e => e.innerText).catch(() => '?'), '| types:', await p.$$eval('[data-inc-type]', e => e.map(x => x.innerText).join(' / ')));
    await p.click('[data-inc-type="sortie"]'); await p.waitForTimeout(200);
    const r = await p.$eval('.incident-map img', e => { const b = e.getBoundingClientRect(); return { x: b.left + b.width * 0.4, y: b.top + b.height * 0.5 }; });
    await p.mouse.click(r.x, r.y); await p.waitForTimeout(300);
    await p.fill('#inc-note', 'Tout va bien');
    await p.click('[data-inc="ok"]'); await p.waitForTimeout(600);
    console.log('publié:', JSON.stringify(await p.evaluate(() => Object.values(window.__MOCK_DATA.wallPosts).filter(w => w.incident).map(w => [w.text, w.audience]))));
    console.log('sur la session:', await p.evaluate(() => firebase.firestore().collection('sessions').get().then(s => JSON.stringify(s.docs.map(d => d.data()).filter(x => x.incident).map(x => [x.circuit, x.incident.type])))));
  }
  // Pour un ami : « Pour qui ? » s'affiche quand des amis ont roulé ce jour-là.
  const b2 = await p.$('[data-action="incident-past"]');
  if (b2) {
    await b2.click(); await p.waitForTimeout(400);
    const who = await p.$$eval('[data-inc-who]', e => e.map(x => x.getAttribute('data-inc-who')));
    console.log('pour qui:', JSON.stringify(who));
    if (who.length > 1) {
      await p.click('[data-inc-who="' + who[1] + '"]'); await p.waitForTimeout(200);
      await p.click('[data-inc-type="chute"]'); await p.waitForTimeout(200);
      await p.click('[data-inc="ok"]'); await p.waitForTimeout(600);
      console.log('ami publié:', JSON.stringify(await p.evaluate(() => Object.values(window.__MOCK_DATA.wallPosts).filter(w => w.incident && w.incident.subject).map(w => [w.text, w.incident.subject, (w.visibleTo || []).length]))));
    } else await p.keyboard.press('Escape');
  }
  console.log('errs', JSON.stringify(errs)); await b.close(); })();
