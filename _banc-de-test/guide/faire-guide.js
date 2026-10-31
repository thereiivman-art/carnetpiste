#!/usr/bin/env node
// Guide PDF de Pitbook (FR et EN), dans le style des fiches profil et Club :
// 2 pages de résumé (ce qu'un pilote amateur y gagne, et pourquoi Pitbook
// plutôt qu'une autre appli), puis 2 pages de détail avec des captures de
// l'appli de démo, prises à chaque fois par captures.js.
//
//   node _banc-de-test/guide/faire-guide.js
//
// Écrit guides/Pitbook-FR.pdf et guides/Pitbook-EN.pdf.
const fs = require('fs');
const path = require('path');
const banc = require('../lancer.js');
const { captures } = require('./captures.js');
const { chromium } = require('../lib');

const DEPOT = banc.DEPOT;
const TMP = path.join(banc.BANC, '.sortie', 'guide');
const LIEN = 'https://thereiivman-art.github.io/carnetpiste/';
const LIEN_COURT = 'thereiivman-art.github.io/carnetpiste';

const ICON = {
  trend: '<path d="M3 17l6-6 4 4 8-8"/><path d="M14 7h7v7"/>',
  podium: '<path d="M9 21V7h6v14M3 21v-9h6M15 21v-6h6M2 21h20"/>',
  clock: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l3 2M9 2h6"/>',
  wrench: '<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.4-.6-.6-2.4z"/>',
  euro: '<path d="M17 6.5a7 7 0 1 0 0 11"/><path d="M4 10h9M4 14h9"/>',
  star: '<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7"/>',
  cross: '<path d="M6 6l12 12M18 6L6 18"/>'
};
const svg = (k, cls) => '<svg class="' + (cls || 'ico') + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + ICON[k] + '</svg>';

