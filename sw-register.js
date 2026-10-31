// Registers the offline app-shell worker (see sw.js) so the app installs
// on the home screen and still opens (cached UI + last-seen data via
// Firestore's own offline persistence) with no signal at the track.
// Deliberately no custom "new version available" prompt: the worker
// updates itself in the background and the new shell simply takes over
// on the next full reload, same as any other static-site deploy.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('sw.js').catch(function () {});
  });
}
