// Applied before the stylesheet paints, so a saved Light/Dark choice never
// flashes the system theme first. "system" (no saved choice) leaves the
// attribute unset, letting the CSS media query decide as before.
(function () {
  try {
    var t = localStorage.getItem('carnet-de-piste-theme');
    if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  } catch (e) {}
  // Barres du téléphone (Android : état et navigation) à la couleur du
  // thème : celui de l'appareil, ou le choix fait dans l'appli.
  window.__syncBarsColor = function () {
    var forced = document.documentElement.dataset.theme;
    document.querySelectorAll('meta[name="theme-color"]').forEach(function (m) {
      if (!m.dataset.media) m.dataset.media = m.getAttribute('media') || '';
      if (forced) { m.setAttribute('content', forced === 'dark' ? '#10151b' : '#f4f3ef'); m.removeAttribute('media'); }
      else { m.setAttribute('content', /dark/.test(m.dataset.media) ? '#10151b' : '#f4f3ef'); if (m.dataset.media) m.setAttribute('media', m.dataset.media); }
    });
    var cs = document.querySelector('meta[name="color-scheme"]');
    if (cs) cs.setAttribute('content', forced || 'light dark');
  };
  window.__syncBarsColor();
})();