const Y = { y: true }, N = { n: true };
const TXT = {
  fr: {
    appName: 'Carnet de Piste',
    kicker: 'Le carnet de bord du pilote amateur',
    lead: 'Tes chronos, ta progression, tes potes, ta moto et ton budget, au même endroit. Même au paddock, sans réseau.',
    kpis: [['1 photo', 'de ta feuille de temps, et tes tours sont lus'], ['0 boîtier', 'à acheter : les chronos de l\'orga suffisent'], ['Hors ligne', 'tout marche au paddock, même sans réseau']],
    gainsH: 'Ce que tu y gagnes',
    gains: [
      ['trend', 'Tu vois tes progrès', 'Ton record sur chaque circuit, et ce que tu gagnes session après session.'],
      ['podium', 'Tu te mesures à tes potes', 'Le podium entre potes sur chaque circuit, après chaque roulage.'],
      ['clock', 'Tu es prêt le jour J', 'Ton groupe et tes horaires en grand, le compte à rebours, ta checklist.'],
      ['wrench', 'Tu connais ta moto', 'Tes réglages, tes pressions et tes pneus, notés par toi, liés à chaque session.'],
      ['euro', 'Tu tiens ton budget', 'Le prix des roulages, tes frais, et le total de ta saison.'],
      ['star', 'Tu gardes tes souvenirs', 'Tes saisons, tes trophées, et des stories à partager.']
    ],
    whyH: 'Pourquoi Carnet de Piste plutôt qu\'une autre appli ?',
    whyLead: 'Un pistard amateur jongle souvent entre un tableur, un groupe de discussion et une appli de chrono. Carnet de Piste réunit ce qui compte pour progresser d\'un roulage à l\'autre.',
    cols: ['Tableur ou carnet', 'Groupe de discussion', 'Appli de chrono GPS', 'Carnet de Piste'],
    rows: [
      ['Tes chronos, sans matériel', 'à recopier', 'photos en vrac', 'téléphone ou boîtier sur la moto', { y: true, t: 'une photo de la feuille de temps' }],
      ['Ta progression par circuit', 'si tu fais les formules', N, Y, Y],
      ['Le classement entre potes', N, 'à faire à la main', 'selon l\'appli', Y],
      ['Ton groupe et tes horaires du jour', N, 'messages à retrouver', N, Y],
      ['Réglages, pressions, pneus', 'à la main', N, 'selon l\'appli', { y: true, t: 'liés à chaque session' }],
      ['Le budget de ta saison', 'à la main', N, N, Y]
    ],
    tableNote: 'Une appli de chrono GPS donne tes trajectoires et tes secteurs : Carnet de Piste ne la remplace pas, il garde tout le reste au même endroit.',
    notH: 'Ce que Carnet de Piste ne fait pas',
    not: ['Pas d\'inscription ni de paiement : ça reste chez l\'organisateur.', 'Pas de chrono officiel : Carnet de Piste lit celui de l\'orga.', 'Aucun conseil de réglage ni de pression : tu notes tes valeurs, c\'est tout.', 'Tes réglages, tes pressions et ton budget restent privés : visibles par toi seul.'],
    tryH: 'Essaie-le',
    tryP: 'Ouvre ce lien sur ton téléphone :',
    trySteps: ['<b>iPhone</b> : Safari, Partager, « Sur l\'écran d\'accueil ».', '<b>Android</b> : Chrome, menu ⋮, « Installer l\'application ».', 'Crée ton compte, et c\'est parti.'],
    proto: 'C\'est un prototype : dis-moi ce qui t\'aide et ce qui manque.',
    detailK: 'En détail',
    detail: [
      ['journee', 'Ta journée, session par session', 'Après le roulage, prends en photo la feuille de temps : Carnet de Piste lit tes tours.', ['Ton meilleur temps et ce que tu as gagné d\'une session à l\'autre.', 'Ce que tu avais changé sur la moto entre deux sessions.', 'Une capture d\'écran ou le PDF de l\'orga marchent aussi.']],
      ['prochain', 'Le jour J', 'Le matin du roulage, l\'appli s\'ouvre sur l\'essentiel.', ['Ton groupe, tes horaires et un compte à rebours.', 'Horaires manquants ? Une photo du planning du paddock suffit.', 'Le roulage dans ton agenda, en un geste.']],
      ['potes', 'Entre potes', 'Chaque roulage se termine par un récap partagé avec tes amis.', ['Le podium entre potes sur chaque circuit, prêt à partager.', 'Tes accompagnants suivent tes roulages et peuvent saisir tes chronos.', 'Les albums photos de chacun, réunis sur le roulage.']],
      ['pressions', 'Ta moto', 'Tout ce que tu notes sur ta moto, retrouvé au bon moment.', ['Tes réglages après chaque session, et ceux de ton record.', 'Tes pressions AV et AR, circuit par circuit.', 'Les sessions et les km faits sur chaque train de pneus.', 'Carnet de Piste ne propose aucune valeur : ce sont les tiennes.']],
      ['budget', 'Ton budget', 'Ce que te coûte ta saison, sans tableur.', ['Le prix annoncé par l\'orga est repris tout seul.', 'Tes frais (déplacement, hôtel, pneus) et tes propres lignes.', 'Le total de la saison, ce qui est payé et ce qui reste.']],
      ['records', 'Tes records et ta saison', 'Ta progression, chiffrée, roulage après roulage.', ['Ton record sur chaque circuit, et l\'écart avec tes potes.', 'Ton chrono estimé sur un circuit où tu n\'as jamais roulé.', 'Des trophées qui se débloquent au fil des roulages.']]
    ],
    startH: 'Ton premier roulage avec Carnet de Piste',
    start: [['Avant', 'Installe l\'appli, ouvre-la une minute avec du réseau et ajoute ton prochain roulage.'], ['Le matin', 'L\'écran du jour J affiche ton groupe et tes horaires.'], ['Après tes sessions', 'Prends en photo la feuille de temps, et note tes réglages.'], ['Le soir', 'Ta journée session par session, puis le podium des potes.']],
    foot: 'Carnet de Piste · prototype'
  },
  en: {
    appName: 'Pitbook',
    kicker: 'The amateur track rider\'s logbook',
    lead: 'Your lap times, your progress, your friends, your bike and your budget, all in one place. Even in the paddock, with no signal.',
    kpis: [['1 photo', 'of your timesheet, and your laps are read'], ['0 device', 'to buy: the organiser\'s timing is enough'], ['Offline', 'everything works in the paddock, even with no signal']],
    gainsH: 'What you get',
    gains: [
      ['trend', 'You see your progress', 'Your record on every circuit, and what you gain session after session.'],
      ['podium', 'You measure up to your friends', 'The friends\' podium on every circuit, after every trackday.'],
      ['clock', 'You\'re ready on the day', 'Your group and schedule in big type, the countdown, your checklist.'],
      ['wrench', 'You know your bike', 'Your setup, pressures and tyres, logged by you, tied to each session.'],
      ['euro', 'You keep to your budget', 'Trackday prices, your costs, and your season total.'],
      ['star', 'You keep the memories', 'Your seasons, your trophies, and stories to share.']
    ],
    whyH: 'Why Pitbook rather than another app?',
    whyLead: 'Amateur track riders often juggle a spreadsheet, a group chat and a lap-timer app. Pitbook brings together what matters to improve from one trackday to the next.',
    cols: ['Spreadsheet or notebook', 'Group chat', 'GPS lap-timer app', 'Pitbook'],
    rows: [
      ['Your lap times, no hardware', 'typed in again', 'photos everywhere', 'phone or device on the bike', { y: true, t: 'a photo of the timesheet' }],
      ['Your progress per circuit', 'if you write the formulas', N, Y, Y],
      ['The ranking among friends', N, 'done by hand', 'depends on the app', Y],
      ['Your group and schedule on the day', N, 'messages to dig out', N, Y],
      ['Setup, pressures, tyres', 'by hand', N, 'depends on the app', { y: true, t: 'tied to each session' }],
      ['Your season budget', 'by hand', N, N, Y]
    ],
    tableNote: 'A GPS lap-timer gives you your lines and sectors: Pitbook doesn\'t replace it, it keeps everything else in one place.',
    notH: 'What Pitbook doesn\'t do',
    not: ['No booking or payment: that stays with the organiser.', 'No official timing: Pitbook reads the organiser\'s.', 'No setup or pressure advice: you log your values, that\'s all.', 'Your setup, pressures and budget stay private: visible to you only.'],
    tryH: 'Try it',
    tryP: 'Open this link on your phone:',
    trySteps: ['<b>iPhone</b>: Safari, Share, “Add to Home Screen”.', '<b>Android</b>: Chrome, menu ⋮, “Install app”.', 'Create your account, and you\'re set.'],
    proto: 'It\'s a prototype: tell me what helps and what\'s missing.',
    detailK: 'In detail',
    detail: [
      ['journee', 'Your day, session by session', 'After the trackday, take a photo of the timesheet: Pitbook reads your laps.', ['Your best time and what you gained from one session to the next.', 'What you changed on the bike between two sessions.', 'A screenshot or the organiser\'s PDF work too.']],
      ['prochain', 'Race day', 'On the morning of the trackday, the app opens on what matters.', ['Your group, your schedule and a countdown.', 'Schedule missing? A photo of the paddock board is enough.', 'The trackday in your calendar, in one tap.']],
      ['potes', 'With your friends', 'Every trackday ends with a recap shared with your friends.', ['The friends\' podium on every circuit, ready to share.', 'Your companions follow your trackdays and can log your lap times.', 'Everyone\'s photo albums, gathered on the trackday.']],
      ['pressions', 'Your bike', 'Everything you note about your bike, found at the right time.', ['Your setup after each session, and the one from your record.', 'Your front and rear pressures, circuit by circuit.', 'Sessions and km done on each set of tyres.', 'Pitbook suggests no value: they are yours.']],
      ['budget', 'Your budget', 'What your season costs, without a spreadsheet.', ['The organiser\'s announced price is picked up for you.', 'Your costs (travel, hotel, tyres) and your own lines.', 'The season total, what\'s paid and what\'s left.']],
      ['records', 'Your records and your season', 'Your progress, in numbers, trackday after trackday.', ['Your record on every circuit, and the gap to your friends.', 'Your estimated lap time on a circuit you\'ve never ridden.', 'Trophies that unlock as you ride.']]
    ],
    startH: 'Your first trackday with Pitbook',
    start: [['Before', 'Install the app, open it for a minute with a signal and add your next trackday.'], ['In the morning', 'The race-day screen shows your group and your schedule.'], ['After your sessions', 'Take a photo of the timesheet, and note your setup.'], ['In the evening', 'Your day session by session, then the friends\' podium.']],
    foot: 'Pitbook · prototype'
  }
};

