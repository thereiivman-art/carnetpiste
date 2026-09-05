
(function () {
  "use strict";

  // Declared first and only here: several top-level `var x = ...expr...`
  // statements below (restoring "Tous les pilotes" from a saved browser
  // preference, for instance) call functions that read STATE immediately
  // as the script loads -- before any function is actually invoked later.
  // If this block sat further down the file (it used to, right before
  // startSync()/persist()/init()), those earlier statements would run
  // first and hit STATE while it's still undefined.
  var db = firebase.firestore();
  var auth = firebase.auth();
  var STATE = {
    sessions: [], events: [], circuits: {}, riders: [], usersByName: {}, friendRequests: [], feedEvents: [], myFollows: [], myFollowedTeams: [],
    myFollowedTeamTiers: {}, myTeamFollowDocs: {}, teams: [], myTeamMemberships: [], teamInvites: [], teamMembersByTeam: {}, teamFeed: [], teamFollowersByTeam: {},
    followedTeamFeed: [], wallPosts: [], coachRequests: [], teamJoinRequests: [], teamLikes: [], eventJoinRequests: [], coachMessages: [], eventAnnouncements: [],
    allTeamLeaders: [], feedback: [], partners: []
  };
  var canPersist = false;
  var unsubscribers = [];

  // Real accounts (email/password), not anonymous sign-in -- gates the
  // whole app behind a login/signup screen (see renderAuthScreen()).
  var authState = 'loading'; // 'loading' | 'signed-out' | 'signed-in'
  var currentUserProfile = null; // { name, role: 'pilote'|'accompagnant', email } once loaded
  // Distinguishes "no data" from "data not in yet" on the main tabs --
  // without this, a slow first connection briefly shows "Aucun événement"/
  // "Aucun pilote" (STATE's arrays start empty) before the real onSnapshot
  // payloads land, which reads as broken rather than loading. Reset to the
  // full set at the top of startSync(), each key removed the first time
  // its own listener actually fires (see startSync()).
  var CORE_SYNC_KEYS = ['sessions', 'events', 'circuits', 'riders', 'users', 'feedEvents', 'wallPosts'];
  var coreSyncPending = null;
  function markCoreSynced(key) { if (coreSyncPending) coreSyncPending.delete(key); }
  function coreDataLoading() { return !!(coreSyncPending && coreSyncPending.size); }
  var authMode = 'login'; // 'login' | 'signup' -- which form the auth screen shows
  var authError = '';
  var autoVerifyEmailSent = false; // guards the auto-resend in onAuthStateChanged, see there
  // Set right before an interactive login/signup attempt, consumed the
  // next time onAuthStateChanged actually lands on 'signed-in' -- lets
  // that one shared handler (also fired on every page reload's session
  // restore) tell a *fresh* connection apart from just reopening the app,
  // so the home tab/profile panel only reset on the former.
  var justAuthenticated = false;
  var riderBikeMap = {}; // rider name -> their bike, from users/{uid}.bike (see startSync)

  // name -> filleul count, fetched on demand (not live-synced) since it's
  // only ever needed while an Achievements section for that name is on
  // screen. undefined = not fetched yet, null = fetch in flight.
  var filleulCounts = {};
  function loadFilleulCount(name) {
    if (!name || filleulCounts[name] !== undefined) return;
    filleulCounts[name] = null;
    db.collection('users').where('referredBy', '==', name).get().then(function (snap) {
      filleulCounts[name] = snap.size;
      renderRoot();
    }).catch(function () {
      filleulCounts[name] = 0;
    });
  }

  function referralLinkFor(name) {
    return window.location.origin + window.location.pathname + '?ref=' + encodeURIComponent(name);
  }

  // ---- Social / amis ----
  //
  // STATE.friendRequests (synced in startSync) holds every friendRequests
  // doc that names this pilote either as from or to -- accepted rows are
  // friendships, pending rows sorted by which side sent them. Deriving all
  // three lists from that one array here keeps the UI code simple.
  function friendsOf(name) {
    return (STATE.friendRequests || [])
      .filter(function (r) { return r.status === 'accepted' && (r.from === name || r.to === name); })
      .map(function (r) { return { id: r.id, name: r.from === name ? r.to : r.from }; });
  }
  function incomingFriendRequests(name) {
    return (STATE.friendRequests || []).filter(function (r) { return r.status === 'pending' && r.to === name; });
  }
  function outgoingFriendRequests(name) {
    return (STATE.friendRequests || []).filter(function (r) { return r.status === 'pending' && r.from === name; });
  }
  // Everyone with an account (pilote/accompagnant/organisateur) is a valid
  // friend candidate, not just riders -- allKnownRiders() would miss
  // accompagnants and organisateurs entirely, since they're never added to
  // the riders roster.
  function allKnownUserNames() {
    return Object.keys(STATE.usersByName || {}).sort(function (a, b) { return a.localeCompare(b); });
  }

  function sendFriendRequest(toName) {
    var me = currentUserProfile;
    if (!me || !toName || toName === me.name) return;
    var already = (STATE.friendRequests || []).some(function (r) {
      return (r.from === me.name && r.to === toName) || (r.from === toName && r.to === me.name);
    });
    if (already) return;
    db.collection('friendRequests').add({ from: me.name, to: toName, status: 'pending', fromUid: myUid(), toUid: uidOf(toName) }).then(function () {
      showToast('Demande envoyée à ' + toName + '.', 'success');
    }).catch(function (err) {
      showToast('Erreur : ' + (err && err.message ? err.message : err));
    });
  }

  function acceptFriendRequest(id) {
    var req = (STATE.friendRequests || []).filter(function (r) { return r.id === id; })[0];
    db.collection('friendRequests').doc(id).update({ status: 'accepted' }).then(function () {
      showToast('Vous êtes maintenant amis.', 'success');
      if (req) writeFeedEvent('friend', { target: req.from });
    }).catch(function (err) {
      showToast('Erreur : ' + (err && err.message ? err.message : err));
    });
  }

  // Best-effort activity log for the Social feed -- never blocks the
  // action it documents (a failed write here shouldn't undo an accepted
  // friend request or a saved chrono), so errors are swallowed silently.
  function writeFeedEvent(type, extra) {
    if (!currentUserProfile) return;
    db.collection('feedEvents').add(Object.assign({
      type: type, actor: currentUserProfile.name, createdAt: Date.now()
    }, extra || {})).catch(function () {});
  }

  // One-way follow, for Personnalités -- no request/accept, unlike
  // friendRequests above; just a row this pilote owns and can delete.
  function followName(name) {
    var me = currentUserProfile;
    if (!me || !name || name === me.name || (STATE.myFollows || []).indexOf(name) !== -1) return;
    db.collection('follows').add({ follower: me.name, followee: name, followerUid: myUid(), followeeUid: uidOf(name) }).catch(function (err) {
      showToast('Erreur : ' + (err && err.message ? err.message : err));
    });
  }
  function unfollowName(name) {
    db.collection('follows').where('follower', '==', currentUserProfile.name).where('followee', '==', name).get().then(function (snap) {
      var batch = db.batch();
      snap.forEach(function (d) { batch.delete(d.ref); });
      return batch.commit();
    }).catch(function (err) {
      showToast('Erreur : ' + (err && err.message ? err.message : err));
    });
  }
  // Same one-way follow, for a Team that has opened itself up to discovery
  // (see renderTeamDiscovery) -- followeeType:'team' distinguishes these
  // rows from the person-follows above.
  function followTeam(teamId) {
    var me = currentUserProfile;
    if (!me || !teamId || (STATE.myFollowedTeams || []).indexOf(teamId) !== -1) return;
    db.collection('follows').add({ follower: me.name, followee: teamId, followeeType: 'team', followerUid: myUid() }).catch(function (err) {
      showToast('Erreur : ' + (err && err.message ? err.message : err));
    });
  }
  function unfollowTeam(teamId) {
    db.collection('follows').where('follower', '==', currentUserProfile.name).where('followee', '==', teamId).where('followeeType', '==', 'team').get().then(function (snap) {
      var batch = db.batch();
      snap.forEach(function (d) { batch.delete(d.ref); });
      return batch.commit();
    }).catch(function (err) {
      showToast('Erreur : ' + (err && err.message ? err.message : err));
    });
  }

  // Same delete either way -- declining a request received, cancelling one
  // sent, and un-friending an accepted one are all just removing the doc.
  function removeFriendRequest(id) {
    db.collection('friendRequests').doc(id).delete().catch(function (err) {
      showToast('Erreur : ' + (err && err.message ? err.message : err));
    });
  }

  // ---- Coaching ----
  //
  // A Pilote or Organisateur asks a Coach (a badge, see isCoachBadge, not
  // a signup role) to coach them -- same request/accept shape as
  // friendRequests, kept as its own collection since it means something
  // different (see renderCoachTab) and carries its own field (plan, the
  // coach's training notes for that pilote, writable only once accepted).
  // type: 'coaching' (default -- a pilote/organisateur asking a Coach, or
  // a Coach proposing regular coaching) or 'bapteme' -- a Coach offering a
  // baptême piste (ride-along/taster lap) instead, which unlike coaching
  // can target an accompagnant too, not just a pilote (see
  // renderCoachTab's propose form). No separate badge for it -- it's just
  // another thing an existing Coach can propose. slotInfo (optional):
  // {eventId, circuit, slotStart, slotEnd, slotLabel} for a single slot,
  // or {eventId, circuit, options: [{start,end,label}, ...]} (1-3 of
  // them) when a pilote/accompagnant is proposing several candidate
  // times at once (see renderCoachSlotModal) for the Coach to pick from
  // -- slotOptions (plain label strings) records every one offered, so
  // the recipient can later accept any of them, not just the default
  // (see firestore.rules' update rule).
  // 'awaiting' always starts on 'to' -- whoever receives a request or
  // proposal always has to act on it first, see the update rule in
  // firestore.rules for the back-and-forth this then allows.
  function sendCoachRequest(toName, type, slotInfo) {
    var me = currentUserProfile;
    if (!me || !toName || toName === me.name) return;
    var isBapteme = type === 'bapteme';
    // Scoped by type, not just by pair -- an account can have both an
    // active/pending coaching *and* a baptême piste with the same Coach
    // at once, just never two of the same type together.
    var already = (STATE.coachRequests || []).some(function (r) {
      return ((r.from === me.name && r.to === toName) || (r.from === toName && r.to === me.name))
        && (r.type || 'coaching') === (isBapteme ? 'bapteme' : 'coaching');
    });
    if (already) { showToast('Une demande de ce type existe déjà avec ce compte.'); return; }
    var doc = { from: me.name, to: toName, status: 'pending', plan: '', type: isBapteme ? 'bapteme' : 'coaching', awaiting: 'to', fromUid: myUid(), toUid: uidOf(toName) };
    if (slotInfo) {
      doc.eventId = slotInfo.eventId || null;
      doc.circuit = slotInfo.circuit || null;
      var options = slotInfo.options && slotInfo.options.length ? slotInfo.options : [{ start: slotInfo.slotStart, end: slotInfo.slotEnd, label: slotInfo.slotLabel }];
      var first = options[0];
      doc.slotStart = first.start != null ? first.start : null;
      doc.slotEnd = first.end != null ? first.end : null;
      doc.slotLabel = first.label || null;
      doc.slotOptions = options.map(function (o) { return o.label; }).filter(Boolean);
    }
    db.collection('coachRequests').add(doc).then(function () {
      showToast((isBapteme ? 'Proposition de baptême piste envoyée à ' : 'Demande de coaching envoyée à ') + toName + '.', 'success');
    }).catch(function (err) {
      showToast('Erreur : ' + (err && err.message ? err.message : err));
    });
  }
  function acceptCoachRequest(id) {
    db.collection('coachRequests').doc(id).update({ status: 'accepted' }).then(function () {
      showToast('Demande acceptée.', 'success');
    }).catch(function (err) {
      showToast('Erreur : ' + (err && err.message ? err.message : err));
    });
  }
  // Accept one of up to 3 alternative slots offered at creation (see
  // sendCoachRequest's slotOptions) instead of the default one -- only
  // valid when slotLabel is genuinely one of those originally offered
  // (see firestore.rules).
  function acceptCoachRequestSlot(id, chosenLabel) {
    var r = (STATE.coachRequests || []).filter(function (x) { return x.id === id; })[0];
    if (!r) return;
    var options = allEventSlots(eventsList().filter(function (e) { return e.id === r.eventId; })[0] || {});
    var chosen = options.filter(function (s) { return s.label === chosenLabel; })[0];
    if (!chosen) { showToast('Créneau invalide.'); return; }
    db.collection('coachRequests').doc(id).update({
      status: 'accepted', slotLabel: chosen.label, slotStart: chosen.start, slotEnd: chosen.end
    }).then(function () {
      showToast('Demande acceptée.', 'success');
    }).catch(function (err) {
      showToast('Erreur : ' + (err && err.message ? err.message : err));
    });
  }
  // Same delete either way -- declining, cancelling, or ending an active
  // coaching relationship are all just removing the doc.
  function removeCoachRequest(id) {
    db.collection('coachRequests').doc(id).delete().catch(function (err) {
      showToast('Erreur : ' + (err && err.message ? err.message : err));
    });
  }
  function saveCoachPlan(id, plan) {
    db.collection('coachRequests').doc(id).update({ plan: plan || '' }).catch(function (err) {
      showToast('Erreur : ' + (err && err.message ? err.message : err));
    });
  }
  // Counter-propose a different time on a still-pending request/
  // proposal -- only the side currently being awaited may call this (see
  // firestore.rules), and it flips 'awaiting' to the other side so
  // there's only ever one open proposal in flight. slotLabel must be one
  // of this event's own real horaire slots (see coachRequestSlotOptions/
  // allEventSlots -- the counter-propose form only ever offers those, a
  // Coach's own declared availability narrowing it further when set), not
  // free text, so the proposed time always lights up live and always
  // means something a rider could actually be on track for.
  function proposeCoachSlot(id, slotLabel) {
    var me = currentUserProfile;
    var r = (STATE.coachRequests || []).filter(function (x) { return x.id === id; })[0];
    if (!me || !r) return;
    var chosen = coachRequestSlotOptions(r, me.name).filter(function (s) { return s.label === slotLabel; })[0];
    if (!chosen) { showToast('Choisis un créneau valide.'); return; }
    var mySide = r.from === me.name ? 'from' : 'to';
    var otherSide = mySide === 'from' ? 'to' : 'from';
    db.collection('coachRequests').doc(id).update({
      slotLabel: chosen.label,
      slotStart: chosen.start,
      slotEnd: chosen.end,
      awaiting: otherSide
    }).then(function () {
      showToast('Nouvel horaire proposé.', 'success');
    }).catch(function (err) {
      showToast('Erreur : ' + (err && err.message ? err.message : err));
    });
  }
  // Coach <-> coaché messaging within one accepted coaching relationship
  // (requestId = that coachRequests doc's id) -- append-only, like
  // teamFeed/feedEvents, read by both parties (see firestore.rules'
  // isPartyToCoachRequest).
  function sendCoachMessage(requestId, text) {
    var me = currentUserProfile;
    text = (text || '').trim();
    if (!me || !text) return;
    db.collection('coachMessages').add({ requestId: requestId, from: me.name, text: text, createdAt: Date.now(), uid: myUid() }).catch(function (err) {
      showToast('Erreur : ' + (err && err.message ? err.message : err));
    });
  }
  // A Coach's own declared availability, per event -- users/{uid}.
  // coachAvailability = { [eventId]: [slotLabel, ...] }, freely self-
  // writable like any other non-badge profile field (see firestore.rules'
  // users update). Narrows coachRequestSlotOptions() for that Coach, and
  // (softly, see renderCoachSlotModal) who gets suggested for a given
  // slot in the first place.
  // byType: { coaching: [slotLabel, ...], bapteme: [slotLabel, ...] } for
  // this one event -- coaching and baptême get separate slot sets since a
  // Coach isn't necessarily free for both at the same times.
  function saveCoachAvailability(eventId, byType) {
    var uid = auth.currentUser && auth.currentUser.uid;
    if (!uid || !currentUserProfile) return;
    var av = Object.assign({}, currentUserProfile.coachAvailability || {});
    av[eventId] = byType;
    db.collection('users').doc(uid).set({ coachAvailability: av }, { merge: true }).then(function () {
      currentUserProfile.coachAvailability = av;
      renderRoot();
    }).catch(function (err) {
      showToast('Erreur : ' + (err && err.message ? err.message : err));
    });
  }
  // Gates the header's 🎓 icon (see renderRootUnsafe) -- open to any
  // signed-in account, not just an actual Coach or someone already in a
  // coaching/baptême relationship, so a pilote/accompagnant can see the
  // event's planning and ask for coaching without needing one first.
  function canAccessCoachSpace() {
    return !!currentUserProfile;
  }

  // ---- Teams ----
  //
  // A team of pilotes (an organisateur's squad, or friends who ride
  // together) -- one or more Team Leaders manage membership and post to
  // the team's feed; a plain member just reads. Doc ids are deterministic
  // (teamId_name) throughout, both for teamMembers and teamInvites, so
  // firestore.rules can check membership/invite state with a plain point
  // lookup instead of a query it can't express.
  function teamMemberDocId(teamId, name) { return teamId + '_' + (name || '').replace(/\//g, '_'); }
  function teamInviteDocId(teamId, name) { return teamMemberDocId(teamId, name); }

  // Unforgeable owner id for every name-bearing doc this account creates --
  // stored alongside the self-reported name field so a later rename can
  // prove ownership via uid (request.auth.uid in the rules, never the
  // name itself) instead of the name matching, which breaks the instant
  // the name changes. See migrateNameEverywhere.
  function myUid() { return auth.currentUser && auth.currentUser.uid; }
  function uidOf(name) { return (STATE.usersByName && STATE.usersByName[name] && STATE.usersByName[name].uid) || null; }

  function myRoleInTeam(teamId) {
    var found = (STATE.myTeamMemberships || []).filter(function (m) { return m.teamId === teamId; })[0];
    return found ? found.role : null;
  }
  function isLeaderOfTeam(teamId) { return myRoleInTeam(teamId) === 'leader'; }
  function membersOfTeam(teamId) { return (STATE.teamMembersByTeam || {})[teamId] || []; }
  function teamById(teamId) { return (STATE.teams || []).filter(function (t) { return t.id === teamId; })[0] || null; }

  // Every teamMembers doc with role 'leader', across every Team in the
  // app (not just this account's own -- see the global sync in
  // startSync()) -- crossed with STATE.teams (already globally synced
  // too, for Team discovery) to know which of those leaderships are of
  // a Team PRO specifically. Powers isProTeamLeaderName()/personNameHtml
  // below: a Team PRO's Team Leader stands out wherever their pseudo
  // shows up -- listings, wall posts, team feed, announcements.
  function isProTeamLeaderName(name) {
    return (STATE.allTeamLeaders || []).some(function (m) {
      return m.name === name && (teamById(m.teamId) || {}).teamPro;
    });
  }
  // Wraps a bare pseudo (not a clickable link -- see nameLinkHtml for
  // that) in the same bold-accent treatment when it belongs to a Team
  // PRO's own Team Leader. Every '<span class="friend-name-plain">' +
  // escapeHtml(personName) + '</span>' showing an actual person's name
  // (not a Team's) should go through this instead.
  // Orange takes priority over blue when someone happens to be both (a
  // Team PRO Team Leader who's also a Coach) -- one color per name keeps
  // this readable at a glance, two would just be noise.
  function nameColorClass(name) {
    if (isProTeamLeaderName(name)) return ' pro-leader-name';
    if (isCoachBadge((STATE.usersByName || {})[name])) return ' coach-name';
    return '';
  }
  function personNameHtml(name) {
    return '<span class="friend-name-plain' + nameColorClass(name) + '">' + escapeHtml(name) + '</span>';
  }

  // Every pilote (a real rider, per allKnownRiders()) in a team this
  // account leads -- name -> the id of the team that grants access to
  // them, so the chrono entry form (renderForm) can offer them alongside
  // the leader's own name, and onSubmit can tag which team justifies the
  // write (see ownsChronoViaTeam in firestore.rules).
  function myTeamPiloteChoices() {
    var me = currentUserProfile;
    var choices = {};
    if (!me) return choices;
    (STATE.myTeamMemberships || []).forEach(function (m) {
      if (m.role !== 'leader') return;
      membersOfTeam(m.teamId).forEach(function (tm) {
        if (tm.name !== me.name && allKnownRiders().indexOf(tm.name) !== -1) choices[tm.name] = m.teamId;
      });
    });
    return choices;
  }

  function createTeam(name, teamPro) {
    var me = currentUserProfile;
    name = (name || '').trim();
    if (!me || !name) return;
    var teamId = genId();
    var uid = auth.currentUser && auth.currentUser.uid;
    var doc = { id: teamId, name: name, createdBy: me.name, createdAt: Date.now(), memberCount: 1 };
    // Only actually takes effect for an Organisateur (see firestore.rules'
    // teams create rule) -- the checkbox itself is hidden for anyone else.
    if (teamPro && me.role === 'organisateur') doc.teamPro = true;
    db.collection('teams').doc(teamId).set(doc).then(function () {
      return db.collection('teamMembers').doc(teamMemberDocId(teamId, me.name)).set({ teamId: teamId, name: me.name, role: 'leader', joinedAt: Date.now(), uid: uid });
    }).then(function () {
      showToast('Team "' + name + '" créée.', 'success');
    }).catch(function (err) {
      showToast('Erreur : ' + (err && err.message ? err.message : err));
    });
  }

  function inviteToTeam(teamId, toName) {
    var me = currentUserProfile;
    var team = teamById(teamId);
    if (!me || !team || !toName) return;
    db.collection('teamInvites').doc(teamInviteDocId(teamId, toName)).set({
      teamId: teamId, teamName: team.name, from: me.name, to: toName, status: 'pending',
      fromUid: myUid(), toUid: uidOf(toName)
    }).then(function () {
      showToast('Invitation envoyée à ' + toName + '.', 'success');
    }).catch(function (err) {
      showToast('Erreur : ' + (err && err.message ? err.message : err));
    });
  }

  function acceptTeamInvite(invite) {
    var me = currentUserProfile;
    if (!me) return;
    db.collection('teamInvites').doc(invite.id).update({ status: 'accepted' }).then(function () {
      return db.collection('teamMembers').doc(teamMemberDocId(invite.teamId, me.name)).set({
        teamId: invite.teamId, name: me.name, role: 'member', joinedAt: Date.now(), uid: (auth.currentUser && auth.currentUser.uid)
      });
    }).then(function () {
      showToast('Bienvenue dans "' + ((teamById(invite.teamId) || {}).name || invite.teamName) + '".', 'success');
      bumpTeamMemberCount(invite.teamId, 1);
    }).catch(function (err) {
      showToast('Erreur : ' + (err && err.message ? err.message : err));
    });
  }

  function removeTeamInvite(id) {
    db.collection('teamInvites').doc(id).delete().catch(function (err) {
      showToast('Erreur : ' + (err && err.message ? err.message : err));
    });
  }

  // Display-only counter (see renderTeamTile) -- nudged by whoever's own
  // action changed it, not read-then-written, so concurrent joins/leaves
  // never race each other (increment() is a server-side atomic op).
  function bumpTeamMemberCount(teamId, delta) {
    db.collection('teams').doc(teamId).update({ memberCount: firebase.firestore.FieldValue.increment(delta) }).catch(function () {});
  }

  // A Team PRO (or any Team) left with zero Team Leaders is stuck -- no
  // one left with the isTeamLeader() rights to manage it, fix it, or hand
  // leadership back to anyone. UI-only guard (client-side, not enforced
  // in firestore.rules -- a leader count isn't something a security rule
  // can check without a denormalized counter), same spirit as this app's
  // other click-to-confirm safety rails.
  function wouldRemoveLastLeader(teamId, name) {
    var members = membersOfTeam(teamId);
    var target = members.filter(function (m) { return m.name === name; })[0];
    if (!target || target.role !== 'leader') return false;
    return members.filter(function (m) { return m.role === 'leader'; }).length <= 1;
  }

  // Same doc either way, whether a leader removes someone else or a
  // member removes themselves (leaving the team) -- see firestore.rules.
  function removeTeamMember(teamId, name) {
    if (wouldRemoveLastLeader(teamId, name)) {
      showToast('Impossible : ce Team doit toujours garder au moins un Team Leader.');
      return;
    }
    bumpTeamMemberCount(teamId, -1);
    db.collection('teamMembers').doc(teamMemberDocId(teamId, name)).delete().catch(function (err) {
      showToast('Erreur : ' + (err && err.message ? err.message : err));
    });
  }

  function setTeamMemberRole(teamId, name, role) {
    if (role !== 'leader' && wouldRemoveLastLeader(teamId, name)) {
      showToast('Impossible : ce Team doit toujours garder au moins un Team Leader.');
      return;
    }
    db.collection('teamMembers').doc(teamMemberDocId(teamId, name)).set({ role: role }, { merge: true }).catch(function (err) {
      showToast('Erreur : ' + (err && err.message ? err.message : err));
    });
  }

  function teamOpError(err) {
    showToast('Erreur : ' + (err && err.message ? err.message : err));
  }

  // Adherent status lives entirely on the follows doc (tier), whether or
  // not the person is also a teamMembers member -- one unified concept
  // per the brief's "octroyer ou retirer les droits de suivi, membre,
  // adhérent et team leader", not two parallel ones. A member asking
  // their own Team Leader to promote them to adherent just sets their own
  // adherentRequested (creating their own follows doc first if they
  // never followed); the leader alone can actually flip tier itself, see
  // decideTeamAdherentRequest / setTeamMemberStatus below.
  function requestTeamAdherent(teamId) {
    var me = currentUserProfile;
    if (!me) return;
    var existing = (STATE.myTeamFollowDocs || {})[teamId];
    var id = existing ? existing.id : teamMemberDocId(teamId, me.name);
    db.collection('follows').doc(id).set({
      follower: me.name, followee: teamId, followeeType: 'team', adherentRequested: true
    }, { merge: true }).then(function () {
      showToast('Demande d\'adhésion envoyée.', 'success');
    }).catch(teamOpError);
  }
  // Leader-only in practice (firestore.rules' follows update rule) --
  // accept sets tier 'adherent' and clears the request; decline just
  // clears it. followId is the requester's own follows doc (it must
  // exist for a request to have been made at all).
  function decideTeamAdherentRequest(followId, accept) {
    db.collection('follows').doc(followId).update({
      adherentRequested: false, tier: accept ? 'adherent' : 'follower'
    }).catch(teamOpError);
  }

  // The unified member-management panel's one entry point (see
  // renderTeamMembersManagement) -- statusKey is 'follow' | 'member' |
  // 'adherent' | 'leader', independently toggled per the brief. Granting
  // 'adherent' or 'leader' to someone with no existing follows/teamMembers
  // doc yet creates it first (as plain follower/member) since
  // firestore.rules never lets either be created with an elevated status
  // directly -- only promoted to one via a separate update, same
  // create-then-elevate shape as everywhere else trust badges work here.
  function setTeamMemberStatus(teamId, followDoc, memberDoc, name, statusKey, on) {
    if (statusKey === 'follow') {
      if (on) {
        var newId = followDoc ? followDoc.id : teamMemberDocId(teamId, name);
        db.collection('follows').doc(newId).set({ follower: name, followee: teamId, followeeType: 'team' }, { merge: true }).catch(teamOpError);
      } else if (followDoc) {
        db.collection('follows').doc(followDoc.id).delete().catch(teamOpError);
      }
      return;
    }
    if (statusKey === 'adherent') {
      var fid = followDoc ? followDoc.id : teamMemberDocId(teamId, name);
      var fref = db.collection('follows').doc(fid);
      var ensure = followDoc ? Promise.resolve() : fref.set({ follower: name, followee: teamId, followeeType: 'team' });
      ensure.then(function () {
        return fref.update({ tier: on ? 'adherent' : 'follower', adherentRequested: false });
      }).catch(teamOpError);
      return;
    }
    var targetUid = (STATE.usersByName && STATE.usersByName[name] && STATE.usersByName[name].uid) || null;
    if (statusKey === 'member') {
      if (on) {
        db.collection('teamMembers').doc(teamMemberDocId(teamId, name)).set({ teamId: teamId, name: name, role: 'member', joinedAt: Date.now(), uid: targetUid }, { merge: true })
          .then(function () { bumpTeamMemberCount(teamId, 1); }).catch(teamOpError);
      } else {
        removeTeamMember(teamId, name);
      }
      return;
    }
    if (statusKey === 'leader') {
      if (on && !memberDoc) {
        db.collection('teamMembers').doc(teamMemberDocId(teamId, name)).set({ teamId: teamId, name: name, role: 'leader', joinedAt: Date.now(), uid: targetUid }, { merge: true })
          .then(function () { bumpTeamMemberCount(teamId, 1); }).catch(teamOpError);
      } else {
        setTeamMemberRole(teamId, name, on ? 'leader' : 'member');
      }
    }
  }
  // Free-form in-team tag a Team Leader can hang on any member -- mécano,
  // assistant, photographe, etc. (see the brief) -- entirely separate
  // from role (leader/member) and adherent, just a label.
  function setTeamMemberTeamRole(teamId, name, teamRole) {
    db.collection('teamMembers').doc(teamMemberDocId(teamId, name)).update({ teamRole: (teamRole || '').trim() || null }).catch(teamOpError);
  }

  // A non-member asking to join a Team as a plain member -- adherent is
  // never requested directly, only granted afterwards by a Team Leader
  // (see decideTeamAdherentRequest and the unified member-management
  // panel, renderTeamMembersManagement). The leader accepts by creating
  // the teamMembers doc themselves (see acceptTeamJoinRequest);
  // teamJoinRequests itself never gets an "accepted" status, only
  // created then deleted either way. kind is kept on the doc for
  // forward-compatibility with older requests already in flight.
  function requestJoinTeam(teamId) {
    var me = currentUserProfile;
    var team = teamById(teamId);
    if (!me || !team) return;
    db.collection('teamJoinRequests').doc(teamMemberDocId(teamId, me.name)).set({
      teamId: teamId, teamName: team.name, from: me.name, kind: 'member', status: 'pending', uid: myUid()
    }).then(function () {
      showToast('Demande envoyée à ' + team.name + '.', 'success');
    }).catch(function (err) {
      showToast('Erreur : ' + (err && err.message ? err.message : err));
    });
  }
  // The leader chooses the resulting status right on accept -- 'member',
  // 'adherent' or 'leader' -- reusing the same unified setTeamMemberStatus
  // entry point the member-management panel's pills use, so the same
  // firestore.rules permissions (isTeamLeader can create/promote
  // teamMembers and follows docs for anyone) already cover it.
  function acceptTeamJoinRequestAs(req, statusKey) {
    var memberDoc = ((STATE.teamMembersByTeam || {})[req.teamId] || []).filter(function (m) { return m.name === req.from; })[0] || null;
    var followDoc = ((STATE.teamFollowersByTeam || {})[req.teamId] || []).filter(function (f) { return f.follower === req.from; })[0] || null;
    setTeamMemberStatus(req.teamId, followDoc, memberDoc, req.from, statusKey, true);
    db.collection('teamJoinRequests').doc(req.id).delete().then(function () {
      showToast(req.from + ' a rejoint ' + ((teamById(req.teamId) || {}).name || req.teamName) + '.', 'success');
    }).catch(teamOpError);
  }
  // Same delete either way -- declining a request received or cancelling
  // one sent.
  function removeTeamJoinRequest(id) {
    db.collection('teamJoinRequests').doc(id).delete().catch(function (err) {
      showToast('Erreur : ' + (err && err.message ? err.message : err));
    });
  }

  // A plain like, no request/accept -- see firestore.rules' teamLikes.
  function toggleTeamLike(teamId) {
    var me = currentUserProfile;
    if (!me) return;
    var id = teamMemberDocId(teamId, me.name);
    var already = (STATE.teamLikes || []).some(function (l) { return l.teamId === teamId && l.name === me.name; });
    var op = already
      ? db.collection('teamLikes').doc(id).delete()
      : db.collection('teamLikes').doc(id).set({ teamId: teamId, name: me.name, uid: myUid() });
    op.catch(function (err) {
      showToast('Erreur : ' + (err && err.message ? err.message : err));
    });
  }

  // text/linkUrl/photoURL post, or a poll (postTeamPoll below) -- both are
  // just teamFeed docs, gated by the same firestore.rules create rule
  // (leader always, or any member when the team's postPolicy is 'members').
  function postTeamFeedMessage(teamId, text, linkUrl, photoURL, audience) {
    var me = currentUserProfile;
    text = (text || '').trim();
    linkUrl = (linkUrl || '').trim();
    if (!me) return;
    if (!text && !linkUrl && !photoURL) return;
    var post = { id: genId(), teamId: teamId, author: me.name, authorUid: myUid(), createdAt: Date.now() };
    if (text) post.text = text;
    if (linkUrl) post.linkUrl = linkUrl;
    if (photoURL) post.photoURL = photoURL;
    if (audience === 'adherents') post.audience = 'adherents';
    db.collection('teamFeed').doc(post.id).set(post).catch(function (err) {
      showToast('Erreur : ' + (err && err.message ? err.message : err));
    });
  }

  function postTeamPoll(teamId, question, options, audience) {
    var me = currentUserProfile;
    question = (question || '').trim();
    options = (options || []).map(function (o) { return o.trim(); }).filter(Boolean);
    if (!me || !question || options.length < 2) {
      showToast('Une question et au moins 2 options sont nécessaires pour un sondage.');
      return;
    }
    var post = { id: genId(), teamId: teamId, author: me.name, authorUid: myUid(), type: 'poll', question: question, options: options, votes: {}, createdAt: Date.now() };
    if (audience === 'adherents') post.audience = 'adherents';
    db.collection('teamFeed').doc(post.id).set(post).catch(function (err) {
      showToast('Erreur : ' + (err && err.message ? err.message : err));
    });
  }

  function voteTeamPoll(postId, optionIndex) {
    var me = currentUserProfile;
    if (!me) return;
    var update = {};
    update['votes.' + me.name] = optionIndex;
    db.collection('teamFeed').doc(postId).update(update).catch(function (err) {
      showToast('Erreur : ' + (err && err.message ? err.message : err));
    });
  }

  // Clicking the same emoji again removes it (FieldValue.delete on that
  // one key) -- otherwise it just overwrites whatever reaction this
  // account already had on the post, one per person.
  function toggleReaction(collectionName, id, emoji, currentReactions) {
    var me = currentUserProfile;
    if (!me) return;
    var already = (currentReactions || {})[me.name] === emoji;
    var update = {};
    update['reactions.' + me.name] = already ? firebase.firestore.FieldValue.delete() : emoji;
    db.collection(collectionName).doc(id).update(update).catch(function (err) {
      showToast('Erreur : ' + (err && err.message ? err.message : err));
    });
  }

  function setTeamPostPolicy(teamId, policy) {
    db.collection('teams').doc(teamId).set({ postPolicy: policy }, { merge: true }).catch(function (err) {
      showToast('Erreur : ' + (err && err.message ? err.message : err));
    });
  }

  function setTeamVisibility(teamId, visibility) {
    db.collection('teams').doc(teamId).set({ visibility: visibility }, { merge: true }).catch(function (err) {
      showToast('Erreur : ' + (err && err.message ? err.message : err));
    });
  }

  function saveTeamDescription(teamId, text) {
    db.collection('teams').doc(teamId).set({ description: (text || '').trim() || null }, { merge: true }).then(function () {
      showToast('Présentation enregistrée.', 'success');
    }).catch(function (err) {
      showToast('Erreur : ' + (err && err.message ? err.message : err));
    });
  }
  // Same base64-data-URL-on-the-doc approach as savePhoto (users) -- no
  // Firebase Storage setup, resized client-side first.
  function saveTeamPhoto(teamId, dataUrl) {
    db.collection('teams').doc(teamId).set({ photoURL: dataUrl || null }, { merge: true }).catch(function (err) {
      showToast('Erreur : ' + (err && err.message ? err.message : err));
    });
  }
  // A wide logo (e.g. "Mototeam95" text-and-mark) would get chopped to an
  // unreadable sliver by the round badge crop -- kept as its own field,
  // shown full-width, uncropped, on the Team's own profile.
  function saveTeamLogo(teamId, dataUrl) {
    db.collection('teams').doc(teamId).set({ logoURL: dataUrl || null }, { merge: true }).catch(function (err) {
      showToast('Erreur : ' + (err && err.message ? err.message : err));
    });
  }
  // "Site internet / boutique / photographe..." -- one link per line as
  // "Nom | URL", parsed into {label, url} objects. A free-form textarea
  // rather than an add/remove-row widget, consistent with how riders/
  // horaires are typed elsewhere in this app.
  // "Nos partenaires de Carnet de Piste" -- one shared doc
  // (settings/partners), admin-only (Xavier), shown in Profil > Aide >
  // À propos. Not to be confused with a Team's own Partenaires (see
  // renderTeamPartnersSection below) -- that one's per-Team, set by that
  // Team's own Leader, a completely separate list.
  function savePartners(raw) {
    var list = (raw || '').split('\n').map(function (line) { return line.trim(); }).filter(Boolean).map(function (line) {
      var parts = line.split('|');
      var url = parts.length > 1 ? parts.slice(1).join('|').trim() : '';
      var name = parts.length > 1 ? parts[0].trim() : parts[0].trim();
      return { name: name, url: url };
    }).filter(function (p) { return p.name; });
    db.collection('settings').doc('partners').set({ list: list }, { merge: true }).then(function () {
      showToast('Partenaires enregistrés.', 'success');
    }).catch(function (err) {
      showToast('Erreur : ' + (err && err.message ? err.message : err));
    });
  }
  function renderPartnersSection() {
    var partners = STATE.partners || [];
    var body;
    if (!partners.length && !isAdmin()) return '';
    if (!partners.length) {
      body = '<div class="empty-state">Aucun partenaire pour l\'instant.</div>';
    } else {
      body = '<div class="team-links-row">' + partners.map(function (p) {
        return p.url
          ? '<a class="team-link-chip" href="' + escapeHtml(p.url) + '" target="_blank" rel="noopener">' + escapeHtml(p.name) + '</a>'
          : '<span class="team-link-chip">' + escapeHtml(p.name) + '</span>';
      }).join('') + '</div>';
    }
    if (isAdmin()) {
      body += '<form id="partners-form" style="margin-top:0.8rem;">' +
        '<label for="partners-input">Un par ligne : Nom | URL (URL optionnelle)</label>' +
        '<textarea id="partners-input" rows="3" placeholder="Mototeam95 | https://...\nAccimoto\nDepamoto | https://...">' +
        escapeHtml(partners.map(function (p) { return p.url ? p.name + ' | ' + p.url : p.name; }).join('\n')) + '</textarea>' +
        '<button type="submit" class="primary" style="margin-top:0.6rem;">Enregistrer</button></form>';
    }
    return '<div style="margin-top:1.2rem; border-top:1px solid var(--border); padding-top:0.9rem;">' +
      '<div class="section-title" style="font-size:0.95rem;">Nos partenaires de Carnet de Piste</div>' + body + '</div>';
  }

  // A Team's OWN partenaires -- set by that Team's Leader (garage,
  // concessionnaire, sponsor...), own list per Team on the team doc
  // itself (a Team Leader can already write any field there but teamPro,
  // see firestore.rules' teams update) -- unrelated to the app-wide list
  // above. Same collapsibleSection style as "Followers" right above it in
  // renderTeamCard, and the same "Nom | URL" free-text convention as
  // saveTeamLinks/savePartners.
  function saveTeamPartners(teamId, raw) {
    var list = (raw || '').split('\n').map(function (line) { return line.trim(); }).filter(Boolean).map(function (line) {
      var parts = line.split('|');
      var url = parts.length > 1 ? parts.slice(1).join('|').trim() : '';
      var name = parts[0].trim();
      return { name: name, url: url };
    }).filter(function (p) { return p.name; });
    db.collection('teams').doc(teamId).set({ partners: list }, { merge: true }).then(function () {
      showToast('Partenaires enregistrés.', 'success');
    }).catch(function (err) {
      showToast('Erreur : ' + (err && err.message ? err.message : err));
    });
  }
  function renderTeamPartnersSection(team, isLeader) {
    var partners = team.partners || [];
    var body;
    if (!partners.length && !isLeader) return '';
    if (!partners.length) {
      body = '<div class="empty-state">Aucun partenaire pour l\'instant.</div>';
    } else {
      body = '<div class="team-links-row">' + partners.map(function (p) {
        return p.url
          ? '<a class="team-link-chip" href="' + escapeHtml(p.url) + '" target="_blank" rel="noopener">' + escapeHtml(p.name) + '</a>'
          : '<span class="team-link-chip">' + escapeHtml(p.name) + '</span>';
      }).join('') + '</div>';
    }
    if (isLeader) {
      body += '<form data-action="team-partners-form" data-team="' + team.id + '" style="margin-top:0.8rem;">' +
        '<label for="team-partners-' + team.id + '">Un par ligne : Nom | URL (URL optionnelle)</label>' +
        '<textarea id="team-partners-' + team.id + '" data-team-partners-input rows="3" placeholder="Concession Motos X | https://...\nGarage Y">' +
        escapeHtml(partners.map(function (p) { return p.url ? p.name + ' | ' + p.url : p.name; }).join('\n')) + '</textarea>' +
        '<button type="submit" class="primary" style="margin-top:0.6rem;">Enregistrer</button></form>';
    }
    return collapsibleSection('team-partners-' + team.id, 'Partenaires', body, false);
  }
  function saveTeamLinks(teamId, raw) {
    var links = (raw || '').split('\n').map(function (line) { return line.trim(); }).filter(Boolean).map(function (line) {
      var parts = line.split('|');
      var url = (parts.length > 1 ? parts.slice(1).join('|') : parts[0]).trim();
      var label = parts.length > 1 ? parts[0].trim() : url;
      return { label: label, url: url };
    }).filter(function (l) { return l.url; });
    db.collection('teams').doc(teamId).set({ links: links }, { merge: true }).catch(function (err) {
      showToast('Erreur : ' + (err && err.message ? err.message : err));
    });
  }

  // ---- Recadrage de photo (badge rond / logo large) ----
  //
  // A round badge (mini-avatar) otherwise always crops to dead-center,
  // fine for a portrait but chops the sides off a wide team photo/logo
  // (or hides "95" off the edge of "Mototeam95"). This lets whoever's
  // uploading pick the framing: zoom (down to well below "fits the
  // frame", so the whole image can float small inside it with empty
  // space around, or in a lot) and pan, both in real pixels against a
  // known viewport size rather than CSS object-fit, since object-fit:
  // cover can never zoom out past "fill the frame". Shared by the Team
  // photo (badge), the account's own profile photo, and the Team's wide
  // logo (kind 'team'|'user'|'logo') -- 'logo' just uses a wide
  // rectangular viewport/output instead of a square one, matching how
  // .team-logo-img is displayed full-width with a capped height.
  var CROP_VIEWPORT = 220; // round crop (user/team badge), square
  var CROP_LOGO_W = 320; // wide crop (team logo), rectangular
  var CROP_LOGO_H = 90;
  var cropModalOpen = false;
  var cropModalKind = null; // 'team' | 'user' | 'logo'
  var cropModalTeamId = null; // only used for kind 'team'/'logo'
  var cropModalSrc = null; // full-res data URL of the just-picked file
  var cropNaturalW = 0;
  var cropNaturalH = 0;
  var cropZoom = 100; // % of "contain" (whole image just fits the frame) -- 20..400
  var cropOffsetXPx = 0;
  var cropOffsetYPx = 0;
  function cropViewportSize() {
    return cropModalKind === 'logo' ? { w: CROP_LOGO_W, h: CROP_LOGO_H } : { w: CROP_VIEWPORT, h: CROP_VIEWPORT };
  }

  // Quick onboarding tour, one step per main onglet -- opens once by
  // itself the first time a freshly signed-in account's own profile
  // hasn't got tutorialSeen set (persisted server-side, see
  // closeTutorial, so it's "seen once" across every device, not just
  // this browser), and any time after that from the Aide button in
  // Profil -> Réglages (see renderProfileReglagesTab).
  var tutorialOpen = false;
  var tutorialStep = 0;
  var TUTORIAL_STEPS = [
    { icon: '🏍️', title: 'Bienvenue sur Carnet de Piste', body: 'Un tour rapide de ce que chaque onglet t\'apporte -- tu peux le refaire à tout moment depuis Profil → Réglages → Aide.' },
    { icon: '📅', title: 'Événements', body: 'Le calendrier de tes sorties : crée-en une, consulte les prochaines/passées, rejoins un event partagé par un Team.' },
    { icon: '⏱️', title: 'Chronos', body: 'Choisis un circuit, enregistre tes temps au tour sortie par sortie, suis ton meilleur temps et ta progression.' },
    { icon: '🏍️', title: 'EN PISTE', body: 'Le jour J : horaires par groupe, ton groupe du jour, infos pratiques et annonces du Team organisateur, ta checklist d\'équipement, tes infos de voyage.' },
    { icon: '👥', title: 'Social', body: 'Suis tes amis, réagis à leur Journal et au fil d\'actualité des Teams que tu suis, retrouve ton propre Journal.' },
    { icon: '🤝', title: 'Team', body: 'Rejoins ou gère un Team (amateur ou PRO) : membres, fil d\'actualité, gestion des événements.' },
    { icon: '📊', title: 'Stats & 🔔 Notifications', body: 'En haut à droite : tes statistiques et trophées (📊), et tes demandes en attente (🔔) -- amis, invitations Team, coaching.' }
  ];
  function openTutorial() {
    tutorialOpen = true;
    tutorialStep = 0;
    renderRoot();
  }
  // markSeen: false when just dismissed mid-way (e.g. clicking outside
  // isn't offered, only the explicit Passer/Fermer) -- both Passer and
  // finishing the last step count as "seen", same outcome either way,
  // it's the account's own choice not to see it that matters here, not
  // whether they read every single step.
  function closeTutorial() {
    tutorialOpen = false;
    if (currentUserProfile && !currentUserProfile.tutorialSeen) {
      currentUserProfile.tutorialSeen = true;
      var uid = myUid();
      if (uid) db.collection('users').doc(uid).set({ tutorialSeen: true }, { merge: true }).catch(function () {});
    }
    renderRoot();
  }
  function tutorialGo(delta) {
    tutorialStep = Math.max(0, Math.min(TUTORIAL_STEPS.length - 1, tutorialStep + delta));
    renderRoot();
  }
  function renderTutorialOverlay() {
    if (!tutorialOpen) return '';
    var step = TUTORIAL_STEPS[tutorialStep];
    var isLast = tutorialStep === TUTORIAL_STEPS.length - 1;
    var html = '<div class="crop-modal-overlay">' +
      '<div class="crop-modal tutorial-modal">' +
      '<div class="tutorial-icon">' + step.icon + '</div>' +
      '<h2 class="section-title">' + escapeHtml(step.title) + '</h2>' +
      '<div class="help-text">' + escapeHtml(step.body) + '</div>' +
      '<div class="tutorial-dots">' + TUTORIAL_STEPS.map(function (_, i) {
        return '<span class="tutorial-dot' + (i === tutorialStep ? ' active' : '') + '"></span>';
      }).join('') + '</div>' +
      '<div style="margin-top:0.9rem; display:flex; gap:0.6rem; justify-content:space-between;">' +
      '<button type="button" class="ghost" id="tutorial-skip-btn">' + (isLast ? 'Fermer' : 'Passer') + '</button>' +
      '<div style="display:flex; gap:0.6rem;">' +
      (tutorialStep > 0 ? '<button type="button" class="ghost" id="tutorial-prev-btn">← Précédent</button>' : '') +
      (isLast ? '<button type="button" class="primary" id="tutorial-finish-btn">Terminé</button>' : '<button type="button" class="primary" id="tutorial-next-btn">Suivant →</button>') +
      '</div></div></div></div>';
    return html;
  }

  // ---- Ressenti à chaud (opt-in, voir Réglages) ----
  //
  // Deliberately not another required field on the chrono form itself --
  // "peut-être que les users auront la flemme" means this has to cost
  // literally one tap or nothing at all, offered right after a chrono a
  // rider just entered for themselves (never for someone else's, see
  // onSubmit) rather than asked for up front.
  var FEELING_OPTIONS = [
    { key: 'top', icon: '🔥', label: 'Top' },
    { key: 'bien', icon: '😊', label: 'Bien' },
    { key: 'moyen', icon: '😐', label: 'Moyen' },
    { key: 'fatigue', icon: '😓', label: 'Fatigué' },
    { key: 'nul', icon: '👎', label: 'Nul' }
  ];
  var feelingModalSessionId = null;
  function openFeelingModal(sessionId) {
    feelingModalSessionId = sessionId;
    renderRoot();
  }
  function closeFeelingModal() {
    feelingModalSessionId = null;
    renderRoot();
  }
  function saveSessionFeeling(sessionId, feeling, comment) {
    comment = (comment || '').trim();
    var session = (STATE.sessions || []).filter(function (s) { return s.id === sessionId; })[0];
    if (session) { session.feeling = feeling; session.feelingComment = comment || null; }
    closeFeelingModal();
    db.collection('sessions').doc(sessionId).update({ feeling: feeling, feelingComment: comment || null }).catch(function (err) {
      showToast('Erreur : ' + (err && err.message ? err.message : err));
    });
  }
  function renderFeelingModal() {
    if (!feelingModalSessionId) return '';
    return '<div class="crop-modal-overlay">' +
      '<div class="crop-modal feeling-modal">' +
      '<h2 class="section-title">Comment s\'est passée la session ?</h2>' +
      '<div class="feeling-options">' + FEELING_OPTIONS.map(function (f) {
        return '<button type="button" class="feeling-option-btn" data-action="feeling-pick" data-feeling="' + f.key + '">' +
          '<span class="feeling-option-icon">' + f.icon + '</span><span class="feeling-option-label">' + escapeHtml(f.label) + '</span></button>';
      }).join('') + '</div>' +
      '<label for="feeling-comment-input" style="margin-top:0.7rem; display:block;">Commentaire (optionnel)</label>' +
      '<input type="text" id="feeling-comment-input" placeholder="Ex. bonnes sensations en freinage">' +
      '<button type="button" class="ghost" id="feeling-skip-btn" style="margin-top:0.8rem;">Passer</button>' +
      '</div></div>';
  }

  function openCropModal(kind, teamId, dataUrl) {
    var probe = new Image();
    probe.onload = function () {
      cropModalOpen = true;
      cropModalKind = kind;
      cropModalTeamId = teamId;
      cropModalSrc = dataUrl;
      cropNaturalW = probe.naturalWidth;
      cropNaturalH = probe.naturalHeight;
      cropZoom = 100;
      cropOffsetXPx = 0;
      cropOffsetYPx = 0;
      renderRoot();
    };
    probe.onerror = function () { showToast('Impossible de lire cette image.'); };
    probe.src = dataUrl;
  }
  function closeCropModal() {
    cropModalOpen = false;
    cropModalKind = null;
    cropModalTeamId = null;
    cropModalSrc = null;
    renderRoot();
  }
  // The image's on-screen size at the current zoom -- "contain" (whole
  // image visible) at zoom=100, smaller below that, larger above.
  function cropDisplaySize() {
    var vp = cropViewportSize();
    var s = Math.min(vp.w / cropNaturalW, vp.h / cropNaturalH) * (cropZoom / 100);
    return { w: cropNaturalW * s, h: cropNaturalH * s };
  }
  function cropImgTransform() {
    var size = cropDisplaySize();
    return 'width:' + size.w + 'px; height:' + size.h + 'px; ' +
      'transform: translate(calc(-50% + ' + cropOffsetXPx + 'px), calc(-50% + ' + cropOffsetYPx + 'px));';
  }
  function renderCropModal() {
    if (!cropModalOpen || !cropModalSrc) return '';
    var isLogo = cropModalKind === 'logo';
    var vp = cropViewportSize();
    var helpText = isLogo
      ? 'Comme il apparaîtra en pleine largeur -- fais glisser l\'image (doigt ou souris), pince ou utilise la molette pour zoomer, ou passe par les curseurs.'
      : 'Comme elle apparaîtra en badge rond -- fais glisser l\'image (doigt ou souris), pince ou utilise la molette pour zoomer, ou passe par les curseurs. Dézoome autant que tu veux, l\'image peut rester petite dans le cercle.';
    return '<div class="crop-modal-overlay">' +
      '<div class="crop-modal">' +
      '<h2 class="section-title">' + (isLogo ? 'Recadrer le logo' : 'Recadrer la photo') + '</h2>' +
      '<div class="help-text">' + helpText + '</div>' +
      '<div class="crop-modal-viewport' + (isLogo ? ' crop-modal-viewport-rect' : '') + '" id="crop-modal-viewport" style="width:' + vp.w + 'px; height:' + vp.h + 'px;">' +
      '<img id="crop-modal-img" src="' + escapeHtml(cropModalSrc) + '" style="' + cropImgTransform() + '"></div>' +
      '<label style="margin-top:0.8rem; display:block;">Zoom<input type="range" id="crop-zoom" min="20" max="400" step="5" value="' + cropZoom + '"></label>' +
      '<label style="margin-top:0.5rem; display:block;">Horizontal<input type="range" id="crop-offset-x" min="-400" max="400" value="' + cropOffsetXPx + '"></label>' +
      '<label style="margin-top:0.5rem; display:block;">Vertical<input type="range" id="crop-offset-y" min="-400" max="400" value="' + cropOffsetYPx + '"></label>' +
      '<div style="margin-top:0.8rem; display:flex; gap:0.6rem;">' +
      '<button type="button" class="primary" id="crop-save-btn">Enregistrer</button>' +
      '<button type="button" class="ghost" id="crop-cancel-btn">Annuler</button>' +
      '</div></div></div>';
  }
  function saveCroppedPhoto() {
    if (!cropModalKind || !cropModalSrc) return;
    var kind = cropModalKind, teamId = cropModalTeamId;
    var vp = cropViewportSize();
    var img = new Image();
    img.onload = function () {
      // The wide logo output used to be a 1280px PNG -- fine for a flat
      // graphic, but a photographic logo pushed the whole teams/{id} doc
      // past Firestore's 1MB field limit. JPEG compresses that kind of
      // content far better, so logo uses it (filling any zoomed-out
      // margin with a neutral background first, since JPEG can't stay
      // transparent there); the round badge/avatar stays PNG+transparent
      // since it's small either way and needs to show the surface
      // through when zoomed out.
      var isLogo = kind === 'logo';
      var OUT_W = isLogo ? 1000 : 400;
      var OUT_H = isLogo ? Math.round(OUT_W * vp.h / vp.w) : 400;
      var k = OUT_W / vp.w;
      var size = cropDisplaySize();
      var outW = size.w * k, outH = size.h * k;
      var outX = (vp.w / 2 + cropOffsetXPx - size.w / 2) * k;
      var outY = (vp.h / 2 + cropOffsetYPx - size.h / 2) * k;
      var canvas = document.createElement('canvas');
      canvas.width = OUT_W;
      canvas.height = OUT_H;
      var ctx = canvas.getContext('2d');
      if (isLogo) {
        ctx.fillStyle = '#f2f2f2';
        ctx.fillRect(0, 0, OUT_W, OUT_H);
      }
      ctx.drawImage(img, 0, 0, img.naturalWidth, img.naturalHeight, outX, outY, outW, outH);
      var dataUrl = isLogo ? canvas.toDataURL('image/jpeg', 0.85) : canvas.toDataURL('image/png');
      if (dataUrl.length > 700000) {
        showToast('Cette image reste trop volumineuse même compressée -- réessaie avec une image moins chargée en détails.');
        return;
      }
      if (kind === 'team') saveTeamPhoto(teamId, dataUrl);
      else if (kind === 'logo') saveTeamLogo(teamId, dataUrl);
      else savePhoto(dataUrl);
      closeCropModal();
    };
    img.src = cropModalSrc;
  }

  // Deleting a Team (amateur or PRO) requires the same fresh
  // reauthentication as deleting one's own account -- a leader typing
  // their password again is the one confirmation step that can't be
  // fat-fingered the way a second click can.
  // Which team's full detail is open below the tile grid (see
  // renderTeamTile/renderTeamTab) -- one at a time, so the tab stays
  // uncluttered.
  var expandedTeamId = null;
  var pendingDeleteTeamId = null;
  var teamDeleteMessage = '';
  // Which event, if any, is open in its own dedicated management screen
  // (see renderEventManagementScreen) -- a full takeover of the Team tab's
  // body, not one more nested collapsible among others: managing an
  // event (résumé, annonces, participants, demandes, groupes) is its own
  // big chunk of work, mainly done from a Team PRO's desktop, and burying
  // it three <details> deep is what made "Groupes de départ" hard to
  // tell apart from "Modifier l'événement".
  var managingEventId = null;
  function deleteTeam(teamId, currentPassword) {
    var user = auth.currentUser;
    if (!user) return;
    if (!currentPassword) {
      teamDeleteMessage = 'Indique ton mot de passe actuel pour confirmer.';
      renderRoot();
      return;
    }
    var cred = firebase.auth.EmailAuthProvider.credential(user.email, currentPassword);
    user.reauthenticateWithCredential(cred).then(function () {
      return db.collection('teams').doc(teamId).delete();
    }).then(function () {
      pendingDeleteTeamId = null;
      teamDeleteMessage = '';
      showToast('Team supprimé.', 'success');
      renderRoot();
    }).catch(function (err) {
      teamDeleteMessage = translateAuthError(err);
      renderRoot();
    });
  }

  function toggleTeamPro(teamId) {
    var team = teamById(teamId);
    if (!team) return;
    db.collection('teams').doc(teamId).set({ teamPro: !team.teamPro }, { merge: true }).catch(function (err) {
      showToast('Erreur : ' + (err && err.message ? err.message : err));
    });
  }

  // Parrainage (referral): whoever's name is in a ?ref= link that brought
  // someone to signup becomes their parrain, written onto the new
  // account once at signup (see onSignupSubmit). Captured once at load,
  // before the auth screen even renders, and the query string is then
  // dropped from the address bar so it doesn't linger through reloads.
  var pendingReferrer = null;
  (function captureReferrer() {
    try {
      var params = new URLSearchParams(window.location.search);
      var ref = params.get('ref');
      if (ref) {
        pendingReferrer = ref;
        params.delete('ref');
        var qs = params.toString();
        var newUrl = window.location.pathname + (qs ? '?' + qs : '') + window.location.hash;
        window.history.replaceState(null, '', newUrl);
      }
    } catch (e) { /* URLSearchParams/history unsupported -- just skip parrainage silently */ }
  })();

  // The one administrator (Xavier) can delete anything; everyone else can
  // still add/edit collaboratively (chronos, sorties, groupes, équipement)
  // but not remove a rider, a sortie, someone else's chrono, or a whole
  // checklist category -- see isAdmin()'s call sites. Matching Firestore
  // rules (riders/events delete, and sessions delete for someone else's
  // chrono) enforce this server-side too; checklist-category/item removal
  // is only hidden client-side (Firestore can't easily tell "this update
  // removed a nested item" from "added one").
  var ADMIN_EMAIL = 'germainxav@gmail.com';
  function isAdmin() {
    return !!(currentUserProfile && currentUserProfile.email &&
      currentUserProfile.email.toLowerCase() === ADMIN_EMAIL.toLowerCase());
  }

  function genId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function formatTime(seconds) {
    var m = Math.floor(seconds / 60);
    var rem = seconds - m * 60;
    var remStr = rem.toFixed(3);
    if (rem < 10) remStr = '0' + remStr;
    return m + ':' + remStr;
  }

  // Rounded-to-the-second version for places that just need a rough sense
  // of scale (the progression chart's y-axis) rather than the exact time.
  function formatTimeShort(seconds) {
    var m = Math.floor(seconds / 60);
    var rem = Math.round(seconds - m * 60);
    if (rem === 60) { rem = 0; m += 1; }
    var remStr = rem < 10 ? '0' + rem : '' + rem;
    return m + ':' + remStr;
  }

  // Seconds.milliseconds only, no minute -- for labels right next to a
  // point on the progression chart, where the y-axis alongside it already
  // establishes the minute, so repeating it on every point is just noise.
  function formatSecondsOnly(seconds) {
    var m = Math.floor(seconds / 60);
    var rem = seconds - m * 60;
    var remStr = rem.toFixed(3);
    if (rem < 10) remStr = '0' + remStr;
    return remStr;
  }

  function parseTime(raw) {
    var str = String(raw).trim();
    if (!str) return null;
    var m = str.match(/^(\d+):(\d{1,2}(?:\.\d+)?)$/);
    if (m) {
      var min = parseInt(m[1], 10);
      var sec = parseFloat(m[2]);
      if (sec >= 60) return null;
      return min * 60 + sec;
    }
    m = str.match(/^(\d+(?:\.\d+)?)$/);
    if (m) {
      var v = parseFloat(m[1]);
      if (v <= 0 || v > 1200) return null;
      return v;
    }
    return null;
  }

  // Builds a M:SS.mmm string from whatever digits are in `text`, filling
  // right-to-left like a stopwatch/currency input -- the last 3 digits
  // typed are always milliseconds, the 2 before that seconds, everything
  // else minutes. So typing "1", "54", "104" in sequence (no punctuation
  // at all) lands on "1:54.104" on its own.
  function maskChronoLine(text) {
    var digits = text.replace(/\D/g, '').slice(-7);
    if (!digits) return '';
    var ms = digits.slice(-3);
    var rest = digits.slice(0, -3);
    var sec = rest.slice(-2);
    var min = rest.slice(0, -2);
    return (min || '0') + ':' + sec.padStart(2, '0') + '.' + ms;
  }

  // Wires that masking onto the Chronos textarea, live as the rider types
  // -- only for actual keystrokes (inputType 'insertText'), never for a
  // paste/drop of already-formatted times, and only on lines with no comma
  // (a comma-separated multi-time line is left as typed).
  var lastLapsInputType = null;
  function attachLapsAutoFormat(textarea) {
    textarea.addEventListener('beforeinput', function (e) { lastLapsInputType = e.inputType; });
    textarea.addEventListener('input', function () {
      if (lastLapsInputType !== 'insertText') return;
      var pos = textarea.selectionStart;
      var value = textarea.value;
      var lineStart = value.lastIndexOf('\n', pos - 1) + 1;
      var lineEnd = value.indexOf('\n', pos);
      if (lineEnd === -1) lineEnd = value.length;
      var line = value.slice(lineStart, lineEnd);
      if (line.indexOf(',') !== -1) return;
      var masked = maskChronoLine(line);
      if (masked === line) return;
      textarea.value = value.slice(0, lineStart) + masked + value.slice(lineEnd);
      var newPos = lineStart + masked.length;
      textarea.setSelectionRange(newPos, newPos);
    });
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function sessionBest(session) {
    var best = Infinity;
    for (var i = 0; i < session.laps.length; i++) {
      if (session.laps[i] < best) best = session.laps[i];
    }
    return best;
  }

  function formatDate(iso) {
    var parts = iso.split('-');
    if (parts.length !== 3) return iso;
    return parts[2] + '/' + parts[1] + '/' + parts[0];
  }

  // Same as formatDate() but with a 2-digit year -- used where table width
  // matters on mobile (the Records battus table has 5 columns already).
  function formatDateShortYear(iso) {
    var parts = iso.split('-');
    if (parts.length !== 3) return iso;
    return parts[2] + '/' + parts[1] + '/' + parts[0].slice(2);
  }

  // The chrono date fields use a plain text JJ/MM/AAAA input instead of a
  // native <input type="date"> -- the native picker's on-screen format
  // follows the browser/OS locale, which can silently show mm/dd/yyyy
  // (American) even on a French page, and there's no reliable HTML-only
  // way to force it. A text field pinned to French order sidesteps that.
  function isoToFrDate(iso) {
    if (!iso) return '';
    var p = String(iso).split('-');
    if (p.length !== 3) return '';
    return p[2] + '/' + p[1] + '/' + p[0];
  }

  function frDateToIso(fr) {
    var m = String(fr || '').trim().match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
    if (!m) return null;
    var d = parseInt(m[1], 10), mo = parseInt(m[2], 10), y = parseInt(m[3], 10);
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    return y + '-' + (mo < 10 ? '0' + mo : mo) + '-' + (d < 10 ? '0' + d : d);
  }

  // Auto-inserts the "/" separators as digits are typed, so JJ/MM/AAAA
  // stays easy to type on a plain text field without a native picker.
  function autoFormatFrDateInput(el) {
    if (!el) return;
    el.addEventListener('input', function () {
      var digits = el.value.replace(/[^\d]/g, '').slice(0, 8);
      var out = digits;
      if (digits.length > 4) out = digits.slice(0, 2) + '/' + digits.slice(2, 4) + '/' + digits.slice(4);
      else if (digits.length > 2) out = digits.slice(0, 2) + '/' + digits.slice(2);
      el.value = out;
    });
  }

  function distinctRiders() {
    var seen = {};
    var out = [];
    STATE.sessions.forEach(function (s) {
      if (s.rider && !seen[s.rider]) { seen[s.rider] = true; out.push(s.rider); }
    });
    out.sort(function (a, b) { return a.localeCompare(b); });
    return out;
  }

  // Every circuit the app knows about — from logged chronos AND from
  // planned sorties, so a brand-new circuit with a sortie but no chrono yet
  // (e.g. picked from the Calendrier) is still a valid Circuit/Chronos tab
  // context instead of being silently rejected by normalizeSelection().
  function allCircuits() {
    var seen = {};
    var out = [];
    STATE.sessions.forEach(function (s) {
      if (!seen[s.circuit]) { seen[s.circuit] = true; out.push(s.circuit); }
    });
    eventsList().forEach(function (e) {
      if (!seen[e.circuit]) { seen[e.circuit] = true; out.push(e.circuit); }
    });
    out.sort(function (a, b) { return a.localeCompare(b); });
    return out;
  }

  function mostRecentCircuit(circuitList) {
    var best = null, bestDate = null;
    circuitList.forEach(function (c) {
      var maxDate = null;
      STATE.sessions.forEach(function (s) {
        if (s.circuit === c && (!maxDate || s.date > maxDate)) maxDate = s.date;
      });
      if (!bestDate || (maxDate && maxDate > bestDate)) { bestDate = maxDate; best = c; }
    });
    return best;
  }

  function mostRecentRider(riderList) {
    var best = null, bestDate = null;
    riderList.forEach(function (r) {
      var maxDate = null;
      STATE.sessions.forEach(function (s) {
        if (s.rider === r && (!maxDate || s.date > maxDate)) maxDate = s.date;
      });
      if (!bestDate || (maxDate && maxDate > bestDate)) { bestDate = maxDate; best = r; }
    });
    return best;
  }

  var editingCircuitInfo = false; // local UI state, not persisted
  var annot = { open: false, circuit: null, eventId: null, sessionId: null, tool: 'brush', color: '#e63946', size: 4, fontSize: 22, drawing: false, lastX: 0, lastY: 0, viewOnly: false, viewOnlyName: null };

  // ---- Calendrier (sorties planifiées + sessions déjà roulées) ----
  //
  // Saving (persist() below) publishes a new document version, and the
  // platform reloads every open view — including this one — to it. That
  // wipes plain JS variables back to their initial values, which used to
  // make something as small as ticking a "pense-bête" checkbox look like it
  // bounced the whole app back to the main tab. UI navigation state (which
  // tab/view/day/circuit/pilote is showing) is therefore kept in
  // localStorage — private to this browser, survives that reload, and never
  // touches the shared document — while actual data (sessions, events,
  // checklists) still goes through STATE/persist() as normal.
  var UI_STATE_KEY = 'carnet-de-piste-ui-state';

  function loadUiState() {
    try {
      var raw = localStorage.getItem(UI_STATE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (e) {
      return {};
    }
  }

  function saveUiState() {
    try {
      var knownRiders = allKnownRiders();
      var isAllRiders = !!(selectedRiders && knownRiders.length > 1 && selectedRiders.size === knownRiders.length);
      localStorage.setItem(UI_STATE_KEY, JSON.stringify({
        activeView: activeView,
        calendarViewMode: calendarViewMode,
        calendarAnchor: calendarAnchor,
        selectedEventId: selectedEventId,
        selectedSessionDate: selectedSessionDate,
        selectedCircuit: selectedCircuit,
        selectedRidersAll: isAllRiders,
        selectedRider: (selectedRiders && selectedRiders.size === 1) ? Array.from(selectedRiders)[0] : null,
        planningGroupFilter: planningGroupFilter
      }));
    } catch (e) {
      // Private browsing / storage blocked / quota — fine, just won't survive a reload.
    }
  }

  var _savedUiState = loadUiState();
  // 'sessions' was this app's old (pre-5-tab) Chronos tab id, and 'chronos'
  // was itself a later, now-retired standalone tab — both map forward to
  // 'circuit', which absorbed that content, so a browser with either value
  // already saved doesn't land on a dead tab.
  var _rawSavedView = _savedUiState.activeView;
  // 'calendar' was itself a later, now-retired standalone tab — Calendrier
  // is merged into Événements, so any saved 'calendar' state maps forward
  // to 'event' too.
  // Home page is EN PISTE (Planning) -- the fallback below only kicks in
  // with no saved state at all (a new browser/account); any previously
  // saved tab, on any device, keeps landing on itself as before.
  var activeView = (_rawSavedView === 'sessions' || _rawSavedView === 'chronos') ? 'circuit' : (_rawSavedView === 'calendar' ? 'event' : (_rawSavedView || 'planning')); // 'event' | 'circuit' | 'stats'
  var calendarAnchor = _savedUiState.calendarAnchor || dateKey(new Date()); // 'YYYY-MM-DD'
  var calendarViewMode = _savedUiState.calendarViewMode || '2month'; // one of ZOOM_LEVELS below — base view is 2 months (current + next)
  var selectedEventId = _savedUiState.selectedEventId || null; // which sortie the Événement tab (and Calendrier's detail card) shows
  var editingEventId = null; // null | 'new' | an event id — never restored (don't reopen a form after reload)
  var prefillEventCircuit = null; // one-shot pre-fill for the "Ajouter une sortie" form's circuit field
  var prefillEventTeamId = null; // one-shot pre-fill for the "Ajouter un événement" form's Team, when opened from a Team's own "Gestion des événements"
  // Draft group assignment while the sortie form (add or edit) is open --
  // riders/dates aren't committed to a real event yet (or may still change
  // while editing), so this lives outside STATE until submit. Reset
  // whenever editingEventId changes (see renderEventForm) so switching
  // between "new" and an existing sortie, or closing the form, never
  // leaks a stale draft into the next one.
  var eventFormDraftGroups = {}; // { [rider]: { [date]: { am, pm } } }
  var eventFormDraftGroupsFor = null; // editingEventId the draft above belongs to
  // Collapsed by default only for a brand-new personal (non-Team) event --
  // "ajout rapide" for a new user backfilling old sorties, circuit+date
  // only, with horaires/pilotes/organisateur tucked behind one click
  // instead of a wall of fields upfront. An existing event, or a Team
  // event, always starts expanded since there's already real content in
  // there worth seeing right away.
  var eventFormMoreOptionsOpen = false;
  var eventFormMoreOptionsFor = null; // editingEventId the flag above belongs to
  var eventFormRidersDraft = []; // rider names picked so far in the "Pilotes" search widget below
  var eventFormRidersDraftFor = null; // editingEventId the draft above belongs to
  var draggedGroupRider = null; // rider name mid-drag in renderGroupsSection's drag-and-drop, or null
  var editingSessionId = null; // id of the chrono row being edited inline in the Circuit history table, or null
  var addChronoOpen = false; // whether renderForm() shows the actual "Entrer un nouveau chrono" form, or just its collapsed teaser button
  var selectedSessionDate = _savedUiState.selectedSessionDate || null; // 'YYYY-MM-DD' — shows the "chronos of that day" card
  var planningGroupFilter = _savedUiState.planningGroupFilter || null; // array of HORAIRES_GROUPS keys, or null for "all available"
  var planningIsOngoing = false; // set by renderPlanningTab(), read by updateLiveClock()
  var planningEventDateStart = null; // ditto -- 'YYYY-MM-DD' of the target sortie
  var planningEventId = null; // ditto -- id of the target sortie, read by maybeNotifyGroupDeparture()
  var notifiedSlotKey = null; // 'eventId-slotStart' already notified, avoids re-notifying every 15s tick
  // Which circuit and which rider(s) all four tabs currently show —
  // validated/defaulted by normalizeSelection() below, and kept in sync
  // with the currently-selected sortie via selectEvent(). The global picker
  // (above the main tabs) allows either exactly one rider or the complete
  // known-riders roster ("Tous les pilotes"); it now conditions Calendrier
  // too (events/sessions on the grid, and the period's sorties list).
  var selectedCircuit = _savedUiState.selectedCircuit || null;
  // Whether this sign-in's session has already applied normalizeSelection's
  // en cours/à venir/passé-récent default once -- selectedCircuit is
  // otherwise sticky (persisted, see saveUiState), which used to mean a
  // circuit picked weeks ago for some other event silently kept winning
  // forever, since normalizeSelection only ever recomputes it when it's
  // empty/invalid. Reset on every fresh sign-in (see init()) so a new
  // session re-derives "the right circuit for right now" once, while a
  // manual pick made *during* that same session still sticks afterward.
  var circuitDefaultApplied = false;
  var selectedRiders = _savedUiState.selectedRidersAll ? new Set(allKnownRiders()) : (_savedUiState.selectedRider ? new Set([_savedUiState.selectedRider]) : null); // Set — 1 rider, or the full roster when "Tous" is active
  var ZOOM_LEVELS = ['year', '6month', '3month', '2month', 'month', 'week', 'day'];
  // The checklist is a shared, editable template (STATE.checklistTemplate,
  // one Firestore doc) -- any rider can add/rename/remove a category or an
  // item; ev.checklist just maps an item's id to checked/not for one
  // sortie. DEFAULT_CHECKLIST_TEMPLATE is only the starting suggestion: it
  // takes effect until someone edits it, at which point that edit
  // "materializes" the template into Firestore (see cloneChecklistTemplate).
  var DEFAULT_CHECKLIST_TEMPLATE = {
    categories: [
      { id: 'pistard', name: 'Équipement du pistard', items: [
        { id: 'casque', label: 'Casque' },
        { id: 'visieres', label: 'Visières' },
        { id: 'combi', label: 'Combi' },
        { id: 'sous-combi', label: 'Sous combi' },
        { id: 'airbag', label: 'Airbag' },
        { id: 'gants', label: 'Gants' },
        { id: 'sous-gants', label: 'Sous gants' },
        { id: 'bottes', label: 'Bottes' },
        { id: 'sliders', label: 'Sliders' }
      ]},
      { id: 'moto', name: 'Équipement de la moto', items: [
        { id: 'pneus-rechange', label: 'Pneus de rechange' },
        { id: 'couv-chauffantes', label: 'Couvertures chauffantes' },
        { id: 'bequilles-av-ar', label: 'Béquilles AV et AR' },
        { id: 'chicane', label: 'Chicane' },
        { id: 'gonfleur', label: 'Gonfleur' },
        { id: 'mamo', label: 'Mamo' }
      ]},
      { id: 'transport', name: 'Équipement transport', items: [
        { id: 'sangles', label: 'Sangles' },
        { id: 'rampe', label: 'Rampe' },
        { id: 'caisses', label: 'Caisses' }
      ]},
      { id: 'papiers', name: 'Papiers administratifs', items: [
        { id: 'acces-circuit', label: 'Accès circuit' },
        { id: 'declaration', label: 'Déclaration' },
        { id: 'assurance', label: 'Assurance' },
        { id: 'carte-grise', label: 'Carte grise moto' },
        { id: 'permis', label: 'Permis de conduire' }
      ]},
      { id: 'consommable', name: 'Équipement consommable', items: [
        { id: 'bidons', label: 'Bidons' },
        { id: 'bec-verseur', label: 'Bec verseur' },
        { id: 'essence', label: 'Essence' },
        { id: 'bouteilles-eau', label: 'Bouteilles eau' },
        { id: 'nettoyage', label: 'Nettoyage' },
        { id: 'serviette', label: 'Serviette' },
        { id: 'sacs-poubelles', label: 'Sacs poubelles' },
        { id: 'eponge', label: 'Éponge' }
      ]},
      { id: 'bricole', name: 'Équipement bricole', items: [
        { id: 'boite-outils', label: 'Boîte à outils' },
        { id: 'dynamo', label: 'Dynamo' }
      ]},
      { id: 'confort', name: 'Équipement confort', items: [
        { id: 'chaises', label: 'Chaises' },
        { id: 'armoire', label: 'Armoire' },
        { id: 'porte-manteau', label: 'Porte-manteau' },
        { id: 'ventilo', label: 'Ventilo' }
      ]},
      { id: 'aide', name: 'Équipement aide', items: [
        { id: '3dms', label: '3DMS' },
        { id: 'camera', label: 'Caméra' },
        { id: 'pc', label: 'PC' }
      ]},
      { id: 'autres', name: 'Autres', items: [
        { id: 'autocollant', label: 'Autocollant' },
        { id: 'plan-circuit', label: 'Plan circuit' },
        { id: 'app-telephone', label: 'Application téléphone' }
      ]}
    ]
  };

  function checklistTemplate() {
    return STATE.checklistTemplate || DEFAULT_CHECKLIST_TEMPLATE;
  }

  function checklistAllItems() {
    var out = [];
    checklistTemplate().categories.forEach(function (cat) {
      cat.items.forEach(function (item) { out.push(item); });
    });
    return out;
  }

  function cloneChecklistTemplate() {
    return JSON.parse(JSON.stringify(checklistTemplate()));
  }

  function addChecklistItem(categoryId, label) {
    label = label.trim();
    if (!label) return;
    var prevState = JSON.parse(JSON.stringify(STATE));
    var tpl = cloneChecklistTemplate();
    var cat = tpl.categories.filter(function (c) { return c.id === categoryId; })[0];
    if (!cat) return;
    cat.items.push({ id: genId(), label: label });
    STATE.checklistTemplate = tpl;
    renderRoot();
    persist(prevState);
  }

  function removeChecklistItem(categoryId, itemId) {
    var prevState = JSON.parse(JSON.stringify(STATE));
    var tpl = cloneChecklistTemplate();
    var cat = tpl.categories.filter(function (c) { return c.id === categoryId; })[0];
    if (!cat) return;
    cat.items = cat.items.filter(function (i) { return i.id !== itemId; });
    STATE.checklistTemplate = tpl;
    renderRoot();
    persist(prevState);
  }

  function addChecklistCategory(name) {
    name = name.trim();
    if (!name) return;
    var prevState = JSON.parse(JSON.stringify(STATE));
    var tpl = cloneChecklistTemplate();
    tpl.categories.push({ id: genId(), name: name, items: [] });
    STATE.checklistTemplate = tpl;
    renderRoot();
    persist(prevState);
  }

  function removeChecklistCategory(categoryId) {
    var prevState = JSON.parse(JSON.stringify(STATE));
    var tpl = cloneChecklistTemplate();
    tpl.categories = tpl.categories.filter(function (c) { return c.id !== categoryId; });
    STATE.checklistTemplate = tpl;
    renderRoot();
    persist(prevState);
  }

  // Horaires are per-groupe-de-niveau session times, not a single free-text
  // slot -- a trackday runs several groups back-to-back, each with its own
  // pause (a fast and a slow group can break for lunch up to an hour
  // apart), so pause is a token within a group's own line (e.g. "PAUSE
  // DEJ"), never a separate field of its own.
  var HORAIRES_GROUPS = [
    { key: 'groupR', label: 'Groupe R (Rookies)' },
    { key: 'groupA', label: 'Groupe A' },
    { key: 'groupB', label: 'Groupe B' },
    { key: 'groupC', label: 'Groupe C' },
    { key: 'groupD', label: 'Groupe D' }
  ];

  // The level-group letters a rider can be assigned to, reused both for
  // per-day/per-période rider assignment on a sortie and for tagging a
  // chrono entry with which group's session it belongs to.
  var GROUP_LETTERS = ['A', 'B', 'C', 'D'];
  // Same, plus ORGA (mécano, photographe, autre staff du Team) -- only
  // used for the Team Leader's roster assignment (renderGroupsSection),
  // never offered when tagging a chrono's group since ORGA never rides.
  var ROSTER_GROUP_LETTERS = GROUP_LETTERS.concat(['ORGA']);

  // Every calendar date from start to end (inclusive), 'YYYY-MM-DD' strings
  // -- used to build the per-day group-assignment grid for a multi-day
  // sortie, and capped defensively against a malformed/huge range.
  function datesInRange(startStr, endStr) {
    var out = [];
    if (!startStr) return out;
    var cur = parseLocalDate(startStr);
    var end = parseLocalDate(endStr || startStr);
    var guard = 0;
    while (cur.getTime() <= end.getTime() && guard < 60) {
      out.push(dateKey(cur));
      cur.setDate(cur.getDate() + 1);
      guard++;
    }
    return out;
  }

  // A rider's assigned group for one day/période of a sortie, or '' if
  // never set. ev.riderGroups = { [rider]: { [date]: { am: 'A', pm: 'B' } } }
  // -- a rider can switch groups at the lunch break (am vs pm) or from one
  // day to the next (a fresh am/pm pair per date), each independently.
  function riderGroupFor(ev, rider, date, period) {
    var slot = period === 'apres-midi' ? 'pm' : 'am';
    return (ev && ev.riderGroups && ev.riderGroups[rider] && ev.riderGroups[rider][date] && ev.riderGroups[rider][date][slot]) || '';
  }

  // The circuit of this account's own most recent past event (by date,
  // not by whichever circuit last got a chrono typed in) -- the third
  // rung of normalizeSelection's default: en cours > à venir > passé le
  // plus récent.
  function mostRecentPastEventCircuit() {
    var me = currentUserProfile;
    if (!me) return null;
    var todayKey = dateKey(new Date());
    var past = eventsList().filter(function (ev) {
      return (ev.riders || []).indexOf(me.name) !== -1 && (ev.dateEnd || ev.dateStart) < todayKey;
    }).sort(function (a, b) {
      var ae = a.dateEnd || a.dateStart, be = b.dateEnd || b.dateStart;
      return ae < be ? 1 : (ae > be ? -1 : 0);
    });
    return past.length ? past[0].circuit : null;
  }

  function normalizeSelection() {
    var circuits = allCircuits();
    if (!circuits.length) {
      selectedCircuit = null;
    } else if (!selectedCircuit || circuits.indexOf(selectedCircuit) === -1 || !circuitDefaultApplied) {
      circuitDefaultApplied = true;
      // Default to the circuit of the ongoing or next sortie (what a rider
      // is about to ride or is currently riding); if there's neither,
      // fall back to the circuit of their own most recent past event, and
      // only then to whichever circuit last has a chrono logged against
      // it (covers a role/account with no ev.riders entries of its own).
      var target = targetPlanningEvent();
      var targetCircuit = target && target.ev && circuits.indexOf(target.ev.circuit) !== -1 ? target.ev.circuit : null;
      if (!targetCircuit) {
        var recentPast = mostRecentPastEventCircuit();
        if (recentPast && circuits.indexOf(recentPast) !== -1) targetCircuit = recentPast;
      }
      selectedCircuit = targetCircuit || mostRecentCircuit(circuits) || circuits[0];
    }
    // Circuit/Chronos/Statistiques show only the connected account's own
    // data now, no exceptions -- Social (a friend's fiche, gated by their
    // own sharing settings) is where you look at someone else's. The
    // admin still picks a different pilote directly in the chrono entry
    // form's own dropdown (see renderForm) when entering one on their
    // behalf -- that's independent of this selection.
    selectedRiders = currentUserProfile ? new Set([currentUserProfile.name]) : new Set();
  }

  function getDisplaySessions() {
    if (!selectedCircuit) return [];
    return STATE.sessions
      .filter(function (s) { return s.circuit === selectedCircuit && selectedRiders.has(s.rider); })
      .sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
  }

  function riderStats(riderName) {
    var sessions = STATE.sessions.filter(function (s) { return s.rider === riderName; });
    var circuitBests = {};
    var circuitDateBests = {}; // circuit -> { date: that day's best } -- for the progression figure below
    var lastSession = null;
    sessions.forEach(function (s) {
      var b = sessionBest(s);
      if (!circuitBests[s.circuit] || b < circuitBests[s.circuit].time) {
        circuitBests[s.circuit] = { time: b, date: s.date };
      }
      circuitDateBests[s.circuit] = circuitDateBests[s.circuit] || {};
      if (!circuitDateBests[s.circuit][s.date] || b < circuitDateBests[s.circuit][s.date]) circuitDateBests[s.circuit][s.date] = b;
      if (!lastSession || s.date > lastSession.date) lastSession = s;
    });
    var circuitNames = Object.keys(circuitBests).sort(function (a, b) { return a.localeCompare(b); });
    var riderEvents = eventsList().filter(function (e) { return (e.riders || []).indexOf(riderName) !== -1; });
    // "Jours sur piste" is every calendar day of every sortie the rider took
    // part in -- not just days with a chrono actually typed in, since a
    // 2-day outing is still 2 track days even if only one got a time
    // logged. A sortie = 1 event; a set of dates (not a running sum) so two
    // sorties sharing a date, however unlikely, still count that day once.
    var trackDaySet = {};
    riderEvents.forEach(function (ev) {
      datesInRange(ev.dateStart, ev.dateEnd || ev.dateStart).forEach(function (d) { trackDaySet[d] = true; });
    });
    var trackDaysList = Object.keys(trackDaySet).sort();
    var outingsList = riderEvents.slice().sort(function (a, b) { return a.dateStart < b.dateStart ? 1 : -1; })
      .map(function (ev) { return { circuit: ev.circuit, dateStart: ev.dateStart, dateEnd: ev.dateEnd || ev.dateStart }; });
    return {
      circuitsVisited: circuitNames.length,
      circuitsList: circuitNames,
      trackDays: trackDaysList.length,
      trackDaysList: trackDaysList,
      outingsCount: riderEvents.length,
      outingsList: outingsList,
      lastSession: lastSession ? { circuit: lastSession.circuit, date: lastSession.date, time: sessionBest(lastSession) } : null,
      // "progression" is the gain (negative) or loss (positive) between the
      // rider's very first outing on that circuit and their current best --
      // null with a single outing, since there's nothing to compare yet.
      bests: circuitNames.map(function (c) {
        var dates = Object.keys(circuitDateBests[c]).sort();
        var firstTime = circuitDateBests[c][dates[0]];
        return {
          circuit: c,
          time: circuitBests[c].time,
          date: circuitBests[c].date,
          outings: dates.length,
          progression: dates.length > 1 ? (circuitBests[c].time - firstTime) : null
        };
      })
    };
  }

  function riderCircuitBest(rider, circuit) {
    var best = null;
    STATE.sessions.forEach(function (s) {
      if (s.rider === rider && s.circuit === circuit) {
        var b = sessionBest(s);
        if (best === null || b < best) best = b;
      }
    });
    return best;
  }

  // circuit -> whoever holds the fastest recorded time there, across every
  // rider -- powers the "Recordman" achievement below.
  function allCircuitRecordHolders() {
    var records = {};
    STATE.sessions.forEach(function (s) {
      var b = sessionBest(s);
      if (!records[s.circuit] || b < records[s.circuit].time) records[s.circuit] = { time: b, rider: s.rider };
    });
    return records;
  }

  // A small, purely-derived set of badges -- nothing new to persist, just
  // fun milestones read straight off the rider's existing stats. Each one
  // has a short explanation so an unearned badge still tells you what to
  // aim for.
  // One achievement: earned once current >= target. progressText is what
  // actually shows on screen -- always the concrete number driving it
  // ("3/5 circuits", "2 filleuls"), never just a plain yes/no, so it's
  // obvious both why an earned badge unlocked and how close an unearned
  // one is.
  function achievementEntry(icon, label, description, current, target, unit) {
    var earned = current >= target;
    var progressText = (earned ? current : current + '/' + target) + (unit ? ' ' + unit : '');
    return { icon: icon, label: label, description: description, earned: earned, progressText: progressText };
  }

  // Social/Team trophies, shared by all three roles below (pilote,
  // accompagnant, organisateur) since none of this depends on riding --
  // only globally-synced data is used (friendRequests, teams, wallPosts
  // are all synced in full, unlike a given team's own roster which is only
  // synced for teams *this* account belongs to) so these also work when
  // shown on someone else's fiche (renderFriendFiche), not just your own.
  function socialTeamAchievements(name) {
    var friendsCount = (STATE.friendRequests || []).filter(function (r) {
      return r.status === 'accepted' && (r.from === name || r.to === name);
    }).length;
    var teamsFounded = (STATE.teams || []).filter(function (t) { return t.createdBy === name; }).length;
    var proTeamsFounded = (STATE.teams || []).filter(function (t) { return t.createdBy === name && t.teamPro; }).length;
    var wallPostCount = (STATE.wallPosts || []).filter(function (w) { return w.author === name; }).length;
    return [
      achievementEntry('🧑‍🤝‍🧑', 'Premier ami', 'Avoir un premier ami accepté dans Social.', friendsCount, 1, 'ami(s)'),
      achievementEntry('👥', 'Cercle fidèle', 'Avoir 5 amis acceptés ou plus.', friendsCount, 5, 'amis'),
      achievementEntry('🏍️', 'Fondateur', 'Créer un Team.', teamsFounded, 1, 'team(s)'),
      achievementEntry('🏆', 'Team PRO', 'Fonder un Team certifié PRO.', proTeamsFounded, 1, 'team(s)'),
      achievementEntry('📣', 'Voix du Journal', 'Publier un premier message sur ton Journal.', wallPostCount, 1, 'message(s)'),
      achievementEntry('📰', 'Chroniqueur', 'Publier 5 messages sur ton Journal.', wallPostCount, 5, 'messages')
    ];
  }

  function riderAchievements(riderName, stats) {
    var records = allCircuitRecordHolders();
    var recordCount = Object.keys(records).filter(function (c) { return records[c].rider === riderName; }).length;
    var maxOutingsOnOneCircuit = stats.bests.reduce(function (max, b) { return Math.max(max, b.outings); }, 0);
    var maxGainSeconds = stats.bests.reduce(function (max, b) {
      return b.progression != null && b.progression < 0 ? Math.max(max, -b.progression) : max;
    }, 0);
    var chronoCount = STATE.sessions.filter(function (s) { return s.rider === riderName; }).length;
    loadFilleulCount(riderName);
    var filleuls = filleulCounts[riderName] || 0;
    return [
      achievementEntry('🏁', 'Premier chrono', 'Enregistrer un premier chrono.', stats.bests.length, 1),
      achievementEntry('🌍', 'Globe-trotter', 'Rouler sur 5 circuits différents.', stats.circuitsVisited, 5, 'circuits'),
      achievementEntry('🗺️', 'Grand voyageur', 'Rouler sur 10 circuits différents.', stats.circuitsVisited, 10, 'circuits'),
      achievementEntry('📅', 'Habitué', 'Cumuler 10 jours sur piste.', stats.trackDays, 10, 'jours'),
      achievementEntry('🎖️', 'Vétéran', 'Cumuler 30 jours sur piste.', stats.trackDays, 30, 'jours'),
      achievementEntry('🔥', 'Régulier', 'Revenir 3 fois ou plus sur le même circuit.', maxOutingsOnOneCircuit, 3, 'événements'),
      achievementEntry('📈', 'Assidu', 'Enregistrer 20 chronos.', chronoCount, 20, 'chronos'),
      achievementEntry('🚀', 'Grosse progression', 'Gagner au moins 1 seconde sur un circuit depuis son premier événement là-bas.', Math.floor(maxGainSeconds), 1, 's gagnées'),
      achievementEntry('⚡', 'Éclair', 'Gagner au moins 3 secondes sur un circuit depuis son premier événement là-bas.', Math.floor(maxGainSeconds), 3, 's gagnées'),
      achievementEntry('🥇', 'Recordman', 'Détenir le record du groupe sur au moins un circuit.', recordCount, 1, 'record(s)'),
      achievementEntry('👑', 'Multi-recordman', 'Détenir le record du groupe sur 3 circuits ou plus.', recordCount, 3, 'records'),
      achievementEntry('🤝', 'Parrain', 'Faire signer un premier filleul avec ton lien de parrainage.', filleuls, 1, 'filleul(s)'),
      achievementEntry('👨‍👩‍👧', 'Grand parrain', 'Faire signer 5 filleuls avec ton lien de parrainage.', filleuls, 5, 'filleuls')
    ].concat(socialTeamAchievements(riderName));
  }

  // Accompagnants don't ride, so their achievements are about following
  // and supporting the group instead of lap times.
  function accompagnantAchievements(profile) {
    var followed = (profile.followedRiders || []).length;
    var mediaLinksAdded = STATE.events.filter(function (ev) { return ev.mediaLinkAddedBy === profile.name; }).length;
    loadFilleulCount(profile.name);
    var filleuls = filleulCounts[profile.name] || 0;
    return [
      achievementEntry('👀', 'Premier suivi', 'Suivre au moins un pilote depuis Mon profil.', followed, 1, 'pilote(s)'),
      achievementEntry('🧭', 'Supporter fidèle', 'Suivre 3 pilotes ou plus.', followed, 3, 'pilotes'),
      achievementEntry('🔔', 'Toujours alerte', 'Activer les notifications de départ en piste.', profile.notifyBeforeSession ? 1 : 0, 1),
      achievementEntry('📸', 'Reporter', 'Partager un lien photos/vidéos pour un événement.', mediaLinksAdded, 1, 'événement(s)'),
      achievementEntry('🎬', 'Grand reporter', 'Partager un lien photos/vidéos pour 3 événements.', mediaLinksAdded, 3, 'événements'),
      achievementEntry('🤝', 'Parrain', 'Faire signer un premier filleul avec ton lien de parrainage.', filleuls, 1, 'filleul(s)'),
      achievementEntry('👨‍👩‍👧', 'Grand parrain', 'Faire signer 5 filleuls avec ton lien de parrainage.', filleuls, 5, 'filleuls')
    ].concat(socialTeamAchievements(profile.name));
  }

  // Organisateurs don't ride either, but unlike an accompagnant their
  // activity is about running events -- counted off the "Organisateur"
  // free-text field every event already carries (see renderEventForm),
  // matched against this account's own name. No schema change: an
  // organisateur just signs their events with the same name they signed
  // up under.
  function organisateurAchievements(profile) {
    var organized = STATE.events.filter(function (ev) { return ev.organizer === profile.name; });
    var circuitsOrganized = {};
    organized.forEach(function (ev) { if (ev.circuit) circuitsOrganized[ev.circuit] = true; });
    var mediaLinksAdded = STATE.events.filter(function (ev) { return ev.mediaLinkAddedBy === profile.name; }).length;
    loadFilleulCount(profile.name);
    var filleuls = filleulCounts[profile.name] || 0;
    return [
      achievementEntry('🏁', 'Premier événement', 'Organiser un événement (champ "Organisateur" de l\'événement = ton nom).', organized.length, 1, 'événement(s)'),
      achievementEntry('📋', 'Organisateur confirmé', 'Organiser 5 événements.', organized.length, 5, 'événements'),
      achievementEntry('🏆', 'Organisateur chevronné', 'Organiser 15 événements.', organized.length, 15, 'événements'),
      achievementEntry('🗺️', 'Multi-circuits', 'Organiser des événements sur 3 circuits différents.', Object.keys(circuitsOrganized).length, 3, 'circuits'),
      achievementEntry('🔔', 'Toujours alerte', 'Activer les notifications de départ en piste.', profile.notifyBeforeSession ? 1 : 0, 1),
      achievementEntry('📸', 'Reporter', 'Partager un lien photos/vidéos pour un événement.', mediaLinksAdded, 1, 'événement(s)'),
      achievementEntry('🎬', 'Grand reporter', 'Partager un lien photos/vidéos pour 3 événements.', mediaLinksAdded, 3, 'événements'),
      achievementEntry('🤝', 'Parrain', 'Faire signer un premier filleul avec ton lien de parrainage.', filleuls, 1, 'filleul(s)'),
      achievementEntry('👨‍👩‍👧', 'Grand parrain', 'Faire signer 5 filleuls avec ton lien de parrainage.', filleuls, 5, 'filleuls')
    ].concat(socialTeamAchievements(profile.name));
  }

  // Shared by pilote and accompagnant profiles -- a proper section (icon,
  // title, always-visible description and the concrete progress behind
  // it), not just a row of chips with a tooltip. Collapsed by default
  // (masquable) so it doesn't crowd out the profile itself -- key must be
  // unique per rider/profile so open/closed state doesn't bleed between them.
  function renderAchievementsCard(achievements, key) {
    var earnedCount = achievements.filter(function (a) { return a.earned; }).length;
    var inner = '<div class="achievements-list">';
    achievements.forEach(function (a) {
      inner += '<div class="achievement-row' + (a.earned ? ' earned' : '') + '">' +
        '<span class="achievement-icon">' + a.icon + '</span>' +
        '<span class="achievement-body"><span class="achievement-title">' + escapeHtml(a.label) + '</span>' +
        '<span class="achievement-desc">' + escapeHtml(a.description) + '</span></span>' +
        '<span class="achievement-progress">' + escapeHtml(a.progressText) + '</span>' +
        '</div>';
    });
    inner += '</div>';
    var title = '🏆 Trophées — ' + earnedCount + '/' + achievements.length + ' débloqués';
    return '<div class="card achievements-card">' + collapsibleSection(key, title, inner) + '</div>';
  }

  // Inline replacement for one row of the chronos history table -- every
  // field of a recorded session (pilote, date, session/groupe, chronos,
  // moto, note) becomes editable in place, instead of only offering
  // delete. Spans the full width of the table so it doesn't fight the
  // column layout with its own multi-field form.
  function renderSessionEditRow(s, colCount) {
    var html = '<tr class="session-edit-row" data-session-id="' + s.id + '"><td colspan="' + colCount + '">';
    html += '<form id="session-edit-form" novalidate>';
    html += '<div class="field-row">';
    html += isAdmin()
      ? '<div><label for="se-rider">Pilote</label><input type="text" id="se-rider" list="rider-options-se" value="' + escapeHtml(s.rider || '') + '" required>' +
        '<datalist id="rider-options-se">' + riderDatalist() + '</datalist></div>'
      : '<div><label>Pilote</label><div class="static-field">' + escapeHtml(s.rider || '') + '</div></div>';
    html += '<div><label for="se-date">Date</label><input type="text" id="se-date" inputmode="numeric" placeholder="JJ/MM/AAAA" value="' + isoToFrDate(s.date) + '" required></div>';
    html += '<div><label for="se-bike">Moto</label><input type="text" id="se-bike" list="bike-options-se" value="' + escapeHtml(s.bike || '') + '">' +
      '<datalist id="bike-options-se">' + bikeDatalist() + '</datalist></div>';
    html += '</div>';
    html += '<div class="field-row">';
    html += '<div><label for="se-group">Groupe</label><select id="se-group"><option value=""' + (!s.group ? ' selected' : '') + '>—</option>' +
      GROUP_LETTERS.map(function (g) { return '<option value="' + g + '"' + (s.group === g ? ' selected' : '') + '>' + g + '</option>'; }).join('') +
      '</select></div>';
    var seSlots = todaysGroupSlots(s.circuit, s.group);
    var seSlotIdx = s.slotStart != null ? seSlots.map(function (sl) { return sl.start; }).indexOf(s.slotStart) : -1;
    html += '<div><label for="se-slot">Session</label><select id="se-slot">' + renderSlotOptions(seSlots, seSlotIdx) + '</select></div>';
    html += '</div>';
    html += '<label for="se-laps">Chronos</label>' +
      '<textarea id="se-laps" required>' + escapeHtml(s.laps.map(function (l) { return formatTime(l); }).join('\n')) + '</textarea>' +
      '<div class="help-text">Un chrono par ligne (ou séparés par une virgule) — format 1:23.456 ou 83.456.</div>';
    html += '<div style="margin-top:0.6rem;"><label for="se-note">Note (optionnel)</label><input type="text" id="se-note" value="' + escapeHtml(s.note || '') + '"></div>';
    html += '<div class="field-error" id="session-edit-error"></div>';
    html += '<div style="margin-top:0.7rem; display:flex; gap:0.6rem;">' +
      '<button type="submit" class="primary">Enregistrer</button>' +
      '<button type="button" class="ghost" id="cancel-session-edit-btn">Annuler</button>' +
      '</div>';
    html += '</form></td></tr>';
    return html;
  }

  function onSessionEditSubmit(evt) {
    evt.preventDefault();
    var errEl = document.getElementById('session-edit-error');
    errEl.textContent = '';
    errEl.classList.remove('visible');

    var session = STATE.sessions.filter(function (s) { return s.id === editingSessionId; })[0];
    if (!session) { editingSessionId = null; renderRoot(); return; }

    var riderInputEl = document.getElementById('se-rider');
    var rider = riderInputEl ? riderInputEl.value.trim() : session.rider;
    var dateRaw = document.getElementById('se-date').value;
    var date = frDateToIso(dateRaw);
    var bike = document.getElementById('se-bike').value.trim();
    var note = document.getElementById('se-note').value.trim();
    var group = document.getElementById('se-group').value;
    var slotEl = document.getElementById('se-slot');
    var rawLaps = document.getElementById('se-laps').value.split(/[\n,;]+/).map(function (s) { return s.trim(); }).filter(Boolean);
    var laps = [];
    var invalid = false;
    rawLaps.forEach(function (raw) {
      var t = parseTime(raw);
      if (t === null) { invalid = true; } else { laps.push(t); }
    });

    if (dateRaw.trim() && !date) {
      errEl.textContent = 'Date invalide — format attendu JJ/MM/AAAA.';
      errEl.classList.add('visible');
      return;
    }
    if (!rider || !date || !laps.length) {
      errEl.textContent = 'Renseignez un pilote, une date et au moins un chrono valide.';
      errEl.classList.add('visible');
      return;
    }
    if (invalid) {
      errEl.textContent = 'Certains chronos sont illisibles — format attendu 1:23.456 ou 83.456.';
      errEl.classList.add('visible');
      return;
    }

    var prevState = JSON.parse(JSON.stringify(STATE));
    session.rider = rider;
    session.date = date;
    session.laps = laps;
    if (bike) session.bike = bike; else delete session.bike;
    if (note) session.note = note; else delete session.note;
    if (group) session.group = group; else delete session.group;
    if (slotEl && slotEl.value) {
      var chosenSlot = todaysGroupSlots(session.circuit, group).filter(function (sl) { return String(sl.start) === slotEl.value; })[0];
      if (chosenSlot) {
        session.slotStart = chosenSlot.start;
        session.slotEnd = chosenSlot.end;
        session.slotLabel = chosenSlot.label;
      } else {
        delete session.slotStart; delete session.slotEnd; delete session.slotLabel;
      }
    } else {
      delete session.slotStart; delete session.slotEnd; delete session.slotLabel;
    }
    editingSessionId = null;
    renderRoot();
    persist(prevState);
    showToast('Chrono modifié.', 'success');
  }

  function renderSessionsCard() {
    var sessions = getDisplaySessions();
    var showRider = selectedRiders.size !== 1;
    var html = '<div class="card sessions-card">';
    html += '<div class="circuit-head"><div class="circuit-name">' + escapeHtml(selectedCircuit) + '</div>';
    var record = null;
    sessions.forEach(function (s) {
      var b = sessionBest(s);
      if (!record || b < record.time) record = { time: b, rider: s.rider };
    });
    if (record) {
      html += '<div class="circuit-best">Record ' + formatTime(record.time) + ' — ' + escapeHtml(record.rider) + '</div>';
    }
    html += '</div>';
    if (!sessions.length) {
      html += '<div class="empty-state">Aucune session pour ce circuit avec les pilotes sélectionnés.</div>';
    } else {
      var colCount = 4 + (showRider ? 1 : 0);
      var tableHtml = '<div class="table-scroll"><table class="session-table"><thead><tr><th>Date</th>' + (showRider ? '<th>Pilote</th>' : '') + '<th>Chronos</th><th>Moto</th><th></th></tr></thead><tbody>';
      sessions.forEach(function (s) {
        if (s.id === editingSessionId) {
          tableHtml += renderSessionEditRow(s, colCount);
          return;
        }
        var best = sessionBest(s);
        var isRecord = record && best === record.time;
        var personalBest = riderCircuitBest(s.rider, s.circuit);
        var lapsHtml = s.laps.map(function (l) {
          var t = formatTime(l);
          var span = (l === best) ? '<span class="best-lap">' + t + '</span>' : t;
          if (personalBest !== null && l > personalBest) {
            span += '<span class="lap-delta">+' + (l - personalBest).toFixed(3) + '</span>';
          }
          return span;
        }).join(', ');
        var noteHtml = s.note ? '<div class="note-text">' + escapeHtml(s.note) + '</div>' : '';
        var periodLabel = s.period === 'matin' ? 'Matin' : s.period === 'apres-midi' ? 'Après-midi' : '';
        var sessionTagParts = [];
        if (s.slotLabel) sessionTagParts.push(s.slotLabel);
        else if (periodLabel) sessionTagParts.push(periodLabel);
        if (s.group) sessionTagParts.push('Groupe ' + s.group);
        var sessionTagHtml = sessionTagParts.length ? '<div class="note-text">' + escapeHtml(sessionTagParts.join(' — ')) + '</div>' : '';
        var feelingOpt = s.feeling ? FEELING_OPTIONS.filter(function (f) { return f.key === s.feeling; })[0] : null;
        var feelingTitle = feelingOpt ? 'Ressenti : ' + feelingOpt.label + (s.feelingComment ? ' — ' + s.feelingComment : '') : '';
        var feelingHtml = feelingOpt ? ' <span class="feeling-tag" title="' + escapeHtml(feelingTitle) + '">' + feelingOpt.icon + '</span>' : '';
        tableHtml += '<tr data-session-id="' + s.id + '">';
        tableHtml += '<td>' + formatDate(s.date) + feelingHtml + sessionTagHtml + noteHtml + '</td>';
        if (showRider) tableHtml += '<td class="rider-cell">' + (s.rider ? renderRiderLink(s.rider) : '—') + '</td>';
        tableHtml += '<td class="laps-cell">' + lapsHtml + (isRecord ? '<span class="record-pill">RECORD</span>' : '') + '</td>';
        tableHtml += '<td class="bike-cell">' + (s.bike ? escapeHtml(s.bike) : '—') + '</td>';
        tableHtml += '<td class="row-actions">' + certifyControl(s) + editControl(s) + deleteControl(s) + '</td>';
        tableHtml += '</tr>';
      });
      tableHtml += '</tbody></table></div>';
      html += renderStatSummaryCategory('chronos-history-' + selectedCircuit, 'Historique', sessions.length, tableHtml);
    }
    html += '</div>';
    return html;
  }

  // The total is always visible (it's the summary text, never hidden by
  // the fold) -- only the underlying list is collapsed, to keep the stats
  // card compact. Uses the same open/closed state map as Planning's
  // collapsibleSection, keyed uniquely per rider so it doesn't cross-bleed.
  function renderStatSummaryCategory(key, label, total, detailHtml) {
    var open = planningSectionsOpen[key] ? ' open' : '';
    return '<details class="stat-summary-category" data-planning-section="' + key + '"' + open + '>' +
      '<summary><span class="stat-summary-label">' + escapeHtml(label) + '</span><span class="stat-summary-value">' + total + '</span></summary>' +
      (detailHtml || '<div class="empty-inline">Aucune donnée.</div>') +
      '</details>';
  }

  function renderRiderStatsCard(riderName) {
    var stats = riderStats(riderName);
    var html = '<div class="card">';
    html += '<div class="rider-stat-name">' + escapeHtml(riderName) + '</div>';
    html += '<div class="rider-stat-summaries">';
    var outingsDetail = '';
    if (stats.lastSession) {
      outingsDetail += infoRow('Dernier événement', escapeHtml(stats.lastSession.circuit) + ' — ' + escapeHtml(formatDate(stats.lastSession.date)) + ' (' + formatTime(stats.lastSession.time) + ')');
    }
    if (stats.outingsList.length) {
      outingsDetail += '<ul class="stat-detail-list">' + stats.outingsList.map(function (o) {
        var range = o.dateStart === o.dateEnd ? formatDate(o.dateStart) : formatDate(o.dateStart) + ' → ' + formatDate(o.dateEnd);
        return '<li>' + escapeHtml(o.circuit) + ' — ' + range + '</li>';
      }).join('') + '</ul>';
    }
    html += renderStatSummaryCategory('outings-' + riderName, 'Événements', stats.outingsCount, outingsDetail);
    html += renderStatSummaryCategory('circuits-' + riderName, 'Circuits visités', stats.circuitsVisited,
      !stats.circuitsList.length ? '' : '<ul class="stat-detail-list">' + stats.circuitsList.map(function (c) {
        return '<li>' + escapeHtml(c) + '</li>';
      }).join('') + '</ul>');
    html += renderStatSummaryCategory('trackdays-' + riderName, 'Jours sur piste', stats.trackDays,
      !stats.trackDaysList.length ? '' : '<ul class="stat-detail-list">' + stats.trackDaysList.slice().reverse().map(function (d) {
        return '<li>' + escapeHtml(formatDate(d)) + '</li>';
      }).join('') + '</ul>');
    var bestsDetail = '';
    if (stats.bests.length) {
      stats.bests.forEach(function (b) {
        var progressionHtml = '';
        if (b.progression != null) {
          progressionHtml = b.progression < 0
            ? '<span class="daily-recap-better">−' + Math.abs(b.progression).toFixed(3) + '</span>'
            : (b.progression > 0 ? '<span class="daily-recap-worse">+' + b.progression.toFixed(3) + '</span>' : '=');
        }
        bestsDetail += '<div class="best-time-row"><span class="best-time-circuit">' + escapeHtml(b.circuit) + ' <span class="help-text" style="display:inline;">(' + b.outings + ' événement' + (b.outings > 1 ? 's' : '') + ')</span></span>' +
          '<span><span class="best-time-value">' + formatTime(b.time) + '</span>' +
          (progressionHtml ? ' ' + progressionHtml : '') +
          '<span class="best-time-date">' + formatDate(b.date) + '</span></span></div>';
      });
    }
    html += renderStatSummaryCategory('bests-' + riderName, 'Meilleurs temps par circuit', stats.bests.length, bestsDetail);
    // Vérifiés par un Team Leader (voir certifyControl/renderEventCertification-
    // Section) -- même liste que sur la fiche d'un ami, mais ici pour le
    // pilote dont les Stats sont affichées.
    var verifiedSessions = STATE.sessions.filter(function (s) { return s.rider === riderName && s.certifiedBy; })
      .sort(function (a, b) { return a.date < b.date ? 1 : a.date > b.date ? -1 : 0; });
    var verifiedDetail = !verifiedSessions.length ? '' : verifiedSessions.map(function (s) {
      return infoRow(escapeHtml(s.circuit) + ' — ' + escapeHtml(formatDate(s.date)), formatTime(sessionBest(s)) + ' ' + certifyControl(s));
    }).join('');
    html += renderStatSummaryCategory('verified-' + riderName, 'Chronos vérifiés', verifiedSessions.length, verifiedDetail);
    html += renderRiderRecordsCategory(riderName);
    html += '</div>';
    html += '</div>';
    return html;
  }

  // Trophées, kept separate from renderRiderStatsCard itself so
  // renderStatsTab can place every rider's stats card first, then
  // Records-of-the-year, then Trophées last -- visual order Chronos
  // vérifiés -> Records -> Trophées, not interleaved per rider.
  function renderRiderAchievementsCard(riderName) {
    return renderAchievementsCard(riderAchievements(riderName, riderStats(riderName)), 'achievements-' + riderName);
  }


  // ---- Gestion des pilotes (ajout / renommage / suppression) ----
  //
  // Riders are otherwise just names attached to sessions/events -- this
  // panel lets the roster (STATE.riders) be edited directly, including a
  // rider with no chrono yet. Admin-only (see isAdmin()): the gear that
  // opens it, and this panel's own content, are both hidden for everyone
  // else -- enforced again server-side in firestore.rules (riders delete).
  function renderRiderManagerPanel() {
    if (!riderManagerOpen) return '';
    var riders = allKnownRiders();
    var rows = riders.map(function (r) {
      if (editingRiderName === r) {
        return '<li class="rider-manager-row rider-manager-row-edit">' +
          '<form data-rename-rider="' + escapeHtml(r) + '" class="rider-manager-rename-form">' +
          '<input type="text" name="new-name" value="' + escapeHtml(r) + '" required autofocus>' +
          '<button type="submit" class="primary">OK</button>' +
          '<button type="button" class="ghost" data-action="cancel-rename-rider">Annuler</button>' +
          '</form></li>';
      }
      var isPendingDelete = pendingDeleteRider === r;
      return '<li class="rider-manager-row">' +
        '<span class="rider-manager-name">' + escapeHtml(r) + '</span>' +
        '<button type="button" class="ghost icon-btn" data-action="rename-rider-request" data-rider="' + escapeHtml(r) + '" aria-label="Renommer ' + escapeHtml(r) + '" title="Renommer">✎</button>' +
        '<button type="button" class="ghost icon-btn' + (isPendingDelete ? ' confirm' : ' danger') + '" data-action="delete-rider-request" data-rider="' + escapeHtml(r) + '" aria-label="Supprimer ' + escapeHtml(r) + '" title="Supprimer">' + (isPendingDelete ? '✓' : '×') + '</button>' +
        '</li>';
    }).join('');
    var html = '<div class="rider-manager">';
    html += riders.length ? '<ul class="rider-manager-list">' + rows + '</ul>' : '';
    html += '<form id="add-rider-form" class="rider-manager-add-form">' +
      '<input type="text" id="new-rider-name" placeholder="Nom du nouveau pilote" required>' +
      '<button type="submit" class="primary">Ajouter</button>' +
      '</form>';
    if (riderManagerError) {
      html += '<div class="field-error visible">' + escapeHtml(riderManagerError) + '</div>';
    }
    html += '</div>';
    return html;
  }

  // ---- Mon profil — chaque pilote/accompagnant gère son propre compte ----
  //
  // A pilote's name doubles as the roster's join key (STATE.riders /
  // ev.riderGroups / session.rider all key off it), so renaming it here
  // cascades through renameRiderEverywhere() just like the admin-only
  // rider manager's rename -- and hits the same uniqueness guard as
  // signup (see resolveUniquePseudo) if the new pseudo collides with
  // someone else's.
  function renderProfileTabBar() {
    var tabs = [['profil', 'Profil'], ['parrainage', 'Parrainage'], ['reglages', 'Réglages'], ['aide', 'Aide'], ['suggestion', 'Suggestion']];
    return '<div class="profile-tabs" role="tablist">' + tabs.map(function (t) {
      return '<button type="button" class="profile-tab-btn' + (profileSubTab === t[0] ? ' active' : '') + '" role="tab" aria-selected="' + (profileSubTab === t[0]) + '" data-profile-tab="' + t[0] + '">' + t[1] + '</button>';
    }).join('') + '</div>';
  }

  function renderProfileAvatar(p) {
    var initial = escapeHtml((p.name || '?').trim().charAt(0).toUpperCase() || '?');
    return '<div class="profile-avatar-row">' +
      '<div class="profile-avatar">' + (p.photoURL ? '<img src="' + escapeHtml(p.photoURL) + '" alt="Photo de profil">' : '<span class="profile-avatar-placeholder">' + initial + '</span>') + '</div>' +
      '<div class="profile-avatar-actions">' +
        '<button type="button" class="ghost" id="profile-photo-btn">' + (p.photoURL ? 'Changer la photo' : 'Ajouter une photo') + '</button>' +
        (p.photoURL ? '<button type="button" class="ghost" id="profile-photo-recrop-btn">Modifier le cadrage</button>' : '') +
        (p.photoURL ? '<button type="button" class="ghost" id="profile-photo-remove-btn">Retirer</button>' : '') +
        '<input type="file" id="profile-photo-input" accept="image/*" style="display:none;">' +
        (profilePhotoMessage ? '<div class="help-text">' + escapeHtml(profilePhotoMessage) + '</div>' : '') +
      '</div>' +
      '</div>';
  }

  // What Carnet de Piste actually does for each role -- shown live as soon
  // as a role is selected in the "Je suis" choice (see the profile-role
  // change listener), not just after Enregistrer, so switching the radio
  // immediately answers "qu'est-ce que ça m'apporte ?" without a round
  // trip through the server. Deliberately never mentions Trophées/Stats --
  // that's covered on its own tab, this is purely "quels services".
  var ROLE_INFO = {
    pilote: {
      title: 'Espace pilote',
      items: [
        'Enregistrer tes chronos événement par événement et suivre tes meilleurs temps par circuit',
        'Faire certifier tes chronos par un Team Leader ("Chrono vérifié")',
        'Retrouver les horaires, groupes et infos pratiques de chaque événement dans EN PISTE',
        'Partager tes infos de voyage (hôtel, vols) avec tes amis, et voir les leurs',
        'Suivre tes amis, réagir sur leur Journal et sur le fil d\'actualité de ton Team',
        'Rejoindre un Team (amateur ou PRO) et participer à ses événements'
      ]
    },
    accompagnant: {
      title: 'Espace accompagnant',
      items: [
        'Suivre des pilotes et être notifié quand leur groupe va partir rouler',
        'Consulter les horaires, groupes et infos pratiques de l\'événement en cours, sans y rouler toi-même',
        'Voir les chronos et la progression des pilotes que tu suis',
        'Voir les infos de voyage des pilotes suivis, si elles sont partagées',
        'Suivre des Teams, réagir sur leur fil d\'actualité, et publier sur ton propre Journal'
      ]
    },
    organisateur: {
      title: 'Espace organisateur',
      items: [
        'Créer et gérer un événement : dates, horaires par groupe, infos pratiques, baptêmes/coaching',
        'Tenir à jour la fiche d\'un circuit (plan, distance, virages, horaires par défaut)',
        'Partager un lien photos/vidéos après l\'événement',
        'Suivre des pilotes et être notifié de leurs départs, comme un accompagnant',
        'Si tu es aussi Team Leader d\'un Team : gérer ses membres, son fil d\'actualité, ses événements et certifier les chronos de tes pilotes'
      ]
    }
  };
  function renderRoleInfoCard(role, currentRole) {
    var info = ROLE_INFO[role];
    var visible = role === currentRole;
    var html = '<div class="card organizer-hub" id="profile-role-info-' + role + '" style="display:' + (visible ? 'block' : 'none') + ';">';
    html += '<div class="section-title" style="font-size:0.95rem;">' + escapeHtml(info.title) + '</div>';
    html += '<div class="help-text">Carnet de Piste t\'aide à :</div>';
    html += '<ul class="organizer-hub-list">' + info.items.map(function (t) { return '<li>' + escapeHtml(t) + '</li>'; }).join('') + '</ul>';
    html += '</div>';
    return html;
  }

  // Locked by default -- clicking "Modifier" (see pseudo-edit-unlock's
  // handler) shows the first warning and, only if accepted, flips this so
  // the field becomes editable; reset every time the profile panel closes
  // or a save actually goes through, so it's never left unlocked across
  // an unrelated visit to Mon profil.
  var pseudoEditUnlocked = false;
  // Click-to-arm/click-to-confirm for the actual rename on submit (replaces
  // a window.confirm()) -- first Enregistrer with a changed pseudo just
  // arms it and shows a message instead of saving, second Enregistrer goes
  // through. Reset whenever the pseudo field itself changes again, so an
  // armed confirm never silently applies to a different name.
  var pseudoRenameConfirmPending = false;

  function renderProfileProfilTab(p) {
    // "Accompagnant" and "Organisateur" both mean "doesn't ride" for the
    // rest of the form (no moto, no name-number, follows riders instead of
    // logging chronos) -- only the role label itself, the notify wording,
    // and which achievements set applies differ between the two.
    var isNonRider = p.role === 'accompagnant' || p.role === 'organisateur';
    var followed = p.followedRiders || [];
    var html = '<form id="profile-form">';
    html += renderProfileAvatar(p);
    html += '<label for="profile-name">Pseudo</label>';
    var renameBlockedUntil = renameAllowedAt(p);
    if (renameBlockedUntil) {
      html += '<input type="text" id="profile-name" value="' + escapeHtml(p.name) + '" disabled>' +
        '<div class="help-text">1 changement de pseudo par mois -- possible à nouveau le ' + escapeHtml(renameBlockedUntil.toLocaleDateString('fr-FR')) + '.</div>';
    } else if (pseudoEditUnlocked) {
      html += '<input type="text" id="profile-name" value="' + escapeHtml(p.name) + '" required>' +
        '<div class="help-text" style="color:var(--danger, #b23);">⚠ Renommer va changer ton identité partout dans l\'app (chronos, événements, teams, coaching, amis...).</div>';
    } else {
      html += '<input type="text" id="profile-name" value="' + escapeHtml(p.name) + '" disabled>' +
        '<button type="button" class="ghost" id="pseudo-edit-unlock" style="margin-top:0.4rem;">Modifier le pseudo</button>';
    }
    // Distinct de Pseudo (l'identifiant utilisé partout dans l'app --
    // chronos, riders, connexion) -- Prénom/Nom sont facultatifs, remplis
    // par le user quand il veut, jamais requis, et ne cascadent nulle part.
    html += '<div style="display:flex; gap:0.6rem; margin-top:0.7rem;">' +
      '<div style="flex:1;"><label for="profile-firstname">Prénom</label><input type="text" id="profile-firstname" value="' + escapeHtml(p.firstName || '') + '"></div>' +
      '<div style="flex:1;"><label for="profile-lastname">Nom</label><input type="text" id="profile-lastname" value="' + escapeHtml(p.lastName || '') + '"></div>' +
      '</div>';
    html += '<label style="margin-top:0.9rem;">Je suis</label>';
    html += '<div class="auth-role-choice">' +
      '<label><input type="radio" name="profile-role" value="pilote"' + (p.role !== 'accompagnant' && p.role !== 'organisateur' ? ' checked' : '') + '> Pilote</label>' +
      '<label><input type="radio" name="profile-role" value="accompagnant"' + (p.role === 'accompagnant' ? ' checked' : '') + '> Accompagnant</label>' +
      '<label><input type="radio" name="profile-role" value="organisateur"' + (p.role === 'organisateur' ? ' checked' : '') + '> Organisateur</label>' +
      '</div>';
    // Trophées unifiés dans Stats désormais, quel que soit le rôle (voir
    // renderStatsTab) -- Profil n'en montre plus une copie séparée. Les
    // trois cartes sont toutes rendues (une seule visible à la fois) pour
    // que changer le radio "Je suis" bascule instantanément vers la bonne,
    // avant même Enregistrer -- voir le listener de profile-role.
    var currentRole = (p.role === 'accompagnant' || p.role === 'organisateur') ? p.role : 'pilote';
    html += renderRoleInfoCard('pilote', currentRole);
    html += renderRoleInfoCard('accompagnant', currentRole);
    html += renderRoleInfoCard('organisateur', currentRole);
    html += '<div id="profile-bike-wrap" style="display:' + (isNonRider ? 'none' : 'block') + '; margin-top:0.9rem;">' +
      '<label for="profile-bike">Ma moto</label><input type="text" id="profile-bike" placeholder="Ex. ST 765 RS" value="' + escapeHtml(p.bike || '') + '">' +
      '<div class="help-text">Suggérée automatiquement quand tu entres un chrono.</div>' +
      '<label for="profile-bike-number" style="margin-top:0.7rem;">N° de moto</label>' +
      '<input type="text" id="profile-bike-number" inputmode="numeric" pattern="[0-9]{1,3}" maxlength="3" placeholder="Ex. 12" value="' + escapeHtml(p.bikeNumber || '') + '">' +
      '<div class="help-text">1 à 3 chiffres.</div>' +
      '<label for="profile-chrono-link" style="margin-top:0.7rem;">Lien vers ton appli de chrono (optionnel)</label>' +
      '<input type="url" id="profile-chrono-link" placeholder="Ex. https://superlaps.fr/..." value="' + escapeHtml(p.chronoLink || '') + '">' +
      '<div class="help-text">Carnet de Piste reste déclaratif -- ce lien renvoie vers ton appli de chrono officielle (Superlaps ou autre) si tu en utilises une.</div></div>';
    html += '<div id="profile-followed-wrap" style="display:' + (isNonRider ? 'block' : 'none') + '; margin-top:0.9rem;">';
    html += '<label>Pilotes que je suis</label>';
    var riders = allKnownRiders();
    if (!riders.length) {
      html += '<div class="help-text">Aucun pilote enregistré pour l\'instant.</div>';
    } else {
      html += '<div class="profile-followed-riders">' + riders.map(function (r) {
        return '<label class="checklist-item"><input type="checkbox" name="profile-follow-rider" value="' + escapeHtml(r) + '"' + (followed.indexOf(r) !== -1 ? ' checked' : '') + '> ' + escapeHtml(r) + '</label>';
      }).join('') + '</div>';
    }
    html += '</div>';
    html += '<div style="margin-top:1rem; display:flex; gap:0.6rem;"><button type="submit" class="primary">Enregistrer</button>' +
      '<button type="button" class="ghost" id="profile-cancel">Fermer</button></div>';
    if (profileSaveMessage) html += '<div class="help-text" style="margin-top:0.6rem;">' + escapeHtml(profileSaveMessage) + '</div>';
    html += '</form>';
    return html;
  }

  // Admin-only: self-service badges. Every other account gets these from
  // the admin via Gestion des comptes -- the admin's own account is
  // deliberately excluded from that list (see loadManageableAccounts), so
  // this is the only place they can flip their own. Reads PROFILE_BADGES,
  // so a new badge added there shows up here for free.
  function renderSelfBadges(p) {
    var html = '<div style="margin-top:1.2rem; border-top:1px solid var(--border); padding-top:0.9rem;">';
    html += '<div class="section-title" style="font-size:0.95rem;">Mes badges (admin)</div>';
    html += '<div class="help-text">Pour tout autre compte, ces badges se gèrent depuis Gestion des comptes.</div>';
    html += PROFILE_BADGES.map(function (b) {
      return '<label class="checklist-item" style="margin-top:0.5rem;"><input type="checkbox" data-self-badge="' + b.field + '"' + (p[b.field] ? ' checked' : '') + '> ' + b.icon + ' ' + escapeHtml(b.label) + '</label>';
    }).join('');
    html += '</div>';
    return html;
  }

  // One toggle per notification category, all opted-in by default (same
  // !== false convention as shareSorties/shareTrophees) except the group-
  // departure one which keeps its own dedicated id/handler (profile-notify,
  // wired to saveProfile, predates this section) since it also drives
  // maybeNotifyGroupDeparture. The other three are plain per-account
  // booleans saved via saveOwnBooleanField and checked by
  // notifCategoryAllowed() wherever that category's event fires -- see
  // maybeNotifyNewTeamInvites and the teamFeed listener in
  // refreshTeamDetailSync. "Nouvelle sortie PRO" has no live trigger yet
  // (events aren't linked to a team in this schema) -- the setting is
  // stored ready for when that lands, but nothing fires from it today.
  function renderNotificationsSettings(p) {
    var isNonRider = p.role === 'accompagnant' || p.role === 'organisateur';
    var html = '<div style="margin-top:1.2rem; border-top:1px solid var(--border); padding-top:0.9rem;">';
    html += '<div class="section-title" style="font-size:0.95rem;">Notifications</div>';
    html += '<div class="help-text">Nécessite d\'autoriser les notifications du navigateur, et que cet onglet reste ouvert.</div>';
    html += '<label class="checklist-item" style="margin-top:0.6rem;"><input type="checkbox" id="profile-notify"' + (p.notifyBeforeSession ? ' checked' : '') + '> <span id="profile-notify-label">' + (isNonRider ? 'Un pilote suivi va partir rouler' : 'Mon groupe va partir rouler') + '</span></label>';
    html += '<label class="checklist-item" style="margin-top:0.4rem;"><input type="checkbox" id="profile-notify-invites"' + (p.notifyInvites !== false ? ' checked' : '') + '> J\'ai reçu une invitation</label>';
    html += '<label class="checklist-item" style="margin-top:0.4rem;"><input type="checkbox" id="profile-notify-team-news"' + (p.notifyTeamNews !== false ? ' checked' : '') + '> Actu de mon Team</label>';
    html += '<label class="checklist-item" style="margin-top:0.4rem;"><input type="checkbox" id="profile-notify-adherent-requests"' + (p.notifyAdherentRequests !== false ? ' checked' : '') + '> Demande d\'adhésion sur un Team que je dirige</label>';
    html += '<label class="checklist-item" style="margin-top:0.4rem;"><input type="checkbox" id="profile-notify-request-decisions"' + (p.notifyRequestDecisions !== false ? ' checked' : '') + '> Réponse à une demande que j\'ai envoyée (ami, rejoindre un Team, devenir adhérent)</label>';
    html += '<label class="checklist-item" style="margin-top:0.4rem;"><input type="checkbox" id="profile-notify-chrono-certified"' + (p.notifyChronoCertified !== false ? ' checked' : '') + '> Un de mes chronos a été vérifié</label>';
    html += '<label class="checklist-item" style="margin-top:0.4rem;"><input type="checkbox" id="profile-notify-reactions"' + (p.notifyReactions !== false ? ' checked' : '') + '> Quelqu\'un a réagi à un de mes posts</label>';
    html += '<label class="checklist-item" style="margin-top:0.4rem;"><input type="checkbox" id="profile-notify-pro-outings"' + (p.notifyProOutings !== false ? ' checked' : '') + '> Nouvel événement organisé par un Team PRO que je suis ou dont je suis adhérent</label>';
    html += '<label class="checklist-item" style="margin-top:0.4rem;"><input type="checkbox" id="profile-notify-coach-messages"' + (p.notifyCoachMessages !== false ? ' checked' : '') + '> Nouveau message dans l\'espace coaching</label>';
    html += '<label class="checklist-item" style="margin-top:0.4rem;"><input type="checkbox" id="profile-notify-event-announcements"' + (p.notifyEventAnnouncements !== false ? ' checked' : '') + '> Annonce du Team Leader sur un événement</label>';
    html += '<label class="checklist-item" style="margin-top:0.4rem;"><input type="checkbox" id="profile-notify-event-ended"' + (p.notifyEventEndedReaction !== false ? ' checked' : '') + '> Un event auquel j\'ai participé vient de se terminer</label>';
    html += '</div>';
    return html;
  }

  function renderProfileReglagesTab(p) {
    var html = renderNotificationsSettings(p);
    html += '<div style="margin-top:1.1rem;"><label style="margin-bottom:0.4rem; display:block;">Thème</label>' + renderThemeToggle() + '</div>';
    // Opt-out, on by default -- a quick "comment c'était ?" prompt after
    // every chrono enregistré, until an account explicitly turns it off
    // (see onSubmit's success handler and renderFeelingModal, both gated
    // on !== false rather than === true).
    html += '<div style="margin-top:1.2rem; border-top:1px solid var(--border); padding-top:0.9rem;">';
    html += '<div class="section-title" style="font-size:0.95rem;">Ressenti après chaque session</div>';
    html += '<label class="checklist-item"><input type="checkbox" id="profile-feeling-enabled"' + (p.sessionFeelingEnabled !== false ? ' checked' : '') + '> Activer le ressenti à ton retour de chaque session</label>';
    html += '<div class="help-text" style="margin-top:0.3rem;">Une fois activé, un chrono enregistré te proposera de dire en un clic comment s\'est passée la session (forme, fatigue...).</div>';
    html += '</div>';
    // What a friend can see when they open your fiche from Social (Mes
    // amis) -- both on by default. Purely a display-level courtesy: every
    // signed-in account can already read sessions/events/users directly,
    // this only controls what shows up in that one card.
    html += '<div style="margin-top:1.2rem; border-top:1px solid var(--border); padding-top:0.9rem;">';
    html += '<div class="section-title" style="font-size:0.95rem;">Réglages social</div>';
    html += '<div class="help-text">Ce que tes amis voient quand ils ouvrent ta fiche depuis Social.</div>';
    html += '<label class="checklist-item" style="margin-top:0.6rem;"><input type="checkbox" id="profile-share-sorties"' + (p.shareSorties !== false ? ' checked' : '') + '> Partager mes événements/chronos</label>';
    html += '<label class="checklist-item" style="margin-top:0.4rem;"><input type="checkbox" id="profile-share-trophees"' + (p.shareTrophees !== false ? ' checked' : '') + '> Partager mes trophées</label>';
    html += '<label class="checklist-item" style="margin-top:0.4rem;"><input type="checkbox" id="profile-share-travel-info"' + (p.shareTravelInfo !== false ? ' checked' : '') + '> Partager mes infos de voyage (avec les amis qui te suivent)</label>';
    html += '</div>';
    if (isAdmin()) html += renderSelfBadges(p);
    // Separate form -- changing the sign-in email needs the current
    // password (Firebase requires a recent reauthentication for it), which
    // has nothing to do with the notify/theme settings above.
    html += '<div style="margin-top:1.2rem; border-top:1px solid var(--border); padding-top:0.9rem;">';
    html += '<div class="section-title" style="font-size:0.95rem;">Compte</div>';
    html += '<form id="profile-email-form">';
    html += '<label>Email actuel<input type="text" value="' + escapeHtml(p.email || '') + '" disabled></label>';
    html += '<label for="profile-new-email" style="margin-top:0.6rem;">Nouvel email</label><input type="email" id="profile-new-email" autocomplete="username">';
    html += '<label for="profile-current-password" style="margin-top:0.6rem;">Mot de passe actuel</label><input type="password" id="profile-current-password" autocomplete="current-password">';
    html += '<div style="margin-top:0.7rem;"><button type="submit" class="ghost">Changer mon email</button></div>';
    if (profileEmailMessage) html += '<div class="help-text" style="margin-top:0.6rem;">' + escapeHtml(profileEmailMessage) + '</div>';
    html += '</form>';
    html += '</div>';
    html += '<div class="danger-zone">';
    html += '<div class="section-title" style="font-size:0.95rem;">Supprimer mon compte</div>';
    if (!profileDeleteConfirmOpen) {
      html += '<div class="help-text">Supprime définitivement ton compte (accès et profil). Tes chronos déjà enregistrés restent visibles pour le groupe.</div>';
      html += '<div style="margin-top:0.7rem;"><button type="button" class="ghost danger" id="delete-account-request-btn">Supprimer mon compte</button></div>';
    } else {
      html += '<form id="profile-delete-account-form">';
      html += '<div class="help-text">Cette action est irréversible. Confirme avec ton mot de passe actuel.</div>';
      html += '<label for="profile-delete-password" style="margin-top:0.6rem;">Mot de passe actuel</label><input type="password" id="profile-delete-password" autocomplete="current-password">';
      html += '<div style="margin-top:0.7rem; display:flex; gap:0.6rem;"><button type="submit" class="ghost danger">Confirmer la suppression</button>' +
        '<button type="button" class="ghost" id="delete-account-cancel-btn">Annuler</button></div>';
      if (profileDeleteMessage) html += '<div class="help-text" style="margin-top:0.6rem;">' + escapeHtml(profileDeleteMessage) + '</div>';
      html += '</form>';
    }
    html += '</div>';
    return html;
  }

  // Sharing this link and someone signing up through it makes p the
  // parrain -- see pendingReferrer/onSignupSubmit. The count below is a
  // live Firestore query (users/{}.referredBy == p.name), not anything
  // synced, hence the "..." while loadFilleulCount resolves it.
  function renderProfileParrainageTab(p) {
    loadFilleulCount(p.name);
    var filleulCount = filleulCounts[p.name];
    var referralLink = referralLinkFor(p.name);
    var html = '<div class="section-title" style="font-size:0.95rem;">Parrainage</div>';
    html += '<div class="help-text">Chaque inscription via ton lien ou ton QR code te compte automatiquement comme parrain.</div>';
    html += '<div class="referral-panel">';
    html += '<img class="referral-qr" src="https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=' + encodeURIComponent(referralLink) + '" alt="QR code du lien de parrainage" width="140" height="140">';
    html += '<div class="referral-actions">';
    html += '<div class="referral-link-text">' + escapeHtml(referralLink) + '</div>';
    html += '<div style="display:flex; gap:0.5rem;">' +
      '<button type="button" class="primary" id="share-referral-link-btn">Partager mon lien</button>' +
      '<button type="button" class="ghost icon-btn" id="copy-referral-link-btn" aria-label="Copier le lien" title="Copier">📋</button>' +
      '</div>';
    html += '<div class="help-text" style="margin-top:0.5rem;">' + (filleulCount == null ? '…' : filleulCount) + ' filleul' + (filleulCount === 1 ? '' : 's') + '</div>';
    html += '</div></div>';
    html += '<div class="referral-milestones">';
    [[1, 'Parrain'], [5, 'Grand parrain']].forEach(function (m) {
      var reached = filleulCount != null && filleulCount >= m[0];
      html += '<div class="referral-milestone' + (reached ? ' reached' : '') + '">' +
        (reached ? '✓' : m[0]) + ' — ' + m[0] + ' filleul' + (m[0] > 1 ? 's' : '') + ' — badge ' + escapeHtml(m[1]) + '</div>';
    });
    html += '</div>';
    return html;
  }
  // One legend for every badge/color the app uses -- reuses PROFILE_BADGES
  // (defined further down) for the account badges themselves rather than
  // duplicating their icon/label/desc, and adds the Team-side ones
  // (✓ Team PRO, Team Leader/Coach name colors, Adhérent, Follower) that
  // have no equivalent entry there.
  function renderBadgesLegend() {
    var rows = PROFILE_BADGES.map(function (b) {
      return '<div class="legend-row"><span class="legend-swatch">' + b.icon + '</span><span>' + escapeHtml(b.desc) + '</span></div>';
    }).join('');
    rows += '<div class="legend-row"><span class="legend-swatch team-pro-badge">✓</span><span>Team PRO — club officiel certifié par l\'administrateur.</span></div>';
    rows += '<div class="legend-row"><span class="legend-swatch pro-leader-name">Nom</span><span>Team Leader d\'un Team PRO.</span></div>';
    rows += '<div class="legend-row"><span class="legend-swatch coach-name">Nom</span><span>Coach.</span></div>';
    rows += '<div class="legend-row"><span class="legend-swatch friend-role-badge adherent-badge">Adhérent</span><span>Adhérent d\'un Team PRO — statut accordé par son Team Leader.</span></div>';
    rows += '<div class="legend-row"><span class="legend-swatch friend-role-badge">Follower</span><span>Suit un Team sans en être membre -- droits limités (voir la fiche du Team).</span></div>';
    return collapsibleSection('badges-legend', 'Que veulent dire ces badges ?', rows, false);
  }

  function renderProfileAideTab(p) {
    var html = '<div class="section-title" style="font-size:0.95rem;">À propos</div>';
    html += '<div class="help-text">Carnet de Piste centralise le planning des événements, les groupes/horaires, tes chronos et ta progression entre pilotes et accompagnants — le tout à jour en temps réel pour tout le monde.</div>';
    html += '<div style="margin-top:1.1rem;"><button type="button" class="ghost" id="tutorial-open-btn">Revoir le tutoriel</button></div>';
    html += '<div style="margin-top:0.9rem;">' + renderBadgesLegend() + '</div>';
    html += renderPartnersSection();
    return html;
  }

  // Retour d'expérience libre vers l'équipe de dev -- pas de backend/mail
  // possible ici (app 100% client + Firestore), donc au plus simple : un
  // formulaire qui écrit dans la collection feedback (lisible seulement
  // par l'admin, voir firestore.rules), et l'admin qui ouvre ce même
  // onglet voit la liste de tout ce qui a été envoyé, comme un document
  // partagé.
  function renderProfileSuggestionTab(p) {
    var html = '<div class="section-title" style="font-size:0.95rem;">Une remarque, une idée ?</div>';
    html += '<div class="help-text">Dis-nous ce qui manque, ce qui bloque ou ce que tu aimerais voir -- ça part directement à l\'équipe de développement.</div>';
    html += '<form id="feedback-form">' +
      '<textarea id="feedback-text" rows="4" placeholder="Ton retour d\'expérience..." required></textarea>' +
      '<button type="submit" class="primary" style="margin-top:0.6rem;">Envoyer</button>' +
      (feedbackMessage ? '<div class="help-text">' + escapeHtml(feedbackMessage) + '</div>' : '') +
      '</form>';
    if (isAdmin()) {
      var items = STATE.feedback || [];
      html += '<div style="margin-top:1.2rem; border-top:1px solid var(--border); padding-top:0.9rem;">';
      html += '<div class="section-title" style="font-size:0.95rem;">Suggestions reçues (' + items.length + ')</div>';
      if (!items.length) {
        html += '<div class="help-text">Rien pour l\'instant.</div>';
      } else {
        html += items.map(function (f) {
          return '<div class="feedback-row">' +
            '<div class="feedback-row-meta">' + escapeHtml(f.author || '?') + ' · ' + (f.createdAt ? new Date(f.createdAt).toLocaleString('fr-FR') : '') + '</div>' +
            '<div class="feedback-row-text">' + escapeHtml(f.text || '') + '</div>' +
            '</div>';
        }).join('');
      }
      html += '</div>';
    }
    return html;
  }

  // Everything that used to live in the header's own account-bar (identity,
  // badges, role, Mon profil/Gestion des comptes/Se déconnecter) now shows
  // up here instead, right when the header's profile-badge avatar is
  // clicked -- the fixed header itself only carries the avatar (see
  // renderRootUnsafe), not this whole bandeau.
  function renderProfilePanel() {
    if (!profilePanelOpen) return '';
    var p = currentUserProfile;
    var html = '<div class="card profile-panel">';
    html += '<div class="account-bar">' +
      '<span class="account-bar-identity">' + escapeHtml(p.name) + badgesHtml(p) + ' · ' + roleLabel(p.role) + '</span>' +
      '<span class="account-bar-actions">' +
        (isAdmin() ? '<button type="button" class="ghost account-bar-btn" id="account-manager-toggle">Gestion des comptes</button>' : '') +
        '<button type="button" class="ghost account-bar-btn" id="logout-btn">Se déconnecter</button>' +
      '</span>' +
    '</div>';
    html += '<div class="section-title">Mon profil</div>';
    html += renderProfileTabBar();
    html += '<div class="profile-tab-body">';
    if (profileSubTab === 'parrainage') html += renderProfileParrainageTab(p);
    else if (profileSubTab === 'reglages') html += renderProfileReglagesTab(p);
    else if (profileSubTab === 'aide') html += renderProfileAideTab(p);
    else if (profileSubTab === 'suggestion') html += renderProfileSuggestionTab(p);
    else html += renderProfileProfilTab(p);
    html += '</div>';
    html += '</div>';
    return html;
  }

  // Shared by the Team detail card's own "Demandes pour rejoindre" section
  // and the header's notifications panel -- the Team Leader picks the
  // resulting status right here rather than a fixed "Membre" outcome.
  function renderTeamJoinRequestRow(r) {
    var u = (STATE.usersByName || {})[r.from] || {};
    var teamName = (teamById(r.teamId) || {}).name || r.teamName;
    return '<div class="team-join-request-row">' +
      '<div class="friend-row-main">' + avatarHtml(u, r.from) + personNameHtml(r.from) + badgesHtml(u) + '</div>' +
      '<div class="help-text">souhaite rejoindre <strong>' + escapeHtml(teamName) + '</strong></div>' +
      '<div class="team-join-request-actions">' +
      '<button type="button" class="primary" data-action="team-join-request-accept" data-id="' + r.id + '" data-role="member">Accepter comme membre</button>' +
      '<button type="button" class="ghost" data-action="team-join-request-accept" data-id="' + r.id + '" data-role="adherent">comme adhérent</button>' +
      '<button type="button" class="ghost" data-action="team-join-request-accept" data-id="' + r.id + '" data-role="leader">comme Team Leader</button>' +
      '<button type="button" class="ghost danger" data-action="team-join-request-remove" data-id="' + r.id + '">Refuser</button>' +
      '</div></div>';
  }

  // Shared by the notifications panel -- a pending "demander à participer"
  // to an Event this account leads the organizing Team of. Was previously
  // only ever visible by opening that exact Event's own management
  // screen (renderEventManagementScreen's "Demandes à accepter") -- easy
  // to miss entirely now that a plain "Membre only" Event (the default)
  // routes even a Team member through this same request flow instead of
  // adding them outright.
  function renderEventJoinRequestRow(r) {
    var u = (STATE.usersByName || {})[r.from] || {};
    var team = teamById(r.teamId);
    return '<div class="friend-row"><div class="friend-row-main">' + avatarHtml(u, r.from) + personNameHtml(r.from) + badgesHtml(u) +
      '<span class="help-text">souhaite participer à ' + escapeHtml(r.circuit || '') + (team ? ' (' + escapeHtml(team.name) + ')' : '') + '</span></div>' +
      '<div class="friend-row-actions">' +
      '<button type="button" class="primary" data-action="event-join-request-accept" data-id="' + r.id + '">Accepter</button>' +
      '<button type="button" class="ghost" data-action="event-join-request-remove" data-id="' + r.id + '">Refuser</button>' +
      '</div></div>';
  }

  // Shared by pendingNotificationCount and renderNotificationsPanel --
  // pending "je veux être adhérent" requests (see requestTeamAdherent)
  // across every team this account leads. STATE.teamFollowersByTeam is
  // already synced for every team the account is in or leads (see
  // refreshTeamDetailSync), so this needs no extra listener of its own.
  function pendingAdherentRequests() {
    var out = [];
    var byTeam = STATE.teamFollowersByTeam || {};
    Object.keys(byTeam).forEach(function (teamId) {
      if (!isLeaderOfTeam(teamId)) return;
      (byTeam[teamId] || []).forEach(function (f) {
        if (f.adherentRequested && f.tier !== 'adherent') out.push(f);
      });
    });
    return out;
  }

  // Shared by the notifications panel -- a pending "devenir adhérent"
  // request for a team this account leads, previously only visible by
  // opening that team's own "Gérer les membres" screen (renderTeamPersonRow's
  // pendingNote), same "invisible until you open the right screen" gap
  // eventJoinRequests had before it joined the 🔔 badge.
  function renderTeamAdherentRequestRow(f) {
    var u = (STATE.usersByName || {})[f.follower] || {};
    var team = teamById(f.followee);
    return '<div class="friend-row"><div class="friend-row-main">' + avatarHtml(u, f.follower) + personNameHtml(f.follower) + badgesHtml(u) +
      '<span class="help-text">souhaite devenir adhérent de ' + escapeHtml(team ? team.name : '') + '</span></div>' +
      '<div class="friend-row-actions">' +
      '<button type="button" class="primary" data-action="team-adherent-accept" data-follow-id="' + f.id + '">Accepter</button>' +
      '<button type="button" class="ghost" data-action="team-adherent-decline" data-follow-id="' + f.id + '">Refuser</button>' +
      '</div></div>';
  }

  // How many items the header's 🔔 notification icon badges up -- every
  // pending thing addressed to this account across the app's request/
  // accept flows (friends, Teams, coaching, Team join requests this
  // account leads, Event join requests for Events it organizes), so the
  // count means "things waiting on you", not an activity-log tally.
  function pendingNotificationCount() {
    var me = currentUserProfile;
    if (!me) return 0;
    var n = 0;
    n += (STATE.friendRequests || []).filter(function (r) { return r.status === 'pending' && r.to === me.name; }).length;
    n += (STATE.teamInvites || []).filter(function (r) { return r.status === 'pending' && r.to === me.name; }).length;
    n += (STATE.coachRequests || []).filter(function (r) { return r.status === 'pending' && (r.from === me.name || r.to === me.name) && coachRequestAwaitingMe(r, me); }).length;
    n += (STATE.teamJoinRequests || []).filter(function (r) { return r.status === 'pending' && isLeaderOfTeam(r.teamId); }).length;
    n += (STATE.eventJoinRequests || []).filter(function (r) { return r.status === 'pending' && teamById(r.teamId) && isLeaderOfTeam(r.teamId); }).length;
    n += pendingAdherentRequests().length;
    return n;
  }

  // Opened from the header's 🔔 icon -- lists exactly the same pending
  // items pendingNotificationCount() counts, each actionable right there
  // via the same data-action handlers their own tab already uses (accept-
  // friend/remove-friend, team-invite-accept/remove, coach-request-
  // accept/remove), so accepting or declining here needs no new wiring.
  function renderNotificationsPanel() {
    if (!notificationsPanelOpen) return '';
    var me = currentUserProfile;
    var html = '<div class="card notifications-panel">';
    html += '<div class="section-title">🔔 Notifications</div>';
    if (!me) { html += '</div>'; return html; }
    var friendReqs = (STATE.friendRequests || []).filter(function (r) { return r.status === 'pending' && r.to === me.name; });
    var teamInvs = (STATE.teamInvites || []).filter(function (r) { return r.status === 'pending' && r.to === me.name; });
    var coachReqs = (STATE.coachRequests || []).filter(function (r) { return r.status === 'pending' && (r.from === me.name || r.to === me.name) && coachRequestAwaitingMe(r, me); });
    var teamJoinReqs = (STATE.teamJoinRequests || []).filter(function (r) { return r.status === 'pending' && isLeaderOfTeam(r.teamId); });
    var eventJoinReqs = (STATE.eventJoinRequests || []).filter(function (r) { return r.status === 'pending' && teamById(r.teamId) && isLeaderOfTeam(r.teamId); });
    var adherentReqs = pendingAdherentRequests();
    var rows = '';
    friendReqs.forEach(function (r) {
      rows += renderFriendRow(r.from, '<button type="button" class="primary" data-action="accept-friend" data-id="' + r.id + '">Accepter</button>' +
        '<button type="button" class="ghost" data-action="remove-friend" data-id="' + r.id + '">Refuser</button>') +
        '<div class="help-text" style="margin:-0.3rem 0 0.6rem;">Demande d\'ami</div>';
    });
    teamInvs.forEach(function (r) {
      rows += '<div class="friend-row"><div class="friend-row-main"><span class="friend-name-plain">' + escapeHtml((teamById(r.teamId) || {}).name || r.teamName) + '</span>' +
        '<span class="help-text">invité par ' + escapeHtml(r.from) + '</span></div><div class="friend-row-actions">' +
        '<button type="button" class="primary" data-action="team-invite-accept" data-id="' + r.id + '">Accepter</button>' +
        '<button type="button" class="ghost" data-action="team-invite-remove" data-id="' + r.id + '">Refuser</button>' +
        '</div></div>';
    });
    coachReqs.forEach(function (r) {
      rows += renderCoachActionRow(r, r.from === me.name ? r.to : r.from);
    });
    teamJoinReqs.forEach(function (r) {
      rows += renderTeamJoinRequestRow(r);
    });
    eventJoinReqs.forEach(function (r) {
      rows += renderEventJoinRequestRow(r);
    });
    adherentReqs.forEach(function (f) {
      rows += renderTeamAdherentRequestRow(f);
    });
    html += rows || '<div class="empty-state">Rien de nouveau.</div>';
    html += '</div>';
    return html;
  }

  // ---- Gestion des comptes (admin) ----
  //
  // Riders (STATE.riders) already have their own admin panel (rename/
  // delete a rider identity); this one is for the users/{uid} accounts
  // themselves -- every role, pilote included -- since that's otherwise
  // nowhere an admin can see an account, walk its role back, or remove its
  // access. The admin's own account never appears here (see isAdmin());
  // they manage themselves from Mon profil like everyone else.
  var accountManagerOpen = false;
  var manageableAccounts = null; // null = not loaded yet; array once fetched
  var accountManagerError = '';
  var pendingDeleteAccountUid = null;

  function loadManageableAccounts() {
    accountManagerError = '';
    db.collection('users').get().then(function (snap) {
      manageableAccounts = snap.docs
        .map(function (doc) { return Object.assign({ uid: doc.id }, doc.data()); })
        .filter(function (a) { return a.email !== ADMIN_EMAIL; })
        .sort(function (a, b) { return (a.name || '').localeCompare(b.name || ''); });
      renderRoot();
    }).catch(function (err) {
      accountManagerError = 'Erreur : ' + (err && err.message ? err.message : err);
      renderRoot();
    });
  }

  // Free-text filter over manageableAccounts (name or email, case/accent
  // insensitive-ish) -- the search this panel needed once it's the only
  // place left to find a pilote among however many accounts exist,
  // now that the old top-of-page Pilote picker is gone entirely.
  var accountManagerSearch = '';
  function filteredManageableAccounts() {
    var q = accountManagerSearch.trim().toLowerCase();
    if (!q) return manageableAccounts || [];
    return (manageableAccounts || []).filter(function (a) {
      return (a.name || '').toLowerCase().indexOf(q) !== -1 || (a.email || '').toLowerCase().indexOf(q) !== -1;
    });
  }

  function renderAccountManagerPanel() {
    if (!accountManagerOpen) return '';
    var html = '<button type="button" class="ghost" id="account-manager-back" style="margin-bottom:0.6rem;">← Retour à Mon profil</button>';
    html += '<div class="card account-manager-panel">';
    html += '<div class="section-title" style="display:flex; align-items:center; justify-content:space-between;">Gestion des comptes' +
      '<button type="button" class="ghost icon-btn" id="rider-manager-toggle" aria-label="Gérer les pilotes (roster)" title="Gérer les pilotes (roster)">⚙</button></div>';
    if (manageableAccounts === null) {
      html += '<div class="help-text">Chargement...</div>';
    } else {
      html += '<input type="text" id="account-manager-search" placeholder="Rechercher un pilote, accompagnant, organisateur..." value="' + escapeHtml(accountManagerSearch) + '" style="margin-bottom:0.8rem;">';
      var accounts = filteredManageableAccounts();
      if (!manageableAccounts.length) {
        html += '<div class="help-text">Aucun compte pour l\'instant.</div>';
      } else if (!accounts.length) {
        html += '<div class="help-text">Aucun résultat pour « ' + escapeHtml(accountManagerSearch) + ' ».</div>';
      } else {
      html += '<ul class="rider-manager-list">' + accounts.map(function (a) {
        var isPendingDelete = pendingDeleteAccountUid === a.uid;
        var isPilote = !a.role || a.role === 'pilote';
        var detail = isPilote ? escapeHtml(a.bike || '—') : escapeHtml((a.followedRiders || []).join(', ') || '—');
        return '<li class="rider-manager-row account-manager-row">' +
          '<div><span class="rider-manager-name' + nameColorClass(a.name) + '">' + escapeHtml(a.name || a.email) + '</span>' + badgesHtml(a) + ' <span class="friend-role-badge">' + roleLabel(a.role) + '</span>' +
          '<div class="help-text">' + escapeHtml(a.email || '') + ' · ' + (isPilote ? 'moto : ' : 'suit : ') + detail + '</div></div>' +
          (isPilote ? '' : '<button type="button" class="ghost icon-btn" data-action="demote-account" data-uid="' + a.uid + '" aria-label="Repasser en pilote" title="Repasser en pilote">↺</button>') +
          PROFILE_BADGES.map(function (b) {
            var on = !!a[b.field];
            var title = (on ? 'Retirer ' : 'Marquer ') + b.label;
            return '<button type="button" class="ghost icon-btn' + (on ? ' confirm' : '') + '" data-action="toggle-account-badge" data-uid="' + a.uid + '" data-field="' + b.field + '" aria-label="' + escapeHtml(title) + '" title="' + escapeHtml(title) + '">' + b.icon + '</button>';
          }).join('') +
          '<button type="button" class="ghost icon-btn' + (isPendingDelete ? ' confirm' : ' danger') + '" data-action="delete-account-request" data-uid="' + a.uid + '" aria-label="Supprimer ce compte" title="Retirer l\'accès">' + (isPendingDelete ? '✓' : '×') + '</button>' +
          '</li>';
      }).join('') + '</ul>';
      }
    }
    if (accountManagerError) html += '<div class="field-error visible">' + escapeHtml(accountManagerError) + '</div>';
    html += renderRiderManagerPanel();
    html += renderTeamManagerPanel();
    html += '</div>';
    return html;
  }

  // Admin-only: mark a Team as "Team PRO" -- STATE.teams already syncs
  // every team in full for everyone (it's a small collection, just
  // identity fields), so no separate fetch is needed here the way
  // manageableAccounts needs its own query.
  function renderTeamManagerPanel() {
    var teams = (STATE.teams || []).slice().sort(function (a, b) { return a.name.localeCompare(b.name); });
    if (!teams.length) return '';
    var html = '<div class="section-title" style="font-size:0.95rem; margin-top:1.2rem; border-top:1px solid var(--border); padding-top:0.9rem;">Gestion des Teams</div>';
    html += '<ul class="rider-manager-list">' + teams.map(function (t) {
      var deleteControl = pendingDeleteTeamId !== t.id
        ? '<button type="button" class="ghost icon-btn danger" data-action="admin-team-delete-request" data-team="' + t.id + '" aria-label="Supprimer ce Team" title="Supprimer ce Team">×</button>'
        : '';
      var row = '<li class="rider-manager-row account-manager-row">' +
        '<div><span class="rider-manager-name">' + escapeHtml(t.name) + '</span>' + teamBadgesHtml(t) +
        '<div class="help-text">créé par ' + escapeHtml(t.createdBy) + '</div></div>' +
        '<button type="button" class="ghost icon-btn' + (t.teamPro ? ' confirm' : '') + '" data-action="toggle-team-pro" data-team="' + t.id + '" aria-label="' + (t.teamPro ? 'Retirer Team PRO' : 'Marquer Team PRO') + '" title="' + (t.teamPro ? 'Retirer Team PRO' : 'Marquer Team PRO') + '">✓</button>' +
        deleteControl +
        '</li>';
      // Same password-confirmation dance as a Team Leader deleting their
      // own Team from Réglages (see deleteTeam/team-delete-form) -- every
      // delete button in this app requires it, and the admin is no
      // exception just because isAdmin() also happens to bypass the
      // ownership check server-side.
      if (pendingDeleteTeamId === t.id) {
        row += '<li class="rider-manager-row"><form id="admin-team-delete-form" data-team="' + t.id + '" style="width:100%;">' +
          '<div class="help-text">Supprimer "' + escapeHtml(t.name) + '" est irréversible. Confirme avec ton mot de passe actuel.</div>' +
          '<label for="admin-team-delete-password" style="margin-top:0.6rem;">Mot de passe actuel</label>' +
          '<input type="password" id="admin-team-delete-password" autocomplete="current-password">' +
          '<div style="margin-top:0.7rem; display:flex; gap:0.6rem;">' +
          '<button type="submit" class="ghost danger">Confirmer la suppression</button>' +
          '<button type="button" class="ghost" data-action="admin-team-delete-cancel">Annuler</button></div>' +
          (teamDeleteMessage ? '<div class="help-text" style="margin-top:0.6rem;">' + escapeHtml(teamDeleteMessage) + '</div>' : '') +
          '</form></li>';
      }
      return row;
    }).join('') + '</ul>';
    return html;
  }

  var profileSaveMessage = '';
  // Moves each of this account's own teamMembers docs from the old
  // name-keyed id to the new one, preserving role -- otherwise a rename
  // silently orphans the old doc (still there, still correct data, but
  // firestore.rules' isTeamLeader()/isTeamMember() look it up by the
  // CURRENT name, which no longer matches its id) and every Team-Leader-
  // gated action starts failing with no obvious cause. migratedFromId
  // lets firestore.rules verify (via uid, not the self-reported name)
  // that the new doc is a genuine continuation of an account's own prior
  // membership, not a way to self-grant a role never actually held.
  function migrateTeamMembershipsForRename(oldName, newName, memberships) {
    var uid = auth.currentUser && auth.currentUser.uid;
    if (!uid) return Promise.resolve();
    return Promise.all((memberships || []).map(function (m) {
      var oldId = teamMemberDocId(m.teamId, oldName);
      var newId = teamMemberDocId(m.teamId, newName);
      return db.collection('teamMembers').doc(newId).set({
        teamId: m.teamId, name: newName, role: m.role, uid: uid,
        joinedAt: m.joinedAt || Date.now(),
        teamRole: m.teamRole || null,
        migratedFromId: oldId
      }).then(function () {
        return db.collection('teamMembers').doc(oldId).delete();
      }).catch(function (err) {
        showToast('Erreur de migration Team : ' + (err && err.message ? err.message : err));
      });
    }));
  }

  // Rate limit for a pseudo change -- 1 per 30 days, enforced both here
  // (immediate, friendly message) and server-side in firestore.rules
  // (users update: request.time > lastNameChangeAt + duration.value(30,'d'),
  // stamped with request.time so it can't be spoofed by a client-supplied
  // value). Returns null if allowed, or the date the next change becomes
  // possible.
  var RENAME_COOLDOWN_DAYS = 30;
  function renameAllowedAt(p) {
    var last = p && p.lastNameChangeAt;
    if (!last) return null;
    var lastMs = typeof last.toMillis === 'function' ? last.toMillis() : (last.seconds ? last.seconds * 1000 : null);
    if (!lastMs) return null;
    var nextMs = lastMs + RENAME_COOLDOWN_DAYS * 24 * 60 * 60 * 1000;
    return nextMs > Date.now() ? new Date(nextMs) : null;
  }

  // Every collection carrying a plain (auto-id) name-bearing field this
  // account might own -- see firestore.rules' canRenameField/
  // canBackfillUid. Doc-id-embedded-name collections (teamMembers,
  // teamLikes, teamJoinRequests, teamInvites' "to" side, eventTravelInfo)
  // are migrated separately below since renaming them in place would
  // leave their id pointing at the old name forever (see
  // migrateGroupBForRename).
  function groupARenameSpecs() {
    return [
      { coll: 'friendRequests', field: 'from', uidField: 'fromUid' },
      { coll: 'friendRequests', field: 'to', uidField: 'toUid' },
      { coll: 'coachRequests', field: 'from', uidField: 'fromUid' },
      { coll: 'coachRequests', field: 'to', uidField: 'toUid' },
      { coll: 'coachMessages', field: 'from', uidField: 'uid' },
      { coll: 'follows', field: 'follower', uidField: 'followerUid' },
      { coll: 'follows', field: 'followee', uidField: 'followeeUid', skip: function (d) { return d.followeeType === 'team'; } },
      { coll: 'teamInvites', field: 'from', uidField: 'fromUid' },
      { coll: 'teamFeed', field: 'author', uidField: 'authorUid' },
      { coll: 'wallPosts', field: 'author', uidField: 'authorUid' },
      { coll: 'eventAnnouncements', field: 'from', uidField: 'fromUid' },
      // sessions.rider deliberately lives here, not in
      // renameRiderEverywhere/persist() -- that path's rule (ownsChrono
      // on both the before AND after rider value) can never hold during
      // an actual rename for a non-admin account, since myName() only
      // ever resolves to one value at a time. Handled with the same
      // uid-based rename as everything else above instead (see
      // firestore.rules' sessions update rule).
      { coll: 'sessions', field: 'rider', uidField: 'uid' }
    ];
  }
  // Queried once, up front, while this account's own name (per
  // firestore.rules' myName()) still resolves to oldName -- both the
  // pre-rename uid backfill and the query itself depend on that.
  function fetchGroupARenameTargets(oldName) {
    return Promise.all(groupARenameSpecs().map(function (spec) {
      return db.collection(spec.coll).where(spec.field, '==', oldName).get().then(function (snap) {
        var docs = [];
        snap.forEach(function (doc) {
          var d = doc.data();
          if (spec.skip && spec.skip(d)) return;
          docs.push({ ref: doc.ref, data: d });
        });
        return { spec: spec, docs: docs };
      }).catch(function () { return { spec: spec, docs: [] }; });
    }));
  }
  function backfillGroupAUids(results, myUidVal) {
    var batch = db.batch(), n = 0;
    results.forEach(function (r) {
      r.docs.forEach(function (d) {
        if (d.data[r.spec.uidField] == null) {
          var patch = {}; patch[r.spec.uidField] = myUidVal;
          batch.update(d.ref, patch);
          n++;
        }
      });
    });
    return n ? batch.commit() : Promise.resolve();
  }
  function applyGroupARenames(results, newName) {
    var batch = db.batch(), n = 0;
    results.forEach(function (r) {
      r.docs.forEach(function (d) {
        var patch = {}; patch[r.spec.field] = newName;
        batch.update(d.ref, patch);
        n++;
      });
    });
    return n ? batch.commit() : Promise.resolve();
  }
  // Catches up any Group A doc left stale by a rename that didn't go
  // through saveProfile's own migration above -- namely a pseudo edited
  // directly in the Firestore console (bypasses the app entirely, so
  // fetchGroupARenameTargets/applyGroupARenames never ran) rather than via
  // "Modifier le pseudo". Queried by uidField (not by an old name we don't
  // know), so it self-heals regardless of how many times or how the name
  // actually changed -- e.g. a wallPost still carrying author:"Xavier"
  // long after that account renamed itself to "Xav" straight in the
  // database, which left it unable to delete/react to its own old post
  // (resource.data.author == myName() no longer matched). Fires once,
  // silently, right after sign-in (see onAuthStateChanged) -- canRenameField
  // already permits exactly this (uid-proven, one field, new value ==
  // current myName()), this just triggers it proactively instead of only
  // during a live rename.
  function selfHealStaleNames(uid, currentName) {
    Promise.all(groupARenameSpecs().map(function (spec) {
      return db.collection(spec.coll).where(spec.uidField, '==', uid).get().then(function (snap) {
        var batch = db.batch(), n = 0;
        snap.forEach(function (doc) {
          var d = doc.data();
          if (spec.skip && spec.skip(d)) return;
          if (d[spec.field] === currentName) return;
          var patch = {}; patch[spec.field] = currentName;
          batch.update(doc.ref, patch);
          n++;
        });
        return n ? batch.commit() : Promise.resolve();
      }).catch(function () {});
    }));
  }
  // The doc-id-embedded-name collections -- recreate under the new id
  // (migratedFromId + uid, same shape as migrateTeamMembershipsForRename)
  // and delete the old one, run only after the users doc rename has
  // landed (myName() now resolves to newName, which each create rule
  // checks the new doc against).
  function migrateGroupBForRename(oldName, newName, myUidVal) {
    var jobs = [];
    jobs.push(db.collection('teamLikes').where('name', '==', oldName).get().then(function (snap) {
      var ops = [];
      snap.forEach(function (doc) {
        var d = doc.data();
        ops.push(db.collection('teamLikes').doc(teamMemberDocId(d.teamId, newName)).set({
          teamId: d.teamId, name: newName, uid: myUidVal, migratedFromId: doc.id
        }).then(function () { return db.collection('teamLikes').doc(doc.id).delete(); }));
      });
      return Promise.all(ops);
    }));
    jobs.push(db.collection('teamJoinRequests').where('from', '==', oldName).get().then(function (snap) {
      var ops = [];
      snap.forEach(function (doc) {
        var d = doc.data();
        ops.push(db.collection('teamJoinRequests').doc(teamMemberDocId(d.teamId, newName)).set({
          teamId: d.teamId, teamName: d.teamName, from: newName, kind: d.kind, status: d.status,
          uid: myUidVal, migratedFromId: doc.id
        }).then(function () { return db.collection('teamJoinRequests').doc(doc.id).delete(); }));
      });
      return Promise.all(ops);
    }));
    jobs.push(db.collection('teamInvites').where('to', '==', oldName).get().then(function (snap) {
      var ops = [];
      snap.forEach(function (doc) {
        var d = doc.data();
        ops.push(db.collection('teamInvites').doc(teamInviteDocId(d.teamId, newName)).set({
          teamId: d.teamId, teamName: d.teamName, from: d.from, fromUid: d.fromUid || null,
          to: newName, toUid: myUidVal, status: d.status, migratedFromId: doc.id
        }).then(function () { return db.collection('teamInvites').doc(doc.id).delete(); }));
      });
      return Promise.all(ops);
    }));
    jobs.push(db.collection('eventTravelInfo').where('rider', '==', oldName).get().then(function (snap) {
      var ops = [];
      snap.forEach(function (doc) {
        var d = doc.data();
        var eventId = doc.id.slice(0, doc.id.length - ('_' + oldName).length);
        var newData = Object.assign({}, d, { rider: newName, uid: myUidVal, migratedFromId: doc.id });
        ops.push(db.collection('eventTravelInfo').doc(eventId + '_' + newName).set(newData)
          .then(function () { return db.collection('eventTravelInfo').doc(doc.id).delete(); }));
      });
      return Promise.all(ops);
    }));
    return Promise.all(jobs);
  }

  function saveProfile(role, notifyBeforeSession, followedRiders, bike, bikeNumber, newRawName, firstName, lastName, chronoLink) {
    var uid = auth.currentUser && auth.currentUser.uid;
    if (!uid || !currentUserProfile) return;
    if (notifyBeforeSession && window.Notification && Notification.permission === 'default') {
      Notification.requestPermission();
    }
    var oldName = currentUserProfile.name;
    var finalName = oldName;
    var renamePrevState = null;
    var nameChanged = false;
    // Snapshot now -- migrateTeamMembershipsForRename needs to know which
    // teams/roles to carry over to the new name, and this account's own
    // teamMembers docs are about to become unreachable by the usual
    // name-keyed lookups the instant the rename below succeeds.
    var teamMembershipsBeforeRename = (STATE.myTeamMemberships || []).slice();
    if (newRawName) {
      var result = resolveUniquePseudo(newRawName, allKnownRiders(), oldName);
      if (!result.ok) {
        profileSaveMessage = result.error;
        renderRoot();
        return;
      }
      if (result.name !== oldName) {
        var blockedUntil = renameAllowedAt(currentUserProfile);
        if (blockedUntil) {
          profileSaveMessage = 'Un seul changement de pseudo par mois -- possible à nouveau le ' + blockedUntil.toLocaleDateString('fr-FR') + '.';
          renderRoot();
          return;
        }
        nameChanged = true;
        finalName = result.name;
        var isKnownRider = allKnownRiders().indexOf(oldName) !== -1;
        if (isKnownRider) {
          renamePrevState = renameRiderEverywhere(oldName, finalName);
          // sessions.rider is migrated separately (see
          // groupARenameSpecs/applyGroupARenames) -- revert STATE.sessions
          // back to their pre-rename values so the persist() call below
          // only ever touches riders/events for this rename. Firestore
          // batches are all-or-nothing: bundling a sessions write here
          // too would poison the whole batch the instant a non-admin
          // account's sessions can't yet satisfy the old ownsChrono-based
          // rule (see that rule's own comment), silently rolling back the
          // riders/events changes as well.
          STATE.sessions = renamePrevState.sessions;
        }
      }
    }
    var writes = { role: role, notifyBeforeSession: notifyBeforeSession, followedRiders: followedRiders, bike: bike || null, bikeNumber: bikeNumber || null,
      firstName: firstName || null, lastName: lastName || null, chronoLink: chronoLink || null };
    if (nameChanged) writes.name = finalName;
    // When the pseudo changes, every other collection that carries it has
    // to be found and backfilled with its owner's uid *before* this write
    // lands (see fetchGroupARenameTargets/backfillGroupAUids -- both rely
    // on myName() still resolving to oldName), then the write itself
    // stamps lastNameChangeAt (server time, for the 30-day rate limit),
    // and only then can each found doc actually be renamed (myName() now
    // resolves to finalName, which canRenameField checks the new value
    // against) alongside the doc-id-embedded-name collections (Group B)
    // and the pre-existing teamMembers/rider/session/event cascades.
    var groupATargets = null;
    (nameChanged ? fetchGroupARenameTargets(oldName).then(function (results) {
      groupATargets = results;
      return backfillGroupAUids(results, uid);
    }) : Promise.resolve()).then(function () {
      if (nameChanged) writes.lastNameChangeAt = firebase.firestore.FieldValue.serverTimestamp();
      return db.collection('users').doc(uid).set(writes, { merge: true });
    }).then(function () {
      // Covers switching to Pilote (or renaming while already one) without
      // ever having gone through onSignupSubmit's own rider-doc creation.
      if (role === 'pilote') {
        return db.collection('riders').doc(safeDocId(finalName)).set({ name: finalName }, { merge: true });
      }
    }).then(function () {
      currentUserProfile.name = finalName;
      currentUserProfile.role = role;
      currentUserProfile.notifyBeforeSession = notifyBeforeSession;
      currentUserProfile.followedRiders = followedRiders;
      currentUserProfile.bike = bike || null;
      currentUserProfile.bikeNumber = bikeNumber || null;
      currentUserProfile.firstName = firstName || null;
      currentUserProfile.lastName = lastName || null;
      currentUserProfile.chronoLink = chronoLink || null;
      profileSaveMessage = 'Profil enregistré.';
      renderRoot();
      if (nameChanged) {
        // Team memberships first, and awaited -- persist() below may touch
        // a team-owned event, and its rule needs isTeamLeader() to find
        // this account's teamMembers doc under its NEW name (see that
        // doc's own migratedFromId dance); starting it concurrently with
        // persist() risked the event write landing first and finding no
        // migrated doc yet, denying it.
        migrateTeamMembershipsForRename(oldName, finalName, teamMembershipsBeforeRename).then(function () {
          refreshMyTeamMembershipsSync();
          if (renamePrevState) persist(renamePrevState);
        });
        if (groupATargets) applyGroupARenames(groupATargets, finalName).catch(function (err) {
          showToast('Migration partielle : ' + (err && err.message ? err.message : err));
        });
        migrateGroupBForRename(oldName, finalName, uid).catch(function (err) {
          showToast('Migration partielle : ' + (err && err.message ? err.message : err));
        });
      }
    }).catch(function (err) {
      profileSaveMessage = 'Erreur : ' + (err && err.message ? err.message : err);
      renderRoot();
    });
  }

  // Stored as a small base64 data URL directly on the users/{uid} doc --
  // resized client-side first (see resizeImageToDataUrl) so it stays well
  // under Firestore's 1MB document limit, avoiding a whole separate
  // Firebase Storage setup (bucket rules, upload code) for a single avatar.
  var profilePhotoMessage = '';
  function savePhoto(dataUrl) {
    var uid = auth.currentUser && auth.currentUser.uid;
    if (!uid || !currentUserProfile) return;
    db.collection('users').doc(uid).set({ photoURL: dataUrl || null }, { merge: true }).then(function () {
      currentUserProfile.photoURL = dataUrl || null;
      profilePhotoMessage = '';
      renderRoot();
    }).catch(function (err) {
      profilePhotoMessage = 'Erreur : ' + (err && err.message ? err.message : err);
      renderRoot();
    });
  }

  // Retour d'expérience -- voir renderProfileSuggestionTab. Append-only,
  // pas de mail (pas de backend), lu par l'admin directement dans l'app.
  var feedbackMessage = '';
  function sendFeedback(text) {
    text = (text || '').trim();
    if (!text || !currentUserProfile) return;
    var uid = auth.currentUser && auth.currentUser.uid;
    if (!uid) return;
    db.collection('feedback').add({
      text: text, author: currentUserProfile.name, authorUid: uid, createdAt: Date.now()
    }).then(function () {
      feedbackMessage = 'Merci, ton retour a bien été envoyé !';
      renderRoot();
    }).catch(function (err) {
      feedbackMessage = 'Erreur : ' + (err && err.message ? err.message : err);
      renderRoot();
    });
  }

  // Generic instant-save for a single boolean field on the connected
  // account's own doc -- the sharing toggles (shareSorties/shareTrophees)
  // and, for the admin only, their own badge checkboxes (see
  // renderSelfBadges) both just call this with a different field name.
  function saveOwnBooleanField(field, value) {
    var uid = auth.currentUser && auth.currentUser.uid;
    if (!uid || !currentUserProfile) return;
    // Only saveProfile's own notifyBeforeSession checkbox used to trigger
    // the browser's native permission prompt -- every other "notify..."
    // category added since (notifyInvites, notifyAdherentRequests, etc.)
    // just checked Notification.permission without ever asking for it, so
    // checking ONLY one of those and never notifyBeforeSession meant
    // nothing would ever actually fire, silently. Any notify* category
    // being turned on now asks, same as notifyBeforeSession always has.
    if (value && field.indexOf('notify') === 0 && window.Notification && Notification.permission === 'default') {
      Notification.requestPermission();
    }
    var writes = {};
    writes[field] = value;
    db.collection('users').doc(uid).set(writes, { merge: true }).then(function () {
      currentUserProfile[field] = value;
      renderRoot();
    }).catch(function (err) {
      showToast('Erreur : ' + (err && err.message ? err.message : err));
    });
  }

  // Downscales to at most maxSize on the longer side and re-encodes as a
  // compressed JPEG -- a photo straight off a phone can be several MB, but
  // an avatar only ever needs to be shown a few dozen pixels across.
  function resizeImageToDataUrl(file, maxSize, quality, callback) {
    var reader = new FileReader();
    reader.onload = function () {
      var img = new Image();
      img.onload = function () {
        var scale = Math.min(1, maxSize / Math.max(img.width, img.height));
        var canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        var ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        callback(canvas.toDataURL('image/jpeg', quality));
      };
      img.onerror = function () { callback(null); };
      img.src = reader.result;
    };
    reader.onerror = function () { callback(null); };
    reader.readAsDataURL(file);
  }

  // Changing the sign-in email requires Firebase to see a recent
  // reauthentication, hence asking for the current password again here --
  // it's the same account, just a different credential check than signup.
  var profileEmailMessage = '';
  function changeProfileEmail(newEmail, currentPassword) {
    var user = auth.currentUser;
    if (!user || !currentUserProfile) return;
    if (!newEmail || !currentPassword) {
      profileEmailMessage = 'Indique le nouvel email et ton mot de passe actuel.';
      renderRoot();
      return;
    }
    var cred = firebase.auth.EmailAuthProvider.credential(user.email, currentPassword);
    user.reauthenticateWithCredential(cred).then(function () {
      return user.updateEmail(newEmail);
    }).then(function () {
      return db.collection('users').doc(user.uid).set({ email: newEmail }, { merge: true });
    }).then(function () {
      currentUserProfile.email = newEmail;
      return user.sendEmailVerification();
    }).then(function () {
      // updateEmail() resets emailVerified server-side, so the app has to
      // hold here again until the new address is confirmed -- same gate as
      // a fresh signup.
      autoVerifyEmailSent = true;
      authState = 'verify-email';
      profilePanelOpen = false;
      renderRoot();
      showToast('Email mis à jour — vérifie ta boîte mail pour confirmer la nouvelle adresse.', 'success');
    }).catch(function (err) {
      profileEmailMessage = translateAuthError(err);
      renderRoot();
    });
  }

  // Deleting the account only removes the users/{uid} profile doc and the
  // Firebase Auth account itself -- past chronos and rider-roster entries
  // stay (they're shared history other riders' stats/records depend on,
  // and belong to the rider name, not the account). Requires the same
  // fresh reauthentication as an email change.
  var profileDeleteMessage = '';
  function deleteMyAccount(currentPassword) {
    var user = auth.currentUser;
    if (!user || !currentUserProfile) return;
    if (!currentPassword) {
      profileDeleteMessage = 'Indique ton mot de passe actuel pour confirmer.';
      renderRoot();
      return;
    }
    var cred = firebase.auth.EmailAuthProvider.credential(user.email, currentPassword);
    var uid = user.uid;
    user.reauthenticateWithCredential(cred).then(function () {
      return db.collection('users').doc(uid).delete();
    }).then(function () {
      return user.delete();
    }).catch(function (err) {
      profileDeleteMessage = translateAuthError(err);
      renderRoot();
    });
  }

  // Riders are keyed by their display name throughout the app (sessions,
  // riderGroups, checklist...), so the pseudo itself must stay unique --
  // two people who happen to share a first name need a distinguishable
  // pseudo (e.g. "Julien" / "Julien P."), not a hidden bike-number suffix:
  // that number is now purely "Ma moto" in Mon profil, a single field with
  // nothing to do with identity (see also renderEventManagementScreen's
  // per-event override, a separate, event-scoped number an orga can set).
  // Shared by adding a rider, the admin rename, a pilote renaming
  // themselves from "Mon profil", and signup -- one collision rule
  // everywhere a pseudo gets typed in. excludeName lets a rename/self-
  // rename compare against every OTHER rider without tripping over its
  // own current name.
  function resolveUniquePseudo(rawName, known, excludeName) {
    var name = (rawName || '').trim();
    if (!name) return { ok: false, error: 'Indique un pseudo.' };
    if (known.some(function (r) { return r !== excludeName && r.toLowerCase() === name.toLowerCase(); })) {
      return { ok: false, error: 'Ce pseudo est déjà utilisé -- ajoute par exemple ton numéro de course (ex. "Julien #12").' };
    }
    return { ok: true, name: name };
  }

  function addRider(name) {
    riderManagerError = '';
    var result = resolveUniquePseudo(name, allKnownRiders(), null);
    if (!result.ok) {
      riderManagerError = result.error;
      renderRoot();
      return;
    }
    var prevState = JSON.parse(JSON.stringify(STATE));
    STATE.riders = allKnownRiders().concat([result.name]).sort(function (a, b) { return a.localeCompare(b); });
    renderRoot();
    persist(prevState);
    showToast('Pilote ajouté.', 'success');
  }

  // Cascades a rider name change through everything keyed off it --
  // STATE.riders, sessions, event.riders, and event.riderGroups -- and
  // returns the pre-mutation snapshot for the caller to persist(). Doesn't
  // touch the users/{uid} account doc itself; callers that also need that
  // (self-rename) do it separately since it's a different collection.
  function renameRiderEverywhere(oldName, newName) {
    var prevState = JSON.parse(JSON.stringify(STATE));
    var known = allKnownRiders();
    STATE.riders = known.map(function (r) { return r === oldName ? newName : r; }).sort(function (a, b) { return a.localeCompare(b); });
    STATE.sessions.forEach(function (s) { if (s.rider === oldName) s.rider = newName; });
    eventsList().forEach(function (ev) {
      if (ev.riders && ev.riders.length) {
        ev.riders = ev.riders.map(function (r) { return r === oldName ? newName : r; });
        // A rename can turn two entries into duplicates (rider already
        // there under the new name) -- collapse them.
        var seen = {};
        ev.riders = ev.riders.filter(function (r) { return seen[r] ? false : (seen[r] = true); });
      }
      if (ev.riderGroups && ev.riderGroups[oldName]) {
        ev.riderGroups[newName] = ev.riderGroups[oldName];
        delete ev.riderGroups[oldName];
      }
    });
    if (selectedRiders && selectedRiders.has(oldName)) {
      selectedRiders.delete(oldName);
      selectedRiders.add(newName);
    }
    return prevState;
  }

  function renameRider(oldName, newName) {
    riderManagerError = '';
    var conflict = allKnownRiders().some(function (r) { return r !== oldName && r.toLowerCase() === newName.toLowerCase(); });
    if (conflict) {
      riderManagerError = 'Ce pilote existe déjà.';
      editingRiderName = null;
      renderRoot();
      return;
    }
    var prevState = renameRiderEverywhere(oldName, newName);
    editingRiderName = null;
    renderRoot();
    persist(prevState);
    showToast('Pilote renommé.', 'success');
  }

  function deleteRider(name) {
    riderManagerError = '';
    var hasSessions = STATE.sessions.some(function (s) { return s.rider === name; });
    var hasEvents = eventsList().some(function (ev) { return (ev.riders || []).indexOf(name) !== -1; });
    if (hasSessions || hasEvents) {
      riderManagerError = 'Ce pilote a des chronos ou des événements enregistrés — supprimez-les ou renommez plutôt le pilote.';
      pendingDeleteRider = null;
      renderRoot();
      return;
    }
    var prevState = JSON.parse(JSON.stringify(STATE));
    STATE.riders = (STATE.riders || []).filter(function (r) { return r !== name; });
    if (selectedRiders) selectedRiders.delete(name);
    pendingDeleteRider = null;
    renderRoot();
    persist(prevState);
    showToast('Pilote supprimé.', 'success');
  }

  // Every rider+circuit's personal-best progression, walked in chronological
  // order, so we can tell exactly which sessions actually beat a previous
  // record and when -- as opposed to riderCircuitBest()/the session table's
  // RECORD pill, which only flag today's all-time best, not the history of
  // who beat what. A session only counts as "battu" (beaten) when it
  // improves on a real prior best; the very first session on a circuit sets
  // one but doesn't beat anything, so it's excluded.
  function personalRecordsBrokenInYear(year, riderFilter) {
    var groups = {};
    STATE.sessions.forEach(function (s) {
      if (riderFilter && !riderFilter.has(s.rider)) return;
      var key = s.rider + '||' + s.circuit;
      groups[key] = groups[key] || [];
      groups[key].push(s);
    });
    var records = [];
    Object.keys(groups).forEach(function (key) {
      var sessions = groups[key].slice().sort(function (a, b) {
        if (a.date !== b.date) return a.date < b.date ? -1 : 1;
        return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0);
      });
      var running = null;
      sessions.forEach(function (s) {
        var b = sessionBest(s);
        if (running !== null && b < running && s.date.slice(0, 4) === year) {
          records.push({ rider: s.rider, circuit: s.circuit, date: s.date, time: b, previous: running });
        }
        if (running === null || b < running) running = b;
      });
    });
    records.sort(function (a, b) { return a.date < b.date ? 1 : a.date > b.date ? -1 : 0; });
    return records;
  }

  // Gains are usually well under a minute, so a bare "0.514s" reads faster
  // than the m:ss.mmm format used for absolute times -- fall back to
  // formatTime() only for the rare gain that spans a full minute.
  function formatGain(seconds) {
    if (seconds >= 60) return formatTime(seconds);
    return seconds.toFixed(3) + 's';
  }

  // Records battus, scoped to this one rider and folded right into their
  // own stats card, right after Chronos vérifiés -- no longer a separate
  // "à part" card sitting between the rider list and the Trophées cards.
  function renderRiderRecordsCategory(riderName) {
    var year = String(new Date().getFullYear());
    var records = personalRecordsBrokenInYear(year, new Set([riderName]));
    var detail = '';
    if (records.length) {
      detail = '<div class="table-scroll"><table class="session-table"><thead><tr><th>Date</th><th>Circuit</th><th>Nouveau temps</th><th>Gain</th></tr></thead><tbody>';
      records.forEach(function (r) {
        detail += '<tr><td>' + escapeHtml(formatDateShortYear(r.date)) + '</td><td>' + escapeHtml(r.circuit) + '</td>' +
          '<td class="laps-cell">' + formatTime(r.time) + '<span class="record-pill">RECORD</span></td>' +
          '<td class="gain-cell">-' + formatGain(r.previous - r.time) + '</td></tr>';
      });
      detail += '</tbody></table></div>';
    }
    return renderStatSummaryCategory('records-' + year + '-' + riderName, 'Records battus en ' + year, records.length, detail);
  }

  function renderStatsTab() {
    var me = currentUserProfile;
    var html = '';
    var isNonRider = !!(me && (me.role === 'accompagnant' || me.role === 'organisateur'));
    var nonRiderAch = isNonRider ? (me.role === 'organisateur' ? organisateurAchievements(me) : accompagnantAchievements(me)) : null;
    var riders = allKnownRiders();
    if (!riders.length) {
      // Un compte accompagnant/organisateur qui n'a pas de chronos et
      // n'apparaît donc jamais dans allKnownRiders() garde tout de même
      // sa propre carte Trophées.
      if (isNonRider) html += renderAchievementsCard(nonRiderAch, 'achievements-profile-' + me.name);
      return html || '<div class="card"><div class="empty-state">' + (coreDataLoading() ? 'Chargement...' : 'Aucun pilote pour l\'instant — ajoutez un événement ou un chrono pour commencer.') + '</div></div>';
    }
    var rider = (selectedRiders && selectedRiders.size === 1) ? Array.from(selectedRiders)[0] : null;
    // Chronos vérifiés -> Records (repliés dans la même carte, voir
    // renderRiderRecordsCategory) -> Trophées, dans cet ordre pour tout le
    // monde, y compris un compte accompagnant/organisateur dont la propre
    // carte Trophées vient tout en bas, après celles des pilotes.
    var names = rider ? [rider] : (selectedRiders && selectedRiders.size ? Array.from(selectedRiders) : riders).slice().sort(function (a, b) { return a.localeCompare(b); });
    // Exporte exactement ce que la page affiche -- le(s) pilote(s)
    // actuellement filtré(s) par le sélecteur global, pas toute la base.
    html += '<div style="margin-bottom:0.8rem;"><button type="button" class="ghost" data-action="export-chronos-csv">⬇ Exporter en CSV</button></div>';
    names.forEach(function (r) { html += renderRiderStatsCard(r); });
    // Un compte accompagnant/organisateur qui apparaît aussi dans
    // allKnownRiders() (ex. listé une fois comme participant d'un event)
    // a déjà sa propre carte Trophées rendue juste après -- ne pas la
    // rendre une deuxième fois ici via la boucle rider générique.
    var skipAchievementsFor = isNonRider ? me.name : null;
    names.forEach(function (r) { if (r !== skipAchievementsFor) html += renderRiderAchievementsCard(r); });
    if (isNonRider) html += renderAchievementsCard(nonRiderAch, 'achievements-profile-' + me.name);
    return html;
  }

  // One row per session, meilleur tour + tous les tours + certification --
  // covers what a rider would want to keep outside the app (a personal
  // spreadsheet, a season recap) without needing a backend to generate it.
  function csvField(v) {
    var s = String(v == null ? '' : v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function exportSessionsCsv(names) {
    var rows = [['Pilote', 'Date', 'Circuit', 'Meilleur tour', 'Tous les tours', 'Vérifié', 'Vérifié par']];
    STATE.sessions
      .filter(function (s) { return names.indexOf(s.rider) !== -1; })
      .sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : (a.rider < b.rider ? -1 : 1); })
      .forEach(function (s) {
        rows.push([
          s.rider, s.date, s.circuit, formatTime(sessionBest(s)),
          s.laps.map(formatTime).join(' / '),
          s.certifiedBy ? 'Oui' : 'Non', s.certifiedBy || ''
        ]);
      });
    var csv = rows.map(function (r) { return r.map(csvField).join(','); }).join('\r\n');
    var blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'chronos-' + dateKey(new Date()) + '.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // Every sortie on this circuit whose date range covers dateStr -- lets
  // the chrono form suggest a link even when the rider didn't get here by
  // way of that sortie's own "En cours"/Planning context (selectedEventId).
  function candidateEventsForCircuitDate(circuit, dateStr) {
    if (!dateStr) return [];
    return eventsList().filter(function (e) {
      return e.circuit === circuit && e.dateStart <= dateStr && (e.dateEnd || e.dateStart) >= dateStr;
    }).sort(function (a, b) { return a.dateStart < b.dateStart ? -1 : 1; });
  }

  function renderLinkedEventField(circuit, dateStr) {
    var candidates = candidateEventsForCircuitDate(circuit, dateStr);
    if (!candidates.length) return '';
    var preselect = (selectedEventId && candidates.some(function (e) { return e.id === selectedEventId; })) ? selectedEventId : candidates[0].id;
    var options = candidates.map(function (e) {
      return '<option value="' + e.id + '"' + (e.id === preselect ? ' selected' : '') + '>' + escapeHtml(formatEventRange(e, true)) + '</option>';
    }).join('');
    return '<div style="margin-top:0.9rem;"><label for="f-linked-event">Événement associé</label>' +
      '<select id="f-linked-event"><option value="">Aucune</option>' + options + '</select></div>';
  }

  function renderForm() {
    if (!selectedCircuit) {
      return '<div class="card"><div class="empty-state">Choisissez un circuit dans l\'onglet Circuit avant d\'enregistrer un chrono.</div></div>';
    }
    var admin = isAdmin();
    var teamPiloteChoices = myTeamPiloteChoices(); // name -> teamId, for pilotes on a team this account leads
    var teamPiloteNames = Object.keys(teamPiloteChoices);
    // An accompagnant never rides and leads no chrono-relevant team
    // access; an organisateur doesn't ride either, but can still enter
    // one for a team pilote if they lead a team that includes them (see
    // ownsChronoViaTeam in firestore.rules) -- otherwise same dead end.
    var isNonRiderRole = currentUserProfile && (currentUserProfile.role === 'accompagnant' || currentUserProfile.role === 'organisateur');
    if (isNonRiderRole && !admin && !teamPiloteNames.length) {
      return '<div class="card"><div class="empty-state">Seuls les pilotes (et l\'administrateur) peuvent entrer des chronos' +
        (currentUserProfile.role === 'organisateur' ? ' -- ou un Team Leader, pour un pilote de son team.' : '.') + '</div></div>';
    }
    // Retracté par défaut -- juste un bouton pleine largeur en évidence,
    // le formulaire complet n'apparaît qu'une fois cliqué (et redisparaît
    // au profit du bouton une fois le chrono envoyé, voir onSubmit).
    if (!addChronoOpen) {
      return '<button type="button" class="primary add-chrono-btn" id="add-chrono-toggle">+ Ajouter un chrono</button>';
    }
    var rider = (selectedRiders && selectedRiders.size === 1) ? Array.from(selectedRiders)[0] : null;
    // A pilote can only ever enter their own chronos, or a teammate's if
    // they lead a team that includes them; an organisateur/admin-less
    // account with no chronos of its own defaults straight to the first
    // team pilote instead (see firestore.rules for the actual boundary).
    if (!admin && currentUserProfile) {
      rider = (currentUserProfile.role === 'organisateur') ? (teamPiloteNames[0] || null) : currentUserProfile.name;
    }
    var todayStr = dateKey(new Date());
    var groupHint = rider ? chronoGroupHint(selectedCircuit, todayStr, rider) : '';
    var slots = todaysGroupSlots(selectedCircuit, groupHint);
    var suggestedSlotIdx = suggestSlotIndex(slots);
    var html = '<div class="card">';
    html += '<h2 class="section-title">Entrer un nouveau chrono</h2>';
    html += '<form id="session-form" novalidate>';
    html += '<div class="field-row">';
    if (admin) {
      // Only the admin can enter a chrono for anyone at all -- everyone
      // else is locked to their own name, or (see above) their team's.
      var knownRiders = allKnownRiders();
      html += '<div><label for="f-rider">Pilote</label><select id="f-rider" required><option value="">—</option>' +
        knownRiders.map(function (r) { return '<option value="' + escapeHtml(r) + '"' + (r === rider ? ' selected' : '') + '>' + escapeHtml(r) + '</option>'; }).join('') +
        '</select></div>';
    } else if (teamPiloteNames.length) {
      var ownOption = currentUserProfile.role === 'organisateur' ? [] : [currentUserProfile.name];
      var pickOptions = ownOption.concat(teamPiloteNames);
      html += '<div><label for="f-rider">Pilote</label><select id="f-rider" required>' +
        pickOptions.map(function (r) { return '<option value="' + escapeHtml(r) + '"' + (r === rider ? ' selected' : '') + '>' + escapeHtml(r) + '</option>'; }).join('') +
        '</select></div>';
    } else {
      html += '<div><label>Pilote</label><div class="static-field">' + escapeHtml(rider || '') + '</div></div>';
    }
    html += '<div><label for="f-date">Date</label>' +
      '<input type="text" id="f-date" inputmode="numeric" placeholder="JJ/MM/AAAA" value="' + isoToFrDate(todayStr) + '" required></div>';
    html += '<div><label for="f-circuit">Circuit</label><select id="f-circuit" required>' +
      allCircuits().map(function (c) { return '<option value="' + escapeHtml(c) + '"' + (c === selectedCircuit ? ' selected' : '') + '>' + escapeHtml(c) + '</option>'; }).join('') +
      '</select></div>';
    html += '<div><label for="f-bike">Moto</label>' +
      '<input type="text" id="f-bike" list="bike-options" placeholder="Ex. ST 765 RS" value="' + escapeHtml((rider && riderBikeMap[rider]) || '') + '">' +
      '<datalist id="bike-options">' + bikeDatalist() + '</datalist></div>';
    html += '</div>';
    // Entry granularity is deliberately flexible: one row can be just the
    // day's best time, just one session's best, or every lap of one
    // session -- "Session" (the timed slot, see todaysGroupSlots) +
    // "Chronos" together cover all three, since the Chronos field already
    // accepts one time or a whole list.
    html += '<div class="field-row">';
    html += '<div><label for="f-group">Groupe</label><select id="f-group"><option value="">—</option>' +
      GROUP_LETTERS.map(function (g) { return '<option value="' + g + '"' + (g === groupHint ? ' selected' : '') + '>' + g + '</option>'; }).join('') +
      '</select></div>';
    html += '<div><label for="f-slot">Session</label><select id="f-slot">' + renderSlotOptions(slots, suggestedSlotIdx) + '</select></div>';
    html += '</div>';
    html += '<div class="help-text" id="f-group-hint"' + (groupHint ? '' : ' style="display:none;"') + '>Groupe suggéré depuis l’événement associé : ' + escapeHtml(groupHint) + '.</div>';
    html += '<div class="help-text" id="f-slot-hint"' + (suggestedSlotIdx !== -1 ? '' : ' style="display:none;"') + '>Session suggérée selon l\'heure actuelle — modifie si besoin.</div>';
    html += '<label for="f-laps">Chronos</label>' +
      '<textarea id="f-laps" placeholder="1:23.456' + String.fromCharCode(10) + '1:22.980' + String.fromCharCode(10) + '1:23.120" required></textarea>' +
      '<div class="help-text">Un chrono par ligne (ou séparés par une virgule) — tape juste les chiffres, les : et . s\'ajoutent automatiquement. Ex. 1 54 104 pour 1:54.104.</div>';
    html += '<div style="margin-top:0.9rem;"><label for="f-note">Note (optionnel)</label>' +
      '<input type="text" id="f-note" placeholder="Ex. Pluie, pneus neufs, réglages…"></div>';
    html += '<div id="f-linked-event-wrap">' + renderLinkedEventField(selectedCircuit, todayStr) + '</div>';
    html += '<div class="field-error" id="form-error"></div>';
    html += '<div style="margin-top:0.9rem;">' +
      '<button type="submit" class="primary" id="submit-btn">Enregistrer le chrono</button>' +
      '</div>';
    html += '</form></div>';
    return html;
  }

  // The group a rider is suggested to race in today, straight from the
  // sortie linked to this circuit/date (see candidateEventsForCircuitDate)
  // -- matin taking priority since that's the group a rider entering a
  // chrono earlier in the day is most likely riding in.
  function chronoGroupHint(circuit, dateStr, rider) {
    var candidates = candidateEventsForCircuitDate(circuit, dateStr);
    if (!candidates.length) return '';
    var linkedEvent = candidates.filter(function (e) { return e.id === selectedEventId; })[0] || candidates[0];
    return riderGroupFor(linkedEvent, rider, dateStr, 'matin') || riderGroupFor(linkedEvent, rider, dateStr, 'apres-midi') || '';
  }

  // Every timed slot for one group letter on a circuit, from its horaires
  // -- what a rider actually rode, as opposed to the coarse "Matin/Après-
  // midi" period field. Only real timed entries (skips "PAUSE" labels).
  function todaysGroupSlots(circuit, letter) {
    if (!letter) return [];
    var horaires = circuitInfo(circuit).horaires;
    var line = horaires && horaires['group' + letter];
    if (!line) return [];
    return parseHoraireLine(line).filter(function (s) { return s.start != null; });
  }

  // Which of today's slots to preselect: the one in progress right now, or
  // failing that, whichever one ended most recently -- as long as that's
  // recent enough (<=60 min ago) that the rider is plausibly still fresh
  // off the track for it, not guessing at a slot from hours earlier.
  function suggestSlotIndex(slots) {
    if (!slots.length) return -1;
    var nowMinutes = new Date().getHours() * 60 + new Date().getMinutes();
    for (var i = 0; i < slots.length; i++) {
      if (nowMinutes >= slots[i].start && nowMinutes < slots[i].end) return i;
    }
    var bestIdx = -1, bestEnd = -1;
    slots.forEach(function (s, i) {
      if (s.end <= nowMinutes && s.end > bestEnd) { bestEnd = s.end; bestIdx = i; }
    });
    if (bestIdx !== -1 && nowMinutes - bestEnd <= 60) return bestIdx;
    return -1;
  }

  function renderSlotOptions(slots, suggestedIdx) {
    var html = '<option value="">Aucun créneau spécifique</option>';
    slots.forEach(function (s, i) {
      html += '<option value="' + s.start + '"' + (i === suggestedIdx ? ' selected' : '') + '>' + escapeHtml(s.label) + '</option>';
    });
    return html;
  }

  function renderChronosTab() {
    var html = '';
    // The history table already supports any number of selected riders
    // (it shows a "Pilote" column when more than one is active), so keep
    // it visible in "Tous les pilotes" mode too.
    if (selectedCircuit && selectedRiders && selectedRiders.size) {
      html += renderSessionsCard();
    }
    html += '<div style="margin-top:1rem;">' + renderForm() + '</div>';
    // The progression chart comes right after the chronos summary. With
    // several riders active (including "Tous les pilotes") every one of
    // them gets their own line, overlaid on the same chart, instead of
    // arbitrarily picking just one. Its own circuit dropdown (any circuit
    // with a chrono for the active rider(s), not just whichever is picked
    // in Circuit) defaults to the Circuit tab's selection but can be
    // changed independently -- see progressionCircuitPick.
    if (selectedRiders && selectedRiders.size) {
      var progressionRiders = Array.from(selectedRiders);
      var progressionCircuits = circuitsWithChronosFor(progressionRiders);
      if (progressionCircuits.length) {
        var progressionCircuit = (progressionCircuitPick && progressionCircuits.indexOf(progressionCircuitPick) !== -1)
          ? progressionCircuitPick
          : (progressionCircuits.indexOf(selectedCircuit) !== -1 ? selectedCircuit : progressionCircuits[0]);
        html += renderProgressionChart(progressionRiders, progressionCircuit, progressionCircuits);
      }
    }
    return html;
  }

  // name -> array of circuits with at least one chrono, restricted to the
  // given riders -- feeds the progression chart's own circuit dropdown.
  function circuitsWithChronosFor(riders) {
    var set = {};
    STATE.sessions.forEach(function (s) { if (riders.indexOf(s.rider) !== -1) set[s.circuit] = true; });
    return Object.keys(set).sort(function (a, b) { return a.localeCompare(b); });
  }

  // Holds the flat list of {date, time, rider, isBest} points across every
  // series (rider) in the most recently rendered progression chart, keyed
  // by a running index, so the click-to-update-caption handler in
  // attachHandlers() can look up what was clicked without re-parsing the
  // DOM.
  var PROGRESSION_POINTS = [];
  var PROGRESSION_MULTI = false; // whether the last render had >1 rider series (caption then names the rider)
  var progressionCircuitPick = null; // circuit chosen in the chart's own dropdown, overriding Circuit's selection

  // Fixed hue order for rider series -- a rider keeps the same color
  // whenever they appear on this chart, regardless of who else is shown
  // alongside them (picked by that rider's position in the full
  // known-riders roster, not by selection order, so it never shuffles).
  var PROGRESSION_SERIES_COLORS = ['var(--accent)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)'];

  function riderSeriesColor(riderName) {
    var idx = allKnownRiders().indexOf(riderName);
    if (idx === -1) idx = 0;
    return PROGRESSION_SERIES_COLORS[idx % PROGRESSION_SERIES_COLORS.length];
  }

  // Line chart of one or more riders' recorded chronos on one circuit,
  // over time -- one line per rider, sharing the same time/date scale so
  // they're directly comparable. x is spaced proportionally to real
  // elapsed time between session dates (not just index order); y is NOT
  // inverted — a faster (lower) time naturally plots lower on the chart,
  // same as any plain numeric axis where values grow upward (1'54 below
  // 2'00, not above it).
  // 'day' (a single day, picked below -- every chrono entered that day),
  // 'event' (every chrono entered on any of the selected événement's
  // dates, whichever circuit day it falls on), or 'all' (every chrono
  // ever entered on this circuit, any date/événement). Nothing is ever
  // aggregated to a "best of the group" point -- every chrono in scope
  // gets its own point, so several attempts the same day show as a
  // vertical scatter instead of hiding behind one collapsed value. Pure
  // UI state, not persisted, shared across every progression chart
  // currently on screen.
  var progressionGranularity = 'day';
  var progressionDayPick = null; // 'YYYY-MM-DD', re-validated against the actual date list on every render
  var progressionEventPick = null; // an event id, same re-validation

  // Every distinct date any of these riders has a chrono on this circuit --
  // the option list for the Jour picker, and how Événement resolves which
  // of an événement's days actually have chronos to show.
  function circuitSessionDates(riders, circuit) {
    var set = {};
    STATE.sessions.forEach(function (s) {
      if (riders.indexOf(s.rider) === -1 || s.circuit !== circuit) return;
      set[s.date] = true;
    });
    return Object.keys(set).sort();
  }
  // Événements on this circuit that actually overlap at least one of
  // those dates -- an événement with no chrono yet doesn't clutter the
  // picker.
  function circuitEventsWithSessions(riders, circuit) {
    var dates = circuitSessionDates(riders, circuit);
    return eventsList().filter(function (ev) {
      if (ev.circuit !== circuit) return false;
      var end = ev.dateEnd || ev.dateStart;
      return dates.some(function (d) { return d >= ev.dateStart && d <= end; });
    }).sort(function (a, b) { return a.dateStart < b.dateStart ? 1 : a.dateStart > b.dateStart ? -1 : 0; });
  }

  function progressionSeriesRaw(riderName, circuit) {
    var relevant = STATE.sessions.filter(function (s) { return s.rider === riderName && s.circuit === circuit; });
    if (progressionGranularity === 'day') {
      if (!progressionDayPick) return [];
      relevant = relevant.filter(function (s) { return s.date === progressionDayPick; });
    } else if (progressionGranularity === 'event') {
      var ev = progressionEventPick ? (STATE.events || []).filter(function (e) { return e.id === progressionEventPick; })[0] : null;
      if (!ev) return [];
      var end = ev.dateEnd || ev.dateStart;
      relevant = relevant.filter(function (s) { return s.date >= ev.dateStart && s.date <= end; });
    }
    // 'all' falls straight through with every session on this circuit.
    return relevant.map(function (s) { return { date: s.date, time: sessionBest(s) }; });
  }

  function renderProgressionChart(riders, circuit, availableCircuits) {
    var selectorHtml = '';
    if (availableCircuits && availableCircuits.length > 1) {
      selectorHtml = '<label for="progression-circuit-select" class="help-text" style="display:block; margin-bottom:0.3rem;">Circuit</label>' +
        '<select id="progression-circuit-select" style="margin-bottom:0.8rem;">' +
        availableCircuits.map(function (c) { return '<option value="' + escapeHtml(c) + '"' + (c === circuit ? ' selected' : '') + '>' + escapeHtml(c) + '</option>'; }).join('') +
        '</select>';
    }
    selectorHtml += '<div class="progression-granularity">' + [['day', 'Jour'], ['event', 'Événement'], ['all', 'All time']].map(function (g) {
      return '<button type="button" class="ghost' + (progressionGranularity === g[0] ? ' active' : '') + '" data-action="progression-granularity" data-granularity="' + g[0] + '">' + g[1] + '</button>';
    }).join('') + '</div>';
    // The Jour/Événement picker only shows once there's actually a choice
    // to make -- re-validated every render (not just when granularity
    // changes) since switching circuit/rider can invalidate whichever day
    // or événement was picked for a different one.
    if (progressionGranularity === 'day') {
      var days = circuitSessionDates(riders, circuit);
      if (!progressionDayPick || days.indexOf(progressionDayPick) === -1) progressionDayPick = days.length ? days[days.length - 1] : null;
      if (days.length > 1) {
        selectorHtml += '<select id="progression-day-select" style="margin-bottom:0.8rem;">' +
          days.map(function (d) { return '<option value="' + d + '"' + (d === progressionDayPick ? ' selected' : '') + '>' + escapeHtml(formatDate(d)) + '</option>'; }).join('') +
          '</select>';
      }
    } else if (progressionGranularity === 'event') {
      var evOptions = circuitEventsWithSessions(riders, circuit);
      if (!progressionEventPick || !evOptions.some(function (e) { return e.id === progressionEventPick; })) {
        progressionEventPick = evOptions.length ? evOptions[0].id : null;
      }
      if (evOptions.length) {
        selectorHtml += '<select id="progression-event-select" style="margin-bottom:0.8rem;">' +
          evOptions.map(function (e) { return '<option value="' + e.id + '"' + (e.id === progressionEventPick ? ' selected' : '') + '>' + escapeHtml(formatEventRange(e, true)) + '</option>'; }).join('') +
          '</select>';
      } else {
        selectorHtml += '<div class="help-text" style="margin-bottom:0.6rem;">Aucun événement avec chrono sur ' + escapeHtml(circuit) + '.</div>';
      }
    }
    var series = riders.map(function (riderName) {
      var raw = progressionSeriesRaw(riderName, circuit)
        .sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
      return { rider: riderName, raw: raw };
    }).filter(function (s) { return s.raw.length > 0; });

    var isMulti = series.length > 1;
    // A single rider's chart keeps the app's accent color, same as before
    // multi-rider overlays existed -- the fixed categorical palette only
    // kicks in once there's actually more than one line to tell apart.
    series.forEach(function (s) { s.color = isMulti ? riderSeriesColor(s.rider) : 'var(--accent)'; });
    var progressionKey = 'progression-' + riders.slice().sort().join(',');
    var html = selectorHtml;

    if (!series.length) {
      html += '<div class="empty-state">Aucun chrono enregistré sur ' + escapeHtml(circuit) + (riders.length === 1 ? ' pour ' + escapeHtml(riders[0]) : '') + '.</div>';
      return collapsibleCard(progressionKey, 'Visualisation de la progression', html, true);
    }
    if (series.length === 1 && series[0].raw.length === 1) {
      var only = series[0].raw[0];
      html += '<div class="empty-state">Un seul chrono enregistré — ' + formatTime(only.time) + ' le ' + escapeHtml(formatDate(only.date)) + '. La courbe apparaîtra au prochain chrono.</div>';
      return collapsibleCard(progressionKey, 'Visualisation de la progression', html, true);
    }
    var totalPoints = series.reduce(function (sum, s) { return sum + s.raw.length; }, 0);
    if (totalPoints < 2) {
      html += '<div class="empty-state">Pas encore assez de chronos pour tracer une courbe.</div>';
      return collapsibleCard(progressionKey, 'Visualisation de la progression', html, true);
    }

    var W = 640, H = 260;
    var marginL = 64, marginR = 16, marginT = 34, marginB = 38;
    var plotW = W - marginL - marginR, plotH = H - marginT - marginB;

    var allTimes = [], allStamps = [];
    series.forEach(function (s) {
      s.raw.forEach(function (p) {
        allTimes.push(p.time);
        allStamps.push(parseLocalDate(p.date).getTime());
      });
    });
    var minTime = Math.min.apply(null, allTimes);
    var maxTime = Math.max.apply(null, allTimes);
    var timeSpan = maxTime - minTime;
    var minStamp = Math.min.apply(null, allStamps);
    var maxStamp = Math.max.apply(null, allStamps);
    var stampSpan = maxStamp - minStamp;

    series.forEach(function (s) {
      var recordTime = Math.min.apply(null, s.raw.map(function (p) { return p.time; }));
      s.pts = s.raw.map(function (p, i) {
        var xFrac = stampSpan > 0 ? (parseLocalDate(p.date).getTime() - minStamp) / stampSpan : (s.raw.length > 1 ? i / (s.raw.length - 1) : 0.5);
        var yFrac = timeSpan > 0 ? (maxTime - p.time) / timeSpan : 0.5;
        return { x: marginL + xFrac * plotW, y: marginT + yFrac * plotH, date: p.date, time: p.time, isBest: p.time === recordTime };
      });
    });

    var gridTimes = timeSpan > 0 ? [minTime, minTime + timeSpan / 2, maxTime] : [minTime];
    var gridSvg = '';
    gridTimes.forEach(function (t) {
      var y = marginT + (timeSpan > 0 ? (maxTime - t) / timeSpan : 0.5) * plotH;
      gridSvg += '<line class="progression-grid" x1="' + marginL + '" y1="' + y.toFixed(1) + '" x2="' + (marginL + plotW) + '" y2="' + y.toFixed(1) + '"></line>';
      // The axis is just for orientation (roughly how fast) -- the exact
      // lap times already show at each point, so milliseconds here would
      // just be clutter. Rounded to the second.
      gridSvg += '<text class="progression-axis-label" x="' + (marginL - 10) + '" y="' + (y + 5).toFixed(1) + '" text-anchor="end">' + formatTimeShort(t) + '</text>';
    });

    // With one rider, every point can carry a value label (dataviz
    // guidance: label all points when few). With several riders overlaid,
    // that many labels would collide, so only each series' own endpoints
    // and its own record get one.
    var MIN_LABEL_GAP = 56; // wider now that the label font is bigger
    var pointsSvg = '';
    var dateLabelsSvg = '';
    var dateLabelReservedX = [];
    var flatPoints = [];

    series.forEach(function (s) {
      var pts = s.pts;
      var lastIdx = pts.length - 1;
      var recordIdx = -1;
      pts.forEach(function (p, i) { if (recordIdx === -1 && p.isBest) recordIdx = i; });

      if (pts.length > 1) {
        var pathD = pts.map(function (p, i) { return (i === 0 ? 'M' : 'L') + p.x.toFixed(1) + ',' + p.y.toFixed(1); }).join(' ');
        pointsSvg += '<path class="progression-line" style="stroke:' + s.color + '" d="' + pathD + '"></path>';
      }

      var labelEvery = !isMulti && pts.length <= 7;
      var chosen = {};
      var reservedX = [];
      [0, lastIdx, recordIdx].forEach(function (i) {
        if (i < 0 || chosen[i]) return;
        chosen[i] = true;
        reservedX.push(pts[i].x);
      });
      if (labelEvery) {
        pts.forEach(function (p, i) {
          if (chosen[i]) return;
          var clear = reservedX.every(function (rx) { return Math.abs(p.x - rx) >= MIN_LABEL_GAP; });
          if (clear) { chosen[i] = true; reservedX.push(p.x); }
        });
      }

      pts.forEach(function (p, i) {
        var globalIdx = flatPoints.length;
        flatPoints.push({ date: p.date, time: p.time, rider: s.rider, isBest: p.isBest });
        pointsSvg += '<circle class="progression-point' + (p.isBest ? ' is-best' : '') + '" style="' + (p.isBest ? '' : 'stroke:' + s.color + ';') + '" cx="' + p.x.toFixed(1) + '" cy="' + p.y.toFixed(1) + '" r="9" data-idx="' + globalIdx + '" tabindex="0">' +
          '<title>' + (isMulti ? escapeHtml(s.rider) + ' — ' : '') + escapeHtml(formatDate(p.date)) + ' — ' + formatTime(p.time) + (p.isBest ? ' (record)' : '') + '</title>' +
          '</circle>';
        if (chosen[i]) {
          pointsSvg += '<text class="progression-value-label' + (p.isBest ? ' is-best' : '') + '" style="' + (p.isBest ? '' : 'fill:' + s.color + ';') + '" x="' + p.x.toFixed(1) + '" y="' + (p.y - 16).toFixed(1) + '" text-anchor="middle">' + formatSecondsOnly(p.time) + '</text>';
        }
        if (i === 0 || i === lastIdx) {
          var clearDate = dateLabelReservedX.every(function (rx) { return Math.abs(p.x - rx) >= MIN_LABEL_GAP; });
          if (clearDate) {
            dateLabelReservedX.push(p.x);
            dateLabelsSvg += '<text class="progression-axis-label" x="' + p.x.toFixed(1) + '" y="' + (H - marginB + 18).toFixed(1) + '" text-anchor="middle">' + shortDayMonth(parseLocalDate(p.date)) + '</text>';
          }
        }
      });
    });

    var svg = '<svg class="progression-chart" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Progression des chronos">' +
      gridSvg +
      pointsSvg +
      dateLabelsSvg +
      '</svg>';

    html += svg;

    if (isMulti) {
      html += '<div class="progression-legend">' + series.map(function (s) {
        return '<span class="progression-legend-item"><span class="progression-legend-dot" style="background:' + s.color + '"></span>' + escapeHtml(s.rider) + '</span>';
      }).join('') + '</div>';
    }

    var latest = flatPoints.reduce(function (best, p) { return (!best || p.date > best.date) ? p : best; }, null);
    html += '<div class="progression-caption" id="progression-caption">' +
      (isMulti ? escapeHtml(latest.rider) + ' — ' : '') +
      escapeHtml(formatDate(latest.date)) + ' — ' + formatTime(latest.time) + (latest.isBest ? ' (record)' : '') +
      '</div>';

    PROGRESSION_POINTS = flatPoints;
    PROGRESSION_MULTI = isMulti;
    return collapsibleCard(progressionKey, 'Visualisation de la progression', html, true);
  }

  function circuitDatalist() {
    var out = '';
    allCircuits().forEach(function (c) { out += '<option value="' + escapeHtml(c) + '">'; });
    return out;
  }

  function bikeDatalist() {
    var seen = {};
    var out = '';
    STATE.sessions.forEach(function (s) {
      if (s.bike && !seen[s.bike]) { seen[s.bike] = true; out += '<option value="' + escapeHtml(s.bike) + '">'; }
    });
    return out;
  }

  function riderDatalist() {
    var out = '';
    allKnownRiders().forEach(function (r) {
      out += '<option value="' + escapeHtml(r) + '">';
    });
    return out;
  }

  // Suggestions for the event form's "Pilotes" field -- scoped to riders
  // this account actually knows (a friend, or a fellow member of any Team
  // it's in) rather than the entire roster, per "les pilotes ajoutés sont
  // des amis ou bien un Team". Still a plain text input underneath (see
  // renderEventForm), so this only narrows the datalist's suggestions --
  // the admin, who manages every account, keeps seeing everyone.
  function riderDatalistForEventForm(existingRiders) {
    if (isAdmin()) return riderDatalist();
    var me = currentUserProfile;
    var known = {};
    (existingRiders || []).forEach(function (r) { known[r] = true; });
    if (me) {
      friendsOf(me.name).forEach(function (f) { known[f.name] = true; });
      (STATE.myTeamMemberships || []).forEach(function (m) {
        membersOfTeam(m.teamId).forEach(function (tm) { known[tm.name] = true; });
      });
    }
    var out = '';
    allKnownRiders().forEach(function (r) {
      if (known[r]) out += '<option value="' + escapeHtml(r) + '">';
    });
    return out;
  }

  // Only the admin or the chrono's own rider can touch it (matching
  // firestore.rules) -- not any other pilote, and never an accompagnant
  // (their account name never matches a session's rider).
  function canEditSession(session) {
    return isAdmin() || !!(currentUserProfile && session.rider === currentUserProfile.name);
  }

  function deleteControl(session) {
    if (!canEditSession(session)) return '';
    return '<button type="button" class="ghost icon-btn" data-action="delete-request" data-id="' + session.id + '" aria-label="Supprimer cette session" title="Supprimer">×</button>';
  }

  function editControl(session) {
    if (!canEditSession(session)) return '';
    return '<button type="button" class="ghost icon-btn" data-action="edit-session-request" data-id="' + session.id + '" aria-label="Modifier ce chrono" title="Modifier">✎</button>';
  }

  // A chrono logged under a Team Event can be certified by that event's
  // own Team Leader -- the pitch to clubs: a future organizer building
  // homogeneous, safe groups can trust a certified time instead of
  // having to ask every pilote for their references by hand. Whether it's
  // already certified or not doesn't change who can manage it -- the same
  // leader can revoke or hand it to a co-leader just as easily as grant
  // it the first time.
  function canManageCertification(session) {
    if (!session.eventId) return false;
    var ev = (STATE.events || []).filter(function (e) { return e.id === session.eventId; })[0];
    return !!(ev && ev.teamId && isLeaderOfTeam(ev.teamId));
  }
  function certifyControl(session) {
    var manageable = canManageCertification(session);
    if (session.certifiedBy) {
      var verifiedDesc = 'Chrono vérifié par ' + escapeHtml(session.certifiedBy);
      var pill = '<span class="verified-pill" title="' + verifiedDesc + '" data-badge-info="' + verifiedDesc + '">✓ Vérifié</span>';
      if (!manageable) return pill;
      return pill + '<button type="button" class="ghost icon-btn" data-action="uncertify-session" data-id="' + session.id + '" aria-label="Retirer la vérification" title="Retirer la vérification">×</button>';
    }
    if (!manageable) return '';
    return '<button type="button" class="ghost icon-btn" data-action="certify-session" data-id="' + session.id + '" aria-label="Vérifier ce chrono" title="Vérifier ce chrono">✓</button>';
  }
  function certifyChrono(sessionId) {
    var me = currentUserProfile;
    if (!me) return;
    db.collection('sessions').doc(sessionId).update({ certifiedBy: me.name }).then(function () {
      showToast('Chrono vérifié.', 'success');
    }).catch(function (err) {
      showToast('Erreur : ' + (err && err.message ? err.message : err));
    });
  }
  function uncertifyChrono(sessionId) {
    db.collection('sessions').doc(sessionId).update({ certifiedBy: null }).catch(function (err) {
      showToast('Erreur : ' + (err && err.message ? err.message : err));
    });
  }

  // A rider's usual "N° de moto" lives on their own profile (Mon profil ->
  // Ma moto) -- this is a separate, event-scoped override an orga
  // (Team Leader) can set arbitrarily for a given sortie (e.g. a grid
  // number assigned for that trackday only), never touching the rider's
  // own account. Stored on the event doc itself, ev.riderBikeNumbers[name],
  // since only that Team's leader can already write anything on a
  // Team-owned event.
  function saveEventRiderBikeNumber(eventId, riderName, number) {
    var patch = {};
    patch['riderBikeNumbers.' + riderName] = (number || '').trim() || firebase.firestore.FieldValue.delete();
    db.collection('events').doc(eventId).update(patch).catch(function (err) {
      showToast('Erreur : ' + (err && err.message ? err.message : err));
    });
  }

  // Organisateur view: one row per pilote of this event, its best chrono
  // and its certification status, so a Team Leader can check who's
  // certified for the sortie without opening each pilote's fiche one by
  // one -- the check-in he'd otherwise do rider by rider before building
  // groups.
  function renderEventCertificationSection(ev) {
    if (!ev.teamId || !isLeaderOfTeam(ev.teamId)) return '';
    var riders = (ev.riders || []).slice().sort();
    if (!riders.length) return '';
    var rows = riders.map(function (rider) {
      var sessions = STATE.sessions.filter(function (s) { return s.rider === rider && s.eventId === ev.id; });
      var valueHtml = !sessions.length
        ? '<span class="help-text">Aucun chrono</span>'
        : (function () {
            var best = sessions.reduce(function (a, b) { return sessionBest(b) < sessionBest(a) ? b : a; });
            return formatTime(sessionBest(best)) + ' ' + certifyControl(best);
          })();
      return '<div class="info-row"><span class="info-label">' + nameLinkHtml(rider) + '</span><span class="info-value">' + valueHtml + '</span></div>' + maybeFicheHtml(rider);
    }).join('');
    return collapsibleSection('cert-' + ev.id, 'Chronos vérifiés', rows, true);
  }

  // ---- Circuit info (km, virages, prochaine sortie) + visuel annotable ----

  function circuitInfo(name) {
    STATE.circuits = STATE.circuits || {};
    return STATE.circuits[name] || {};
  }

  // The horaires actually in effect for a given sortie: its own override
  // (ev.horairesOverride, set from the event form -- see onEventSubmit)
  // when set, else the circuit's shared "horaires habituels" (admin-only,
  // see renderCircuitInfoEditForm). Lets a Team Leader fix an unusual
  // schedule for their own sortie without needing write access to the
  // circuit's own reference data.
  function eventHoraires(ev) {
    if (ev && ev.horairesOverride && Object.keys(ev.horairesOverride).length) return ev.horairesOverride;
    return ev ? circuitInfo(ev.circuit).horaires : null;
  }

  // The circuit card's "Prochaine sortie" is derived straight from the
  // Calendrier — the earliest sortie on this circuit that hasn't finished
  // yet — rather than a separately-typed date that can drift out of sync.
  function nextOutingForCircuit(circuit) {
    var todayKey = dateKey(new Date());
    var norm = (circuit || '').trim().toLowerCase();
    var matches = eventsList().filter(function (e) {
      return e.circuit.trim().toLowerCase() === norm && (e.dateEnd || e.dateStart) >= todayKey;
    }).sort(function (a, b) { return a.dateStart < b.dateStart ? -1 : a.dateStart > b.dateStart ? 1 : 0; });
    return matches[0] || null;
  }

  // By default only returns sessions for the riders currently selected in
  // the main filter, so the circuit info card, the sessions table and the
  // annotation screen all agree on "whose data am I looking at". Pass
  // includeAllRiders=true to bypass that (used nowhere yet, kept for
  // flexibility).
  function circuitSessionsDesc(circuit, includeAllRiders) {
    return STATE.sessions
      .filter(function (s) {
        if (s.circuit !== circuit) return false;
        if (includeAllRiders) return true;
        return selectedRiders && selectedRiders.has(s.rider);
      })
      .sort(function (a, b) { return a.date < b.date ? 1 : a.date > b.date ? -1 : 0; });
  }

  function infoRow(label, valueHtml) {
    return '<div class="info-row"><span class="info-label">' + escapeHtml(label) + '</span><span class="info-value">' + valueHtml + '</span></div>';
  }

  // A rider's name, used anywhere one shows up (chronos table, récap du
  // jour, groupes par pilote). Plain text now for everyone, admin
  // included -- Chronos/Stats are locked to the connected account's own
  // name (see normalizeSelection), so a click here would have nowhere to
  // go; checking on a teammate goes through Social (fiche d'ami) instead.
  function renderRiderLink(name) {
    var cls = nameColorClass(name);
    return cls ? '<span class="' + cls.trim() + '">' + escapeHtml(name) + '</span>' : escapeHtml(name);
  }

  // Turns any name into the same clickable "open fiche" link Social's Mes
  // amis list uses (see renderFriendRow/renderFriendFiche) -- reused
  // wherever a name shows up in Team/Événements so a fiche (with its
  // shared chronos, chronos vérifiés, trophées...) is one click away, not
  // just from Social.
  function nameLinkHtml(name) {
    return '<button type="button" class="friend-name-link' + nameColorClass(name) + '" data-action="toggle-friend-fiche" data-name="' + escapeHtml(name) + '">' + escapeHtml(name) + '</button>';
  }
  function maybeFicheHtml(name) {
    return expandedFriend === name ? renderFriendFiche(name) : '';
  }

  // Copier/Maps/Waze actions for any free-text address or place name --
  // used for the hotel address and the trip's airport (Planning). Buttons
  // rather than <a> tags so click handling (clipboard copy, opening a new
  // tab) stays consistent and doesn't need a second ".ghost" CSS rule just
  // for anchors.
  function renderLocationActions(text) {
    if (!text) return '';
    return '<span class="location-actions">' +
      '<button type="button" class="ghost icon-btn" data-action="copy-location" data-text="' + escapeHtml(text) + '" aria-label="Copier" title="Copier">📋</button>' +
      '<button type="button" class="ghost icon-btn" data-action="open-maps" data-text="' + escapeHtml(text) + '" aria-label="Ouvrir dans Google Maps" title="Google Maps">🗺️</button>' +
      '<button type="button" class="ghost icon-btn" data-action="open-waze" data-text="' + escapeHtml(text) + '" aria-label="Ouvrir dans Waze" title="Waze">🚗</button>' +
      '</span>';
  }

  // The Circuit tab is rider-agnostic (it's context, not a comparison
  // view), so its "Dernière sortie"/"Record circuit" figures cover every
  // rider, not just whichever one happens to be active elsewhere.
  function renderCircuitTab() {
    var circuits = allCircuits();
    if (!circuits.length) {
      return '<div class="card"><div class="empty-state">' + (coreDataLoading() ? 'Chargement...' : 'Aucun circuit pour l\'instant — ajoutez un événement dans le Calendrier ou un chrono pour commencer.') + '</div></div>';
    }
    var html = '<div class="card"><label for="f-filter-circuit">Circuit</label><select id="f-filter-circuit">';
    circuits.forEach(function (c) {
      html += '<option value="' + escapeHtml(c) + '"' + (c === selectedCircuit ? ' selected' : '') + '>' + escapeHtml(c) + '</option>';
    });
    html += '</select></div>';
    html += renderCircuitInfoCard();
    html += renderChronoGoalsCard();
    // Chronos used to be its own tab; it's really always been about
    // "the currently active circuit", so it lives here now, right after
    // the circuit's own info.
    html += '<h2 class="section-title" style="margin-top:0.5rem;">Chronos</h2>';
    html += renderChronosTab();
    return html;
  }

  // Personal, per-circuit -- users/{uid}.chronoGoals[circuit] = free text,
  // same "just a map field, freely self-writable" shape as coachAvailability.
  // Paired with a read-only reminder of how the rider felt last time out
  // (any circuit -- "la dernière session", not specifically this one) so
  // setting a goal for next time has that context right above it.
  function mostRecentSessionForRider(riderName) {
    var mine = (STATE.sessions || []).filter(function (s) { return s.rider === riderName; });
    mine.sort(function (a, b) { return (b.date || '').localeCompare(a.date || ''); });
    return mine[0] || null;
  }
  var chronoGoalsMessage = '';
  function saveChronoGoals(circuit, text) {
    var uid = auth.currentUser && auth.currentUser.uid;
    if (!uid || !currentUserProfile) return;
    var goals = Object.assign({}, currentUserProfile.chronoGoals || {});
    goals[circuit] = (text || '').trim();
    db.collection('users').doc(uid).set({ chronoGoals: goals }, { merge: true }).then(function () {
      currentUserProfile.chronoGoals = goals;
      chronoGoalsMessage = 'Objectifs enregistrés.';
      renderRoot();
    }).catch(function (err) {
      chronoGoalsMessage = 'Erreur : ' + (err && err.message ? err.message : err);
      renderRoot();
    });
  }
  function renderChronoGoalsCard() {
    var me = currentUserProfile;
    if (!me || !selectedCircuit) return '';
    var goals = (me.chronoGoals || {})[selectedCircuit] || '';
    var last = mostRecentSessionForRider(me.name);
    var feelingOpt = last && last.feeling ? FEELING_OPTIONS.filter(function (f) { return f.key === last.feeling; })[0] : null;
    var html = '<div class="card" style="margin-top:1rem;"><h2 class="section-title">Objectifs pour la prochaine session</h2>';
    html += feelingOpt
      ? '<div class="help-text">Ressenti à ta dernière session : ' + feelingOpt.icon + ' ' + escapeHtml(feelingOpt.label) + (last.feelingComment ? ' — ' + escapeHtml(last.feelingComment) : '') + '</div>'
      : '<div class="help-text">Pas encore de ressenti enregistré (voir Réglages pour l\'activer).</div>';
    html += '<textarea id="chrono-goals-input" rows="4" style="margin-top:0.6rem;" placeholder="Ex. Travailler le point de corde en 3, être plus fluide au freinage...">' + escapeHtml(goals) + '</textarea>';
    html += '<button type="button" class="ghost" id="chrono-goals-save-btn" style="margin-top:0.5rem;">Enregistrer</button>';
    if (chronoGoalsMessage) html += '<div class="help-text" style="margin-top:0.4rem;">' + escapeHtml(chronoGoalsMessage) + '</div>';
    html += '</div>';
    return html;
  }
  function renderCircuitInfoCard() {
    var info = circuitInfo(selectedCircuit);
    var sessions = circuitSessionsDesc(selectedCircuit, true);
    var lastSession = null;
    sessions.forEach(function (s) { if (!lastSession || s.date > lastSession.date) lastSession = s; });
    var recordSession = null, recordTime = Infinity;
    sessions.forEach(function (s) {
      var b = sessionBest(s);
      if (b < recordTime) { recordTime = b; recordSession = s; }
    });

    var turnsHtml = '—';
    if (info.turnsRight != null || info.turnsLeft != null) {
      turnsHtml = (info.turnsRight != null ? info.turnsRight + ' D' : '—') + ' / ' + (info.turnsLeft != null ? info.turnsLeft + ' G' : '—');
    }

    // Pas de titre "circuit-name" redondant ici -- le <select> juste
    // au-dessus (voir renderCircuitTab) sert déjà de titre pour ce
    // circuit, pas la peine de répéter son nom.
    var html = '<div class="card circuit-info-card">';
    html += '<div class="circuit-info-map-full">' + renderCircuitVisual(info) + '</div>';
    html += '<div class="circuit-info-list">';
    html += infoRow('Distance', info.km != null ? (escapeHtml(String(info.km)) + ' km') : '—');
    html += infoRow('Virages (D / G)', turnsHtml);
    var lastEvent = (lastSession && lastSession.eventId) ? eventsList().filter(function (e) { return e.id === lastSession.eventId; })[0] : null;
    var lastOutingText = lastSession ? (escapeHtml(formatDate(lastSession.date)) + ' — ' + formatTime(sessionBest(lastSession))) : '—';
    html += infoRow('Dernier événement', lastEvent
      ? '<button type="button" class="link-btn" id="last-outing-link" data-event-id="' + lastEvent.id + '">' + lastOutingText + '</button>'
      : lastOutingText);
    html += infoRow('Record circuit', recordSession ? (formatTime(recordTime) + ' (' + escapeHtml(recordSession.rider) + ')') : '—');
    var upcoming = nextOutingForCircuit(selectedCircuit);
    html += infoRow('Prochain événement', upcoming
      ? '<button type="button" class="link-btn" id="next-outing-link" data-event-id="' + upcoming.id + '">' + escapeHtml(formatEventRange(upcoming, true)) + '</button>'
      : '<button type="button" class="link-btn" id="plan-outing-link">Non planifiée — planifier</button>');
    // Admin-only now (see firestore.rules' circuits match) -- this used to
    // be open to any pilote, which meant literally anyone could overwrite
    // another circuit's imported plan image, not just tweak a km figure.
    if (isAdmin()) {
      if (editingCircuitInfo) {
        html += renderCircuitInfoEditForm(info);
      } else {
        html += '<button type="button" class="ghost" id="edit-circuit-info-btn" style="margin-top:0.6rem;">Modifier les infos</button>';
      }
    }
    html += '</div>';
    html += '</div>';
    return html;
  }

  function renderCircuitInfoEditForm(info) {
    var html = '<div class="info-edit-form">';
    html += '<div><label for="ci-km">Distance (km)</label><input type="text" inputmode="decimal" id="ci-km" value="' + (info.km != null ? escapeHtml(String(info.km)) : '') + '" placeholder="Ex. 4.2"></div>';
    html += '<div><label for="ci-right">Virages à droite</label><input type="text" inputmode="numeric" id="ci-right" value="' + (info.turnsRight != null ? escapeHtml(String(info.turnsRight)) : '') + '" placeholder="Ex. 9"></div>';
    html += '<div><label for="ci-left">Virages à gauche</label><input type="text" inputmode="numeric" id="ci-left" value="' + (info.turnsLeft != null ? escapeHtml(String(info.turnsLeft)) : '') + '" placeholder="Ex. 5"></div>';
    var allTeamsForOrganizer = (STATE.teams || []).slice().sort(function (a, b) { return a.name.localeCompare(b.name); });
    html += '<div><label for="ci-organizer">Organisateur</label><select id="ci-organizer"><option value="">—</option>' +
      allTeamsForOrganizer.map(function (t) {
        return '<option value="' + t.id + '"' + (t.id === info.organizerTeamId ? ' selected' : '') + '>' + escapeHtml(t.name) + (t.teamPro ? ' (PRO)' : '') + '</option>';
      }).join('') + '</select></div>';
    html += '<div><label for="ci-briefing">Briefing</label><input type="text" id="ci-briefing" value="' + escapeHtml(info.briefing || '') + '" placeholder="Ex. 8h15"></div>';
    html += '</div>';
    // These usual times pre-remplissent automatiquement une nouvelle sortie
    // créée sur ce circuit (voir renderEventForm) -- utile puisque
    // l'organisateur fixe en général les mêmes créneaux à chaque sortie.
    var horairesVal = (info.horaires && typeof info.horaires === 'object') ? info.horaires : {};
    html += '<div style="margin-top:0.6rem;"><label>Horaires habituels par groupe</label><div class="horaires-grid">';
    HORAIRES_GROUPS.forEach(function (g) {
      // Rookies (groupe R) is Mugello-only for now -- hide the field
      // elsewhere so it doesn't look like every circuit has one.
      if (g.key === 'groupR' && selectedCircuit !== 'Mugello' && !horairesVal.groupR) return;
      html += '<div><label for="ci-horaires-' + g.key + '" class="horaires-sublabel">' + escapeHtml(g.label) + '</label>' +
        '<input type="text" id="ci-horaires-' + g.key + '" placeholder="Ex. 9h, 10h40, 14h, 15h20, 16h40" value="' + escapeHtml(horairesVal[g.key] || '') + '"></div>';
    });
    html += '</div></div>';
    // Same free upload as everywhere else in the app (photo/logo/horaires
    // photo) -- no in-app path existed at all before to set info.mapImage,
    // it could only ever be seeded by hand -- so "Aucun plan importé pour
    // ce circuit" (renderCircuitVisual) had no way to actually get fixed
    // from here.
    html += '<div style="margin-top:0.9rem;"><label>Plan du circuit</label>' +
      '<div style="display:flex; gap:0.5rem; margin-top:0.3rem; flex-wrap:wrap;">' +
      '<button type="button" class="ghost" id="circuit-map-upload-btn">' + (info.mapImage ? 'Remplacer le plan' : 'Importer un plan') + '</button>' +
      (info.mapImage ? '<button type="button" class="ghost" id="circuit-map-remove-btn">Retirer</button>' : '') +
      '</div>' +
      '<input type="file" id="circuit-map-input" accept="image/*" style="display:none;">' +
      (circuitMapMessage ? '<div class="help-text" style="margin-top:0.4rem;">' + escapeHtml(circuitMapMessage) + '</div>' : '') +
      '</div>';
    html += '<div class="info-edit-actions"><button type="button" class="primary" id="save-circuit-info-btn">Enregistrer</button><button type="button" class="ghost" id="cancel-circuit-info-btn">Annuler</button></div>';
    return html;
  }
  var circuitMapMessage = '';
  function saveCircuitMapImage(circuitName, dataUrl) {
    if (!isAdmin()) return;
    var prevState = JSON.parse(JSON.stringify(STATE));
    STATE.circuits = STATE.circuits || {};
    var entry = STATE.circuits[circuitName] || {};
    entry.mapImage = dataUrl || null;
    STATE.circuits[circuitName] = entry;
    renderRoot();
    persist(prevState);
  }

  // eventId (optional): when the visual is shown from a sortie's own card
  // (Événements) rather than the Circuit tab, annotating it opens that
  // sortie's own blank layer (see openAnnotation) instead of the circuit's
  // shared plan -- so the button carries the event id rather than the id
  // attachHandlers() otherwise wires to the globally-selected circuit.
  function renderCircuitVisual(info, circuitName, eventId) {
    circuitName = circuitName || selectedCircuit;
    if (info.mapImage) {
      return (
        '<div class="circuit-visual-frame">' +
          '<button type="button" class="circuit-visual-btn" id="open-annot-btn" data-circuit="' + escapeHtml(circuitName) + '"' + (eventId ? ' data-event-id="' + eventId + '"' : '') + ' aria-label="Annoter le tracé du circuit">' +
            '<img src="' + info.mapImage + '" alt="Tracé de ' + escapeHtml(circuitName) + '">' +
          '</button>' +
          '<div class="circuit-visual-caption">' + ((currentUserProfile && currentUserProfile.role === 'accompagnant' && !isAdmin() && !eventId) ? 'Toucher pour voir/marquer le plan accompagnant' : 'Toucher pour annoter') + '</div>' +
        '</div>'
      );
    }
    return (
      '<div class="circuit-visual-frame">' +
        '<div class="circuit-visual-btn circuit-visual-placeholder">Aucun plan importé pour ce circuit</div>' +
      '</div>'
    );
  }

  function saveCircuitInfo() {
    if (!isAdmin()) return;
    var kmRaw = document.getElementById('ci-km').value.trim().replace(',', '.');
    var rightRaw = document.getElementById('ci-right').value.trim();
    var leftRaw = document.getElementById('ci-left').value.trim();
    var km = kmRaw ? parseFloat(kmRaw) : null;
    var right = rightRaw ? parseInt(rightRaw, 10) : null;
    var left = leftRaw ? parseInt(leftRaw, 10) : null;
    var organizerTeamId = document.getElementById('ci-organizer').value;
    var briefing = document.getElementById('ci-briefing').value.trim();
    var horaires = {};
    var anyHoraire = false;
    HORAIRES_GROUPS.forEach(function (g) {
      var el = document.getElementById('ci-horaires-' + g.key);
      var v = el ? el.value.trim() : '';
      if (v) { horaires[g.key] = v; anyHoraire = true; }
    });
    var prevState = JSON.parse(JSON.stringify(STATE));
    STATE.circuits = STATE.circuits || {};
    var entry = STATE.circuits[selectedCircuit] || {};
    entry.km = (km != null && !isNaN(km)) ? km : null;
    entry.turnsRight = (right != null && !isNaN(right)) ? right : null;
    entry.turnsLeft = (left != null && !isNaN(left)) ? left : null;
    entry.organizerTeamId = organizerTeamId || null;
    entry.briefing = briefing || null;
    entry.horaires = anyHoraire ? horaires : null;
    STATE.circuits[selectedCircuit] = entry;
    editingCircuitInfo = false;
    renderRoot();
    persist(prevState);
  }

  // ---- Écran d'annotation (calque façon Paint sur le tracé du circuit) ----

  var annotCanvasEl = null;
  var annotInnerEl = null;
  var annotView = { scale: 1, x: 0, y: 0 };
  var annotPointers = new Map(); // pointerId -> {x, y} in client coords
  var annotPinch = null; // {startDist, startMidLocal, startScale, startX, startY}
  // Retained-mode model so strokes/text can be undone and moved after the
  // fact. Coordinates/sizes are stored as FRACTIONS of the canvas buffer's
  // current width/height (not raw pixels) so they survive a real canvas
  // resize (e.g. the force-landscape rotation swapping width/height)
  // without any manual rescale math — a redraw just multiplies by whatever
  // canvas.width/height currently are.
  var annotObjects = []; // {type:'stroke', tool, color, sizeFrac, points:[{nx,ny}]} | {type:'text', text, color, nx, ny, fontSizeFrac}
  var annotUndoStack = []; // [{baseVisible, objects}], most recent last
  var annotBaseImageObj = null; // previously-saved PNG (Image), immutable background layer
  var annotBaseImageVisible = false;
  var annotCurrentStroke = null; // in-progress stroke object while drawing
  var annotDrag = null; // {obj, startNx, startNy, origPoints|origXY}
  // The canvas drawing buffer is rendered at this many buffer-pixels per CSS
  // pixel so strokes and text stay crisp on retina phones, and stay crisp
  // when the rider pinch-zooms in to add fine detail. Capped at 3 so the
  // saved PNG doesn't balloon on very high-DPI devices.
  var ANNOT_DPR = Math.max(1, Math.min(window.devicePixelRatio || 1, 3));

  // Sentinel session id meaning "the circuit's own plan, not tied to any
  // particular chrono" -- lets a rider annotate a track (braking markers,
  // lines) before ever logging a session there. Personal to each account
  // (one shared base plan, everyone's own marks on top) -- stored on
  // STATE.circuits[circuit].drawings[riderName] instead of a single
  // shared field or a STATE.sessions[] entry.
  var ANNOT_CIRCUIT_LEVEL = '__circuit__';

  // A third level, one per sortie: opening the map from an event's own
  // card (Événements -> "En cours") always starts from a blank layer for
  // that sortie specifically, rather than the circuit-level plan that
  // otherwise accumulates every trait ever drawn on that track across
  // every past outing. Its drawing is stored on the event doc itself
  // (STATE.events[].drawing), keyed 'event:<eventId>' in annot.sessionId.
  var ANNOT_EVENT_PREFIX = 'event:';
  function eventLevelSessionId(eventId) { return ANNOT_EVENT_PREFIX + eventId; }
  function isEventLevelId(sessionId) { return typeof sessionId === 'string' && sessionId.indexOf(ANNOT_EVENT_PREFIX) === 0; }
  function eventIdFromLevelId(sessionId) { return sessionId.slice(ANNOT_EVENT_PREFIX.length); }

  // A fourth level: one accompagnant-facing plan per circuit, independent
  // of any sortie/session -- toilettes, douches, buvette/restaurant, point
  // de vue, paddock/box, marked once and valid for every future outing at
  // that circuit rather than redrawn per event. Also personal per account,
  // same shape as the circuit-level plan above -- stored on the circuit
  // doc as STATE.circuits[circuit].accompagnantDrawings[riderName].
  var ANNOT_ACCOMPAGNANT_LEVEL = '__accompagnant__';

  // Read-only view of another account's own circuit-level/accompagnant
  // plan (see the annot.viewOnly branches in renderAnnotationOverlay/
  // saveAnnotation) -- lets a coach show a pupil their own line, or an
  // accompagnant check what a teammate already marked, without either
  // account's layer ever overwriting the other's (see the per-user
  // drawings/accompagnantDrawings maps above).
  var ANNOT_VIEW_PREFIX = 'viewer:';
  function viewLevelSessionId(level, name) { return ANNOT_VIEW_PREFIX + level + ':' + name; }
  function isViewLevelId(sessionId) { return typeof sessionId === 'string' && sessionId.indexOf(ANNOT_VIEW_PREFIX) === 0; }
  function parseViewLevelId(sessionId) {
    var rest = sessionId.slice(ANNOT_VIEW_PREFIX.length);
    var sep = rest.indexOf(':');
    return { level: rest.slice(0, sep), name: rest.slice(sep + 1) };
  }

  function openAnnotation(circuit, eventId) {
    var sessions = circuitSessionsDesc(circuit);
    annot.open = true;
    annot.circuit = circuit;
    annot.eventId = eventId || null;
    if (eventId) {
      annot.sessionId = eventLevelSessionId(eventId);
    } else if (currentUserProfile && currentUserProfile.role === 'accompagnant' && !isAdmin()) {
      annot.sessionId = ANNOT_ACCOMPAGNANT_LEVEL;
    } else {
      annot.sessionId = sessions.length ? sessions[0].id : ANNOT_CIRCUIT_LEVEL;
    }
    annot.tool = 'brush';
    annot.viewOnly = false;
    annot.viewOnlyName = null;
    renderAnnotationOverlay();
  }

  function closeAnnotation() {
    annot.open = false;
    annot.eventId = null;
    annot.viewOnly = false;
    annot.viewOnlyName = null;
    var overlay = document.getElementById('annot-overlay');
    if (overlay) {
      overlay.classList.remove('open');
      overlay.classList.remove('force-landscape');
      overlay.innerHTML = '';
    }
    document.body.classList.remove('annot-forced-landscape');
    annotCanvasEl = null;
    annotInnerEl = null;
    annotPointers.clear();
    annotPinch = null;
    annotObjects = [];
    annotUndoStack = [];
    annotBaseImageObj = null;
    annotBaseImageVisible = false;
    annotCurrentStroke = null;
    annotDrag = null;
    window.removeEventListener('resize', onAnnotResize);
    window.removeEventListener('orientationchange', onAnnotOrientationChange);
    window.removeEventListener('keydown', onAnnotKeydown);
    if (document.fullscreenElement || document.webkitFullscreenElement) {
      var exit = document.exitFullscreen || document.webkitExitFullscreen;
      if (exit) exit.call(document).catch(function () {});
    }
  }

  // iOS Safari (including "Add to Home Screen" apps) does not implement the
  // Fullscreen API or Screen Orientation lock at all, so relying on those
  // silently does nothing on an iPhone. Instead we rotate the whole overlay
  // 90° with CSS so it visually fills the screen in landscape regardless of
  // how the phone is physically held — this works on every browser.
  function toggleAnnotFullscreen() {
    var overlay = document.getElementById('annot-overlay');
    if (!overlay) return;

    // Deliberately NOT using the real Fullscreen API here: iOS Safari
    // (including "Add to Home Screen" apps) doesn't support it at all, and
    // on browsers that DO support it, becoming the fullscreen element hands
    // the box to the browser's own top-layer fullscreen rendering, which
    // overrides our custom rotate/size transform outright. The CSS rotation
    // trick below is the one mechanism that works consistently everywhere.
    var isPortrait = window.matchMedia && window.matchMedia('(orientation: portrait)').matches;
    if (!isPortrait) {
      showToast('Déjà en mode paysage.');
      return;
    }
    var forced = overlay.classList.toggle('force-landscape');
    document.body.classList.toggle('annot-forced-landscape', forced);
    // Layout box swapped dimensions — resize the drawing surface to match
    // once the browser has applied the new transform.
    requestAnimationFrame(function () {
      requestAnimationFrame(resizeAnnotCanvasPreserving);
    });
  }

  // Plain window resize (also fires when a real Fullscreen API request
  // succeeds, e.g. on desktop/Android — that is NOT a device rotation) just
  // needs the canvas resized to match the new box.
  function onAnnotResize() {
    if (!annot.open) return;
    resizeAnnotCanvasPreserving();
  }

  // orientationchange only fires on an actual device rotation, so it is the
  // right (and only) signal to auto-drop the force-landscape CSS hack —
  // using 'resize' for this too would misfire when requestFullscreen()
  // succeeds and briefly reports a landscape-shaped viewport on its own.
  function onAnnotOrientationChange() {
    var overlay = document.getElementById('annot-overlay');
    if (!overlay || !annot.open) return;
    var isPortrait = window.matchMedia && window.matchMedia('(orientation: portrait)').matches;
    if (!isPortrait && overlay.classList.contains('force-landscape')) {
      overlay.classList.remove('force-landscape');
      document.body.classList.remove('annot-forced-landscape');
    }
    resizeAnnotCanvasPreserving();
  }

  function renderAnnotationOverlay() {
    var overlay = document.getElementById('annot-overlay');
    if (!overlay) return;
    if (!annot.open) {
      overlay.classList.remove('open');
      overlay.innerHTML = '';
      return;
    }
    var info = circuitInfo(annot.circuit);
    var sessions = circuitSessionsDesc(annot.circuit);
    var showRiderInOption = selectedRiders && selectedRiders.size !== 1;
    // A circuit-level entry always leads the list, so the plan can be
    // annotated (braking markers, lines) before any chrono is logged there
    // -- alongside one entry per session, each with its own drawing.
    var options = '';
    if (annot.eventId) {
      var evForAnnot = eventsList().filter(function (e) { return e.id === annot.eventId; })[0];
      var evDrawing = evForAnnot && evForAnnot.drawing;
      var evLevelId = eventLevelSessionId(annot.eventId);
      options += '<option value="' + evLevelId + '"' + (annot.sessionId === evLevelId ? ' selected' : '') + '>' +
        'Cet événement (nouveau plan)' + (evDrawing ? ' ✎' : '') + '</option>';
    }
    var myAnnotName = currentUserProfile && currentUserProfile.name;
    options += '<option value="' + ANNOT_CIRCUIT_LEVEL + '"' + (annot.sessionId === ANNOT_CIRCUIT_LEVEL ? ' selected' : '') + '>' +
      'Plan général' + (myAnnotName && info.drawings && info.drawings[myAnnotName] ? ' ✎' : '') + '</option>';
    Object.keys(info.drawings || {}).filter(function (name) { return name !== myAnnotName; }).sort().forEach(function (name) {
      var vId = viewLevelSessionId('circuit', name);
      options += '<option value="' + vId + '"' + (annot.sessionId === vId ? ' selected' : '') + '>' +
        '👁 Plan général de ' + escapeHtml(name) + '</option>';
    });
    options += '<option value="' + ANNOT_ACCOMPAGNANT_LEVEL + '"' + (annot.sessionId === ANNOT_ACCOMPAGNANT_LEVEL ? ' selected' : '') + '>' +
      'Plan accompagnant' + (myAnnotName && info.accompagnantDrawings && info.accompagnantDrawings[myAnnotName] ? ' ✎' : '') + '</option>';
    Object.keys(info.accompagnantDrawings || {}).filter(function (name) { return name !== myAnnotName; }).sort().forEach(function (name) {
      var vId2 = viewLevelSessionId('accompagnant', name);
      options += '<option value="' + vId2 + '"' + (annot.sessionId === vId2 ? ' selected' : '') + '>' +
        '👁 Plan accompagnant de ' + escapeHtml(name) + '</option>';
    });
    options += sessions.map(function (s) {
      var label = formatDate(s.date) + ' — ' + formatTime(sessionBest(s)) + (showRiderInOption ? ' — ' + s.rider : '') + (s.drawing ? ' ✎' : '');
      return '<option value="' + s.id + '"' + (s.id === annot.sessionId ? ' selected' : '') + '>' + escapeHtml(label) + '</option>';
    }).join('');

    var html = '';
    var svgFullscreen = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M16 3h3a2 2 0 0 1 2 2v3"/><path d="M21 16v3a2 2 0 0 1-2 2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/></svg>';

    html += '<div class="annot-header">';
    html += '<button type="button" class="ghost icon-btn" id="annot-close" aria-label="Fermer">←</button>';
    html += '<div class="annot-title">' + escapeHtml(annot.circuit) + '</div>';
    html += '<select id="annot-session-select" aria-label="Événement à annoter">' + options + '</select>';
    html += '<button type="button" class="ghost icon-btn annot-fullscreen-btn" id="annot-fullscreen" aria-label="Plein écran paysage" title="Forcer l\'affichage paysage">' + svgFullscreen + '</button>';
    html += '</div>';
    html += '<div class="annot-orientation-hint">Astuce : passez le téléphone en mode paysage (ou utilisez le bouton paysage) pour annoter plus confortablement.</div>';
    html += '<div class="annot-body">';
    html += '<div class="annot-toolbar">';
    var svgBrush = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M18.5 2.5a2.1 2.1 0 0 1 3 3L11 16 6 18l2-5z"/><path d="M15 6l3 3"/></svg>';
    var svgEraser = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="12" width="18" height="7" rx="1.5" transform="rotate(-20 12 12)"/><path d="M4 20h16"/></svg>';
    var svgMove = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v18M3 12h18M6 6l-3 6 3 6M18 6l3 6-3 6M6 6l6-3 6 3M6 18l6 3 6-3"/></svg>';
    var svgClear = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/></svg>';
    var svgUndo = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7v6h6"/><path d="M3.5 13a8.5 8.5 0 1 0 2.3-7"/></svg>';
    var svgExport = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="M7 8l5-5 5 5"/><path d="M4 17v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/></svg>';
    // Read-only mode (see openAnnotationView) shows someone else's own
    // per-account plan -- no drawing tools, no save, just look/zoom/export,
    // since editing it would edit THEIR layer, not the viewer's.
    if (annot.viewOnly) {
      html += '<span class="help-text annot-viewonly-badge">👁 Plan de ' + escapeHtml(annot.viewOnlyName || '') + ' (lecture seule)</span>';
    } else {
      html += '<button type="button" class="annot-tool-btn" data-tool="brush" aria-label="Pinceau" title="Pinceau">' + svgBrush + '</button>';
      html += '<button type="button" class="annot-tool-btn" data-tool="eraser" aria-label="Gomme" title="Gomme">' + svgEraser + '</button>';
      html += '<button type="button" class="annot-tool-btn" data-tool="text" aria-label="Texte" title="Texte">T</button>';
      html += '<button type="button" class="annot-tool-btn" data-tool="move" aria-label="Déplacer" title="Déplacer un trait ou un texte">' + svgMove + '</button>';
      html += '<input type="color" id="annot-color" class="annot-color-input" value="' + annot.color + '" aria-label="Couleur" title="Couleur">';
      var SIZE_PRESETS = [2, 4, 8];
      var SIZE_LABELS = { 2: 'Fin', 4: 'Moyen', 8: 'Épais' };
      html += '<div class="annot-size-group" role="group" aria-label="Épaisseur du trait">';
      SIZE_PRESETS.forEach(function (s) {
        var dotPx = 3 + s;
        html += '<button type="button" class="annot-size-btn' + (annot.size === s ? ' active' : '') + '" data-size="' + s + '" aria-label="' + SIZE_LABELS[s] + '" title="' + SIZE_LABELS[s] + '">' +
          '<span class="annot-size-dot" style="width:' + dotPx + 'px;height:' + dotPx + 'px;"></span></button>';
      });
      html += '</div>';
    }
    html += '<div class="annot-zoom-group" role="group" aria-label="Zoom">';
    html += '<span class="annot-zoom-label">Zoom</span>';
    html += '<button type="button" class="annot-zoom-btn" id="annot-zoom-out" aria-label="Zoom arrière" title="Zoom arrière">−</button>';
    html += '<button type="button" class="ghost annot-zoom-value" id="annot-zoom-value" aria-label="Réinitialiser le zoom" title="Revenir à 100%">' + Math.round(annotView.scale * 100) + '%</button>';
    html += '<button type="button" class="annot-zoom-btn" id="annot-zoom-in" aria-label="Zoom avant" title="Zoom avant">+</button>';
    html += '</div>';
    html += '<button type="button" class="ghost icon-btn" id="annot-export" aria-label="Exporter en image" title="Afficher le tracé annoté en grand pour l\'enregistrer">' + svgExport + '</button>';
    if (!annot.viewOnly) {
      html += '<button type="button" class="ghost icon-btn" id="annot-undo" aria-label="Annuler" title="Annuler la dernière action (Ctrl+Z)">' + svgUndo + '</button>';
      html += '<button type="button" class="ghost icon-btn" id="annot-clear" aria-label="Tout effacer" title="Tout effacer">' + svgClear + '</button>';
      html += '<button type="button" class="primary annot-save-btn" id="annot-save">Enregistrer</button>';
    }
    html += '</div>';
    html += '<div class="annot-canvas-wrap' + (info.mapImage ? ' has-basemap' : '') + '" id="annot-canvas-wrap">';
    html += '<div class="annot-canvas-inner" id="annot-canvas-inner">';
    if (info.mapImage) html += '<img class="annot-basemap" src="' + info.mapImage + '" alt="">';
    html += '<canvas class="annot-canvas" id="annot-canvas"></canvas>';
    html += '</div>';
    html += '</div>';
    html += '</div>';

    overlay.innerHTML = html;
    overlay.classList.add('open');
    setupAnnotCanvas();
    attachAnnotHandlers();
    window.addEventListener('resize', onAnnotResize);
    window.addEventListener('orientationchange', onAnnotOrientationChange);
    window.addEventListener('keydown', onAnnotKeydown);
  }

  function onAnnotKeydown(e) {
    var isZ = e.key === 'z' || e.key === 'Z';
    if ((e.ctrlKey || e.metaKey) && isZ) {
      e.preventDefault();
      annotUndo();
    }
  }

  function setupAnnotCanvas() {
    var wrap = document.getElementById('annot-canvas-wrap');
    var canvas = document.getElementById('annot-canvas');
    var inner = document.getElementById('annot-canvas-inner');
    if (!wrap || !canvas || !inner) return;
    var size0 = annotWrapLocalSize();
    var w = Math.max(1, Math.round(size0.w * ANNOT_DPR));
    var h = Math.max(1, Math.round(size0.h * ANNOT_DPR));
    canvas.width = w;
    canvas.height = h;
    annotCanvasEl = canvas;
    annotInnerEl = inner;
    annotView = { scale: 1, x: 0, y: 0 };
    applyAnnotView();
    var ctx = canvas.getContext('2d');
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    annotObjects = [];
    annotUndoStack = [];
    annotCurrentStroke = null;
    annotDrag = null;
    annotBaseImageObj = null;
    annotBaseImageVisible = false;
    var existingDrawing = annot.sessionId === ANNOT_CIRCUIT_LEVEL
      ? (currentUserProfile && (circuitInfo(annot.circuit).drawings || {})[currentUserProfile.name])
      : annot.sessionId === ANNOT_ACCOMPAGNANT_LEVEL
        ? (currentUserProfile && (circuitInfo(annot.circuit).accompagnantDrawings || {})[currentUserProfile.name])
        : isViewLevelId(annot.sessionId)
          ? (function () {
              var parsed = parseViewLevelId(annot.sessionId);
              var map = parsed.level === 'accompagnant' ? circuitInfo(annot.circuit).accompagnantDrawings : circuitInfo(annot.circuit).drawings;
              return (map || {})[parsed.name];
            })()
          : isEventLevelId(annot.sessionId)
            ? (eventsList().filter(function (e) { return e.id === eventIdFromLevelId(annot.sessionId); })[0] || {}).drawing
            : (STATE.sessions.filter(function (s) { return s.id === annot.sessionId; })[0] || {}).drawing;
    if (existingDrawing) {
      var img = new Image();
      img.onload = function () {
        annotBaseImageObj = img;
        annotBaseImageVisible = true;
        redrawAnnotCanvas();
      };
      img.src = existingDrawing;
    }
  }

  // Resizes the canvas buffer to the wrap's current size (e.g. after the
  // force-landscape rotation swaps width/height) and redraws from the
  // retained object model — since objects are stored as fractions of the
  // buffer's own width/height, they land in the right place automatically.
  function resizeAnnotCanvasPreserving() {
    var wrap = document.getElementById('annot-canvas-wrap');
    var canvas = annotCanvasEl;
    if (!wrap || !canvas) return;
    var size1 = annotWrapLocalSize();
    var newW = Math.max(1, Math.round(size1.w * ANNOT_DPR));
    var newH = Math.max(1, Math.round(size1.h * ANNOT_DPR));
    if (newW === canvas.width && newH === canvas.height) return;
    canvas.width = newW;
    canvas.height = newH;
    var ctx = canvas.getContext('2d');
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    redrawAnnotCanvas();
  }

  // Clones the object list deeply (JSON-safe: plain numbers/strings only) so
  // undo snapshots aren't aliased to the live, still-mutable array/objects.
  function cloneAnnotObjects(arr) {
    return JSON.parse(JSON.stringify(arr));
  }

  // Call before any action that mutates the drawing (finishing a stroke,
  // baking text, clearing, moving an object) so Ctrl+Z / the undo button can
  // step back to exactly this point.
  function pushAnnotUndo() {
    annotUndoStack.push({ baseVisible: annotBaseImageVisible, objects: cloneAnnotObjects(annotObjects) });
    if (annotUndoStack.length > 30) annotUndoStack.shift();
  }

  function annotUndo() {
    if (!annotUndoStack.length) {
      showToast('Rien à annuler.');
      return;
    }
    var prev = annotUndoStack.pop();
    annotBaseImageVisible = prev.baseVisible;
    annotObjects = prev.objects;
    annotDrag = null;
    redrawAnnotCanvas();
  }

  // Full from-scratch redraw of the annotation layer: the (immutable) saved
  // base image first, then every retained object in creation order (order
  // matters for the eraser tool, which needs to punch through whatever was
  // drawn before it).
  function redrawAnnotCanvas() {
    var canvas = annotCanvasEl;
    if (!canvas) return;
    var ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (annotBaseImageVisible && annotBaseImageObj) {
      ctx.drawImage(annotBaseImageObj, 0, 0, canvas.width, canvas.height);
    }
    annotObjects.forEach(function (obj) { drawAnnotObject(obj, ctx, canvas); });
  }

  function drawAnnotObject(obj, ctx, canvas) {
    if (obj.type === 'stroke') {
      if (obj.points.length < 1) return;
      ctx.save();
      var lineWidth = obj.sizeFrac * canvas.width * (obj.tool === 'eraser' ? 3 : 1);
      if (obj.tool === 'eraser') {
        ctx.globalCompositeOperation = 'destination-out';
      } else {
        ctx.globalCompositeOperation = 'source-over';
        ctx.strokeStyle = obj.color;
      }
      ctx.lineWidth = lineWidth;
      ctx.beginPath();
      obj.points.forEach(function (p, i) {
        var x = p.nx * canvas.width, y = p.ny * canvas.height;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      if (obj.points.length === 1) {
        // A single tap with no movement: draw a dot, not an invisible path.
        var p0 = obj.points[0];
        ctx.lineTo(p0.nx * canvas.width + 0.01, p0.ny * canvas.height + 0.01);
      }
      ctx.stroke();
      ctx.restore();
    } else if (obj.type === 'text') {
      ctx.save();
      ctx.fillStyle = obj.color;
      ctx.font = '600 ' + (obj.fontSizeFrac * canvas.width) + 'px "IBM Plex Sans", sans-serif';
      ctx.textBaseline = 'middle';
      ctx.fillText(obj.text, obj.nx * canvas.width, obj.ny * canvas.height);
      ctx.restore();
    }
  }

  // Point-to-segment distance, used to hit-test strokes for the move tool.
  function annotPointSegDist(px, py, x1, y1, x2, y2) {
    var dx = x2 - x1, dy = y2 - y1;
    var lenSq = dx * dx + dy * dy;
    var t = lenSq > 0 ? ((px - x1) * dx + (py - y1) * dy) / lenSq : 0;
    t = Math.max(0, Math.min(1, t));
    var cx = x1 + t * dx, cy = y1 + t * dy;
    return Math.sqrt((px - cx) * (px - cx) + (py - cy) * (py - cy));
  }

  // Finds the top-most object under a buffer-pixel point, or null.
  function annotHitTest(px, py) {
    var canvas = annotCanvasEl;
    if (!canvas) return null;
    for (var i = annotObjects.length - 1; i >= 0; i--) {
      var obj = annotObjects[i];
      if (obj.type === 'text') {
        var ctx = canvas.getContext('2d');
        ctx.save();
        ctx.font = '600 ' + (obj.fontSizeFrac * canvas.width) + 'px "IBM Plex Sans", sans-serif';
        var width = ctx.measureText(obj.text).width;
        ctx.restore();
        var height = obj.fontSizeFrac * canvas.width * 1.3;
        var x = obj.nx * canvas.width, y = obj.ny * canvas.height;
        if (px >= x - 6 && px <= x + width + 6 && py >= y - height / 2 - 6 && py <= y + height / 2 + 6) {
          return obj;
        }
      } else if (obj.type === 'stroke') {
        var threshold = Math.max(obj.sizeFrac * canvas.width * 2, 22 * ANNOT_DPR);
        var pts = obj.points;
        var hit = false;
        if (pts.length === 1) {
          var d0 = annotDistance({ x: px, y: py }, { x: pts[0].nx * canvas.width, y: pts[0].ny * canvas.height });
          if (d0 <= threshold) hit = true;
        } else {
          for (var j = 0; j < pts.length - 1 && !hit; j++) {
            var x1 = pts[j].nx * canvas.width, y1 = pts[j].ny * canvas.height;
            var x2 = pts[j + 1].nx * canvas.width, y2 = pts[j + 1].ny * canvas.height;
            if (annotPointSegDist(px, py, x1, y1, x2, y2) <= threshold) hit = true;
          }
        }
        if (hit) return obj;
      }
    }
    return null;
  }

  function applyAnnotView() {
    if (!annotInnerEl) return;
    annotInnerEl.style.transform = 'translate(' + annotView.x + 'px,' + annotView.y + 'px) scale(' + annotView.scale + ')';
    var zoomLabel = document.getElementById('annot-zoom-value');
    if (zoomLabel) zoomLabel.textContent = Math.round(annotView.scale * 100) + '%';
  }

  // Zooms in/out by a fixed step, keeping the wrap's own center point
  // visually anchored — the same pivot-anchor math the pinch gesture uses,
  // just with a fixed pivot instead of the fingers' midpoint.
  function annotZoomStep(factor) {
    var wrap = document.getElementById('annot-canvas-wrap');
    if (!wrap) return;
    var rect = wrap.getBoundingClientRect();
    var centerLocal = annotClientToLocal(rect.left + rect.width / 2, rect.top + rect.height / 2);
    var newScale = Math.max(0.5, Math.min(6, annotView.scale * factor));
    var pivotX = (centerLocal.x - annotView.x) / annotView.scale;
    var pivotY = (centerLocal.y - annotView.y) / annotView.scale;
    annotView.scale = newScale;
    annotView.x = centerLocal.x - newScale * pivotX;
    annotView.y = centerLocal.y - newScale * pivotY;
    applyAnnotView();
  }

  function annotDistance(a, b) {
    var dx = a.x - b.x, dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  function annotMidpoint(a, b) {
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }

  // Converts a client (viewport) point into the LOCAL coordinate system that
  // #annot-canvas-inner's translate()/scale() transform operates in. That
  // local space is simply "pixels from the wrap's own top-left" UNLESS the
  // force-landscape CSS rotation hack is active, in which case the whole
  // subtree is additionally rotated 90° and a plain client-minus-rect
  // subtraction would be wrong — this undoes that fixed, known rotation.
  function annotClientToLocal(clientX, clientY) {
    var wrap = document.getElementById('annot-canvas-wrap');
    var overlay = document.getElementById('annot-overlay');
    var rect = wrap.getBoundingClientRect();
    var rotated = overlay && overlay.classList.contains('force-landscape');
    if (!rotated) {
      return { x: clientX - rect.left, y: clientY - rect.top };
    }
    var cx = rect.left + rect.width / 2;
    var cy = rect.top + rect.height / 2;
    var vx = clientX - cx, vy = clientY - cy;
    // Inverse of a 90° clockwise rotation about the center.
    var lx = vy, ly = -vx;
    var localW = rect.height, localH = rect.width; // dimensions swap under 90°
    return { x: lx + localW / 2, y: ly + localH / 2 };
  }

  // The wrap's own LOCAL (pre-rotation) box size. getBoundingClientRect()
  // always reports the on-screen, POST-rotation box, whose width/height are
  // swapped relative to local layout under the force-landscape 90° rotation
  // — this undoes that swap so callers get true local pixel dimensions.
  function annotWrapLocalSize() {
    var wrap = document.getElementById('annot-canvas-wrap');
    var overlay = document.getElementById('annot-overlay');
    if (!wrap) return { w: 0, h: 0 };
    var rect = wrap.getBoundingClientRect();
    var rotated = overlay && overlay.classList.contains('force-landscape');
    return rotated ? { w: rect.height, h: rect.width } : { w: rect.width, h: rect.height };
  }

  // Converts a point already in the wrap's LOCAL coordinate system (as
  // returned by annotClientToLocal) into a canvas drawing-buffer pixel —
  // undoes the pan/zoom transform applied to #annot-canvas-inner, then
  // scales from local CSS pixels to buffer pixels.
  function annotLocalToCanvasPoint(localX, localY) {
    var canvas = annotCanvasEl;
    if (!canvas) return { x: 0, y: 0 };
    var innerX = (localX - annotView.x) / annotView.scale;
    var innerY = (localY - annotView.y) / annotView.scale;
    var size = annotWrapLocalSize();
    return {
      x: innerX / (size.w || 1) * canvas.width,
      y: innerY / (size.h || 1) * canvas.height
    };
  }

  // Maps a client (viewport) coordinate to a pixel coordinate in the
  // canvas's drawing buffer, correctly accounting for BOTH the fixed 90°
  // force-landscape rotation (if active) and the current pan/zoom — a plain
  // getBoundingClientRect() ratio silently breaks under the rotation
  // because on-screen axes no longer line up with the buffer's own axes.
  function annotCanvasPointFromClient(clientX, clientY) {
    var localPt = annotClientToLocal(clientX, clientY);
    return annotLocalToCanvasPoint(localPt.x, localPt.y);
  }

  function annotDrawSegment(x0, y0, x1, y1) {
    var canvas = annotCanvasEl;
    if (!canvas) return;
    var ctx = canvas.getContext('2d');
    ctx.save();
    if (annot.tool === 'eraser') {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.lineWidth = annot.size * 3 * ANNOT_DPR;
    } else {
      ctx.globalCompositeOperation = 'source-over';
      ctx.strokeStyle = annot.color;
      ctx.lineWidth = annot.size * ANNOT_DPR;
    }
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
    ctx.restore();
  }

  // Unified gesture handling on the wrap: one finger draws (or drops a text
  // label), two fingers pan/zoom the view — same convention as most
  // sketching apps, and works with mouse too (mouse never has a 2nd pointer).
  function annotFinalizeCurrentStroke() {
    if (annotCurrentStroke) {
      annotObjects.push(annotCurrentStroke);
      annotCurrentStroke = null;
    }
  }

  function onAnnotWrapPointerDown(e) {
    var wrap = e.currentTarget;
    annotPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (annotPointers.size === 1) {
      if (annot.viewOnly) {
        // Read-only view of someone else's plan (see openAnnotationView) --
        // one-finger pan still works via the 'move' tool's else-branch
        // below being skipped entirely, so just let the tap through as a
        // no-op instead of drawing/erasing/dropping text on their layer.
      } else if (annot.tool === 'text') {
        e.preventDefault();
        // Text input/labels are children of the wrap (not the pan/zoomed
        // inner div), so they only need the rotation undone, not pan/zoom.
        var localTap = annotClientToLocal(e.clientX, e.clientY);
        showAnnotTextInput(localTap.x, localTap.y);
      } else if (annot.tool === 'move') {
        e.preventDefault();
        var canvasM = annotCanvasEl;
        var mpt = annotCanvasPointFromClient(e.clientX, e.clientY);
        var hitObj = annotHitTest(mpt.x, mpt.y);
        if (hitObj && canvasM) {
          try { wrap.setPointerCapture(e.pointerId); } catch (err) {}
          pushAnnotUndo();
          annotDrag = {
            obj: hitObj,
            startNx: mpt.x / canvasM.width,
            startNy: mpt.y / canvasM.height,
            orig: hitObj.type === 'text'
              ? { nx: hitObj.nx, ny: hitObj.ny }
              : { points: hitObj.points.map(function (p) { return { nx: p.nx, ny: p.ny }; }) }
          };
        } else {
          annotDrag = null;
        }
      } else {
        try { wrap.setPointerCapture(e.pointerId); } catch (err) {}
        var pt = annotCanvasPointFromClient(e.clientX, e.clientY);
        annot.drawing = true;
        annot.lastX = pt.x;
        annot.lastY = pt.y;
        pushAnnotUndo();
        var canvas2 = annotCanvasEl;
        annotCurrentStroke = {
          type: 'stroke',
          tool: annot.tool,
          color: annot.color,
          sizeFrac: (annot.size * ANNOT_DPR) / canvas2.width,
          points: [{ nx: pt.x / canvas2.width, ny: pt.y / canvas2.height }]
        };
      }
    } else if (annotPointers.size === 2) {
      annot.drawing = false;
      annotFinalizeCurrentStroke();
      annotDrag = null;
      var pending = document.getElementById('annot-text-input');
      if (pending) pending.blur();
      var pts = Array.from(annotPointers.values());
      var localA = annotClientToLocal(pts[0].x, pts[0].y);
      var localB = annotClientToLocal(pts[1].x, pts[1].y);
      annotPinch = {
        startDist: annotDistance(pts[0], pts[1]),
        startMidLocal: annotMidpoint(localA, localB),
        startScale: annotView.scale,
        startX: annotView.x,
        startY: annotView.y
      };
    }
    e.preventDefault();
  }

  function onAnnotWrapPointerMove(e) {
    if (!annotPointers.has(e.pointerId)) return;
    annotPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (annotPointers.size >= 2 && annotPinch) {
      var pts = Array.from(annotPointers.values()).slice(0, 2);
      var dist = annotDistance(pts[0], pts[1]);
      var localA = annotClientToLocal(pts[0].x, pts[0].y);
      var localB = annotClientToLocal(pts[1].x, pts[1].y);
      var midLocal = annotMidpoint(localA, localB);
      var scaleRatio = dist / (annotPinch.startDist || 1);
      var newScale = Math.max(0.5, Math.min(6, annotPinch.startScale * scaleRatio));
      // Keep the point under the fingers at pinch-start anchored under the
      // fingers' current midpoint as scale changes (standard pinch-zoom
      // pivot math), instead of naively adding the midpoint's raw delta —
      // the latter looks like it "doesn't zoom right", drifting the image
      // out from under your fingers as soon as the distance changes.
      var pivotX = (annotPinch.startMidLocal.x - annotPinch.startX) / annotPinch.startScale;
      var pivotY = (annotPinch.startMidLocal.y - annotPinch.startY) / annotPinch.startScale;
      annotView.scale = newScale;
      annotView.x = midLocal.x - newScale * pivotX;
      annotView.y = midLocal.y - newScale * pivotY;
      applyAnnotView();
      e.preventDefault();
      return;
    }
    if (annotPointers.size === 1 && annot.tool === 'move' && annotDrag) {
      var canvasM = annotCanvasEl;
      if (canvasM) {
        var mpt = annotCanvasPointFromClient(e.clientX, e.clientY);
        var nx = mpt.x / canvasM.width, ny = mpt.y / canvasM.height;
        var dnx = nx - annotDrag.startNx, dny = ny - annotDrag.startNy;
        var obj = annotDrag.obj;
        if (obj.type === 'text') {
          obj.nx = annotDrag.orig.nx + dnx;
          obj.ny = annotDrag.orig.ny + dny;
        } else {
          obj.points = annotDrag.orig.points.map(function (p) { return { nx: p.nx + dnx, ny: p.ny + dny }; });
        }
        redrawAnnotCanvas();
      }
      e.preventDefault();
      return;
    }
    if (annotPointers.size === 1 && annot.drawing && annotCurrentStroke) {
      var pt = annotCanvasPointFromClient(e.clientX, e.clientY);
      annotDrawSegment(annot.lastX, annot.lastY, pt.x, pt.y);
      annot.lastX = pt.x;
      annot.lastY = pt.y;
      var canvas2 = annotCanvasEl;
      annotCurrentStroke.points.push({ nx: pt.x / canvas2.width, ny: pt.y / canvas2.height });
      e.preventDefault();
    }
  }

  function onAnnotWrapPointerUp(e) {
    annotPointers.delete(e.pointerId);
    if (annotPointers.size < 2) annotPinch = null;
    if (annotPointers.size === 0) {
      annot.drawing = false;
      annotFinalizeCurrentStroke();
      annotDrag = null;
    }
  }

  // window.prompt() is blocked inside the artifact's sandboxed frame (no
  // allow-modals), so the text tool uses a small in-page input instead of a
  // native prompt dialog. Once confirmed, the text becomes a draggable
  // label the rider can reposition before "baking" it into the drawing.
  function showAnnotTextInput(wrapX, wrapY) {
    var wrap = document.getElementById('annot-canvas-wrap');
    if (!wrap) return;
    var existingInput = document.getElementById('annot-text-input');
    if (existingInput && existingInput.parentNode) existingInput.parentNode.removeChild(existingInput);

    var input = document.createElement('input');
    input.type = 'text';
    input.id = 'annot-text-input';
    input.className = 'annot-text-input';
    input.placeholder = 'Texte…';
    input.style.left = wrapX + 'px';
    input.style.top = wrapY + 'px';
    input.style.color = annot.color;
    input.style.fontSize = annot.fontSize + 'px';
    wrap.appendChild(input);
    input.focus();

    var committed = false;
    function commit() {
      if (committed) return;
      committed = true;
      var value = input.value.trim();
      if (input.parentNode) input.parentNode.removeChild(input);
      if (value) createAnnotTextLabel(value, wrapX, wrapY);
    }
    function cancel() {
      committed = true;
      if (input.parentNode) input.parentNode.removeChild(input);
    }
    input.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') { ev.preventDefault(); commit(); }
      else if (ev.key === 'Escape') { ev.preventDefault(); cancel(); }
    });
    input.addEventListener('blur', commit);
  }

  // A movable label the rider can drag with one finger to reposition, resize
  // with A-/A+, and then confirm (✓ bakes it into the canvas pixels) or
  // discard (×).
  function createAnnotTextLabel(text, wrapX, wrapY) {
    var wrap = document.getElementById('annot-canvas-wrap');
    if (!wrap) return;
    var size = annot.fontSize;
    var label = document.createElement('div');
    label.className = 'annot-text-label';
    label.textContent = text;
    label.style.left = wrapX + 'px';
    label.style.top = wrapY + 'px';
    label.style.color = annot.color;
    label.style.fontSize = size + 'px';
    wrap.appendChild(label);

    var controls = document.createElement('div');
    controls.className = 'annot-text-controls';
    controls.innerHTML =
      '<button type="button" class="annot-text-smaller" aria-label="Réduire le texte">A-</button>' +
      '<button type="button" class="annot-text-bigger" aria-label="Agrandir le texte">A+</button>' +
      '<button type="button" class="annot-text-confirm" aria-label="Valider le texte">✓</button>' +
      '<button type="button" class="annot-text-delete" aria-label="Supprimer le texte">×</button>';
    // Stop these buttons' pointerdown from bubbling to the wrap-level
    // gesture handler — it calls preventDefault() while the text tool is
    // active, which would otherwise silently swallow the click that follows.
    controls.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
    wrap.appendChild(controls);

    // Pure local-space arithmetic (offsetWidth/offsetHeight are layout
    // values, unaffected by any ancestor CSS transform) so this positions
    // correctly whether or not the force-landscape rotation is active —
    // using getBoundingClientRect() here would mix up the axes once rotated.
    function positionControls() {
      var leftPx = parseFloat(label.style.left) || 0;
      var topPx = parseFloat(label.style.top) || 0;
      var w = label.offsetWidth, h = label.offsetHeight;
      controls.style.left = (leftPx + w + 4) + 'px';
      controls.style.top = (topPx - h / 2 - 4) + 'px';
    }
    positionControls();

    var dragging = false, offsetX = 0, offsetY = 0;
    label.addEventListener('pointerdown', function (e) {
      dragging = true;
      try { label.setPointerCapture(e.pointerId); } catch (err) {}
      var localStart = annotClientToLocal(e.clientX, e.clientY);
      offsetX = localStart.x - (parseFloat(label.style.left) || 0);
      offsetY = localStart.y - (parseFloat(label.style.top) || 0);
      e.preventDefault();
      e.stopPropagation();
    });
    label.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      var localPt = annotClientToLocal(e.clientX, e.clientY);
      label.style.left = (localPt.x - offsetX) + 'px';
      label.style.top = (localPt.y - offsetY) + 'px';
      positionControls();
      e.preventDefault();
      e.stopPropagation();
    });
    function stopDrag(e) { dragging = false; if (e) e.stopPropagation(); }
    label.addEventListener('pointerup', stopDrag);
    label.addEventListener('pointercancel', stopDrag);

    function cleanup() {
      if (label.parentNode) label.parentNode.removeChild(label);
      if (controls.parentNode) controls.parentNode.removeChild(controls);
    }
    function resize(delta) {
      size = Math.max(12, Math.min(64, size + delta));
      label.style.fontSize = size + 'px';
      annot.fontSize = size; // next text starts at the last used size
      positionControls();
    }
    controls.querySelector('.annot-text-smaller').addEventListener('click', function (e) {
      e.stopPropagation();
      resize(-4);
    });
    controls.querySelector('.annot-text-bigger').addEventListener('click', function (e) {
      e.stopPropagation();
      resize(4);
    });
    controls.querySelector('.annot-text-confirm').addEventListener('click', function (e) {
      e.stopPropagation();
      // label.style.left/top ARE the local anchor (left edge, vertical
      // center — matching fillText's left-align/middle-baseline) that we've
      // been tracking all along, so convert straight from local space
      // instead of round-tripping through getBoundingClientRect(), which
      // reports an axis-swapped bounding box once the label is rotated.
      var localX = parseFloat(label.style.left) || 0;
      var localY = parseFloat(label.style.top) || 0;
      var pt = annotLocalToCanvasPoint(localX, localY);
      var canvas = annotCanvasEl;
      if (canvas) {
        // Buffer pixels per on-screen CSS pixel is just DPR/zoom — constant
        // regardless of rotation, since the canvas buffer is always sized
        // from its own local (un-rotated) box (see annotWrapLocalSize) and
        // rotation doesn't change lengths. Store the baked size as a
        // FRACTION of the buffer width so it survives a later resize.
        var bufferScale = ANNOT_DPR / annotView.scale;
        pushAnnotUndo();
        var textObj = {
          type: 'text',
          text: text,
          color: label.style.color,
          nx: pt.x / canvas.width,
          ny: pt.y / canvas.height,
          fontSizeFrac: (size * bufferScale) / canvas.width
        };
        annotObjects.push(textObj);
        drawAnnotObject(textObj, canvas.getContext('2d'), canvas);
      }
      cleanup();
    });
    controls.querySelector('.annot-text-delete').addEventListener('click', function (e) {
      e.stopPropagation();
      cleanup();
    });
  }

  function saveAnnotation() {
    if (!annotCanvasEl || annot.viewOnly) return;
    // any text label still pending gets baked in automatically on save
    var pendingConfirm = document.querySelector('.annot-text-confirm');
    if (pendingConfirm) pendingConfirm.click();
    var dataUrl = annotCanvasEl.toDataURL('image/png');
    var prevState = JSON.parse(JSON.stringify(STATE));
    if (annot.sessionId === ANNOT_CIRCUIT_LEVEL) {
      if (!currentUserProfile) return;
      STATE.circuits = STATE.circuits || {};
      var entry = STATE.circuits[annot.circuit] || {};
      entry.drawings = Object.assign({}, entry.drawings || {});
      entry.drawings[currentUserProfile.name] = dataUrl;
      STATE.circuits[annot.circuit] = entry;
    } else if (annot.sessionId === ANNOT_ACCOMPAGNANT_LEVEL) {
      if (!currentUserProfile) return;
      STATE.circuits = STATE.circuits || {};
      var accEntry = STATE.circuits[annot.circuit] || {};
      accEntry.accompagnantDrawings = Object.assign({}, accEntry.accompagnantDrawings || {});
      accEntry.accompagnantDrawings[currentUserProfile.name] = dataUrl;
      STATE.circuits[annot.circuit] = accEntry;
    } else if (isEventLevelId(annot.sessionId)) {
      var evForSave = STATE.events.filter(function (e) { return e.id === eventIdFromLevelId(annot.sessionId); })[0];
      if (evForSave) evForSave.drawing = dataUrl;
    } else {
      var session = STATE.sessions.filter(function (s) { return s.id === annot.sessionId; })[0];
      if (session) session.drawing = dataUrl;
    }
    persist(prevState);
    showToast('Annotation enregistrée.', 'success');
    renderAnnotationOverlay();
  }

  // Flattens the circuit map + annotations onto an opaque white background
  // (the canvas itself is transparent, so exporting it alone would give a
  // washed-out/see-through PNG) and shows it full-screen as a plain <img>.
  // Long-pressing an <img> is a native browser/OS feature ("Enregistrer
  // l'image") that works even inside a sandboxed, publicly-shared artifact —
  // unlike the `downloads` capability, which the platform disables the
  // moment an artifact is shared publicly (this one is, so riders can add
  // their own chronos), and unlike a script-triggered download, which the
  // viewer's sandbox blocks outright.
  // Human label for whichever plan annot.sessionId currently points at --
  // shared by the export preview's caption (see exportAnnotationPng) so
  // that, now several accounts can each have their own layer on the same
  // circuit, the saved/screenshotted image says whose plan it actually is.
  function annotCurrentLevelLabel() {
    if (annot.sessionId === ANNOT_CIRCUIT_LEVEL) return 'Plan général (' + ((currentUserProfile && currentUserProfile.name) || 'moi') + ')';
    if (annot.sessionId === ANNOT_ACCOMPAGNANT_LEVEL) return 'Plan accompagnant (' + ((currentUserProfile && currentUserProfile.name) || 'moi') + ')';
    if (isViewLevelId(annot.sessionId)) {
      var parsed = parseViewLevelId(annot.sessionId);
      return (parsed.level === 'accompagnant' ? 'Plan accompagnant' : 'Plan général') + ' de ' + parsed.name;
    }
    if (isEventLevelId(annot.sessionId)) return 'Plan de l\'événement';
    var session = STATE.sessions.filter(function (s) { return s.id === annot.sessionId; })[0];
    return session ? (formatDate(session.date) + ' — ' + formatTime(sessionBest(session))) : annot.circuit;
  }

  function exportAnnotationPng() {
    if (!annotCanvasEl) return;
    var pendingConfirm = document.querySelector('.annot-text-confirm');
    if (pendingConfirm) pendingConfirm.click();
    var canvas = annotCanvasEl;
    var out = document.createElement('canvas');
    out.width = canvas.width;
    out.height = canvas.height;
    var octx = out.getContext('2d');
    octx.fillStyle = '#ffffff';
    octx.fillRect(0, 0, out.width, out.height);
    var basemapImg = document.querySelector('#annot-canvas-wrap .annot-basemap');
    if (basemapImg && basemapImg.complete && basemapImg.naturalWidth) {
      // Replicate the on-screen "object-fit: contain" placement and the
      // basemap's reduced opacity so the export matches what's visible.
      var iw = basemapImg.naturalWidth, ih = basemapImg.naturalHeight;
      var scale = Math.min(out.width / iw, out.height / ih);
      var dw = iw * scale, dh = ih * scale;
      var dx = (out.width - dw) / 2, dy = (out.height - dh) / 2;
      octx.save();
      octx.globalAlpha = 0.55;
      octx.drawImage(basemapImg, dx, dy, dw, dh);
      octx.restore();
    }
    octx.drawImage(canvas, 0, 0, out.width, out.height);
    showAnnotImagePreview(out.toDataURL('image/png'), annot.circuit + ' — ' + annotCurrentLevelLabel());
  }

  function showAnnotImagePreview(dataUrl, caption) {
    var existing = document.getElementById('annot-image-preview');
    if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
    var overlay = document.createElement('div');
    overlay.id = 'annot-image-preview';
    overlay.className = 'annot-image-preview-overlay';
    overlay.innerHTML =
      '<button type="button" class="ghost icon-btn annot-image-preview-close" id="annot-image-preview-close" aria-label="Fermer">✕</button>' +
      (caption ? '<div class="annot-image-preview-caption">' + escapeHtml(caption) + '</div>' : '') +
      '<img src="' + dataUrl + '" alt="Tracé annoté">' +
      '<div class="annot-image-preview-hint">Appui long sur l’image pour l’enregistrer dans votre galerie photo (ou faites une capture d’écran).</div>';
    document.body.appendChild(overlay);
    function closePreview() { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); }
    document.getElementById('annot-image-preview-close').addEventListener('click', closePreview);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) closePreview(); });
  }

  function attachAnnotHandlers() {
    var closeBtn = document.getElementById('annot-close');
    if (closeBtn) closeBtn.addEventListener('click', closeAnnotation);

    var sessionSelect = document.getElementById('annot-session-select');
    if (sessionSelect) {
      sessionSelect.addEventListener('change', function () {
        annot.sessionId = sessionSelect.value;
        if (isViewLevelId(annot.sessionId)) {
          var parsed = parseViewLevelId(annot.sessionId);
          annot.viewOnly = true;
          annot.viewOnlyName = parsed.name;
        } else {
          annot.viewOnly = false;
          annot.viewOnlyName = null;
        }
        renderAnnotationOverlay();
      });
    }

    document.querySelectorAll('.annot-tool-btn[data-tool]').forEach(function (btn) {
      btn.classList.toggle('active', btn.getAttribute('data-tool') === annot.tool);
      btn.addEventListener('click', function () {
        annot.tool = btn.getAttribute('data-tool');
        document.querySelectorAll('.annot-tool-btn').forEach(function (b) {
          b.classList.toggle('active', b === btn);
        });
      });
    });

    var colorInput = document.getElementById('annot-color');
    if (colorInput) colorInput.addEventListener('input', function (e) { annot.color = e.target.value; });

    document.querySelectorAll('.annot-size-btn[data-size]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        annot.size = parseFloat(btn.getAttribute('data-size'));
        document.querySelectorAll('.annot-size-btn').forEach(function (b) {
          b.classList.toggle('active', b === btn);
        });
      });
    });

    var zoomValueBtn = document.getElementById('annot-zoom-value');
    if (zoomValueBtn) {
      zoomValueBtn.addEventListener('click', function () {
        annotView = { scale: 1, x: 0, y: 0 };
        applyAnnotView();
      });
    }
    var zoomOutBtn = document.getElementById('annot-zoom-out');
    if (zoomOutBtn) zoomOutBtn.addEventListener('click', function () { annotZoomStep(1 / 1.25); });
    var zoomInBtn = document.getElementById('annot-zoom-in');
    if (zoomInBtn) zoomInBtn.addEventListener('click', function () { annotZoomStep(1.25); });

    var undoBtn = document.getElementById('annot-undo');
    if (undoBtn) undoBtn.addEventListener('click', annotUndo);

    var clearBtn = document.getElementById('annot-clear');
    if (clearBtn) {
      clearBtn.addEventListener('click', function () {
        if (!annotCanvasEl) return;
        if (!annotObjects.length && !annotBaseImageVisible) return;
        pushAnnotUndo();
        annotObjects = [];
        annotBaseImageVisible = false;
        annotCurrentStroke = null;
        annotDrag = null;
        redrawAnnotCanvas();
      });
    }

    var saveBtn = document.getElementById('annot-save');
    if (saveBtn) saveBtn.addEventListener('click', saveAnnotation);

    var exportBtn = document.getElementById('annot-export');
    if (exportBtn) exportBtn.addEventListener('click', exportAnnotationPng);

    var fullscreenBtn = document.getElementById('annot-fullscreen');
    if (fullscreenBtn) fullscreenBtn.addEventListener('click', toggleAnnotFullscreen);

    var wrap = document.getElementById('annot-canvas-wrap');
    if (wrap) {
      wrap.addEventListener('pointerdown', onAnnotWrapPointerDown);
      wrap.addEventListener('pointermove', onAnnotWrapPointerMove);
      wrap.addEventListener('pointerup', onAnnotWrapPointerUp);
      wrap.addEventListener('pointercancel', onAnnotWrapPointerUp);
    }
  }

  // ---- Calendrier : sorties planifiées + sessions déjà roulées, en vue année/mois/semaine ----

  var MONTH_NAMES_FR = ['Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin', 'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre'];
  var WEEKDAY_LETTERS_FR = ['L', 'M', 'M', 'J', 'V', 'S', 'D'];

  // A personal/backfilled sortie (no teamId) is visible to everyone, same
  // as before Team Events existed -- that's what keeps "add my past
  // outings to rebuild my history" working for a brand-new account no
  // matter who organized them. A Team Event's visibility depends on the
  // owning Team: the leader/admin always sees it; a member of that Team
  // (any role) always sees it; so does anyone who's themselves riding it,
  // OR whose own team (any team they belong to, not just this event's
  // organizing one) has at least one member riding it -- e.g. an
  // accompagnant member of an amateur Team can see a Team PRO's event
  // that a teammate is actually participating in, without being a member
  // or adherent of that Team PRO themselves. Beyond that, a Team PRO's
  // own eventVisibility opens it further ('public'/'ouvert' to everyone,
  // 'adherent' to that Team's adherents) -- an amateur Team's events
  // never go past members/riders/teammates. Display-layer only (see
  // firestore.rules' events match), same convention as every other
  // audience filter in this app.
  function canSeeEvent(ev) {
    if (!ev.teamId) return true;
    var me = currentUserProfile;
    if (!me) return false;
    if (isAdmin() || isLeaderOfTeam(ev.teamId)) return true;
    var myTeamIds = (STATE.myTeamMemberships || []).map(function (m) { return m.teamId; });
    if (myTeamIds.indexOf(ev.teamId) !== -1) return true;
    if ((ev.riders || []).indexOf(me.name) !== -1) return true;
    // A teammate riding this event, even on a Team that organized it and
    // that I'm not myself a member of, opens it to me too -- e.g. an
    // accompagnant in Motop (amateur) can see a Mototeam95 event her own
    // Motop teammate is actually participating in, without being a
    // Mototeam95 member/adherent herself.
    var teammateRiding = myTeamIds.some(function (tid) {
      var roster = membersOfTeam(tid).map(function (m) { return m.name; });
      return (ev.riders || []).some(function (r) { return roster.indexOf(r) !== -1; });
    });
    if (teammateRiding) return true;
    var team = teamById(ev.teamId);
    if (team && team.teamPro) {
      var vis = ev.eventVisibility || 'membre';
      if (vis === 'public' || vis === 'ouvert') return true;
      if (vis === 'adherent') return (STATE.myFollowedTeamTiers || {})[ev.teamId] === 'adherent';
      if (vis === 'follower') return (STATE.myFollowedTeams || []).indexOf(ev.teamId) !== -1;
    }
    return false;
  }

  function eventsList() {
    STATE.events = STATE.events || [];
    return STATE.events.filter(canSeeEvent);
  }

  // Stricter than canSeeEvent, and only for the "En cours"/"À venir"/
  // "Passés" bands of the compte's own Événements tab -- being able to
  // *see* a Team PRO event (canSeeEvent) is not the same as it being
  // "mine": a plain member of Mototeam95 who never asked to join Barcelone
  // shouldn't find it sitting in their own upcoming sorties as if they
  // were already going -- it belongs in Découvrir des Événements instead,
  // with a join/request action, until they're actually on the roster.
  // Amateur Teams keep the old behaviour (any member's event is "theirs"
  // too, no per-event registration for a casual club ride) since that's
  // never had a request flow to begin with. Personal (no teamId) events
  // stay exactly as visible as canSeeEvent already makes them.
  function isMyEventForList(ev) {
    if (!ev.teamId) return true;
    var me = currentUserProfile;
    if (!me) return false;
    if (isAdmin() || isLeaderOfTeam(ev.teamId)) return true;
    if ((ev.riders || []).indexOf(me.name) !== -1) return true;
    var myTeamIds = (STATE.myTeamMemberships || []).map(function (m) { return m.teamId; });
    var teammateRiding = myTeamIds.some(function (tid) {
      var roster = membersOfTeam(tid).map(function (m) { return m.name; });
      return (ev.riders || []).some(function (r) { return roster.indexOf(r) !== -1; });
    });
    if (teammateRiding) return true;
    var team = teamById(ev.teamId);
    if (team && !team.teamPro && myTeamIds.indexOf(ev.teamId) !== -1) return true;
    return false;
  }

  // 'ouvert' Team Events self-register straight onto the event (see
  // firestore.rules' events update rule -- any verified account may add
  // *itself* to riders when eventVisibility is 'ouvert', nothing else).
  function selfJoinOuvertEvent(eventId) {
    var me = currentUserProfile;
    var ev = (STATE.events || []).filter(function (e) { return e.id === eventId; })[0];
    if (!me || !ev || (ev.riders || []).indexOf(me.name) !== -1) return;
    var riders = (ev.riders || []).concat([me.name]);
    db.collection('events').doc(eventId).update({ riders: riders }).then(function () {
      showToast('Tu as rejoint "' + ev.circuit + '".', 'success');
    }).catch(function (err) {
      showToast('Erreur : ' + (err && err.message ? err.message : err));
    });
  }
  // 'public' Team Events need the leader's OK -- id = eventId_from so a
  // second request overwrites instead of stacking, same shape as
  // teamJoinRequests; accept is the leader adding the rider to
  // event.riders themselves (already allowed) then deleting this doc.
  function requestJoinEvent(eventId) {
    var me = currentUserProfile;
    var ev = (STATE.events || []).filter(function (e) { return e.id === eventId; })[0];
    if (!me || !ev) return;
    db.collection('eventJoinRequests').doc(eventId + '_' + me.name).set({
      eventId: eventId, teamId: ev.teamId, circuit: ev.circuit, from: me.name, status: 'pending'
    }).then(function () {
      showToast('Demande envoyée.', 'success');
    }).catch(function (err) {
      showToast('Erreur : ' + (err && err.message ? err.message : err));
    });
  }
  function acceptEventJoinRequest(req) {
    var ev = (STATE.events || []).filter(function (e) { return e.id === req.eventId; })[0];
    if (!ev) return;
    var riders = (ev.riders || []).indexOf(req.from) === -1 ? (ev.riders || []).concat([req.from]) : (ev.riders || []);
    db.collection('events').doc(req.eventId).update({ riders: riders }).then(function () {
      return db.collection('eventJoinRequests').doc(req.id).delete();
    }).then(function () {
      showToast(req.from + ' a rejoint l\'événement.', 'success');
    }).catch(function (err) {
      showToast('Erreur : ' + (err && err.message ? err.message : err));
    });
  }
  // Same delete either way -- declining a request received or cancelling
  // one sent.
  function removeEventJoinRequest(id) {
    db.collection('eventJoinRequests').doc(id).delete().catch(function (err) {
      showToast('Erreur : ' + (err && err.message ? err.message : err));
    });
  }
  // Team Leader removing a participant from their own event's roster, from
  // the Team's "Gestion des événements" panel -- same field write as the
  // event form's own "Pilotes" list, just one click instead of re-editing
  // the whole comma-separated field.
  // Candidates for a Team Leader's search-to-add on an event: the Team's
  // own members plus the leader's own friends (admin sees everyone),
  // minus whoever's already a participant.
  function candidateRidersForTeamEvent(team, currentRiders) {
    var known = {};
    membersOfTeam(team.id).forEach(function (m) { known[m.name] = true; });
    if (currentUserProfile) friendsOf(currentUserProfile.name).forEach(function (f) { known[f.name] = true; });
    if (isAdmin()) allKnownUserNames().forEach(function (n) { known[n] = true; });
    return Object.keys(known).filter(function (n) { return currentRiders.indexOf(n) === -1; }).sort();
  }
  function addRiderToEvent(eventId, rider) {
    var ev = (STATE.events || []).filter(function (e) { return e.id === eventId; })[0];
    if (!ev || !rider) return;
    var riders = ev.riders || [];
    if (riders.indexOf(rider) !== -1) return;
    db.collection('events').doc(eventId).update({ riders: riders.concat([rider]) }).catch(function (err) {
      showToast('Erreur : ' + (err && err.message ? err.message : err));
    });
  }
  function removeRiderFromEvent(eventId, rider) {
    var ev = (STATE.events || []).filter(function (e) { return e.id === eventId; })[0];
    if (!ev) return;
    var riders = (ev.riders || []).filter(function (r) { return r !== rider; });
    db.collection('events').doc(eventId).update({ riders: riders }).catch(function (err) {
      showToast('Erreur : ' + (err && err.message ? err.message : err));
    });
  }
  // Free-text broadcast from a Team Leader to an event's pilotes -- "ADMINISTRATION
  // OUVERTE DE 18H A 20H CE SOIR", "BRIEFING DEMAIN A 8H15", "INCIDENT SUR LA
  // PISTE : TRAITEMENT"... left entirely free-form, no preset templates, per
  // "laisser champs libre d'écriture aux Team Leaders".
  function sendEventAnnouncement(eventId, teamId, text) {
    var me = currentUserProfile;
    text = (text || '').trim();
    if (!me || !text) return;
    db.collection('eventAnnouncements').add({ eventId: eventId, teamId: teamId, from: me.name, fromUid: myUid(), text: text, createdAt: Date.now() }).catch(function (err) {
      showToast('Erreur : ' + (err && err.message ? err.message : err));
    });
  }
  function updateEventAnnouncement(id, text) {
    text = (text || '').trim();
    if (!text) return;
    db.collection('eventAnnouncements').doc(id).update({ text: text, editedAt: Date.now() }).then(function () {
      editingAnnouncementId = null;
      renderRoot();
    }).catch(function (err) {
      showToast('Erreur : ' + (err && err.message ? err.message : err));
    });
  }
  function deleteEventAnnouncement(id) {
    db.collection('eventAnnouncements').doc(id).delete().catch(function (err) {
      showToast('Erreur : ' + (err && err.message ? err.message : err));
    });
  }
  var editingAnnouncementId = null; // id of the one announcement currently shown as an inline edit form, or null
  // Reused both in the Team's "Gestion des événements" (leader, with the
  // posting form and edit/delete) and in Planning for a rider on that
  // event (read-only) -- isLeader controls whether those show.
  function renderEventAnnouncements(ev, isLeader) {
    var posts = (STATE.eventAnnouncements || []).filter(function (a) { return a.eventId === ev.id; });
    if (!posts.length && !isLeader) return '';
    var body = !posts.length
      ? '<div class="empty-state">Aucune annonce pour l\'instant.</div>'
      : posts.map(function (a) {
        if (isLeader && editingAnnouncementId === a.id) {
          return '<form class="coach-message-form" data-action="event-announcement-edit-form" data-id="' + a.id + '">' +
            '<input type="text" value="' + escapeHtml(a.text) + '" data-event-announcement-edit-input>' +
            '<button type="submit" class="primary">Enregistrer</button>' +
            '<button type="button" class="ghost" data-action="event-announcement-edit-cancel">Annuler</button></form>';
        }
        var actions = isLeader
          ? '<button type="button" class="ghost icon-btn" data-action="event-announcement-edit" data-id="' + a.id + '" aria-label="Modifier" title="Modifier">✎</button>' +
            '<button type="button" class="ghost icon-btn" data-action="event-announcement-delete" data-id="' + a.id + '" aria-label="Supprimer" title="Supprimer">×</button>'
          : '';
        return '<div class="coach-message"><div class="coach-message-head">' + personNameHtml(a.from) +
          '<span class="feed-entry-time">' + escapeHtml(relativeTime(a.editedAt || a.createdAt)) + (a.editedAt ? ' (modifié)' : '') + '</span>' + actions + '</div>' +
          '<div class="coach-message-text">' + escapeHtml(a.text) + '</div></div>';
      }).join('');
    if (isLeader) {
      body += '<form class="coach-message-form" data-action="event-announcement-form" data-event-id="' + ev.id + '" data-team-id="' + ev.teamId + '">' +
        '<input type="text" placeholder="Ex. BRIEFING DEMAIN A 8H15" data-event-announcement-input>' +
        '<button type="submit" class="primary">Envoyer</button></form>';
    }
    return collapsibleSection('event-announcements-' + ev.id, 'Annonces' + (posts.length ? ' (' + posts.length + ')' : ''), body, true);
  }

  // Team-Leader-only free text blocks on the event itself (unlike
  // Annonces, a running thread, these are single fields the leader
  // keeps up to date) -- "Infos pratiques" (parking, accès, restauration...)
  // and, optionally, special activities for the day (baptêmes, coaching).
  // Both live in the orange "TEAM PRO" card since they're organizer-
  // provided, not personal info.
  var editingPracticalInfoFor = null;
  var editingSpecialActivitiesFor = null;
  var editingRentalMotosFor = null;
  var editingRentalEquipementFor = null;
  function savePracticalInfo(eventId, text) {
    db.collection('events').doc(eventId).update({ practicalInfo: (text || '').trim() || null }).then(function () {
      editingPracticalInfoFor = null;
      renderRoot();
    }).catch(function (err) {
      showToast('Erreur : ' + (err && err.message ? err.message : err));
    });
  }
  function saveSpecialActivities(eventId, text) {
    db.collection('events').doc(eventId).update({ specialActivities: (text || '').trim() || null }).then(function () {
      editingSpecialActivitiesFor = null;
      renderRoot();
    }).catch(function (err) {
      showToast('Erreur : ' + (err && err.message ? err.message : err));
    });
  }
  function saveRentalMotos(eventId, text) {
    db.collection('events').doc(eventId).update({ rentalMotos: (text || '').trim() || null }).then(function () {
      editingRentalMotosFor = null;
      renderRoot();
    }).catch(function (err) {
      showToast('Erreur : ' + (err && err.message ? err.message : err));
    });
  }
  function saveRentalEquipement(eventId, text) {
    db.collection('events').doc(eventId).update({ rentalEquipement: (text || '').trim() || null }).then(function () {
      editingRentalEquipementFor = null;
      renderRoot();
    }).catch(function (err) {
      showToast('Erreur : ' + (err && err.message ? err.message : err));
    });
  }
  function renderEventLeaderTextSection(ev, isLeader, opts) {
    var value = ev[opts.field] || '';
    var editing = opts.editingId() === ev.id;
    if (!value && !isLeader) return '';
    var body;
    if (editing) {
      body = '<textarea id="' + opts.inputId + '" rows="3" placeholder="' + escapeHtml(opts.placeholder) + '">' + escapeHtml(value) + '</textarea>' +
        '<div style="margin-top:0.5rem; display:flex; gap:0.5rem;">' +
        '<button type="button" class="primary" data-action="' + opts.saveAction + '" data-id="' + ev.id + '">Enregistrer</button>' +
        '<button type="button" class="ghost" data-action="' + opts.cancelAction + '">Annuler</button></div>';
    } else {
      body = value ? '<div class="help-text" style="white-space:pre-wrap;">' + escapeHtml(value) + '</div>' : '<div class="help-text">Rien renseigné pour l\'instant.</div>';
      if (isLeader) body += '<button type="button" class="ghost" data-action="' + opts.editAction + '" data-id="' + ev.id + '" style="margin-top:0.5rem;">' + (value ? 'Modifier' : 'Compléter') + '</button>';
    }
    return collapsibleSection(opts.key + '-' + ev.id, opts.label, body, !!value);
  }
  function renderPracticalInfoSection(ev, isLeader) {
    return renderEventLeaderTextSection(ev, isLeader, {
      field: 'practicalInfo', key: 'infos-pratiques-team', label: 'Infos pratiques',
      inputId: 'practical-info-input', placeholder: 'Ex. Parking, accès paddock, restauration...',
      editingId: function () { return editingPracticalInfoFor; },
      saveAction: 'save-practical-info', cancelAction: 'cancel-practical-info', editAction: 'edit-practical-info'
    });
  }
  function renderSpecialActivitiesSection(ev, isLeader) {
    return renderEventLeaderTextSection(ev, isLeader, {
      field: 'specialActivities', key: 'special-activities', label: 'Baptêmes, coaching...',
      inputId: 'special-activities-input', placeholder: 'Ex. Baptêmes de piste 12h-14h, coaching sur inscription...',
      editingId: function () { return editingSpecialActivitiesFor; },
      saveAction: 'save-special-activities', cancelAction: 'cancel-special-activities', editAction: 'edit-special-activities'
    });
  }
  // Espace location -- ce que l'organisateur peut fournir sur place, pour
  // ses pilotes comme pour les baptêmes piste. Même famille que Infos
  // pratiques/Baptêmes-coaching ci-dessus (texte libre, pas un système de
  // réservation avec quotas/stock -- l'organisateur décrit ce qu'il a, les
  // intéressés le contactent), deux champs séparés puisque moto et
  // équipement sont des besoins différents.
  function renderRentalMotosSection(ev, isLeader) {
    return renderEventLeaderTextSection(ev, isLeader, {
      field: 'rentalMotos', key: 'rental-motos', label: 'Location — Motos',
      inputId: 'rental-motos-input', placeholder: 'Ex. 2 CBR600 dispo pour les baptêmes, 1 pour un pilote -- contacter Marc',
      editingId: function () { return editingRentalMotosFor; },
      saveAction: 'save-rental-motos', cancelAction: 'cancel-rental-motos', editAction: 'edit-rental-motos'
    });
  }
  function renderRentalEquipementSection(ev, isLeader) {
    return renderEventLeaderTextSection(ev, isLeader, {
      field: 'rentalEquipement', key: 'rental-equipement', label: 'Location — Équipement',
      inputId: 'rental-equipement-input', placeholder: 'Ex. Combinaisons et casques toutes tailles, pilotes et baptêmes',
      editingId: function () { return editingRentalEquipementFor; },
      saveAction: 'save-rental-equipement', cancelAction: 'cancel-rental-equipement', editAction: 'edit-rental-equipement'
    });
  }

  // "Découvrir les Événements PRO" -- every Team PRO event this account
  // isn't already riding, open enough for it to request/self-join given
  // its own relationship to the owning Team ('adherent'/'follower' need
  // the matching tier, 'public'/'ouvert' are open to everyone). 'membre'
  // stays leader-curated only -- no self-request path, same as before.
  // Amateur Team Events never show up here -- per the brief, only
  // invited members/friends ever see those at all.
  var discoveryViewMode = 'list'; // 'list' | 'month' | 'year' -- Découvrir des Événements PRO
  var discoverySortMode = 'date'; // 'date' | 'team' -- list view only
  var discoveryCalendarAnchor = dateKey(new Date());
  var discoverySelectedDate = null; // a date clicked in the month/year view, or null

  // One dateKey -> [eventId,...] map over just the candidates passed in --
  // its own tiny version of eventDateInfoAll() (which scans eventsList(),
  // a different set: everything this account can already see, not what
  // it's discovering) since a discoverable event is deliberately outside
  // that list.
  function discoveryEventInfo(candidates) {
    var map = {};
    candidates.forEach(function (ev) {
      var start = parseLocalDate(ev.dateStart);
      var end = parseLocalDate(ev.dateEnd || ev.dateStart);
      var cur = new Date(start.getTime());
      var guard = 0;
      while (cur.getTime() <= end.getTime() && guard < 400) {
        guard++;
        var key = dateKey(cur);
        (map[key] = map[key] || []).push(ev.id);
        cur.setDate(cur.getDate() + 1);
      }
    });
    return map;
  }

  // Its own small month grid (not renderMonthGrid) -- that one is tied to
  // the personal calendar's own anchor/selectedEventId and eventsList(),
  // neither of which apply here.
  function renderDiscoveryCalendar(candidates) {
    var info = discoveryEventInfo(candidates);
    var anchor = parseLocalDate(discoveryCalendarAnchor);
    var year = anchor.getFullYear(), month = anchor.getMonth();
    var firstDow = (new Date(year, month, 1).getDay() + 6) % 7;
    var daysInMonth = new Date(year, month + 1, 0).getDate();
    var todayKey = dateKey(new Date());
    var html = '<div class="calendar-nav-card" style="margin-bottom:0.6rem;">' +
      '<button type="button" class="ghost icon-btn" id="discovery-cal-prev" aria-label="Mois précédent">‹</button>' +
      '<div class="calendar-year-label">' + MONTH_NAMES_FR[month] + ' ' + year + '</div>' +
      '<button type="button" class="ghost icon-btn" id="discovery-cal-next" aria-label="Mois suivant">›</button>' +
      '</div>';
    html += '<div class="cal-month cal-month-large">';
    html += '<div class="cal-weekdays">' + WEEKDAY_LETTERS_FR.map(function (w) { return '<span>' + w + '</span>'; }).join('') + '</div>';
    html += '<div class="cal-days cal-days-large">';
    for (var i = 0; i < firstDow; i++) html += '<span class="cal-day cal-day-large empty"></span>';
    for (var d = 1; d <= daysInMonth; d++) {
      var key = year + '-' + pad2(month + 1) + '-' + pad2(d);
      var ids = info[key];
      var classes = 'cal-day cal-day-large';
      if (ids && ids.length) classes += ' has-event';
      if (key === todayKey) classes += ' today';
      if (key === discoverySelectedDate) classes += ' selected';
      html += (ids && ids.length)
        ? '<button type="button" class="calendar-cell ' + classes + '" data-discovery-date="' + key + '">' + d + '</button>'
        : '<span class="' + classes + '">' + d + '</span>';
    }
    html += '</div></div>';
    return html;
  }

  // The compact per-month tile used by the year view (12 of these) -- its
  // own version of renderMonthMini using data-discovery-date instead of
  // data-date, so its cells never get picked up by the personal
  // calendar's own click wiring (see the .calendar-cell[data-date]
  // handler in attachHandlers).
  function renderDiscoveryMonthMini(year, month, info) {
    var firstDow = (new Date(year, month, 1).getDay() + 6) % 7;
    var daysInMonth = new Date(year, month + 1, 0).getDate();
    var todayKey = dateKey(new Date());
    var html = '<div class="cal-month"><div class="cal-month-title">' + MONTH_NAMES_FR[month] + '</div>';
    html += '<div class="cal-weekdays">' + WEEKDAY_LETTERS_FR.map(function (w) { return '<span>' + w + '</span>'; }).join('') + '</div>';
    html += '<div class="cal-days">';
    for (var i = 0; i < firstDow; i++) html += '<span class="cal-day empty"></span>';
    for (var d = 1; d <= daysInMonth; d++) {
      var key = year + '-' + pad2(month + 1) + '-' + pad2(d);
      var ids = info[key];
      var classes = 'cal-day';
      if (ids && ids.length) classes += ' has-event';
      if (key === todayKey) classes += ' today';
      if (key === discoverySelectedDate) classes += ' selected';
      html += (ids && ids.length)
        ? '<button type="button" class="calendar-cell ' + classes + '" data-discovery-date="' + key + '">' + d + '</button>'
        : '<span class="' + classes + '">' + d + '</span>';
    }
    html += '</div></div>';
    return html;
  }

  function renderDiscoveryYearGrid(candidates) {
    var info = discoveryEventInfo(candidates);
    var year = parseLocalDate(discoveryCalendarAnchor).getFullYear();
    var html = '<div class="calendar-nav-card" style="margin-bottom:0.6rem;">' +
      '<button type="button" class="ghost icon-btn" id="discovery-cal-prev" aria-label="Année précédente">‹</button>' +
      '<div class="calendar-year-label">' + year + '</div>' +
      '<button type="button" class="ghost icon-btn" id="discovery-cal-next" aria-label="Année suivante">›</button>' +
      '</div><div class="calendar-year-grid">';
    for (var m = 0; m < 12; m++) html += renderDiscoveryMonthMini(year, m, info);
    html += '</div>';
    return html;
  }

  function renderProEventDiscovery(me) {
    if (!me) return '';
    var myTeamIds = (STATE.myTeamMemberships || []).map(function (m) { return m.teamId; });
    // Being a Team member no longer excludes an event from here -- a
    // Mototeam95 member who hasn't asked to join Barcelone yet needs to
    // find it here just as much as a follower or a stranger would (see
    // isMyEventForList, which is what now keeps it out of "À venir"
    // instead). Only actually leading the Team, or already being on the
    // roster, takes an event off this list.
    var candidates = (STATE.events || []).filter(function (ev) {
      if (!ev.teamId || isLeaderOfTeam(ev.teamId)) return false;
      var team = teamById(ev.teamId);
      if (!team || !team.teamPro) return false;
      if ((ev.riders || []).indexOf(me.name) !== -1) return false;
      var vis = ev.eventVisibility || 'membre';
      if (vis === 'membre') return myTeamIds.indexOf(ev.teamId) !== -1;
      if (vis === 'adherent') return (STATE.myFollowedTeamTiers || {})[ev.teamId] === 'adherent';
      if (vis === 'follower') return (STATE.myFollowedTeams || []).indexOf(ev.teamId) !== -1;
      return vis === 'public' || vis === 'ouvert';
    }).sort(function (a, b) { return a.dateStart < b.dateStart ? -1 : a.dateStart > b.dateStart ? 1 : 0; });
    if (!candidates.length) return '';
    var visTags = { ouvert: 'Ouvert', public: 'Public', membre: 'Membre', adherent: 'Adhérent', follower: 'Followers' };
    function rowHtml(ev) {
      var team = teamById(ev.teamId);
      var vis = ev.eventVisibility || 'membre';
      var myRequest = (STATE.eventJoinRequests || []).filter(function (r) { return r.eventId === ev.id && r.from === me.name; })[0];
      var actionHtml = vis === 'ouvert'
        ? '<button type="button" class="primary" data-action="event-join-ouvert" data-id="' + ev.id + '">Rejoindre</button>'
        : (myRequest
          ? '<span class="help-text">Demande envoyée</span>'
          : '<button type="button" class="ghost" data-action="event-join-request" data-id="' + ev.id + '" title="Envoie une demande sur Carnet de Piste, à valider par le Team -- ne réserve/paie rien.">Rejoindre</button>');
      // A separate external action -- the actual paid reservation/
      // inscription, if the Team Leader set one, never Carnet de Piste's
      // own roster/join flow above.
      if (ev.bookingUrl) actionHtml += ' <button type="button" class="ghost" data-action="open-external-url" data-url="' + escapeHtml(ev.bookingUrl) + '">Réserver ↗</button>';
      // The Team leads here (avatar, name, ✓ badge) rather than a bare
      // name in the help-text -- the whole point of this card is "which
      // Team PRO is proposing this", not just "which circuit".
      return '<div class="friend-row"><div class="friend-row-main">' + avatarHtml(team || {}, team ? team.name : '') +
        '<span class="friend-name-plain">' + escapeHtml(team ? team.name : '') + '</span>' + teamBadgesHtml(team) +
        '<span class="help-text">' + escapeHtml(ev.circuit) + ' — ' + escapeHtml(formatEventRange(ev, true)) +
        ' · ' + (visTags[vis] || '') + '</span></div>' +
        '<div class="friend-row-actions">' + actionHtml + '</div></div>';
    }
    var legend = '<div class="help-text" style="margin-bottom:0.7rem;">"Rejoindre sur Carnet de Piste" envoie juste une demande au Team, à valider -- ça ne réserve ni ne paie rien. "Réserver" ouvre le site de billetterie du Team pour l\'inscription/le paiement.</div>';
    var toggle = legend + '<div style="display:flex; flex-wrap:wrap; gap:0.5rem; margin-bottom:0.7rem;">' +
      '<button type="button" class="calendar-view-btn' + (discoveryViewMode === 'list' ? ' active' : '') + '" data-action="discovery-view-mode" data-mode="list">Liste</button>' +
      '<button type="button" class="calendar-view-btn' + (discoveryViewMode === 'month' ? ' active' : '') + '" data-action="discovery-view-mode" data-mode="month">Mois</button>' +
      '<button type="button" class="calendar-view-btn' + (discoveryViewMode === 'year' ? ' active' : '') + '" data-action="discovery-view-mode" data-mode="year">Année</button>' +
      '</div>';
    var body;
    if (discoveryViewMode === 'month' || discoveryViewMode === 'year') {
      body = toggle + (discoveryViewMode === 'year' ? renderDiscoveryYearGrid(candidates) : renderDiscoveryCalendar(candidates));
      if (discoverySelectedDate) {
        var dayEvents = candidates.filter(function (ev) {
          return ev.dateStart <= discoverySelectedDate && (ev.dateEnd || ev.dateStart) >= discoverySelectedDate;
        });
        body += '<div style="margin-top:0.8rem;">' + (dayEvents.length
          ? dayEvents.map(rowHtml).join('')
          : '<div class="help-text">Rien ce jour-là.</div>') + '</div>';
      }
    } else {
      // Tri par Team -- one subheading per Team (name, badge), sorted
      // alphabetically, its own events kept in the usual date order
      // underneath, instead of one flat date-ordered list.
      var sortToggle = '<div style="display:flex; gap:0.5rem; margin-bottom:0.6rem;">' +
        '<button type="button" class="calendar-view-btn' + (discoverySortMode === 'date' ? ' active' : '') + '" data-action="discovery-sort-mode" data-mode="date">Trier par date</button>' +
        '<button type="button" class="calendar-view-btn' + (discoverySortMode === 'team' ? ' active' : '') + '" data-action="discovery-sort-mode" data-mode="team">Trier par Team</button>' +
        '</div>';
      if (discoverySortMode === 'team') {
        var byTeam = {};
        candidates.forEach(function (ev) {
          (byTeam[ev.teamId] = byTeam[ev.teamId] || []).push(ev);
        });
        var teamIds = Object.keys(byTeam).sort(function (a, b) {
          var ta = teamById(a), tb = teamById(b);
          return (ta ? ta.name : '').localeCompare(tb ? tb.name : '');
        });
        body = toggle + sortToggle + teamIds.map(function (tid) {
          var t = teamById(tid);
          return '<div class="section-title" style="font-size:0.95rem; margin-top:0.8rem;">' + avatarHtml(t || {}, t ? t.name : '') +
            ' ' + escapeHtml(t ? t.name : '') + teamBadgesHtml(t) + '</div>' +
            byTeam[tid].map(rowHtml).join('');
        }).join('');
      } else {
        body = toggle + sortToggle + candidates.map(rowHtml).join('');
      }
    }
    return collapsibleCard('event-discovery-pro', 'Événements de Teams PRO', body, false);
  }

  function pad2(n) {
    return n < 10 ? '0' + n : '' + n;
  }

  // Parses a "YYYY-MM-DD" string as a LOCAL midnight Date (not UTC), so
  // day-by-day range walking and calendar-cell matching stay consistent
  // regardless of the viewer's timezone.
  function parseLocalDate(str) {
    var p = str.split('-').map(Number);
    return new Date(p[0], p[1] - 1, p[2]);
  }

  var WEEKDAY_NAMES_FR = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
  function weekdayName(iso) {
    return WEEKDAY_NAMES_FR[parseLocalDate(iso).getDay()];
  }

  function dateKey(date) {
    return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate());
  }

  function shortDayMonth(date) {
    return pad2(date.getDate()) + '/' + pad2(date.getMonth() + 1);
  }

  function mondayOf(date) {
    var copy = new Date(date.getTime());
    var dow = (copy.getDay() + 6) % 7; // Monday = 0
    copy.setDate(copy.getDate() - dow);
    return copy;
  }

  // Every rider known to the log — from ridden sessions AND from planned
  // outings (a rider can be added to an outing before ever logging a
  // chrono), so the calendar's rider filter covers both.
  function allKnownRiders() {
    var seen = {};
    (STATE.riders || []).forEach(function (r) { seen[r] = true; });
    distinctRiders().forEach(function (r) { seen[r] = true; });
    eventsList().forEach(function (ev) { (ev.riders || []).forEach(function (r) { seen[r] = true; }); });
    var out = Object.keys(seen);
    out.sort(function (a, b) { return a.localeCompare(b); });
    return out;
  }

  // Condensed human-readable date range for an event, e.g. "28-30 septembre"
  // or, spanning months/years, "28 septembre - 2 octobre". Pass withYear for
  // the fuller form used in the detail card.
  function formatEventRange(ev, withYear) {
    var s = parseLocalDate(ev.dateStart);
    var e = parseLocalDate(ev.dateEnd || ev.dateStart);
    var yearSuffix = withYear ? ' ' + e.getFullYear() : '';
    if (s.getTime() === e.getTime()) {
      return s.getDate() + ' ' + MONTH_NAMES_FR[s.getMonth()].toLowerCase() + yearSuffix;
    }
    if (s.getMonth() === e.getMonth() && s.getFullYear() === e.getFullYear()) {
      return s.getDate() + '-' + e.getDate() + ' ' + MONTH_NAMES_FR[e.getMonth()].toLowerCase() + yearSuffix;
    }
    if (s.getFullYear() === e.getFullYear()) {
      return s.getDate() + ' ' + MONTH_NAMES_FR[s.getMonth()].toLowerCase() + ' - ' + e.getDate() + ' ' + MONTH_NAMES_FR[e.getMonth()].toLowerCase() + yearSuffix;
    }
    return s.getDate() + ' ' + MONTH_NAMES_FR[s.getMonth()].toLowerCase() + ' ' + s.getFullYear() +
      ' - ' + e.getDate() + ' ' + MONTH_NAMES_FR[e.getMonth()].toLowerCase() + ' ' + e.getFullYear();
  }

  function eventCircuitById(id) {
    var ev = eventsList().filter(function (e) { return e.id === id; })[0];
    return ev ? ev.circuit : '';
  }

  // Maps every date-string touched by a planned outing to
  // {eventId, isStart, isEnd} so the grids can highlight whole ranges with
  // rounded ends, in one pass over all events. Respects the global rider
  // picker (above the main tabs) — an event with riders specified is hidden
  // unless at least one of them is selected; an event with no riders yet
  // always shows.
  // Filtered by isMyEventForList, not just canSeeEvent, to match En cours/
  // À venir/Passés (see renderEventTab) -- otherwise a Team PRO event a
  // plain member never joined could still mark a day here while being
  // absent from every list, which read as a bug rather than "not yours yet".
  function eventDateInfoAll() {
    var map = {};
    eventsList().filter(isMyEventForList).forEach(function (ev) {
      if (selectedRiders && ev.riders && ev.riders.length) {
        var matches = ev.riders.some(function (r) { return selectedRiders.has(r); });
        if (!matches) return;
      }
      var start = parseLocalDate(ev.dateStart);
      var end = parseLocalDate(ev.dateEnd || ev.dateStart);
      var cur = new Date(start.getTime());
      var guard = 0;
      while (cur.getTime() <= end.getTime() && guard < 400) {
        guard++;
        map[dateKey(cur)] = {
          eventId: ev.id,
          isStart: cur.getTime() === start.getTime(),
          isEnd: cur.getTime() === end.getTime()
        };
        cur.setDate(cur.getDate() + 1);
      }
    });
    return map;
  }

  // Maps every date-string that has at least one ridden session to the list
  // of sessions on that date (respecting the global rider picker), so those
  // dates can be shown in a different colour from planned outings.
  function sessionsByDate() {
    var map = {};
    STATE.sessions.forEach(function (s) {
      if (!s.date) return;
      if (selectedRiders && !selectedRiders.has(s.rider)) return;
      (map[s.date] = map[s.date] || []).push(s);
    });
    return map;
  }

  function sessionsOnDate(dateStr) {
    return STATE.sessions.filter(function (s) {
      return s.date === dateStr && (!selectedRiders || selectedRiders.has(s.rider));
    });
  }

  // Chronos no longer has its own tab — its content (rider picker,
  // progression chart, entry form, session history) is appended to the
  // end of Circuit, since it was always about the currently active circuit
  // anyway. See renderCircuitTab().
  // Stats has its own header icon now (see renderRootUnsafe), not a
  // bottom-nav slot -- only these 5 make up the bottom nav, in this order.
  var MAIN_TABS = [
    ['event', 'Événements', '📅'],
    ['circuit', 'Chronos', '⏱️'],
    ['planning', 'EN PISTE', '🏍️'],
    ['social', 'Social', '👥'],
    ['team', 'Team', '🤝']
  ];

  // Fixed to the bottom of the viewport (see .bottom-nav), like a native
  // app's tab bar -- rendered as the very last thing in renderRoot()'s
  // innerHTML, not up near the header, purely so its DOM position matches
  // where position:fixed puts it visually; the fixed CSS is what actually
  // pins it, this ordering is just for readability of the source.
  function renderBottomNav() {
    var html = '<nav class="bottom-nav">';
    MAIN_TABS.forEach(function (t) {
      html += '<button type="button" class="bottom-nav-btn' + (activeView === t[0] ? ' active' : '') + '" data-view="' + t[0] + '">' +
        '<span class="bottom-nav-icon">' + t[2] + '</span><span class="bottom-nav-label">' + t[1] + '</span></button>';
    });
    html += '</nav>';
    return html;
  }

  // Ordered for ergonomics: (1) the year's sorties at a glance, (2) the
  // calendar grid to navigate/pick a date, (3) a summary of whichever
  // sortie/day is currently selected. The add/edit form stays last — it's
  // an action, not something to read.
  // The event's own info/checklist/actions live in the Événement tab now —
  // showing them again here would just duplicate that. Calendrier stays
  // focused on navigating dates: the grid, then a summary of sorties in
  // whatever period is on screen (clicking one jumps to Événement). A
  // day's logged chronos (not event-related) still show inline, since
  // that's not duplicated anywhere else.
  function renderCalendarSection() {
    var eventInfo = eventDateInfoAll();
    var sessionsMap = sessionsByDate();
    var html = renderCalendarViewSwitcher();
    html += renderCalendarZoomHint();
    html += renderCalendarNav();
    if (calendarViewMode === 'day') html += renderDayGrid(eventInfo);
    else if (calendarViewMode === 'month') html += renderMonthGrid(eventInfo, sessionsMap);
    else if (calendarViewMode === 'week') html += renderWeekGrid(eventInfo, sessionsMap);
    else if (calendarViewMode === '6month') html += renderMultiMonthGrid(6, eventInfo, sessionsMap);
    else if (calendarViewMode === '3month') html += renderMultiMonthGrid(3, eventInfo, sessionsMap);
    else if (calendarViewMode === '2month') html += renderMultiMonthGrid(2, eventInfo, sessionsMap);
    else html += renderYearGrid(eventInfo, sessionsMap);
    if (selectedSessionDate) html += renderSessionDayCard(selectedSessionDate);
    return collapsibleCard('events-calendar', 'Mon calendrier', html, false);
  }

  var ZOOM_LEVEL_LABELS = { year: 'Année', '6month': '6 mois', '3month': '3 mois', '2month': '2 mois', month: 'Mois', week: 'Semaine', day: 'Jour' };

  // Explicit buttons for picking the calendar's zoom level -- pinch/Ctrl+
  // wheel gestures (see the hint below) still work too, but aren't
  // discoverable on their own, especially for someone without a trackpad.
  function renderCalendarViewSwitcher() {
    var html = '<div class="calendar-view-switcher">';
    ZOOM_LEVELS.forEach(function (mode) {
      html += '<button type="button" class="calendar-view-btn' + (calendarViewMode === mode ? ' active' : '') + '" data-calendar-view="' + mode + '">' + ZOOM_LEVEL_LABELS[mode] + '</button>';
    });
    html += '</div>';
    return html;
  }

  function renderCalendarZoomHint() {
    return '<div class="calendar-zoom-hint">Astuce : glissez à gauche/droite (ou flèches ← →) pour changer de période, pincez à deux doigts ou Ctrl + molette pour zoomer.</div>';
  }

  // How many consecutive months a given mode shows — 'year' is the one
  // special case (always the 12 calendar-aligned months of one year); the
  // others are a rolling window of N months starting at calendarAnchor.
  function monthsCountForMode(mode) {
    if (mode === '6month') return 6;
    if (mode === '3month') return 3;
    if (mode === '2month') return 2;
    return 1; // 'month'
  }

  function calendarNavLabel() {
    var d = parseLocalDate(calendarAnchor);
    if (calendarViewMode === 'day') return weekdayName(calendarAnchor) + ' ' + shortDayMonth(d) + ' ' + d.getFullYear();
    if (calendarViewMode === 'year') return '' + d.getFullYear();
    if (calendarViewMode === 'week') {
      var monday = mondayOf(d);
      var sunday = new Date(monday.getTime());
      sunday.setDate(sunday.getDate() + 6);
      return shortDayMonth(monday) + ' – ' + shortDayMonth(sunday) + ' ' + sunday.getFullYear();
    }
    var count = monthsCountForMode(calendarViewMode);
    if (count === 1) return MONTH_NAMES_FR[d.getMonth()] + ' ' + d.getFullYear();
    var end = new Date(d.getFullYear(), d.getMonth() + count - 1, 1);
    if (d.getFullYear() === end.getFullYear()) {
      return MONTH_NAMES_FR[d.getMonth()] + ' - ' + MONTH_NAMES_FR[end.getMonth()] + ' ' + d.getFullYear();
    }
    return MONTH_NAMES_FR[d.getMonth()] + ' ' + d.getFullYear() + ' - ' + MONTH_NAMES_FR[end.getMonth()] + ' ' + end.getFullYear();
  }

  function calendarNavStep(delta) {
    var d = parseLocalDate(calendarAnchor);
    if (calendarViewMode === 'year') d.setFullYear(d.getFullYear() + delta);
    else if (calendarViewMode === 'day') d.setDate(d.getDate() + delta);
    else if (calendarViewMode === 'week') d.setDate(d.getDate() + delta * 7);
    else d.setMonth(d.getMonth() + delta * monthsCountForMode(calendarViewMode));
    calendarAnchor = dateKey(d);
  }

  // Steps through ZOOM_LEVELS (Année → 6 mois → 3 mois → 2 mois → Mois →
  // Semaine). direction +1 = more detail (zoom in), -1 = less (zoom out).
  // Returns false at either end so callers can skip a pointless re-render.
  function calendarZoomStep(direction) {
    var idx = ZOOM_LEVELS.indexOf(calendarViewMode);
    if (idx === -1) idx = 0;
    var next = Math.max(0, Math.min(ZOOM_LEVELS.length - 1, idx + direction));
    if (next === idx) return false;
    calendarViewMode = ZOOM_LEVELS[next];
    return true;
  }

  function renderCalendarNav() {
    return (
      '<div class="card calendar-nav-card">' +
        '<button type="button" class="ghost icon-btn" id="cal-prev" aria-label="Précédent">‹</button>' +
        '<div class="calendar-year-label">' + calendarNavLabel() + '</div>' +
        '<button type="button" class="ghost icon-btn" id="cal-next" aria-label="Suivant">›</button>' +
        '<button type="button" class="ghost" id="cal-today">Aujourd\'hui</button>' +
      '</div>'
    );
  }

  function renderYearGrid(eventInfo, sessionsMap) {
    var year = parseLocalDate(calendarAnchor).getFullYear();
    var html = '<div class="card calendar-grid-card"><div class="calendar-year-grid">';
    for (var m = 0; m < 12; m++) html += renderMonthMini(year, m, eventInfo, sessionsMap);
    html += '</div></div>';
    return html;
  }

  // Rolling window of `count` consecutive months starting at calendarAnchor
  // — used for the 6/3/2-month zoom levels between the full year and a
  // single month.
  function renderMultiMonthGrid(count, eventInfo, sessionsMap) {
    var anchor = parseLocalDate(calendarAnchor);
    var startYear = anchor.getFullYear(), startMonth = anchor.getMonth();
    var html = '<div class="card calendar-grid-card"><div class="calendar-year-grid">';
    for (var i = 0; i < count; i++) {
      var y = startYear, m = startMonth + i;
      while (m > 11) { m -= 12; y += 1; }
      html += renderMonthMini(y, m, eventInfo, sessionsMap);
    }
    html += '</div></div>';
    return html;
  }

  function renderMonthMini(year, month, eventInfo, sessionsMap) {
    var firstDow = (new Date(year, month, 1).getDay() + 6) % 7; // Monday = 0
    var daysInMonth = new Date(year, month + 1, 0).getDate();
    var todayKey = dateKey(new Date());
    var html = '<div class="cal-month"><div class="cal-month-title">' + MONTH_NAMES_FR[month] + '</div>';
    html += '<div class="cal-weekdays">' + WEEKDAY_LETTERS_FR.map(function (w) { return '<span>' + w + '</span>'; }).join('') + '</div>';
    html += '<div class="cal-days">';
    for (var i = 0; i < firstDow; i++) html += '<span class="cal-day empty"></span>';
    for (var d = 1; d <= daysInMonth; d++) {
      var key = year + '-' + pad2(month + 1) + '-' + pad2(d);
      var cell = eventInfo[key];
      var sessions = sessionsMap[key];
      var classes = 'cal-day';
      if (cell) {
        classes += ' has-event';
        if (cell.eventId === selectedEventId) classes += ' selected';
        if (cell.isStart) classes += ' range-start';
        if (cell.isEnd) classes += ' range-end';
      }
      if (sessions && sessions.length) classes += ' has-session';
      if (key === todayKey) classes += ' today';
      var dotHtml = (sessions && sessions.length) ? '<span class="cal-day-dot"></span>' : '';
      if (cell || (sessions && sessions.length)) {
        html += '<button type="button" class="calendar-cell ' + classes + '" data-date="' + key + '"' + (cell ? ' data-event-id="' + cell.eventId + '"' : '') + '>' + d + dotHtml + '</button>';
      } else {
        html += '<span class="' + classes + '">' + d + '</span>';
      }
    }
    html += '</div></div>';
    return html;
  }

  function renderMonthGrid(eventInfo, sessionsMap) {
    var anchor = parseLocalDate(calendarAnchor);
    var year = anchor.getFullYear(), month = anchor.getMonth();
    var firstDow = (new Date(year, month, 1).getDay() + 6) % 7;
    var daysInMonth = new Date(year, month + 1, 0).getDate();
    var todayKey = dateKey(new Date());
    var html = '<div class="card calendar-grid-card"><div class="cal-month cal-month-large">';
    html += '<div class="cal-weekdays">' + WEEKDAY_LETTERS_FR.map(function (w) { return '<span>' + w + '</span>'; }).join('') + '</div>';
    html += '<div class="cal-days cal-days-large">';
    for (var i = 0; i < firstDow; i++) html += '<span class="cal-day cal-day-large empty"></span>';
    for (var d = 1; d <= daysInMonth; d++) {
      var key = year + '-' + pad2(month + 1) + '-' + pad2(d);
      var cell = eventInfo[key];
      var sessions = sessionsMap[key];
      var classes = 'cal-day cal-day-large';
      if (cell) {
        classes += ' has-event';
        if (cell.eventId === selectedEventId) classes += ' selected';
        if (cell.isStart) classes += ' range-start';
        if (cell.isEnd) classes += ' range-end';
      }
      if (sessions && sessions.length) classes += ' has-session';
      if (key === todayKey) classes += ' today';
      var inner = '<span class="cal-day-num">' + d + '</span>';
      if (cell) inner += '<span class="cal-day-label">' + escapeHtml(eventCircuitById(cell.eventId)) + '</span>';
      if (sessions && sessions.length) inner += '<span class="cal-day-dot"></span>';
      if (cell || (sessions && sessions.length)) {
        html += '<button type="button" class="calendar-cell ' + classes + '" data-date="' + key + '"' + (cell ? ' data-event-id="' + cell.eventId + '"' : '') + '>' + inner + '</button>';
      } else {
        html += '<span class="' + classes + '">' + inner + '</span>';
      }
    }
    html += '</div></div></div>';
    return html;
  }

  // The finest zoom level: one day's own schedule, reusing the exact same
  // Horaires timeline (groups + briefing, live current/next/past
  // highlighting) as Planning's "En ce moment", but for whichever date the
  // calendar is anchored to -- not just today. eventInfo (from
  // eventDateInfoAll) already maps every date to the sortie covering it,
  // respecting the global rider filter.
  function renderDayGrid(eventInfo) {
    var cell = eventInfo[calendarAnchor];
    var html = '<div class="card calendar-grid-card">';
    if (!cell) {
      html += '<div class="empty-state">Aucun événement ce jour-là.</div></div>';
      return html;
    }
    var ev = eventsList().filter(function (e) { return e.id === cell.eventId; })[0];
    if (!ev) { html += '<div class="empty-state">Aucun événement ce jour-là.</div></div>'; return html; }
    var info = circuitInfo(ev.circuit);
    html += '<div class="eyebrow">' + escapeHtml(ev.circuit) + '</div>';
    var calOrganizerTeam = info.organizerTeamId ? teamById(info.organizerTeamId) : null;
    if (calOrganizerTeam) html += '<div class="help-text">Organisateur ' + escapeHtml(calOrganizerTeam.name) + '</div>';
    var dayHoraires = eventHoraires(ev);
    if (!dayHoraires) {
      html += '<div class="help-text">Aucun horaire enregistré pour ' + escapeHtml(ev.circuit) + '.</div>';
    } else {
      html += renderHoraireGroups(dayHoraires, null, ev, info.briefing, calendarAnchor === dateKey(new Date()));
    }
    html += '</div>';
    return html;
  }

  function renderWeekGrid(eventInfo, sessionsMap) {
    var anchor = parseLocalDate(calendarAnchor);
    var monday = mondayOf(anchor);
    var todayKey = dateKey(new Date());
    var html = '<div class="card calendar-grid-card"><div class="cal-week">';
    for (var i = 0; i < 7; i++) {
      var d = new Date(monday.getTime());
      d.setDate(d.getDate() + i);
      var key = dateKey(d);
      var cell = eventInfo[key];
      var sessions = sessionsMap[key];
      var classes = 'cal-week-day';
      if (cell) classes += ' has-event';
      if (sessions && sessions.length) classes += ' has-session';
      if (key === todayKey) classes += ' today';
      var clickable = !!cell || (sessions && sessions.length);
      html += '<div class="' + (clickable ? 'calendar-cell ' : '') + classes + '"' + (clickable ? ' data-date="' + key + '"' : '') + (cell ? ' data-event-id="' + cell.eventId + '"' : '') + '>';
      html += '<div class="cal-week-day-head">' + WEEKDAY_LETTERS_FR[i] + ' ' + d.getDate() + '</div>';
      if (cell) {
        var ev = eventsList().filter(function (e) { return e.id === cell.eventId; })[0];
        if (ev) {
          html += '<div class="cal-week-event">' + escapeHtml(ev.circuit) + '</div>';
          if (ev.riders && ev.riders.length) html += '<div class="cal-week-riders">' + escapeHtml(ev.riders.join(', ')) + '</div>';
        }
      }
      if (sessions && sessions.length) {
        sessions.forEach(function (s) {
          html += '<div class="cal-week-session">' + escapeHtml(s.rider) + ' · ' + formatTime(sessionBest(s)) + '</div>';
        });
      }
      html += '</div>';
    }
    html += '</div></div>';
    return html;
  }

  // Deleting a sortie is admin-only, or the Team Leader of the Team that
  // owns it (matches firestore.rules) -- a personal (non-Team) sortie
  // stays admin-only since several riders can be relying on it (groupes,
  // horaires, checklist), not just whoever created it, and there's no
  // Team Leader to trust with that call on those.
  // Rendered only inside renderEventForm's own danger zone now (see
  // below), never as a bare × next to "Modifier" in a list row -- that
  // placement is exactly what caused an accidental double-delete: the
  // confirm-armed state used to live only in the clicked button's own
  // DOM (textContent/class), so a live-sync re-render between the two
  // clicks silently reset the button back to "×" while pendingDeleteEvent
  // stayed armed underneath, and the next ordinary-looking click deleted
  // immediately with no visible warning. Reading pendingDeleteEvent here
  // keeps the armed state correct across re-renders too.
  function deleteEventControl(ev) {
    if (!isAdmin() && !(ev.teamId && isLeaderOfTeam(ev.teamId))) return '';
    var armed = pendingDeleteEvent === ev.id;
    var btn = '<button type="button" class="ghost danger' + (armed ? ' confirm' : '') + '" data-action="delete-event-request" data-id="' + ev.id + '">' +
      (armed ? 'Confirmer la suppression' : 'Supprimer cet événement') + '</button>';
    // Explicit Annuler once armed -- otherwise the only way out is to
    // notice the click didn't do what you expected and guess that
    // clicking away resets it.
    if (armed) btn += ' <button type="button" class="ghost" data-action="delete-event-cancel">Annuler</button>';
    return btn;
  }

  function renderSessionDayCard(dateStr) {
    var sessions = sessionsOnDate(dateStr);
    if (!sessions.length) return '';
    var html = '<div class="card event-detail-card session-day-card">';
    html += '<div class="event-detail-header"><h3>Chronos du ' + escapeHtml(formatDate(dateStr)) + '</h3><button type="button" class="ghost icon-btn" id="close-session-day" aria-label="Fermer">×</button></div>';
    sessions.forEach(function (s) {
      html += infoRow(s.rider + ' — ' + s.circuit, formatTime(sessionBest(s)));
    });
    html += '</div>';
    return html;
  }

  // Selecting a sortie is a "picking" action — it also syncs selectedCircuit
  // so the Circuit/Chronos/Statistiques tabs stay contextually consistent
  // with whichever sortie is currently active. Closing/clearing sites keep
  // assigning selectedEventId = null directly (there's nothing to sync to).
  function selectEvent(id) {
    selectedEventId = id || null;
    if (id) {
      var ev = eventsList().filter(function (e) { return e.id === id; })[0];
      if (ev) selectedCircuit = ev.circuit;
    }
  }

  // Classifies a sortie against today's date so the Événement tab can group
  // every sortie ever logged — past, ongoing, or upcoming — rather than
  // showing only whichever one happens to be selected.
  function eventTemporalStatus(ev, todayKey) {
    // A malformed/legacy event with no dateStart at all must never fall
    // through to 'ongoing' (both comparisons below are false against
    // undefined, which used to default here) -- that would let it jump
    // the queue ahead of every real ongoing/upcoming sortie in
    // targetPlanningEvent()'s default-circuit pick.
    if (!ev.dateStart) return 'past';
    var end = ev.dateEnd || ev.dateStart;
    if (todayKey < ev.dateStart) return 'upcoming';
    if (todayKey > end) return 'past';
    return 'ongoing';
  }

  // A rider isn't locked to one group for the whole sortie -- they can move
  // up or down at the lunch break (matin vs après-midi) or overnight (a
  // fresh choice each day), so this renders one Matin/Après-midi pair of
  // selects per rider per day rather than a single group for the event.
  // One group per rider for the whole event -- no more matin/après-midi,
  // no more day-by-day. Still stored as ev.riderGroups[rider][date] =
  // {am, pm} underneath (unchanged, so Planning's schedule/récap/notify
  // code keeps working as-is), but every date/période is always written
  // together with the same value (see assignRiderToGroup), so reading any
  // one of them back gives the rider's one group. Scans every date rather
  // than assuming dates[0] purely to self-heal old events that still
  // carry differing legacy values.
  function riderEventGroup(ev, rider) {
    var dates = datesInRange(ev.dateStart, ev.dateEnd);
    for (var i = 0; i < dates.length; i++) {
      var g = riderGroupFor(ev, rider, dates[i], 'matin') || riderGroupFor(ev, rider, dates[i], 'apres-midi');
      if (g) return g;
    }
    return '';
  }
  function assignRiderToGroup(eventId, rider, group) {
    var ev = (STATE.events || []).filter(function (e) { return e.id === eventId; })[0];
    if (!ev) return;
    var dates = datesInRange(ev.dateStart, ev.dateEnd);
    var riderGroups = Object.assign({}, ev.riderGroups || {});
    var entry = {};
    dates.forEach(function (date) { entry[date] = { am: group, pm: group }; });
    riderGroups[rider] = entry;
    db.collection('events').doc(eventId).update({ riderGroups: riderGroups }).catch(function (err) {
      showToast('Erreur : ' + (err && err.message ? err.message : err));
    });
  }
  function removeRiderFromGroup(eventId, rider) {
    var ev = (STATE.events || []).filter(function (e) { return e.id === eventId; })[0];
    if (!ev) return;
    var riderGroups = Object.assign({}, ev.riderGroups || {});
    delete riderGroups[rider];
    db.collection('events').doc(eventId).update({ riderGroups: riderGroups }).catch(function (err) {
      showToast('Erreur : ' + (err && err.message ? err.message : err));
    });
  }
  function riderVerifiedBest(ev, rider) {
    var s = STATE.sessions.filter(function (x) { return x.rider === rider && x.circuit === ev.circuit && x.certifiedBy; })
      .sort(function (a, b) { return sessionBest(a) - sessionBest(b); })[0];
    return s ? sessionBest(s) : null;
  }
  // One rubrique per group, each with its own search-to-add -- and, per
  // "suggestion d'ajout en fonction des chronos vérifiés", candidates in
  // that search are ordered by how close their best verified chrono is to
  // the group's current average (fastest-first when the group's still
  // empty), so the pilotes who best fit that group's level surface first.
  function renderGroupsSection(ev, canEdit) {
    var riders = ev.riders || [];
    if (!riders.length) return '<div class="section-title" style="margin-top:1rem;">Groupes</div><div class="help-text">Ajoute des participants pour pouvoir les répartir en groupes.</div>';
    var byGroup = {};
    ROSTER_GROUP_LETTERS.forEach(function (g) { byGroup[g] = []; });
    var unassigned = [];
    riders.forEach(function (r) {
      var g = riderEventGroup(ev, r);
      if (g && byGroup[g]) byGroup[g].push(r);
      else unassigned.push(r);
    });
    function riderRow(name, removable) {
      var u = (STATE.usersByName || {})[name] || {};
      var t = riderVerifiedBest(ev, name);
      var timeHtml = t != null ? ' <span class="verified-pill">' + formatTime(t) + '</span>' : '';
      var removeBtn = (removable && canEdit) ? '<button type="button" class="ghost icon-btn" data-action="event-group-remove" data-id="' + ev.id + '" data-rider="' + escapeHtml(name) + '" aria-label="Retirer du groupe" title="Retirer du groupe">×</button>' : '';
      // Drag-and-drop between groups, desktop mainly (touch browsers mostly
      // don't fire native HTML5 drag events) -- the search-to-add form and
      // the × button above still cover mobile either way.
      var dragAttrs = canEdit ? ' draggable="true" data-drag-rider="' + escapeHtml(name) + '"' : '';
      return '<div class="friend-row"' + dragAttrs + '><div class="friend-row-main">' + nameLinkHtml(name) + badgesHtml(u) + timeHtml + '</div><div class="friend-row-actions">' + removeBtn + '</div></div>' + maybeFicheHtml(name);
    }
    var assignedCount = riders.length - unassigned.length;
    var html = '<div class="section-title" style="margin-top:1rem;">Groupes (' + assignedCount + ')</div>';
    // .groups-board: on desktop (see style.css) this becomes a row of
    // columns -- Non attribués + every group side by side, like a board,
    // instead of one long vertical stack of accordions. That's exactly
    // "les pilotes dans les bons groupes" at a glance for an organizer
    // with a wide screen; each column stays its own <details> underneath
    // so mobile keeps the accordion behaviour unchanged, and a column can
    // still be collapsed individually to free up horizontal room.
    // canEdit-only drop zones -- data-drop-group="" is "Non attribués"
    // (removeRiderFromGroup), a letter is assignRiderToGroup (see the
    // dragstart/dragover/drop wiring in attachHandlers).
    html += '<div class="groups-board">';
    if (unassigned.length) {
      var unassignedBody = canEdit
        ? '<div class="group-drop-zone" data-drop-group="" data-event-id="' + ev.id + '">' + unassigned.map(function (r) { return riderRow(r, false); }).join('') + '</div>'
        : unassigned.map(function (r) { return riderRow(r, false); }).join('');
      html += collapsibleSection('event-group-unassigned-' + ev.id, 'Non attribués (' + unassigned.length + ')', unassignedBody, true);
    }
    ROSTER_GROUP_LETTERS.forEach(function (g) {
      var members = byGroup[g];
      var times = members.map(function (r) { return riderVerifiedBest(ev, r); }).filter(function (t) { return t != null; });
      var avg = times.length ? times.reduce(function (a, b) { return a + b; }, 0) / times.length : null;
      var membersHtml = members.length ? members.map(function (r) { return riderRow(r, true); }).join('') : '<div class="help-text">Personne pour l\'instant.</div>';
      var body = canEdit ? '<div class="group-drop-zone" data-drop-group="' + g + '" data-event-id="' + ev.id + '">' + membersHtml + '</div>' : membersHtml;
      var candidates = riders.filter(function (r) { return members.indexOf(r) === -1; }).sort(function (a, b) {
        var ta = riderVerifiedBest(ev, a), tb = riderVerifiedBest(ev, b);
        if (avg != null) {
          var da = ta == null ? Infinity : Math.abs(ta - avg), db = tb == null ? Infinity : Math.abs(tb - avg);
          return da - db;
        }
        if (ta == null && tb == null) return a.localeCompare(b);
        if (ta == null) return 1;
        if (tb == null) return -1;
        return ta - tb;
      });
      if (canEdit && candidates.length) {
        body += '<form class="team-event-add-rider-form" data-action="event-group-add-form" data-event-id="' + ev.id + '" data-group="' + g + '">' +
          '<input type="text" list="event-group-candidates-' + g + '-' + ev.id + '" placeholder="Rechercher un pilote..." data-event-group-add-input>' +
          '<datalist id="event-group-candidates-' + g + '-' + ev.id + '">' + candidates.map(function (n) {
            var t = riderVerifiedBest(ev, n);
            return '<option value="' + escapeHtml(n) + '">' + escapeHtml(n) + (t != null ? ' — ' + formatTime(t) : '') + '</option>';
          }).join('') + '</datalist>' +
          '<button type="submit" class="ghost">Ajouter</button></form>';
      }
      html += collapsibleSection('event-group-' + g + '-' + ev.id, (g === 'ORGA' ? 'Groupe ORGA (staff)' : 'Groupe ' + g) + ' (' + members.length + ')', body, true);
    });
    html += '</div>';
    return html;
  }

  // Replaces the old "Groupes par pilote" (every rider's group, visible to
  // everyone) in Planning -- a pilote now only ever sees their own
  // assignment here, per "seuls les renseignements du user seront
  // affichés sur la fiche de l'Event".
  function renderMyGroupSection(ev) {
    var me = currentUserProfile;
    if (!me || (ev.riders || []).indexOf(me.name) === -1) return '';
    var group = riderEventGroup(ev, me.name);
    if (!group) return '';
    var row = infoRow(me.name, '<span class="my-group-letter">' + escapeHtml(group) + '</span>');
    // A Team Leader can assign a rider a different bike number just for
    // this sortie (see saveEventRiderBikeNumber) -- separate from, and
    // never touching, "Ma moto" on the rider's own profile.
    var eventNumber = (ev.riderBikeNumbers || {})[me.name];
    if (eventNumber) row += infoRow('N° pour cet événement', '#' + escapeHtml(eventNumber));
    return collapsibleSection('my-group-' + ev.id, 'Mon groupe', row, true);
  }

  // And "Mes amis" -- same idea, but for friends also on this event (see
  // "un autre champ : mes amis"), each one still just a click away from
  // their own fiche.
  function renderFriendsGroupSection(ev) {
    var me = currentUserProfile;
    if (!me) return '';
    var friendNames = friendsOf(me.name).map(function (f) { return f.name; });
    var onEvent = (ev.riders || []).filter(function (r) { return friendNames.indexOf(r) !== -1; }).sort();
    if (!onEvent.length) return '';
    var rows = onEvent.map(function (name) {
      var group = riderEventGroup(ev, name);
      return '<div class="info-row"><span class="info-label">' + nameLinkHtml(name) + '</span><span class="info-value">' +
        (group ? escapeHtml(group) : '<span class="help-text">Pas encore de groupe</span>') + '</span></div>' + maybeFicheHtml(name);
    }).join('');
    return collapsibleSection('friends-group-' + ev.id, 'Mes amis', rows, true);
  }

  // Trims the sortie form's in-memory group draft down to a clean
  // riderGroups object: only riders currently in the form and dates
  // currently within its start/end range, and only am/pm slots that are
  // actually set. Returns null instead of an empty object so a sortie
  // with no groups assigned doesn't carry a pointless riderGroups: {}.
  // existingRiderGroups (the sortie's current riderGroups, when editing one)
  // is carried forward untouched for any rider who already has real
  // per-day/période assignments -- those are fine-tuned in Planning and a
  // sortie edit (changing the date, the note, ...) shouldn't collapse them
  // back to a single uniform group. The "groupe de départ" dropdown only
  // seeds a rider who doesn't have any assignment yet.
  function draftRiderGroupsFor(riders, dateStart, dateEnd, existingRiderGroups) {
    var dates = datesInRange(dateStart, dateEnd);
    var merged = {};
    riders.forEach(function (rider) {
      var existing = (existingRiderGroups || {})[rider];
      if (existing && Object.keys(existing).length) {
        merged[rider] = existing;
        return;
      }
      var startGroup = eventFormDraftGroups[rider] && eventFormDraftGroups[rider].start;
      if (!startGroup) return;
      merged[rider] = {};
      dates.forEach(function (date) { merged[rider][date] = { am: startGroup, pm: startGroup }; });
    });
    var out = {};
    riders.forEach(function (rider) {
      if (!merged[rider]) return;
      dates.forEach(function (date) {
        var slot = merged[rider][date];
        if (!slot) return;
        var clean = {};
        if (slot.am) clean.am = slot.am;
        if (slot.pm) clean.pm = slot.pm;
        if (clean.am || clean.pm) {
          out[rider] = out[rider] || {};
          out[rider][date] = clean;
        }
      });
    });
    return Object.keys(out).length ? out : null;
  }

  function renderEventSummaryCard(ev, opts) {
    opts = opts || {};
    var html = '<div class="card event-detail-card">';
    html += '<div class="event-detail-header"><h3>' + escapeHtml(ev.circuit) + '</h3><button type="button" class="ghost icon-btn" id="close-event-detail" aria-label="Fermer">×</button></div>';
    if (ev.teamId) {
      var evTeam = teamById(ev.teamId);
      var visLabels = { public: 'Public', adherent: 'Adhérent only', membre: 'Membre only', follower: 'Followers only', ouvert: 'Ouvert' };
      html += infoRow('Team', (evTeam ? escapeHtml(evTeam.name) + teamBadgesHtml(evTeam) : '—') +
        (evTeam && evTeam.teamPro ? ' <span class="friend-role-badge">' + (visLabels[ev.eventVisibility] || 'Membre only') + '</span>' : ''));
    } else if (ev.organizerNote) {
      html += infoRow('Organisateur', escapeHtml(ev.organizerNote));
    }
    html += infoRow('Circuit', escapeHtml(ev.circuit));
    html += infoRow('Dates', escapeHtml(formatEventRange(ev, true)));
    if (ev.note) html += infoRow('Note', escapeHtml(ev.note));
    // Carnet de Piste ne gère pas les paiements/réservations -- ce lien
    // renvoie vers l'outil de billetterie du Team (Billetweb ou autre),
    // jamais une inscription gérée ici.
    if (ev.bookingUrl) html += '<div style="margin-top:0.6rem;"><button type="button" class="primary" data-action="open-external-url" data-url="' + escapeHtml(ev.bookingUrl) + '">Réserver / S\'inscrire ↗</button></div>';
    // Once the event is over, its own rider can react with an emoji --
    // the lightweight "on a kiffé" ask (see maybeNotifyEndedEvents), never
    // a text/photo comment thread.
    if (currentUserProfile && (ev.riders || []).indexOf(currentUserProfile.name) !== -1
      && eventTemporalStatus(ev, dateKey(new Date())) === 'past') {
      html += '<div style="margin-top:0.6rem;"><div class="help-text">Comment s\'est passé cet event ?</div>' + renderReactionBar(ev.reactions, 'react-event', ev.id) + '</div>';
    }
    // No full roster/groups here any more -- only what's the connected
    // account's own (+ friends'), per "seuls les renseignements du user +
    // éventuellement ses amis seront affichés sur la fiche de l'Event".
    // The complete roster and group assignment now live entirely in the
    // Team's own "Gestion des événements" (renderTeamEventsManagement).
    if (!opts.hideGroups) {
      html += renderMyGroupSection(ev);
      html += renderFriendsGroupSection(ev);
    }
    // Une fois l'event passé, EN PISTE ne cible plus que l'event en cours/à
    // venir (voir targetPlanningEvent) -- sans ça, "qui était dans quel
    // groupe à quelle heure" disparaissait complètement après coup, alors
    // que ev.riderGroups et les horaires du circuit restent là. Repliée
    // par défaut (ce n'est plus l'info qu'on vient chercher en premier une
    // fois la sortie terminée) ; live=false, pas de mise en avant du
    // créneau "en cours" qui n'aurait plus de sens pour une date passée.
    if (eventTemporalStatus(ev, dateKey(new Date())) === 'past') {
      var pastInfo = circuitInfo(ev.circuit);
      var pastHoraires = eventHoraires(ev);
      if (pastHoraires) {
        var pastGroups = renderHoraireGroups(pastHoraires, null, ev, pastInfo.briefing, false);
        if (pastGroups) html += collapsibleSection('event-past-horaires-' + ev.id, 'Groupes & horaires de cette sortie', pastGroups, false);
      }
    }
    html += renderEventCertificationSection(ev);
    html += renderMediaLinkSection(ev);
    // The circuit's own interactive map, so the annotated track is one tap
    // away from the sortie it belongs to, not just reachable from Circuit.
    html += '<div class="event-circuit-map"><div class="event-checklist-title">Carte du circuit</div>' + renderCircuitVisual(circuitInfo(ev.circuit), ev.circuit, ev.id) + '</div>';
    // The équipement checklist (with its count) lives entirely in
    // Planning now -- Événements stays simple and informative.
    html += '<div class="event-detail-actions"><button type="button" class="ghost" id="edit-event-btn" data-id="' + ev.id + '">Modifier</button></div>';
    html += '</div>';
    return html;
  }

  // Hôtel/avion/aéroport -- personal per (event, account) travel info, not
  // filled in by the Team orga for everyone (see eventTravelInfo in
  // firestore.rules: read/write is restricted server-side to its own
  // rider, the one genuinely private collection here besides
  // coachMessages). Loaded lazily, one doc at a time, since it's only ever
  // needed for whichever event is currently open/showing in Planning --
  // not synced globally like the rest of STATE.
  var travelInfoByEvent = {}; // eventId -> data, once loaded ({} meaning "loaded, nothing saved yet")
  function ensureMyTravelInfoLoaded(eventId) {
    if (!currentUserProfile || travelInfoByEvent.hasOwnProperty(eventId)) return;
    travelInfoByEvent[eventId] = {};
    db.collection('eventTravelInfo').doc(eventId + '_' + currentUserProfile.name).get().then(function (doc) {
      travelInfoByEvent[eventId] = doc.exists ? doc.data() : {};
      renderRoot();
    }).catch(function () {});
  }
  // Read-only counterpart for an accompagnant/organisateur: firestore.rules
  // now also lets eventTravelInfo be read by anyone who follows that rider
  // (see myFollowedRiders() there), so a pilote sharing "Pilotes que je
  // suis" effectively shares their hôtel/avion info with whoever follows
  // them -- keyed eventId -> rider -> data (or {} once loaded, nothing set).
  var travelInfoByEventRider = {};
  function ensureFollowedTravelInfoLoaded(eventId, rider) {
    travelInfoByEventRider[eventId] = travelInfoByEventRider[eventId] || {};
    if (travelInfoByEventRider[eventId].hasOwnProperty(rider)) return;
    travelInfoByEventRider[eventId][rider] = {};
    db.collection('eventTravelInfo').doc(eventId + '_' + rider).get().then(function (doc) {
      travelInfoByEventRider[eventId][rider] = doc.exists ? doc.data() : {};
      renderRoot();
    }).catch(function () {});
  }
  function saveMyTravelInfo(eventId) {
    var me = currentUserProfile;
    if (!me) return;
    var data = {
      rider: me.name,
      uid: myUid(),
      hotelName: (document.getElementById('travel-hotel-name').value || '').trim() || null,
      hotelAddress: (document.getElementById('travel-hotel-address').value || '').trim() || null,
      flightOutDep: (document.getElementById('travel-flight-out-dep').value || '').trim() || null,
      flightOutArr: (document.getElementById('travel-flight-out-arr').value || '').trim() || null,
      flightBackDep: (document.getElementById('travel-flight-back-dep').value || '').trim() || null,
      flightBackArr: (document.getElementById('travel-flight-back-arr').value || '').trim() || null,
      airport: (document.getElementById('travel-airport').value || '').trim() || null
    };
    db.collection('eventTravelInfo').doc(eventId + '_' + me.name).set(data, { merge: true }).then(function () {
      travelInfoByEvent[eventId] = data;
      showToast('Infos de voyage enregistrées.', 'success');
      renderRoot();
    }).catch(function (err) {
      showToast('Erreur : ' + (err && err.message ? err.message : err));
    });
  }
  function renderMyTravelInfoSection(ev) {
    if (!currentUserProfile) return '';
    ensureMyTravelInfoLoaded(ev.id);
    var info = travelInfoByEvent[ev.id] || {};
    var body = '<div class="help-text">Visible par toi et par les comptes Accompagnant qui te suivent.</div>';
    body += '<div class="field-row" style="margin-top:0.6rem;">';
    body += '<div><label for="travel-hotel-name">Hôtel — nom</label><input type="text" id="travel-hotel-name" placeholder="Ex. Ibis Le Mans" value="' + escapeHtml(info.hotelName || '') + '"></div>';
    body += '<div><label for="travel-hotel-address">Hôtel — adresse</label><input type="text" id="travel-hotel-address" placeholder="Ex. 12 rue de la Sarthe, 72100 Le Mans" value="' + escapeHtml(info.hotelAddress || '') + '"></div>';
    body += '</div>';
    body += '<label style="margin-top:0.6rem; display:block;">Avion</label><div class="field-row">';
    body += '<div><label for="travel-flight-out-dep" class="horaires-sublabel">Aller — départ</label><input type="text" id="travel-flight-out-dep" placeholder="Ex. 6h40" value="' + escapeHtml(info.flightOutDep || '') + '"></div>';
    body += '<div><label for="travel-flight-out-arr" class="horaires-sublabel">Aller — arrivée</label><input type="text" id="travel-flight-out-arr" placeholder="Ex. 8h15" value="' + escapeHtml(info.flightOutArr || '') + '"></div>';
    body += '<div><label for="travel-flight-back-dep" class="horaires-sublabel">Retour — départ</label><input type="text" id="travel-flight-back-dep" placeholder="Ex. 18h00" value="' + escapeHtml(info.flightBackDep || '') + '"></div>';
    body += '<div><label for="travel-flight-back-arr" class="horaires-sublabel">Retour — arrivée</label><input type="text" id="travel-flight-back-arr" placeholder="Ex. 19h35" value="' + escapeHtml(info.flightBackArr || '') + '"></div>';
    body += '<div><label for="travel-airport" class="horaires-sublabel">Aéroport</label><input type="text" id="travel-airport" placeholder="Ex. Aéroport de Bologne" value="' + escapeHtml(info.airport || '') + '"></div>';
    body += '</div>';
    body += '<div style="margin-top:0.6rem;"><button type="button" class="ghost" data-action="save-travel-info" data-event-id="' + ev.id + '">Enregistrer</button></div>';
    return collapsibleSection('travel-info-' + ev.id, 'Mes infos de voyage', body);
  }

  // Read-only: an accompagnant/organisateur's own followed riders' travel
  // info for this event, right next to (never instead of) their own. Never
  // editable here -- eventTravelInfo stays each rider's own to fill in
  // (see firestore.rules), this is purely "what my followed pilote(s)
  // already shared with me by following works both ways" visibility.
  function renderFollowedTravelInfoSection(ev) {
    var me = currentUserProfile;
    if (!me) return '';
    var followed = (me.followedRiders || []).filter(function (r) {
      if ((ev.riders || []).indexOf(r) === -1) return false;
      var u = STATE.usersByName && STATE.usersByName[r];
      return !u || u.shareTravelInfo !== false;
    });
    if (!followed.length) return '';
    var body = followed.map(function (rider) {
      ensureFollowedTravelInfoLoaded(ev.id, rider);
      var info = (travelInfoByEventRider[ev.id] || {})[rider];
      var rows;
      if (!info) rows = '<div class="help-text">Chargement...</div>';
      else if (!Object.keys(info).length) rows = '<div class="help-text">Rien renseigné pour l\'instant.</div>';
      else {
        rows = '';
        if (info.hotelName) rows += infoRow('Hôtel', escapeHtml(info.hotelName) + (info.hotelAddress ? ' — ' + escapeHtml(info.hotelAddress) : ''));
        if (info.flightOutDep || info.flightOutArr) rows += infoRow('Aller', escapeHtml(info.flightOutDep || '?') + ' → ' + escapeHtml(info.flightOutArr || '?'));
        if (info.flightBackDep || info.flightBackArr) rows += infoRow('Retour', escapeHtml(info.flightBackDep || '?') + ' → ' + escapeHtml(info.flightBackArr || '?'));
        if (info.airport) rows += infoRow('Aéroport', escapeHtml(info.airport));
        if (!rows) rows = '<div class="help-text">Rien renseigné pour l\'instant.</div>';
      }
      return '<div style="margin-top:0.6rem;"><div class="account-role-tag" style="margin-bottom:0.3rem;">' + escapeHtml(rider) + '</div>' + rows + '</div>';
    }).join('');
    return collapsibleSection('followed-travel-' + ev.id, 'Infos de voyage des pilotes suivis', body);
  }

  // Photos/vidéos de la sortie -- one link par event (Drive, WeTransfer,
  // an album, whatever), added by whoever was on the ground with a phone
  // (usually the accompagnant, but not restricted to them -- same
  // collaborative model as everything else here). Feeds the accompagnant's
  // "Reporter" achievement below (see accompagnantAchievements).
  var editingMediaLinkFor = null; // event id currently showing the edit form, or null
  function renderMediaLinkSection(ev) {
    if (editingMediaLinkFor === ev.id) {
      return '<div class="media-link-edit">' +
        '<label for="media-link-input">Lien photos/vidéos (Drive, WeTransfer...)</label>' +
        '<input type="url" id="media-link-input" placeholder="https://..." value="' + escapeHtml(ev.mediaLink || '') + '">' +
        '<div style="margin-top:0.5rem; display:flex; gap:0.5rem;">' +
        '<button type="button" class="primary" data-action="save-media-link" data-id="' + ev.id + '">Enregistrer</button>' +
        '<button type="button" class="ghost" data-action="cancel-media-link">Annuler</button></div></div>';
    }
    if (ev.mediaLink) {
      return infoRow('Photos/vidéos', '<a class="ghost" href="' + escapeHtml(ev.mediaLink) + '" target="_blank" rel="noopener">📷 Ouvrir</a>' +
        (ev.mediaLinkAddedBy ? ' <span class="help-text" style="display:inline;">— ajouté par ' + escapeHtml(ev.mediaLinkAddedBy) + '</span>' : '') +
        ' <button type="button" class="ghost icon-btn" data-action="edit-media-link" data-id="' + ev.id + '" aria-label="Modifier le lien" title="Modifier">✎</button>');
    }
    return '<div style="margin-top:0.6rem;"><button type="button" class="ghost" data-action="edit-media-link" data-id="' + ev.id + '">📷 Ajouter un lien photos/vidéos</button></div>';
  }

  function saveMediaLink(eventId, url) {
    var prevState = JSON.parse(JSON.stringify(STATE));
    var ev = STATE.events.filter(function (e) { return e.id === eventId; })[0];
    if (!ev) return;
    if (url) {
      ev.mediaLink = url;
      ev.mediaLinkAddedBy = (currentUserProfile && currentUserProfile.name) || null;
    } else {
      delete ev.mediaLink;
      delete ev.mediaLinkAddedBy;
    }
    editingMediaLinkFor = null;
    renderRoot();
    persist(prevState);
  }

  // Each row is its own accordion: clicking it opens its résumé (info,
  // pense-bête, circuit map) right underneath, in place, instead of
  // duplicating it in a summary above the lists. Only one can be open at a
  // time (there's a single selectedEventId), so opening a new row closes
  // whichever was open.
  // One sortie row (+ its accordion panel when open) -- shared by the
  // plain "En cours"/"À venir" lists and the per-year "Passés" bands below,
  // so the row markup and its open/edit behavior stay in exactly one place.
  function renderEventRow(ev, opts) {
    opts = opts || {};
    var isOpen = ev.id === selectedEventId;
    var html = '<div class="event-row event-row-toggle' + (isOpen ? ' selected' : '') + '" data-event-id="' + ev.id + '" aria-expanded="' + (isOpen ? 'true' : 'false') + '">';
    html += '<div class="event-row-main"><span class="event-row-circuit">' + escapeHtml(ev.circuit) + '</span>';
    // The équipement count lives only in Planning now (with the actual
    // checklist to act on) -- it added nothing here, least of all for a
    // past sortie where it's just a stale "0/43".
    html += '<span class="event-row-dates">' + escapeHtml(formatEventRange(ev)) + '</span></div>';
    if (!opts.hideRiders) {
      html += '<div class="event-row-riders">' + ((ev.riders && ev.riders.length) ? escapeHtml(ev.riders.join(', ')) : 'Pilotes non précisés') + '</div>';
    }
    html += '</div>';
    if (isOpen) {
      html += '<div class="event-accordion-panel">' + ((editingEventId === ev.id) ? renderEventForm() : renderEventSummaryCard(ev, opts)) + '</div>';
    }
    return html;
  }

  function renderEventGroupCard(title, events, opts) {
    opts = opts || {};
    var body = !events.length ? '<div class="empty-state">Aucun événement.</div>' :
      events.map(function (ev) { return renderEventRow(ev, opts); }).join('');
    if (opts.collapseKey) return collapsibleCard(opts.collapseKey, title, body, opts.defaultOpen);
    return '<div class="card events-list-card"><h2 class="section-title">' + escapeHtml(title) + '</h2>' + body + '</div>';
  }

  // Which "Passés" year bands are expanded in the Événement tab -- every
  // year starts collapsed (nothing in this map) so a rider with years of
  // history isn't confronted with a giant scrolling list by default; a
  // year only stays open once the rider has actually clicked it open.
  var expandedPastYears = {};

  // Past sorties collapse into one closed band per year (most recent
  // first) instead of one long flat list -- opening a year reveals its
  // sorties in place, same accordion row as everywhere else.
  function renderPastEventsCard(past) {
    if (!past.length) return collapsibleCard('events-past', 'Passés', '<div class="empty-state">Aucun événement.</div>', false);
    var byYear = {};
    past.forEach(function (ev) {
      var year = (ev.dateStart || '').slice(0, 4) || '—';
      byYear[year] = byYear[year] || [];
      byYear[year].push(ev);
    });
    var years = Object.keys(byYear).sort(function (a, b) { return b.localeCompare(a); });
    var body = '';
    years.forEach(function (year) {
      var yearEvents = byYear[year];
      var isExpanded = !!expandedPastYears[year];
      body += '<div class="past-year-band">';
      body += '<button type="button" class="past-year-toggle" data-past-year="' + escapeHtml(year) + '" aria-expanded="' + (isExpanded ? 'true' : 'false') + '">' +
        '<span class="past-year-chevron">' + (isExpanded ? '▾' : '▸') + '</span>' +
        '<span class="past-year-label">' + escapeHtml(year) + '</span>' +
        '<span class="past-year-count">' + yearEvents.length + ' événement' + (yearEvents.length > 1 ? 's' : '') + '</span>' +
        '</button>';
      if (isExpanded) {
        body += '<div class="past-year-body">';
        yearEvents.forEach(function (ev) { body += renderEventRow(ev, { hideGroups: false }); });
        body += '</div>';
      }
      body += '</div>';
    });
    return collapsibleCard('events-past', 'Passés', body, false);
  }

  // Two clear categories now: "Mes Événements" (En cours/À venir/Mon
  // calendrier/Ajouter/Passés -- everything that's actually mine, per
  // isMyEventForList) then "Découvrir des Événements" (Team PRO events
  // I'm not on the roster of yet, per their own visibility tier). En
  // cours/À venir/Passés all use isMyEventForList now, not just
  // canSeeEvent -- a plain Team PRO member who never joined a sortie
  // shouldn't find it sitting in their own upcoming events as if they
  // were already going; it belongs in Découvrir, with a join/request
  // action, until they're actually on the roster (amateur Team events
  // and personal sorties are unaffected -- see isMyEventForList).
  function renderEventTab() {
    var all = eventsList();
    var todayKey = dateKey(new Date());
    var me = currentUserProfile;
    var ongoing = [], upcoming = [], past = [];
    all.forEach(function (ev) {
      if (!isMyEventForList(ev)) return;
      var status = eventTemporalStatus(ev, todayKey);
      if (status === 'ongoing') ongoing.push(ev);
      else if (status === 'upcoming') upcoming.push(ev);
      else past.push(ev);
    });
    ongoing.sort(function (a, b) { return a.dateStart < b.dateStart ? -1 : a.dateStart > b.dateStart ? 1 : 0; });
    upcoming.sort(function (a, b) { return a.dateStart < b.dateStart ? -1 : a.dateStart > b.dateStart ? 1 : 0; });
    past.sort(function (a, b) { return a.dateStart < b.dateStart ? 1 : a.dateStart > b.dateStart ? -1 : 0; });
    var html = '<h2 class="section-title">Mes Événements</h2>';
    if (!ongoing.length && !upcoming.length && !past.length) {
      html += '<div class="card"><div class="empty-state">' + (coreDataLoading() ? 'Chargement...' : 'Aucun événement enregistré — ajoutez-en un ci-dessous.') + '</div></div>';
    } else {
      if (ongoing.length) html += renderEventGroupCard('En cours', ongoing, { collapseKey: 'events-ongoing', defaultOpen: true });
      // Upcoming defaults open only when nothing's ongoing -- whichever of
      // the two actually has something to show for right now is the one
      // that shouldn't need an extra click.
      html += renderEventGroupCard('À venir', upcoming, { collapseKey: 'events-upcoming', defaultOpen: !ongoing.length });
    }
    html += renderCalendarSection();
    // Only the "+ Ajouter" prompt (or its own open form, editingEventId
    // 'new') lives in this standing slot -- editing an EXISTING event
    // (editingEventId set to a real id, from "Modifier" inside its own
    // row's accordion below) must never also open the form again here:
    // that duplicated the whole edit card and jumped the page's scroll
    // to this spot, above whatever event the click was actually on.
    html += (editingEventId === null || editingEventId === 'new') ? renderEventForm() : addEventTeaserCard();
    html += renderPastEventsCard(past);
    var discovery = renderProEventDiscovery(me);
    if (discovery) html += '<h2 class="section-title" style="margin-top:1.4rem;">Découvrir des Événements</h2>' + discovery;
    return html;
  }

  // ---- Onglet Planning (horaires de la sortie en cours / à venir) ----
  //
  // A trackday's schedule is fixed by the organizer and repeats every
  // group all day -- what actually changes minute to minute is which
  // slot is current. updateLiveClock() (below, run on an interval) patches
  // the current/next/past classes on these DOM nodes directly rather than
  // going through renderRoot(), so it never blows away an open form
  // elsewhere on the page.
  //
  // Groups are shown as independent columns, each with its own list of
  // slots -- NOT merged onto one shared timeline. A first attempt merged
  // every group onto one "heure en ligne" table, but groups routinely
  // break for lunch at different times (up to 1h apart between a fast
  // group and a slow one), which made a shared timeline mostly empty
  // cells and auto-detected pause rows that didn't line up with what any
  // single group actually experienced.
  function parseHoraireToken(tok) {
    var m = tok.match(/^(\d{1,2})h(\d{2})?\s*(?:[-–à]\s*(\d{1,2})h(\d{2})?)?$/i);
    if (!m) return null;
    var start = parseInt(m[1], 10) * 60 + (m[2] ? parseInt(m[2], 10) : 0);
    var end = m[3] != null
      ? parseInt(m[3], 10) * 60 + (m[4] ? parseInt(m[4], 10) : 0)
      : start + 20; // no end given -- Le Mans/Carole's sessions are 20 min
    return { start: start, end: end };
  }

  function parseHoraireLine(line) {
    return (line || '').split(/[\n,]+/).map(function (s) { return s.trim(); }).filter(Boolean).map(function (tok) {
      var parsed = parseHoraireToken(tok);
      return { label: tok, start: parsed ? parsed.start : null, end: parsed ? parsed.end : null };
    });
  }

  // Every actual timed slot across an event's groups (deduped, sorted) --
  // a free-text label-only line (slot.start == null, see
  // parseHoraireLine) is skipped since it isn't a real time to propose or
  // declare availability for. Used by the Coach tab so a counter-
  // proposal and a Coach's own availability both only ever reference a
  // slot that genuinely exists in this event's horaires, never free text.
  function allEventSlots(ev) {
    var horaires = ev && eventHoraires(ev);
    if (!horaires) return [];
    var seen = {}, out = [];
    HORAIRES_GROUPS.forEach(function (g) {
      if (!horaires[g.key]) return;
      parseHoraireLine(horaires[g.key]).forEach(function (slot) {
        if (slot.start == null || seen[slot.label]) return;
        seen[slot.label] = true;
        out.push(slot);
      });
    });
    out.sort(function (a, b) { return a.start - b.start; });
    return out;
  }
  // A Coach's own declared slot labels for one event and one type
  // (coaching vs baptême get separate sets, see saveCoachAvailability) --
  // null when nothing's been declared for that (event, type) at all, as
  // opposed to [] (declared, but currently nothing checked).
  function coachAvailabilityFor(name, eventId, type) {
    var u = (STATE.usersByName || {})[name] || {};
    if (!isCoachBadge(u)) return null;
    var byType = (u.coachAvailability || {})[eventId];
    return (byType && byType[type]) || null;
  }
  // The valid slots a given account may currently propose for this
  // request -- their own declared coachAvailability for the request's
  // type when they're a Coach who's actually declared any for it,
  // otherwise every real slot of the linked event (an empty/undeclared
  // availability isn't treated as "available for nothing", it just means
  // no filter yet -- this fallback keeps counter-proposing usable before
  // a Coach has gotten around to setting availability up).
  function coachRequestSlotOptions(r, actorName) {
    if (!r.eventId) return [];
    var ev = eventsList().filter(function (e) { return e.id === r.eventId; })[0];
    if (!ev) return [];
    var slots = allEventSlots(ev);
    var av = coachAvailabilityFor(actorName, r.eventId, r.type || 'coaching');
    return (av && av.length) ? slots.filter(function (s) { return av.indexOf(s.label) !== -1; }) : slots;
  }

  // Every rider assigned to a group letter (A-D) at any point of the
  // sortie -- riderGroups is per-day/per-période, but the horaires display
  // is for the whole sortie, so a rider who's in Groupe B on any day/demi-
  // journée shows up under Groupe B.
  function ridersInGroup(ev, letter) {
    var rg = (ev && ev.riderGroups) || {};
    return Object.keys(rg).filter(function (rider) {
      var byDate = rg[rider] || {};
      return Object.keys(byDate).some(function (d) { return byDate[d].am === letter || byDate[d].pm === letter; });
    }).sort();
  }

  // allowedKeys: null/undefined shows every group that has horaires; an
  // array restricts to just those keys (the Planning tab's checkboxes).
  // ev (optional) lets us list which riders are assigned to each group.
  // briefing (optional) shows it as its own column, same as a group, so it
  // shares the live current/next/past highlighting (updateLiveClock keys
  // off data-slot-start/end on every such element, not just group ones).
  // No end time is ever given for a briefing -- 30 min is just the usual
  // length, not a real schedule fact, so it's never treated as anything
  // more precise than that.
  // live (default true): whether to attach data-slot-start/end at all --
  // updateLiveClock() compares them against right-now's clock with no idea
  // which calendar date they're for, so the Calendrier day view (any date,
  // not just today) passes false to render a plain, unhighlighted list
  // instead of misleadingly marking a past/future day's slots as current.
  // slotClassFn(label), optional: extra CSS class(es) to append to a real
  // timed slot's span -- used by the Coach tab to mark availability
  // (see renderCoachPlanningSection) without this function needing to
  // know anything about coaching/baptême itself.
  function renderHoraireGroups(horaires, allowedKeys, ev, briefing, live, slotClassFn) {
    if (live == null) live = true;
    var groups = HORAIRES_GROUPS.filter(function (g) {
      return horaires[g.key] && (!allowedKeys || allowedKeys.indexOf(g.key) !== -1);
    });
    var briefingSlot = briefing ? parseHoraireToken(briefing.trim()) : null;
    if (!groups.length && !briefingSlot) return '';
    var html = '<div class="today-schedule-groups">';
    if (briefingSlot) {
      var briefingAttrs = live ? ' data-slot-start="' + briefingSlot.start + '" data-slot-end="' + (briefingSlot.start + 30) + '"' : '';
      html += '<div class="today-schedule-group today-schedule-briefing"><div class="today-schedule-group-label">Briefing</div>' +
        '<div class="today-schedule-slots"><span class="schedule-slot"' + briefingAttrs + '>' +
        escapeHtml(briefing.trim()) + ' (30 min)</span></div></div>';
    }
    groups.forEach(function (g) {
      html += '<div class="today-schedule-group"><div class="today-schedule-group-label">' + escapeHtml(g.label) + '</div>';
      if (ev) {
        var letter = g.key.replace('group', '');
        var names = ridersInGroup(ev, letter);
        if (names.length) {
          html += '<div class="today-schedule-group-riders">' + names.map(renderRiderLink).join(', ') + '</div>';
        }
      }
      html += '<div class="today-schedule-slots">';
      parseHoraireLine(horaires[g.key]).forEach(function (slot) {
        if (slot.start == null) {
          html += '<span class="schedule-slot schedule-slot-label">' + escapeHtml(slot.label) + '</span>';
        } else {
          var attrs = live ? ' data-slot-start="' + slot.start + '" data-slot-end="' + slot.end + '"' : '';
          var extraCls = slotClassFn ? slotClassFn(slot.label) : '';
          html += '<span class="schedule-slot' + (extraCls || '') + '"' + attrs + '>' + escapeHtml(slot.label) + '</span>';
        }
      });
      html += '</div></div>';
    });
    html += '</div>';
    return html;
  }

  function checklistCountLabel(ev) {
    var allItems = checklistAllItems();
    if (!allItems.length) return 'Équipement (pense-bête)';
    var checklist = ev.checklist || {};
    var done = allItems.filter(function (item) { return checklist[item.id]; }).length;
    return 'Équipement (pense-bête) — ' + done + '/' + allItems.length;
  }

  // The full, editable, categorized pense-bête -- any rider can check an
  // item for this sortie, add/remove an item within a category, or add/
  // remove a whole category, straight from Planning.
  function renderPlanningChecklist(ev) {
    var tpl = checklistTemplate();
    var checklist = ev.checklist || {};
    var admin = isAdmin();
    var html = '<div class="event-checklist planning-checklist">';
    tpl.categories.forEach(function (cat) {
      var isPendingDelete = pendingDeleteChecklistCategory === cat.id;
      var doneInCat = cat.items.filter(function (item) { return checklist[item.id]; }).length;
      var catKey = 'cat-' + cat.id;
      var open = planningSectionsOpen[catKey] ? ' open' : '';
      html += '<details class="checklist-category" data-planning-section="' + catKey + '"' + open + '>';
      html += '<summary><span class="checklist-category-name">' + escapeHtml(cat.name) + ' — ' + doneInCat + '/' + cat.items.length + '</span>';
      // Deleting a whole category is admin-only (see isAdmin()) -- it
      // removes every item other riders may already rely on. Adding is
      // still open to anyone, right below.
      if (admin) {
        html += '<button type="button" class="ghost icon-btn' + (isPendingDelete ? ' confirm' : '') + '" data-action="remove-checklist-category" data-category="' + cat.id + '" aria-label="Supprimer la catégorie ' + escapeHtml(cat.name) + '" title="Supprimer la catégorie">' + (isPendingDelete ? '✓' : '×') + '</button>';
      }
      html += '</summary>';
      html += '<div class="planning-section-body">';
      cat.items.forEach(function (item) {
        var checked = !!checklist[item.id];
        // The remove button is a sibling of the <label>, not nested inside
        // it -- a button nested in a checkbox's <label> gets its click
        // forwarded to the checkbox by the browser, toggling it as an
        // unwanted side effect of removing the item.
        html += '<div class="checklist-item-row">' +
          '<label class="checklist-item"><input type="checkbox" data-checklist-key="' + item.id + '" data-event-id="' + ev.id + '"' + (checked ? ' checked' : '') + '> ' + escapeHtml(item.label) + '</label>' +
          (admin ? '<button type="button" class="ghost icon-btn checklist-item-remove" data-action="remove-checklist-item" data-category="' + cat.id + '" data-item="' + item.id + '" aria-label="Retirer ' + escapeHtml(item.label) + '" title="Retirer">×</button>' : '') +
          '</div>';
      });
      html += '<form class="checklist-add-item-form" data-add-item-category="' + cat.id + '">' +
        '<input type="text" placeholder="+ ajouter un objet" data-new-item-input>' +
        '<button type="submit" class="ghost">Ajouter</button></form>';
      html += '</div></details>';
    });
    html += '<form id="add-checklist-category-form" class="checklist-add-category-form">' +
      '<input type="text" id="new-checklist-category" placeholder="+ nouvelle catégorie">' +
      '<button type="submit" class="ghost">Ajouter</button></form>';
    html += '</div>';
    return html;
  }

  // The sortie the Planning tab leads with: today's if one is running,
  // else the soonest upcoming one, so there's always something useful to
  // look at instead of an empty gap between outings.
  function targetPlanningEvent() {
    var all = eventsList();
    var todayKey = dateKey(new Date());
    var ongoing = all.filter(function (ev) { return eventTemporalStatus(ev, todayKey) === 'ongoing'; })
      .sort(function (a, b) { return a.dateStart < b.dateStart ? -1 : 1; });
    if (ongoing.length) return { ev: ongoing[0], mode: 'ongoing' };
    var upcoming = all.filter(function (ev) { return eventTemporalStatus(ev, todayKey) === 'upcoming'; })
      .sort(function (a, b) { return a.dateStart < b.dateStart ? -1 : 1; });
    if (upcoming.length) return { ev: upcoming[0], mode: 'upcoming' };
    return null;
  }

  // Collapsed by default -- Planning got long once horaires, group
  // assignment and the equipment checklist all landed here, so each big
  // section is a native <details> a rider opens only when they need it.
  // Open/closed state is tracked here (not just left to the browser)
  // because renderRoot() rebuilds this markup from scratch on every
  // change -- without this a <details> would snap shut the moment you
  // ticked a checkbox inside it.
  var planningSectionsOpen = {};
  // titleActionsHtml (optional, e.g. "+ Ajouter un événement" next to
  // "Gestion des événements" -- see collapsibleCard's own titleActionsHtml
  // for the same convention/caveat about preventDefault()).
  function collapsibleSection(key, title, innerHtml, defaultOpen, titleActionsHtml) {
    if (!innerHtml) return '';
    var isOpen = planningSectionsOpen.hasOwnProperty(key) ? !!planningSectionsOpen[key] : !!defaultOpen;
    // margin-left:auto on just the actions wrapper (not justify-content on
    // the whole <summary>) -- summary's arrow (::before) and title text are
    // two separate flex items once display:flex is set, and space-between
    // would shove them apart from each other too, not just push the
    // actions to the right.
    var actionsHtml = titleActionsHtml ? '<span style="margin-left:auto; display:flex; gap:0.5rem;">' + titleActionsHtml + '</span>' : '';
    return '<details class="planning-section" data-planning-section="' + key + '"' + (isOpen ? ' open' : '') + '><summary>' + escapeHtml(title) + actionsHtml + '</summary><div class="planning-section-body">' + innerHtml + '</div></details>';
  }

  // Same open/closed tracking as collapsibleSection above, but styled as a
  // full card (used for Événements' En cours/À venir/Passés/Calendrier/
  // Sorties bands) with its own default -- unlike collapsibleSection,
  // which always starts closed, a key that's never been toggled yet can
  // default open (En cours) so the one thing actually happening today
  // isn't hidden behind an extra click.
  // titleActionsHtml (optional): extra controls next to the title, inside
  // the <summary> -- e.g. "+ Ajouter un événement" right by "Gestion des
  // événements" instead of buried at the bottom of the list. Each such
  // control MUST call evt.preventDefault() in its own click handler (see
  // the "team-event-add" handler) or clicking it would also toggle the
  // <details> open/closed, since a click anywhere in <summary> does that
  // by default.
  function collapsibleCard(key, title, bodyHtml, defaultOpen, titleActionsHtml) {
    var isOpen = planningSectionsOpen.hasOwnProperty(key) ? !!planningSectionsOpen[key] : !!defaultOpen;
    return '<details class="card events-list-card" data-planning-section="' + key + '"' + (isOpen ? ' open' : '') + '>' +
      '<summary class="section-title collapsible-card-summary"><span class="collapsible-card-title">' + escapeHtml(title) + '</span>' + (titleActionsHtml || '') + '</summary>' +
      '<div class="collapsible-card-body">' + bodyHtml + '</div>' +
      '</details>';
  }

  // A photo of the horaires as posted by the organizer in the group's
  // WhatsApp -- lets a rider cross-check what's actually announced
  // against what's been typed into the app (a typo entering the times
  // wouldn't otherwise be caught by anything). Stored as a resized data
  // URL on the event doc, same approach as the profile photo, and goes
  // through the ordinary STATE + persist() flow like every other event
  // field (mediaLink is the same pattern) rather than a direct write.
  var horairesPhotoMessage = '';
  var horairesPhotoExpanded = {}; // event id -> bool, tap to zoom
  function saveHorairesPhoto(eventId, dataUrl) {
    var prevState = JSON.parse(JSON.stringify(STATE));
    var ev = STATE.events.filter(function (e) { return e.id === eventId; })[0];
    if (!ev) return;
    if (dataUrl) {
      ev.horairesPhotoURL = dataUrl;
      ev.horairesPhotoAddedBy = (currentUserProfile && currentUserProfile.name) || null;
    } else {
      delete ev.horairesPhotoURL;
      delete ev.horairesPhotoAddedBy;
    }
    horairesPhotoMessage = '';
    renderRoot();
    persist(prevState);
  }

  function renderHorairesPhotoSection(ev) {
    var isLeader = ev.teamId && isLeaderOfTeam(ev.teamId);
    if (!ev.horairesPhotoURL && !isLeader) return '';
    var html = '<div class="horaires-photo-block">';
    html += '<div class="horaires-photo-title">📷 Photo des horaires de l\'organisateur</div>';
    html += '<div class="help-text">Pour vérifier les horaires ci-dessus par rapport à ce qui a été partagé dans le groupe WhatsApp.</div>';
    if (ev.horairesPhotoURL) {
      var expanded = !!horairesPhotoExpanded[ev.id];
      html += '<img class="horaires-photo-thumb' + (expanded ? ' expanded' : '') + '" src="' + escapeHtml(ev.horairesPhotoURL) + '" alt="Photo des horaires" data-action="toggle-horaires-photo" data-id="' + ev.id + '">';
      if (ev.horairesPhotoAddedBy) html += '<div class="help-text">Ajoutée par ' + escapeHtml(ev.horairesPhotoAddedBy) + '</div>';
      if (isLeader) {
        html += '<div style="margin-top:0.5rem; display:flex; gap:0.5rem;">' +
          '<button type="button" class="ghost" data-action="horaires-photo-add" data-id="' + ev.id + '">Remplacer</button>' +
          '<button type="button" class="ghost" data-action="horaires-photo-remove" data-id="' + ev.id + '">Retirer</button></div>';
      }
    } else {
      html += '<div style="margin-top:0.5rem;"><button type="button" class="ghost" data-action="horaires-photo-add" data-id="' + ev.id + '">Ajouter la photo de l\'organisateur</button></div>';
    }
    html += '<input type="file" id="horaires-photo-input" accept="image/*" style="display:none;" data-id="' + ev.id + '">';
    if (horairesPhotoMessage) html += '<div class="help-text">' + escapeHtml(horairesPhotoMessage) + '</div>';
    html += '</div>';
    return html;
  }

  function renderPlanningTab() {
    var target = targetPlanningEvent();
    if (!target) {
      return '<div class="card"><div class="empty-state">' + (coreDataLoading() ? 'Chargement...' : 'Aucun événement en cours ou à venir — planifiez-en un dans l\'onglet Événements.') + '</div></div>';
    }
    var ev = target.ev, isOngoing = target.mode === 'ongoing';
    // Read by updateLiveClock() so it knows whether "now" actually falls
    // within this sortie -- a session's time-of-day only means "in
    // progress"/"past" today; for a sortie weeks away the countdown should
    // read in days, not compare today's clock against Jerez's 10h.
    planningIsOngoing = isOngoing;
    planningEventDateStart = ev.dateStart;
    planningEventId = ev.id;
    var info = circuitInfo(ev.circuit);
    var horaires = eventHoraires(ev);

    // Orange card: everything the organizing Team PRO/Team provides --
    // schedule, announcements, and the two leader-editable blocks below.
    // Distinguished from the grey card underneath (this account's own,
    // personal info) by a Team badge top-right and its accent border
    // (see .today-schedule-card).
    var isLeader = !!(ev.teamId && isLeaderOfTeam(ev.teamId));
    var orgTeam = ev.teamId ? teamById(ev.teamId) : null;
    var html = '<div class="card today-schedule-card">';
    html += '<div class="today-schedule-head">';
    html += '<div class="eyebrow">' + (isOngoing ? 'En ce moment — ' : 'Prochain événement — ') + escapeHtml(ev.circuit) + '</div>';
    html += '<div class="today-schedule-head-right">';
    if (orgTeam) html += '<span class="event-team-badge">' + escapeHtml(orgTeam.name) + teamBadgesHtml(orgTeam) + '</span>';
    if (isOngoing) html += '<div class="planning-big-clock" id="planning-big-clock">--h--</div>';
    html += '</div>';
    html += '</div>';
    var sub = [];
    if (!isOngoing) sub.push(escapeHtml(formatEventRange(ev, true)) + ' (' + weekdayName(ev.dateStart) + ')');
    if (sub.length) html += '<div class="help-text" style="font-size:0.78rem; font-weight:400;">' + sub.join(' · ') + '</div>';
    // Raccourci vers Modifier l'événement, uniquement pour le Team Leader
    // du Team qui gère cet event -- pas besoin d'aller jusqu'à Team ->
    // Gestion des événements pour un ajustement rapide.
    if (isLeader) {
      if (editingEventId === ev.id) html += renderEventForm();
      else html += '<div style="margin:0.5rem 0;"><button type="button" class="ghost" data-action="team-event-edit" data-id="' + ev.id + '">✎ Modifier l\'événement</button></div>';
    }
    if (ev.teamId) html += renderEventAnnouncements(ev, false);
    html += renderSpecialActivitiesSection(ev, isLeader);
    html += renderRentalMotosSection(ev, isLeader);
    html += renderRentalEquipementSection(ev, isLeader);
    // Briefing lives with Horaires (above the group filter) now, not up
    // here -- it's schedule information, same family as the slot times.
    var briefingLine = info.briefing ? '<div class="help-text" style="margin-bottom:0.6rem; color:var(--accent); font-weight:600;">Briefing ' + escapeHtml(info.briefing) + '</div>' : '';

    html += renderMyGroupSection(ev);

    // Groupes/Équipement/Infos pratiques are the same three rubriques
    // whether or not this circuit has horaires recorded -- only the
    // Horaires rubrique itself (and the countdown/recap that depend on
    // slot times) differs between the two cases, so that's the only part
    // built conditionally below.
    var availableGroups = horaires ? HORAIRES_GROUPS.filter(function (g) { return horaires[g.key]; }) : [];
    if (!availableGroups.length) {
      html += briefingLine;
      html += '<div class="help-text">Aucun horaire enregistré pour ' + escapeHtml(ev.circuit) + ' — un admin peut les ajouter depuis l\'onglet Circuit (Modifier les infos), ou le Team Leader depuis "Modifier l\'événement" pour cette sortie seulement.</div>';
      html += renderHorairesPhotoSection(ev);
    } else {
      var activeKeys = (planningGroupFilter && planningGroupFilter.length)
        ? planningGroupFilter.filter(function (k) { return availableGroups.some(function (g) { return g.key === k; }); })
        : availableGroups.map(function (g) { return g.key; });
      if (!activeKeys.length) activeKeys = availableGroups.map(function (g) { return g.key; });

      html += '<div id="planning-countdown" class="planning-countdown"></div>';
      if (isOngoing) html += renderFollowedRidersStatus(ev, horaires, dateKey(new Date()));

      var horairesInner = briefingLine;
      horairesInner += '<div class="planning-group-filter">';
      availableGroups.forEach(function (g) {
        var checked = activeKeys.indexOf(g.key) !== -1;
        horairesInner += '<label class="planning-group-check"><input type="checkbox" data-planning-group="' + g.key + '"' + (checked ? ' checked' : '') + '> ' + escapeHtml(g.label) + '</label>';
      });
      horairesInner += '</div>';
      horairesInner += renderHoraireGroups(horaires, activeKeys, ev, info.briefing);
      horairesInner += renderHorairesPhotoSection(ev);
      html += collapsibleSection('horaires', 'Horaires', horairesInner, false);
    }
    html += renderPracticalInfoSection(ev, isLeader);
    if (isOngoing && availableGroups.length) {
      var todayKey = dateKey(new Date());
      if (myGroupFinishedToday(ev, horaires, todayKey)) {
        html += '<div class="return-reminder">De retour au paddock — pense à vérifier la <strong>PRESSION PNEUS</strong> et l\'<strong>ESSENCE</strong>.</div>';
      }
      html += renderDailyRecap(ev, horaires, todayKey);
    }
    html += '</div>';

    // Grey card: this account's own personal info for the sortie -- never
    // something the Team orga fills in for everyone.
    var personal = '<div class="card personal-info-card">';
    personal += renderFriendsGroupSection(ev);
    personal += collapsibleSection('equipement', checklistCountLabel(ev), renderPlanningChecklist(ev));
    personal += renderMyTravelInfoSection(ev);
    personal += renderFollowedTravelInfoSection(ev);
    personal += '</div>';

    return html + personal;
  }

  // The connected pilote's own group for a given date -- pm takes
  // priority over am since it's the later, more current assignment as the
  // day progresses (a pilote who switched groups at lunch is "in" their pm
  // group by the time the day winds down).
  function myGroupLetterToday(ev, dateStr) {
    if (!currentUserProfile || currentUserProfile.role === 'accompagnant') return '';
    return riderGroupFor(ev, currentUserProfile.name, dateStr, 'apres-midi') || riderGroupFor(ev, currentUserProfile.name, dateStr, 'matin') || '';
  }

  // Whether the connected pilote's own group has no more slots left today
  // -- the trigger for showing the daily recap. A pilote not assigned to
  // any group today, or an accompagnant, never sees it (nothing of
  // "theirs" to recap).
  function myGroupFinishedToday(ev, horaires, dateStr) {
    var letter = myGroupLetterToday(ev, dateStr);
    if (!letter || !horaires) return false;
    var line = horaires['group' + letter];
    if (!line) return false;
    var ends = parseHoraireLine(line).map(function (s) { return s.end; }).filter(function (e) { return e != null; });
    if (!ends.length) return false;
    var nowMinutes = new Date().getHours() * 60 + new Date().getMinutes();
    return nowMinutes >= Math.max.apply(null, ends);
  }

  // Same am/pm-priority group lookup as myGroupLetterToday, but for any
  // named rider -- used to build the accompagnant's followed-riders status
  // card below (myGroupLetterToday only ever answers for the connected
  // account itself).
  function riderGroupLetterToday(ev, riderName, dateStr) {
    return riderGroupFor(ev, riderName, dateStr, 'apres-midi') || riderGroupFor(ev, riderName, dateStr, 'matin') || '';
  }

  // One line of status per followed rider ("en piste", "prochain départ à
  // 14h20", "terminé pour aujourd'hui", "pas de groupe aujourd'hui"),
  // computed from the schedule directly rather than relying on the
  // browser Notification firing while the tab happens to be open -- an
  // accompagnant can check this on demand at any time.
  function followedRiderStatusToday(ev, horaires, dateStr, riderName) {
    var letter = riderGroupLetterToday(ev, riderName, dateStr);
    if (!letter) return 'Pas de groupe aujourd\'hui';
    var line = horaires && horaires['group' + letter];
    var slots = line ? parseHoraireLine(line) : [];
    var withTimes = slots.filter(function (s) { return s.start != null && s.end != null; });
    if (!withTimes.length) return 'Groupe ' + letter;
    var nowMinutes = new Date().getHours() * 60 + new Date().getMinutes();
    var current = withTimes.filter(function (s) { return nowMinutes >= s.start && nowMinutes < s.end; })[0];
    if (current) return 'Groupe ' + letter + ' — en piste maintenant';
    var next = withTimes.filter(function (s) { return s.start > nowMinutes; }).sort(function (a, b) { return a.start - b.start; })[0];
    if (next) return 'Groupe ' + letter + ' — prochain départ ' + pad2(Math.floor(next.start / 60)) + 'h' + pad2(next.start % 60);
    return 'Groupe ' + letter + ' — terminé pour aujourd\'hui';
  }

  // Priority card for an accompagnant on an ongoing sortie: at-a-glance
  // status of every rider they follow, so they don't have to rely solely
  // on the best-effort browser Notification (lost if the tab is closed).
  function renderFollowedRidersStatus(ev, horaires, dateStr) {
    if (!currentUserProfile || currentUserProfile.role !== 'accompagnant') return '';
    var followed = (currentUserProfile.followedRiders || []).slice().sort();
    if (!followed.length) return '';
    var rows = followed.map(function (name) {
      return infoRow(name, escapeHtml(followedRiderStatusToday(ev, horaires, dateStr, name)));
    }).join('');
    return '<div class="card followed-riders-status-card">' +
      '<h2 class="section-title">Statut de mes pilotes</h2>' + rows + '</div>';
  }

  // A same-day leaderboard: every rider who logged a chrono today on this
  // circuit, fastest first, with how much they gained or lost against
  // their best time on this circuit from any earlier day.
  // Shared by the rendered table and the "Partager" button (which needs
  // the same numbers again once clicked, outside the render closure).
  function dailyRecapRows(circuit, dateStr) {
    var todaySessions = STATE.sessions.filter(function (s) { return s.circuit === circuit && s.date === dateStr; });
    var byRider = {};
    todaySessions.forEach(function (s) {
      var best = sessionBest(s);
      if (!byRider[s.rider]) byRider[s.rider] = { best: best, laps: 0 };
      if (best < byRider[s.rider].best) byRider[s.rider].best = best;
      byRider[s.rider].laps += s.laps.length;
    });
    return Object.keys(byRider).map(function (rider) {
      var prevBest = null;
      STATE.sessions.forEach(function (s) {
        if (s.rider !== rider || s.circuit !== circuit || s.date === dateStr) return;
        var b = sessionBest(s);
        if (prevBest === null || b < prevBest) prevBest = b;
      });
      var todayBest = byRider[rider].best;
      return { rider: rider, best: todayBest, laps: byRider[rider].laps, delta: prevBest === null ? null : (todayBest - prevBest) };
    }).sort(function (a, b) { return a.best - b.best; });
  }

  function dailyRecapShareText(circuit, dateStr, rows) {
    var lines = ['🏁 Récap ' + circuit + ' — ' + formatDate(dateStr)];
    rows.forEach(function (r) {
      var deltaText = r.delta == null ? '' : r.delta < 0 ? ' (−' + Math.abs(r.delta).toFixed(3) + ')' : r.delta > 0 ? ' (+' + r.delta.toFixed(3) + ')' : ' (=)';
      lines.push(r.rider + ' — ' + formatTime(r.best) + deltaText + ' · ' + r.laps + ' tour' + (r.laps > 1 ? 's' : ''));
    });
    return lines.join('\n');
  }

  function renderDailyRecap(ev, horaires, dateStr) {
    if (!myGroupFinishedToday(ev, horaires, dateStr)) return '';
    var rows = dailyRecapRows(ev.circuit, dateStr);
    if (!rows.length) return '';

    var html = '<div class="card daily-recap-card" data-recap-circuit="' + escapeHtml(ev.circuit) + '" data-recap-date="' + dateStr + '">';
    html += '<div class="daily-recap-head"><h2 class="section-title">Récap de la journée</h2>' +
      '<button type="button" class="ghost" id="daily-recap-share-btn">Partager</button></div>';
    html += '<div class="table-scroll"><table class="session-table"><thead><tr><th>Pilote</th><th>Meilleur chrono</th><th>Tours</th><th>Progression</th></tr></thead><tbody>';
    rows.forEach(function (r) {
      var deltaHtml = '—';
      if (r.delta != null) {
        if (r.delta < 0) deltaHtml = '<span class="daily-recap-better">−' + Math.abs(r.delta).toFixed(3) + '</span>';
        else if (r.delta > 0) deltaHtml = '<span class="daily-recap-worse">+' + r.delta.toFixed(3) + '</span>';
        else deltaHtml = '=';
      }
      html += '<tr><td>' + renderRiderLink(r.rider) + '</td><td>' + formatTime(r.best) + '</td><td>' + r.laps + '</td><td>' + deltaHtml + '</td></tr>';
    });
    html += '</tbody></table></div></div>';
    return html;
  }

  // Fires a browser notification once, when a rider the current account
  // cares about is about to go out (<=10 min) and notifications are
  // opted-in from "Mon profil". A pilote is notified about their own
  // group; an accompagnant is notified about whichever of their followed
  // riders is about to leave. Only works while this tab stays open --
  // there's no backend on GitHub Pages to push a real notification once
  // the app is closed.
  function maybeNotifyGroupDeparture(nextStart, diff, nextGroupLabels) {
    if (!currentUserProfile || !currentUserProfile.notifyBeforeSession) return;
    if (!window.Notification || Notification.permission !== 'granted') return;
    if (diff > 10 || diff < 0) return;
    var ev = eventsList().filter(function (e) { return e.id === planningEventId; })[0];
    if (!ev) return;
    var namesToWatch = currentUserProfile.role === 'accompagnant'
      ? (currentUserProfile.followedRiders || [])
      : [currentUserProfile.name];
    if (!namesToWatch.length) return;
    var departingNames = ridersForGroupLabels(ev, nextGroupLabels).filter(function (name) {
      return namesToWatch.indexOf(name) !== -1;
    });
    if (!departingNames.length) return;
    var slotKey = planningEventId + '-' + nextStart;
    if (notifiedSlotKey === slotKey) return;
    notifiedSlotKey = slotKey;
    var subject = currentUserProfile.role === 'accompagnant'
      ? departingNames.join(', ') + ' part' + (departingNames.length > 1 ? 'ent' : '') + ' rouler'
      : 'Ton groupe part rouler';
    new Notification('Carnet de Piste', { body: subject + ' dans ' + diff + ' min !' });
  }

  // Same "opted-in + permission granted" gating as maybeNotifyGroupDeparture
  // above, one flag per notification category (see renderNotificationsSettings)
  // -- every category defaults to true (opted-in) via !== false, same
  // convention as shareSorties/shareTrophees.
  function notifCategoryAllowed(field) {
    return !!currentUserProfile && currentUserProfile[field] !== false
      && !!window.Notification && Notification.permission === 'granted';
  }

  // Once, the day after an event a rider took part in ends: a nudge to
  // react with an emoji (see toggleReaction('events', ...)/renderReactionBar)
  // -- deliberately not an invitation to write a comment or upload a
  // photo, which would cost far more to store and moderate for what's
  // meant to be a lightweight "on a kiffé" gauge. Narrow, date-windowed
  // stream (only ever events that ended exactly yesterday), so unlike
  // notifyOnNewIds' streams there's no "backlog" to baseline away --
  // still persisted (not a plain in-memory var) so a page reload the same
  // day doesn't re-fire it.
  function maybeNotifyEndedEvents() {
    var me = currentUserProfile, uid = myUid();
    if (!me || !uid || !notifCategoryAllowed('notifyEventEndedReaction')) return;
    var storageKey = 'carnet-de-piste-seen-event-ended-' + uid;
    var notifiedEventEndedIds;
    try {
      var raw = localStorage.getItem(storageKey);
      notifiedEventEndedIds = raw ? JSON.parse(raw) : {};
    } catch (e) { notifiedEventEndedIds = {}; }
    var changed = false;
    var yesterdayKey = dateKey(new Date(Date.now() - 86400000));
    (STATE.events || []).forEach(function (ev) {
      if (!ev.riders || ev.riders.indexOf(me.name) === -1) return;
      if ((ev.dateEnd || ev.dateStart) !== yesterdayKey) return;
      if (notifiedEventEndedIds[ev.id]) return;
      notifiedEventEndedIds[ev.id] = true;
      changed = true;
      if ((ev.reactions || {})[me.name]) return;
      new Notification('Carnet de Piste', { body: 'Comment s\'est passé ' + ev.circuit + ' ? Réagis avec un emoji !' });
    });
    if (changed) {
      try { localStorage.setItem(storageKey, JSON.stringify(notifiedEventEndedIds)); } catch (e) {}
    }
  }

  // Every "notify once for each new X" stream (team invites, Actu de
  // Team, annonces d'event, messages de coaching...) used to track its
  // baseline in a plain JS variable, reset to null on every single page
  // load -- so its very first snapshot after a refresh always re-ran the
  // "baseline, don't notify" branch, which itself is harmless, but a
  // second snapshot arriving moments later (Firestore delivers one from
  // local cache, then one confirmed by the server -- routine, not a bug)
  // could see a slightly different doc set and treat some as newly seen,
  // firing a real Notification() for a post from days ago. Persisting the
  // seen-id set in localStorage (per account, since the browser can be
  // shared) instead of memory makes "seen" durable across reloads, so a
  // post only ever notifies once, full stop, matching every other
  // "seenXxxIds" call site below (they all now go through this).
  function notifyOnNewIds(streamKey, items, idFn, onNew) {
    var uid = myUid();
    if (!uid) return;
    var storageKey = 'carnet-de-piste-seen-' + streamKey + '-' + uid;
    var seen = null;
    try {
      var raw = localStorage.getItem(storageKey);
      seen = raw ? JSON.parse(raw) : null;
    } catch (e) { seen = null; }
    var isFirstEver = seen === null;
    seen = seen || {};
    var changed = false;
    items.forEach(function (item) {
      var id = idFn(item);
      if (seen[id]) return;
      seen[id] = true;
      changed = true;
      if (!isFirstEver) onNew(item);
    });
    if (changed) {
      try { localStorage.setItem(storageKey, JSON.stringify(seen)); } catch (e) {}
    }
  }

  // Neither decideTeamAdherentRequest (accept/decline "devenir adhérent")
  // nor acceptTeamJoinRequestAs/removeTeamJoinRequest ever told the
  // requester what happened -- they'd only find out by reopening the
  // Team's own fiche. Unlike notifyOnNewIds (new id appearing), this
  // watches for a *transition* on a doc the requester already has open:
  // adherentRequested flipping from true to false means a decision was
  // made, tier says which way. Purely in-memory (not persisted to
  // localStorage like notifyOnNewIds' streams) since it only needs to
  // catch a decision made while this tab is open, same as every push
  // notification here ("nécessite que cet onglet reste ouvert").
  var myAdherentRequestWasPending = {};
  function maybeNotifyAdherentDecision(teamFollows) {
    teamFollows.forEach(function (f) {
      var wasPending = myAdherentRequestWasPending[f.id];
      if (f.adherentRequested) {
        myAdherentRequestWasPending[f.id] = true;
        return;
      }
      myAdherentRequestWasPending[f.id] = false;
      if (!wasPending || !notifCategoryAllowed('notifyRequestDecisions')) return;
      var t = teamById(f.followee);
      var body = f.tier === 'adherent'
        ? 'Ta demande d\'adhésion' + (t ? ' à ' + t.name : '') + ' a été acceptée !'
        : 'Ta demande d\'adhésion' + (t ? ' à ' + t.name : '') + ' a été refusée.';
      new Notification('Carnet de Piste', { body: body });
    });
  }

  // Same gap as maybeNotifyAdherentDecision, for a plain "demander à
  // rejoindre" Team request (see acceptTeamJoinRequestAs/
  // removeTeamJoinRequest): the request doc is simply deleted either way,
  // so accept vs. decline is told apart by checking whether this account
  // actually landed in that Team's roster right after -- a one-off get(),
  // not a live listener, since this only needs to run once per vanished
  // request.
  var myTeamJoinRequestIds = {};
  function maybeNotifyJoinRequestDecision(docs) {
    var stillPending = {};
    docs.forEach(function (r) { stillPending[r.id] = r.teamId; });
    Object.keys(myTeamJoinRequestIds).forEach(function (id) {
      if (stillPending[id]) return;
      var teamId = myTeamJoinRequestIds[id];
      if (notifCategoryAllowed('notifyRequestDecisions')) {
        var myNameNow = currentUserProfile.name;
        db.collection('teamMembers').where('teamId', '==', teamId).where('name', '==', myNameNow).limit(1).get().then(function (memSnap) {
          var t = teamById(teamId);
          var body = !memSnap.empty
            ? 'Ta demande pour rejoindre' + (t ? ' ' + t.name : '') + ' a été acceptée !'
            : 'Ta demande pour rejoindre' + (t ? ' ' + t.name : '') + ' a été refusée.';
          new Notification('Carnet de Piste', { body: body });
        }).catch(function () {});
      }
    });
    myTeamJoinRequestIds = stillPending;
  }

  // Same gap again, for a plain friend request: acceptFriendRequest sets
  // status 'accepted' (writeFeedEvent then surfaces it in the Social
  // feed), but removeFriendRequest just deletes the doc for a decline, a
  // cancel, AND an unfriend alike (see friendRequests rules), with no
  // distinction and no signal to the sender either way. Only a decline of
  // a still-pending SENT request should ever notify -- unfriending an
  // old, already-accepted one must stay silent, so this only fires when
  // the doc's last known status (before it vanished) was 'pending'.
  var myFriendRequestsSeen = {};
  function maybeNotifyFriendDecline(byId) {
    var prev = myFriendRequestsSeen;
    Object.keys(prev).forEach(function (id) {
      if (byId[id]) return;
      if (prev[id].status !== 'pending') return;
      if (!notifCategoryAllowed('notifyRequestDecisions')) return;
      new Notification('Carnet de Piste', { body: 'Ta demande d\'ami' + (prev[id].to ? ' à ' + prev[id].to : '') + ' a été refusée.' });
    });
    myFriendRequestsSeen = byId;
  }

  // certifyChrono (see canManageCertification) sets a session's
  // certifiedBy with no signal at all to the rider it belongs to -- they'd
  // only notice the ✓ Vérifié badge next time they happened to look at
  // that chrono. Watches the global sessions sync (every session, not
  // just this account's own) for a certifiedBy appearing on one of MY
  // sessions. isFirstEver-style baseline (like notifyOnNewIds) so chronos
  // already certified before this page load never fire on startup --
  // only a certification that happens while this tab is open.
  var myChronoCertifiedState = null;
  function maybeNotifyChronoCertified(sessions) {
    var me = currentUserProfile;
    if (!me) return;
    var isFirstEver = myChronoCertifiedState === null;
    var next = {};
    sessions.forEach(function (s) {
      if (s.rider !== me.name) return;
      next[s.id] = s.certifiedBy || null;
      if (isFirstEver) return;
      var prev = myChronoCertifiedState[s.id];
      if (s.certifiedBy && !prev && notifCategoryAllowed('notifyChronoCertified')) {
        new Notification('Carnet de Piste', { body: 'Ton chrono' + (s.circuit ? ' à ' + s.circuit : '') + ' a été vérifié par ' + s.certifiedBy + ' !' });
      }
    });
    myChronoCertifiedState = next;
  }

  // toggleReaction (Mur/Team feed emoji reactions) writes straight to
  // reactions.<name> with no signal at all to the post's own author --
  // the last of tonight's silent-write gaps. Watches a post stream for a
  // new key appearing in ITS OWN post's reactions map (never for a
  // reaction the author added themselves). isFirstEver-style baseline per
  // stream instance, same reasoning as maybeNotifyChronoCertified -- and
  // since teamFeed's stream is torn down and rebuilt on every
  // refreshTeamDetailSync (team list change), each rebuild only means one
  // skipped baseline snapshot, never a stale one.
  function makeReactionNotifier(authorField, describe) {
    var seen = null;
    return function (posts) {
      var isFirstEver = seen === null;
      var next = {};
      var me = currentUserProfile;
      (posts || []).forEach(function (p) {
        var prevReactions = (seen && seen[p.id]) || {};
        next[p.id] = p.reactions || {};
        if (isFirstEver || !me || p[authorField] !== me.name || !notifCategoryAllowed('notifyReactions')) return;
        Object.keys(p.reactions || {}).forEach(function (name) {
          if (name === me.name || prevReactions[name]) return;
          new Notification('Carnet de Piste', { body: name + ' a réagi ' + p.reactions[name] + ' à ' + describe(p) });
        });
      });
      seen = next;
    };
  }
  var maybeNotifyWallPostReaction = makeReactionNotifier('author', function () { return 'ton post sur le Mur'; });
  var maybeNotifyTeamFeedReaction = makeReactionNotifier('author', function (f) {
    var t = teamById(f.teamId);
    return 'ta publication' + (t ? ' sur ' + t.name : '');
  });

  function maybeNotifyNewTeamInvites(byId) {
    var pending = Object.keys(byId).filter(function (id) { return byId[id].status === 'pending'; }).map(function (id) { return byId[id]; });
    notifyOnNewIds('team-invites', pending, function (inv) { return inv.id; }, function (inv) {
      if (!notifCategoryAllowed('notifyInvites')) return;
      var invTeamName = (teamById(inv.teamId) || {}).name || inv.teamName;
      new Notification('Carnet de Piste', { body: 'Tu as reçu une invitation' + (invTeamName ? ' à rejoindre ' + invTeamName : '') + ' !' });
    });
  }

  // The group label(s) attached to the earliest data-slot-start currently
  // in the DOM, and among those matching, the group letter itself. Shared
  // by both the "dans X jours" and "prochaine session dans" countdowns so
  // only the group that actually leaves first is ever shown, not every
  // group running that day.
  function earliestScheduleGroupLabels(minStart) {
    var labels = [];
    document.querySelectorAll('[data-slot-start="' + minStart + '"]').forEach(function (el) {
      var groupContainer = el.closest('.today-schedule-group');
      var labelEl = groupContainer && groupContainer.querySelector('.today-schedule-group-label');
      if (labelEl && labels.indexOf(labelEl.textContent) === -1) labels.push(labelEl.textContent);
    });
    return labels;
  }

  function ridersForGroupLabels(ev, labels) {
    var names = [];
    HORAIRES_GROUPS.filter(function (g) { return labels.indexOf(g.label) !== -1; }).forEach(function (g) {
      ridersInGroup(ev, g.key.replace('group', '')).forEach(function (name) {
        if (names.indexOf(name) === -1) names.push(name);
      });
    });
    return names.sort();
  }

  function countdownHtml(prefix, groupLabels, riderNames) {
    var html = escapeHtml(prefix);
    if (groupLabels.length) html += ' — ' + escapeHtml(groupLabels.join(', '));
    if (riderNames.length) html += ' <span class="planning-countdown-riders">' + riderNames.map(escapeHtml).join(', ') + '</span>';
    return html;
  }

  // Every group with a slot live right now (there can be more than one at
  // once, each on its own schedule) -- distinct from
  // earliestScheduleGroupLabels(), which looks at a single start time.
  function activeScheduleGroupLabels() {
    var labels = [];
    document.querySelectorAll('.today-schedule-group').forEach(function (container) {
      if (!container.querySelector('.slot-current')) return;
      var labelEl = container.querySelector('.today-schedule-group-label');
      if (labelEl && labels.indexOf(labelEl.textContent) === -1) labels.push(labelEl.textContent);
    });
    return labels;
  }

  function updateLiveClock() {
    var clockEl = document.getElementById('live-clock');
    if (clockEl) {
      var now = new Date();
      clockEl.textContent = pad2(now.getHours()) + 'h' + pad2(now.getMinutes());
    }
    var bigClockEl = document.getElementById('planning-big-clock');
    if (bigClockEl) {
      var now2 = new Date();
      bigClockEl.textContent = pad2(now2.getHours()) + 'h' + pad2(now2.getMinutes());
    }
    var countdownEl = document.getElementById('planning-countdown');
    // Session times are only "current"/"past" relative to today's clock if
    // today actually falls within the sortie -- for a sortie that's still
    // weeks away, every slot would otherwise look "past" the moment its
    // time-of-day ticks by today, which is meaningless.
    if (!planningIsOngoing) {
      document.querySelectorAll('[data-slot-start]').forEach(function (el) {
        el.classList.remove('slot-current', 'slot-next', 'slot-past');
      });
      if (countdownEl) {
        if (planningEventDateStart) {
          var days = Math.round((parseLocalDate(planningEventDateStart) - parseLocalDate(dateKey(new Date()))) / 86400000);
          var dayText = days === 1 ? 'Dans 1 jour' : 'Dans ' + days + ' jours';
          var minStartUp = null;
          document.querySelectorAll('[data-slot-start]').forEach(function (el) {
            var start = parseInt(el.getAttribute('data-slot-start'), 10);
            if (minStartUp == null || start < minStartUp) minStartUp = start;
          });
          var groupLabelsUp = minStartUp == null ? [] : earliestScheduleGroupLabels(minStartUp);
          var evUp = eventsList().filter(function (e) { return e.id === planningEventId; })[0];
          var riderNamesUp = evUp ? ridersForGroupLabels(evUp, groupLabelsUp) : [];
          countdownEl.innerHTML = countdownHtml(dayText, groupLabelsUp, riderNamesUp);
        } else {
          countdownEl.textContent = '';
        }
      }
      return;
    }
    var nowMinutes = new Date().getHours() * 60 + new Date().getMinutes();
    var seenNext = false;
    var nextStart = null;
    document.querySelectorAll('[data-slot-start]').forEach(function (el) {
      var start = parseInt(el.getAttribute('data-slot-start'), 10);
      var end = parseInt(el.getAttribute('data-slot-end'), 10);
      el.classList.remove('slot-current', 'slot-next', 'slot-past');
      if (nowMinutes >= start && nowMinutes < end) {
        el.classList.add('slot-current');
      } else if (nowMinutes < start) {
        if (!seenNext) { el.classList.add('slot-next'); seenNext = true; }
        if (nextStart == null || start < nextStart) nextStart = start;
      } else {
        el.classList.add('slot-past');
      }
    });
    if (countdownEl) {
      var evForLines = eventsList().filter(function (e) { return e.id === planningEventId; })[0];
      var currentGroupLabels = activeScheduleGroupLabels();
      var currentRiderNames = evForLines ? ridersForGroupLabels(evForLines, currentGroupLabels) : [];
      var currentLine = currentGroupLabels.length
        ? '<div class="planning-current-session">Session en cours — ' + escapeHtml(currentGroupLabels.join(', ')) +
          (currentRiderNames.length ? ' — ' + currentRiderNames.map(escapeHtml).join(', ') : '') + '</div>'
        : '';
      if (nextStart == null) {
        countdownEl.innerHTML = currentLine;
      } else {
        var diff = nextStart - nowMinutes;
        var nextGroupLabels = earliestScheduleGroupLabels(nextStart);
        var nextRiderNames = evForLines ? ridersForGroupLabels(evForLines, nextGroupLabels) : [];
        var timeText = diff >= 60 ? (Math.floor(diff / 60) + 'h' + pad2(diff % 60)) : (diff + ' min');
        var nextLine = 'Prochaine session dans <span class="planning-countdown-time">' + escapeHtml(timeText) + '</span>' +
          (nextGroupLabels.length ? ' — ' + escapeHtml(nextGroupLabels.join(', ')) : '') +
          (nextRiderNames.length ? ' <span class="planning-countdown-riders">' + nextRiderNames.map(escapeHtml).join(', ') + '</span>' : '');
        countdownEl.innerHTML = currentLine + '<div>' + nextLine + '</div>';
        maybeNotifyGroupDeparture(nextStart, diff, nextGroupLabels);
      }
    }
  }

  // Only ever shown for a personal (non-Team) event -- a Team event's
  // groups are entirely managed afterward from renderGroupsSection
  // instead. Reads/writes the form's in-memory draft, not a saved event's
  // ev.riderGroups -- riders typed into the form aren't a real sortie yet,
  // there's nothing to key off of until Enregistrer is pressed. This
  // single "groupe de départ" per rider seeds ev.riderGroups uniformly
  // across every date/période when the sortie is created/saved (see
  // draftRiderGroupsFor).
  function renderEventFormGroupsGrid(riders) {
    if (!riders.length) return '<div class="help-text">Ajoutez au moins un pilote pour lui assigner un groupe de départ.</div>';
    var groupOptions = function (current) {
      var opts = '<option value=""' + (!current ? ' selected' : '') + '>—</option>';
      GROUP_LETTERS.forEach(function (g) {
        opts += '<option value="' + g + '"' + (current === g ? ' selected' : '') + '>' + g + '</option>';
      });
      return opts;
    };
    var html = '<div class="rider-start-groups">';
    riders.forEach(function (rider) {
      var current = (eventFormDraftGroups[rider] && eventFormDraftGroups[rider].start) || '';
      html += '<label class="rider-group-field"><span class="rider-group-name">' + escapeHtml(rider) + '</span>' +
        '<select data-form-start-group data-rider="' + escapeHtml(rider) + '">' + groupOptions(current) + '</select></label>';
    });
    html += '</div>';
    return html;
  }

  // Reads the riders currently typed into the open form and regenerates
  // just the groups grid from the draft -- called whenever that field
  // changes, without touching (or losing in-progress input in) the rest
  // of the form.
  function refreshEventFormGroups() {
    var grid = document.getElementById('ev-groups-grid');
    if (!grid) return;
    var ridersEl = document.getElementById('ev-riders');
    var riders = ridersEl ? ridersEl.value.split(',').map(function (r) { return r.trim(); }).filter(Boolean) : [];
    grid.innerHTML = renderEventFormGroupsGrid(riders);
    attachEventFormGroupHandlers();
  }

  function attachEventFormGroupHandlers() {
    document.querySelectorAll('#ev-groups-grid select[data-form-start-group]').forEach(function (sel) {
      sel.addEventListener('change', function () {
        var rider = sel.getAttribute('data-rider');
        eventFormDraftGroups[rider] = sel.value ? { start: sel.value } : {};
      });
    });
  }

  function addEventTeaserCard() {
    return '<div class="card add-event-card"><h2 class="section-title">Ajouter un événement</h2><button type="button" class="primary" id="add-event-btn">+ Ajouter un événement</button></div>';
  }

  function renderEventForm() {
    if (editingEventId === null) {
      eventFormDraftGroupsFor = null;
      eventFormRidersDraftFor = null;
      return addEventTeaserCard();
    }
    var isNew = editingEventId === 'new';
    var ev = isNew ? { circuit: prefillEventCircuit || '' } : (eventsList().filter(function (e) { return e.id === editingEventId; })[0] || {});
    // A new sortie starts from its circuit's usual organizing Team (set via
    // Chronos > Modifier les infos) -- the organizer is normally the same
    // every time, so re-picking it per sortie would be pure friction. Only
    // takes if this account actually leads that team (the only teams
    // ev-team ever offers below).
    // Horaires themselves aren't edited here at all anymore -- Planning
    // reads them straight from the circuit.
    if (isNew && ev.circuit) {
      var circuitDefaults = circuitInfo(ev.circuit);
      if (circuitDefaults.organizerTeamId) ev.teamId = circuitDefaults.organizerTeamId;
    }
    // Opened from a Team's own "Gestion des événements" -- that Team wins
    // over the circuit's usual organizing Team, since the leader picked it
    // explicitly by clicking there.
    if (isNew && prefillEventTeamId) ev.teamId = prefillEventTeamId;
    // The draft starts from each rider's day-1 group when editing an
    // existing sortie (just a representative "groupe de départ", not the
    // full day-by-day breakdown -- that's edited in Planning), or empty
    // for a new one. Only re-seeds when editingEventId itself changes, so
    // it isn't wiped on every keystroke.
    if (eventFormDraftGroupsFor !== editingEventId) {
      var seedGroups = {};
      Object.keys(ev.riderGroups || {}).forEach(function (rider) {
        var riderDates = Object.keys(ev.riderGroups[rider]).sort();
        var firstDate = riderDates[0];
        var start = firstDate && (ev.riderGroups[rider][firstDate].am || ev.riderGroups[rider][firstDate].pm);
        if (start) seedGroups[rider] = { start: start };
      });
      eventFormDraftGroups = seedGroups;
      eventFormDraftGroupsFor = editingEventId;
    }
    if (eventFormMoreOptionsFor !== editingEventId) {
      eventFormMoreOptionsOpen = !(isNew && !ev.teamId);
      eventFormMoreOptionsFor = editingEventId;
    }
    var html = '<div class="card">';
    html += '<h2 class="section-title">' + (isNew ? 'Ajouter un événement' : 'Modifier l\'événement') + '</h2>';
    html += '<form id="event-form" novalidate>';
    html += '<div class="field-row">';
    // A plain text input with a <datalist> already lets someone pick an
    // existing circuit OR type a brand-new one -- but nothing stopped
    // "Circuit de Catalunya" from quietly becoming a second, disconnected
    // entry for what's already known as "Barcelone" (own plan/horaires/
    // history lost). #ev-circuit-warning (populated live, see
    // attachHandlers) flags an exact-match miss so a near-duplicate name
    // gets noticed before saving, without forcing a rigid dropdown that
    // could never cover an actually-new circuit.
    var knownCircuitsForWarning = allCircuits();
    var circuitMismatch = !!(ev.circuit && knownCircuitsForWarning.indexOf(ev.circuit) === -1);
    html += '<div><label for="ev-circuit">Circuit</label>' +
      '<input type="text" id="ev-circuit" list="circuit-options-ev" placeholder="Ex. Jerez" value="' + escapeHtml(ev.circuit || '') + '" required>' +
      '<datalist id="circuit-options-ev">' + circuitDatalist() + '</datalist>' +
      '<div class="field-warning' + (circuitMismatch ? ' visible' : '') + '" id="ev-circuit-warning">Nouveau circuit -- vérifie qu\'il n\'existe pas déjà sous un autre nom dans la liste (sinon son plan/historique resteront séparés).</div></div>';
    html += '<div><label for="ev-date-start">Date de début</label><input type="text" id="ev-date-start" inputmode="numeric" placeholder="JJ/MM/AAAA" value="' + isoToFrDate(ev.dateStart) + '" required></div>';
    html += '<div><label for="ev-date-end">Date de fin (optionnel)</label><input type="text" id="ev-date-end" inputmode="numeric" placeholder="JJ/MM/AAAA" value="' + isoToFrDate(ev.dateEnd) + '"></div>';
    html += '</div>';
    // A Team Event is "owned" by whichever Team leads it -- only teams
    // this account actually leads are offered, per "un event doit être
    // détenu par un Team Leader" -- left as "Aucun" this stays a plain
    // personal sortie (unrestricted, exactly like before Team Events
    // existed, which is what keeps backfilling old history unaffected).
    var ledTeamsForEvent = (STATE.myTeamMemberships || []).filter(function (m) { return m.role === 'leader'; })
      .map(function (m) { return teamById(m.teamId); }).filter(Boolean);
    if (ledTeamsForEvent.length) {
      html += '<div style="margin-top:0.9rem;"><label for="ev-team">Team organisateur (optionnel)</label>' +
        '<select id="ev-team"><option value="">Aucun (événement personnel)</option>' +
        ledTeamsForEvent.map(function (t) {
          return '<option value="' + t.id + '"' + (ev.teamId === t.id ? ' selected' : '') + '>' + escapeHtml(t.name) + (t.teamPro ? ' (PRO)' : '') + '</option>';
        }).join('') + '</select></div>';
      var selectedTeam = ev.teamId ? teamById(ev.teamId) : null;
      html += '<div id="ev-visibility-wrap" style="margin-top:0.9rem; display:' + (selectedTeam && selectedTeam.teamPro ? 'block' : 'none') + ';">' +
        '<label for="ev-visibility">Visibilité</label>' +
        '<select id="ev-visibility">' +
        '<option value="membre"' + (ev.eventVisibility === 'membre' ? ' selected' : '') + '>Membre only</option>' +
        '<option value="adherent"' + (ev.eventVisibility === 'adherent' ? ' selected' : '') + '>Adhérent only</option>' +
        '<option value="follower"' + (ev.eventVisibility === 'follower' ? ' selected' : '') + '>Followers only</option>' +
        '<option value="public"' + (ev.eventVisibility === 'public' ? ' selected' : '') + '>Public (visible par tous, invitation requise)</option>' +
        '<option value="ouvert"' + (ev.eventVisibility === 'ouvert' ? ' selected' : '') + '>Ouvert (inscription libre)</option>' +
        '</select>' +
        '<div class="help-text">Réservé aux Teams PRO -- un Team amateur reste visible par ses membres et les pilotes invités.</div>' +
        '<label for="ev-booking-url" style="margin-top:0.7rem;">Lien de réservation (optionnel)</label>' +
        '<input type="url" id="ev-booking-url" placeholder="Ex. https://www.billetweb.fr/..." value="' + escapeHtml(ev.bookingUrl || '') + '">' +
        '<div class="help-text">Carnet de Piste ne gère pas les paiements -- ce lien renvoie vers ta billetterie (Billetweb ou autre) pour l\'inscription/le paiement.</div>' +
        '</div>';
    }
    // "Ajout rapide" -- horaires/pilotes/organisateur tucked behind one
    // click for a brand-new personal event (see eventFormMoreOptionsOpen),
    // so a new user backfilling old sorties only faces circuit+date at
    // first. Pure DOM toggle in attachHandlers (no renderRoot()), so
    // whatever's mid-typed in circuit/dates above never gets wiped by
    // opening this panel.
    html += '<button type="button" class="ghost" id="ev-more-options-toggle" style="margin-top:0.9rem;">' +
      (eventFormMoreOptionsOpen ? '− Moins d\'options' : '+ Plus d\'options (horaires, pilotes, organisateur...)') + '</button>';
    html += '<div id="ev-more-options" style="display:' + (eventFormMoreOptionsOpen ? 'block' : 'none') + ';">';
    // Per-event override, stored on the event itself (ev.horairesOverride),
    // NOT on the circuit's shared "horaires habituels" (admin-only, see
    // renderCircuitInfoEditForm) -- this form is only ever reachable by
    // whoever can already edit this event (admin, or that Team's Leader,
    // see edit-event-btn/team-event-edit gating), so no isAdmin() check
    // needed here, and it's a plain events-collection write like the rest
    // of this form, never touching the admin-gated circuits collection.
    // Falls back to the circuit's own habitual horaires when blank (see
    // the renderHoraireGroups call sites), so this is purely an
    // exception for a specific sortie's unusual schedule.
    var evHorairesVal = ev.horairesOverride || {};
    html += '<div style="margin-top:0.9rem;"><label>Horaires par groupe (cette sortie -- laisser vide pour utiliser les horaires habituels du circuit)</label><div class="horaires-grid">';
    HORAIRES_GROUPS.forEach(function (g) {
      if (g.key === 'groupR' && ev.circuit !== 'Mugello' && !evHorairesVal.groupR) return;
      html += '<div><label for="ev-horaires-' + g.key + '" class="horaires-sublabel">' + escapeHtml(g.label) + '</label>' +
        '<input type="text" id="ev-horaires-' + g.key + '" placeholder="Ex. 9h, 10h40, 14h, 15h20, 16h40" value="' + escapeHtml(evHorairesVal[g.key] || '') + '"></div>';
    });
    html += '</div></div>';
    // Pilotes/groupes for a Team event now live entirely in the Team's own
    // "Gestion des événements" (search-to-add, chronos vérifiés as
    // reference for group moves) -- this form only still carries the
    // riders field for a personal (non-Team) event, which has no Team
    // Leader to manage a roster from anywhere else.
    if (!ev.teamId) {
      // A personal sortie's actual organizer is often a real Team PRO that
      // just isn't on the app (per the brief: a new rider logging past
      // events should never be blocked on "their club must exist here
      // first") -- free text, purely descriptive, no link to any real
      // Team doc.
      html += '<div style="margin-top:0.9rem;"><label for="ev-organizer-note">Organisateur (si absent de l\'app)</label>' +
        '<input type="text" id="ev-organizer-note" placeholder="Ex. Circuit Paul Ricard, club non inscrit..." value="' + escapeHtml(ev.organizerNote || '') + '"></div>';
      // Search-and-add instead of a comma-typed list -- pick a name from
      // the datalist (friends + teammates, see riderDatalistForEventForm)
      // and it becomes a removable chip; #ev-riders stays a hidden field
      // holding the same comma-joined value it always did, so
      // onEventSubmit/refreshEventFormGroups need no changes at all.
      if (eventFormRidersDraftFor !== editingEventId) {
        eventFormRidersDraft = (ev.riders || []).slice();
        eventFormRidersDraftFor = editingEventId;
      }
      html += '<label for="ev-riders-search" style="margin-top:0.9rem; display:block;">Pilotes</label>' +
        '<input type="text" id="ev-riders-search" list="rider-options-ev" placeholder="Rechercher un nom..." autocomplete="off">' +
        '<div class="help-text">Suggestions limitées à tes amis et aux membres de tes Teams -- choisis un nom dans la liste pour l\'ajouter.</div>' +
        '<datalist id="rider-options-ev">' + riderDatalistForEventForm(eventFormRidersDraft) + '</datalist>';
      html += '<div class="chip-row" style="margin-top:0.5rem;">' + eventFormRidersDraft.map(function (r) {
        return '<span class="team-link-chip" style="display:inline-flex; align-items:center; gap:0.4rem;">' + escapeHtml(r) +
          '<button type="button" class="ghost icon-btn" data-action="ev-rider-remove" data-name="' + escapeHtml(r) + '" aria-label="Retirer" style="padding:0;">×</button></span>';
      }).join('') + '</div>';
      html += '<input type="hidden" id="ev-riders" value="' + escapeHtml(eventFormRidersDraft.join(',')) + '">';
      html += '<div class="event-checklist" style="margin-top:0.9rem;"><div class="event-checklist-title">Groupe de départ</div><div id="ev-groups-grid">' +
        renderEventFormGroupsGrid(eventFormRidersDraft) + '</div></div>';
    } else {
      html += '<div class="help-text" style="margin-top:0.9rem;">Participants et groupes se gèrent depuis la Gestion des événements du Team.</div>';
    }
    html += '</div>';
    html += '<div style="margin-top:0.9rem;"><label for="ev-note">Note (optionnel)</label><input type="text" id="ev-note" placeholder="Ex. Inscriptions avant le 1er septembre" value="' + escapeHtml(ev.note || '') + '"></div>';
    html += '<div class="field-error" id="event-form-error"></div>';
    html += '<div style="margin-top:0.9rem; display:flex; gap:0.6rem;">' +
      '<button type="submit" class="primary">Enregistrer</button>' +
      '<button type="button" class="ghost" id="cancel-event-btn">Annuler</button>' +
      '</div>';
    html += '</form>';
    // Deleting only lives here now, inside Modifier -- a deliberate two-
    // step (open Modifier, then confirm) instead of a bare × sitting next
    // to Modifier in every list row, which is what got clicked by mistake.
    if (!isNew) {
      var deleteBtn = deleteEventControl(ev);
      if (deleteBtn) html += '<div class="danger-zone" style="margin-top:1rem;">' + deleteBtn + '</div>';
    }
    html += '</div>';
    return html;
  }

  function onEventSubmit(ev) {
    ev.preventDefault();
    var circuit = document.getElementById('ev-circuit').value.trim();
    var dateStartRaw = document.getElementById('ev-date-start').value;
    var dateEndRawInput = document.getElementById('ev-date-end').value;
    var dateStart = frDateToIso(dateStartRaw);
    var ridersEl = document.getElementById('ev-riders');
    var note = document.getElementById('ev-note').value.trim();
    var organizerNoteEl = document.getElementById('ev-organizer-note');
    var organizerNote = organizerNoteEl ? organizerNoteEl.value.trim() : '';
    var errEl = document.getElementById('event-form-error');
    errEl.textContent = '';
    errEl.classList.remove('visible');

    if (dateStartRaw.trim() && !dateStart) {
      errEl.textContent = 'Date de début invalide — format attendu JJ/MM/AAAA.';
      errEl.classList.add('visible');
      return;
    }
    if (dateEndRawInput.trim() && !frDateToIso(dateEndRawInput)) {
      errEl.textContent = 'Date de fin invalide — format attendu JJ/MM/AAAA.';
      errEl.classList.add('visible');
      return;
    }
    if (!circuit || !dateStart) {
      errEl.textContent = 'Le circuit et la date de début sont obligatoires.';
      errEl.classList.add('visible');
      return;
    }
    var dateEndRaw = frDateToIso(dateEndRawInput);
    var dateEnd = dateEndRaw || dateStart;
    if (dateEnd < dateStart) {
      errEl.textContent = 'La date de fin doit être après la date de début.';
      errEl.classList.add('visible');
      return;
    }
    var teamEl = document.getElementById('ev-team');
    var teamId = teamEl && teamEl.value ? teamEl.value : null;
    var visibilityEl = document.getElementById('ev-visibility');
    var eventVisibility = teamId && visibilityEl ? visibilityEl.value : null;
    var bookingUrlEl = document.getElementById('ev-booking-url');
    var bookingUrl = teamId && bookingUrlEl ? bookingUrlEl.value.trim() : '';
    // The live STATE.events entry being edited, or null for a new one --
    // used both to read forward what a Team event's roster/groups already
    // are (see riders/riderGroups below) and, further down, as the actual
    // record to mutate on save.
    var existingEvent = editingEventId !== 'new' ? (STATE.events.filter(function (e) { return e.id === editingEventId; })[0] || null) : null;
    // A Team event's roster is managed entirely from the Team's own
    // "Gestion des événements" (ridersEl doesn't even render for one, see
    // renderEventForm) -- riders/groups here are simply carried forward
    // untouched. A personal (non-Team) event still reads them from the
    // field, same as before Team events existed.
    // ridersEl only fails to exist when the form was rendered for a Team
    // event (see renderEventForm) -- if the Team was then switched to
    // "Aucun" in this same edit, there's no typed field to read from, so
    // fall back to the event's existing roster rather than wiping it to
    // empty.
    var riders = ridersEl
      ? ridersEl.value.split(',').map(function (r) { return r.trim(); }).filter(Boolean)
      : (existingEvent ? (existingEvent.riders || []) : []);
    var horairesFromForm = {};
    var anyHoraireFromForm = false;
    HORAIRES_GROUPS.forEach(function (g) {
      var el = document.getElementById('ev-horaires-' + g.key);
      var v = el ? el.value.trim() : '';
      if (v) { horairesFromForm[g.key] = v; anyHoraireFromForm = true; }
    });

    // Trim the form's draft down to riders still in the field and dates
    // still within range -- a rider removed from the field, or a date
    // dropped by shortening the range, shouldn't leave orphaned group data
    // behind in the saved sortie. Existing per-day/période assignments
    // (fine-tuned in Team's group management) are carried forward, not reset.
    var riderGroups = teamId
      ? (existingEvent ? existingEvent.riderGroups : null)
      : draftRiderGroupsFor(riders, dateStart, dateEnd, existingEvent && existingEvent.riderGroups);

    var prevState = JSON.parse(JSON.stringify(STATE));
    eventsList();
    if (editingEventId === 'new') {
      var newEvent = { id: genId(), circuit: circuit, dateStart: dateStart, dateEnd: dateEnd, riders: riders, note: note };
      if (teamId) newEvent.teamId = teamId;
      else if (organizerNote) newEvent.organizerNote = organizerNote;
      if (eventVisibility) newEvent.eventVisibility = eventVisibility;
      if (bookingUrl) newEvent.bookingUrl = bookingUrl;
      if (riderGroups) newEvent.riderGroups = riderGroups;
      if (anyHoraireFromForm) newEvent.horairesOverride = horairesFromForm;
      STATE.events.push(newEvent);
      selectedEventId = newEvent.id;
    } else {
      var existing = existingEvent;
      if (existing) {
        existing.circuit = circuit;
        existing.dateStart = dateStart;
        existing.dateEnd = dateEnd;
        existing.riders = riders;
        existing.note = note;
        existing.teamId = teamId || null;
        existing.organizerNote = (!teamId && organizerNote) ? organizerNote : null;
        existing.eventVisibility = eventVisibility || null;
        existing.bookingUrl = bookingUrl || null;
        existing.autoCreated = false; // a manual edit means it's no longer just a byproduct of a chrono
        // checklist isn't touched here -- it's checked off in Planning, not the sortie form.
        existing.riderGroups = riderGroups || null; // never `undefined` -- Firestore rejects that as a field value
        existing.horairesOverride = anyHoraireFromForm ? horairesFromForm : null;
        selectedEventId = existing.id;
      }
    }
    selectedCircuit = circuit;
    calendarAnchor = dateStart;
    editingEventId = null;
    prefillEventCircuit = null;
    prefillEventTeamId = null;
    pendingDeleteEvent = null;
    renderRoot();
    persist(prevState);
  }

  function toggleEventChecklist(eventId, key, value) {
    var prevState = JSON.parse(JSON.stringify(STATE));
    var ev = eventsList().filter(function (e) { return e.id === eventId; })[0];
    if (!ev) return;
    ev.checklist = ev.checklist || {};
    ev.checklist[key] = value;
    renderRoot();
    persist(prevState);
  }

  function removeEvent(id) {
    var prevState = JSON.parse(JSON.stringify(STATE));
    STATE.events = eventsList().filter(function (e) { return e.id !== id; });
    if (selectedEventId === id) selectedEventId = null;
    if (editingEventId === id) editingEventId = null;
    renderRoot();
    persist(prevState);
  }

  // ---- Calendrier : pincer/molette pour zoomer, glisser/flèches pour naviguer ----
  //
  // Registered once on `document` (not re-attached per render) so a gesture
  // survives the renderRoot() that happens mid-gesture when the view
  // actually changes — attaching to `.calendar-grid-card` itself would
  // lose the in-flight pointermove/pointerup once that element gets
  // replaced. Each handler scopes itself with closest('.calendar-grid-card').
  var calendarPinchPointers = new Map();
  var calendarPinchStartDist = null;
  var calendarSwipeStart = null; // {x, y} — only set while exactly one touch/pen pointer is down

  function onCalendarPointerDown(e) {
    if (!e.target.closest || !e.target.closest('.calendar-grid-card')) return;
    calendarPinchPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (calendarPinchPointers.size === 1 && e.pointerType !== 'mouse') {
      calendarSwipeStart = { x: e.clientX, y: e.clientY };
    } else {
      // A second finger landed (pinch) or this is a mouse pointer — not a swipe.
      calendarSwipeStart = null;
    }
    if (calendarPinchPointers.size === 2) {
      var pts = Array.from(calendarPinchPointers.values());
      calendarPinchStartDist = annotDistance(pts[0], pts[1]);
    }
  }

  function onCalendarPointerMove(e) {
    if (!calendarPinchPointers.has(e.pointerId)) return;
    calendarPinchPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (calendarPinchPointers.size === 2 && calendarPinchStartDist != null) {
      e.preventDefault();
      var pts = Array.from(calendarPinchPointers.values());
      var dist = annotDistance(pts[0], pts[1]);
      var ratio = dist / (calendarPinchStartDist || 1);
      if (ratio > 1.3) {
        calendarPinchStartDist = dist;
        if (calendarZoomStep(1)) renderRoot();
      } else if (ratio < 1 / 1.3) {
        calendarPinchStartDist = dist;
        if (calendarZoomStep(-1)) renderRoot();
      }
    }
  }

  // One-finger horizontal swipe on the calendar grid moves to the
  // previous/next period (same as the ‹ › buttons or the ← → keys) —
  // swipe left reveals what's next, swipe right goes back, matching how a
  // native calendar app (or a book page) responds to a horizontal drag.
  var CALENDAR_SWIPE_THRESHOLD = 50;

  function onCalendarPointerUp(e) {
    if (calendarSwipeStart && calendarPinchPointers.size === 1 && calendarPinchPointers.has(e.pointerId)) {
      var dx = e.clientX - calendarSwipeStart.x;
      var dy = e.clientY - calendarSwipeStart.y;
      if (Math.abs(dx) > CALENDAR_SWIPE_THRESHOLD && Math.abs(dx) > Math.abs(dy) * 1.5) {
        calendarNavStep(dx < 0 ? 1 : -1);
        renderRoot();
      }
    }
    calendarPinchPointers.delete(e.pointerId);
    if (calendarPinchPointers.size < 2) calendarPinchStartDist = null;
    if (calendarPinchPointers.size === 0) calendarSwipeStart = null;
  }

  // Trackpad pinch-to-zoom is delivered by the browser as a wheel event with
  // ctrlKey set — that's the only wheel interaction we hijack, so a normal
  // two-finger scroll over the calendar still scrolls the page as expected.
  function onCalendarWheel(e) {
    if (!e.ctrlKey) return;
    if (!e.target.closest || !e.target.closest('.calendar-grid-card')) return;
    e.preventDefault();
    if (calendarZoomStep(e.deltaY < 0 ? 1 : -1)) renderRoot();
  }

  // ← → move to the previous/next period whenever the Événements tab (which
  // now includes the Calendrier section) is showing, unless the user is
  // typing somewhere (a form field, a name…).
  function onCalendarKeydown(e) {
    if (activeView !== 'event') return;
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    var tag = (document.activeElement && document.activeElement.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    e.preventDefault();
    calendarNavStep(e.key === 'ArrowLeft' ? -1 : 1);
    renderRoot();
  }

  // ---- Thème clair / sombre ----
  //
  // Per-browser preference (like the UI state above), not shared via
  // Firestore -- each rider picks their own. "system" (no localStorage
  // entry) leaves data-theme unset so the CSS's own
  // prefers-color-scheme media query keeps deciding, matching the
  // pre-toggle behavior exactly.
  var THEME_KEY = 'carnet-de-piste-theme';

  function getThemePref() {
    try {
      var t = localStorage.getItem(THEME_KEY);
      return (t === 'light' || t === 'dark') ? t : 'system';
    } catch (e) { return 'system'; }
  }

  function applyTheme(pref) {
    if (pref === 'light' || pref === 'dark') {
      document.documentElement.dataset.theme = pref;
    } else {
      delete document.documentElement.dataset.theme;
    }
  }

  function setThemePref(pref) {
    try { localStorage.setItem(THEME_KEY, pref); } catch (e) {}
    applyTheme(pref);
    renderRoot();
  }

  function renderThemeToggle() {
    var pref = getThemePref();
    function btn(value, label, icon) {
      return '<button type="button" class="theme-toggle-btn' + (pref === value ? ' active' : '') + '" data-theme-choice="' + value + '" aria-label="Thème ' + label + '" title="Thème ' + label + '">' + icon + '</button>';
    }
    return '<div class="theme-toggle" role="group" aria-label="Choix du thème">' +
      btn('light', 'clair', '☀️') +
      btn('dark', 'sombre', '🌙') +
      btn('system', 'système', '🖥️') +
      '</div>';
  }

  // A render bug used to mean a silent blank page -- an exception thrown
  // while building `body` fires before root.innerHTML is ever assigned, so
  // whatever was there before (nothing, on a fresh load) just stays.
  // Catching it here turns that into a visible, copy-pasteable error
  // instead, so a rider hitting a bug can report exactly what broke.
  function roleLabel(role) {
    if (role === 'accompagnant') return 'Accompagnant';
    if (role === 'organisateur') return 'Organisateur';
    return 'Pilote';
  }

  // The admin account defaults to certified without ever having toggled
  // it (there'd be no way to, before self-badges existed) -- but once
  // they explicitly turn it off from Mon profil, that's respected rather
  // than always winning. Everyone else is certified only once the admin
  // flips it on for them (see renderAccountManagerPanel), or the admin
  // does it for their own account the same way (see renderSelfBadges).
  function isCertified(u) {
    if (!u) return false;
    if (u.certified === false) return false;
    return !!(u.certified || u.email === ADMIN_EMAIL);
  }

  // Distinct from certified: certified means "this is really this person"
  // (identity verification), personality means "a public figure worth
  // suggesting to follow" (a pro rider, a mechanic, a consultant...) --
  // orthogonal badges, a personality isn't necessarily certified and vice
  // versa. pro marks an official professional rider (MotoGP, FSBK...),
  // separate from both.
  function isPersonality(u) {
    return !!(u && u.personality);
  }
  function isPro(u) {
    return !!(u && u.pro);
  }
  // Trust badge for an organisateur the admin has actually vetted --
  // distinct from the 'organisateur' role itself (anyone can pick that at
  // signup, same as 'pilote'/'accompagnant'); this is the "Team PRO of
  // people" equivalent, admin-granted like certified/personality/pro.
  function isOrganizerBadge(u) {
    return !!(u && u.organizer);
  }
  // Admin-vetted coach -- see renderCoachTab and coachRequests. Any role
  // (pilote, accompagnant, organisateur) can carry it; it's a trust badge
  // like the others, not a signup role of its own.
  function isCoachBadge(u) {
    return !!(u && u.coach);
  }
  // Same trust-badge shape as Coach, but granted by a Team PRO's Team
  // Leader rather than the admin (see renderTeamProBadgeGrantSection) --
  // an official photographer covering the Team's events. coachTeamId/
  // photographerTeamId (set alongside) name which Team PRO vouches for
  // it, checked server-side by firestore.rules on every grant/revoke.
  function isPhotographerBadge(u) {
    return !!(u && u.photographer);
  }

  // Every badge a profile can carry -- one place to add a future one
  // (field, icon, label, and the CSS class it renders with), read by both
  // badgesHtml() (anywhere a name shows up) and the admin's own
  // self-badges toggle in Mon profil.
  // desc is the fuller, tap-friendly explanation (see data-badge-info
  // below) -- label stays the short one already used elsewhere (admin's
  // self-badges checkboxes).
  var PROFILE_BADGES = [
    { field: 'certified', icon: '✓', label: 'Certifié', desc: 'Certifié — compte vérifié par l\'administrateur.', cssClass: 'certified-badge', check: isCertified },
    { field: 'personality', icon: '★', label: 'Personnalité', desc: 'Personnalité — pilote mis en avant par l\'administrateur.', cssClass: 'personality-badge', check: isPersonality },
    { field: 'pro', icon: '🏅', label: 'Pilote PRO', desc: 'Pilote PRO — statut de pilote professionnel.', cssClass: 'pro-badge', check: isPro },
    { field: 'organizer', icon: '👤', label: 'Organisateur vérifié', desc: 'Organisateur vérifié par l\'administrateur.', cssClass: 'organizer-badge', check: isOrganizerBadge },
    { field: 'coach', icon: '🎓', label: 'Coach', desc: 'Coach — reconnu par l\'administrateur ou le Team Leader d\'un Team PRO pour donner du coaching.', cssClass: 'coach-badge', check: isCoachBadge },
    { field: 'photographer', icon: '📷', label: 'Photographe officiel', desc: 'Photographe officiel — reconnu par l\'administrateur ou le Team Leader d\'un Team PRO.', cssClass: 'photographer-badge', check: isPhotographerBadge }
  ];

  // Badges are icon-only, so their meaning normally only shows on hover
  // (title=...) -- useless on mobile, no cursor to hover with. Every badge
  // also carries data-badge-info with the same text: tapping it shows a
  // toast (see the delegated click handler in attachHandlers), which works
  // identically on touch and desktop.
  function badgesHtml(u) {
    return PROFILE_BADGES.map(function (b) {
      return b.check(u) ? ' <span class="' + b.cssClass + '" title="' + escapeHtml(b.desc) + '" data-badge-info="' + escapeHtml(b.desc) + '">' + b.icon + '</span>' : '';
    }).join('');
  }

  // A Team's own badge, distinct from a person's (PROFILE_BADGES) --
  // "Team PRO" marks an organisateur's official squad, set by the admin
  // only (see toggle-team-pro in attachHandlers), to stand apart from an
  // amateur "Team entre amis".
  function teamBadgesHtml(team) {
    return team && team.teamPro ? ' <span class="team-pro-badge" title="Team PRO certifié par l\'administrateur." data-badge-info="Team PRO certifié par l\'administrateur.">✓</span>' : '';
  }

  // Which friend's fiche (see renderFriendFiche) is expanded inline in the
  // "Mes amis" list -- one at a time, pure UI state.
  var expandedFriend = null;
  var pendingRemoveFriendId = null; // friendRequests doc id awaiting a second click to confirm removal (see renderFriendFiche)
  var addFriendOpen = false; // whether Social shows the "Ajouter un ami" form, or just its collapsed teaser button

  // A small round avatar (photoURL is already a resized data URL, see
  // savePhoto) with a first-initial placeholder when none is set --
  // shared by friend rows, team member rows, and the wall.
  function avatarHtml(u, name) {
    var initial = escapeHtml((name || '?').trim().charAt(0).toUpperCase() || '?');
    return '<span class="mini-avatar">' + (u && u.photoURL
      ? '<img src="' + escapeHtml(u.photoURL) + '" alt="">'
      : '<span class="mini-avatar-placeholder">' + initial + '</span>') + '</span>';
  }

  function renderFriendRow(name, actionsHtml, expandable) {
    var u = (STATE.usersByName || {})[name] || {};
    var nameHtml = expandable ? nameLinkHtml(name) : personNameHtml(name);
    var html = '<div class="friend-row">' +
      '<div class="friend-row-main">' + avatarHtml(u, name) + nameHtml + badgesHtml(u) + '<span class="friend-role-badge">' + roleLabel(u.role) + '</span></div>' +
      '<div class="friend-row-actions">' + actionsHtml + '</div>' +
      '</div>';
    if (expandable && expandedFriend === name) html += renderFriendFiche(name);
    return html;
  }

  // What a friend's card shows once opened -- gated by the two sharing
  // toggles they set themselves in Réglages (shareSorties/shareTrophees,
  // both on by default). This is a display-level courtesy, not a real
  // access boundary: sessions/events/users are all already readable by any
  // signed-in account under firestore.rules, same as before Social existed.
  function renderFriendFiche(name) {
    var u = (STATE.usersByName || {})[name] || {};
    var isPilote = !u.role || u.role === 'pilote';
    var shareSorties = u.shareSorties !== false;
    var shareTrophees = u.shareTrophees !== false;
    var html = '<div class="friend-fiche">';
    if (isPilote) {
      if (shareSorties) {
        var stats = riderStats(name);
        html += infoRow('Événements', String(stats.outingsCount));
        html += infoRow('Circuits visités', String(stats.circuitsVisited));
        html += infoRow('Jours sur piste', String(stats.trackDays));
        if (stats.lastSession) {
          html += infoRow('Dernier événement', escapeHtml(stats.lastSession.circuit) + ' — ' + escapeHtml(formatDate(stats.lastSession.date)) + ' (' + formatTime(stats.lastSession.time) + ')');
        }
        // Carnet de Piste reste déclaratif -- ce lien renvoie vers l'appli
        // de chrono officielle du pilote (Superlaps ou autre) s'il en a
        // renseigné une dans son profil, jamais une mesure faite ici.
        if (u.chronoLink) html += '<div style="margin:0.5rem 0;"><button type="button" class="ghost" data-action="open-external-url" data-url="' + escapeHtml(u.chronoLink) + '">Voir ses chronos officiels ↗</button></div>';
        var verifiedSessions = STATE.sessions.filter(function (s) { return s.rider === name && s.certifiedBy; })
          .sort(function (a, b) { return a.date < b.date ? 1 : a.date > b.date ? -1 : 0; });
        if (verifiedSessions.length) {
          var verifiedRows = verifiedSessions.map(function (s) {
            return infoRow(escapeHtml(s.circuit) + ' — ' + escapeHtml(formatDate(s.date)), formatTime(sessionBest(s)) + ' ' + certifyControl(s));
          }).join('');
          html += collapsibleSection('fiche-verified-' + name, 'Chronos vérifiés (' + verifiedSessions.length + ')', verifiedRows);
        }
        var recentSessions = STATE.sessions.filter(function (s) { return s.rider === name; })
          .sort(function (a, b) { return a.date < b.date ? 1 : a.date > b.date ? -1 : 0; }).slice(0, 10);
        if (recentSessions.length) {
          var historyRows = recentSessions.map(function (s) {
            return infoRow(escapeHtml(s.circuit) + ' — ' + escapeHtml(formatDate(s.date)), formatTime(sessionBest(s)));
          }).join('');
          html += collapsibleSection('fiche-history-' + name, 'Historique', historyRows);
        }
      } else {
        html += '<div class="help-text">' + escapeHtml(name) + ' n\'a pas choisi de partager ses événements/chronos.</div>';
      }
      if (shareTrophees) {
        html += renderAchievementsCard(riderAchievements(name, riderStats(name)), 'fiche-achievements-' + name);
      } else {
        html += '<div class="help-text">Trophées non partagés.</div>';
      }
    } else {
      if (shareTrophees) {
        var ach = u.role === 'organisateur' ? organisateurAchievements(u) : accompagnantAchievements(u);
        html += renderAchievementsCard(ach, 'fiche-achievements-' + name);
      } else {
        html += '<div class="help-text">Trophées non partagés.</div>';
      }
    }
    // Removing a friend now happens here, on their own fiche, instead of
    // a bare × sitting in the list row -- a second click still required
    // (no password, just a plain "tu es sûr ?" to avoid an accidental
    // tap), same spirit as every other delete confirmation in the app.
    var friendship = currentUserProfile ? friendsOf(currentUserProfile.name).filter(function (f) { return f.name === name; })[0] : null;
    if (friendship) {
      html += '<div class="danger-zone" style="margin-top:0.9rem;">';
      if (pendingRemoveFriendId === friendship.id) {
        html += '<div class="help-text">Retirer ' + escapeHtml(name) + ' de tes amis ?</div>' +
          '<div style="margin-top:0.5rem; display:flex; gap:0.6rem;">' +
          '<button type="button" class="ghost danger" data-action="remove-friend-confirm" data-id="' + friendship.id + '">Confirmer</button>' +
          '<button type="button" class="ghost" data-action="remove-friend-cancel">Annuler</button></div>';
      } else {
        html += '<button type="button" class="ghost danger" data-action="remove-friend-request" data-id="' + friendship.id + '">Retirer cet ami</button>';
      }
      html += '</div>';
    }
    html += '</div>';
    return html;
  }

  function relativeTime(ms) {
    var diff = Date.now() - ms;
    if (diff < 60000) return 'à l\'instant';
    if (diff < 3600000) return 'il y a ' + Math.floor(diff / 60000) + ' min';
    if (diff < 86400000) return 'il y a ' + Math.floor(diff / 3600000) + ' h';
    return formatDate(dateKey(new Date(ms)));
  }

  // Positive-only, on purpose -- a news feed/team wall isn't the place for
  // a thumbs-down. Shared by Social's Actualités and the Team feed.
  var REACTION_EMOJIS = ['🔥', '👍', '💪', '🎉'];
  function renderReactionBar(reactions, dataAction, id) {
    reactions = reactions || {};
    var counts = {};
    REACTION_EMOJIS.forEach(function (em) { counts[em] = 0; });
    var mine = currentUserProfile ? reactions[currentUserProfile.name] : null;
    Object.keys(reactions).forEach(function (n) { var em = reactions[n]; if (counts[em] != null) counts[em]++; });
    return '<div class="reaction-bar">' + REACTION_EMOJIS.map(function (em) {
      return '<button type="button" class="reaction-btn' + (mine === em ? ' active' : '') + '" data-action="' + dataAction + '" data-id="' + id + '" data-emoji="' + em + '">' +
        em + (counts[em] ? ' ' + counts[em] : '') + '</button>';
    }).join('') + '</div>';
  }

  function renderFeedEntry(e) {
    var text;
    if (e.type === 'friend') {
      text = escapeHtml(e.actor) + ' et ' + escapeHtml(e.target) + ' sont maintenant amis 🤝';
    } else if (e.type === 'record') {
      text = escapeHtml(e.actor) + ' a battu son record sur ' + escapeHtml(e.circuit) + ' : ' + formatTime(e.time) + ' 🏁';
    } else {
      return '';
    }
    return '<div class="feed-entry"><div class="feed-entry-row"><span class="feed-entry-text">' + text + '</span>' +
      '<span class="feed-entry-time">' + escapeHtml(relativeTime(e.createdAt)) + '</span></div>' +
      renderReactionBar(e.reactions, 'react-feed-event', e.id) + '</div>';
  }

  // friendSuggestions() feeds both "Tes amis" (renderSocialTab) and the
  // quick-add chip row inside it -- a few candidates worth nudging, not
  // the exhaustive picker (that's the "Ajouter un ami" select).
  // "Mode profil" -- a small avatar/name/role card per suggestion instead
  // of a bare text chip, scrolling left-to-right in one row so several
  // fit without stacking vertically.
  function friendSuggestionChips(candidates) {
    var suggestions = candidates.slice(0, 8);
    if (!suggestions.length) return '';
    return '<div class="social-suggestions-label" style="margin-top:0.8rem;">Suggestions</div>' +
      '<div class="suggestion-profile-row">' + suggestions.map(function (n) {
        var u = (STATE.usersByName || {})[n] || {};
        return '<div class="suggestion-profile-card">' + avatarHtml(u, n) +
          '<span class="suggestion-profile-name">' + escapeHtml(n) + '</span>' +
          '<span class="friend-role-badge">' + roleLabel(u.role) + '</span>' +
          '<button type="button" class="ghost icon-btn" data-action="quick-add-friend" data-name="' + escapeHtml(n) + '" aria-label="Ajouter" title="Ajouter">+</button>' +
          '</div>';
      }).join('') + '</div>';
  }

  // Sub-rubrique of Connexions (see renderSocialTab), same shape as "Mes
  // amis" -- followed personalities plus a nudge toward ones not yet
  // followed, rather than only showing up once you follow someone.
  function renderPersonalitiesSection(me) {
    var followed = (STATE.myFollows || []).slice().sort(function (a, b) { return a.localeCompare(b); });
    var suggestions = allKnownUserNames().filter(function (n) {
      return n !== me.name && isPersonality(STATE.usersByName[n]) && followed.indexOf(n) === -1;
    }).slice(0, 5);
    var body = !followed.length
      ? '<div class="empty-state">Tu ne suis encore aucune personnalité.</div>'
      : followed.map(function (n) {
        return renderFriendRow(n, '<button type="button" class="ghost icon-btn" data-action="unfollow" data-name="' + escapeHtml(n) + '" aria-label="Ne plus suivre" title="Ne plus suivre">×</button>');
      }).join('');
    if (suggestions.length) {
      body += '<div class="social-suggestions-row"><span class="social-suggestions-label">À suivre</span>' +
        suggestions.map(function (n) {
          return '<span class="suggestion-chip">' + escapeHtml(n) + ' <button type="button" class="ghost icon-btn" data-action="quick-follow" data-name="' + escapeHtml(n) + '" aria-label="Suivre" title="Suivre">★</button></span>';
        }).join('') + '</div>';
    }
    return collapsibleSection('social-personnalites', 'Suivi des personnalités (' + followed.length + ')', body, false);
  }

  // ---- Mur (wall) ----
  //
  // A post picks its own audience (amis / followers / les deux) --
  // filtered client-side from one capped, most-recent-first sync of every
  // wallPost (same "readable by any signed-in account, audience is a
  // display-layer choice" pattern as everything else in Social/Team; a
  // truly server-enforced audience would need friendRequests/follows to
  // use deterministic doc ids the way teamMembers does, which they don't).
  var wallPostMessage = '';
  var wallPostDraftPhotoURL = null;
  // Only one team's photo picker is ever in use at a time -- paired with
  // the team id it's for, same as wallPostDraftPhotoURL but scoped.
  var teamPostDraftPhotoTeamId = null;
  var teamPostDraftPhotoURL = null;
  // Which composer, if any, is open on the Fil d'actualité -- null shows
  // just the two "Écrire un message"/"Sondage" buttons instead of every
  // field always expanded. One at a time, per the single teamPostDraft*
  // vars above already being un-scoped-per-team (same convention).
  var teamComposerMode = null; // null | 'message' | 'poll'
  // The poll draft's question + option values, read fresh off the form
  // right before "+ Ajouter une option" re-renders it -- otherwise
  // growing the options list would blow away whatever was already typed
  // (renderRoot() rebuilds the whole form from scratch every time).
  var pollDraftQuestion = '';
  var pollDraftOptions = ['', ''];
  // Which Team's own profile photo (Réglages) is currently being replaced
  // -- unlike teamPostDraftPhotoURL above, this uploads straight to the
  // team doc on selection (see saveTeamPhoto), no preview/draft step.
  var teamPhotoUploadTeamId = null;

  function visibleWallPosts(me) {
    var friendNames = friendsOf(me.name).map(function (f) { return f.name; });
    var followedNames = STATE.myFollows || [];
    return (STATE.wallPosts || []).filter(function (p) {
      if (p.author === me.name) return true;
      if (friendNames.indexOf(p.author) !== -1 && (p.audience === 'friends' || p.audience === 'all')) return true;
      if (followedNames.indexOf(p.author) !== -1 && (p.audience === 'followers' || p.audience === 'all')) return true;
      return false;
    });
  }

  var wallComposerOpen = false; // whether the "Publier un message" form is expanded, or just its collapsed teaser button
  var wallFeedVisibleCount = 5; // how many of Mon Journal's items are rendered -- +5 each time the scroll sentinel is reached (see attachHandlers)

  function renderWallComposer() {
    if (!wallComposerOpen) {
      return '<button type="button" class="primary add-chrono-btn" id="wall-composer-toggle" style="margin-top:1rem;">Publier un message sur mon Journal</button>';
    }
    var html = '<div class="card" style="margin-top:1rem;"><h2 class="section-title">Publier un message sur mon Journal</h2>';
    html += '<div class="help-text">Ce que tu publies sera visible par tes amis (ou followers, selon ce que tu choisis ci-dessous).</div>';
    html += '<form id="wall-post-form">';
    html += '<label for="wall-post-text">Un mot, un événement, une photo...</label><textarea id="wall-post-text" rows="2"></textarea>';
    html += '<label for="wall-post-link" style="margin-top:0.6rem;">Lien (optionnel)</label><input type="url" id="wall-post-link" placeholder="https://...">';
    html += '<div style="margin-top:0.6rem;">';
    if (wallPostDraftPhotoURL) {
      html += '<img class="wall-post-photo-preview" src="' + escapeHtml(wallPostDraftPhotoURL) + '" alt="">' +
        '<button type="button" class="ghost" id="wall-post-photo-remove-btn">Retirer la photo</button>';
    } else {
      html += '<button type="button" class="ghost" id="wall-post-photo-btn">📷 Ajouter une photo</button>';
    }
    html += '<input type="file" id="wall-post-photo-input" accept="image/*" style="display:none;">';
    html += '</div>';
    html += '<label for="wall-post-audience" style="margin-top:0.6rem;">Visible par</label>' +
      '<select id="wall-post-audience">' +
      '<option value="friends">Mes amis</option>' +
      '<option value="followers">Mes followers</option>' +
      '<option value="all">Amis + followers</option>' +
      '</select>';
    html += '<button type="submit" class="primary" style="margin-top:0.7rem;">Publier</button>';
    if (wallPostMessage) html += '<div class="help-text" style="margin-top:0.6rem;">' + escapeHtml(wallPostMessage) + '</div>';
    html += '</form></div>';
    return html;
  }

  var editingWallPostId = null; // id of the one wallPost currently shown as an inline edit form, or null -- same pattern as editingTeamPostId
  function renderWallPost(p) {
    var u = (STATE.usersByName || {})[p.author] || {};
    var audienceLabel = p.audience === 'followers' ? 'Followers' : (p.audience === 'all' ? 'Amis + followers' : 'Amis');
    var canEdit = !!(currentUserProfile && p.author === currentUserProfile.name);
    if (canEdit && editingWallPostId === p.id) {
      return '<div class="wall-post"><form data-action="wall-post-edit-form" data-id="' + p.id + '">' +
        '<textarea rows="2" placeholder="Un mot, un événement, une photo..." data-wall-post-edit-text>' + escapeHtml(p.text || '') + '</textarea>' +
        '<input type="url" value="' + escapeHtml(p.linkUrl || '') + '" placeholder="Lien (optionnel)" data-wall-post-edit-link>' +
        '<div style="display:flex; gap:0.5rem; margin-top:0.4rem;"><button type="submit" class="primary">Enregistrer</button>' +
        '<button type="button" class="ghost" data-action="wall-post-edit-cancel">Annuler</button></div></form></div>';
    }
    var html = '<div class="wall-post">';
    html += '<div class="wall-post-head">' + avatarHtml(u, p.author) +
      personNameHtml(p.author) + badgesHtml(u) +
      '<span class="friend-role-badge">' + escapeHtml(audienceLabel) + '</span>' +
      '<span class="feed-entry-time">' + escapeHtml(relativeTime(p.editedAt || p.createdAt)) + (p.editedAt ? ' (modifié)' : '') + '</span></div>';
    if (p.text) html += '<div class="wall-post-text">' + escapeHtml(p.text) + '</div>';
    if (p.linkUrl) html += '<a class="wall-post-link" href="' + escapeHtml(p.linkUrl) + '" target="_blank" rel="noopener">🔗 ' + escapeHtml(p.linkUrl) + '</a>';
    if (p.photoURL) html += '<img class="wall-post-photo" src="' + escapeHtml(p.photoURL) + '" alt="">';
    if (canEdit) {
      html += '<button type="button" class="ghost icon-btn" data-action="wall-post-edit" data-id="' + p.id + '" aria-label="Modifier" title="Modifier">✎</button>' +
        '<button type="button" class="ghost icon-btn" data-action="delete-wall-post" data-id="' + p.id + '" aria-label="Supprimer" title="Supprimer">×</button>';
    }
    // Same reaction bar as teamFeed -- was missing entirely here, so
    // anyone who could see a wallPost (a follower included, not just a
    // friend) had no way to react to it at all.
    html += renderReactionBar(p.reactions, 'react-wall-post', p.id);
    html += '</div>';
    return html;
  }

  // The Mur is one unified, per-account, private-by-default feed -- not
  // just this account's own posts, but everything relevant to it: its own
  // activity and wallPosts, friends'/followed personalities' (gated
  // below -- an account that isn't a friend never shows up here at all,
  // wallPosts' own audience picker on top of that), the team feed of
  // every amateur or PRO team it's actually a member of (STATE.teamFeed),
  // and the public club news of every Team PRO it only follows without
  // being a member (STATE.followedTeamFeed) -- gated by membership tier:
  // an 'adherents'-only club post only shows up here if
  // myFollowedTeamTiers says this account is actually an adherent of that
  // club, not just a follower (adherent > follower, per the brief).
  function renderWallFeed(me) {
    var friendNames = friendsOf(me.name).map(function (f) { return f.name; });
    var items = visibleWallPosts(me).map(function (p) { return { kind: 'wall', data: p, createdAt: p.createdAt }; });
    // Activity log (friend added, personal record) -- only from this
    // account itself or an actual friend, never a stranger's, per "si
    // user n'est pas ami alors il ne voit pas les actualités sur son mur".
    (STATE.feedEvents || []).forEach(function (e) {
      if (e.actor !== me.name && friendNames.indexOf(e.actor) === -1) return;
      items.push({ kind: 'activity', data: e, createdAt: e.createdAt });
    });
    var myTeamIds = (STATE.myTeamMemberships || []).map(function (m) { return m.teamId; });
    (STATE.teamFeed || []).forEach(function (f) {
      items.push({ kind: 'team', data: f, teamId: f.teamId, createdAt: f.createdAt });
    });
    (STATE.followedTeamFeed || []).forEach(function (f) {
      if (myTeamIds.indexOf(f.teamId) !== -1) return; // already covered via STATE.teamFeed above
      var t = teamById(f.teamId);
      if (!t || !t.teamPro) return;
      if (f.audience === 'adherents' && (STATE.myFollowedTeamTiers || {})[f.teamId] !== 'adherent') return;
      items.push({ kind: 'team', data: f, teamId: f.teamId, createdAt: f.createdAt });
    });
    items.sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
    // 5 at a time -- a scroll sentinel (see attachHandlers) loads 5 more
    // once it comes into view, rather than the whole history rendering
    // (and every reaction/edit re-diffing it) up front.
    var visible = items.slice(0, wallFeedVisibleCount);
    var body = !items.length
      ? '<div class="empty-state">' + (coreDataLoading() ? 'Chargement...' : 'Rien pour l\'instant.') + '</div>'
      : visible.map(function (it) {
        if (it.kind === 'wall') return renderWallPost(it.data);
        if (it.kind === 'activity') return renderFeedEntry(it.data);
        var t = teamById(it.teamId);
        return renderTeamFeedEntry(it.data, me, t ? t.name : null);
      }).join('') + (items.length > visible.length ? '<div id="wall-feed-sentinel" class="empty-inline">Chargement...</div>' : '');
    return collapsibleCard('social-mur', 'Mon Journal (' + items.length + ')', body, true);
  }

  function postToWall(text, linkUrl, photoURL, audience) {
    var me = currentUserProfile;
    if (!me) return;
    text = (text || '').trim();
    linkUrl = (linkUrl || '').trim();
    if (!text && !linkUrl && !photoURL) {
      wallPostMessage = 'Ajoute au moins un texte, un lien ou une photo.';
      renderRoot();
      return;
    }
    var post = { id: genId(), author: me.name, authorUid: myUid(), audience: audience, createdAt: Date.now() };
    if (text) post.text = text;
    if (linkUrl) post.linkUrl = linkUrl;
    if (photoURL) post.photoURL = photoURL;
    db.collection('wallPosts').doc(post.id).set(post).then(function () {
      wallPostMessage = '';
      wallPostDraftPhotoURL = null;
      wallComposerOpen = false;
      renderRoot();
    }).catch(function (err) {
      wallPostMessage = 'Erreur : ' + (err && err.message ? err.message : err);
      renderRoot();
    });
  }

  function deleteWallPost(id) {
    db.collection('wallPosts').doc(id).delete().catch(function (err) {
      showToast('Erreur : ' + (err && err.message ? err.message : err));
    });
  }

  function updateWallPost(id, text, linkUrl) {
    text = (text || '').trim();
    linkUrl = (linkUrl || '').trim();
    if (!text && !linkUrl) { showToast('Le message ne peut pas être vide.'); return; }
    db.collection('wallPosts').doc(id).update({ text: text || null, linkUrl: linkUrl || null, editedAt: Date.now() }).then(function () {
      editingWallPostId = null;
      renderRoot();
    }).catch(function (err) {
      showToast('Erreur : ' + (err && err.message ? err.message : err));
    });
  }

  function renderSocialTab() {
    var me = currentUserProfile;
    if (!me) return '';
    var friends = friendsOf(me.name);
    var incoming = incomingFriendRequests(me.name);
    var outgoing = outgoingFriendRequests(me.name);
    var candidates = allKnownUserNames().filter(function (n) {
      return n !== me.name &&
        !friends.some(function (f) { return f.name === n; }) &&
        !incoming.some(function (r) { return r.from === n; }) &&
        !outgoing.some(function (r) { return r.to === n; });
    });

    // Social, reorganized into exactly 3 rubriques: (1) Tes amis -- the
    // friend list itself plus everything about managing it (requests,
    // add, suggestions) folded into one card as sub-sections, so it's a
    // single place instead of four separate cards; (2) suivi des
    // personnalités; (3) le Mur, this account's own private-by-default
    // activity feed (see renderWallFeed).
    // Retirer un ami se fait maintenant depuis sa propre fiche (voir
    // renderFriendFiche), plus un bare × sur la ligne -- chaque ligne
    // n'a donc plus d'action, juste le nom cliquable pour l'ouvrir.
    var friendsBody = !friends.length
      ? '<div class="empty-state">Pas encore d’amis — ajoutes-en un ci-dessous.</div>'
      : friends.map(function (f) { return renderFriendRow(f.name, '', true); }).join('');
    var amisHtml = collapsibleSection('social-amis-liste', 'Mes amis (' + friends.length + ')', friendsBody, true);

    if (incoming.length) {
      var incomingBody = incoming.map(function (r) {
        return renderFriendRow(r.from,
          '<button type="button" class="primary" data-action="accept-friend" data-id="' + r.id + '">Accepter</button>' +
          '<button type="button" class="ghost" data-action="remove-friend" data-id="' + r.id + '">Refuser</button>');
      }).join('');
      amisHtml += collapsibleSection('social-demandes-recues', 'Demandes reçues (' + incoming.length + ')', incomingBody, true);
    }
    if (outgoing.length) {
      var outgoingBody = outgoing.map(function (r) {
        return renderFriendRow(r.to, '<button type="button" class="ghost" data-action="remove-friend" data-id="' + r.id + '">Annuler</button>');
      }).join('');
      amisHtml += collapsibleSection('social-demandes-envoyees', 'Demandes envoyées (' + outgoing.length + ')', outgoingBody);
    }
    // Retracté par défaut, juste un bouton -- le formulaire (avec ses
    // suggestions) n'apparaît qu'une fois cliqué, même logique que
    // "+ Ajouter un chrono" dans Chronos.
    if (!addFriendOpen) {
      amisHtml += '<button type="button" class="primary add-chrono-btn" id="add-friend-toggle" style="margin-top:0.8rem;">+ Ajouter un ami</button>';
    } else {
      // Recherche par pseudo (datalist) plutôt qu'un long menu déroulant --
      // le # (numéro de moto) est affiché à côté de chaque suggestion pour
      // lever le doute entre deux homonymes.
      var addFriendBody = !candidates.length
        ? '<div class="empty-state">Personne d’autre à ajouter pour l’instant.</div>'
        : '<form id="add-friend-form"><label for="add-friend-input">Rechercher par pseudo</label>' +
          '<input type="text" id="add-friend-input" list="add-friend-list" placeholder="Pseudo" autocomplete="off" required>' +
          '<datalist id="add-friend-list">' + candidates.map(function (n) {
            var u = (STATE.usersByName || {})[n] || {};
            var label = n + ' — ' + roleLabel(u.role) + (u.bikeNumber ? ' — #' + u.bikeNumber : '');
            return '<option value="' + escapeHtml(n) + '">' + escapeHtml(label) + '</option>';
          }).join('') + '</datalist>' +
          '<button type="submit" class="primary" style="margin-top:0.7rem;">Envoyer une demande</button></form>' +
          friendSuggestionChips(candidates);
      amisHtml += '<div style="margin-top:0.8rem;">' + addFriendBody + '</div>';
    }
    amisHtml += renderPersonalitiesSection(me);

    var html = collapsibleCard('social-amis', 'Connexions', amisHtml, true);
    html += renderWallFeed(me);
    html += renderWallComposer();
    return html;
  }

  // ---- Team ----
  //
  // A team's roster and feed (see refreshTeamDetailSync) only ever cover
  // the team(s) this account is actually in -- there's no "browse other
  // teams" here, same boundary as Social's friend-only visibility.
  // Member rows (and, for the leader, their management pills) are built
  // by the unified renderTeamMembersSection below -- one list instead of
  // a plain "Membres" and a second, overlapping "Gestion des membres".

  // A poll is just another teamFeed doc (type:'poll', options, votes) --
  // votes is a plain {name: optionIndex} map, updated one dotted field at
  // a time (votes.<myName()>) so firestore.rules can allow that one
  // narrow update (any team member, their own vote only) without opening
  // up the rest of the post to editing.
  function renderTeamPollEntry(f, me, teamName) {
    var votes = f.votes || {};
    var counts = f.options.map(function (_, i) {
      return Object.keys(votes).filter(function (n) { return votes[n] === i; }).length;
    });
    var total = counts.reduce(function (a, b) { return a + b; }, 0);
    var myVote = votes[me.name];
    var html = '<div class="wall-post">';
    html += '<div class="wall-post-head">' + personNameHtml(f.author) +
      (teamName ? '<span class="friend-role-badge">' + escapeHtml(teamName) + '</span>' : '') +
      (f.audience === 'adherents' ? '<span class="friend-role-badge adherent-badge">Adhérents</span>' : '') +
      '<span class="feed-entry-time">' + escapeHtml(relativeTime(f.createdAt)) + '</span></div>';
    html += '<div class="wall-post-text">📊 ' + escapeHtml(f.question) + '</div>';
    html += '<div class="poll-options">' + f.options.map(function (opt, i) {
      var pct = total ? Math.round(counts[i] / total * 100) : 0;
      return '<button type="button" class="poll-option-btn' + (myVote === i ? ' voted' : '') + '" data-action="team-poll-vote" data-id="' + f.id + '" data-option="' + i + '">' +
        '<span class="poll-option-bar" style="width:' + pct + '%"></span>' +
        '<span class="poll-option-label">' + escapeHtml(opt) + (myVote === i ? ' ✓' : '') + '</span>' +
        '<span class="poll-option-pct">' + pct + '% (' + counts[i] + ')</span>' +
        '</button>';
    }).join('') + '</div>';
    html += '</div>';
    return html;
  }

  // teamName is only passed when this entry shows up out of its own Team
  // card (i.e. on the Mur, see renderWallFeed) -- inside the Team card
  // itself the team is already the whole context, so it's omitted there.
  var editingTeamPostId = null; // id of the one Fil d'actualité post currently shown as an inline edit form, or null
  function renderTeamFeedEntry(f, me, teamName) {
    if (f.type === 'poll') return renderTeamPollEntry(f, me, teamName);
    var canEdit = !!(me && f.author === me.name);
    var canDelete = !!(me && (f.author === me.name || isLeaderOfTeam(f.teamId)));
    if (canEdit && editingTeamPostId === f.id) {
      return '<div class="wall-post"><form data-action="team-post-edit-form" data-id="' + f.id + '">' +
        '<input type="text" value="' + escapeHtml(f.text || '') + '" placeholder="Écrire au team..." data-team-post-edit-text>' +
        '<input type="url" value="' + escapeHtml(f.linkUrl || '') + '" placeholder="Lien (optionnel)" data-team-post-edit-link>' +
        '<div style="display:flex; gap:0.5rem; margin-top:0.4rem;"><button type="submit" class="primary">Enregistrer</button>' +
        '<button type="button" class="ghost" data-action="team-post-edit-cancel">Annuler</button></div></form></div>';
    }
    var html = '<div class="wall-post">';
    html += '<div class="wall-post-head">' + personNameHtml(f.author) +
      (teamName ? '<span class="friend-role-badge">' + escapeHtml(teamName) + '</span>' : '') +
      (f.audience === 'adherents' ? '<span class="friend-role-badge adherent-badge">Adhérents</span>' : '') +
      '<span class="feed-entry-time">' + escapeHtml(relativeTime(f.editedAt || f.createdAt)) + (f.editedAt ? ' (modifié)' : '') + '</span>' +
      (canEdit ? '<button type="button" class="ghost icon-btn" data-action="team-post-edit" data-id="' + f.id + '" aria-label="Modifier" title="Modifier">✎</button>' : '') +
      (canDelete ? '<button type="button" class="ghost icon-btn" data-action="team-post-delete" data-id="' + f.id + '" aria-label="Supprimer" title="Supprimer">×</button>' : '') +
      '</div>';
    if (f.text) html += '<div class="wall-post-text">' + escapeHtml(f.text) + '</div>';
    if (f.linkUrl) html += '<a class="wall-post-link" href="' + escapeHtml(f.linkUrl) + '" target="_blank" rel="noopener">🔗 ' + escapeHtml(f.linkUrl) + '</a>';
    if (f.photoURL) html += '<img class="wall-post-photo" src="' + escapeHtml(f.photoURL) + '" alt="">';
    html += renderReactionBar(f.reactions, 'react-team-post', f.id);
    html += '</div>';
    return html;
  }
  function updateTeamFeedPost(id, text, linkUrl) {
    text = (text || '').trim();
    linkUrl = (linkUrl || '').trim();
    if (!text && !linkUrl) { showToast('Le message ne peut pas être vide.'); return; }
    db.collection('teamFeed').doc(id).update({ text: text || null, linkUrl: linkUrl || null, editedAt: Date.now() }).then(function () {
      editingTeamPostId = null;
      renderRoot();
    }).catch(function (err) {
      showToast('Erreur : ' + (err && err.message ? err.message : err));
    });
  }
  function deleteTeamFeedPost(id) {
    db.collection('teamFeed').doc(id).delete().catch(function (err) {
      showToast('Erreur : ' + (err && err.message ? err.message : err));
    });
  }

  // One row renderer shared by the "Membres" and "Followers" sections
  // below -- a plain listing for everyone, and for the Team Leader the
  // same row also carries the four status toggle pills (Suivi / Membre /
  // Adhérent / Team Leader, see setTeamMemberStatus) and a free-form
  // "rôle" field for members. Used to be one merged list showing members
  // and followers together under "Membres" -- split back into two so a
  // plain follower like Geoff (no teamMembers doc yet) isn't counted or
  // shown as a member.
  function renderTeamPersonRow(team, name, memberDoc, followDoc, me, isLeader) {
    function pill(key, label, on) {
      // Granting/revoking Team Leader is the one pill worth a pause for --
      // click-to-arm/click-to-confirm (same pattern as every other
      // destructive action here) instead of a native window.confirm().
      var armed = key === 'leader' && pendingLeaderToggle && pendingLeaderToggle.team === team.id && pendingLeaderToggle.name === name;
      var shownLabel = armed ? 'Confirmer ?' : label;
      return '<button type="button" class="team-status-pill' + (on ? ' active' : '') + (armed ? ' confirm' : '') + '" data-action="team-status-toggle" data-team="' + team.id + '" data-name="' + escapeHtml(name) + '" data-status="' + key + '" data-on="' + (on ? '0' : '1') + '">' + shownLabel + '</button>';
    }
    var u = (STATE.usersByName || {})[name] || {};
    var isAdherent = !!(followDoc && followDoc.tier === 'adherent');
    var accountRoleLabel = u.role === 'accompagnant' ? 'Accompagnant' : (u.role === 'organisateur' ? 'Organisateur' : '');
    var actions = '';
    if (name === me.name && memberDoc) {
      if (!isAdherent) {
        actions += (followDoc && followDoc.adherentRequested)
          ? '<span class="help-text">Demande envoyée</span>'
          : '<button type="button" class="ghost" data-action="team-request-adherent" data-team="' + team.id + '">Devenir adhérent</button>';
      }
      actions += '<button type="button" class="ghost" data-action="team-leave" data-team="' + team.id + '">Quitter</button>';
    }
    var row = '<div style="display:flex; align-items:center; justify-content:space-between; gap:0.6rem;">' +
      '<div class="friend-row-main">' + avatarHtml(u, name) + nameLinkHtml(name) + badgesHtml(u) +
      (accountRoleLabel ? '<span class="account-role-tag">' + accountRoleLabel + '</span>' : '') +
      (memberDoc && memberDoc.teamRole ? '<span class="account-role-tag">' + escapeHtml(memberDoc.teamRole) + '</span>' : '') +
      (isAdherent ? '<span class="friend-role-badge adherent-badge">Adhérent</span>' : '') +
      (memberDoc ? '<span class="friend-role-badge">' + (memberDoc.role === 'leader' ? 'Team Leader' : 'Membre') + '</span>' : '<span class="friend-role-badge">Follower</span>') +
      '</div><div class="friend-row-actions">' + actions + '</div></div>';
    if (isLeader) {
      var isTeamLeaderRole = !!(memberDoc && memberDoc.role === 'leader');
      var pills = pill('follow', 'Suivi', !!followDoc) + pill('member', 'Membre', !!memberDoc) +
        pill('adherent', 'Adhérent', isAdherent) + pill('leader', 'Team Leader', isTeamLeaderRole);
      // Explicit Annuler once the Team Leader pill is armed -- same
      // reasoning as deleteEventControl: otherwise the only way out is
      // to guess that clicking elsewhere resets it.
      if (pendingLeaderToggle && pendingLeaderToggle.team === team.id && pendingLeaderToggle.name === name) {
        pills += '<button type="button" class="ghost" data-action="team-leader-toggle-cancel">Annuler</button>';
      }
      // A pending "je veux être adhérent" request (see
      // requestTeamAdherent) surfaces here rather than in a separate
      // list -- toggling the Adhérent pill above already clears it
      // either way, this just makes sure the leader notices one's waiting.
      var pendingNote = (followDoc && followDoc.adherentRequested && !isAdherent)
        ? '<div class="team-manage-pending">Demande d\'adhésion en attente' +
          ' <button type="button" class="ghost" data-action="team-adherent-accept" data-follow-id="' + followDoc.id + '">Accepter</button>' +
          ' <button type="button" class="ghost" data-action="team-adherent-decline" data-follow-id="' + followDoc.id + '">Refuser</button></div>'
        : '';
      var roleField = memberDoc
        ? '<div class="team-role-field"><input type="text" placeholder="Rôle (mécano, assistant...)" value="' + escapeHtml(memberDoc.teamRole || '') + '" data-team-role-input list="team-role-suggestions">' +
          '<button type="button" class="ghost icon-btn" data-action="team-role-save" data-team="' + team.id + '" data-name="' + escapeHtml(name) + '" aria-label="Enregistrer le rôle" title="Enregistrer">✓</button></div>'
        : '';
      row += '<div class="team-status-pills">' + pills + '</div>' + pendingNote + roleField;
    }
    return '<div class="team-manage-row">' + row + '</div>' + maybeFicheHtml(name);
  }

  function renderTeamMembersSection(team, members, teamFollowers, me, isLeader) {
    var followByName = {};
    teamFollowers.forEach(function (f) { followByName[f.follower] = f; });
    var names = members.map(function (m) { return m.name; }).sort(function (a, b) { return a.localeCompare(b); });
    var body = !names.length
      ? '<div class="help-text">Personne pour l\'instant.</div>'
      : names.map(function (name) {
        var memberDoc = members.filter(function (m) { return m.name === name; })[0];
        return renderTeamPersonRow(team, name, memberDoc, followByName[name] || null, me, isLeader);
      }).join('') + (isLeader ? '<datalist id="team-role-suggestions"><option value="Mécano"><option value="Assistant"><option value="Photographe"><option value="Logistique"></datalist>' : '');
    return collapsibleSection('team-members-' + team.id, 'Membres (' + members.length + ')', body);
  }

  // Follows the Team without (yet) being a member of its roster -- Geoff,
  // say, before a Team Leader accepts his join request as a member. Kept
  // as its own section (per le brief's "distingo entre les membres et
  // les followers") rather than merged into "Membres" like it used to be.
  function renderTeamFollowersSection(team, members, teamFollowers, me, isLeader) {
    var memberNames = members.map(function (m) { return m.name; });
    var followersOnly = teamFollowers.filter(function (f) { return memberNames.indexOf(f.follower) === -1; });
    var names = followersOnly.map(function (f) { return f.follower; }).sort(function (a, b) { return a.localeCompare(b); });
    var body = !names.length
      ? '<div class="help-text">Personne pour l\'instant.</div>'
      : names.map(function (name) {
        var followDoc = followersOnly.filter(function (f) { return f.follower === name; })[0];
        return renderTeamPersonRow(team, name, null, followDoc, me, isLeader);
      }).join('');
    return collapsibleSection('team-followers-' + team.id, 'Followers (' + names.length + ')', body);
  }

  function renderTeamSettings(team, isLeader) {
    if (!isLeader) {
      return '<div class="team-settings-disabled"><div class="help-text">🔒 Réservé aux Team Leaders.</div></div>';
    }
    var visibility = team.visibility || 'private';
    var html = '<div><label for="team-description-' + team.id + '">Présentation</label>' +
      '<textarea id="team-description-' + team.id + '" rows="2" placeholder="Quelques mots sur le Team...">' + escapeHtml(team.description || '') + '</textarea>' +
      '<div style="margin-top:0.5rem; display:flex; align-items:center; gap:0.6rem;">' +
      '<button type="button" class="ghost" data-action="team-description-save" data-team="' + team.id + '">Enregistrer la présentation</button>' +
      '<button type="button" class="ghost" data-action="team-photo-btn" data-team="' + team.id + '">' + (team.photoURL ? 'Changer la photo (badge)' : 'Ajouter une photo (badge)') + '</button>' +
      (team.photoURL ? '<button type="button" class="ghost" data-action="team-photo-recrop" data-team="' + team.id + '">Modifier le cadrage</button>' : '') +
      (team.photoURL ? '<button type="button" class="ghost" data-action="team-photo-remove" data-team="' + team.id + '">Retirer</button>' : '') +
      '</div>' +
      '<div class="help-text" style="margin-top:0.3rem;">S\'affiche partout en rond (fil d\'actu, membres, invitations...) -- le prochain écran te laisse choisir le cadrage.</div>' +
      '</div>';
    html += '<div style="margin-top:0.9rem;"><label>Logo (affiché en largeur sur la fiche du Team)</label>' +
      '<div style="margin-top:0.3rem; display:flex; align-items:center; gap:0.6rem;">' +
      '<button type="button" class="ghost" data-action="team-logo-btn" data-team="' + team.id + '">' + (team.logoURL ? 'Changer le logo' : 'Ajouter un logo') + '</button>' +
      (team.logoURL ? '<button type="button" class="ghost" data-action="team-logo-recrop" data-team="' + team.id + '">Modifier le cadrage</button>' : '') +
      (team.logoURL ? '<button type="button" class="ghost" data-action="team-logo-remove" data-team="' + team.id + '">Retirer</button>' : '') +
      '</div>' +
      '<div class="help-text" style="margin-top:0.3rem;">Utile pour un logo large (ex. "Mototeam95") que le badge rond couperait.</div>' +
      '</div>';
    html += '<div style="margin-top:0.9rem;"><form data-action="team-links-form" data-team="' + team.id + '">' +
      '<label for="team-links-' + team.id + '">Liens (un par ligne : Nom | URL)</label>' +
      '<textarea id="team-links-' + team.id + '" data-team-links-input rows="3" placeholder="Site internet | https://...\nBoutique | https://...\nPhotographe | https://...">' +
      escapeHtml((team.links || []).map(function (l) { return l.label + ' | ' + l.url; }).join('\n')) + '</textarea>' +
      '<button type="submit" class="ghost" style="margin-top:0.4rem;">Enregistrer les liens</button></form></div>';
    html += '<label for="team-visibility-select-' + team.id + '" style="margin-top:0.9rem;">Visibilité (qui peut trouver et suivre ce Team)</label>' +
      '<select id="team-visibility-select-' + team.id + '" data-action="team-visibility" data-team="' + team.id + '">' +
      '<option value="private"' + (visibility === 'private' ? ' selected' : '') + '>Sur invitation uniquement</option>' +
      '<option value="all"' + (visibility === 'all' ? ' selected' : '') + '>Visible par tous</option>' +
      '<option value="pro"' + (visibility === 'pro' ? ' selected' : '') + '>Visible par les Pilotes PRO</option>' +
      '<option value="certified"' + (visibility === 'certified' ? ' selected' : '') + '>Visible par les comptes certifiés</option>' +
      '</select>';
    html += '<label for="team-post-policy-select-' + team.id + '" style="margin-top:0.7rem;">Qui peut publier</label>' +
      '<select id="team-post-policy-select-' + team.id + '" data-action="team-post-policy" data-team="' + team.id + '">' +
      '<option value="leaders"' + (team.postPolicy !== 'members' ? ' selected' : '') + '>Team Leaders seulement</option>' +
      '<option value="members"' + (team.postPolicy === 'members' ? ' selected' : '') + '>Tous les membres</option>' +
      '</select>';
    html += '<div class="danger-zone" style="margin-top:1rem;">';
    if (pendingDeleteTeamId !== team.id) {
      html += '<button type="button" class="ghost danger" data-action="team-delete-request" data-team="' + team.id + '">Supprimer ce Team</button>';
    } else {
      html += '<form id="team-delete-form" data-team="' + team.id + '">' +
        '<div class="help-text">Cette action est irréversible. Confirme avec ton mot de passe actuel.</div>' +
        '<label for="team-delete-password" style="margin-top:0.6rem;">Mot de passe actuel</label>' +
        '<input type="password" id="team-delete-password" autocomplete="current-password">' +
        '<div style="margin-top:0.7rem; display:flex; gap:0.6rem;">' +
        '<button type="submit" class="ghost danger">Confirmer la suppression</button>' +
        '<button type="button" class="ghost" data-action="team-delete-cancel">Annuler</button></div>' +
        (teamDeleteMessage ? '<div class="help-text" style="margin-top:0.6rem;">' + escapeHtml(teamDeleteMessage) + '</div>' : '') +
        '</form>';
    }
    html += '</div>';
    return html;
  }

  // A Team PRO's own Team Leader can attribute Coach/Photographe officiel
  // to any account in the app (not just this Team's own members -- a
  // photographer covering the event may never follow/join the Team) --
  // the admin keeps the same power independently (see the users update
  // rule), this just delegates it too, scoped to this one Team PRO's
  // vouching (coachTeamId/photographerTeamId, verified server-side).
  function renderTeamProBadgeGrantSection(team) {
    var names = allKnownUserNames();
    var options = names.map(function (n) { return '<option value="' + escapeHtml(n) + '">' + escapeHtml(n) + '</option>'; }).join('');
    var body = '<div class="help-text">En tant que Team Leader d\'un Team PRO, attribue ou retire ces badges à n\'importe quel compte (pas seulement les membres du Team).</div>' +
      '<input type="text" list="team-pro-badge-names-' + team.id + '" placeholder="Rechercher un pilote, accompagnant, organisateur..." data-team-pro-badge-name style="margin-top:0.5rem;">' +
      '<datalist id="team-pro-badge-names-' + team.id + '">' + options + '</datalist>' +
      '<div style="display:flex; gap:0.6rem; margin-top:0.6rem; flex-wrap:wrap;">' +
      '<button type="button" class="ghost" data-action="team-pro-badge-toggle" data-team="' + team.id + '" data-field="coach">🎓 Coach : attribuer/retirer</button>' +
      '<button type="button" class="ghost" data-action="team-pro-badge-toggle" data-team="' + team.id + '" data-field="photographer">📷 Photographe : attribuer/retirer</button>' +
      '</div>';
    return collapsibleSection('team-pro-badges-' + team.id, 'Attribuer Coach / Photographe officiel', body);
  }

  // A Team Leader's own "Gestion des événements" -- create/modify a
  // sortie owned by this Team and manage its roster (participants +
  // pending "demander à participer" requests) without leaving the Team's
  // own space to hunt through the global Événements tab. Reuses the exact
  // same renderEventForm()/onEventSubmit() and accept/refuse plumbing as
  // Événements -- this is just a second, Team-scoped entry point onto it.
  // Compact list only -- one row per event (circuit, dates, headcount,
  // pending-requests badge) with a single "Gérer" button. Everything
  // about actually managing one event (résumé, annonces, participants,
  // demandes, groupes) now lives in its own dedicated screen (see
  // renderEventManagementScreen), not stacked three <details> deep here.
  function renderTeamEventsManagement(team) {
    var todayKey = dateKey(new Date());
    var own = (STATE.events || []).filter(function (ev) { return ev.teamId === team.id; });
    // Cross-team, read-only : un event organisé par un autre Team (le
    // plus souvent un Team PRO) où au moins un membre de CE Team-ci
    // participe -- pas de bouton Gérer, les droits de modification
    // restent réservés au Team Leader du Team organisateur (voir
    // renderEventManagementScreen). Mélangé dans les mêmes buckets
    // En cours/À venir/Passés que les events propres au Team (plutôt
    // qu'une 4e section à part) pour que le regroupement reste
    // temporel partout -- seuls le badge du Team organisateur et le
    // bouton Voir (au lieu de Gérer) distinguent une ligne cross-team.
    var roster = membersOfTeam(team.id).map(function (m) { return m.name; });
    var cross = (STATE.events || []).filter(function (ev) {
      return ev.teamId && ev.teamId !== team.id && (ev.riders || []).some(function (r) { return roster.indexOf(r) !== -1; });
    });
    var all = own.concat(cross);
    var pendingByEvent = {};
    (STATE.eventJoinRequests || []).forEach(function (r) {
      if (r.status !== 'pending' || r.teamId !== team.id) return;
      (pendingByEvent[r.eventId] = pendingByEvent[r.eventId] || []).push(r);
    });
    function eventRow(ev) {
      var isOwn = ev.teamId === team.id;
      var orgTeam = isOwn ? null : teamById(ev.teamId);
      var reqs = pendingByEvent[ev.id] || [];
      var riders = ev.riders || [];
      var meta;
      if (isOwn) {
        meta = [String(riders.length) + ' participant' + (riders.length > 1 ? 's' : '')];
        if (reqs.length) meta.push(reqs.length + ' demande' + (reqs.length > 1 ? 's' : '') + ' en attente');
      } else {
        var mine = riders.filter(function (r) { return roster.indexOf(r) !== -1; });
        meta = [mine.join(', ')];
      }
      // Réactions ne comptent qu'une fois l'event passé -- avant ça,
      // personne n'a encore été invité à réagir (voir renderEventSummaryCard).
      var likesHtml = '';
      if (isOwn && eventTemporalStatus(ev, todayKey) === 'past') {
        var likeCount = Object.keys(ev.reactions || {}).length;
        if (likeCount) likesHtml = ' <span class="event-likes-badge">👍 ' + likeCount + '</span>';
      }
      return '<div class="friend-row"><div class="friend-row-main"><span class="friend-name-plain">' + escapeHtml(ev.circuit) + '</span>' +
        (orgTeam ? '<span class="friend-role-badge">' + escapeHtml(orgTeam.name) + '</span>' : '') +
        '<span class="help-text">' + escapeHtml(formatEventRange(ev, true)) + ' · ' + meta.join(' · ') + '</span>' + likesHtml + '</div>' +
        '<div class="friend-row-actions"><button type="button" class="' + (isOwn ? 'primary' : 'ghost') + '" data-action="team-event-manage-open" data-id="' + ev.id + '">' + (isOwn ? 'Gérer' : 'Voir') + '</button></div></div>';
    }
    var ongoing = [], upcoming = [], past = [];
    all.forEach(function (ev) {
      var status = eventTemporalStatus(ev, todayKey);
      if (status === 'ongoing') ongoing.push(ev);
      else if (status === 'upcoming') upcoming.push(ev);
      else past.push(ev);
    });
    ongoing.sort(function (a, b) { return a.dateStart < b.dateStart ? -1 : 1; });
    upcoming.sort(function (a, b) { return a.dateStart < b.dateStart ? -1 : 1; });
    past.sort(function (a, b) { return a.dateStart < b.dateStart ? 1 : -1; });
    var body = '';
    if (!all.length) {
      body = '<div class="empty-state">Aucun événement pour ce Team.</div>';
    } else {
      // Toutes rétractées, sauf En cours s'il y en a -- et à défaut, À
      // venir (le prochain), pour toujours ouvrir sur ce qui compte
      // maintenant plutôt que sur du passé.
      body += collapsibleSection('team-events-ongoing-' + team.id, 'En cours (' + ongoing.length + ')',
        ongoing.length ? ongoing.map(eventRow).join('') : '<div class="help-text">Rien en ce moment.</div>', true);
      body += collapsibleSection('team-events-upcoming-' + team.id, 'À venir (' + upcoming.length + ')',
        upcoming.length ? upcoming.map(eventRow).join('') : '<div class="help-text">Rien de prévu.</div>', !ongoing.length);
      body += collapsibleSection('team-events-past-' + team.id, 'Passés (' + past.length + ')',
        past.length ? past.map(eventRow).join('') : '<div class="help-text">Aucun événement passé.</div>', false);
    }
    if (editingEventId === 'new' && prefillEventTeamId === team.id) body += renderEventForm();
    // Same collapsibleSection style as every other sub-section of this
    // Team's own fiche (Fil d'actualité/Membres/Followers/Inviter/
    // Réglages) -- used to be its own full collapsibleCard, which looked
    // like a heavier, disconnected block sitting inside the Team card.
    // The "+ Ajouter" still lives right next to the title (collapsibleSection
    // now takes the same titleActionsHtml collapsibleCard does) instead
    // of buried at the bottom of a long list.
    var addBtn = '<button type="button" class="ghost" data-action="team-event-add" data-team="' + team.id + '">+ Ajouter un événement</button>';
    // The card title's count is own.length, not all.length -- "Gestion"
    // in the title is about what's actually manageable here; the
    // cross-team, read-only events mixed into the buckets below aren't.
    return collapsibleSection('team-events-' + team.id, 'Gestion des événements' + (own.length ? ' (' + own.length + ')' : ''), body, false, addBtn);
  }

  // The dedicated per-event management screen (see managingEventId) --
  // résumé, annonces, participants + demandes, and l'attribution des
  // groupes, each its own flat section instead of nested collapsibles.
  // Mainly a Team PRO desktop tool: a big roster to search/filter and
  // reassign, not something meant to be skimmed on a phone between two
  // other things.
  function renderEventManagementScreen(ev, team) {
    // team is just the screen the viewer navigated in from -- it's the
    // organizing Team (canEdit true) when opened from that Team's own
    // Gestion des événements, but can also be another Team whose member(s)
    // happen to ride this event (see the cross-team, read-only list in
    // renderTeamEventsManagement). Every roster/visibility detail below
    // must reflect the event's actual organizing Team (orgTeam), and every
    // write control must be gated on canEdit, not on which Team's page got
    // us here -- firestore.rules enforces the same isTeamLeader(ev.teamId)
    // boundary server-side regardless of what the UI shows.
    var canEdit = !!(ev.teamId && isLeaderOfTeam(ev.teamId));
    var orgTeam = teamById(ev.teamId) || team;
    var reqs = (STATE.eventJoinRequests || []).filter(function (r) { return r.status === 'pending' && r.eventId === ev.id; });
    var riders = ev.riders || [];
    var html = '<div class="card">';
    html += '<h2 class="section-title">' + escapeHtml(ev.circuit) + ' — ' + escapeHtml(formatEventRange(ev, true)) + '</h2>';
    if (!canEdit && orgTeam !== team) html += '<div class="help-text" style="margin-bottom:0.6rem;">Organisé par ' + escapeHtml(orgTeam.name) + ' — lecture seule, seul le Team Leader de ' + escapeHtml(orgTeam.name) + ' peut modifier cet événement.</div>';
    // Modifier right under the title -- it used to sit at the bottom of a
    // long stack of sections, easy to lose track of and easy to confuse
    // with the collapsible headers just above it.
    if (canEdit) {
      html += '<div style="margin:0.6rem 0 1rem;"><button type="button" class="ghost" data-action="team-event-edit" data-id="' + ev.id + '">Modifier l\'événement</button></div>';
      if (editingEventId === ev.id) html += renderEventForm();
    }
    // Résumé -- no dates here, already in the title above.
    if (ev.note) html += infoRow('Note', escapeHtml(ev.note));
    var evTeamVis = { public: 'Public', adherent: 'Adhérent only', membre: 'Membre only', follower: 'Followers only', ouvert: 'Ouvert' };
    if (orgTeam.teamPro) html += infoRow('Visibilité', evTeamVis[ev.eventVisibility] || 'Membre only');
    if (ev.bookingUrl) html += '<div style="margin:0.6rem 0;"><button type="button" class="ghost" data-action="open-external-url" data-url="' + escapeHtml(ev.bookingUrl) + '">Réserver / S\'inscrire ↗</button></div>';
    html += renderEventAnnouncements(ev, canEdit);
    // Badges + rôle Team (Membre/Adhérent/Team Leader/Suivi) right on each
    // participant row -- a quick read for the Team orga without having to
    // open every fiche one by one. Always the organizing Team's own roster,
    // never the viewing Team's.
    var teamMembers = membersOfTeam(orgTeam.id);
    var teamFollowers = (STATE.teamFollowersByTeam || {})[orgTeam.id] || [];
    function participantRoleTag(name) {
      var m = teamMembers.filter(function (x) { return x.name === name; })[0];
      var f = teamFollowers.filter(function (x) { return x.follower === name; })[0];
      var isAdherent = !!(f && f.tier === 'adherent');
      var tags = '';
      if (m) tags += '<span class="friend-role-badge">' + (m.role === 'leader' ? 'Team Leader' : 'Membre') + '</span>';
      if (isAdherent) tags += ' <span class="friend-role-badge adherent-badge">Adhérent</span>';
      else if (f && !m) tags += ' <span class="friend-role-badge">Suivi</span>';
      return tags;
    }
    var eventBikeNumbers = ev.riderBikeNumbers || {};
    // .participants-list: same friend-row markup as everywhere else in
    // the app (mobile keeps its usual stacked look), but on desktop (see
    // style.css) each row becomes a grid line -- identité / rôle Team /
    // N° pour l'event / retirer, lined up in columns like a real table
    // instead of an organiser scanning a long stack of wrapped rows for
    // 20-30 pilotes.
    // Column labels -- hidden on mobile (see style.css), only meaningful
    // once .participants-list actually lays out as a grid on desktop.
    var riderRows = '<div class="participants-list">' +
      '<div class="participants-list-head friend-row"><span>Pilote</span><span>' + (canEdit ? 'N° pour cet event' : '') + '</span><span></span></div>';
    riderRows += riders.length
      ? riders.map(function (name) {
          var u = (STATE.usersByName || {})[name] || {};
          var eventNumber = eventBikeNumbers[name] || '';
          var actions = canEdit
            ? '<div class="friend-row-actions"><button type="button" class="ghost icon-btn" data-action="team-event-remove-rider" data-id="' + ev.id + '" data-rider="' + escapeHtml(name) + '" aria-label="Retirer" title="Retirer">×</button></div>' +
              '<div class="team-role-field"><input type="text" placeholder="N° pour cet event" value="' + escapeHtml(eventNumber) + '" data-event-bike-number-input inputmode="numeric">' +
              '<button type="button" class="ghost icon-btn" data-action="event-bike-number-save" data-id="' + ev.id + '" data-rider="' + escapeHtml(name) + '" aria-label="Enregistrer le N°" title="Enregistrer">✓</button></div>'
            : (eventNumber ? '<div class="team-role-field"><span class="account-role-tag">N° pour cet event : #' + escapeHtml(eventNumber) + '</span></div>' : '');
          return '<div class="friend-row"><div class="friend-row-main">' + nameLinkHtml(name) + badgesHtml(u) + participantRoleTag(name) + (u.bikeNumber ? ' <span class="account-role-tag">#' + escapeHtml(u.bikeNumber) + '</span>' : '') + '</div>' +
            actions + '</div>' + maybeFicheHtml(name);
        }).join('')
      : '<div class="help-text">Aucun participant.</div>';
    riderRows += '</div>';
    // Search-to-add, name + # (bikeNumber) shown per candidate so a Team
    // Leader can tell same-name pilotes apart before adding one.
    if (canEdit) {
      var candidates = candidateRidersForTeamEvent(orgTeam, riders);
      if (candidates.length) {
        riderRows += '<form class="team-event-add-rider-form" data-action="team-event-add-rider-form" data-event-id="' + ev.id + '">' +
          '<select data-team-event-add-rider-select>' + candidates.map(function (n) {
            var u = (STATE.usersByName || {})[n] || {};
            return '<option value="' + escapeHtml(n) + '">' + escapeHtml(n) + (u.bikeNumber ? ' #' + escapeHtml(u.bikeNumber) : '') + '</option>';
          }).join('') + '</select>' +
          '<button type="submit" class="ghost">Ajouter</button></form>';
      }
    }
    html += collapsibleSection('event-manage-riders-' + ev.id, 'Participants (' + riders.length + ')', riderRows, true);
    // Easy per-rider chrono check right here, next to the roster --
    // renderEventCertificationSection already lets the leader verify (✓)
    // or un-verify a rider's best chrono for this sortie whenever they
    // want, not just right after the event. Self-gated on isLeaderOfTeam
    // (ev.teamId) already, so it naturally stays empty here for a viewer
    // who isn't the organizing Team's leader.
    html += renderEventCertificationSection(ev);
    if (canEdit && reqs.length) {
      var reqRows = reqs.map(function (r) {
        var u = (STATE.usersByName || {})[r.from] || {};
        return '<div class="friend-row"><div class="friend-row-main">' + avatarHtml(u, r.from) + personNameHtml(r.from) + badgesHtml(u) + '</div>' +
          '<div class="friend-row-actions">' +
          '<button type="button" class="primary" data-action="event-join-request-accept" data-id="' + r.id + '">Accepter</button>' +
          '<button type="button" class="ghost" data-action="event-join-request-remove" data-id="' + r.id + '">Refuser</button>' +
          '</div></div>';
      }).join('');
      html += collapsibleSection('event-manage-requests-' + ev.id, 'Demandes à accepter (' + reqs.length + ')', reqRows, true);
    }
    html += renderGroupsSection(ev, canEdit);
    html += '</div>';
    return html;
  }

  function renderTeamCard(team, me) {
    var isLeader = isLeaderOfTeam(team.id);
    var members = membersOfTeam(team.id).slice().sort(function (a, b) {
      if ((a.role === 'leader') !== (b.role === 'leader')) return a.role === 'leader' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    // This fiche now also opens for a plain follower (Geoff on
    // Mototeam95, say -- see renderTeamTab's myTeams), not just members,
    // so canPost and the header badge need to actually check membership
    // instead of assuming every viewer here is at least a member.
    var isMember = members.some(function (m) { return m.name === me.name; });
    var canPost = isLeader || (isMember && team.postPolicy === 'members');
    var feed = (STATE.teamFeed || []).filter(function (f) { return f.teamId === team.id; });
    var html = '<div class="card team-card">';
    html += '<div class="section-title" style="display:flex; align-items:center; gap:0.6rem;">' + avatarHtml(team, team.name) +
      '<span style="flex:1;">' + escapeHtml(team.name) + teamBadgesHtml(team) + '</span>' +
      (!isMember ? '<button type="button" class="ghost icon-btn" data-action="unfollow-team" data-team="' + team.id + '" aria-label="Ne plus suivre" title="Ne plus suivre">×</button>' : '') +
      '<span class="friend-role-badge">' + (isLeader ? 'Team Leader' : (isMember ? 'Membre' : 'Follower')) + '</span></div>';
    var teamLikeCount = (STATE.teamLikes || []).filter(function (l) { return l.teamId === team.id; }).length;
    var teamFollowCount = ((STATE.teamFollowersByTeam || {})[team.id] || []).length;
    html += '<div class="team-stats-row"><span>❤ ' + teamLikeCount + ' like' + (teamLikeCount > 1 ? 's' : '') + '</span>' +
      '<span>👥 ' + teamFollowCount + ' follow' + (teamFollowCount > 1 ? 's' : '') + '</span></div>';
    // A wide logo (e.g. "Mototeam95") shown full-width, uncropped -- the
    // round avatar above is for badges everywhere else, this is the one
    // place it's shown properly.
    if (team.logoURL) html += '<div class="team-logo-frame"><img class="team-logo-img" src="' + escapeHtml(team.logoURL) + '" alt="Logo ' + escapeHtml(team.name) + '"></div>';
    if (team.description) html += '<div class="help-text team-description">' + escapeHtml(team.description) + '</div>';
    if (team.links && team.links.length) {
      html += '<div class="team-links-row">' + team.links.map(function (l) {
        return '<a class="team-link-chip" href="' + escapeHtml(l.url) + '" target="_blank" rel="noopener">' + escapeHtml(l.label) + '</a>';
      }).join('') + '</div>';
    }
    // Gestion des événements right under the profile (header/logo/
    // présentation/liens) -- it's the main reason a Team Leader opens
    // this screen, not something to scroll past Fil d'actualité/Membres
    // to reach.
    if (isLeader) html += renderTeamEventsManagement(team);
    if (isLeader && team.teamPro) html += renderTeamProBadgeGrantSection(team);

    var feedBody = !feed.length
      ? '<div class="empty-state">' + (teamFeedSynced ? 'Rien pour l\'instant.' : 'Chargement...') + '</div>'
      : feed.map(function (f) { return renderTeamFeedEntry(f, me); }).join('');
    if (canPost) {
      // The Adhérents-only audience option only makes sense for a Team PRO
      // ("club", see renderTeamMembersManagement) and only the leader hands
      // out exclusive club news -- an ordinary member posting to an
      // amateur team never sees this selector, and their posts stay
      // visible to every follower (no audience field written at all).
      var audienceSelect = (isLeader && team.teamPro)
        ? '<select data-team-feed-audience style="margin-top:0.4rem;">' +
          '<option value="all">Visible par tous (membres + followers)</option>' +
          '<option value="adherents">Adhérents seulement</option>' +
          '</select>'
        : '';
      if (teamComposerMode === 'message') {
        feedBody += '<form class="team-feed-form" data-action="team-feed-form" data-team="' + team.id + '">' +
          '<input type="text" placeholder="Écrire au team..." data-team-feed-input autofocus>' +
          '<input type="url" placeholder="Lien (optionnel)" data-team-feed-link>' +
          (teamPostDraftPhotoTeamId === team.id && teamPostDraftPhotoURL
            ? '<img class="wall-post-photo-preview" src="' + escapeHtml(teamPostDraftPhotoURL) + '" alt="">' +
              '<button type="button" class="ghost" data-action="team-feed-photo-remove">Retirer la photo</button>'
            : '') +
          audienceSelect +
          '<div style="display:flex; gap:0.5rem;">' +
          '<button type="button" class="ghost icon-btn" data-action="team-feed-photo-btn" data-team="' + team.id + '" aria-label="Ajouter une photo" title="Ajouter une photo">📷</button>' +
          '<button type="submit" class="primary">Publier</button>' +
          '<button type="button" class="ghost" data-action="team-composer-close">Annuler</button>' +
          '</div></form>';
      } else if (teamComposerMode === 'poll') {
        var optionInputs = pollDraftOptions.map(function (val, pi) {
          return '<input type="text" placeholder="Option ' + (pi + 1) + (pi >= 2 ? ' (optionnel)' : '') + '" value="' + escapeHtml(val) + '" data-poll-option>';
        }).join('');
        feedBody += '<form class="team-poll-form" data-action="team-poll-form" data-team="' + team.id + '">' +
          '<input type="text" placeholder="Créer un sondage : la question" value="' + escapeHtml(pollDraftQuestion) + '" data-poll-question autofocus>' +
          optionInputs +
          '<button type="button" class="ghost" data-action="team-poll-add-option">+ Ajouter une option</button>' +
          audienceSelect +
          '<div style="display:flex; gap:0.5rem; margin-top:0.4rem;">' +
          '<button type="submit" class="ghost">Publier le sondage</button>' +
          '<button type="button" class="ghost" data-action="team-composer-close">Annuler</button>' +
          '</div></form>';
      } else {
        feedBody += '<div style="display:flex; gap:0.5rem; margin-top:0.6rem;">' +
          '<button type="button" class="ghost" data-action="team-composer-open" data-mode="message">✎ Écrire un message</button>' +
          '<button type="button" class="ghost" data-action="team-composer-open" data-mode="poll">📊 Sondage</button>' +
          '</div>';
      }
    }
    html += collapsibleSection('team-feed-' + team.id, 'Fil d\'actualité (' + feed.length + ')', feedBody);

    var teamFollowers = (STATE.teamFollowersByTeam || {})[team.id] || [];
    html += renderTeamMembersSection(team, members, teamFollowers, me, isLeader);
    html += renderTeamFollowersSection(team, members, teamFollowers, me, isLeader);
    html += renderTeamPartnersSection(team, isLeader);

    if (isLeader) {
      var memberNames = members.map(function (m) { return m.name; });
      var outgoingInvites = (STATE.teamInvites || []).filter(function (r) { return r.status === 'pending' && r.teamId === team.id; });
      var invitedNames = outgoingInvites.map(function (r) { return r.to; });
      // A Team PRO recruits openly -- its leader can invite anyone with an
      // account, not just existing friends (see firestore.rules'
      // teamInvites: only isTeamLeader() is required to create one, no
      // friendship check ever existed server-side, so this was always
      // just the UI being more conservative than the rules for an
      // ordinary/amateur team). A non-PRO team keeps the friends-only pool.
      var invitePool = team.teamPro ? allKnownUserNames() : friendsOf(me.name).map(function (f) { return f.name; });
      var candidates = invitePool.filter(function (n) {
        return n !== me.name && memberNames.indexOf(n) === -1 && invitedNames.indexOf(n) === -1;
      });
      var inviteBody = !candidates.length
        ? (team.teamPro
          ? '<div class="help-text">Personne d’autre à inviter pour l’instant.</div>'
          : '<div class="help-text">Tous tes amis sont déjà dans ce team, ou aucun ami à inviter -- vois Social.</div>')
        : '<form class="team-invite-form" data-action="team-invite-form" data-team="' + team.id + '">' +
          (team.teamPro ? '<div class="help-text" style="margin-bottom:0.4rem;">Team PRO : tu peux inviter n’importe quel compte, ami ou non.</div>' : '') +
          '<select data-team-invite-select>' + candidates.map(function (n) {
            var cu = (STATE.usersByName || {})[n] || {};
            var roleSuffix = cu.role === 'accompagnant' ? ' (Accompagnant)' : (cu.role === 'organisateur' ? ' (Organisateur)' : '');
            return '<option value="' + escapeHtml(n) + '">' + escapeHtml(n) + escapeHtml(roleSuffix) + '</option>';
          }).join('') + '</select>' +
          '<button type="submit" class="ghost">Inviter</button></form>';
      if (outgoingInvites.length) {
        var outgoingBody = outgoingInvites.map(function (r) {
          return '<div class="friend-row"><div class="friend-row-main">' + personNameHtml(r.to) + '</div>' +
            '<div class="friend-row-actions"><button type="button" class="ghost" data-action="team-invite-remove" data-id="' + r.id + '">Annuler</button></div></div>';
        }).join('');
        inviteBody += collapsibleSection('team-invites-out-' + team.id, 'Invitations envoyées (' + outgoingInvites.length + ')', outgoingBody);
      }
      html += collapsibleSection('team-invite-' + team.id, 'Inviter', inviteBody);
    }

    if (isLeader) {
      var joinRequests = (STATE.teamJoinRequests || []).filter(function (r) { return r.teamId === team.id && r.status === 'pending'; });
      if (joinRequests.length) {
        var joinReqBody = joinRequests.map(renderTeamJoinRequestRow).join('');
        html += collapsibleSection('team-join-requests-' + team.id, 'Demandes pour rejoindre (' + joinRequests.length + ')', joinReqBody, true);
      }
    }

    html += collapsibleSection('team-settings-' + team.id, 'Réglages', renderTeamSettings(team, isLeader));
    html += '</div>';
    return html;
  }

  function renderCreateTeamCard() {
    var me = currentUserProfile;
    var isOrganisateur = !!(me && me.role === 'organisateur');
    var html = '<div class="card"><h2 class="section-title">Créer un Team</h2>' +
      '<div class="help-text"><strong>Team amateur</strong> : entre amis, ouvert tout de suite, tu en es le premier Team Leader -- membres, fil d\'actualité et événements, sans plus.<br>' +
      '<strong>Team PRO</strong> (coche bleue ✓) : club officiel validé -- en plus de l\'amateur, gère des adhérents, peut attribuer les badges Coach et Photographe officiel, proposer coaching/baptêmes piste, et choisir la visibilité de ses événements (public, adhérents, sur demande...).';
    if (isOrganisateur) {
      html += ' En tant qu\'Organisateur, tu peux directement le créer en Team PRO ci-dessous.</div>';
    } else {
      html += ' Un Team PRO ne se crée pas directement : contacte l\'administrateur une fois ton Team amateur créé pour le faire valider et passer PRO, ou passe ton profil en Organisateur pour pouvoir le créer directement PRO.</div>';
    }
    html += '<form id="create-team-form" style="margin-top:0.7rem;">' +
      '<label for="new-team-name">Nom du team</label>' +
      '<input type="text" id="new-team-name" placeholder="Ex. Mototeam95" required>';
    if (isOrganisateur) {
      html += '<label class="checklist-item" style="margin-top:0.6rem;"><input type="checkbox" id="new-team-pro"> Créer directement comme Team PRO ✓</label>';
    }
    html += '<button type="submit" class="primary" style="margin-top:0.7rem;">Créer</button>' +
      '</form></div>';
    return html;
  }

  // ---- Coach ----
  //
  // Reachable from the header's 🎓 icon (see canAccessCoachSpace), not the
  // bottom nav -- it only matters to a Coach and to whoever's actually
  // asked one for coaching. Two independent halves on the same page: "mes
  // pilotes coachés" (only if this account carries the Coach badge) and
  // "ma demande de coaching" (this account's own, as a Pilote/Organisateur
  // asking someone else) -- an account can be both at once (a coach who's
  // also coached by someone more senior), so both sections show whenever
  // they have something to show.
  // Shared by both sides of one coaching relationship (the coach's own
  // roster row and the coaché's "Mon coaching" card) -- same requestId,
  // same thread.
  function renderCoachMessageThread(requestId) {
    var me = currentUserProfile;
    var messages = (STATE.coachMessages || []).filter(function (m) { return m.requestId === requestId; });
    var body = !messages.length
      ? '<div class="empty-state">Aucun message pour l\'instant.</div>'
      : messages.map(function (m) {
        return '<div class="coach-message' + (me && m.from === me.name ? ' mine' : '') + '">' +
          '<div class="coach-message-head">' + personNameHtml(m.from) +
          '<span class="feed-entry-time">' + escapeHtml(relativeTime(m.createdAt)) + '</span></div>' +
          '<div class="coach-message-text">' + escapeHtml(m.text) + '</div></div>';
      }).join('');
    body += '<form class="coach-message-form" data-action="coach-message-form" data-request-id="' + requestId + '">' +
      '<input type="text" placeholder="Écrire un message..." data-coach-message-input>' +
      '<button type="submit" class="primary">Envoyer</button></form>';
    return collapsibleSection('coach-messages-' + requestId, 'Messages', body);
  }

  // Which type a Coach's propose form is currently set to -- pure UI
  // state (not persisted), read by both the form's own render (candidate
  // list/roles differ) and its submit handler.
  var coachProposeType = 'coaching';
  // Whether the planning grid below is currently in "paint my
  // availability" mode (Coach only, see renderCoachPlanningSection) and,
  // while it is, which type new paint strokes mark -- pure UI state.
  var coachAvailabilityEditOpen = false;
  var coachAvailabilityEditType = 'coaching';
  // Drag-paint state for the availability editor (see attachHandlers'
  // .coach-availability-painting wiring) -- module-level since the
  // document-level pointermove/up/cancel listeners are attached exactly
  // once, ever (paintListenersOn), and need to read whatever the latest
  // render bound paintEventId to.
  var painting = false;
  var paintValue = null;
  var paintTouched = {};
  var paintEventId = null;
  var paintListenersOn = false;
  function paintApplySlot(el) {
    var label = el.textContent.trim();
    if (paintTouched[label]) return;
    paintTouched[label] = true;
    var current = coachAvailabilityFor(currentUserProfile.name, paintEventId, coachAvailabilityEditType) || [];
    var has = current.indexOf(label) !== -1;
    if (paintValue === has) return;
    el.classList.toggle('slot-avail-' + coachAvailabilityEditType, paintValue);
    var byType = Object.assign({}, (currentUserProfile.coachAvailability || {})[paintEventId] || {});
    var arr = (byType[coachAvailabilityEditType] || []).slice();
    var idx = arr.indexOf(label);
    if (paintValue && idx === -1) arr.push(label);
    else if (!paintValue && idx !== -1) arr.splice(idx, 1);
    byType[coachAvailabilityEditType] = arr;
    currentUserProfile.coachAvailability = Object.assign({}, currentUserProfile.coachAvailability || {});
    currentUserProfile.coachAvailability[paintEventId] = byType;
  }
  // Every Coach's declared availability for this event, aggregated for
  // display (view mode only -- edit mode shows just the current Coach's
  // own picks, see renderCoachPlanningSection) -- blue dot = someone's
  // free for coaching then, orange = baptême, purple = both.
  function coachAvailabilitySlotClass(ev, me) {
    if (coachAvailabilityEditOpen && isCoachBadge(me)) {
      var mine = coachAvailabilityFor(me.name, ev.id, coachAvailabilityEditType) || [];
      return function (label) { return mine.indexOf(label) !== -1 ? ' slot-avail-' + coachAvailabilityEditType : ''; };
    }
    var coachingLabels = {}, baptemeLabels = {};
    Object.keys(STATE.usersByName || {}).forEach(function (name) {
      var byType = (STATE.usersByName[name].coachAvailability || {})[ev.id];
      if (!byType || !isCoachBadge(STATE.usersByName[name])) return;
      (byType.coaching || []).forEach(function (l) { coachingLabels[l] = true; });
      (byType.bapteme || []).forEach(function (l) { baptemeLabels[l] = true; });
    });
    return function (label) {
      var c = !!coachingLabels[label], b = !!baptemeLabels[label];
      return c && b ? ' slot-avail-both' : c ? ' slot-avail-coaching' : b ? ' slot-avail-bapteme' : '';
    };
  }
  // Same ongoing/upcoming event + horaires-by-group as EN PISTE's own
  // "today-schedule-card" (see renderPlanningTab/renderHoraireGroups) --
  // reused as-is here so a Coach can see when to be trackside for a
  // coaching or baptême without leaving this tab. live:true (same as
  // there) gets the current/next/past slot highlighting for free, since
  // updateLiveClock() already queries every [data-slot-start] in the
  // page, not just the Planning tab's own copy.
  //
  // Doubles as the Coach's own availability editor: toggling "Définir mes
  // disponibilités" swaps the grid from "click a slot to ask for it" into
  // "click or drag across slots to mark them" for whichever type
  // (Coaching/Baptême) is currently selected -- one continuous pointer
  // gesture across several slots (see attachHandlers' coach-availability-*
  // handlers) rather than one tap per slot, since a whole day's worth one
  // at a time was tedious.
  function renderCoachPlanningSection(me) {
    var target = targetPlanningEvent();
    if (!target) return '';
    var ev = target.ev;
    var info = circuitInfo(ev.circuit);
    var iAmCoach = isCoachBadge(me);
    var editing = coachAvailabilityEditOpen && iAmCoach;
    var coachHoraires = eventHoraires(ev);
    var groupsHtml = coachHoraires ? renderHoraireGroups(coachHoraires, null, ev, info.briefing, true, coachAvailabilitySlotClass(ev, me)) : '';
    if (!groupsHtml) return '';
    var body = '<div class="eyebrow">' + (target.mode === 'ongoing' ? 'En ce moment — ' : 'Prochain événement — ') + escapeHtml(ev.circuit) + '</div>';
    if (iAmCoach) {
      body += '<div style="display:flex; gap:0.5rem; align-items:center; flex-wrap:wrap; margin:0.4rem 0;">' +
        '<button type="button" class="ghost" data-action="coach-availability-edit-toggle">' + (editing ? 'Terminé' : '✎ Définir mes disponibilités') + '</button>';
      if (editing) {
        body += '<div class="coach-availability-type-switch">' +
          '<button type="button" class="coach-availability-type-btn' + (coachAvailabilityEditType === 'coaching' ? ' active' : '') + '" data-action="coach-availability-type" data-type="coaching">Coaching</button>' +
          '<button type="button" class="coach-availability-type-btn' + (coachAvailabilityEditType === 'bapteme' ? ' active' : '') + '" data-action="coach-availability-type" data-type="bapteme">Baptême piste</button>' +
          '</div>';
      }
      body += '</div>';
      if (editing) {
        body += '<div class="help-text" style="margin-bottom:0.4rem;">Clique ou fais glisser (doigt ou souris) sur les créneaux pour les marquer disponibles.</div>';
      } else {
        body += '<div class="help-text" style="margin-bottom:0.4rem;">🔵 disponible pour du coaching · 🟠 pour un baptême piste · 🟣 les deux.</div>';
      }
    }
    var wrapClass = editing ? 'coach-availability-painting' : 'coach-planning-clickable';
    body += '<div class="' + wrapClass + '" data-event-id="' + ev.id + '" data-circuit="' + escapeHtml(ev.circuit) + '">' + groupsHtml + '</div>';
    return collapsibleCard('coach-planning', 'Planning (horaires par groupe)', body, true);
  }

  // ---- Demander depuis un créneau du planning (voir renderCoachPlanningSection) ----
  //
  // Clicking a schedule-slot span there (delegated click handler, see
  // attachHandlers) opens this instead of going through the general
  // search form -- the slot/event/circuit are already known, only "qui"
  // and "coaching ou baptême" are left to pick.
  var coachSlotModal = null; // {eventId, circuit, slotLabel} (the clicked/anchor slot) or null
  var coachSlotModalType = 'coaching';
  // Up to 3 slot labels the user is currently offering -- starts as just
  // the clicked slot, can be widened via the checklist below so a Coach
  // has room to pick whichever of several times actually suits them.
  var coachSlotModalSelected = [];
  function openCoachSlotModal(eventId, circuit, slotStart, slotEnd, slotLabel) {
    coachSlotModal = { eventId: eventId, circuit: circuit, slotLabel: slotLabel };
    coachSlotModalType = 'coaching';
    coachSlotModalSelected = [slotLabel];
    renderRoot();
  }
  function closeCoachSlotModal() {
    coachSlotModal = null;
    renderRoot();
  }
  function renderCoachSlotModal() {
    if (!coachSlotModal) return '';
    var me = currentUserProfile;
    var proposeRoles = coachSlotModalType === 'bapteme' ? ['pilote', 'accompagnant'] : ['pilote'];
    var linkedNames = (STATE.coachRequests || []).filter(function (r) { return me && (r.from === me.name || r.to === me.name) && (r.type || 'coaching') === coachSlotModalType; })
      .map(function (r) { return r.from === me.name ? r.to : r.from; });
    var ev = eventsList().filter(function (e) { return e.id === coachSlotModal.eventId; })[0];
    var allSlots = ev ? allEventSlots(ev) : [];
    // Hard filter -- a request can only ever be raised against a Coach
    // who's actually declared themselves free (for this type: coaching
    // and baptême availability are separate sets, see
    // saveCoachAvailability) for at least one of the offered slots,
    // never "anyone with the badge".
    var coachCandidates = allKnownUserNames().filter(function (n) {
      if (me && n === me.name) return false;
      if (linkedNames.indexOf(n) !== -1) return false;
      var av = coachAvailabilityFor(n, coachSlotModal.eventId, coachSlotModalType);
      return !!(av && coachSlotModalSelected.some(function (l) { return av.indexOf(l) !== -1; }));
    });
    var html = '<div class="crop-modal-overlay"><div class="crop-modal">' +
      '<h2 class="section-title">Demander pour ' + escapeHtml(coachSlotModal.slotLabel) + '</h2>';
    if (me && proposeRoles.indexOf(me.role || 'pilote') === -1) {
      html += '<div class="help-text">Le coaching est réservé aux pilotes -- choisis "Baptême piste" ci-dessous.</div>';
    }
    html += '<label for="coach-slot-type" style="margin-top:0.6rem;">Type</label>' +
      '<select id="coach-slot-type">' +
      '<option value="coaching"' + (coachSlotModalType === 'coaching' ? ' selected' : '') + '>Coaching</option>' +
      '<option value="bapteme"' + (coachSlotModalType === 'bapteme' ? ' selected' : '') + '>Baptême piste</option>' +
      '</select>';
    if (allSlots.length > 1) {
      html += '<label style="margin-top:0.6rem; display:block;">Créneaux proposés (3 maximum)</label>' +
        '<div class="coach-slot-modal-options">' + allSlots.map(function (s) {
          var checked = coachSlotModalSelected.indexOf(s.label) !== -1;
          var disabled = !checked && coachSlotModalSelected.length >= 3;
          return '<label class="checklist-item"><input type="checkbox" data-action="coach-slot-modal-option" value="' + escapeHtml(s.label) + '"' +
            (checked ? ' checked' : '') + (disabled ? ' disabled' : '') + '> ' + escapeHtml(s.label) + '</label>';
        }).join('') + '</div>';
    }
    if (!coachCandidates.length) {
      html += '<div class="help-text" style="margin-top:0.6rem;">Aucun Coach disponible sur ' + (coachSlotModalSelected.length > 1 ? 'ces créneaux' : 'ce créneau') + ' pour ce type -- essaie d\'autres créneaux ou l\'autre type.</div>';
    } else {
      html += '<form id="coach-slot-request-form" style="margin-top:0.6rem;">' +
        '<label for="coach-slot-coach">Coach</label>' +
        '<select id="coach-slot-coach">' + coachCandidates.map(function (n) { return '<option value="' + escapeHtml(n) + '">' + escapeHtml(n) + '</option>'; }).join('') + '</select>' +
        '<button type="submit" class="primary" style="margin-top:0.7rem;">Envoyer la demande</button></form>';
    }
    html += '<button type="button" class="ghost" id="coach-slot-cancel-btn" style="margin-top:0.6rem;">Annuler</button>';
    return html + '</div></div>';
  }
  // Which request currently shows its inline "proposer un autre horaire"
  // text form instead of the usual Accepter/Proposer/Refuser buttons --
  // pure UI state, not persisted.
  var counterProposeRequestId = null;
  // 'awaiting' defaults to 'to' for a doc that predates this field (the
  // original accept-only flow always needed the recipient's action) --
  // matches firestore.rules' own resource.data.get('awaiting', 'to').
  function coachRequestAwaitingMe(r, me) {
    return (r.awaiting || 'to') === (r.from === me.name ? 'from' : 'to');
  }
  function coachRequestSlotHtml(r) {
    if (!r.slotLabel) return '';
    var suffix = r.circuit ? ' — ' + escapeHtml(r.circuit) : '';
    // More than one option still means "take your pick", not "here's
    // what's booked" -- shown as a full list only while still pending
    // with several options actually open (see renderCoachActionRow for
    // the matching per-option Accepter buttons); once accepted or down
    // to a single slot, the plain "Créneau : X" line says it all.
    if (r.status === 'pending' && r.slotOptions && r.slotOptions.length > 1) {
      return '<div class="help-text" style="margin-top:0.2rem;">Créneaux proposés : ' + r.slotOptions.map(escapeHtml).join(', ') + suffix + '</div>';
    }
    return '<div class="help-text" style="margin-top:0.2rem;">Créneau : ' + escapeHtml(r.slotLabel) + suffix + '</div>';
  }
  // A request/proposal that's on me to answer right now -- whichever
  // side of the doc that makes me, and whether it just arrived or is a
  // counter-proposal bounced back. Accepter locks in the slot currently
  // on the doc; Proposer un autre horaire (only offered when there's an
  // actual slot to negotiate) swaps it out and passes the turn back;
  // Refuser always just deletes the doc outright, from either side, at
  // any point -- the one action that never needs it to be "my turn".
  function renderCoachActionRow(r, otherName) {
    var me = currentUserProfile;
    var u = (STATE.usersByName || {})[otherName] || {};
    var isBapteme = r.type === 'bapteme';
    var html = '<div class="coach-request-row"><div class="friend-row-main">' + avatarHtml(u, otherName) + personNameHtml(otherName) + badgesHtml(u) +
      ' <span class="friend-role-badge">' + (isBapteme ? 'Baptême piste' : 'Coaching') + '</span></div>' +
      coachRequestSlotHtml(r);
    if (counterProposeRequestId === r.id) {
      var slotOptions = coachRequestSlotOptions(r, me.name);
      html += '<form class="coach-slot-propose-form" data-action="coach-slot-propose-form" data-id="' + r.id + '" style="margin-top:0.5rem; display:flex; gap:0.5rem; flex-wrap:wrap; align-items:center;">';
      if (slotOptions.length) {
        html += '<select data-coach-slot-propose-select style="flex:1 1 140px;">' + slotOptions.map(function (s) {
          return '<option value="' + escapeHtml(s.label) + '"' + (s.label === r.slotLabel ? ' selected' : '') + '>' + escapeHtml(s.label) + '</option>';
        }).join('') + '</select>' +
          '<button type="submit" class="primary">Envoyer</button>';
      } else {
        html += '<div class="help-text">Aucun créneau disponible à proposer' + (isCoachBadge(me) ? ' -- vérifie tes disponibilités ci-dessus.' : '.') + '</div>';
      }
      html += '<button type="button" class="ghost" data-action="coach-slot-propose-cancel">Annuler</button></form>';
    } else if (r.slotOptions && r.slotOptions.length > 1) {
      // Several candidate slots still open -- one Accepter per option
      // rather than a single generic one, since accepting *means*
      // picking which of them (see acceptCoachRequestSlot).
      html += '<div class="friend-row-actions" style="margin-top:0.5rem; flex-direction:column; align-items:stretch;">' +
        r.slotOptions.map(function (label) {
          return '<button type="button" class="primary" data-action="coach-request-accept-slot" data-id="' + r.id + '" data-label="' + escapeHtml(label) + '">Accepter ' + escapeHtml(label) + '</button>';
        }).join('') +
        '<div style="display:flex; gap:0.5rem; flex-wrap:wrap;">' +
        (r.eventId ? '<button type="button" class="ghost" data-action="coach-slot-propose-open" data-id="' + r.id + '">Proposer un autre horaire</button>' : '') +
        '<button type="button" class="ghost" data-action="coach-request-remove" data-id="' + r.id + '">Refuser</button>' +
        '</div></div>';
    } else {
      html += '<div class="friend-row-actions" style="margin-top:0.5rem;">' +
        '<button type="button" class="primary" data-action="coach-request-accept" data-id="' + r.id + '">Accepter</button>' +
        (r.slotLabel && r.eventId ? '<button type="button" class="ghost" data-action="coach-slot-propose-open" data-id="' + r.id + '">Proposer un autre horaire</button>' : '') +
        '<button type="button" class="ghost" data-action="coach-request-remove" data-id="' + r.id + '">Refuser</button>' +
        '</div>';
    }
    return html + '</div>';
  }
  // Pending, but the *other* side has to answer -- nothing to do here
  // except cancel outright.
  function renderCoachWaitingRow(r, otherName) {
    var u = (STATE.usersByName || {})[otherName] || {};
    var isBapteme = r.type === 'bapteme';
    return '<div class="coach-request-row"><div class="friend-row-main">' + avatarHtml(u, otherName) + personNameHtml(otherName) + badgesHtml(u) +
      ' <span class="friend-role-badge">' + (isBapteme ? 'Baptême piste' : 'Coaching') + '</span></div>' +
      coachRequestSlotHtml(r) +
      '<div class="help-text" style="margin-top:0.3rem;">En attente de la réponse de ' + escapeHtml(otherName) + '.</div>' +
      '<div class="friend-row-actions" style="margin-top:0.4rem;"><button type="button" class="ghost" data-action="coach-request-remove" data-id="' + r.id + '">Annuler</button></div></div>';
  }
  // Accepted -- coaching gets the plan/notes field, baptême doesn't (no
  // ongoing training to track for a single ride-along); both get the
  // shared message thread.
  function renderCoachActiveRow(r, otherName) {
    var u = (STATE.usersByName || {})[otherName] || {};
    var isBapteme = r.type === 'bapteme';
    var html = '<div class="coach-request-row"><div class="friend-row-main">' + avatarHtml(u, otherName) + personNameHtml(otherName) + badgesHtml(u) +
      '<span class="friend-role-badge">' + (isBapteme ? 'Baptême piste' : 'Coaching') + '</span></div>' +
      coachRequestSlotHtml(r);
    if (!isBapteme) {
      html += '<label for="coach-plan-' + r.id + '" style="margin-top:0.5rem;">Planning / notes de coaching</label>' +
        '<textarea id="coach-plan-' + r.id + '" rows="3" data-coach-plan="' + r.id + '">' + escapeHtml(r.plan || '') + '</textarea>' +
        '<div style="margin-top:0.5rem;"><button type="button" class="ghost" data-action="coach-plan-save" data-id="' + r.id + '">Enregistrer</button></div>';
    }
    html += '<div style="margin-top:0.5rem;"><button type="button" class="ghost danger" data-action="coach-request-remove" data-id="' + r.id + '">' +
      (isBapteme ? 'Retirer' : 'Arrêter le coaching') + '</button></div>';
    html += renderCoachMessageThread(r.id);
    return html + '</div>';
  }
  function renderCoachTab() {
    var me = currentUserProfile;
    if (!me) return '';
    var html = '<div class="section-title" style="font-size:0.95rem;">Coaching &amp; baptêmes piste</div>' +
      '<div class="help-text" style="margin-bottom:0.8rem;">Un Coach peut proposer un suivi de coaching (pilotes) ou un baptême piste, un tour passager (pilotes et accompagnants) -- clique un créneau du planning ci-dessous pour lui demander directement dessus.</div>';
    html += renderCoachPlanningSection(me);
    var iAmCoach = isCoachBadge(me);
    var myRequests = (STATE.coachRequests || []).filter(function (r) { return r.from === me.name || r.to === me.name; });

    var needsAction = myRequests.filter(function (r) { return r.status === 'pending' && coachRequestAwaitingMe(r, me); });
    if (needsAction.length) {
      var needsActionBody = needsAction.map(function (r) {
        return renderCoachActionRow(r, r.from === me.name ? r.to : r.from);
      }).join('');
      html += collapsibleCard('coach-requests-in', 'Demandes à traiter (' + needsAction.length + ')', needsActionBody, true);
    }

    var waiting = myRequests.filter(function (r) { return r.status === 'pending' && !coachRequestAwaitingMe(r, me); });
    if (waiting.length) {
      var waitingBody = waiting.map(function (r) {
        return renderCoachWaitingRow(r, r.from === me.name ? r.to : r.from);
      }).join('');
      html += collapsibleCard('coach-requests-waiting', 'En attente de réponse (' + waiting.length + ')', waitingBody, true);
    }

    var active = myRequests.filter(function (r) { return r.status === 'accepted'; });
    if (active.length) {
      var activeBody = active.map(function (r) {
        return renderCoachActiveRow(r, r.from === me.name ? r.to : r.from);
      }).join('');
      html += collapsibleCard('coach-active', (iAmCoach ? 'Mes pilotes coachés / baptisés' : 'Mon coaching / baptême') + ' (' + active.length + ')', activeBody, true);
    }

    if (iAmCoach) {
      // Proposer un coaching (pilotes seulement) ou un baptême piste
      // (pilote OU accompagnant, un baptême étant un tour passager --
      // pas de badge séparé, juste une deuxième chose qu'un Coach peut
      // proposer) à n'importe quel compte -- pas besoin d'être amis ou de
      // se suivre, juste un champ de recherche (datalist), moins ceux
      // déjà liés (demande en cours ou déjà coachés/baptisés). Toujours
      // sur un créneau réel de l'événement en cours/à venir, tiré des
      // propres disponibilités déclarées du Coach pour ce type (voir
      // "Définir mes disponibilités" plus haut) -- jamais "à définir plus
      // tard", comme la demande depuis un créneau du planning.
      var linkedNames = myRequests.filter(function (r) { return (r.type || 'coaching') === coachProposeType; })
        .map(function (r) { return r.from === me.name ? r.to : r.from; });
      var proposeRoles = coachProposeType === 'bapteme' ? ['pilote', 'accompagnant'] : ['pilote'];
      var proposeCandidates = allKnownUserNames().filter(function (n) {
        var u = (STATE.usersByName || {})[n] || {};
        return n !== me.name && proposeRoles.indexOf(u.role || 'pilote') !== -1 && linkedNames.indexOf(n) === -1;
      });
      var proposeTarget = targetPlanningEvent();
      var proposeSlots = proposeTarget ? (coachAvailabilityFor(me.name, proposeTarget.ev.id, coachProposeType) || []) : [];
      var proposeSlotObjs = proposeTarget ? allEventSlots(proposeTarget.ev).filter(function (s) { return proposeSlots.indexOf(s.label) !== -1; }) : [];
      var proposeBody = '<label for="coach-propose-type">Type</label>' +
        '<select id="coach-propose-type">' +
        '<option value="coaching"' + (coachProposeType === 'coaching' ? ' selected' : '') + '>Coaching</option>' +
        '<option value="bapteme"' + (coachProposeType === 'bapteme' ? ' selected' : '') + '>Baptême piste</option>' +
        '</select>';
      if (!proposeTarget) {
        proposeBody += '<div class="help-text" style="margin-top:0.5rem;">Aucun événement en cours ou à venir.</div>';
      } else if (!proposeSlotObjs.length) {
        proposeBody += '<div class="help-text" style="margin-top:0.5rem;">Déclare d\'abord tes disponibilités (' + (coachProposeType === 'bapteme' ? 'baptême piste' : 'coaching') + ') sur le planning ci-dessus avant de proposer.</div>';
      } else if (!proposeCandidates.length) {
        proposeBody += '<div class="help-text" style="margin-top:0.5rem;">' +
          (coachProposeType === 'bapteme' ? 'Aucun pilote ou accompagnant disponible pour l\'instant.' : 'Aucun pilote disponible pour l\'instant.') + '</div>';
      } else {
        proposeBody += '<form id="coach-propose-form" style="margin-top:0.6rem;">' +
          '<label for="coach-propose-slot">Créneau</label>' +
          '<select id="coach-propose-slot">' + proposeSlotObjs.map(function (s) { return '<option value="' + escapeHtml(s.label) + '">' + escapeHtml(s.label) + '</option>'; }).join('') + '</select>' +
          '<label for="coach-propose-input" style="margin-top:0.6rem;">' + (coachProposeType === 'bapteme' ? 'Rechercher un pilote ou un accompagnant' : 'Rechercher un pilote') + '</label>' +
          '<input type="text" id="coach-propose-input" list="coach-propose-list" placeholder="Nom" autocomplete="off">' +
          '<datalist id="coach-propose-list">' + proposeCandidates.map(function (n) { return '<option value="' + escapeHtml(n) + '">'; }).join('') + '</datalist>' +
          '<button type="submit" class="primary" style="margin-top:0.7rem;">' + (coachProposeType === 'bapteme' ? 'Proposer le baptême piste' : 'Proposer le coaching') + '</button></form>';
      }
      html += collapsibleCard('coach-propose', 'Proposer un coaching ou un baptême piste', proposeBody, false);
    }

    // Self-service: ask any Coach for regular coaching, with no relation
    // at all yet -- only offered once (a second request would just hit
    // the "already" guard in sendCoachRequest), and not the baptême
    // side, which stays Coach-initiated only per the brief.
    if (!myRequests.length) {
      var coachNames = allKnownUserNames().filter(function (n) { return n !== me.name && isCoachBadge((STATE.usersByName || {})[n]); });
      if (coachNames.length) {
        var selfRequestBody = '<form id="coach-request-form"><label for="coach-request-select">Demander à être coaché par</label>' +
          '<select id="coach-request-select">' + coachNames.map(function (n) { return '<option value="' + escapeHtml(n) + '">' + escapeHtml(n) + '</option>'; }).join('') + '</select>' +
          '<button type="submit" class="primary" style="margin-top:0.7rem;">Envoyer la demande</button></form>';
        html += collapsibleCard('coach-self-request', 'Demander un coaching', selfRequestBody, false);
      }
    }
    return html;
  }

  function renderTeamTab() {
    var me = currentUserProfile;
    if (!me) return '';
    var incoming = (STATE.teamInvites || []).filter(function (r) { return r.status === 'pending' && r.to === me.name; });
    // "Mes Teams" also lists teams this account merely follows, not just
    // those it's a member of -- a plain follower still gets the Team's
    // fiche (renderTeamCard), just with a Team Leader inside gating
    // member-only actions off (see canPost/isMember there).
    var memberTeamIds = (STATE.myTeamMemberships || []).map(function (m) { return m.teamId; });
    var followedOnlyIds = (STATE.myFollowedTeams || []).filter(function (id) { return memberTeamIds.indexOf(id) === -1; });
    var myTeams = memberTeamIds.concat(followedOnlyIds).map(teamById).filter(Boolean)
      .sort(function (a, b) { return a.name.localeCompare(b.name); });

    var html = '';
    if (incoming.length) {
      var incomingBody = incoming.map(function (r) {
        return '<div class="friend-row"><div class="friend-row-main"><span class="friend-name-plain">' + escapeHtml((teamById(r.teamId) || {}).name || r.teamName) + '</span> <span class="help-text">invité par ' + escapeHtml(r.from) + '</span></div>' +
          '<div class="friend-row-actions">' +
          '<button type="button" class="primary" data-action="team-invite-accept" data-id="' + r.id + '">Accepter</button>' +
          '<button type="button" class="ghost" data-action="team-invite-remove" data-id="' + r.id + '">Refuser</button>' +
          '</div></div>';
      }).join('');
      html += collapsibleCard('team-invites-in', 'Invitations reçues (' + incoming.length + ')', incomingBody, true);
    }
    // "Invitations envoyées" (this account inviting others into a team it
    // leads) moved into that team's own "Inviter" section (renderTeamCard)
    // instead of sitting here, unscoped, right under the header -- it's
    // per-team info, not something to show before you've even picked one.

    if (!myTeams.length) {
      html += '<div class="card"><div class="empty-state">Pas encore de team -- crée-en un, rejoins-en un depuis "Découvrir des Teams" ci-dessous, ou attends une invitation.</div></div>';
    } else {
      // Clean grid of small "encadrés" first -- clicking one opens its
      // full detail (feed, membres, réglages) below, one at a time, so
      // the tab stays uncluttered instead of every team's whole content
      // always being on screen at once. Hidden entirely once drilled into
      // a Team (or one of its events) -- it's the Team space's own home
      // screen, not something to keep scrolling past once you're already
      // deep in a specific Team/Event.
      if (!expandedTeamId) {
        html += '<h2 class="section-title">Mes Teams</h2>';
        html += '<div class="team-tile-grid">' + myTeams.map(function (t) {
          var label = isLeaderOfTeam(t.id) ? 'Team Leader' : (memberTeamIds.indexOf(t.id) !== -1 ? 'Membre' : 'Follower');
          var tag = '<span class="friend-role-badge">' + label + '</span>';
          return renderTeamTile(t, tag, true);
        }).join('') + '</div>';
      }

      var expandedTeam = expandedTeamId ? myTeams.filter(function (t) { return t.id === expandedTeamId; })[0] : null;
      if (expandedTeam) {
        // No teamId restriction here on purpose -- managingEventId can
        // point at a cross-team event opened read-only from the cross-team
        // list below (see renderTeamEventsManagement), not just one this
        // Team itself organizes. renderEventManagementScreen figures out
        // canEdit on its own from the event's actual teamId.
        var managingEvent = managingEventId
          ? (STATE.events || []).filter(function (e) { return e.id === managingEventId; })[0]
          : null;
        if (managingEvent) {
          html += '<div style="margin-top:1rem;">' +
            '<button type="button" class="ghost" data-action="event-manage-close" style="margin-bottom:0.6rem;">← Retour à ' + escapeHtml(expandedTeam.name) + '</button>' +
            renderEventManagementScreen(managingEvent, expandedTeam) +
            '</div>';
        } else {
          html += '<div style="margin-top:1rem;">' +
            '<button type="button" class="ghost" data-action="team-tile-close" style="margin-bottom:0.6rem;">← Retour aux Teams</button>' +
            renderTeamCard(expandedTeam, me) +
            '</div>';
        }
      }
      // Shared by every team card's 📷 button -- only one photo picker is
      // ever open at a time, so one hidden input covers them all (see
      // teamPostDraftPhotoTeamId).
      html += '<input type="file" id="team-feed-photo-input" accept="image/*" style="display:none;">';
      html += '<input type="file" id="team-photo-input" accept="image/*" style="display:none;">';
      html += '<input type="file" id="team-logo-input" accept="image/*" style="display:none;">';
    }
    // Same reasoning as the tile grid above -- Découvrir des Teams/Créer
    // un Team belong on the Team space's home screen, not trailing behind
    // whatever specific Team/Event you've drilled into.
    if (!expandedTeamId) {
      html += renderTeamDiscovery(me, myTeams);
      html += renderCreateTeamCard();
    }
    return html;
  }

  // A small, clean "encadré" for one Team -- photo, name, member/like
  // counts, a short description -- shared by "Mes Teams" (clickable, see
  // expandedTeamId) and "Découvrir des Teams" (informational + action
  // buttons only, see renderTeamDiscoveryTile). memberCount comes off the
  // team doc itself (see bumpTeamMemberCount) rather than a live count of
  // membersOfTeam(), which is only ever synced for teams this account is
  // actually in -- a discoverable team it isn't in has no such data.
  function renderTeamTile(t, innerActionsHtml, clickable) {
    var likeCount = (STATE.teamLikes || []).filter(function (l) { return l.teamId === t.id; }).length;
    // teamMembersByTeam (the real roster) is only ever synced for teams
    // this account is actually in (see refreshTeamDetailSync), which
    // covers every tile in "Mes Teams" (team-tile-grid) -- but a
    // discoverable team it isn't in has no such data, so those tiles
    // fall back to t.memberCount, a denormalized counter kept in sync via
    // atomic increments/decrements (see bumpTeamMemberCount).
    var memberCount = ((STATE.teamMembersByTeam || {})[t.id] || []).length || t.memberCount || 0;
    var desc = t.description ? '<div class="team-tile-desc">' + escapeHtml(t.description) + '</div>' : '';
    var mainInner = avatarHtml(t, t.name) +
      '<div class="team-tile-name">' + escapeHtml(t.name) + teamBadgesHtml(t) + '</div>' +
      desc +
      '<div class="team-tile-stats">' + memberCount + ' membre' + (memberCount === 1 ? '' : 's') + ' · ❤ ' + likeCount + '</div>';
    var main = clickable
      ? '<button type="button" class="team-tile-main" data-action="team-tile-open" data-team="' + t.id + '">' + mainInner + '</button>'
      : '<div class="team-tile-main">' + mainInner + '</div>';
    return '<div class="team-tile">' + main +
      (innerActionsHtml ? '<div class="team-tile-actions">' + innerActionsHtml + '</div>' : '') +
      '</div>';
  }

  // A team only shows up here once its Team Leader opts it into being
  // findable (team.visibility, set from that team's own Réglages) --
  // 'private' (the default) never appears. "Suivre" is a one-way follow
  // (see followName/toggleReaction's sibling functions), not membership --
  // it doesn't add you to the roster or its feed, just marks the team as
  // one you keep an eye on. Joining is member-only from here -- adherent
  // is never requested directly, only granted afterwards by a Team
  // Leader (see requestJoinTeam).
  function renderTeamDiscoveryTile(t, me, showUnfollow) {
    var iLike = (STATE.teamLikes || []).some(function (l) { return l.teamId === t.id && l.name === me.name; });
    var myRequest = (STATE.teamJoinRequests || []).filter(function (r) { return r.teamId === t.id && r.from === me.name; })[0];
    var actions = '<button type="button" class="ghost icon-btn' + (iLike ? ' liked' : '') + '" data-action="team-like-toggle" data-team="' + t.id + '" aria-label="' + (iLike ? 'Retirer le like' : 'Liker') + '" title="' + (iLike ? 'Retirer le like' : 'Liker') + '">❤</button>';
    actions += showUnfollow
      ? '<button type="button" class="ghost icon-btn" data-action="unfollow-team" data-team="' + t.id + '" aria-label="Ne plus suivre" title="Ne plus suivre">×</button>'
      : '<button type="button" class="ghost" data-action="follow-team" data-team="' + t.id + '">Suivre</button>';
    // A Team Leader never needs to request to join a team it already
    // leads -- guarded directly on role rather than relying solely on
    // discoverable's myTeamIds filter above, so a leader whose
    // membership sync momentarily lags never sees "Rejoindre" on their
    // own team.
    if (!isLeaderOfTeam(t.id)) {
      actions += myRequest
        ? '<span class="help-text">Demande envoyée</span>'
        : '<button type="button" class="ghost" data-action="team-join-request" data-team="' + t.id + '">Rejoindre</button>';
    }
    return renderTeamTile(t, actions, false);
  }

  function renderTeamDiscovery(me, myTeams) {
    var myTeamIds = myTeams.map(function (t) { return t.id; });
    // "Mes Teams" above already lists every team this account follows
    // (see renderTeamTab), with a real, clickable fiche -- so a followed
    // team never needs its own smaller "Teams suivis" tile here too.
    var followedTeamIds = (STATE.myFollowedTeams || []).filter(function (id) { return myTeamIds.indexOf(id) === -1; });
    var discoverable = (STATE.teams || []).filter(function (t) {
      if (myTeamIds.indexOf(t.id) !== -1) return false;
      if (t.visibility === 'all') return true;
      if (t.visibility === 'pro') return isPro(me);
      if (t.visibility === 'certified') return isCertified(me);
      return false;
    }).sort(function (a, b) { return a.name.localeCompare(b.name); });
    if (!discoverable.length && !followedTeamIds.length) return '';
    var body = '';
    if (followedTeamIds.length) {
      body += '<div class="team-section-title">Teams suivis</div><div class="team-tile-grid">';
      body += followedTeamIds.map(function (id) {
        var t = teamById(id);
        return t ? renderTeamDiscoveryTile(t, me, true) : '';
      }).join('') + '</div>';
    }
    var toSuggest = discoverable.filter(function (t) { return followedTeamIds.indexOf(t.id) === -1; });
    if (toSuggest.length) {
      body += '<div class="team-section-title">À découvrir</div><div class="team-tile-grid">';
      body += toSuggest.map(function (t) { return renderTeamDiscoveryTile(t, me, false); }).join('') + '</div>';
    }
    return collapsibleCard('team-discovery', 'Découvrir des Teams', body, false);
  }

  function renderRoot() {
    try {
      renderRootUnsafe();
    } catch (err) {
      if (window.console) console.error('renderRoot failed', err);
      var root = document.getElementById('root');
      if (root) {
        root.innerHTML = '<div class="card"><h2 class="section-title">Erreur d\'affichage</h2>' +
          '<p>Quelque chose a mal tourné en construisant la page. Envoie ce message tel quel :</p>' +
          '<pre style="white-space:pre-wrap; word-break:break-word; font-size:0.78rem; background:var(--surface-alt); padding:0.8rem; border-radius:8px;">' +
          escapeHtml((err && err.stack) || String(err)) + '</pre></div>';
      }
    }
  }

  function renderRootUnsafe() {
    var root = document.getElementById('root');
    // Snapshot every collapsible <details>' current open/closed state right
    // before the DOM under it gets torn down (root.innerHTML replaced
    // below) -- relying solely on their 'toggle' event listener (see
    // attachHandlers) missed cases where a *different* action elsewhere on
    // the page (e.g. clicking an unrelated Enregistrer button) triggered a
    // re-render: nothing had toggled, so nothing had fired, but the old
    // <details> were still open and about to be destroyed. This makes sure
    // planningSectionsOpen always reflects reality at render time, not just
    // at the last manual toggle.
    document.querySelectorAll('[data-planning-section]').forEach(function (details) {
      planningSectionsOpen[details.getAttribute('data-planning-section')] = details.open;
    });
    document.body.classList.toggle('has-bottom-nav', authState === 'signed-in');
    if (authState !== 'signed-in') {
      var authBody;
      if (authState === 'loading') authBody = '<div class="card auth-card"><div class="empty-state">Connexion...</div></div>';
      else if (authState === 'verify-email') authBody = renderVerifyEmailScreen();
      else authBody = renderAuthScreen();
      root.innerHTML =
        '<header class="page-head"><div class="page-head-inner"><h1 class="title">Carnet de Piste</h1></div></header>' +
        '<div class="auth-screen">' + authBody + '</div>';
      attachAuthHandlers();
      updateFixedHeaderOffset();
      return;
    }
    normalizeSelection();
    // root.innerHTML is fully replaced below, which would otherwise drop
    // focus (and the cursor position) out of a text input on every single
    // keystroke for any live-filter-as-you-type field -- restored after
    // attachHandlers() runs, same element by id.
    var focusedId = null, focusedSelection = null;
    var activeEl = document.activeElement;
    if (activeEl && activeEl.id && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA')) {
      focusedId = activeEl.id;
      if (typeof activeEl.selectionStart === 'number') focusedSelection = [activeEl.selectionStart, activeEl.selectionEnd];
    }
    // Mon profil (and its own Gestion des comptes sub-page) and
    // Notifications each now take over the whole content area as their
    // own page -- replacing the current tab's content instead of
    // stacking above it, which used to pile both on screen at once and
    // read as one long undifferentiated block.
    var body;
    if (profilePanelOpen) {
      body = accountManagerOpen ? renderAccountManagerPanel() : renderProfilePanel();
    } else if (notificationsPanelOpen) {
      body = renderNotificationsPanel();
    } else if (activeView === 'circuit') body = renderCircuitTab();
    else if (activeView === 'stats') body = renderStatsTab();
    else if (activeView === 'planning') body = renderPlanningTab();
    else if (activeView === 'social') body = renderSocialTab();
    else if (activeView === 'team') body = renderTeamTab();
    else if (activeView === 'coach') body = renderCoachTab();
    else body = renderEventTab(); // 'event' and safety fallback
    var notifCount = pendingNotificationCount();
    root.innerHTML =
      '<header class="page-head">' +
        '<div class="page-head-inner">' +
          '<div class="page-head-row">' +
            '<h1 class="title">Carnet de Piste</h1>' +
            '<div class="header-controls">' +
              (canAccessCoachSpace() ? '<button type="button" class="header-icon-btn' + (activeView === 'coach' ? ' active' : '') + '" data-view="coach" aria-label="Coach" title="Coach">🎓</button>' : '') +
              '<button type="button" class="header-icon-btn' + (activeView === 'stats' ? ' active' : '') + '" data-view="stats" aria-label="Stats" title="Stats">📊</button>' +
              '<button type="button" class="header-icon-btn" id="notifications-toggle" aria-label="Notifications" title="Notifications">🔔' +
                (notifCount ? '<span class="notif-count">' + (notifCount > 9 ? '9+' : notifCount) + '</span>' : '') +
              '</button>' +
              '<button type="button" class="profile-badge-btn" id="profile-toggle" aria-label="Mon profil" title="Mon profil">' + avatarHtml(currentUserProfile, currentUserProfile.name) + '</button>' +
            '</div>' +
          '</div>' +
          '<div class="banner" id="status-banner"></div>' +
        '</div>' +
      '</header>' +
      body +
      renderBottomNav() +
      renderCropModal() +
      renderTutorialOverlay() +
      renderFeelingModal() +
      renderCoachSlotModal();
    attachHandlers();
    if (focusedId) {
      var toRefocus = document.getElementById(focusedId);
      if (toRefocus) {
        toRefocus.focus();
        if (focusedSelection && typeof toRefocus.setSelectionRange === 'function') {
          try { toRefocus.setSelectionRange(focusedSelection[0], focusedSelection[1]); } catch (e) {}
        }
      }
    }
    updateBanner();
    updateFixedHeaderOffset();
    saveUiState();
    updateLiveClock();
  }

  // ---- Comptes (Pilote / Accompagnant) ----
  //
  // Real Firebase accounts (email/password), one profile doc per uid in
  // 'users'. Gates the whole app: nothing renders until authState is
  // 'signed-in' and the profile doc has loaded (see init()'s
  // onAuthStateChanged and onSignupSubmit below).
  // A freshly created account (or an old one from before this check
  // existed) can't do anything until its email is confirmed -- otherwise
  // any bot can "sign up" with a throwaway address and start writing.
  // Firestore rules enforce this server-side too (email_verified on every
  // write except a user's own profile, which has to be writable right
  // after signup, before there's been time to verify anything).
  function renderVerifyEmailScreen() {
    var email = (auth.currentUser && auth.currentUser.email) || 'ton adresse';
    var html = '<div class="card auth-card">';
    html += '<h2 class="section-title">Vérifie ton email</h2>';
    html += '<p class="help-text">Un email de vérification a été envoyé à <strong>' + escapeHtml(email) + '</strong>. Clique sur le lien qu\'il contient, puis reviens ici. Pense à vérifier tes spams/courriers indésirables si tu ne le vois pas — l\'expéditeur est une adresse @firebaseapp.com.</p>';
    html += '<div class="field-error' + (authError ? ' visible' : '') + '" id="auth-error">' + escapeHtml(authError) + '</div>';
    html += '<div style="margin-top:0.9rem; display:flex; gap:0.6rem; flex-wrap:wrap;">' +
      '<button type="button" class="primary" id="verify-check-btn">J\'ai vérifié, continuer</button>' +
      '<button type="button" class="ghost" id="verify-resend-btn">Renvoyer l\'email</button>' +
      '</div>';
    html += '<div class="help-text" style="margin-top:0.9rem;"><button type="button" class="auth-link" id="verify-logout-btn">Se déconnecter</button></div>';
    html += '</div>';
    return html;
  }

  function renderAuthScreen() {
    var html = '<div class="card auth-card">';
    if (authMode === 'signup') {
      html += '<h2 class="section-title">Créer un compte</h2>';
      html += '<form id="signup-form" novalidate>';
      html += '<label for="au-name">Pseudo</label><input type="text" id="au-name" name="name" autocomplete="username" placeholder="Ex. Julien #12" required>';
      html += '<div class="help-text" style="margin-top:0.2rem;">C\'est ce pseudo qu\'il faudra retaper pour se connecter -- en cas de doublon, ajoute ton numéro de course (ex. "Julien #12").</div>';
      html += '<label style="margin-top:0.7rem;">Je suis</label><div class="auth-role-choice">' +
        '<label><input type="radio" name="au-role" value="pilote" checked> Pilote</label>' +
        '<label><input type="radio" name="au-role" value="accompagnant"> Accompagnant</label>' +
        '<label><input type="radio" name="au-role" value="organisateur"> Organisateur</label></div>';
      html += '<label for="au-email" style="margin-top:0.7rem;">Email</label><input type="email" id="au-email" name="email" autocomplete="username" required>';
      html += '<label for="au-password" style="margin-top:0.7rem;">Mot de passe</label><input type="password" id="au-password" name="new-password" autocomplete="new-password" required minlength="6">';
      html += '<div class="field-error' + (authError ? ' visible' : '') + '" id="auth-error">' + escapeHtml(authError) + '</div>';
      html += '<button type="submit" class="primary" style="margin-top:0.9rem;">Créer mon compte</button>';
      html += '</form>';
      html += '<div class="help-text" style="margin-top:0.9rem;">Déjà un compte ?<br><button type="button" class="auth-link" id="switch-to-login">Se connecter</button></div>';
    } else {
      html += '<h2 class="section-title">Connexion</h2>';
      html += '<form id="login-form" novalidate>';
      html += '<label for="au-email">Email ou pseudo</label><input type="text" id="au-email" name="email" autocomplete="username" required>';
      html += '<div class="help-text" style="margin-top:0.2rem;">Avec le pseudo, retape-le exactement comme à l\'inscription, numéro de course compris (ex. "Julien #12").</div>';
      html += '<label for="au-password" style="margin-top:0.7rem;">Mot de passe</label><input type="password" id="au-password" name="password" autocomplete="current-password" required>';
      html += '<label class="checklist-item" style="margin-top:0.6rem;"><input type="checkbox" id="au-remember" checked> Se souvenir de moi</label>';
      html += '<div class="field-error' + (authError ? ' visible' : '') + '" id="auth-error">' + escapeHtml(authError) + '</div>';
      html += '<button type="submit" class="primary" style="margin-top:0.9rem;">Se connecter</button>';
      html += '</form>';
      html += '<div class="help-text" style="margin-top:0.9rem;">Pas encore de compte ?<br><button type="button" class="auth-link" id="switch-to-signup">Créer un compte</button></div>';
      html += '<div class="help-text" style="margin-top:0.4rem;"><button type="button" class="auth-link" id="forgot-password-btn">Mot de passe oublié ?</button></div>';
    }
    html += '</div>';
    return html;
  }

  function translateAuthError(err) {
    var code = err && err.code;
    if (code === 'auth/email-already-in-use') return 'Cet email est déjà utilisé — connecte-toi plutôt.';
    if (code === 'auth/invalid-email') return 'Email invalide.';
    if (code === 'auth/weak-password') return 'Mot de passe trop court (6 caractères minimum).';
    // Kept distinct from "mot de passe incorrect" below -- this one means
    // the pseudo→email lookup itself found nothing, which otherwise
    // surfaced as a misleading "wrong password" even when the password
    // typed was actually correct (see resolveLoginIdentifier).
    if (code === 'custom/pseudo-not-found') return err.message;
    if (code === 'auth/wrong-password' || code === 'auth/user-not-found' || code === 'auth/invalid-credential') return 'Email ou mot de passe incorrect.';
    if (code === 'auth/too-many-requests') return 'Trop de tentatives — attends quelques minutes avant de renvoyer l\'email.';
    return 'Erreur : ' + ((err && err.message) || err);
  }

  // Connexion par pseudo (en plus de l'email) -- le pseudo (users.name)
  // n'est pas une adresse email, Firebase Auth ne peut signer qu'avec un
  // email, donc on le résout d'abord vers l'email associé via une lecture
  // Firestore. Cette lecture nécessite d'être authentifié (voir
  // firestore.rules users: allow read: if request.auth != null) alors
  // qu'on ne l'est pas encore -- un aller-retour anonyme le temps de la
  // résolution (même mécanisme que rename-organizer.html) le permet sans
  // ouvrir la lecture des emails à tout le monde. onAuthStateChanged
  // ignore les users anonymes (voir init()) donc ce passage est invisible.
  function resolveLoginIdentifier(identifier) {
    if (identifier.indexOf('@') !== -1) return Promise.resolve(identifier);
    return auth.signInAnonymously().then(function () {
      return db.collection('users').where('name', '==', identifier).limit(1).get();
    }).then(function (snap) {
      if (!snap.empty) return snap.docs[0].data().email;
      // Query exacte d'abord (rapide) -- secours insensible à la casse
      // seulement si rien trouvé, en relisant toute la collection (petite
      // base, pas d'index composé pour une comparaison lowercase).
      return db.collection('users').get().then(function (allSnap) {
        var match = null;
        allSnap.forEach(function (doc) {
          var n = (doc.data().name || '').trim();
          if (n && n.toLowerCase() === identifier.toLowerCase()) match = doc.data();
        });
        return match && match.email;
      });
    }).then(function (email) {
      if (!email) {
        // Distinct from a genuine wrong-password rejection (see
        // translateAuthError) -- this means no account's pseudo matched
        // at all, so blaming the password would be misleading.
        return Promise.reject({ code: 'custom/pseudo-not-found', message: 'Aucun compte avec le pseudo "' + identifier + '" -- vérifie l\'orthographe exacte, ou connecte-toi avec ton email.' });
      }
      return email;
    });
  }

  function onLoginSubmit(evt) {
    evt.preventDefault();
    justAuthenticated = true;
    var identifier = document.getElementById('au-email').value.trim();
    var password = document.getElementById('au-password').value;
    var rememberEl = document.getElementById('au-remember');
    var remember = !rememberEl || rememberEl.checked;
    authError = '';
    // LOCAL survives closing the browser entirely; SESSION clears the
    // moment the tab/browser closes -- unchecking "Se souvenir de moi" is
    // for a shared/public device where the next person shouldn't land
    // straight in someone else's account.
    auth.setPersistence(remember ? firebase.auth.Auth.Persistence.LOCAL : firebase.auth.Auth.Persistence.SESSION).then(function () {
      return resolveLoginIdentifier(identifier);
    }).then(function (email) {
      return auth.signInWithEmailAndPassword(email, password);
    }).catch(function (err) {
      authError = translateAuthError(err);
      renderRoot();
    });
  }

  function onSignupSubmit(evt) {
    evt.preventDefault();
    justAuthenticated = true;
    var roleEl = document.querySelector('input[name="au-role"]:checked');
    var role = roleEl ? roleEl.value : 'pilote';
    var rawName = document.getElementById('au-name').value.trim();
    var email = document.getElementById('au-email').value.trim();
    var password = document.getElementById('au-password').value;
    if (!rawName) {
      authError = 'Indique ton pseudo.';
      renderRoot();
      return;
    }
    authError = '';
    var name = rawName;
    auth.createUserWithEmailAndPassword(email, password).then(function (cred) {
      // STATE.riders isn't synced yet at this point (that only starts once
      // signed in) -- a live query is the only way to check for a homonym
      // before this account claims the name. Skipped for accompagnant:
      // they're not a rider, so there's nothing to collide with.
      var collisionCheck = role === 'pilote'
        ? db.collection('riders').get().then(function (snap) {
            return snap.docs.map(function (d) { return d.data().name; });
          })
        : Promise.resolve([]);
      return collisionCheck.then(function (existingNames) {
        var result = resolveUniquePseudo(rawName, existingNames, null);
        if (!result.ok) {
          // The auth account already exists at this point -- back it out
          // rather than leave an orphaned, nameless account behind.
          return cred.user.delete().then(function () {
            return Promise.reject({ code: 'custom/name-collision', message: result.error });
          });
        }
        name = result.name;
        var profileDoc = { name: name, role: role, email: email, notifyBeforeSession: true };
        // A parrain can't refer themselves -- someone opening their own
        // link and signing up under the same name shouldn't count.
        if (pendingReferrer && pendingReferrer !== name) profileDoc.referredBy = pendingReferrer;
        return db.collection('users').doc(cred.user.uid).set(profileDoc).then(function () {
          if (role === 'pilote') {
            return db.collection('riders').doc(safeDocId(name)).set({ name: name }, { merge: true });
          }
        }).then(function () {
          return cred.user.sendEmailVerification();
        });
      });
    }).then(function () {
      // Held at 'verify-email' -- the account and profile both exist, but
      // nothing writable happens until the address is confirmed (bots
      // shouldn't be able to just type in someone's email and start
      // editing sorties). currentUserProfile is set directly here rather
      // than waiting on onAuthStateChanged's own profile fetch, since that
      // fetch can race this document write.
      currentUserProfile = { name: name, role: role, email: email };
      authState = 'verify-email';
      autoVerifyEmailSent = true; // already sent just above -- don't let onAuthStateChanged send a second one
      renderRoot();
      showToast('Compte créé — vérifie ton email pour continuer.', 'success');
    }).catch(function (err) {
      authError = (err && err.code === 'custom/name-collision') ? err.message : translateAuthError(err);
      renderRoot();
    });
  }

  function checkEmailVerified() {
    var user = auth.currentUser;
    if (!user) return;
    user.reload().then(function () {
      if (user.emailVerified) {
        authError = '';
        // Force-refresh the ID token so Firestore rules see
        // email_verified=true on the very next write, instead of
        // whatever was cached from before verification.
        return user.getIdToken(true).then(function () {
          return db.collection('users').doc(user.uid).get();
        }).then(function (doc) {
          if (doc.exists) currentUserProfile = doc.data();
          authState = 'signed-in';
          canPersist = true;
          activeView = 'planning';
          profilePanelOpen = false;
          justAuthenticated = false;
          startSync();
          renderRoot();
        });
      }
      authError = 'Pas encore vérifié — clique sur le lien reçu par email, puis réessaie.';
      renderRoot();
    });
  }

  function attachAuthHandlers() {
    var loginForm = document.getElementById('login-form');
    if (loginForm) loginForm.addEventListener('submit', onLoginSubmit);
    var signupForm = document.getElementById('signup-form');
    if (signupForm) signupForm.addEventListener('submit', onSignupSubmit);
    var toSignup = document.getElementById('switch-to-signup');
    if (toSignup) toSignup.addEventListener('click', function () { authMode = 'signup'; authError = ''; renderRoot(); });
    var toLogin = document.getElementById('switch-to-login');
    if (toLogin) toLogin.addEventListener('click', function () { authMode = 'login'; authError = ''; renderRoot(); });
    var forgotBtn = document.getElementById('forgot-password-btn');
    if (forgotBtn) {
      forgotBtn.addEventListener('click', function () {
        var email = document.getElementById('au-email').value.trim();
        if (!email) {
          authError = 'Indique ton email d\'abord, puis clique à nouveau sur "Mot de passe oublié ?".';
          renderRoot();
          return;
        }
        auth.sendPasswordResetEmail(email).then(function () {
          authError = '';
          showToast('Email de réinitialisation envoyé à ' + email + '.', 'success');
        }).catch(function (err) {
          authError = translateAuthError(err);
          renderRoot();
        });
      });
    }
    var verifyCheckBtn = document.getElementById('verify-check-btn');
    if (verifyCheckBtn) verifyCheckBtn.addEventListener('click', checkEmailVerified);
    var verifyResendBtn = document.getElementById('verify-resend-btn');
    if (verifyResendBtn) {
      verifyResendBtn.addEventListener('click', function () {
        if (!auth.currentUser) return;
        auth.currentUser.sendEmailVerification().then(function () {
          showToast('Email renvoyé à ' + auth.currentUser.email + '.', 'success');
        }).catch(function (err) {
          authError = translateAuthError(err);
          renderRoot();
        });
      });
    }
    var verifyLogoutBtn = document.getElementById('verify-logout-btn');
    if (verifyLogoutBtn) verifyLogoutBtn.addEventListener('click', function () { auth.signOut(); });
  }

  var pendingDelete = null;
  var pendingDeleteEvent = null;
  var pendingDeleteChecklistCategory = null;
  var profilePanelOpen = false; // pure UI state, not persisted
  var notificationsPanelOpen = false; // pure UI state, not persisted
  var profileSubTab = 'profil'; // 'profil' | 'reglages' | 'aide' -- pure UI state, not persisted
  var profileDeleteConfirmOpen = false; // pure UI state, not persisted
  var riderManagerOpen = false; // pure UI state, not persisted
  var editingRiderName = null; // rider currently shown as an inline rename form, or null
  var pendingDeleteRider = null; // rider armed for delete (click-to-confirm, like session delete)
  var pendingLeaderToggle = null; // { team, name, on } -- click-to-arm/click-to-confirm for granting/revoking Team Leader, replaces a window.confirm()
  var riderManagerError = ''; // validation/blocking message shown in the panel

  function attachHandlers() {
    var logoutBtn = document.getElementById('logout-btn');
    if (logoutBtn) logoutBtn.addEventListener('click', function () { auth.signOut(); });
    // Badges (compte certifié, Team PRO, chrono vérifié...) are icon-only,
    // so their explanation normally only shows on hover (title=...) -- no
    // way to hover on mobile. Tapping one shows the same text as a toast,
    // which works identically on touch and desktop.
    document.querySelectorAll('[data-badge-info]').forEach(function (el) {
      el.addEventListener('click', function () { showToast(el.getAttribute('data-badge-info')); });
    });
    document.querySelectorAll('[data-action="copy-location"]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var text = btn.getAttribute('data-text') || '';
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(function () {
            showToast('Adresse copiée.', 'success');
          }).catch(function () {
            showToast('Impossible de copier — copie-la manuellement.');
          });
        }
      });
    });
    document.querySelectorAll('[data-action="open-maps"]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var text = btn.getAttribute('data-text') || '';
        window.open('https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(text), '_blank', 'noopener');
      });
    });
    document.querySelectorAll('[data-action="open-waze"]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var text = btn.getAttribute('data-text') || '';
        window.open('https://waze.com/ul?q=' + encodeURIComponent(text) + '&navigate=yes', '_blank', 'noopener');
      });
    });
    var profileToggle = document.getElementById('profile-toggle');
    if (profileToggle) {
      profileToggle.addEventListener('click', function () {
        profilePanelOpen = !profilePanelOpen;
        notificationsPanelOpen = false;
        if (!profilePanelOpen) accountManagerOpen = false;
        profileSaveMessage = '';
        renderRoot();
      });
    }
    var notificationsToggle = document.getElementById('notifications-toggle');
    if (notificationsToggle) {
      notificationsToggle.addEventListener('click', function () {
        notificationsPanelOpen = !notificationsPanelOpen;
        profilePanelOpen = false;
        renderRoot();
      });
    }
    // In the Réglages tab (no surrounding <form>, no Enregistrer button) --
    // saves immediately on toggle, unlike the Profil tab's fields.
    var reglagesNotify = document.getElementById('profile-notify');
    if (reglagesNotify && !document.getElementById('profile-form')) {
      reglagesNotify.addEventListener('change', function () {
        var p = currentUserProfile;
        saveProfile(p.role, reglagesNotify.checked, p.followedRiders || [], p.bike, p.bikeNumber, p.name, p.firstName || '', p.lastName || '', p.chronoLink || '');
        showToast(reglagesNotify.checked ? 'Notifications activées.' : 'Notifications désactivées.', 'success');
      });
    }
    var notifyInvitesEl = document.getElementById('profile-notify-invites');
    if (notifyInvitesEl) {
      notifyInvitesEl.addEventListener('change', function () { saveOwnBooleanField('notifyInvites', notifyInvitesEl.checked); });
    }
    var notifyTeamNewsEl = document.getElementById('profile-notify-team-news');
    if (notifyTeamNewsEl) {
      notifyTeamNewsEl.addEventListener('change', function () { saveOwnBooleanField('notifyTeamNews', notifyTeamNewsEl.checked); });
    }
    var notifyAdherentRequestsEl = document.getElementById('profile-notify-adherent-requests');
    if (notifyAdherentRequestsEl) {
      notifyAdherentRequestsEl.addEventListener('change', function () { saveOwnBooleanField('notifyAdherentRequests', notifyAdherentRequestsEl.checked); });
    }
    var notifyRequestDecisionsEl = document.getElementById('profile-notify-request-decisions');
    if (notifyRequestDecisionsEl) {
      notifyRequestDecisionsEl.addEventListener('change', function () { saveOwnBooleanField('notifyRequestDecisions', notifyRequestDecisionsEl.checked); });
    }
    var notifyChronoCertifiedEl = document.getElementById('profile-notify-chrono-certified');
    if (notifyChronoCertifiedEl) {
      notifyChronoCertifiedEl.addEventListener('change', function () { saveOwnBooleanField('notifyChronoCertified', notifyChronoCertifiedEl.checked); });
    }
    var notifyReactionsEl = document.getElementById('profile-notify-reactions');
    if (notifyReactionsEl) {
      notifyReactionsEl.addEventListener('change', function () { saveOwnBooleanField('notifyReactions', notifyReactionsEl.checked); });
    }
    var notifyProOutingsEl = document.getElementById('profile-notify-pro-outings');
    if (notifyProOutingsEl) {
      notifyProOutingsEl.addEventListener('change', function () { saveOwnBooleanField('notifyProOutings', notifyProOutingsEl.checked); });
    }
    var notifyCoachMessagesEl = document.getElementById('profile-notify-coach-messages');
    if (notifyCoachMessagesEl) {
      notifyCoachMessagesEl.addEventListener('change', function () { saveOwnBooleanField('notifyCoachMessages', notifyCoachMessagesEl.checked); });
    }
    var notifyEventAnnouncementsEl = document.getElementById('profile-notify-event-announcements');
    if (notifyEventAnnouncementsEl) {
      notifyEventAnnouncementsEl.addEventListener('change', function () { saveOwnBooleanField('notifyEventAnnouncements', notifyEventAnnouncementsEl.checked); });
    }
    var notifyEventEndedEl = document.getElementById('profile-notify-event-ended');
    if (notifyEventEndedEl) {
      notifyEventEndedEl.addEventListener('change', function () { saveOwnBooleanField('notifyEventEndedReaction', notifyEventEndedEl.checked); });
    }
    var feelingEnabledEl = document.getElementById('profile-feeling-enabled');
    if (feelingEnabledEl) {
      feelingEnabledEl.addEventListener('change', function () { saveOwnBooleanField('sessionFeelingEnabled', feelingEnabledEl.checked); });
    }
    var shareSortiesEl = document.getElementById('profile-share-sorties');
    if (shareSortiesEl) {
      shareSortiesEl.addEventListener('change', function () { saveOwnBooleanField('shareSorties', shareSortiesEl.checked); });
    }
    var shareTropheesEl = document.getElementById('profile-share-trophees');
    if (shareTropheesEl) {
      shareTropheesEl.addEventListener('change', function () { saveOwnBooleanField('shareTrophees', shareTropheesEl.checked); });
    }
    var shareTravelInfoEl = document.getElementById('profile-share-travel-info');
    if (shareTravelInfoEl) {
      shareTravelInfoEl.addEventListener('change', function () { saveOwnBooleanField('shareTravelInfo', shareTravelInfoEl.checked); });
    }
    document.querySelectorAll('[data-self-badge]').forEach(function (cb) {
      cb.addEventListener('change', function () { saveOwnBooleanField(cb.getAttribute('data-self-badge'), cb.checked); });
    });
    document.querySelectorAll('[data-profile-tab]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        profileSubTab = btn.getAttribute('data-profile-tab');
        renderRoot();
      });
    });
    var accountManagerToggle = document.getElementById('account-manager-toggle');
    if (accountManagerToggle) {
      accountManagerToggle.addEventListener('click', function () {
        accountManagerOpen = !accountManagerOpen;
        if (accountManagerOpen && manageableAccounts === null) loadManageableAccounts();
        renderRoot();
      });
    }
    var accountManagerBack = document.getElementById('account-manager-back');
    if (accountManagerBack) {
      accountManagerBack.addEventListener('click', function () {
        accountManagerOpen = false;
        renderRoot();
      });
    }
    document.querySelectorAll('[data-action="demote-account"]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var uid = btn.getAttribute('data-uid');
        var account = (manageableAccounts || []).filter(function (a) { return a.uid === uid; })[0];
        if (!account) return;
        db.collection('users').doc(uid).set({ role: 'pilote' }, { merge: true }).then(function () {
          if (account.name) return db.collection('riders').doc(safeDocId(account.name)).set({ name: account.name }, { merge: true });
        }).then(function () {
          manageableAccounts = manageableAccounts.filter(function (a) { return a.uid !== uid; });
          showToast(account.name + ' est maintenant Pilote.', 'success');
          renderRoot();
        }).catch(function (err) {
          accountManagerError = 'Erreur : ' + (err && err.message ? err.message : err);
          renderRoot();
        });
      });
    });
    document.querySelectorAll('[data-action="delete-account-request"]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var uid = btn.getAttribute('data-uid');
        if (pendingDeleteAccountUid === uid) {
          db.collection('users').doc(uid).delete().then(function () {
            manageableAccounts = manageableAccounts.filter(function (a) { return a.uid !== uid; });
            pendingDeleteAccountUid = null;
            showToast('Accès retiré.', 'success');
            renderRoot();
          }).catch(function (err) {
            accountManagerError = 'Erreur : ' + (err && err.message ? err.message : err);
            renderRoot();
          });
        } else {
          pendingDeleteAccountUid = uid;
          renderRoot();
        }
      });
    });
    document.querySelectorAll('[data-action="toggle-account-badge"]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var uid = btn.getAttribute('data-uid');
        var field = btn.getAttribute('data-field');
        var badge = PROFILE_BADGES.filter(function (b) { return b.field === field; })[0];
        var account = (manageableAccounts || []).filter(function (a) { return a.uid === uid; })[0];
        if (!account || !badge) return;
        var next = !account[field];
        var writes = {};
        writes[field] = next;
        db.collection('users').doc(uid).set(writes, { merge: true }).then(function () {
          account[field] = next;
          showToast((next ? (account.name + ' est maintenant ') : (account.name + ' n\'est plus ')) + badge.label + '.', 'success');
          renderRoot();
        }).catch(function (err) {
          accountManagerError = 'Erreur : ' + (err && err.message ? err.message : err);
          renderRoot();
        });
      });
    });
    var profileCancel = document.getElementById('profile-cancel');
    if (profileCancel) {
      profileCancel.addEventListener('click', function () {
        profilePanelOpen = false;
        profileDeleteConfirmOpen = false;
        pseudoEditUnlocked = false;
        pseudoRenameConfirmPending = false;
        renderRoot();
      });
    }
    var pseudoEditUnlock = document.getElementById('pseudo-edit-unlock');
    if (pseudoEditUnlock) {
      pseudoEditUnlock.addEventListener('click', function () {
        // No native confirm() here -- unlocking the field already reveals
        // the same warning inline right below it (see renderProfileProfilTab's
        // "⚠ Renommer va changer..." text), and the actual rename still
        // needs its own click-to-confirm on submit below.
        pseudoEditUnlocked = true;
        renderRoot();
      });
    }
    var profileForm = document.getElementById('profile-form');
    if (profileForm) {
      var profileNameEl = document.getElementById('profile-name');
      if (profileNameEl) {
        profileNameEl.addEventListener('input', function () { pseudoRenameConfirmPending = false; });
      }
      profileForm.addEventListener('submit', function (evt) {
        evt.preventDefault();
        var role = profileForm.querySelector('input[name="profile-role"]:checked').value;
        // The notify checkbox lives in the Réglages tab (saved instantly on
        // change, see profile-notify's own handler below), not in this form
        // -- fall back to the already-saved value when it's not in the DOM.
        var notifyEl = document.getElementById('profile-notify');
        var notify = notifyEl ? notifyEl.checked : !!currentUserProfile.notifyBeforeSession;
        var bikeEl = document.getElementById('profile-bike');
        var bike = bikeEl ? bikeEl.value.trim() : '';
        var bikeNumberEl = document.getElementById('profile-bike-number');
        var bikeNumber = bikeNumberEl ? bikeNumberEl.value.trim() : '';
        if (bikeNumber && !/^\d{1,3}$/.test(bikeNumber)) {
          profileSaveMessage = 'Le numéro de moto doit être composé de 1 à 3 chiffres.';
          renderRoot();
          return;
        }
        var followedRiders = Array.prototype.map.call(
          profileForm.querySelectorAll('input[name="profile-follow-rider"]:checked'),
          function (el) { return el.value; }
        );
        var nameEl = document.getElementById('profile-name');
        var newName = nameEl ? nameEl.value.trim() : '';
        var firstNameEl = document.getElementById('profile-firstname');
        var firstName = firstNameEl ? firstNameEl.value.trim() : '';
        var lastNameEl = document.getElementById('profile-lastname');
        var lastName = lastNameEl ? lastNameEl.value.trim() : '';
        var chronoLinkEl = document.getElementById('profile-chrono-link');
        var chronoLink = chronoLinkEl ? chronoLinkEl.value.trim() : '';
        if (pseudoEditUnlocked && newName && newName !== currentUserProfile.name && !pseudoRenameConfirmPending) {
          pseudoRenameConfirmPending = true;
          profileSaveMessage = 'Confirme le changement de pseudo de "' + currentUserProfile.name + '" vers "' + newName + '" en cliquant à nouveau sur Enregistrer. Action immédiate, un seul changement par mois.';
          renderRoot();
          return;
        }
        saveProfile(role, notify, followedRiders, bike, bikeNumber, newName, firstName, lastName, chronoLink);
        pseudoEditUnlocked = false;
        pseudoRenameConfirmPending = false;
      });
      var notifyLabel = document.getElementById('profile-notify-label');
      profileForm.querySelectorAll('input[name="profile-role"]').forEach(function (radio) {
        radio.addEventListener('change', function () {
          var isNonRider = (radio.value === 'accompagnant' || radio.value === 'organisateur') && radio.checked;
          if (radio.checked) {
            var wrap = document.getElementById('profile-followed-wrap');
            if (wrap) wrap.style.display = isNonRider ? 'block' : 'none';
            var bikeWrap = document.getElementById('profile-bike-wrap');
            if (bikeWrap) bikeWrap.style.display = isNonRider ? 'none' : 'block';
            if (notifyLabel) notifyLabel.textContent = isNonRider ? 'Me notifier quand un pilote suivi va partir rouler' : 'Me notifier quand mon groupe va partir rouler';
            ['pilote', 'accompagnant', 'organisateur'].forEach(function (r) {
              var card = document.getElementById('profile-role-info-' + r);
              if (card) card.style.display = (r === radio.value) ? 'block' : 'none';
            });
          }
        });
      });
    }
    var profileEmailForm = document.getElementById('profile-email-form');
    if (profileEmailForm) {
      profileEmailForm.addEventListener('submit', function (evt) {
        evt.preventDefault();
        var newEmail = document.getElementById('profile-new-email').value.trim();
        var currentPassword = document.getElementById('profile-current-password').value;
        changeProfileEmail(newEmail, currentPassword);
      });
    }
    var profilePhotoBtn = document.getElementById('profile-photo-btn');
    var profilePhotoInput = document.getElementById('profile-photo-input');
    if (profilePhotoBtn && profilePhotoInput) {
      profilePhotoBtn.addEventListener('click', function () { profilePhotoInput.click(); });
      profilePhotoInput.addEventListener('change', function () {
        var file = profilePhotoInput.files && profilePhotoInput.files[0];
        if (!file) return;
        if (!/^image\//.test(file.type)) {
          profilePhotoMessage = 'Choisis un fichier image.';
          renderRoot();
          return;
        }
        resizeImageToDataUrl(file, 1000, 0.85, function (dataUrl) {
          if (!dataUrl) {
            profilePhotoMessage = 'Impossible de lire cette image.';
            renderRoot();
            return;
          }
          openCropModal('user', null, dataUrl);
        });
      });
    }
    var profilePhotoRecropBtn = document.getElementById('profile-photo-recrop-btn');
    if (profilePhotoRecropBtn) {
      profilePhotoRecropBtn.addEventListener('click', function () {
        if (currentUserProfile && currentUserProfile.photoURL) openCropModal('user', null, currentUserProfile.photoURL);
      });
    }
    var profilePhotoRemoveBtn = document.getElementById('profile-photo-remove-btn');
    if (profilePhotoRemoveBtn) {
      profilePhotoRemoveBtn.addEventListener('click', function () { savePhoto(null); });
    }
    var horairesPhotoInput = document.getElementById('horaires-photo-input');
    if (horairesPhotoInput) {
      horairesPhotoInput.addEventListener('change', function () {
        var eventId = horairesPhotoInput.getAttribute('data-id');
        var file = horairesPhotoInput.files && horairesPhotoInput.files[0];
        if (!file) return;
        if (!/^image\//.test(file.type)) {
          horairesPhotoMessage = 'Choisis un fichier image.';
          renderRoot();
          return;
        }
        // Larger and less compressed than the avatar -- this photo needs
        // to stay legible enough to actually read times off it.
        resizeImageToDataUrl(file, 1400, 0.65, function (dataUrl) {
          if (!dataUrl) {
            horairesPhotoMessage = 'Impossible de lire cette image.';
            renderRoot();
            return;
          }
          // Firestore caps a document at 1MB, and this one also carries
          // every other field of the sortie -- leave headroom rather than
          // find out at save time.
          if (dataUrl.length > 700000) {
            horairesPhotoMessage = 'Cette photo est trop volumineuse même après compression — recadre-la ou prends-en une capture d\'écran partielle.';
            renderRoot();
            return;
          }
          saveHorairesPhoto(eventId, dataUrl);
        });
      });
    }
    var circuitMapUploadBtn = document.getElementById('circuit-map-upload-btn');
    if (circuitMapUploadBtn) {
      circuitMapUploadBtn.addEventListener('click', function () {
        var input = document.getElementById('circuit-map-input');
        if (input) input.click();
      });
    }
    var circuitMapRemoveBtn = document.getElementById('circuit-map-remove-btn');
    if (circuitMapRemoveBtn) {
      circuitMapRemoveBtn.addEventListener('click', function () {
        circuitMapMessage = '';
        saveCircuitMapImage(selectedCircuit, null);
      });
    }
    var circuitMapInput = document.getElementById('circuit-map-input');
    if (circuitMapInput) {
      circuitMapInput.addEventListener('change', function () {
        var file = circuitMapInput.files && circuitMapInput.files[0];
        if (!file) return;
        if (!/^image\//.test(file.type)) {
          circuitMapMessage = 'Choisis un fichier image.';
          renderRoot();
          return;
        }
        resizeImageToDataUrl(file, 1400, 0.7, function (dataUrl) {
          if (!dataUrl) {
            circuitMapMessage = 'Impossible de lire cette image.';
            renderRoot();
            return;
          }
          if (dataUrl.length > 700000) {
            circuitMapMessage = 'Ce plan est trop volumineux même après compression — recadre-le ou prends-en une capture d\'écran partielle.';
            renderRoot();
            return;
          }
          circuitMapMessage = '';
          saveCircuitMapImage(selectedCircuit, dataUrl);
        });
      });
    }
    document.querySelectorAll('[data-action="horaires-photo-add"]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var input = document.getElementById('horaires-photo-input');
        if (input) input.click();
      });
    });
    document.querySelectorAll('[data-action="horaires-photo-remove"]').forEach(function (btn) {
      btn.addEventListener('click', function () { saveHorairesPhoto(btn.getAttribute('data-id'), null); });
    });
    document.querySelectorAll('[data-action="toggle-horaires-photo"]').forEach(function (img) {
      img.addEventListener('click', function () {
        var id = img.getAttribute('data-id');
        horairesPhotoExpanded[id] = !horairesPhotoExpanded[id];
        renderRoot();
      });
    });
    var wallFeedSentinel = document.getElementById('wall-feed-sentinel');
    if (wallFeedSentinel && window.IntersectionObserver) {
      var wallFeedObserver = new IntersectionObserver(function (entries) {
        if (entries[0].isIntersecting) {
          wallFeedObserver.disconnect();
          wallFeedVisibleCount += 5;
          renderRoot();
        }
      });
      wallFeedObserver.observe(wallFeedSentinel);
    }
    var wallComposerToggle = document.getElementById('wall-composer-toggle');
    if (wallComposerToggle) {
      wallComposerToggle.addEventListener('click', function () {
        wallComposerOpen = true;
        renderRoot();
      });
    }
    var wallPostForm = document.getElementById('wall-post-form');
    if (wallPostForm) {
      wallPostForm.addEventListener('submit', function (evt) {
        evt.preventDefault();
        var textEl = document.getElementById('wall-post-text');
        var linkEl = document.getElementById('wall-post-link');
        var audienceEl = document.getElementById('wall-post-audience');
        postToWall(textEl.value, linkEl.value, wallPostDraftPhotoURL, audienceEl.value);
      });
    }
    var wallPostPhotoBtn = document.getElementById('wall-post-photo-btn');
    var wallPostPhotoInput = document.getElementById('wall-post-photo-input');
    if (wallPostPhotoBtn && wallPostPhotoInput) {
      wallPostPhotoBtn.addEventListener('click', function () { wallPostPhotoInput.click(); });
      wallPostPhotoInput.addEventListener('change', function () {
        var file = wallPostPhotoInput.files && wallPostPhotoInput.files[0];
        if (!file) return;
        if (!/^image\//.test(file.type)) {
          wallPostMessage = 'Choisis un fichier image.';
          renderRoot();
          return;
        }
        resizeImageToDataUrl(file, 1000, 0.6, function (dataUrl) {
          if (!dataUrl) {
            wallPostMessage = 'Impossible de lire cette image.';
            renderRoot();
            return;
          }
          if (dataUrl.length > 700000) {
            wallPostMessage = 'Cette photo est trop volumineuse même après compression.';
            renderRoot();
            return;
          }
          wallPostDraftPhotoURL = dataUrl;
          wallPostMessage = '';
          renderRoot();
        });
      });
    }
    var wallPostPhotoRemoveBtn = document.getElementById('wall-post-photo-remove-btn');
    if (wallPostPhotoRemoveBtn) {
      wallPostPhotoRemoveBtn.addEventListener('click', function () { wallPostDraftPhotoURL = null; renderRoot(); });
    }
    var exportCsvBtn = document.querySelector('[data-action="export-chronos-csv"]');
    if (exportCsvBtn) {
      exportCsvBtn.addEventListener('click', function () {
        var riders = allKnownRiders();
        var rider = (selectedRiders && selectedRiders.size === 1) ? Array.from(selectedRiders)[0] : null;
        var names = rider ? [rider] : (selectedRiders && selectedRiders.size ? Array.from(selectedRiders) : riders);
        exportSessionsCsv(names);
      });
    }
    document.querySelectorAll('[data-action="delete-wall-post"]').forEach(function (btn) {
      btn.addEventListener('click', function () { deleteWallPost(btn.getAttribute('data-id')); });
    });
    document.querySelectorAll('[data-action="wall-post-edit"]').forEach(function (btn) {
      btn.addEventListener('click', function () { editingWallPostId = btn.getAttribute('data-id'); renderRoot(); });
    });
    document.querySelectorAll('[data-action="wall-post-edit-cancel"]').forEach(function (btn) {
      btn.addEventListener('click', function () { editingWallPostId = null; renderRoot(); });
    });
    document.querySelectorAll('[data-action="wall-post-edit-form"]').forEach(function (form) {
      form.addEventListener('submit', function (evt) {
        evt.preventDefault();
        var textEl = form.querySelector('[data-wall-post-edit-text]');
        var linkEl = form.querySelector('[data-wall-post-edit-link]');
        updateWallPost(form.getAttribute('data-id'), textEl ? textEl.value : '', linkEl ? linkEl.value : '');
      });
    });
    var deleteAccountRequestBtn = document.getElementById('delete-account-request-btn');
    if (deleteAccountRequestBtn) {
      deleteAccountRequestBtn.addEventListener('click', function () {
        profileDeleteConfirmOpen = true;
        profileDeleteMessage = '';
        renderRoot();
      });
    }
    var deleteAccountCancelBtn = document.getElementById('delete-account-cancel-btn');
    if (deleteAccountCancelBtn) {
      deleteAccountCancelBtn.addEventListener('click', function () {
        profileDeleteConfirmOpen = false;
        profileDeleteMessage = '';
        renderRoot();
      });
    }
    var deleteAccountForm = document.getElementById('profile-delete-account-form');
    if (deleteAccountForm) {
      deleteAccountForm.addEventListener('submit', function (evt) {
        evt.preventDefault();
        deleteMyAccount(document.getElementById('profile-delete-password').value);
      });
    }
    var addFriendForm = document.getElementById('add-friend-form');
    if (addFriendForm) {
      addFriendForm.addEventListener('submit', function (evt) {
        evt.preventDefault();
        var input = document.getElementById('add-friend-input');
        var name = input ? input.value.trim() : '';
        if (!name) return;
        if (!(STATE.usersByName || {})[name]) {
          showToast('Choisis un pseudo dans la liste proposée.');
          return;
        }
        sendFriendRequest(name);
        addFriendOpen = false;
        renderRoot();
      });
    }
    document.querySelectorAll('[data-action="accept-friend"]').forEach(function (btn) {
      btn.addEventListener('click', function () { acceptFriendRequest(btn.getAttribute('data-id')); });
    });
    document.querySelectorAll('[data-action="remove-friend"]').forEach(function (btn) {
      btn.addEventListener('click', function () { removeFriendRequest(btn.getAttribute('data-id')); });
    });
    document.querySelectorAll('[data-action="remove-friend-request"]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        pendingRemoveFriendId = btn.getAttribute('data-id');
        renderRoot();
      });
    });
    document.querySelectorAll('[data-action="remove-friend-confirm"]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        removeFriendRequest(btn.getAttribute('data-id'));
        pendingRemoveFriendId = null;
        expandedFriend = null;
        renderRoot();
      });
    });
    document.querySelectorAll('[data-action="remove-friend-cancel"]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        pendingRemoveFriendId = null;
        renderRoot();
      });
    });
    var addFriendToggle = document.getElementById('add-friend-toggle');
    if (addFriendToggle) {
      addFriendToggle.addEventListener('click', function () {
        addFriendOpen = true;
        renderRoot();
      });
    }
    document.querySelectorAll('[data-action="toggle-friend-fiche"]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var name = btn.getAttribute('data-name');
        expandedFriend = expandedFriend === name ? null : name;
        pendingRemoveFriendId = null;
        renderRoot();
      });
    });
    document.querySelectorAll('[data-action="quick-add-friend"]').forEach(function (btn) {
      btn.addEventListener('click', function () { sendFriendRequest(btn.getAttribute('data-name')); });
    });
    document.querySelectorAll('[data-action="quick-follow"]').forEach(function (btn) {
      btn.addEventListener('click', function () { followName(btn.getAttribute('data-name')); });
    });
    document.querySelectorAll('[data-action="unfollow"]').forEach(function (btn) {
      btn.addEventListener('click', function () { unfollowName(btn.getAttribute('data-name')); });
    });
    document.querySelectorAll('[data-action="follow-team"]').forEach(function (btn) {
      btn.addEventListener('click', function () { followTeam(btn.getAttribute('data-team')); });
    });
    document.querySelectorAll('[data-action="unfollow-team"]').forEach(function (btn) {
      btn.addEventListener('click', function () { unfollowTeam(btn.getAttribute('data-team')); });
    });
    document.querySelectorAll('[data-action="team-pro-badge-toggle"]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var teamId = btn.getAttribute('data-team');
        var field = btn.getAttribute('data-field');
        var scope = btn.closest('.planning-section-body') || document;
        var input = scope.querySelector('[data-team-pro-badge-name]');
        var name = input ? input.value.trim() : '';
        if (!name) { showToast('Indique un compte.'); return; }
        var target = (STATE.usersByName || {})[name];
        if (!target || !target.uid) { showToast('Compte introuvable : "' + name + '".'); return; }
        var next = !target[field];
        var writes = {};
        writes[field] = next;
        writes[field + 'TeamId'] = next ? teamId : null;
        db.collection('users').doc(target.uid).set(writes, { merge: true }).then(function () {
          showToast((next ? (name + ' est maintenant ') : (name + ' n\'est plus ')) + (field === 'coach' ? 'Coach' : 'Photographe officiel') + '.', 'success');
          if (input) input.value = '';
        }).catch(function (err) {
          showToast('Erreur : ' + (err && err.message ? err.message : err));
        });
      });
    });
    var createTeamForm = document.getElementById('create-team-form');
    if (createTeamForm) {
      createTeamForm.addEventListener('submit', function (evt) {
        evt.preventDefault();
        var input = document.getElementById('new-team-name');
        var proEl = document.getElementById('new-team-pro');
        createTeam(input.value, proEl ? proEl.checked : false);
        input.value = '';
      });
    }
    document.querySelectorAll('[data-action="team-invite-form"]').forEach(function (form) {
      form.addEventListener('submit', function (evt) {
        evt.preventDefault();
        var select = form.querySelector('[data-team-invite-select]');
        if (select && select.value) inviteToTeam(form.getAttribute('data-team'), select.value);
      });
    });
    document.querySelectorAll('[data-action="team-feed-form"]').forEach(function (form) {
      form.addEventListener('submit', function (evt) {
        evt.preventDefault();
        var teamId = form.getAttribute('data-team');
        var textInput = form.querySelector('[data-team-feed-input]');
        var linkInput = form.querySelector('[data-team-feed-link]');
        var audienceSelect = form.querySelector('[data-team-feed-audience]');
        var photoURL = (teamPostDraftPhotoTeamId === teamId) ? teamPostDraftPhotoURL : null;
        postTeamFeedMessage(teamId, textInput ? textInput.value : '', linkInput ? linkInput.value : '', photoURL, audienceSelect ? audienceSelect.value : null);
        teamPostDraftPhotoTeamId = null;
        teamPostDraftPhotoURL = null;
        teamComposerMode = null;
        renderRoot();
      });
    });
    document.querySelectorAll('[data-action="team-feed-photo-btn"]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        teamPostDraftPhotoTeamId = btn.getAttribute('data-team');
        var input = document.getElementById('team-feed-photo-input');
        if (input) input.click();
      });
    });
    var teamFeedPhotoInput = document.getElementById('team-feed-photo-input');
    if (teamFeedPhotoInput) {
      teamFeedPhotoInput.addEventListener('change', function () {
        var file = teamFeedPhotoInput.files && teamFeedPhotoInput.files[0];
        if (!file || !teamPostDraftPhotoTeamId) return;
        if (!/^image\//.test(file.type)) { showToast('Choisis un fichier image.'); return; }
        resizeImageToDataUrl(file, 1000, 0.6, function (dataUrl) {
          if (!dataUrl || dataUrl.length > 700000) {
            showToast(dataUrl ? 'Cette photo est trop volumineuse même après compression.' : 'Impossible de lire cette image.');
            return;
          }
          teamPostDraftPhotoURL = dataUrl;
          renderRoot();
        });
      });
    }
    document.querySelectorAll('[data-action="team-feed-photo-remove"]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        teamPostDraftPhotoTeamId = null;
        teamPostDraftPhotoURL = null;
        renderRoot();
      });
    });
    document.querySelectorAll('[data-action="team-poll-form"]').forEach(function (form) {
      form.addEventListener('submit', function (evt) {
        evt.preventDefault();
        var question = form.querySelector('[data-poll-question]').value;
        var options = Array.prototype.map.call(form.querySelectorAll('[data-poll-option]'), function (el) { return el.value; });
        var audienceSelect = form.querySelector('[data-team-feed-audience]');
        postTeamPoll(form.getAttribute('data-team'), question, options, audienceSelect ? audienceSelect.value : null);
        // Same "question + at least 2 options" check postTeamPoll makes
        // internally -- only close the composer once it's actually valid,
        // so an incomplete draft (and postTeamPoll's own toast) isn't
        // silently thrown away.
        if (question.trim() && options.filter(function (o) { return o.trim(); }).length >= 2) {
          teamComposerMode = null;
          pollDraftQuestion = '';
          pollDraftOptions = ['', ''];
          renderRoot();
        }
      });
    });
    document.querySelectorAll('[data-action="team-composer-open"]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        teamComposerMode = btn.getAttribute('data-mode');
        pollDraftQuestion = '';
        pollDraftOptions = ['', ''];
        renderRoot();
      });
    });
    document.querySelectorAll('[data-action="team-composer-close"]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        teamComposerMode = null;
        teamPostDraftPhotoTeamId = null;
        teamPostDraftPhotoURL = null;
        renderRoot();
      });
    });
    document.querySelectorAll('[data-action="team-poll-add-option"]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var form = btn.closest('form');
        if (form) {
          var questionEl = form.querySelector('[data-poll-question]');
          pollDraftQuestion = questionEl ? questionEl.value : pollDraftQuestion;
          pollDraftOptions = Array.prototype.map.call(form.querySelectorAll('[data-poll-option]'), function (el) { return el.value; });
        }
        pollDraftOptions.push('');
        renderRoot();
      });
    });
    document.querySelectorAll('[data-action="team-poll-vote"]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        voteTeamPoll(btn.getAttribute('data-id'), parseInt(btn.getAttribute('data-option'), 10));
      });
    });
    document.querySelectorAll('[data-action="team-post-policy"]').forEach(function (select) {
      select.addEventListener('change', function () { setTeamPostPolicy(select.getAttribute('data-team'), select.value); });
    });
    document.querySelectorAll('[data-action="team-status-toggle"]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var teamId = btn.getAttribute('data-team');
        var name = btn.getAttribute('data-name');
        var status = btn.getAttribute('data-status');
        var turningOn = btn.getAttribute('data-on') === '1';
        // Granting or revoking Team Leader is the one pill worth a pause
        // for -- it's full control over the Team (members, événements,
        // suppression), not a lightweight tag like Suivi/Membre/Adhérent.
        // First click arms it (see pill()'s "Confirmer ?" state), second
        // click on the same pill actually performs it -- clicking anything
        // else re-renders with a different armed target, which disarms it.
        if (status === 'leader') {
          var alreadyArmed = pendingLeaderToggle && pendingLeaderToggle.team === teamId && pendingLeaderToggle.name === name;
          if (!alreadyArmed) {
            pendingLeaderToggle = { team: teamId, name: name, on: turningOn };
            renderRoot();
            return;
          }
          pendingLeaderToggle = null;
        }
        var memberDoc = ((STATE.teamMembersByTeam || {})[teamId] || []).filter(function (m) { return m.name === name; })[0] || null;
        var followDoc = ((STATE.teamFollowersByTeam || {})[teamId] || []).filter(function (f) { return f.follower === name; })[0] || null;
        setTeamMemberStatus(teamId, followDoc, memberDoc, name, status, turningOn);
      });
    });
    document.querySelectorAll('[data-action="team-leader-toggle-cancel"]').forEach(function (btn) {
      btn.addEventListener('click', function () { pendingLeaderToggle = null; renderRoot(); });
    });
    document.querySelectorAll('[data-action="team-role-save"]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var row = btn.closest('.team-manage-row');
        var input = row ? row.querySelector('[data-team-role-input]') : null;
        setTeamMemberTeamRole(btn.getAttribute('data-team'), btn.getAttribute('data-name'), input ? input.value : '');
        showToast('Rôle enregistré.', 'success');
      });
    });
    document.querySelectorAll('[data-action="event-bike-number-save"]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var row = btn.closest('.friend-row');
        var input = row ? row.querySelector('[data-event-bike-number-input]') : null;
        saveEventRiderBikeNumber(btn.getAttribute('data-id'), btn.getAttribute('data-rider'), input ? input.value : '');
        showToast('N° enregistré.', 'success');
      });
    });
    document.querySelectorAll('[data-action="team-visibility"]').forEach(function (select) {
      select.addEventListener('change', function () { setTeamVisibility(select.getAttribute('data-team'), select.value); });
    });
    document.querySelectorAll('[data-action="team-description-save"]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var teamId = btn.getAttribute('data-team');
        var textarea = document.getElementById('team-description-' + teamId);
        saveTeamDescription(teamId, textarea ? textarea.value : '');
      });
    });
    var teamPhotoInput = document.getElementById('team-photo-input');
    document.querySelectorAll('[data-action="team-photo-btn"]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        teamPhotoUploadTeamId = btn.getAttribute('data-team');
        if (teamPhotoInput) teamPhotoInput.click();
      });
    });
    if (teamPhotoInput) {
      teamPhotoInput.addEventListener('change', function () {
        var file = teamPhotoInput.files && teamPhotoInput.files[0];
        if (!file || !teamPhotoUploadTeamId) return;
        if (!/^image\//.test(file.type)) { showToast('Choisis un fichier image.'); return; }
        // Kept larger than the final 400x400 badge output so there's
        // still real detail left to pan/zoom into in the crop modal.
        resizeImageToDataUrl(file, 1000, 0.85, function (dataUrl) {
          if (!dataUrl) { showToast('Impossible de lire cette image.'); return; }
          openCropModal('team', teamPhotoUploadTeamId, dataUrl);
        });
      });
    }
    document.querySelectorAll('[data-action="team-photo-remove"]').forEach(function (btn) {
      btn.addEventListener('click', function () { saveTeamPhoto(btn.getAttribute('data-team'), null); });
    });
    document.querySelectorAll('[data-action="team-photo-recrop"]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var teamId = btn.getAttribute('data-team');
        var team = teamById(teamId);
        if (team && team.photoURL) openCropModal('team', teamId, team.photoURL);
      });
    });
    var teamLogoInput = document.getElementById('team-logo-input');
    document.querySelectorAll('[data-action="team-logo-btn"]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        teamPhotoUploadTeamId = btn.getAttribute('data-team');
        if (teamLogoInput) teamLogoInput.click();
      });
    });
    if (teamLogoInput) {
      teamLogoInput.addEventListener('change', function () {
        var file = teamLogoInput.files && teamLogoInput.files[0];
        if (!file || !teamPhotoUploadTeamId) return;
        if (!/^image\//.test(file.type)) { showToast('Choisis un fichier image.'); return; }
        // Kept larger than the final 1280px-wide output so there's still
        // real detail left to pan/zoom into in the crop modal.
        resizeImageToDataUrl(file, 1400, 0.85, function (dataUrl) {
          if (!dataUrl) { showToast('Impossible de lire cette image.'); return; }
          openCropModal('logo', teamPhotoUploadTeamId, dataUrl);
        });
      });
    }
    document.querySelectorAll('[data-action="team-logo-remove"]').forEach(function (btn) {
      btn.addEventListener('click', function () { saveTeamLogo(btn.getAttribute('data-team'), null); });
    });
    document.querySelectorAll('[data-action="team-logo-recrop"]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var teamId = btn.getAttribute('data-team');
        var team = teamById(teamId);
        if (team && team.logoURL) openCropModal('logo', teamId, team.logoURL);
      });
    });
    document.querySelectorAll('[data-action="team-links-form"]').forEach(function (form) {
      form.addEventListener('submit', function (evt) {
        evt.preventDefault();
        var textarea = form.querySelector('[data-team-links-input]');
        saveTeamLinks(form.getAttribute('data-team'), textarea ? textarea.value : '');
      });
    });
    var partnersForm = document.getElementById('partners-form');
    if (partnersForm) {
      partnersForm.addEventListener('submit', function (evt) {
        evt.preventDefault();
        var textarea = document.getElementById('partners-input');
        savePartners(textarea ? textarea.value : '');
      });
    }
    document.querySelectorAll('[data-action="team-partners-form"]').forEach(function (form) {
      form.addEventListener('submit', function (evt) {
        evt.preventDefault();
        var textarea = form.querySelector('[data-team-partners-input]');
        saveTeamPartners(form.getAttribute('data-team'), textarea ? textarea.value : '');
      });
    });
    var cropViewportEl = document.getElementById('crop-modal-viewport');
    var cropModalImgEl = document.getElementById('crop-modal-img');
    var cropZoomEl = document.getElementById('crop-zoom');
    var cropOffsetXEl = document.getElementById('crop-offset-x');
    var cropOffsetYEl = document.getElementById('crop-offset-y');
    // Live preview via direct style writes (no renderRoot()) so dragging
    // stays smooth -- the module vars are kept in sync too, so whatever
    // the preview shows is exactly what saveCroppedPhoto() crops. Also
    // keeps the sliders' own displayed value in sync when a drag/pinch/
    // wheel gesture (below) is what actually changed zoom/offset.
    var applyCropTransform = function () {
      if (!cropModalImgEl) return;
      var size = cropDisplaySize();
      cropModalImgEl.style.width = size.w + 'px';
      cropModalImgEl.style.height = size.h + 'px';
      cropModalImgEl.style.transform = 'translate(calc(-50% + ' + cropOffsetXPx + 'px), calc(-50% + ' + cropOffsetYPx + 'px))';
      if (cropZoomEl) cropZoomEl.value = cropZoom;
      if (cropOffsetXEl) cropOffsetXEl.value = cropOffsetXPx;
      if (cropOffsetYEl) cropOffsetYEl.value = cropOffsetYPx;
    };
    if (cropModalImgEl && cropZoomEl) {
      cropZoomEl.addEventListener('input', function () {
        cropZoom = parseInt(cropZoomEl.value, 10);
        applyCropTransform();
      });
    }
    if (cropModalImgEl && cropOffsetXEl && cropOffsetYEl) {
      var updateCropOffset = function () {
        cropOffsetXPx = parseInt(cropOffsetXEl.value, 10);
        cropOffsetYPx = parseInt(cropOffsetYEl.value, 10);
        applyCropTransform();
      };
      cropOffsetXEl.addEventListener('input', updateCropOffset);
      cropOffsetYEl.addEventListener('input', updateCropOffset);
    }
    // Direct finger/mouse drag-to-pan and pinch/wheel-to-zoom on the
    // viewport itself -- the sliders above stay as a fallback, but
    // dragging the image directly (pinching to zoom on a touch screen,
    // or scrolling the wheel on a mouse) is the natural gesture. Pointer
    // Events unify mouse/touch/pen so one set of handlers covers both
    // single-finger pan and two-finger pinch.
    if (cropViewportEl && cropModalImgEl) {
      var cropPointers = {}; // pointerId -> {x, y}
      var cropDragStart = null; // {x, y, offsetX, offsetY}
      var cropPinchStart = null; // {dist, zoom}
      var cropPointerDist = function () {
        var pts = Object.keys(cropPointers).map(function (id) { return cropPointers[id]; });
        if (pts.length < 2) return 0;
        return Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      };
      cropViewportEl.addEventListener('pointerdown', function (evt) {
        evt.preventDefault();
        try { cropViewportEl.setPointerCapture(evt.pointerId); } catch (e) {}
        cropPointers[evt.pointerId] = { x: evt.clientX, y: evt.clientY };
        var ids = Object.keys(cropPointers);
        if (ids.length === 2) {
          cropDragStart = null;
          cropPinchStart = { dist: cropPointerDist(), zoom: cropZoom };
        } else {
          cropPinchStart = null;
          cropDragStart = { x: evt.clientX, y: evt.clientY, offsetX: cropOffsetXPx, offsetY: cropOffsetYPx };
        }
      });
      cropViewportEl.addEventListener('pointermove', function (evt) {
        if (!cropPointers[evt.pointerId]) return;
        cropPointers[evt.pointerId] = { x: evt.clientX, y: evt.clientY };
        var ids = Object.keys(cropPointers);
        if (ids.length >= 2 && cropPinchStart) {
          var dist = cropPointerDist();
          if (cropPinchStart.dist > 0) {
            cropZoom = Math.max(20, Math.min(400, Math.round(cropPinchStart.zoom * (dist / cropPinchStart.dist))));
            applyCropTransform();
          }
        } else if (ids.length === 1 && cropDragStart) {
          cropOffsetXPx = Math.max(-400, Math.min(400, cropDragStart.offsetX + (evt.clientX - cropDragStart.x)));
          cropOffsetYPx = Math.max(-400, Math.min(400, cropDragStart.offsetY + (evt.clientY - cropDragStart.y)));
          applyCropTransform();
        }
      });
      var cropPointerEnd = function (evt) {
        delete cropPointers[evt.pointerId];
        var ids = Object.keys(cropPointers);
        cropPinchStart = null;
        cropDragStart = ids.length === 1
          ? { x: cropPointers[ids[0]].x, y: cropPointers[ids[0]].y, offsetX: cropOffsetXPx, offsetY: cropOffsetYPx }
          : null;
      };
      cropViewportEl.addEventListener('pointerup', cropPointerEnd);
      cropViewportEl.addEventListener('pointercancel', cropPointerEnd);
      cropViewportEl.addEventListener('wheel', function (evt) {
        evt.preventDefault();
        cropZoom = Math.max(20, Math.min(400, cropZoom - Math.sign(evt.deltaY) * 10));
        applyCropTransform();
      }, { passive: false });
    }
    var cropSaveBtn = document.getElementById('crop-save-btn');
    if (cropSaveBtn) cropSaveBtn.addEventListener('click', saveCroppedPhoto);
    var cropCancelBtn = document.getElementById('crop-cancel-btn');
    if (cropCancelBtn) cropCancelBtn.addEventListener('click', closeCropModal);
    var feedbackForm = document.getElementById('feedback-form');
    if (feedbackForm) {
      feedbackForm.addEventListener('submit', function (evt) {
        evt.preventDefault();
        var textEl = document.getElementById('feedback-text');
        sendFeedback(textEl ? textEl.value : '');
        if (textEl) textEl.value = '';
      });
    }
    var tutorialOpenBtn = document.getElementById('tutorial-open-btn');
    if (tutorialOpenBtn) tutorialOpenBtn.addEventListener('click', openTutorial);
    var tutorialNextBtn = document.getElementById('tutorial-next-btn');
    if (tutorialNextBtn) tutorialNextBtn.addEventListener('click', function () { tutorialGo(1); });
    var tutorialPrevBtn = document.getElementById('tutorial-prev-btn');
    if (tutorialPrevBtn) tutorialPrevBtn.addEventListener('click', function () { tutorialGo(-1); });
    var tutorialSkipBtn = document.getElementById('tutorial-skip-btn');
    if (tutorialSkipBtn) tutorialSkipBtn.addEventListener('click', closeTutorial);
    var tutorialFinishBtn = document.getElementById('tutorial-finish-btn');
    if (tutorialFinishBtn) tutorialFinishBtn.addEventListener('click', closeTutorial);
    document.querySelectorAll('[data-action="feeling-pick"]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        if (!feelingModalSessionId) return;
        var commentEl = document.getElementById('feeling-comment-input');
        saveSessionFeeling(feelingModalSessionId, btn.getAttribute('data-feeling'), commentEl ? commentEl.value : '');
      });
    });
    var feelingSkipBtn = document.getElementById('feeling-skip-btn');
    if (feelingSkipBtn) feelingSkipBtn.addEventListener('click', closeFeelingModal);
    var chronoGoalsSaveBtn = document.getElementById('chrono-goals-save-btn');
    if (chronoGoalsSaveBtn) {
      chronoGoalsSaveBtn.addEventListener('click', function () {
        var input = document.getElementById('chrono-goals-input');
        saveChronoGoals(selectedCircuit, input ? input.value : '');
      });
    }
    document.querySelectorAll('[data-action="team-delete-request"]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        pendingDeleteTeamId = btn.getAttribute('data-team');
        teamDeleteMessage = '';
        renderRoot();
      });
    });
    document.querySelectorAll('[data-action="team-delete-cancel"]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        pendingDeleteTeamId = null;
        teamDeleteMessage = '';
        renderRoot();
      });
    });
    var teamDeleteForm = document.getElementById('team-delete-form');
    if (teamDeleteForm) {
      teamDeleteForm.addEventListener('submit', function (evt) {
        evt.preventDefault();
        var pwEl = document.getElementById('team-delete-password');
        deleteTeam(teamDeleteForm.getAttribute('data-team'), pwEl ? pwEl.value : '');
      });
    }
    document.querySelectorAll('[data-action="admin-team-delete-request"]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        pendingDeleteTeamId = btn.getAttribute('data-team');
        teamDeleteMessage = '';
        renderRoot();
      });
    });
    document.querySelectorAll('[data-action="admin-team-delete-cancel"]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        pendingDeleteTeamId = null;
        teamDeleteMessage = '';
        renderRoot();
      });
    });
    var adminTeamDeleteForm = document.getElementById('admin-team-delete-form');
    if (adminTeamDeleteForm) {
      adminTeamDeleteForm.addEventListener('submit', function (evt) {
        evt.preventDefault();
        var pwEl = document.getElementById('admin-team-delete-password');
        deleteTeam(adminTeamDeleteForm.getAttribute('data-team'), pwEl ? pwEl.value : '');
      });
    }
    document.querySelectorAll('[data-action="team-tile-open"]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        expandedTeamId = btn.getAttribute('data-team');
        managingEventId = null;
        renderRoot();
        window.scrollTo(0, 0);
      });
    });
    document.querySelectorAll('[data-action="team-tile-close"]').forEach(function (btn) {
      btn.addEventListener('click', function () { expandedTeamId = null; managingEventId = null; renderRoot(); });
    });
    document.querySelectorAll('[data-action="team-event-manage-open"]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        managingEventId = btn.getAttribute('data-id');
        editingEventId = null;
        renderRoot();
        window.scrollTo(0, 0);
      });
    });
    document.querySelectorAll('[data-action="event-manage-close"]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        managingEventId = null;
        editingEventId = null;
        renderRoot();
      });
    });
    document.querySelectorAll('[data-action="toggle-team-pro"]').forEach(function (btn) {
      btn.addEventListener('click', function () { toggleTeamPro(btn.getAttribute('data-team')); });
    });
    document.querySelectorAll('[data-action="react-feed-event"]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.getAttribute('data-id');
        var entry = (STATE.feedEvents || []).filter(function (e) { return e.id === id; })[0];
        toggleReaction('feedEvents', id, btn.getAttribute('data-emoji'), entry && entry.reactions);
      });
    });
    document.querySelectorAll('[data-action="react-team-post"]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.getAttribute('data-id');
        var entry = (STATE.teamFeed || []).filter(function (f) { return f.id === id; })[0];
        toggleReaction('teamFeed', id, btn.getAttribute('data-emoji'), entry && entry.reactions);
      });
    });
    document.querySelectorAll('[data-action="react-wall-post"]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.getAttribute('data-id');
        var entry = (STATE.wallPosts || []).filter(function (p) { return p.id === id; })[0];
        toggleReaction('wallPosts', id, btn.getAttribute('data-emoji'), entry && entry.reactions);
      });
    });
    document.querySelectorAll('[data-action="team-post-edit"]').forEach(function (btn) {
      btn.addEventListener('click', function () { editingTeamPostId = btn.getAttribute('data-id'); renderRoot(); });
    });
    document.querySelectorAll('[data-action="team-post-edit-cancel"]').forEach(function (btn) {
      btn.addEventListener('click', function () { editingTeamPostId = null; renderRoot(); });
    });
    document.querySelectorAll('[data-action="team-post-edit-form"]').forEach(function (form) {
      form.addEventListener('submit', function (evt) {
        evt.preventDefault();
        var textEl = form.querySelector('[data-team-post-edit-text]');
        var linkEl = form.querySelector('[data-team-post-edit-link]');
        updateTeamFeedPost(form.getAttribute('data-id'), textEl ? textEl.value : '', linkEl ? linkEl.value : '');
      });
    });
    document.querySelectorAll('[data-action="team-post-delete"]').forEach(function (btn) {
      btn.addEventListener('click', function () { deleteTeamFeedPost(btn.getAttribute('data-id')); });
    });
    document.querySelectorAll('[data-action="react-event"]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.getAttribute('data-id');
        var entry = (STATE.events || []).filter(function (e) { return e.id === id; })[0];
        toggleReaction('events', id, btn.getAttribute('data-emoji'), entry && entry.reactions);
      });
    });
    document.querySelectorAll('[data-action="coach-request-accept"]').forEach(function (btn) {
      btn.addEventListener('click', function () { acceptCoachRequest(btn.getAttribute('data-id')); });
    });
    document.querySelectorAll('[data-action="coach-request-accept-slot"]').forEach(function (btn) {
      btn.addEventListener('click', function () { acceptCoachRequestSlot(btn.getAttribute('data-id'), btn.getAttribute('data-label')); });
    });
    document.querySelectorAll('[data-action="coach-request-remove"]').forEach(function (btn) {
      btn.addEventListener('click', function () { removeCoachRequest(btn.getAttribute('data-id')); });
    });
    document.querySelectorAll('[data-action="coach-plan-save"]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.getAttribute('data-id');
        var textarea = document.querySelector('[data-coach-plan="' + id + '"]');
        saveCoachPlan(id, textarea ? textarea.value : '');
        showToast('Planning enregistré.', 'success');
      });
    });
    var coachRequestForm = document.getElementById('coach-request-form');
    if (coachRequestForm) {
      coachRequestForm.addEventListener('submit', function (evt) {
        evt.preventDefault();
        var select = document.getElementById('coach-request-select');
        if (select && select.value) sendCoachRequest(select.value);
      });
    }
    var coachProposeTypeEl = document.getElementById('coach-propose-type');
    if (coachProposeTypeEl) {
      coachProposeTypeEl.addEventListener('change', function () {
        coachProposeType = coachProposeTypeEl.value;
        renderRoot();
      });
    }
    var coachProposeForm = document.getElementById('coach-propose-form');
    if (coachProposeForm) {
      coachProposeForm.addEventListener('submit', function (evt) {
        evt.preventDefault();
        var input = document.getElementById('coach-propose-input');
        var slotSelect = document.getElementById('coach-propose-slot');
        var name = input ? input.value.trim() : '';
        if (!name || !slotSelect || !slotSelect.value) return;
        var u = (STATE.usersByName || {})[name];
        var allowedRoles = coachProposeType === 'bapteme' ? ['pilote', 'accompagnant'] : ['pilote'];
        if (!u || allowedRoles.indexOf(u.role || 'pilote') === -1) {
          showToast(coachProposeType === 'bapteme' ? 'Choisis un pilote ou un accompagnant dans la liste proposée.' : 'Choisis un pilote dans la liste proposée.');
          return;
        }
        var target = targetPlanningEvent();
        var chosen = target ? allEventSlots(target.ev).filter(function (s) { return s.label === slotSelect.value; })[0] : null;
        if (!target || !chosen) { showToast('Choisis un créneau valide.'); return; }
        sendCoachRequest(name, coachProposeType, {
          eventId: target.ev.id, circuit: target.ev.circuit,
          slotStart: chosen.start, slotEnd: chosen.end, slotLabel: chosen.label
        });
        input.value = '';
      });
    }
    document.querySelectorAll('[data-action="coach-message-form"]').forEach(function (form) {
      form.addEventListener('submit', function (evt) {
        evt.preventDefault();
        var input = form.querySelector('[data-coach-message-input]');
        if (input && input.value.trim()) sendCoachMessage(form.getAttribute('data-request-id'), input.value);
        if (input) input.value = '';
      });
    });
    var coachAvailabilityEditToggleBtn = document.querySelector('[data-action="coach-availability-edit-toggle"]');
    if (coachAvailabilityEditToggleBtn) {
      coachAvailabilityEditToggleBtn.addEventListener('click', function () {
        coachAvailabilityEditOpen = !coachAvailabilityEditOpen;
        renderRoot();
      });
    }
    document.querySelectorAll('[data-action="coach-availability-type"]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        coachAvailabilityEditType = btn.getAttribute('data-type');
        renderRoot();
      });
    });
    // Click-or-drag "paint" over the planning grid while in availability-
    // editing mode (see renderCoachPlanningSection) -- one continuous
    // pointer gesture can mark several slots at once instead of one tap
    // each. The DOM is updated directly during the drag (no renderRoot,
    // so it stays perfectly smooth) and every touched slot is written to
    // Firestore in one shot on release. Only pointerdown is bound to the
    // grid element itself (freely re-bound every render, the old element
    // and its listener are discarded along with it); pointermove/up/
    // cancel are bound to `document` exactly once, ever (paintListenersOn
    // guards that) -- attachHandlers() re-runs on every render, and
    // re-adding a document-level listener each time would otherwise pile
    // up duplicates forever instead of ever being cleaned up.
    var paintWrap = document.querySelector('.coach-availability-painting');
    if (paintWrap) {
      paintEventId = paintWrap.getAttribute('data-event-id');
      paintWrap.addEventListener('pointerdown', function (evt) {
        var el = evt.target.closest('.schedule-slot[data-slot-start]');
        if (!el) return;
        evt.preventDefault();
        painting = true;
        paintTouched = {};
        var label = el.textContent.trim();
        var current = coachAvailabilityFor(currentUserProfile.name, paintEventId, coachAvailabilityEditType) || [];
        paintValue = current.indexOf(label) === -1;
        paintApplySlot(el);
      });
    }
    if (!paintListenersOn) {
      paintListenersOn = true;
      document.addEventListener('pointermove', function (evt) {
        if (!painting) return;
        var el = document.elementFromPoint(evt.clientX, evt.clientY);
        el = el && el.closest ? el.closest('.coach-availability-painting .schedule-slot[data-slot-start]') : null;
        if (el) paintApplySlot(el);
      });
      var paintEnd = function () {
        if (!painting) return;
        painting = false;
        saveCoachAvailability(paintEventId, (currentUserProfile.coachAvailability || {})[paintEventId] || {});
      };
      document.addEventListener('pointerup', paintEnd);
      document.addEventListener('pointercancel', paintEnd);
    }
    document.querySelectorAll('[data-action="coach-slot-propose-open"]').forEach(function (btn) {
      btn.addEventListener('click', function () { counterProposeRequestId = btn.getAttribute('data-id'); renderRoot(); });
    });
    document.querySelectorAll('[data-action="coach-slot-propose-cancel"]').forEach(function (btn) {
      btn.addEventListener('click', function () { counterProposeRequestId = null; renderRoot(); });
    });
    document.querySelectorAll('[data-action="coach-slot-propose-form"]').forEach(function (form) {
      form.addEventListener('submit', function (evt) {
        evt.preventDefault();
        var select = form.querySelector('[data-coach-slot-propose-select]');
        if (select && select.value) proposeCoachSlot(form.getAttribute('data-id'), select.value);
        counterProposeRequestId = null;
      });
    });
    // Clicking an actual timed slot (not a label-only line -- see
    // renderHoraireGroups) in the Coach tab's planning card opens the
    // "who do you want to ask about this session" modal (see
    // openCoachSlotModal); this is the only place these spans are
    // interactive -- the same markup on the main Planning tab isn't
    // wrapped in .coach-planning-clickable, so it stays inert there.
    document.querySelectorAll('.coach-planning-clickable .schedule-slot[data-slot-start]').forEach(function (el) {
      el.addEventListener('click', function () {
        var wrap = el.closest('.coach-planning-clickable');
        openCoachSlotModal(
          wrap ? wrap.getAttribute('data-event-id') : null,
          wrap ? wrap.getAttribute('data-circuit') : null,
          el.getAttribute('data-slot-start'),
          el.getAttribute('data-slot-end'),
          el.textContent.trim()
        );
      });
    });
    var coachSlotTypeEl = document.getElementById('coach-slot-type');
    if (coachSlotTypeEl) {
      coachSlotTypeEl.addEventListener('change', function () {
        coachSlotModalType = coachSlotTypeEl.value;
        renderRoot();
      });
    }
    document.querySelectorAll('[data-action="coach-slot-modal-option"]').forEach(function (cb) {
      cb.addEventListener('change', function () {
        var label = cb.value;
        if (cb.checked) {
          if (coachSlotModalSelected.length >= 3) { cb.checked = false; return; }
          coachSlotModalSelected.push(label);
        } else {
          coachSlotModalSelected = coachSlotModalSelected.filter(function (l) { return l !== label; });
        }
        renderRoot();
      });
    });
    var coachSlotCancelBtn = document.getElementById('coach-slot-cancel-btn');
    if (coachSlotCancelBtn) coachSlotCancelBtn.addEventListener('click', closeCoachSlotModal);
    var coachSlotRequestForm = document.getElementById('coach-slot-request-form');
    if (coachSlotRequestForm) {
      coachSlotRequestForm.addEventListener('submit', function (evt) {
        evt.preventDefault();
        var select = document.getElementById('coach-slot-coach');
        if (select && select.value && coachSlotModal && coachSlotModalSelected.length) {
          var ev = eventsList().filter(function (e) { return e.id === coachSlotModal.eventId; })[0];
          var allSlots = ev ? allEventSlots(ev) : [];
          var options = coachSlotModalSelected.map(function (label) {
            return allSlots.filter(function (s) { return s.label === label; })[0];
          }).filter(Boolean);
          if (options.length) {
            sendCoachRequest(select.value, coachSlotModalType, { eventId: coachSlotModal.eventId, circuit: coachSlotModal.circuit, options: options });
          }
        }
        closeCoachSlotModal();
      });
    }
    document.querySelectorAll('[data-action="event-announcement-form"]').forEach(function (form) {
      form.addEventListener('submit', function (evt) {
        evt.preventDefault();
        var input = form.querySelector('[data-event-announcement-input]');
        if (input && input.value.trim()) sendEventAnnouncement(form.getAttribute('data-event-id'), form.getAttribute('data-team-id'), input.value);
        if (input) input.value = '';
      });
    });
    document.querySelectorAll('[data-action="event-announcement-edit"]').forEach(function (btn) {
      btn.addEventListener('click', function () { editingAnnouncementId = btn.getAttribute('data-id'); renderRoot(); });
    });
    document.querySelectorAll('[data-action="event-announcement-edit-cancel"]').forEach(function (btn) {
      btn.addEventListener('click', function () { editingAnnouncementId = null; renderRoot(); });
    });
    document.querySelectorAll('[data-action="event-announcement-edit-form"]').forEach(function (form) {
      form.addEventListener('submit', function (evt) {
        evt.preventDefault();
        var input = form.querySelector('[data-event-announcement-edit-input]');
        updateEventAnnouncement(form.getAttribute('data-id'), input ? input.value : '');
      });
    });
    document.querySelectorAll('[data-action="edit-practical-info"]').forEach(function (btn) {
      btn.addEventListener('click', function () { editingPracticalInfoFor = btn.getAttribute('data-id'); renderRoot(); });
    });
    document.querySelectorAll('[data-action="cancel-practical-info"]').forEach(function (btn) {
      btn.addEventListener('click', function () { editingPracticalInfoFor = null; renderRoot(); });
    });
    document.querySelectorAll('[data-action="save-practical-info"]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var input = document.getElementById('practical-info-input');
        savePracticalInfo(btn.getAttribute('data-id'), input ? input.value : '');
      });
    });
    document.querySelectorAll('[data-action="edit-special-activities"]').forEach(function (btn) {
      btn.addEventListener('click', function () { editingSpecialActivitiesFor = btn.getAttribute('data-id'); renderRoot(); });
    });
    document.querySelectorAll('[data-action="cancel-special-activities"]').forEach(function (btn) {
      btn.addEventListener('click', function () { editingSpecialActivitiesFor = null; renderRoot(); });
    });
    document.querySelectorAll('[data-action="save-special-activities"]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var input = document.getElementById('special-activities-input');
        saveSpecialActivities(btn.getAttribute('data-id'), input ? input.value : '');
      });
    });
    document.querySelectorAll('[data-action="edit-rental-motos"]').forEach(function (btn) {
      btn.addEventListener('click', function () { editingRentalMotosFor = btn.getAttribute('data-id'); renderRoot(); });
    });
    document.querySelectorAll('[data-action="cancel-rental-motos"]').forEach(function (btn) {
      btn.addEventListener('click', function () { editingRentalMotosFor = null; renderRoot(); });
    });
    document.querySelectorAll('[data-action="save-rental-motos"]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var input = document.getElementById('rental-motos-input');
        saveRentalMotos(btn.getAttribute('data-id'), input ? input.value : '');
      });
    });
    document.querySelectorAll('[data-action="edit-rental-equipement"]').forEach(function (btn) {
      btn.addEventListener('click', function () { editingRentalEquipementFor = btn.getAttribute('data-id'); renderRoot(); });
    });
    document.querySelectorAll('[data-action="cancel-rental-equipement"]').forEach(function (btn) {
      btn.addEventListener('click', function () { editingRentalEquipementFor = null; renderRoot(); });
    });
    document.querySelectorAll('[data-action="save-rental-equipement"]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var input = document.getElementById('rental-equipement-input');
        saveRentalEquipement(btn.getAttribute('data-id'), input ? input.value : '');
      });
    });
    document.querySelectorAll('[data-action="event-announcement-delete"]').forEach(function (btn) {
      btn.addEventListener('click', function () { deleteEventAnnouncement(btn.getAttribute('data-id')); });
    });
    document.querySelectorAll('[data-action="team-invite-accept"]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var invite = (STATE.teamInvites || []).filter(function (r) { return r.id === btn.getAttribute('data-id'); })[0];
        if (invite) acceptTeamInvite(invite);
      });
    });
    document.querySelectorAll('[data-action="team-invite-remove"]').forEach(function (btn) {
      btn.addEventListener('click', function () { removeTeamInvite(btn.getAttribute('data-id')); });
    });
    document.querySelectorAll('[data-action="team-leave"]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        if (currentUserProfile) removeTeamMember(btn.getAttribute('data-team'), currentUserProfile.name);
      });
    });
    document.querySelectorAll('[data-action="team-request-adherent"]').forEach(function (btn) {
      btn.addEventListener('click', function () { requestTeamAdherent(btn.getAttribute('data-team')); });
    });
    document.querySelectorAll('[data-action="team-adherent-accept"]').forEach(function (btn) {
      btn.addEventListener('click', function () { decideTeamAdherentRequest(btn.getAttribute('data-follow-id'), true); });
    });
    document.querySelectorAll('[data-action="team-adherent-decline"]').forEach(function (btn) {
      btn.addEventListener('click', function () { decideTeamAdherentRequest(btn.getAttribute('data-follow-id'), false); });
    });
    document.querySelectorAll('[data-action="team-join-request"]').forEach(function (btn) {
      btn.addEventListener('click', function () { requestJoinTeam(btn.getAttribute('data-team')); });
    });
    document.querySelectorAll('[data-action="team-join-request-accept"]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var req = (STATE.teamJoinRequests || []).filter(function (r) { return r.id === btn.getAttribute('data-id'); })[0];
        if (req) acceptTeamJoinRequestAs(req, btn.getAttribute('data-role'));
      });
    });
    document.querySelectorAll('[data-action="team-join-request-remove"]').forEach(function (btn) {
      btn.addEventListener('click', function () { removeTeamJoinRequest(btn.getAttribute('data-id')); });
    });
    document.querySelectorAll('[data-action="event-join-ouvert"]').forEach(function (btn) {
      btn.addEventListener('click', function () { selfJoinOuvertEvent(btn.getAttribute('data-id')); });
    });
    document.querySelectorAll('[data-action="event-join-request"]').forEach(function (btn) {
      btn.addEventListener('click', function () { requestJoinEvent(btn.getAttribute('data-id')); });
    });
    document.querySelectorAll('[data-action="open-external-url"]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var url = btn.getAttribute('data-url');
        if (url) window.open(url, '_blank', 'noopener');
      });
    });
    document.querySelectorAll('[data-action="discovery-view-mode"]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        discoveryViewMode = btn.getAttribute('data-mode');
        renderRoot();
      });
    });
    document.querySelectorAll('[data-action="discovery-sort-mode"]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        discoverySortMode = btn.getAttribute('data-mode');
        renderRoot();
      });
    });
    var discoveryCalPrev = document.getElementById('discovery-cal-prev');
    if (discoveryCalPrev) {
      discoveryCalPrev.addEventListener('click', function () {
        var d = parseLocalDate(discoveryCalendarAnchor);
        if (discoveryViewMode === 'year') d.setFullYear(d.getFullYear() - 1);
        else d.setMonth(d.getMonth() - 1);
        discoveryCalendarAnchor = dateKey(d);
        renderRoot();
      });
    }
    var discoveryCalNext = document.getElementById('discovery-cal-next');
    if (discoveryCalNext) {
      discoveryCalNext.addEventListener('click', function () {
        var d = parseLocalDate(discoveryCalendarAnchor);
        if (discoveryViewMode === 'year') d.setFullYear(d.getFullYear() + 1);
        else d.setMonth(d.getMonth() + 1);
        discoveryCalendarAnchor = dateKey(d);
        renderRoot();
      });
    }
    document.querySelectorAll('[data-discovery-date]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var date = btn.getAttribute('data-discovery-date');
        discoverySelectedDate = discoverySelectedDate === date ? null : date;
        renderRoot();
      });
    });
    document.querySelectorAll('[data-action="event-join-request-accept"]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var req = (STATE.eventJoinRequests || []).filter(function (r) { return r.id === btn.getAttribute('data-id'); })[0];
        if (req) acceptEventJoinRequest(req);
      });
    });
    document.querySelectorAll('[data-action="event-join-request-remove"]').forEach(function (btn) {
      btn.addEventListener('click', function () { removeEventJoinRequest(btn.getAttribute('data-id')); });
    });
    document.querySelectorAll('[data-action="team-like-toggle"]').forEach(function (btn) {
      btn.addEventListener('click', function () { toggleTeamLike(btn.getAttribute('data-team')); });
    });
    var copyReferralBtn = document.getElementById('copy-referral-link-btn');
    if (copyReferralBtn) {
      copyReferralBtn.addEventListener('click', function () {
        if (!currentUserProfile) return;
        var link = referralLinkFor(currentUserProfile.name);
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(link).then(function () {
            showToast('Lien de parrainage copié.', 'success');
          }).catch(function () {
            showToast('Impossible de copier — copie-le manuellement : ' + link);
          });
        }
      });
    }
    var shareReferralBtn = document.getElementById('share-referral-link-btn');
    if (shareReferralBtn) {
      shareReferralBtn.addEventListener('click', function () {
        if (!currentUserProfile) return;
        var link = referralLinkFor(currentUserProfile.name);
        if (navigator.share) {
          navigator.share({ title: 'Carnet de Piste', text: 'Rejoins-nous sur Carnet de Piste !', url: link }).catch(function () {});
        } else if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(link).then(function () {
            showToast('Lien de parrainage copié.', 'success');
          });
        }
      });
    }
    document.querySelectorAll('[data-theme-choice]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        setThemePref(btn.getAttribute('data-theme-choice'));
      });
    });
    var form = document.getElementById('session-form');
    if (form) form.addEventListener('submit', onSubmit);
    var fDateEl = document.getElementById('f-date');
    autoFormatFrDateInput(fDateEl);
    var fRiderEl = document.getElementById('f-rider');
    var fCircuitEl = document.getElementById('f-circuit');
    // Shared by the rider/circuit/date fields: whichever one changes, the
    // linked-sortie suggestion, the bike suggestion (from "Mon profil")
    // and the group suggestion (from that sortie's rider assignment) all
    // need to be recomputed together, not just the one field that changed.
    function refreshChronoFormAux() {
      var rider = fRiderEl ? fRiderEl.value : ((currentUserProfile && currentUserProfile.name) || '');
      var circuit = fCircuitEl ? fCircuitEl.value : selectedCircuit;
      var iso = frDateToIso(fDateEl.value) || dateKey(new Date());
      var wrap = document.getElementById('f-linked-event-wrap');
      if (wrap) wrap.innerHTML = renderLinkedEventField(circuit, iso);
      var bikeEl = document.getElementById('f-bike');
      if (bikeEl && rider && riderBikeMap[rider]) bikeEl.value = riderBikeMap[rider];
      var groupEl = document.getElementById('f-group');
      var groupHintEl = document.getElementById('f-group-hint');
      var hint = rider ? chronoGroupHint(circuit, iso, rider) : '';
      if (groupEl && hint && !groupEl.dataset.userTouched) groupEl.value = hint;
      if (groupHintEl) {
        if (hint) {
          groupHintEl.style.display = '';
          groupHintEl.textContent = 'Groupe suggéré depuis l’événement associé : ' + hint + '.';
        } else {
          groupHintEl.style.display = 'none';
        }
      }
      var slotEl = document.getElementById('f-slot');
      var slotHintEl = document.getElementById('f-slot-hint');
      var slots = todaysGroupSlots(circuit, groupEl ? groupEl.value : '');
      var suggestedIdx = suggestSlotIndex(slots);
      if (slotEl) {
        slotEl.innerHTML = renderSlotOptions(slots, suggestedIdx);
      }
      if (slotHintEl) slotHintEl.style.display = suggestedIdx !== -1 ? '' : 'none';
    }
    if (fDateEl) fDateEl.addEventListener('input', refreshChronoFormAux);
    if (fRiderEl) fRiderEl.addEventListener('change', refreshChronoFormAux);
    if (fCircuitEl) fCircuitEl.addEventListener('change', refreshChronoFormAux);
    var fGroupEl = document.getElementById('f-group');
    if (fGroupEl) {
      fGroupEl.addEventListener('change', function () {
        fGroupEl.dataset.userTouched = '1';
        refreshChronoFormAux();
      });
    }
    var fLapsEl = document.getElementById('f-laps');
    if (fLapsEl) attachLapsAutoFormat(fLapsEl);
    var recapShareBtn = document.getElementById('daily-recap-share-btn');
    if (recapShareBtn) {
      recapShareBtn.addEventListener('click', function () {
        var card = recapShareBtn.closest('.daily-recap-card');
        var circuit = card.getAttribute('data-recap-circuit');
        var dateStr = card.getAttribute('data-recap-date');
        var text = dailyRecapShareText(circuit, dateStr, dailyRecapRows(circuit, dateStr));
        if (navigator.share) {
          navigator.share({ text: text }).catch(function () {}); // user-cancelled share is not an error
        } else if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(function () {
            showToast('Récap copié — colle-le où tu veux.', 'success');
          }).catch(function () {
            showToast('Impossible de copier le récap.');
          });
        }
      });
    }
    var nextOutingLink = document.getElementById('next-outing-link');
    if (nextOutingLink) {
      nextOutingLink.addEventListener('click', function () {
        var ev = eventsList().filter(function (e) { return e.id === nextOutingLink.getAttribute('data-event-id'); })[0];
        if (!ev) return;
        activeView = 'event';
        selectEvent(ev.id);
        calendarAnchor = ev.dateStart;
        renderRoot();
      });
    }
    var planOutingLink = document.getElementById('plan-outing-link');
    if (planOutingLink) {
      planOutingLink.addEventListener('click', function () {
        activeView = 'event';
        editingEventId = 'new';
        selectedEventId = null;
        prefillEventCircuit = selectedCircuit;
        renderRoot();
      });
    }
    document.querySelectorAll('[data-action="delete-request"]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.getAttribute('data-id');
        if (pendingDelete === id) {
          removeSession(id);
          pendingDelete = null;
        } else {
          pendingDelete = id;
          btn.textContent = '✓';
          btn.setAttribute('aria-label', 'Confirmer la suppression');
          btn.setAttribute('title', 'Confirmer la suppression');
          btn.classList.add('confirm');
        }
      });
    });

    document.querySelectorAll('[data-action="certify-session"]').forEach(function (btn) {
      btn.addEventListener('click', function () { certifyChrono(btn.getAttribute('data-id')); });
    });
    document.querySelectorAll('[data-action="uncertify-session"]').forEach(function (btn) {
      btn.addEventListener('click', function () { uncertifyChrono(btn.getAttribute('data-id')); });
    });
    document.querySelectorAll('[data-action="edit-session-request"]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        editingSessionId = btn.getAttribute('data-id');
        renderRoot();
      });
    });
    var cancelSessionEditBtn = document.getElementById('cancel-session-edit-btn');
    if (cancelSessionEditBtn) cancelSessionEditBtn.addEventListener('click', function () { editingSessionId = null; renderRoot(); });
    var sessionEditForm = document.getElementById('session-edit-form');
    if (sessionEditForm) sessionEditForm.addEventListener('submit', onSessionEditSubmit);
    autoFormatFrDateInput(document.getElementById('se-date'));

    document.querySelectorAll('[data-view]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        activeView = btn.getAttribute('data-view');
        profilePanelOpen = false;
        notificationsPanelOpen = false;
        editingEventId = null;
        prefillEventCircuit = null;
        prefillEventTeamId = null;
        pendingDeleteEvent = null;
        editingSessionId = null;
        renderRoot();
        // The header/bottom nav stay put (position:fixed) -- only the
        // content between them scrolls, so switching tab has to reset
        // that scroll itself, the way a native app's tab bar always opens
        // each tab at its top.
        window.scrollTo(0, 0);
      });
    });
    document.querySelectorAll('[data-calendar-view]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        calendarViewMode = btn.getAttribute('data-calendar-view');
        renderRoot();
      });
    });
    var calPrev = document.getElementById('cal-prev');
    if (calPrev) calPrev.addEventListener('click', function () { calendarNavStep(-1); renderRoot(); });
    var calNext = document.getElementById('cal-next');
    if (calNext) calNext.addEventListener('click', function () { calendarNavStep(1); renderRoot(); });
    var calToday = document.getElementById('cal-today');
    if (calToday) calToday.addEventListener('click', function () { calendarAnchor = dateKey(new Date()); renderRoot(); });

    // A day cell carrying a planned outing selects it and stays on
    // Calendrier — the sorties list below (same accordion as Événement)
    // then shows it expanded in place. A day with only ridden sessions and
    // no outing shows its chronos inline instead.
    document.querySelectorAll('.calendar-cell[data-date]').forEach(function (el) {
      el.addEventListener('click', function () {
        var evId = el.getAttribute('data-event-id');
        var dateStr = el.getAttribute('data-date');
        if (evId) {
          selectEvent(evId);
          renderRoot();
          return;
        }
        var sessionsHere = sessionsOnDate(dateStr);
        selectedSessionDate = sessionsHere.length ? dateStr : null;
        renderRoot();
      });
    });
    // Every sorties list (Calendrier's period card and the Événement tab's
    // groups) is the same accordion: clicking the open row again collapses
    // it, clicking another row switches to it — nothing here navigates tabs.
    document.querySelectorAll('.event-row-toggle[data-event-id]').forEach(function (row) {
      row.addEventListener('click', function () {
        var id = row.getAttribute('data-event-id');
        if (selectedEventId === id) {
          selectedEventId = null;
        } else {
          selectEvent(id);
        }
        renderRoot();
      });
    });
    document.querySelectorAll('.past-year-toggle[data-past-year]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var year = btn.getAttribute('data-past-year');
        expandedPastYears[year] = !expandedPastYears[year];
        renderRoot();
      });
    });
    var lastOutingLink = document.getElementById('last-outing-link');
    if (lastOutingLink) {
      lastOutingLink.addEventListener('click', function () {
        selectEvent(lastOutingLink.getAttribute('data-event-id'));
        activeView = 'event';
        renderRoot();
      });
    }
    var closeEventDetail = document.getElementById('close-event-detail');
    if (closeEventDetail) closeEventDetail.addEventListener('click', function () { selectedEventId = null; renderRoot(); });
    var closeSessionDay = document.getElementById('close-session-day');
    if (closeSessionDay) closeSessionDay.addEventListener('click', function () { selectedSessionDate = null; renderRoot(); });
    document.querySelectorAll('input[data-checklist-key]').forEach(function (cb) {
      cb.addEventListener('change', function () {
        toggleEventChecklist(cb.getAttribute('data-event-id'), cb.getAttribute('data-checklist-key'), cb.checked);
      });
    });
    document.querySelectorAll('[data-action="event-group-add-form"]').forEach(function (form) {
      form.addEventListener('submit', function (evt) {
        evt.preventDefault();
        var input = form.querySelector('[data-event-group-add-input]');
        var name = input ? input.value.trim() : '';
        if (name) assignRiderToGroup(form.getAttribute('data-event-id'), name, form.getAttribute('data-group'));
        if (input) input.value = '';
      });
    });
    document.querySelectorAll('[data-action="event-group-remove"]').forEach(function (btn) {
      btn.addEventListener('click', function () { removeRiderFromGroup(btn.getAttribute('data-id'), btn.getAttribute('data-rider')); });
    });
    // Drag a rider's row (see riderRow's draggable attribute) onto another
    // group's drop zone to move them there in one gesture -- mainly a
    // desktop convenience (touch browsers mostly don't fire native HTML5
    // drag events), the search-to-add form and × button above still cover
    // mobile either way.
    document.querySelectorAll('[data-drag-rider]').forEach(function (el) {
      el.addEventListener('dragstart', function (evt) {
        draggedGroupRider = el.getAttribute('data-drag-rider');
        if (evt.dataTransfer) {
          evt.dataTransfer.effectAllowed = 'move';
          evt.dataTransfer.setData('text/plain', draggedGroupRider);
        }
      });
      el.addEventListener('dragend', function () { draggedGroupRider = null; });
    });
    document.querySelectorAll('[data-drop-group]').forEach(function (zone) {
      zone.addEventListener('dragover', function (evt) {
        evt.preventDefault();
        zone.classList.add('group-drop-zone-hover');
      });
      zone.addEventListener('dragleave', function () { zone.classList.remove('group-drop-zone-hover'); });
      zone.addEventListener('drop', function (evt) {
        evt.preventDefault();
        zone.classList.remove('group-drop-zone-hover');
        if (!draggedGroupRider) return;
        var group = zone.getAttribute('data-drop-group');
        var eventId = zone.getAttribute('data-event-id');
        if (group) assignRiderToGroup(eventId, draggedGroupRider, group);
        else removeRiderFromGroup(eventId, draggedGroupRider);
        draggedGroupRider = null;
      });
    });
    var editEventBtn = document.getElementById('edit-event-btn');
    if (editEventBtn) {
      editEventBtn.addEventListener('click', function () {
        editingEventId = editEventBtn.getAttribute('data-id');
        pendingDeleteEvent = null;
        renderRoot();
      });
    }
    document.querySelectorAll('[data-action="edit-media-link"]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        editingMediaLinkFor = btn.getAttribute('data-id');
        renderRoot();
      });
    });
    var cancelMediaLinkBtn = document.querySelector('[data-action="cancel-media-link"]');
    if (cancelMediaLinkBtn) {
      cancelMediaLinkBtn.addEventListener('click', function () {
        editingMediaLinkFor = null;
        renderRoot();
      });
    }
    document.querySelectorAll('[data-action="save-media-link"]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var input = document.getElementById('media-link-input');
        saveMediaLink(btn.getAttribute('data-id'), input.value.trim());
      });
    });
    document.querySelectorAll('[data-action="save-travel-info"]').forEach(function (btn) {
      btn.addEventListener('click', function () { saveMyTravelInfo(btn.getAttribute('data-event-id')); });
    });
    var addChronoToggle = document.getElementById('add-chrono-toggle');
    if (addChronoToggle) {
      addChronoToggle.addEventListener('click', function () {
        addChronoOpen = true;
        renderRoot();
      });
    }
    var addEventBtn = document.getElementById('add-event-btn');
    if (addEventBtn) {
      addEventBtn.addEventListener('click', function () {
        editingEventId = 'new';
        selectedEventId = null;
        prefillEventCircuit = null;
        prefillEventTeamId = null;
        pendingDeleteEvent = null;
        renderRoot();
      });
    }
    document.querySelectorAll('[data-action="team-event-add"]').forEach(function (btn) {
      btn.addEventListener('click', function (evt) {
        // Sits inside the "Gestion des événements" card's <summary> now
        // (see collapsibleCard's titleActionsHtml) -- without this, the
        // click would also toggle the card open/closed, since that's the
        // default action of clicking anywhere in a <summary>. But
        // preventDefault() alone left a Team with zero events (the card
        // defaults to closed, see renderTeamEventsManagement) stuck: the
        // form below rendered inside a still-collapsed <details>, so
        // clicking "+ Ajouter" appeared to do nothing at all. Force this
        // card open explicitly instead of relying on the native toggle.
        evt.preventDefault();
        var teamId = btn.getAttribute('data-team');
        planningSectionsOpen['team-events-' + teamId] = true;
        editingEventId = 'new';
        selectedEventId = null;
        prefillEventCircuit = null;
        prefillEventTeamId = teamId;
        pendingDeleteEvent = null;
        renderRoot();
      });
    });
    document.querySelectorAll('[data-action="team-event-edit"]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        editingEventId = btn.getAttribute('data-id');
        prefillEventCircuit = null;
        prefillEventTeamId = null;
        pendingDeleteEvent = null;
        renderRoot();
      });
    });
    document.querySelectorAll('[data-action="team-event-remove-rider"]').forEach(function (btn) {
      btn.addEventListener('click', function () { removeRiderFromEvent(btn.getAttribute('data-id'), btn.getAttribute('data-rider')); });
    });
    document.querySelectorAll('[data-action="team-event-add-rider-form"]').forEach(function (form) {
      form.addEventListener('submit', function (evt) {
        evt.preventDefault();
        var select = form.querySelector('[data-team-event-add-rider-select]');
        if (select && select.value) addRiderToEvent(form.getAttribute('data-event-id'), select.value);
      });
    });
    var cancelEventBtn = document.getElementById('cancel-event-btn');
    if (cancelEventBtn) cancelEventBtn.addEventListener('click', function () { editingEventId = null; prefillEventCircuit = null; prefillEventTeamId = null; pendingDeleteEvent = null; renderRoot(); });
    var eventForm = document.getElementById('event-form');
    if (eventForm) eventForm.addEventListener('submit', onEventSubmit);
    // Riders and dates typed into the open sortie form drive the groups
    // grid live, without touching the rest of the form.
    var evRidersEl = document.getElementById('ev-riders');
    if (evRidersEl) evRidersEl.addEventListener('input', refreshEventFormGroups);
    var evMoreOptionsToggle = document.getElementById('ev-more-options-toggle');
    if (evMoreOptionsToggle) {
      evMoreOptionsToggle.addEventListener('click', function () {
        eventFormMoreOptionsOpen = !eventFormMoreOptionsOpen;
        var panel = document.getElementById('ev-more-options');
        if (panel) panel.style.display = eventFormMoreOptionsOpen ? 'block' : 'none';
        evMoreOptionsToggle.textContent = eventFormMoreOptionsOpen ? '− Moins d\'options' : '+ Plus d\'options (horaires, pilotes, organisateur...)';
      });
    }
    // Search-and-add Pilotes widget (see renderEventForm) -- a datalist
    // has no "onselect", so matching the typed value against a known
    // candidate on every keystroke is the usual trick for detecting a
    // pick. Adding updates the hidden #ev-riders field directly (instead
    // of a full renderRoot) so refreshEventFormGroups can pick it straight
    // up, then still re-renders once to show the new chip.
    var evRidersSearchEl = document.getElementById('ev-riders-search');
    if (evRidersSearchEl) {
      evRidersSearchEl.addEventListener('input', function () {
        var typed = evRidersSearchEl.value.trim();
        if (!typed || eventFormRidersDraft.indexOf(typed) !== -1) return;
        var known = allKnownRiders().indexOf(typed) !== -1 || isAdmin();
        if (!known) return;
        eventFormRidersDraft.push(typed);
        if (evRidersEl) evRidersEl.value = eventFormRidersDraft.join(',');
        refreshEventFormGroups();
        renderRoot();
      });
    }
    document.querySelectorAll('[data-action="ev-rider-remove"]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var name = btn.getAttribute('data-name');
        eventFormRidersDraft = eventFormRidersDraft.filter(function (r) { return r !== name; });
        if (evRidersEl) evRidersEl.value = eventFormRidersDraft.join(',');
        refreshEventFormGroups();
        renderRoot();
      });
    });
    var evCircuitEl = document.getElementById('ev-circuit');
    if (evCircuitEl && editingEventId === 'new') {
      evCircuitEl.addEventListener('change', function () {
        var defaults = circuitInfo(evCircuitEl.value.trim());
        var teamEl = document.getElementById('ev-team');
        if (teamEl && !teamEl.value && defaults.organizerTeamId) {
          var hasOption = Array.prototype.some.call(teamEl.options, function (o) { return o.value === defaults.organizerTeamId; });
          if (hasOption) { teamEl.value = defaults.organizerTeamId; teamEl.dispatchEvent(new Event('change')); }
        }
      });
    }
    if (evCircuitEl) {
      var evCircuitWarningEl = document.getElementById('ev-circuit-warning');
      if (evCircuitWarningEl) {
        var updateCircuitWarning = function () {
          var typed = evCircuitEl.value.trim();
          var known = typed && allCircuits().indexOf(typed) === -1;
          evCircuitWarningEl.classList.toggle('visible', known);
        };
        evCircuitEl.addEventListener('input', updateCircuitWarning);
      }
    }
    var evTeamEl = document.getElementById('ev-team');
    if (evTeamEl) {
      evTeamEl.addEventListener('change', function () {
        var wrap = document.getElementById('ev-visibility-wrap');
        if (!wrap) return;
        var team = evTeamEl.value ? teamById(evTeamEl.value) : null;
        wrap.style.display = (team && team.teamPro) ? 'block' : 'none';
      });
    }
    var evDateStartEl = document.getElementById('ev-date-start');
    if (evDateStartEl) { evDateStartEl.addEventListener('input', refreshEventFormGroups); autoFormatFrDateInput(evDateStartEl); }
    var evDateEndEl = document.getElementById('ev-date-end');
    if (evDateEndEl) { evDateEndEl.addEventListener('input', refreshEventFormGroups); autoFormatFrDateInput(evDateEndEl); }
    attachEventFormGroupHandlers();
    document.querySelectorAll('[data-action="delete-event-request"]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.getAttribute('data-id');
        if (pendingDeleteEvent === id) {
          removeEvent(id);
          pendingDeleteEvent = null;
        } else {
          pendingDeleteEvent = id;
        }
        // Re-rendered rather than mutated in place -- deleteEventControl()
        // now reads pendingDeleteEvent itself, so the confirm state stays
        // correct even if a live-sync update re-renders this button
        // in between the two clicks (see deleteEventControl's comment).
        renderRoot();
      });
    });
    document.querySelectorAll('[data-action="delete-event-cancel"]').forEach(function (btn) {
      btn.addEventListener('click', function () { pendingDeleteEvent = null; renderRoot(); });
    });

    document.querySelectorAll('[data-planning-section]').forEach(function (details) {
      details.addEventListener('toggle', function () {
        planningSectionsOpen[details.getAttribute('data-planning-section')] = details.open;
      });
    });
    document.querySelectorAll('[data-planning-group]').forEach(function (cb) {
      cb.addEventListener('change', function () {
        var selected = [];
        document.querySelectorAll('[data-planning-group]').forEach(function (b) {
          if (b.checked) selected.push(b.getAttribute('data-planning-group'));
        });
        planningGroupFilter = selected;
        renderRoot();
      });
    });

    document.querySelectorAll('.checklist-add-item-form').forEach(function (form) {
      form.addEventListener('submit', function (evt) {
        evt.preventDefault();
        var input = form.querySelector('[data-new-item-input]');
        if (!input || !input.value.trim()) return;
        addChecklistItem(form.getAttribute('data-add-item-category'), input.value);
      });
    });
    var addCategoryForm = document.getElementById('add-checklist-category-form');
    if (addCategoryForm) {
      addCategoryForm.addEventListener('submit', function (evt) {
        evt.preventDefault();
        var input = document.getElementById('new-checklist-category');
        if (!input || !input.value.trim()) return;
        addChecklistCategory(input.value);
      });
    }
    document.querySelectorAll('[data-action="remove-checklist-item"]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        removeChecklistItem(btn.getAttribute('data-category'), btn.getAttribute('data-item'));
      });
    });
    document.querySelectorAll('[data-action="remove-checklist-category"]').forEach(function (btn) {
      btn.addEventListener('click', function (evt) {
        // This button sits inside a <summary> (the category's collapsible
        // header) -- without stopping the click here, the browser's
        // default "click toggles the parent <details>" behavior fires too.
        evt.preventDefault();
        evt.stopPropagation();
        var categoryId = btn.getAttribute('data-category');
        if (pendingDeleteChecklistCategory === categoryId) {
          removeChecklistCategory(categoryId);
          pendingDeleteChecklistCategory = null;
        } else {
          pendingDeleteChecklistCategory = categoryId;
          renderRoot();
        }
      });
    });
    var riderManagerToggle = document.getElementById('rider-manager-toggle');
    if (riderManagerToggle) {
      riderManagerToggle.addEventListener('click', function () {
        riderManagerOpen = !riderManagerOpen;
        editingRiderName = null;
        pendingDeleteRider = null;
        riderManagerError = '';
        renderRoot();
      });
    }
    var addRiderForm = document.getElementById('add-rider-form');
    if (addRiderForm) {
      addRiderForm.addEventListener('submit', function (evt) {
        evt.preventDefault();
        var input = document.getElementById('new-rider-name');
        var name = input.value.trim();
        if (!name) return;
        addRider(name);
      });
    }
    document.querySelectorAll('[data-action="rename-rider-request"]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        editingRiderName = btn.getAttribute('data-rider');
        pendingDeleteRider = null;
        riderManagerError = '';
        renderRoot();
      });
    });
    var cancelRenameBtn = document.querySelector('[data-action="cancel-rename-rider"]');
    if (cancelRenameBtn) {
      cancelRenameBtn.addEventListener('click', function () {
        editingRiderName = null;
        renderRoot();
      });
    }
    var renameRiderForm = document.querySelector('.rider-manager-rename-form');
    if (renameRiderForm) {
      renameRiderForm.addEventListener('submit', function (evt) {
        evt.preventDefault();
        var oldName = renameRiderForm.getAttribute('data-rename-rider');
        var newName = renameRiderForm.querySelector('[name="new-name"]').value.trim();
        if (!newName) return;
        renameRider(oldName, newName);
      });
    }
    document.querySelectorAll('[data-action="delete-rider-request"]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var name = btn.getAttribute('data-rider');
        if (pendingDeleteRider === name) {
          deleteRider(name);
        } else {
          pendingDeleteRider = name;
          editingRiderName = null;
          riderManagerError = '';
          renderRoot();
        }
      });
    });

    var circuitSelect = document.getElementById('f-filter-circuit');
    if (circuitSelect) {
      circuitSelect.addEventListener('change', function () {
        selectedCircuit = circuitSelect.value;
        editingCircuitInfo = false;
        editingSessionId = null;
        renderRoot();
      });
    }
    var editInfoBtn = document.getElementById('edit-circuit-info-btn');
    if (editInfoBtn) editInfoBtn.addEventListener('click', function () { editingCircuitInfo = true; renderRoot(); });
    var cancelInfoBtn = document.getElementById('cancel-circuit-info-btn');
    if (cancelInfoBtn) cancelInfoBtn.addEventListener('click', function () { editingCircuitInfo = false; renderRoot(); });
    var saveInfoBtn = document.getElementById('save-circuit-info-btn');
    if (saveInfoBtn) saveInfoBtn.addEventListener('click', saveCircuitInfo);
    var openAnnotBtn = document.getElementById('open-annot-btn');
    if (openAnnotBtn) {
      openAnnotBtn.addEventListener('click', function () {
        openAnnotation(openAnnotBtn.getAttribute('data-circuit') || selectedCircuit, openAnnotBtn.getAttribute('data-event-id') || null);
      });
    }
    var accountManagerSearchEl = document.getElementById('account-manager-search');
    if (accountManagerSearchEl) {
      accountManagerSearchEl.addEventListener('input', function () {
        accountManagerSearch = accountManagerSearchEl.value;
        renderRoot();
      });
    }
    var progressionCircuitSelect = document.getElementById('progression-circuit-select');
    if (progressionCircuitSelect) {
      progressionCircuitSelect.addEventListener('change', function () {
        progressionCircuitPick = progressionCircuitSelect.value;
        renderRoot();
      });
    }
    var progressionDaySelect = document.getElementById('progression-day-select');
    if (progressionDaySelect) {
      progressionDaySelect.addEventListener('change', function () {
        progressionDayPick = progressionDaySelect.value;
        renderRoot();
      });
    }
    var progressionEventSelect = document.getElementById('progression-event-select');
    if (progressionEventSelect) {
      progressionEventSelect.addEventListener('change', function () {
        progressionEventPick = progressionEventSelect.value;
        renderRoot();
      });
    }
    document.querySelectorAll('[data-action="progression-granularity"]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        progressionGranularity = btn.getAttribute('data-granularity');
        renderRoot();
      });
    });
    document.querySelectorAll('.progression-point').forEach(function (el) {
      el.addEventListener('click', function () {
        var idx = parseInt(el.getAttribute('data-idx'), 10);
        var p = PROGRESSION_POINTS[idx];
        var caption = document.getElementById('progression-caption');
        if (p && caption) {
          caption.textContent = (PROGRESSION_MULTI ? p.rider + ' — ' : '') + formatDate(p.date) + ' — ' + formatTime(p.time) + (p.isBest ? ' (record)' : '');
        }
      });
    });
  }

  function onSubmit(ev) {
    ev.preventDefault();
    var riderEl = document.getElementById('f-rider');
    var circuitEl = document.getElementById('f-circuit');
    var dateEl = document.getElementById('f-date');
    var bikeEl = document.getElementById('f-bike');
    var lapsEl = document.getElementById('f-laps');
    var noteEl = document.getElementById('f-note');
    var groupEl = document.getElementById('f-group');
    var slotEl = document.getElementById('f-slot');
    var errEl = document.getElementById('form-error');
    errEl.classList.remove('visible');

    // Only the admin gets an actual #f-rider select (see renderForm) --
    // anyone else is locked to their own account name, never whatever
    // happens to be active in the global rider filter.
    var rider = riderEl ? riderEl.value.trim() : ((currentUserProfile && currentUserProfile.name) || '');
    var date = frDateToIso(dateEl.value);
    var circuit = circuitEl ? circuitEl.value : selectedCircuit;
    var bike = bikeEl.value.trim();
    var note = noteEl.value.trim();
    var group = groupEl ? groupEl.value : '';
    var rawLaps = lapsEl.value.split(/[\n,;]+/).map(function (s) { return s.trim(); }).filter(Boolean);
    var laps = [];
    var invalid = false;
    rawLaps.forEach(function (raw) {
      var t = parseTime(raw);
      if (t === null) { invalid = true; } else { laps.push(t); }
    });

    if (dateEl.value.trim() && !date) {
      errEl.textContent = 'Date invalide — format attendu JJ/MM/AAAA.';
      errEl.classList.add('visible');
      return;
    }
    // A chrono is necessarily logged after the fact -- a future date can
    // only ever be a typo (day/month swapped, wrong year...), and one
    // slipping through used to actively break things: normalizeSelection's
    // last-resort default-circuit fallback picks whichever circuit has the
    // single most recent session date across *every* account, so one
    // mistyped future date silently hijacked the default circuit shown to
    // everyone, indefinitely, until manually found and fixed.
    if (date && date > dateKey(new Date())) {
      errEl.textContent = 'Cette date est dans le futur — vérifie le jour/mois/année (' + dateEl.value + ').';
      errEl.classList.add('visible');
      return;
    }
    if (!rider || !date || !circuit || !laps.length) {
      errEl.textContent = 'Renseignez un pilote, une date et au moins un chrono valide.';
      errEl.classList.add('visible');
      return;
    }
    if (invalid) {
      errEl.textContent = 'Certains chronos sont illisibles — format attendu 1:23.456 ou 83.456.';
      errEl.classList.add('visible');
      return;
    }

    var previousBest = riderCircuitBest(rider, circuit);
    var session = { id: genId(), rider: rider, date: date, circuit: circuit, laps: laps };
    if (bike) session.bike = bike;
    if (note) session.note = note;
    if (group) session.group = group;
    // Entering a chrono for a teammate (an organisateur for one of their
    // team's pilotes, typically) rather than one's own -- tags which team
    // granted the access, since firestore.rules can't otherwise verify a
    // non-owner write (see ownsChronoViaTeam).
    if (!isAdmin() && currentUserProfile && rider !== currentUserProfile.name) {
      var grantingTeamId = myTeamPiloteChoices()[rider];
      if (grantingTeamId) session.teamId = grantingTeamId;
    }
    // The precise timed slot (e.g. "9h40-10h00"), when one was picked --
    // re-derived from the current horaires/group rather than trusting the
    // <option> text alone, so a stale selection can't outlive a horaires
    // edit made mid-form.
    if (slotEl && slotEl.value) {
      var chosenSlot = todaysGroupSlots(circuit, group).filter(function (s) { return String(s.start) === slotEl.value; })[0];
      if (chosenSlot) {
        session.slotStart = chosenSlot.start;
        session.slotEnd = chosenSlot.end;
        session.slotLabel = chosenSlot.label;
      }
    }
    var prevState = JSON.parse(JSON.stringify(STATE));

    // Linked via the "Sortie associée" suggestion (renderLinkedEventField),
    // pre-selected to whichever sortie on this circuit covers the chosen
    // date -- a rider can still pick "Aucune" to skip it.
    var linkedEventEl = document.getElementById('f-linked-event');
    var linkedEventId = linkedEventEl ? linkedEventEl.value : '';
    var linkedEvent = linkedEventId ? eventsList().filter(function (e) { return e.id === linkedEventId; })[0] : null;
    if (linkedEvent) {
      session.eventId = linkedEvent.id;
      linkedEvent.riders = linkedEvent.riders || [];
      if (linkedEvent.riders.indexOf(rider) === -1) linkedEvent.riders.push(rider);
    }

    STATE.sessions.push(session);
    selectedRiders = new Set([rider]);
    selectedCircuit = circuit;
    addChronoOpen = false;
    renderRoot();
    persist(prevState);

    var newBest = sessionBest(session);
    if (previousBest === null || newBest < previousBest) {
      showToast('Nouveau record personnel sur ' + circuit + ' : ' + formatTime(newBest) + ' !', 'success');
      if (previousBest !== null) writeFeedEvent('record', { circuit: circuit, time: newBest, sessionId: session.id });
    } else {
      showToast('Chrono enregistré.', 'success');
    }
    // On by default, opt-out (see Réglages), and only for a chrono this
    // account entered for itself -- an organisateur/admin entering one
    // for a teammate has no feeling of their own to report.
    if (currentUserProfile && currentUserProfile.sessionFeelingEnabled !== false && rider === currentUserProfile.name) {
      openFeelingModal(session.id);
    }
  }

  function removeSession(id) {
    var prevState = JSON.parse(JSON.stringify(STATE));
    STATE.sessions = STATE.sessions.filter(function (s) { return s.id !== id; });
    renderRoot();
    persist(prevState);
    // A deleted chrono's own "a battu son record" Journal entry (see
    // writeFeedEvent's caller in onSubmit) would otherwise live on
    // forever, pointing at a record that no longer exists.
    db.collection('feedEvents').where('sessionId', '==', id).get().then(function (snap) {
      var batch = db.batch();
      snap.forEach(function (d) { batch.delete(d.ref); });
      return snap.size ? batch.commit() : null;
    }).catch(function () {});
  }

  // header.page-head is position:fixed (see style.css) so it stays put
  // like a native app's title bar -- .wrap's own padding-top has to match
  // its real rendered height exactly, or content either hides underneath
  // it or leaves a gap, and that height isn't a constant: it wraps
  // differently per view (subtitle length), and the status banner adds a
  // row only when disconnected. Measured after every render (and on
  // resize/orientation change) rather than hardcoded.
  function updateFixedHeaderOffset() {
    var header = document.querySelector('header.page-head');
    if (!header) return;
    document.documentElement.style.setProperty('--header-h', header.offsetHeight + 'px');
  }
  window.addEventListener('resize', updateFixedHeaderOffset);

  function updateBanner() {
    var banner = document.getElementById('status-banner');
    if (!banner) return;
    if (!canPersist) {
      banner.textContent = 'Sauvegarde indisponible dans cette vue : vos modifications ne seront pas conservées.';
      banner.classList.add('visible');
      var submitBtn = document.getElementById('submit-btn');
      if (submitBtn) submitBtn.disabled = true;
    } else {
      banner.classList.remove('visible');
    }
  }

  function showToast(message, variant) {
    var stack = document.getElementById('toast-stack');
    var toast = document.createElement('div');
    toast.className = variant ? 'toast ' + variant : 'toast';
    toast.textContent = message;
    stack.appendChild(toast);
    setTimeout(function () {
      if (toast.parentNode) toast.parentNode.removeChild(toast);
    }, 4000);
  }

  function safeDocId(name) {
    return encodeURIComponent(name).slice(0, 300) || '_';
  }

  function startSync() {
    coreSyncPending = new Set(CORE_SYNC_KEYS);
    unsubscribers.push(db.collection('sessions').onSnapshot(function (snap) {
      STATE.sessions = snap.docs.map(function (d) { return d.data(); });
      maybeNotifyChronoCertified(STATE.sessions);
      markCoreSynced('sessions');
      renderRoot();
    }, handleSyncError));
    unsubscribers.push(db.collection('events').onSnapshot(function (snap) {
      STATE.events = snap.docs.map(function (d) { return d.data(); });
      maybeNotifyEndedEvents();
      markCoreSynced('events');
      renderRoot();
    }, handleSyncError));
    unsubscribers.push(db.collection('circuits').onSnapshot(function (snap) {
      var map = {};
      snap.docs.forEach(function (d) {
        var data = d.data();
        map[data.name] = data;
      });
      STATE.circuits = map;
      markCoreSynced('circuits');
      renderRoot();
    }, handleSyncError));
    unsubscribers.push(db.collection('riders').onSnapshot(function (snap) {
      STATE.riders = snap.docs.map(function (d) { return d.data().name; })
        .sort(function (a, b) { return a.localeCompare(b); });
      markCoreSynced('riders');
      renderRoot();
    }, handleSyncError));
    unsubscribers.push(db.collection('settings').doc('checklist').onSnapshot(function (doc) {
      STATE.checklistTemplate = doc.exists ? doc.data() : null;
      renderRoot();
    }, handleSyncError));
    unsubscribers.push(db.collection('settings').doc('partners').onSnapshot(function (doc) {
      STATE.partners = doc.exists ? (doc.data().list || []) : [];
      renderRoot();
    }, handleSyncError));
    // Powers the chrono form's bike auto-suggest (see refreshChronoFormAux):
    // a rider's own motorcycle, set once in "Mon profil", instead of
    // re-typing it every time a chrono is entered.
    unsubscribers.push(db.collection('users').onSnapshot(function (snap) {
      var bikeMap = {}, usersByName = {};
      snap.forEach(function (doc) {
        var data = doc.data();
        if (!data.name) return;
        if (data.bike) bikeMap[data.name] = data.bike;
        // uid (the doc's own id) isn't part of data() -- carried along
        // here so a rename's teamMembers migration (see saveProfile) can
        // tag the new doc with an unforgeable owner, not just a name that
        // itself just changed.
        usersByName[data.name] = Object.assign({ uid: doc.id }, data);
      });
      riderBikeMap = bikeMap;
      STATE.usersByName = usersByName;
      markCoreSynced('users');
      renderRoot();
    }, handleSyncError));
    // Social/amis: two live queries (Firestore can't OR across fields in
    // one query) merged into one list -- every request either sent or
    // received by this pilote, pending or accepted. Un-friending, declining
    // and cancelling are all just deleting the doc (see friendRequests
    // rules), so nothing else needs to be synced for that.
    var friendReqFrom = {}, friendReqTo = {};
    function mergeFriendRequests() {
      var byId = {};
      Object.keys(friendReqFrom).forEach(function (id) { byId[id] = friendReqFrom[id]; });
      Object.keys(friendReqTo).forEach(function (id) { byId[id] = friendReqTo[id]; });
      STATE.friendRequests = Object.keys(byId).map(function (id) { return byId[id]; });
      renderRoot();
    }
    if (currentUserProfile && currentUserProfile.name) {
      unsubscribers.push(db.collection('friendRequests').where('from', '==', currentUserProfile.name).onSnapshot(function (snap) {
        friendReqFrom = {};
        snap.forEach(function (d) { friendReqFrom[d.id] = Object.assign({ id: d.id }, d.data()); });
        maybeNotifyFriendDecline(friendReqFrom);
        mergeFriendRequests();
      }, handleSyncError));
      unsubscribers.push(db.collection('friendRequests').where('to', '==', currentUserProfile.name).onSnapshot(function (snap) {
        friendReqTo = {};
        snap.forEach(function (d) { friendReqTo[d.id] = Object.assign({ id: d.id }, d.data()); });
        mergeFriendRequests();
      }, handleSyncError));
      // Coaching -- same two-query-merged shape as friendRequests above,
      // for the same reason (Firestore can't OR across from/to).
      var coachReqFrom = {}, coachReqTo = {};
      function mergeCoachRequests() {
        var byId = {};
        Object.keys(coachReqFrom).forEach(function (id) { byId[id] = coachReqFrom[id]; });
        Object.keys(coachReqTo).forEach(function (id) { byId[id] = coachReqTo[id]; });
        STATE.coachRequests = Object.keys(byId).map(function (id) { return byId[id]; });
        refreshCoachMessagesSync();
        renderRoot();
      }
      unsubscribers.push(db.collection('coachRequests').where('from', '==', currentUserProfile.name).onSnapshot(function (snap) {
        coachReqFrom = {};
        snap.forEach(function (d) { coachReqFrom[d.id] = Object.assign({ id: d.id }, d.data()); });
        mergeCoachRequests();
      }, handleSyncError));
      unsubscribers.push(db.collection('coachRequests').where('to', '==', currentUserProfile.name).onSnapshot(function (snap) {
        coachReqTo = {};
        snap.forEach(function (d) { coachReqTo[d.id] = Object.assign({ id: d.id }, d.data()); });
        mergeCoachRequests();
      }, handleSyncError));
    }
    // Social feed -- most recent first, capped since it's a scrolling
    // activity log, not something that needs full history loaded.
    unsubscribers.push(db.collection('feedEvents').orderBy('createdAt', 'desc').limit(40).onSnapshot(function (snap) {
      STATE.feedEvents = snap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
      markCoreSynced('feedEvents');
      renderRoot();
    }, handleSyncError));
    // Wall posts -- same cap-and-sync-all approach as the feed above;
    // visibleWallPosts() then filters to what this account's own
    // friends/follows relationships actually allow it to see.
    unsubscribers.push(db.collection('wallPosts').orderBy('createdAt', 'desc').limit(200).onSnapshot(function (snap) {
      STATE.wallPosts = snap.docs.map(function (d) { return d.data(); });
      maybeNotifyWallPostReaction(STATE.wallPosts);
      markCoreSynced('wallPosts');
      renderRoot();
    }, handleSyncError));
    // Who this pilote follows (Personnalités and Teams) -- one-way, no
    // acceptance. Split by followeeType into two derived arrays so
    // existing user-follow code (myFollows) doesn't need to change.
    // Team follows also carry a tier ('follower', the default, or
    // 'adherent' -- a paid club member, promoted by that Team's leader,
    // see requestTeamAdherent/setTeamMemberStatus) captured into myFollowedTeamTiers so
    // rendering the Mur can tell which "adherents only" club posts this
    // account is entitled to see.
    if (currentUserProfile && currentUserProfile.name) {
      unsubscribers.push(db.collection('follows').where('follower', '==', currentUserProfile.name).onSnapshot(function (snap) {
        var docs = snap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
        STATE.myFollows = docs.filter(function (f) { return (f.followeeType || 'user') === 'user'; }).map(function (f) { return f.followee; });
        var teamFollows = docs.filter(function (f) { return f.followeeType === 'team'; });
        STATE.myFollowedTeams = teamFollows.map(function (f) { return f.followee; });
        maybeNotifyAdherentDecision(teamFollows);
        var tiers = {}, byTeam = {};
        teamFollows.forEach(function (f) {
          tiers[f.followee] = f.tier === 'adherent' ? 'adherent' : 'follower';
          byTeam[f.followee] = f;
        });
        STATE.myFollowedTeamTiers = tiers;
        // My own follows/{id} doc per team I follow, keyed by teamId --
        // requestTeamAdherent needs the doc id (create vs update) and
        // adherentRequested to know whether it's already pending.
        STATE.myTeamFollowDocs = byTeam;
        refreshFollowedTeamFeedSync();
        refreshTeamDetailSync();
        renderRoot();
      }, handleSyncError));
    }
    // Teams: cheap to sync in full (id/name/createdBy only, no member
    // list on the doc itself -- see teamMembers). Membership/rosters and
    // the feed are then scoped to just the team(s) this account is
    // actually in (refreshTeamDetailSync, re-subscribed whenever that set
    // changes) rather than syncing every team's roster for everyone.
    unsubscribers.push(db.collection('teams').onSnapshot(function (snap) {
      STATE.teams = snap.docs.map(function (d) { return d.data(); });
      renderRoot();
    }, handleSyncError));
    // Every Team Leader in the app, not just this account's own Teams --
    // cheap to sync in full like teams/teamLikes above (one small doc per
    // leadership, not per member), needed so isProTeamLeaderName() can
    // recognize a Team PRO's Team Leader anywhere their pseudo shows up,
    // even in a Team this account isn't itself a part of.
    unsubscribers.push(db.collection('teamMembers').where('role', '==', 'leader').onSnapshot(function (snap) {
      STATE.allTeamLeaders = snap.docs.map(function (d) { return d.data(); });
      renderRoot();
    }, handleSyncError));
    // Retours d'expérience (Profil -> Suggestion) -- read is admin-only
    // per firestore.rules, so this listener is only ever attached for the
    // admin account to avoid a permission-denied on every other account.
    if (isAdmin()) {
      unsubscribers.push(db.collection('feedback').orderBy('createdAt', 'desc').onSnapshot(function (snap) {
        STATE.feedback = snap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
        renderRoot();
      }, handleSyncError));
    }
    // Likes: cheap to sync in full, like teams itself -- a flat {teamId,
    // name} row per like, small enough at this app's scale that a plain
    // count/lookup client-side beats scoping it like teamMembers is.
    unsubscribers.push(db.collection('teamLikes').onSnapshot(function (snap) {
      STATE.teamLikes = snap.docs.map(function (d) { return d.data(); });
      renderRoot();
    }, handleSyncError));
    if (currentUserProfile && currentUserProfile.name) {
      // My own outgoing join requests (see renderTeamDiscovery) -- the
      // matching incoming side, for teams this account leads, is synced
      // separately in refreshTeamDetailSync (scoped to teams it's
      // actually in, same as teamFollowersByTeam).
      unsubscribers.push(db.collection('teamJoinRequests').where('from', '==', currentUserProfile.name).onSnapshot(function (snap) {
        var docs = snap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
        maybeNotifyJoinRequestDecision(docs);
        myTeamJoinRequestsOut = docs;
        mergeTeamJoinRequests();
      }, handleSyncError));
      // Same shape as teamJoinRequests -- my own outgoing "demander à
      // participer" requests for a 'public' Team PRO event (see
      // renderProEventDiscovery); the incoming side, for events owned by
      // a team this account leads, is synced in refreshTeamDetailSync.
      unsubscribers.push(db.collection('eventJoinRequests').where('from', '==', currentUserProfile.name).onSnapshot(function (snap) {
        myEventJoinRequestsOut = snap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
        mergeEventJoinRequests();
      }, handleSyncError));
      refreshMyTeamMembershipsSync();
      var teamInviteFrom = {}, teamInviteTo = {};
      function mergeTeamInvites() {
        var byId = {};
        Object.keys(teamInviteFrom).forEach(function (id) { byId[id] = teamInviteFrom[id]; });
        Object.keys(teamInviteTo).forEach(function (id) { byId[id] = teamInviteTo[id]; });
        STATE.teamInvites = Object.keys(byId).map(function (id) { return byId[id]; });
        renderRoot();
      }
      unsubscribers.push(db.collection('teamInvites').where('from', '==', currentUserProfile.name).onSnapshot(function (snap) {
        teamInviteFrom = {};
        snap.forEach(function (d) { teamInviteFrom[d.id] = Object.assign({ id: d.id }, d.data()); });
        mergeTeamInvites();
      }, handleSyncError));
      unsubscribers.push(db.collection('teamInvites').where('to', '==', currentUserProfile.name).onSnapshot(function (snap) {
        teamInviteTo = {};
        snap.forEach(function (d) { teamInviteTo[d.id] = Object.assign({ id: d.id }, d.data()); });
        maybeNotifyNewTeamInvites(teamInviteTo);
        mergeTeamInvites();
      }, handleSyncError));
    }
  }

  // Split the same way teamInvites' from/to halves are (see mergeTeamInvites
  // above) -- my own outgoing join requests (synced in startSync) plus the
  // incoming ones for every team I lead (synced in refreshTeamDetailSync
  // below), merged into one STATE.teamJoinRequests list.
  var myTeamJoinRequestsOut = [], teamJoinRequestsIn = [];
  function mergeTeamJoinRequests() {
    var byId = {};
    myTeamJoinRequestsOut.forEach(function (r) { byId[r.id] = r; });
    teamJoinRequestsIn.forEach(function (r) { byId[r.id] = r; });
    STATE.teamJoinRequests = Object.keys(byId).map(function (id) { return byId[id]; });
    renderRoot();
  }
  var myEventJoinRequestsOut = [], eventJoinRequestsIn = [];
  function mergeEventJoinRequests() {
    var byId = {};
    myEventJoinRequestsOut.forEach(function (r) { byId[r.id] = r; });
    eventJoinRequestsIn.forEach(function (r) { byId[r.id] = r; });
    STATE.eventJoinRequests = Object.keys(byId).map(function (id) { return byId[id]; });
    renderRoot();
  }

  // Re-subscribed (not just a one-time listener) so a display-name change
  // re-points the query at the new name -- it used to be bound once in
  // startSync() with whatever currentUserProfile.name was at that moment,
  // which meant it kept matching the OLD name for the rest of the
  // session even after a rename migrated the underlying teamMembers docs
  // (see saveProfile), silently emptying "Mes Teams"/leader rights out
  // from under the renamed account.
  var myTeamMembershipsUnsub = null;
  function refreshMyTeamMembershipsSync() {
    if (myTeamMembershipsUnsub) { myTeamMembershipsUnsub(); myTeamMembershipsUnsub = null; }
    if (!currentUserProfile) return;
    myTeamMembershipsUnsub = db.collection('teamMembers').where('name', '==', currentUserProfile.name).onSnapshot(function (snap) {
      STATE.myTeamMemberships = snap.docs.map(function (d) { return d.data(); });
      // Opportunistic backfill: a membership doc created before uid was
      // tracked has none yet -- add it now, while the name still matches
      // (see firestore.rules' teamMembers update, the
      // name==myName()-and-uid-only clause), so a *future* rename can
      // migrate this membership instead of silently losing it (see
      // saveProfile's own migration, which needs uid to prove ownership
      // of the pre-rename doc).
      var myUid = auth.currentUser && auth.currentUser.uid;
      snap.docs.forEach(function (d) {
        var data = d.data();
        if (myUid && !data.uid) {
          d.ref.update({ uid: myUid }).catch(function () {});
        }
      });
      refreshTeamDetailSync();
      renderRoot();
    }, handleSyncError);
  }

  // Re-subscribed (not just once) whenever STATE.myTeamMemberships changes
  // -- e.g. joining a new team -- so its roster and feed start syncing
  // without needing a full page reload. Firestore's 'in' operator caps at
  // 10 values, plenty for a hobby app's worth of teams per person.
  var teamDetailUnsubs = [];
  // Independent of CORE_SYNC_KEYS/coreDataLoading() -- teamFeed only ever
  // starts syncing once myTeamMemberships has resolved to a non-empty
  // teamIds list, which an account with zero teams never reaches, so
  // folding it into that single shared pending-set would leave every
  // *other* tab's spinner stuck on "Chargement..." forever for such an
  // account. This flag instead just tracks this one feed's own state,
  // and is set true either way (real first snapshot, or "no team at all
  // to sync") so its own empty-state (see renderTeamDetail) can tell
  // "still loading" from "genuinely nothing yet".
  var teamFeedSynced = false;
  function refreshTeamDetailSync() {
    teamDetailUnsubs.forEach(function (unsub) { unsub(); });
    teamDetailUnsubs = [];
    // Union of teams this account is a member of AND teams it merely
    // follows -- a plain follower (Geoff on Mototeam95, say) still needs
    // this data synced to see the Team's fiche (renderTeamCard) at all,
    // just with fewer rights inside it (see canPost/isMember there).
    var teamIds = (STATE.myTeamMemberships || []).map(function (m) { return m.teamId; })
      .concat(STATE.myFollowedTeams || [])
      .filter(function (id, i, arr) { return arr.indexOf(id) === i; })
      .slice(0, 10);
    if (!teamIds.length) {
      STATE.teamMembersByTeam = {};
      STATE.teamFeed = [];
      STATE.teamFollowersByTeam = {};
      teamJoinRequestsIn = [];
      mergeTeamJoinRequests();
      eventJoinRequestsIn = [];
      mergeEventJoinRequests();
      STATE.eventAnnouncements = [];
      teamFeedSynced = true;
      return;
    }
    teamDetailUnsubs.push(db.collection('teamMembers').where('teamId', 'in', teamIds).onSnapshot(function (snap) {
      var byTeam = {};
      snap.forEach(function (d) {
        var m = d.data();
        byTeam[m.teamId] = byTeam[m.teamId] || [];
        byTeam[m.teamId].push(m);
      });
      STATE.teamMembersByTeam = byTeam;
      renderRoot();
    }, handleSyncError));
    // Sorted client-side rather than orderBy('createdAt') server-side --
    // combined with where('teamId','in',...) that would need a composite
    // index configured in the Firebase console before it'd work at all.
    // "Seen" is persisted (notifyOnNewIds), not just this subscription's
    // own memory -- switching teams/reloading the page never re-notifies
    // for a post already seen.
    teamDetailUnsubs.push(db.collection('teamFeed').where('teamId', 'in', teamIds).limit(200).onSnapshot(function (snap) {
      var posts = snap.docs.map(function (d) { return d.data(); })
        .sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); })
        .slice(0, 50);
      notifyOnNewIds('team-feed', posts, function (f) { return f.id; }, function (f) {
        if (currentUserProfile && f.author === currentUserProfile.name) return;
        if (notifCategoryAllowed('notifyTeamNews')) {
          var t = teamById(f.teamId);
          var body = f.text || f.question || (f.linkUrl ? 'Nouveau lien partagé' : (f.photoURL ? 'Nouvelle photo partagée' : 'Nouvelle publication'));
          new Notification('Carnet de Piste', { body: 'Actu' + (t ? ' de ' + t.name : ' de ton Team') + ' : ' + body.slice(0, 100) });
        }
      });
      maybeNotifyTeamFeedReaction(posts);
      STATE.teamFeed = posts;
      teamFeedSynced = true;
      renderRoot();
    }, handleSyncError));
    // Followers (and adherents -- see requestTeamAdherent/setTeamMemberStatus) of every team
    // this account is in, so a Team Leader can manage its Adhérents list
    // (renderTeamMembersManagement) -- cheap to scope by the same teamIds
    // as the two listeners above, no separate "leader-only" query needed
    // since firestore.rules already keeps the actual promote/demote action
    // leader-gated.
    teamDetailUnsubs.push(db.collection('follows').where('followeeType', '==', 'team').where('followee', 'in', teamIds).onSnapshot(function (snap) {
      var byTeam = {};
      snap.forEach(function (d) {
        var f = Object.assign({ id: d.id }, d.data());
        byTeam[f.followee] = byTeam[f.followee] || [];
        byTeam[f.followee].push(f);
      });
      STATE.teamFollowersByTeam = byTeam;
      // A pending "devenir adhérent" request now also surfaces in the 🔔
      // badge (see pendingAdherentRequests), but that's passive -- nothing
      // alerted the leader it had arrived, unlike every other request type
      // here (teamInvites, teamFeed...). Same notifyOnNewIds pattern:
      // skipped entirely on first-ever sync so old/backlog requests never
      // fire, only a request that shows up after that baseline.
      var myAdherentReqs = [];
      Object.keys(byTeam).forEach(function (teamId) {
        if (!isLeaderOfTeam(teamId)) return;
        byTeam[teamId].forEach(function (f) {
          if (f.adherentRequested && f.tier !== 'adherent') myAdherentReqs.push(f);
        });
      });
      notifyOnNewIds('team-adherent-requests', myAdherentReqs, function (f) { return f.id; }, function (f) {
        if (!notifCategoryAllowed('notifyAdherentRequests')) return;
        var t = teamById(f.followee);
        new Notification('Carnet de Piste', { body: f.follower + ' souhaite devenir adhérent' + (t ? ' de ' + t.name : '') + '.' });
      });
      renderRoot();
    }, handleSyncError));
    // Incoming join requests (see teamJoinRequests above) for every team
    // this account is in -- only the leader-facing UI actually reads
    // these (renderTeamJoinRequestsSection), but scoping the query to
    // "my" teams is what keeps it cheap regardless.
    teamDetailUnsubs.push(db.collection('teamJoinRequests').where('teamId', 'in', teamIds).onSnapshot(function (snap) {
      teamJoinRequestsIn = snap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
      mergeTeamJoinRequests();
    }, handleSyncError));
    // Same for eventJoinRequests -- every pending "demander à participer"
    // for a Team Event owned by one of this account's teams.
    teamDetailUnsubs.push(db.collection('eventJoinRequests').where('teamId', 'in', teamIds).onSnapshot(function (snap) {
      eventJoinRequestsIn = snap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
      mergeEventJoinRequests();
    }, handleSyncError));
    // Team Leader broadcasts to an event's pilotes ("BRIEFING DEMAIN A
    // 8H15"...) -- same notifyOnNewIds pattern as teamFeed above, scoped
    // to this account's own teams the same way.
    teamDetailUnsubs.push(db.collection('eventAnnouncements').where('teamId', 'in', teamIds).limit(200).onSnapshot(function (snap) {
      var posts = snap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); })
        .sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
      notifyOnNewIds('event-announcements', posts, function (a) { return a.id; }, function (a) {
        if (currentUserProfile && a.from === currentUserProfile.name) return;
        if (notifCategoryAllowed('notifyEventAnnouncements')) {
          var ev = (STATE.events || []).filter(function (e) { return e.id === a.eventId; })[0];
          new Notification('Carnet de Piste', { body: (ev ? ev.circuit + ' — ' : '') + (a.text || '').slice(0, 150) });
        }
      });
      STATE.eventAnnouncements = posts;
      renderRoot();
    }, handleSyncError));
  }

  // Re-subscribed whenever STATE.myFollowedTeams changes (see the follows
  // listener above) -- the feed of every Team PRO ("club", see
  // renderTeamMembersManagement) this account follows but isn't a member
  // of, so the Mur (renderWallFeed) can fold in their public news
  // alongside "adherents only" posts this account is actually entitled to
  // (checked against myFollowedTeamTiers at render time, not here --
  // teamFeed reads are open to any signed-in account, same display-layer-
  // only audience pattern as wallPosts).
  var followedTeamFeedUnsubs = [];
  function refreshFollowedTeamFeedSync() {
    followedTeamFeedUnsubs.forEach(function (unsub) { unsub(); });
    followedTeamFeedUnsubs = [];
    var teamIds = (STATE.myFollowedTeams || []).slice(0, 10);
    if (!teamIds.length) {
      STATE.followedTeamFeed = [];
      return;
    }
    followedTeamFeedUnsubs.push(db.collection('teamFeed').where('teamId', 'in', teamIds).limit(200).onSnapshot(function (snap) {
      STATE.followedTeamFeed = snap.docs.map(function (d) { return d.data(); })
        .sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); })
        .slice(0, 50);
      renderRoot();
    }, handleSyncError));
  }

  // Re-subscribed whenever STATE.coachRequests changes (see
  // mergeCoachRequests above) -- every message across every accepted
  // coaching relationship this account is a party to, whichever side
  // (see renderCoachMessageThread). Same persisted notifyOnNewIds as the
  // other streams above: a relationship's own history shouldn't flood
  // notifications the moment it's (re)synced, and a message already
  // notified once shouldn't fire again on a page reload either.
  var coachMessagesUnsubs = [];
  function refreshCoachMessagesSync() {
    coachMessagesUnsubs.forEach(function (unsub) { unsub(); });
    coachMessagesUnsubs = [];
    var requestIds = (STATE.coachRequests || []).filter(function (r) { return r.status === 'accepted'; }).map(function (r) { return r.id; }).slice(0, 10);
    if (!requestIds.length) {
      STATE.coachMessages = [];
      return;
    }
    coachMessagesUnsubs.push(db.collection('coachMessages').where('requestId', 'in', requestIds).onSnapshot(function (snap) {
      var messages = snap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
      notifyOnNewIds('coach-messages', messages, function (m) { return m.id; }, function (m) {
        if (currentUserProfile && m.from === currentUserProfile.name) return;
        if (notifCategoryAllowed('notifyCoachMessages')) {
          new Notification('Carnet de Piste', { body: 'Message de ' + m.from + ' (coaching) : ' + (m.text || '').slice(0, 100) });
        }
      });
      STATE.coachMessages = messages.sort(function (a, b) { return (a.createdAt || 0) - (b.createdAt || 0); });
      renderRoot();
    }, handleSyncError));
  }

  function stopSync() {
    coreSyncPending = null;
    unsubscribers.forEach(function (unsub) { unsub(); });
    unsubscribers = [];
    if (myTeamMembershipsUnsub) { myTeamMembershipsUnsub(); myTeamMembershipsUnsub = null; }
    teamDetailUnsubs.forEach(function (unsub) { unsub(); });
    teamDetailUnsubs = [];
    teamFeedSynced = false;
    followedTeamFeedUnsubs.forEach(function (unsub) { unsub(); });
    followedTeamFeedUnsubs = [];
    coachMessagesUnsubs.forEach(function (unsub) { unsub(); });
    coachMessagesUnsubs = [];
    myTeamJoinRequestsOut = [];
    teamJoinRequestsIn = [];
    myEventJoinRequestsOut = [];
    eventJoinRequestsIn = [];
  }

  function handleSyncError() {
    canPersist = false;
    updateBanner();
    showToast('Connexion à la base de données perdue — vérifie ta connexion et recharge la page.');
  }

  // Diffs prevState against the current STATE (already mutated in place by
  // the caller, the same pattern every mutation in this app already
  // follows) and writes only the documents that actually changed --
  // Firestore's own compare-and-set per document, not one big blob.
  function diffArrayCollection(batch, coll, prevArr, nextArr) {
    var prevById = {}, nextById = {}, n = 0;
    (prevArr || []).forEach(function (item) { prevById[item.id] = item; });
    (nextArr || []).forEach(function (item) { nextById[item.id] = item; });
    Object.keys(nextById).forEach(function (id) {
      if (JSON.stringify(nextById[id]) !== JSON.stringify(prevById[id])) {
        batch.set(db.collection(coll).doc(id), nextById[id]);
        n++;
      }
    });
    Object.keys(prevById).forEach(function (id) {
      if (!nextById[id]) { batch.delete(db.collection(coll).doc(id)); n++; }
    });
    return n;
  }

  function diffCircuits(batch, prevMap, nextMap) {
    var n = 0;
    Object.keys(nextMap || {}).forEach(function (name) {
      var prevEntry = (prevMap || {})[name];
      var nextEntry = nextMap[name];
      if (JSON.stringify(nextEntry) !== JSON.stringify(prevEntry)) {
        var doc = Object.assign({}, nextEntry, { name: name });
        batch.set(db.collection('circuits').doc(safeDocId(name)), doc);
        n++;
      }
    });
    Object.keys(prevMap || {}).forEach(function (name) {
      if (!nextMap || !nextMap[name]) { batch.delete(db.collection('circuits').doc(safeDocId(name))); n++; }
    });
    return n;
  }

  function diffRiders(batch, prevArr, nextArr) {
    var n = 0;
    var prevSet = {}, nextSet = {};
    (prevArr || []).forEach(function (r) { prevSet[r] = true; });
    (nextArr || []).forEach(function (r) { nextSet[r] = true; });
    (nextArr || []).forEach(function (r) {
      if (!prevSet[r]) { batch.set(db.collection('riders').doc(safeDocId(r)), { name: r }); n++; }
    });
    (prevArr || []).forEach(function (r) {
      if (!nextSet[r]) { batch.delete(db.collection('riders').doc(safeDocId(r))); n++; }
    });
    return n;
  }

  // A single document (not a collection) -- STATE.checklistTemplate starts
  // null (DEFAULT_CHECKLIST_TEMPLATE is used until someone edits it), so
  // this only writes once the first edit actually happens.
  function diffChecklistTemplate(batch, prevTemplate, nextTemplate) {
    if (JSON.stringify(prevTemplate || null) === JSON.stringify(nextTemplate || null)) return 0;
    if (nextTemplate) batch.set(db.collection('settings').doc('checklist'), nextTemplate);
    else batch.delete(db.collection('settings').doc('checklist'));
    return 1;
  }

  function persist(prevState) {
    if (!canPersist) { updateBanner(); return; }
    var batch = db.batch();
    var ops = 0;
    ops += diffArrayCollection(batch, 'sessions', prevState.sessions, STATE.sessions);
    ops += diffArrayCollection(batch, 'events', prevState.events, STATE.events);
    ops += diffCircuits(batch, prevState.circuits, STATE.circuits);
    ops += diffRiders(batch, prevState.riders, STATE.riders);
    ops += diffChecklistTemplate(batch, prevState.checklistTemplate, STATE.checklistTemplate);
    if (!ops) return;
    batch.commit().catch(function (err) {
      STATE = prevState;
      renderRoot();
      if (err && err.code === 'permission-denied') {
        canPersist = false;
        updateBanner();
      } else {
        showToast('La sauvegarde a échoué — réessayez.');
      }
    });
  }

  function init() {
    renderRoot();
    setInterval(updateLiveClock, 15000);
    document.addEventListener('pointerdown', onCalendarPointerDown);
    document.addEventListener('pointermove', onCalendarPointerMove);
    document.addEventListener('pointerup', onCalendarPointerUp);
    document.addEventListener('pointercancel', onCalendarPointerUp);
    document.addEventListener('wheel', onCalendarWheel, { passive: false });
    document.addEventListener('keydown', onCalendarKeydown);
    // Real accounts (Pilote/Accompagnant), not anonymous sign-in: only
    // onSignupSubmit's own success handler moves authState to 'signed-in'
    // for a brand-new account (see its comment) -- here, a missing profile
    // doc just means that write hasn't landed yet, so it's a no-op rather
    // than an error.
    auth.onAuthStateChanged(function (user) {
      // The anonymous sign-in used only to resolve a pseudo to its email
      // before the real login (see resolveLoginIdentifier) also fires this
      // -- ignore it entirely, the real signInWithEmailAndPassword that
      // follows fires it again with the actual account moments later.
      if (user && user.isAnonymous) return;
      if (!user) {
        stopSync();
        authState = 'signed-out';
        currentUserProfile = null;
        canPersist = false;
        autoVerifyEmailSent = false;
        renderRoot();
        return;
      }
      if (!user.emailVerified) {
        // Covers both a fresh signup (handled directly in
        // onSignupSubmit, but this also fires) and someone logging back
        // into an old, never-verified account -- either way, held here
        // until they confirm. An account created before this screen
        // existed never got a first verification email at all, so send
        // one automatically the first time we land here this session
        // (guarded so a re-fired onAuthStateChanged doesn't spam it, and
        // skipped if onSignupSubmit already just sent one itself).
        if (!autoVerifyEmailSent) {
          autoVerifyEmailSent = true;
          user.sendEmailVerification().catch(function () {});
        }
        authState = 'verify-email';
        renderRoot();
        return;
      }
      db.collection('users').doc(user.uid).get().then(function (doc) {
        if (doc.exists) {
          currentUserProfile = doc.data();
          authState = 'signed-in';
          canPersist = true;
          if (justAuthenticated) {
            activeView = 'planning';
            profilePanelOpen = false;
            justAuthenticated = false;
          }
          // Auto-opens once, ever, per account -- tutorialSeen is set on
          // the profile doc itself (see closeTutorial), not per-device,
          // so it stays "seen" across every browser/phone that account
          // ever signs into. Always still reachable afterward via Aide
          // in Profil -> Réglages.
          if (!currentUserProfile.tutorialSeen) {
            tutorialOpen = true;
            tutorialStep = 0;
          }
          circuitDefaultApplied = false;
          startSync();
          renderRoot();
          selfHealStaleNames(user.uid, currentUserProfile.name);
        } else {
          // The admin removed this account (see renderAccountManagerPanel) --
          // sign them out cleanly instead of leaving the app stuck on
          // "Connexion..." forever.
          authState = 'signed-out';
          auth.signOut();
        }
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
