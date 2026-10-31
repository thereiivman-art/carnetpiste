(function () {
  var today = new Date(); function d(off) { var x = new Date(today); x.setDate(x.getDate() + off); return x.toISOString().slice(0, 10); }
  var LANG = (location.hash.match(/lang=(\w+)/) || [])[1] || 'en'; var ADMIN = /admin=1/.test(location.hash); var EMAIL = ADMIN ? (window.__BENCH_ADMIN_EMAIL || 'admin@example.com') : 'alex@example.com';
  window.__MOCK_USER = { uid: 'u1', email: EMAIL, emailVerified: true, isAnonymous: false, displayName: 'Alex', getIdToken: function () { return Promise.resolve('x'); }, sendEmailVerification: function () { return Promise.resolve(); } };
  window.__MOCK_DATA = {
    users: {
      u1: { name: 'Alex', role: /role=acc/.test(location.hash) ? 'accompagnant' : 'pilote', email: EMAIL, lang: LANG, tutorialSeen: true, country: 'FR', bike: 'Yamaha R6', level: 'intermediaire', bikeNumber: /look=1/.test(location.hash) ? '27' : undefined, look: /look=1/.test(location.hash) ? { cover: 'trace', plate: 'course', color: '#c8261f', bio: 'Pistard du dimanche' } : undefined },
      u2: { name: 'Sam', role: 'pilote', email: 'sam@example.com', lang: 'fr', tutorialSeen: true, country: 'BE', bike: 'BMW S1000RR' },
      u3: { name: 'Tom', role: 'pilote', email: 'tom@example.com', lang: 'fr', tutorialSeen: true, country: 'FR', bike: 'Yamaha R1' },
      u4: { name: 'Ugo', role: 'pilote', email: 'ugo@example.com', lang: 'fr', tutorialSeen: true, country: 'FR', bike: 'Yamaha R1' },
      u5: { name: 'Victor', role: 'pilote', email: 'victor@example.com', lang: 'fr', tutorialSeen: true, country: 'FR', bike: 'Yamaha R1' },
      u6: { name: 'Yann', role: 'pilote', email: 'yann@example.com', lang: 'fr', tutorialSeen: true, country: 'FR', bike: 'Yamaha R1' },
      u7: { name: 'Zoé', role: 'pilote', email: 'zoe@example.com', lang: 'fr', tutorialSeen: true, country: 'FR', bike: 'Yamaha R1' },
      u8: { name: 'Théo', role: 'pilote', email: 'theo@example.com', lang: 'fr', tutorialSeen: true, country: 'FR', bike: 'Yamaha R1' },
      u9: { name: 'Luca', role: 'pilote', email: 'luca@example.com', lang: 'fr', tutorialSeen: true, country: 'IT', bike: 'Ducati V4' }
    },
    chronoProposals: { cp1: { id: 'cp1', from: 'Tom', to: 'Alex', circuit: 'Mugello', date: d(-40), laps: [115.2, 114.1], slotLabel: '16h00-16h20', status: 'pending', createdAt: Date.now() } },
    friendRequests: { f1: { id: 'f1', from: 'Alex', to: 'Sam', status: 'accepted' }, f2: { id: 'f2', from: 'Luca', to: 'Alex', status: 'pending' }, g0: { id: 'g0', from: 'Alex', to: 'Tom', status: 'accepted' }, g1: { id: 'g1', from: 'Alex', to: 'Ugo', status: 'accepted' }, g2: { id: 'g2', from: 'Alex', to: 'Victor', status: 'accepted' }, g3: { id: 'g3', from: 'Alex', to: 'Yann', status: 'accepted' }, g4: { id: 'g4', from: 'Alex', to: 'Zoé', status: 'accepted' }, g5: { id: 'g5', from: 'Alex', to: 'Théo', status: 'accepted' } },
    riders: { Alex: { name: 'Alex' }, Sam: { name: 'Sam' } },
    circuits: { Barcelone: { name: 'Barcelone', km: 4.657 }, Mugello: { name: 'Mugello' } },
    events: {
      e1: { id: 'e1', circuit: 'Barcelone', dateStart: d(30), dateEnd: d(31), riders: ['Alex', 'Sam'], note: '~420 € · test', horairesOverride: { groupB: '9h20-9h40, 11h20-11h40, 14h20-14h40' }, riderGroups: { Alex: (function () { var o = {}; o[d(30)] = { am: 'B' }; o[d(31)] = { am: 'B' }; return o; })() } },
      e2: { id: 'e2', circuit: 'Mugello', dateStart: d(-40), dateEnd: d(-39), riders: ['Alex', 'Sam'], note: '~350 €', personalMediaLinks: { Sam: 'https://photos.app.goo.gl/SamMugello' } },
      e3: { id: 'e3', circuit: 'Le Mans', dateStart: '2025-05-10', dateEnd: '2025-05-11', riders: ['Alex'], note: '' },
      // Roulages passés sans chrono : pour cocher ses sessions sur les pneus.
      e4: { id: 'e4', circuit: 'Mugello', dateStart: d(-20), dateEnd: d(-19), riders: ['Alex'], note: '', horairesOverride: { groupB: '9h20-9h40, 11h20-11h40, 14h20-14h40, 16h20-16h40' }, riderGroups: { Alex: (function () { var o = {}; o[d(-20)] = { am: 'B', pm: 'B' }; o[d(-19)] = { am: 'B' }; return o; })() } },
      e5: { id: 'e5', circuit: 'Barcelone', dateStart: d(-10), dateEnd: d(-10), riders: ['Alex'], note: '' },
      e6: { id: 'e6', circuit: 'Misano', dateStart: d(60), dateEnd: d(61), riders: ['Alex'], note: '' },
      e7: { id: 'e7', circuit: 'Jerez', dateStart: d(90), dateEnd: d(91), riders: ['Alex'], note: '' },
      e8: { id: 'e8', circuit: 'Navarra', dateStart: d(120), dateEnd: d(121), riders: ['Alex'], note: '' },
      // Aujourd'hui : Sam et Tom roulent (Mes potes en piste).
      e9: { id: 'e9', circuit: 'Carole', dateStart: d(0), dateEnd: d(0), riders: /jourj=1/.test(location.hash) ? ['Sam', 'Tom', 'Alex'] : ['Sam', 'Tom'], note: '', horairesOverride: { groupB: '9h00-9h20, 11h00-11h20, 14h00-14h20, 16h00-16h20, 18h00-18h20', groupC: '9h20-9h40, 11h20-11h40, 14h20-14h40, 16h20-16h40, 18h20-18h40' }, riderGroups: { Alex: (function () { var o = {}; o[d(0)] = { am: 'B', pm: 'B' }; return o; })(), Sam: (function () { var o = {}; o[d(0)] = { am: 'B', pm: 'B' }; return o; })(), Tom: (function () { var o = {}; o[d(0)] = { am: 'C', pm: 'C' }; return o; })() } }
    },
    sessions: {
      // Roulage d'hier de Sam : une story dans le fil.
      sStory: { id: 'sStory', rider: 'Sam', date: d(-1), circuit: 'Lédenon', laps: [102.4, 101.1, 100.6], createdAt: Date.now() - 20 * 3600e3 },
      s1: { id: 's1', rider: 'Alex', date: d(-40), circuit: 'Mugello', laps: [118.2, 116.9, 115.4, 116.1], eventId: 'e2', bike: 'Yamaha R6', group: 'B', slotStart: 540, slotLabel: '9h00-9h20' },
      s1b: { id: 's1b', rider: 'Alex', date: d(-40), circuit: 'Mugello', laps: [115.9, 114.8, 114.6, 115.0, 114.9], eventId: 'e2', bike: 'Yamaha R6', group: 'B', slotStart: 660, slotLabel: '11h00-11h20' },
      s1c: { id: 's1c', rider: 'Alex', date: d(-40), circuit: 'Mugello', laps: [114.2, 113.6, 113.9, 113.7], eventId: 'e2', bike: 'Yamaha R6', group: 'B', slotStart: 840, slotLabel: '14h00-14h20' },
      // Chronos d'autres pilotes ailleurs : pour estimer le chrono d'Alex à Misano.
      e_sam_mis: { id: 'e_sam_mis', rider: 'Sam', date: d(-60), circuit: 'Misano', laps: [101.2, 99.8], bike: 'BMW S1000RR' },
      e_tom_mis: { id: 'e_tom_mis', rider: 'Tom', date: d(-50), circuit: 'Misano', laps: [104.5, 103.1] },
      e_tom_bcn: { id: 'e_tom_bcn', rider: 'Tom', date: d(-45), circuit: 'Barcelone', laps: [113.0, 112.2] },
      s1d: { id: 's1d', rider: 'Alex', date: d(-40), circuit: 'Mugello', laps: [114.0, 113.9, 114.3], eventId: 'e2', bike: 'Yamaha R6', group: 'B', slotStart: 960, slotLabel: '16h00-16h20' },
      s2: { id: 's2', rider: 'Sam', date: d(-40), circuit: 'Mugello', laps: [114.8, 113.9], eventId: 'e2' },
      s3: { id: 's3', rider: 'Alex', date: d(-100), circuit: 'Barcelone', laps: [112.4, 110.9], bike: 'Yamaha R6' }
    },
    teams: { t1: { id: 't1', name: 'Team Piste', leader: 'Alex', pro: false, slogan: 'On roule ensemble', look: /look=1/.test(location.hash) ? { cover: 'trace', color: '#c8261f', bio: 'On roule ensemble' } : undefined }, t2: { id: 't2', name: 'Mototeam95', teamPro: true } },
    teamMembers: /noteam=1/.test(location.hash) ? { m2: { teamId: 't1', name: 'Sam', role: 'membre' } } : { m1: { teamId: 't1', name: 'Alex', role: 'leader' }, m2: { teamId: 't1', name: 'Sam', role: 'membre' } },
    feedEvents: { fe1: { id: 'fe1', type: 'record', actor: 'Alex', circuit: 'Mugello', time: 113.6, createdAt: Date.now() - 2 * 3600e3 } },
    // Réseau : un message public de Luca (pas encore ami), un de Sam (ami),
    // et deux abonnés d'Alex.
    wallPosts: {
      w1: { id: 'w1', author: 'Luca', text: 'Premier roulage à Mugello, quelle piste !', audience: 'all', createdAt: Date.now() - 3 * 3600e3 },
      w2: { id: 'w2', author: 'Sam', text: 'Pneus neufs pour Barcelone, qui vient ?', audience: 'friends', createdAt: Date.now() - 5 * 3600e3 }
    },
    follows: {
      fo1: { follower: 'Luca', followee: 'Alex', createdAt: Date.now() - 86400e3 },
      fo2: { follower: 'Sam', followee: 'Alex', createdAt: Date.now() - 2 * 86400e3 }
    },
    postComments: { c1: { id: 'c1', postId: 'w2', author: 'Tom', text: 'Moi je viens !', createdAt: Date.now() - 4 * 3600e3 } },
    settings: {},
    userPrivate: { u1: { setups: {
      s1: { pFrontHot: '2.3', pRearHot: '2.0', fork: 'C8 R10', shock: 'R12' },
      s1b: { pFrontHot: '2.3', pRearHot: '1.9', fork: 'C8 R10', shock: 'R12' },
      s1c: { pFrontHot: '2.3', pRearHot: '1.9', fork: 'C8 R10', shock: 'R10' } },
      tyreSets: [{ id: 't0', label: 'Pirelli SC1', since: d(-120), at: 1, bike: 'Yamaha R6' }] } }
  };
})();
