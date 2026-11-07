// Ouvre « Signaler un incident » depuis la saisie d'un chrono (onglet Chrono), pour le circuit et la date donnés.
module.exports = async function openIncident(p, circuit, frDate, evId) {
  if (evId) frDate = await p.evaluate((id) => { const e = window.__MOCK_DATA.events[id]; const a = e.dateStart.split('-'); return a[2] + '/' + a[1] + '/' + a[0]; }, evId);
  await p.click('.bottom-nav-btn.bottom-nav-main'); await p.waitForTimeout(500);
  const opener = p.locator('#add-chrono-toggle:visible, [data-action="chrono-add-today"]:visible, .chrono-big-btn:not([data-action="chrono-proposal"]):visible').first();
  if (await opener.count()) { await opener.click(); await p.waitForTimeout(500); }
  await p.evaluate(() => { const d = document.querySelector('details.cf-more'); if (d) d.open = true; });
  if (circuit) await p.selectOption('#f-circuit', circuit).catch(() => {});
  await p.waitForTimeout(200);
  if (frDate) await p.fill('#f-date', frDate).catch(() => {});
  const b = await p.$('[data-action="incident-from-form"]');
  if (!b) return null;
  await b.click(); await p.waitForTimeout(400);
  return b;
};
