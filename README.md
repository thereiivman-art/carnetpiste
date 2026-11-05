# Pitbook (Pitbook)

Carnet de roulage pour la moto sur circuit. Le pilote y note ses chronos et ses repères, prépare ses journées et suit ses amis. C'est une application web installable (PWA), sans serveur à nous : tout tourne dans le navigateur et les données sont dans Firebase (Firestore + Auth, offre gratuite).

En ligne : https://thereiivman-art.github.io/carnetpiste/

## Lire le code en 5 minutes

| Fichier | Rôle |
|---|---|
| `index.html` | Page unique. Charge Firebase, `theme-boot.js`, `style.css`, `app.js`. Le numéro `?v=` sert à vider le cache à chaque version. |
| `app.js` | Toute l'application (JavaScript sans framework, dans une seule fonction auto-appelée). |
| `style.css` | Tous les styles. Charte : fond `#f4f3ef`, encre `#14161a`, rouge `#c8261f`, polices Barlow / Barlow Condensed. Mode sombre par variables CSS. |
| `sw.js`, `sw-register.js` | Service worker : hors ligne et mise à jour. Même numéro de version que `index.html`. |
| `theme-boot.js` | Applique clair / sombre avant l'affichage, pour éviter le flash blanc. |
| `firebase-config.js` | Configuration publique du projet Firebase (pas de secret : la sécurité vient des règles). |
| `firestore.rules` | Règles de sécurité Firestore : qui lit et écrit quoi. **À republier dans la console Firebase à chaque modification.** |
| `chrono-import.js` | Lecture des feuilles de temps collées en texte (gratuit, sans IA payante). |
| `circuit-outlines/` | Tracés des circuits (PNG noir sur blanc, inversés en mode sombre). |
| `guides/` | Guides d'utilisation. |
| `manifest.json`, `icons/` | Installation sur l'écran d'accueil. |
| `_banc-de-test/` | Banc de test hors ligne (faux Firebase + scénarios Playwright). Non publié. Voir `_banc-de-test/LISEZMOI.txt`. |

### Comment `app.js` fonctionne

1. **État** : tout ce qui vient de Firestore arrive dans l'objet `STATE` (abonnements temps réel ouverts dans `startSync`).
2. **Rendu** : `renderRoot()` reconstruit tout le contenu de `#root` en HTML (chaînes de caractères), puis `attachHandlers()` branche les clics. Un gestionnaire délégué sur `#root` couvre les actions les plus courantes (`data-action="…"`).
3. **Navigation** : `activeView` (onglet), `pillState` (sous-onglets), `navStack` + historique du navigateur pour le bouton retour.
4. **Textes** : français par défaut ; `L('fr', 'en')` pour un texte court, `tr('clé')` pour le dictionnaire.
5. **Fenêtres** : `openMiniSheet(html)` ouvre une feuille en bas d'écran (croix de fermeture ajoutée automatiquement).

Chaque partie de `app.js` commence par un titre `// ---- Nom ----`. La table ci-dessous donne la ligne de départ et les principales fonctions (les numéros bougent au fil des versions : chercher le titre).

### Carte de `app.js`