const CSS = `
@page { size: A4; margin: 0; }
:root { --bg: #f4f3ef; --ink: #14161a; --red: #c8261f; --muted: #6b6f76; --line: #e3e1da; --card: #ffffff; --tint: #fbeceb; }
* { box-sizing: border-box; }
html, body { margin: 0; background: var(--bg); color: var(--ink); font-family: Inter, 'DejaVu Sans', sans-serif; font-size: 10pt; line-height: 1.42; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.page { width: 210mm; height: 297mm; padding: 13mm 14mm 11mm; overflow: hidden; page-break-after: always; display: flex; flex-direction: column; gap: 6mm; position: relative; }
.display { font-family: 'Inter Display', Inter, sans-serif; font-weight: 800; font-style: italic; text-transform: uppercase; letter-spacing: -0.01em; line-height: 1; }
h2.display { font-size: 15pt; margin: 0; }
.heading { display: flex; align-items: center; gap: 3.5mm; }
.kerb { width: 4.2mm; height: 11mm; background: var(--red); border-radius: 1.2mm; transform: skewX(-16deg); flex: none; }
.heading .display { font-size: 21pt; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 4.5mm; padding: 5mm 5.5mm; box-shadow: 0 0.4mm 1.4mm rgba(20,22,26,0.06); }
.k { font-size: 7.5pt; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; color: var(--red); }
.muted { color: var(--muted); }
/* Bandeau, comme la fiche pilote */
.hero { position: relative; overflow: hidden; background: var(--red); color: #fff; border-radius: 5mm; padding: 10mm 9mm 8mm; min-height: 68mm; display: flex; flex-direction: column; justify-content: flex-end; gap: 2mm; }
.hero::before { content: ""; position: absolute; left: 0; right: 0; top: 0; height: 3.2mm; background: repeating-linear-gradient(90deg, #fff 0 9mm, var(--red) 9mm 18mm); }
.hero .k { color: #fff; opacity: .9; }
.hero h1 { font-size: 60pt; margin: 0; }
.hero p { margin: 0; font-size: 12pt; max-width: 112mm; line-height: 1.35; }
.hero img { position: absolute; right: 6mm; top: 9mm; width: 68mm; filter: grayscale(1) invert(1) brightness(2); mix-blend-mode: screen; opacity: .55; }
/* Trois chiffres, comme les tuiles de la fiche */
.kpis { display: grid; grid-template-columns: repeat(3, 1fr); gap: 3.5mm; }
.kpis div { background: var(--card); border: 1px solid var(--line); border-radius: 4mm; padding: 4mm 3mm; text-align: center; }
.kpis strong { display: block; font-family: 'Inter Display', Inter, sans-serif; font-weight: 800; font-style: italic; font-size: 21pt; color: var(--red); line-height: 1.05; }
.kpis span { font-size: 8.5pt; color: var(--muted); display: block; margin-top: 1mm; line-height: 1.3; }
.gains { display: grid; grid-template-columns: 1fr 1fr; gap: 3.5mm; }
.gain { display: grid; grid-template-columns: 12mm 1fr; gap: 4mm; align-items: start; background: var(--card); border: 1px solid var(--line); border-radius: 4mm; padding: 4mm; }
.gain .ico-wrap { width: 12mm; height: 12mm; border-radius: 3mm; background: var(--tint); color: var(--red); display: grid; place-items: center; }
.gain .ico { width: 6.2mm; height: 6.2mm; }
.gain b { display: block; font-size: 11pt; margin-bottom: 0.6mm; }
.gain span { font-size: 9.5pt; color: var(--muted); }
.foot { margin-top: auto; display: flex; justify-content: space-between; font-size: 8pt; color: var(--muted); border-top: 1px solid var(--line); padding-top: 2.5mm; }
.foot a { color: var(--muted); text-decoration: none; }
/* Comparatif */
.lead { font-size: 11pt; margin: 0; }
table { width: 100%; border-collapse: separate; border-spacing: 0; font-size: 9.2pt; }
th, td { padding: 3.4mm 2mm; text-align: center; vertical-align: middle; border-bottom: 1px solid var(--line); }
th { font-size: 7.6pt; font-weight: 700; color: var(--muted); text-transform: uppercase; letter-spacing: .06em; vertical-align: bottom; }
td:first-child, th:first-child { text-align: left; font-weight: 600; width: 32%; }
td:first-child { font-size: 9.4pt; }
tr:last-child td { border-bottom: 0; }
.us { background: var(--tint); }
th.us { background: var(--red); color: #fff; border-radius: 2.5mm 2.5mm 0 0; font-size: 9pt; }
tr:last-child td.us { border-radius: 0 0 2.5mm 2.5mm; }
td .ico { width: 5mm; height: 5mm; vertical-align: middle; }
td.us .ico { color: var(--red); }
td .yes { color: var(--ink); }
.dash { color: #b7b9bd; font-weight: 700; }
.cell-t { display: block; font-size: 7.6pt; color: var(--muted); line-height: 1.25; margin-top: .4mm; }
td.us .cell-t { color: var(--red); font-weight: 600; }
.small { font-size: 8.6pt; color: var(--muted); margin: 2.5mm 0 0; }
.grid2 { display: grid; grid-template-columns: 1.08fr 1fr; gap: 4mm; }
ul.list { list-style: none; padding: 0; margin: 2.5mm 0 0; display: grid; gap: 2.2mm; }
ul.list li { display: grid; grid-template-columns: 5mm 1fr; gap: 2mm; font-size: 9.6pt; }
ul.list .ico { width: 4.4mm; height: 4.4mm; margin-top: .3mm; }
ul.not .ico { color: var(--muted); }
ul.yes .ico { color: var(--red); }
.try { background: var(--ink); color: #fff; border: 0; }
.try .k { color: #fff; opacity: .8; }
.try a.link { display: block; margin: 2.5mm 0 3mm; background: var(--red); color: #fff; text-decoration: none; border-radius: 2.5mm; padding: 3mm; font-weight: 700; font-size: 10pt; text-align: center; word-break: break-all; }
.try ol { margin: 0; padding-left: 4.5mm; font-size: 9pt; display: grid; gap: 1.3mm; }
.try .proto { margin: 3mm 0 0; font-size: 8.6pt; opacity: .8; }
/* Détail */
.feat { display: grid; grid-template-columns: 41mm 1fr; gap: 7mm; align-items: center; }
.feat.flip { grid-template-columns: 1fr 41mm; }
.feat.flip .phone { order: 2; }
.phone { width: 41mm; height: 76mm; border-radius: 6.5mm; border: 1.5mm solid var(--ink); overflow: hidden; background: #fff; box-shadow: 0 1.5mm 4mm rgba(20,22,26,0.18); }
.phone img { width: 100%; height: 100%; object-fit: cover; object-position: top; display: block; }
.feat h2 { margin-bottom: 2mm; }
.feat p { margin: 0; font-size: 10.5pt; }
.feat .num { font-family: 'Inter Display', Inter, sans-serif; font-weight: 800; font-style: italic; color: var(--red); font-size: 13pt; margin-bottom: 1mm; }
.steps { display: grid; grid-template-columns: repeat(4, 1fr); gap: 3mm; margin-top: 3mm; }
.step b { display: block; font-size: 9.5pt; margin-bottom: .8mm; }
.step .n { width: 7mm; height: 7mm; border-radius: 50%; border: .5mm solid var(--red); color: var(--red); display: grid; place-items: center; font-weight: 800; font-size: 9pt; margin-bottom: 1.5mm; }
.step span { font-size: 8.6pt; color: var(--muted); }
`;

