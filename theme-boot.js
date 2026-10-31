// Applied before the stylesheet paints, so a saved Light/Dark choice never
// flashes the system theme first. "system" (no saved choice) leaves the
// attribute unset, letting the CSS media query decide as before.
(function () {
  try {
    var t = localStorage.getItem('carnet-de-piste-theme');
    if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  } catch (e) {}
})();