| Partie | Ligne | Fonctions principales |
|---|---|---|
| i18n (FR default, EN optional per-account, see Mon profil) | 41 | `deviceLangCode`, `currentLang`, `countVisitorLang`, `tr` |
| Anglais : traduction des textes écrits en dur en français | 884 | `enText`, `enTextRaw`, `carWord`, `carWordsTree`, `carWordsText`, `translateTreeToEnglish`, `translateTextNode`, `markCoreSynced` … |
| Social / amis | 1679 | `rawFollowingOf`, `rawFollowersOf`, `friendsOf`, `incomingFriendRequests`, `outgoingFriendRequests`, `migrateFriendsToFollows`, `allKnownUserNames`, `sendFriendRequest` … |
| Coaching | 1851 | `sendCoachRequest`, `acceptCoachRequest`, `acceptCoachRequestSlot`, `removeCoachRequest`, `saveCoachPlan`, `proposeCoachSlot`, `sendCoachMessage`, `saveCoachAvailability` … |
| Teams | 2009 | `teamMemberDocId`, `teamInviteDocId`, `myUid`, `uidOf`, `myRoleInTeam`, `isLeaderOfTeam`, `membersOfTeam`, `teamById` … |
| Mots de passe temporaires (admin, temporaire) | 2490 | `pwLog`, `renderPasswordResetSection`, `runPasswordReset` |
| Import de roulages en lot (admin) | 2554 | `applyEventImportPreset`, `canonicalCircuitName`, `parseEventImport`, `renderEventImportCard`, `readEventImportForm`, `createImportTeam`, `evimpCountText`, `runEventImport` … |
| Recadrage de photo (badge rond / logo large) | 2819 | `cropViewportSize`, `openTutorial`, `closeTutorial`, `tutorialGo`, `renderTutorialOverlay` |
| Ressenti à chaud (opt-in, voir Réglages) | 2908 | `openFeelingModal`, `closeFeelingModal`, `saveSessionFeeling`, `renderPhotoLightbox`, `renderFeelingModal`, `openCropModal`, `closeCropModal`, `cropDisplaySize` … |
| Calendrier (sorties planifiées + sessions déjà roulées) | 3461 | `loadUiState`, `saveUiState`, `featureEnabled`, `saveFeatureVisibility`, `ensureAvantSessionChecklistCategory`, `checklistTemplate`, `checklistAllItems`, `cloneChecklistTemplate` … |
| Chrono estimé sur un circuit où le pilote n'a jamais roulé | 3945 | `isWetSession`, `trackTagHtml`, `bestsByRiderCircuit`, `quantile`, `circuitRefTime`, `estimateFromTable`, `estimateLapTime`, `joinAnd` … |
| Trophées à paliers | 4150 | `tierNames`, `numFr`, `tieredEntry`, `singleEntry`, `duelsWonCount`, `gazReceivedCount`, `cachedAchievements`, `keepAcquiredTrophies` … |
| Gestion des pilotes (ajout / renommage / suppression) | 4648 | `renderRiderManagerPanel` |
| Mon profil — chaque pilote/accompagnant gère son propre compte | 4687 | `profileTabList`, `accountNavHtml`, `renderProfileTabBar`, `avatarPresets`, `renderProfileAvatar`, `roleInfo`, `renderRoleInfoCard`, `renderProfileProfilTab` … |
| Mise à jour de l'appli | 5216 | `currentAppVersion`, `checkForAppUpdate`, `applyAppUpdate`, `showUpdateBanner`, `renderAccountBar`, `renderProfilePanel`, `renderTeamJoinRequestRow`, `renderEventJoinRequestRow` … |
| Activité (cloche + fil) | 5363 | `notifIconHtml`, `sessionCreatedAt`, `friendRides`, `ridesFor` |
| Ce qui rend une sortie remarquable (fil + notifications) | 5423 | `riderBestWhere`, `bestBefore`, `bestUpTo`, `formatMark`, `rideMilestone`, `rideDuel`, `duelText`, `friendPhotoLinks` … |
| Gestion des comptes (admin) | 5943 | `referrerCandidates`, `loadManageableAccounts`, `filteredManageableAccounts`, `renderAccountManagerPanel`, `renderTeamManagerPanel`, `migrateTeamMembershipsForRename`, `renameAllowedAt`, `groupARenameSpecs` … |
| Pages légales (RGPD, mentions légales, conditions) | 6566 | `legalTestPhaseHtml`, `legalSection`, `renderPrivacyPolicyHtml`, `renderLegalNoticeHtml`, `openLegal` |
| RGPD : effacement et export | 6657 | `queryMine`, `exportMyData`, `eraseMyData`, `deleteMyAccount`, `resolveUniquePseudo`, `addRider`, `renameRiderEverywhere`, `renameRider` … |
| Carte de partage (story 1080x1920) | 7666 | `sessionRecordInfo`, `loadImageEl`, `roundRect`, `fitText`, `shareFontsReady`, `drawShareMark`, `drawShareGroupChip`, `buildShareCard` … |
| Circuit info (km, virages, prochaine sortie) + visuel annotable | 7932 | `circuitInfo`, `eventHoraires`, `nextOutingForCircuit`, `circuitSessionsDesc`, `infoRow`, `renderRiderLink`, `nameLinkHtml`, `maybeFicheHtml` … |
| Mon carnet (accueil) | 8575 | `mySessions`, `myOutings` |
| QR code d'invitation (lien de parrainage) | 8613 | `loadQrLib`, `paddockQrLink`, `openPaddockQr`, `openInviteQr` |
| Podium des amis : my friends' and my best lap on a circuit, all time | 8740 | `friendsPodium`, `podiumClimb`, `podiumClimbText`, `podiumPlace`, `podiumScopeNow`, `globalPodiumRows`, `renderGlobalPodiums`, `renderStatsPodiums` … |
| Page d'une sortie (ouverte depuis une carte de sortie) | 8894 | `openOuting`, `openEventPage`, `styledPlanAttr`, `styledPlanSrc`, `styleTrackPlans`, `styleTrackThumbs`, `autotrimImages`, `groupChip` |
| Entre amis : classement du jour avec mes amis | 9016 | `battleDates`, `circuitKey`, `circuitKeyRaw`, `sameCircuit`, `friendsBattleRows`, `renderFriendsBattle`, `styledTrack`, `battleTrackSrc` … |
| Story « Podium des amis » | 9216 | `buildPodiumStoryCard`, `sharePodium`, `shareBattle` |
| Mes réglages par session | 9322 | `sessionsForMyDiscipline`, `setMyDiscipline`, `mergeSessionNotes`, `sessionPrivatePart`, `setSessionPrivate`, `migratePublicSessionNotes`, `setupFields`, `ensureSetupsLoaded` … |
| Mes pneus : sessions et km sur le train en place | 9553 | `setupFieldName`, `currentTyreSet`, `tyreSetSessions`, `sessionMinutes`, `sessionLapCount`, `tyreSlotKey`, `tyreScheduleDays`, `tyreSetUsage` … |
| Mes pressions (Stats › Pneus) | 9726 | `pressureText`, `allPressureEntries`, `renderPressuresCard`, `savePressures`, `openPressureSheet`, `tyreSetAt`, `renderOutingDayBike`, `renderCompanionShowcase` … |
| Mon budget : ce que coûtent les roulages | 10064 | `budgetCosts`, `emptyBudgetPerso`, `budgetCostLabel`, `currencySymbol`, `formatEuros`, `parseEuroNumber`, `eventPriceInfo`, `eventDayCount` … |
| Ma journée : session par session | 10526 | `compareSessionsInDay`, `setupChanges`, `renderDayProgression` |
| Ajouter le roulage à l'agenda du téléphone (.ics) | 10581 | `icsDate`, `icsDateTime`, `icsEscape`, `buildEventIcs`, `addToCalendarLink`, `addEventToCalendar`, `renderOutingPage` |
| Rappel « importe ta feuille de temps » | 10864 | `pendingTimesheetReminder`, `renderTimesheetReminder` |
| Mode jour J | 10908 | `todaysOutingForMe`, `myDaySlots`, `riderDaySlots`, `fmtCountdown`, `openJourJ`, `closeJourJ`, `dismissJourJForToday`, `maybeAutoOpenJourJ` |
| Onglet Chrono : le jour du roulage, en très simple | 11065 | `renderChronoTab`, `renderChronoProgress`, `renderChronoNoRide`, `goAddChronoFor`, `myDebriefs`, `openDebrief` |
| Import des horaires depuis une photo / un PDF | 11215 | `canEditEventHoraires`, `renderHorairesImportButton`, `openHorairesImport` |
| Sortie en 10 secondes | 11289 | `quickOutingFormHtml`, `bindQuickOutingForms`, `saveQuickOuting`, `openQuickOutingModal`, `circuitThumbHtml`, `myUpcomingEvents`, `enteredAtText`, `sessionVideoHtml` … |
| Passés : par circuit, puis par date ; album photo ; recherche | 11437 | `outingAlbum`, `eventAlbums`, `albumChipHtml`, `openEventChat`, `openAlbumsSheet`, `outingRowWithAlbum`, `outingMatches`, `renderPastByCircuit` … |
| Carnet d'un accompagnant : les roulages de ses potes pilotes | 11576 | `friendRiderNames`, `friendsOutings` |
| Mes potes en piste (accompagnant) | 11595 | `friendsOnTrack`, `fmtMinOfDay`, `renderFriendsOnTrack` |
| Saisir le chrono d'un pote (accompagnant) | 11636 | `openChronoProposalSheet`, `myPendingChronoProposals`, `acceptChronoProposal`, `refuseChronoProposal`, `renderCompanionCarnet`, `renderMoiTab`, `renderCarnetTab` |
| Mes repères (notes par virage, épinglées sur le plan) | 11815 | `myTrackNotes`, `saveMyTrackNotes`, `trackNoteSummary`, `mapModeSwitchHtml` |
| Spots photo d'un circuit (accompagnants) : placés par l'admin | 11857 | `isFavSpot`, `toggleFavSpot`, `openPhotoSpots` |
| Accident (chute, sortie de piste, contact, panne) | 11923 | `incidentLabel`, `openIncidentSheet`, `incidentImage`, `publishIncident` |
| Repères : image (plan + repères numérotés + liste), PDF, post / | 12000 | `trackNotesImage`, `downloadDataUrl`, `shareableNotes`, `openTrackNotesShare`, `copySharedNotes`, `openTrackNotes`, `renderTrackNotesReminder`, `saveCircuitInfo` |
| Écran d'annotation (calque façon Paint sur le tracé du circuit) | 12324 | `outlineImageFor`, `openCircuitCreate`, `viewLevelSessionId`, `isViewLevelId`, `parseViewLevelId`, `isOutlineLevelId`, `openAnnotation`, `closeDockedMaps` … |
| Story « Mon roulage à… » (après le roulage) | 13660 | `buildRecapStoryCard`, `shareRecapStory` |
| Story « On roule à… » (avant le roulage) | 13761 | `buildRoulageStoryCard`, `shareRoulageStory`, `exportEventRecapPng`, `exportAnnotationPng`, `showAnnotImagePreview`, `attachAnnotHandlers` |
| Calendrier : sorties planifiées + sessions déjà roulées, en vue année/mois/semaine | 14072 | `MONTH_NAMES_FR`, `WEEKDAY_LETTERS_FR`, `canSeeEvent`, `countdownUnits`, `countdownLabel`, `inDaysText`, `eventsList`, `isMyEventForList` … |
| Onglet Planning (horaires de la sortie en cours / à venir) | 16223 | `parseHoraireToken`, `parseHoraireLine`, `allEventSlots`, `coachAvailabilityFor`, `coachRequestSlotOptions`, `ridersInGroup`, `schedClock`, `renderHoraireGroups` … |
| Calendrier : pincer/molette pour zoomer, glisser/flèches pour naviguer | 17716 | `onCalendarPointerDown`, `onCalendarPointerMove`, `onCalendarPointerUp`, `onCalendarWheel`, `onCalendarKeydown` |
| Thème clair / sombre | 17803 | `getThemePref`, `applyTheme`, `setThemePref`, `renderThemeToggle`, `saveLang`, `renderLangToggle`, `roleLabel`, `isCertified` … |
| Compteurs d'usage (anonymes) | 17976 | `usageMonthKey`, `countUsage`, `countUsageOnce`, `countChronoMilestones`, `countActiveMonth`, `renderUsageStatsCard` |
| Nationalité | 18071 | `countryName`, `stripes`, `nordic`, `centreDot`, `countryBallHtml`, `flagEmoji`, `deviceCountryCode`, `nationalitySelectHtml` … |
| Fiche d'un pilote (page) | 18245 | `teamAvatarRaw`, `openPerson`, `pName`, `cName`, `tName`, `personLinkHtml` |
| Fiche personnalisée (aperçu de Pitbook+) | 18294 | `cosmeticOk`, `bubbleStyle`, `unlockChips`, `unlockSwatchesHtml`, `lookCovers`, `lookPlates`, `lookOf`, `lookInk` … |
| Fiche team personnalisée (aperçu de Team PRO) | 18457 | `teamLookFor`, `teamEvents`, `teamPalmares`, `renderTeamHero`, `renderTeamShowcase`, `openTeamLookEditor`, `lookShows`, `normalizeUrl` … |
| Saisons : one year at a time, visual, shareable | 18824 | `riderSeasonYears`, `riderSeason`, `seasonYearChips`, `seasonDateBox`, `renderRiderSeasons`, `teamSeasonYears`, `teamSeasonDays`, `teamEventBest` … |
| Recherche dans toute l'appli (façon Discord : Ctrl/Cmd + K) | 19336 | `gsearchBuild`, `gsearchFill`, `renderSearchInline`, `closeSearchInline`, `bindSearchInline`, `openGlobalSearch`, `openPlayerSheet`, `postLinkHtml` … |
| Réseau : abonnés, abonnements, suggestions | 19502 | `friendNamesOf`, `uniqNames`, `followersOf`, `followingOf`, `followedRidersOf`, `iFollow`, `plural`, `socialCountsHtml` … |
| Stories : le dernier roulage (7 jours) ou la dernière photo | 19656 | `storyItems`, `storyTimeLeft` |
| Stories vidéo (Pitbook+) : 10 s max, recompressées sur le | 19687 | `dataUrlToFile`, `shareElsewhere`, `postShareLink`, `copyText`, `openPostShareSheet` |
| Pneus : la monnaie de Pitbook | 19744 | `pneusState`, `pneusDayCalc`, `pneusProfilePoints`, `pneusTrophyPoints`, `pneusTotal`, `pneusBalance`, `pneusOwned`, `pneusBuyAttrs` … |
| Présence : en ligne (vert), actif il y a moins de 2 h (orange), | 20214 | `loginStreakTick`, `presenceBeat`, `presenceOf`, `presenceLabel`, `friendsPresenceBubbles` |
| Ajoute des amis : suggestions façon Instagram, repliables | 20254 | `friendSuggestions`, `renderFriendSuggestBar`, `renderStoriesRow`, `storyAsTeamHtml`, `openStoryComposer`, `likeOnDoubleTap`, `openStoryOf`, `openTeamFromStory` … |
| Zoom sur une photo (profil) : plein écran, pincer pour zoomer, | 20518 | `openPhotoZoom` |
| Audience : vues des publications et visites du profil | 20556 | `viewAttrs`, `recordView`, `observeViews`, `ensureAudienceSync`, `myAudience`, `postLabel` |
| Espace Pitbook+ (simulation de l'offre payante) | 20634 | `hasCarnetPlus`, `renderCarnetPlusTab`, `renderAudienceTab`, `mediaKitText` |
| Commentaires des messages | 20708 | `commentRowHtml`, `renderPostComments`, `likeComment`, `addComment`, `renderPersonalitiesSection` |
| Mur (wall) | 20795 | `visibleWallPosts`, `consumeSharedIn`, `postPlaceHtml`, `renderWallComposer`, `mentionsHtml`, `storyViewCount`, `inFeed`, `mentionCandidates` … |
| Messagerie privée | 21433 | `dmPolicyOf`, `isFriendName`, `teamDmInfo`, `teamDmUserName`, `welcomeDm`, `dmThreadWith`, `canMessage`, `dmReadMap` … |
| Groupes de discussion : amis et/ou membres d'un team | 21547 | `groupById`, `watchGroup`, `stopGroupWatch`, `groupAvatarHtml`, `sendGroupMsg`, `renderGroupThread`, `groupCandidates`, `openGroupEditor` … |
| Team | 21889 | `renderTeamPollEntry`, `renderTeamFeedEntry`, `updateTeamFeedPost`, `deleteTeamFeedPost`, `renderTeamPersonRow`, `teamCard`, `renderTeamMembersSection`, `renderTeamFollowersSection` |
| Audience du team (Pitbook+ motoclubs) | 22089 | `loadTeamAudience`, `renderTeamAudience`, `renderTeamSettings`, `renderTeamProBadgeGrantSection`, `renderTeamEventsManagement`, `renderEventManagementScreen`, `flatSections`, `renderTeamCard` … |
| Coach | 22677 | `renderCoachMessageThread`, `paintApplySlot`, `aggregatedCoachAvailability`, `coachAvailabilitySlotClass`, `slotAvailableTypes`, `renderCoachPlanningSection` |
| Demander depuis un créneau du planning (voir renderCoachPlanningSection) | 22838 | `openCoachSlotModal`, `coachSlotModalAllowedTypes`, `closeCoachSlotModal`, `renderCoachSlotModal`, `coachRequestAwaitingMe`, `coachRequestSlotHtml`, `renderCoachActionRow`, `renderCoachWaitingRow` … |
| Revenir en arrière | 23403 | `navSnapshot`, `navSig`, `navTrack`, `navBack`, `isSafeUrl`, `sanitizeLinks`, `captureDirtyFields`, `restoreDirtyFields` … |
| Comptes (Pilote / Accompagnant) | 23714 | `renderVerifyEmailScreen` |
| Lien public d'un roulage | 23741 | `publicRoulageLink`, `publicRoulageSnapshot`, `shareRoulage`, `loadPublicRoulage`, `renderPublicRoulage`, `handlePendingRoulageSignedIn`, `joinEventButtonHtml`, `setMyGroupAllDays` … |
| Import de chronos (photo / capture d'écran / texte collé) | 27602 | `findDuplicateSession`, `saveImportedSessions`, `openChronoImport`, `myDatesOnCircuit`, `chronoDateLooksRight`, `miniSheetX`, `openMiniSheet`, `openChronoDateCheck` … |

## Amis et abonnés

Depuis novembre 2026, il n'y a plus de demande d'ami. On **suit** quelqu'un, et deux personnes qui se suivent l'une l'autre sont **amies** (`friendsOf`). Les anciennes amitiés acceptées comptent toujours. À la connexion, `migrateFriendsToFollows` transforme une fois les amitiés et demandes envoyées du compte en abonnements.

## Carte de chaleur des repères

Les repères restent privés (`userPrivate`). Pour la carte de chaleur, chaque compte publie seulement les cases occupées par ses repères (grille 24 × 24, sans texte) dans `trackHeat/{uid}__{circuit}` (`publishTrackHeat`). La carte s'affiche à partir de 3 pilotes et une case s'allume si 2 pilotes y ont un repère (`heatLayerHtml`). Partage désactivable sur l'appareil.

## Tester

```
node _banc-de-test/lancer.js            # banc sur http://localhost:8766/index.html#lang=fr
node _banc-de-test/lancer.js amis fr    # un scénario
node _banc-de-test/lancer.js tout       # tous les scénarios (environ 35 min)
```

## Publier une version

1. Changer le numéro de version partout : `sed -i 's/ANCIEN/NOUVEAU/g' index.html sw.js`.
2. Commit et push : GitHub Pages publie tout seul.
3. Si `firestore.rules` a changé : le copier dans la console Firebase (Firestore › Règles) et publier.

## Règles du projet

- Aucune clé d'API d'IA dans `app.js`.
- Pas de lecture d'image payante, pas d'offre Firebase Blaze, pas de serveur.
- Jamais de conseil de pression de pneus ou de réglage.
- Les pages d'administration et les données d'import ne sont pas publiées.

Historique des versions : [PATCHNOTES.md](PATCHNOTES.md).