function cell(c, us) {
  if (c && c.y) return '<td' + (us ? ' class="us"' : '') + '>' + svg('check', 'ico yes') + (c.t ? '<span class="cell-t">' + c.t + '</span>' : '') + '</td>';
  if (c && c.n) return '<td' + (us ? ' class="us"' : '') + '><span class="dash">—</span></td>';
  return '<td' + (us ? ' class="us"' : '') + '><span class="cell-t">' + c + '</span></td>';
}
function foot(t, n) { return '<div class="foot"><span>' + t.foot + '</span><a href="' + LIEN + '">' + LIEN_COURT + '</a><span>' + n + ' / 4</span></div>'; }
function feat(t, f, i, shots) {
  return '<div class="feat' + (i % 2 ? ' flip' : '') + '"><div class="phone"><img src="file://' + shots[f[0]] + '" alt=""></div>' +
    '<div><div class="num">0' + (i + 1) + '</div><h2 class="display">' + f[1] + '</h2><p>' + f[2] + '</p>' +
    '<ul class="list yes">' + f[3].map(x => '<li>' + svg('check') + '<span>' + x + '</span></li>').join('') + '</ul></div></div>';
}
function html(lang, shots) {
  const t = TXT[lang];
  const trace = path.join(DEPOT, 'circuit-outlines', 'Barcelone.png');
  const p1 = '<section class="page">' +
    '<div class="hero"><img src="file://' + trace + '" alt=""><div class="k">' + t.kicker + '</div><h1 class="display">' + t.appName + '</h1><p>' + t.lead + '</p></div>' +
    '<div class="kpis">' + t.kpis.map(k => '<div><strong>' + k[0] + '</strong><span>' + k[1] + '</span></div>').join('') + '</div>' +
    '<div class="heading"><span class="kerb"></span><h2 class="display">' + t.gainsH + '</h2></div>' +
    '<div class="gains">' + t.gains.map(g => '<div class="gain"><span class="ico-wrap">' + svg(g[0]) + '</span><div><b>' + g[1] + '</b><span>' + g[2] + '</span></div></div>').join('') + '</div>' +
    '<div class="card"><div class="k">' + t.startH + '</div><div class="steps">' + t.start.map((s, i) => '<div class="step"><div class="n">' + (i + 1) + '</div><b>' + s[0] + '</b><span>' + s[1] + '</span></div>').join('') + '</div></div>' +
    foot(t, 1) + '</section>';
  const p2 = '<section class="page">' +
    '<div class="heading"><span class="kerb"></span><h2 class="display">' + t.whyH + '</h2></div>' +
    '<p class="lead">' + t.whyLead + '</p>' +
    '<div class="card"><table><thead><tr><th></th>' + t.cols.map((c, i) => '<th' + (i === 3 ? ' class="us"' : '') + '>' + c + '</th>').join('') + '</tr></thead><tbody>' +
    t.rows.map(r => '<tr><td>' + r[0] + '</td>' + r.slice(1).map((c, i) => cell(c, i === 3)).join('') + '</tr>').join('') + '</tbody></table>' +
    '<p class="small">' + t.tableNote + '</p></div>' +
    '<div class="grid2"><div class="card"><div class="k">' + t.notH + '</div><ul class="list not">' + t.not.map(x => '<li>' + svg('cross') + '<span>' + x + '</span></li>').join('') + '</ul></div>' +
    '<div class="card try"><div class="k">' + t.tryH + '</div><div style="margin-top:2mm;font-size:9.4pt;">' + t.tryP + '</div><a class="link" href="' + LIEN + '">' + LIEN_COURT + '</a>' +
    '<ol>' + t.trySteps.map(x => '<li>' + x + '</li>').join('') + '</ol><p class="proto">' + t.proto + '</p></div></div>' +
    foot(t, 2) + '</section>';
  const p3 = '<section class="page"><div class="heading"><span class="kerb"></span><h2 class="display">' + t.detailK + '</h2></div>' +
    t.detail.slice(0, 3).map((f, i) => feat(t, f, i, shots)).join('') + foot(t, 3) + '</section>';
  const p4 = '<section class="page"><div class="heading"><span class="kerb"></span><h2 class="display">' + t.detailK + '</h2></div>' +
    t.detail.slice(3).map((f, i) => feat(t, f, i + 3, shots)).join('') + foot(t, 4) + '</section>';
  return '<!doctype html><html lang="' + lang + '"><head><meta charset="utf-8"><title>' + TXT[lang].appName + '</title><style>' + CSS + '</style></head><body>' + p1 + p2 + p3 + p4 + '</body></html>';
}

(async () => {
  fs.mkdirSync(TMP, { recursive: true });
  const srv = await banc.servir();
  const base = 'http://localhost:' + banc.PORT + '/';
  const b = await chromium.launch();
  for (const lang of ['fr', 'en']) {
    const shots = await captures(base, TMP, lang);
    const f = path.join(TMP, 'guide-' + lang + '.html');
    fs.writeFileSync(f, html(lang, shots));
    const p = await b.newPage();
    await p.goto('file://' + f); await p.waitForTimeout(600);
    const over = await p.$$eval('.page', ps => ps.map(x => x.scrollHeight - x.clientHeight));
    if (over.some(o => o > 1)) console.log('Attention ' + lang + ' : page trop pleine', over);
    const out = path.join(DEPOT, 'guides', 'Pitbook-' + lang.toUpperCase() + '.pdf');
    await p.pdf({ path: out, preferCSSPageSize: true, printBackground: true });
    await p.close();
    console.log('Écrit : ' + path.relative(DEPOT, out));
  }
  await b.close();
  srv.close();
})().catch(e => { console.error(e); process.exit(1); });
