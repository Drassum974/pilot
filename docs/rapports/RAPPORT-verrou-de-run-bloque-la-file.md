# Le verrou de run ne survit plus à son propriétaire

**Défaut corrigé** : le verrou d'un projet (`busState.runs[clé]`) pouvait rester
tenu alors qu'aucun run ne le portait, et la **file du projet restait bloquée à
vie** : les demandes en attente ne démarraient plus jamais.

Trois causes, établies par un diagnostic indépendant (mission #5) puis vérifiées
sur le code :

| # | Cause | Effet observé |
|---|---|---|
| 1 | La **vidange de file répondait « lancé »** dès qu'une entrée existait, même quand le lancement était **refusé** (`launchNextQueued` rendait un booléen ambigu) | Le verrou croyait avoir un propriétaire ; aucun run n'avait démarré |
| 2 | Une demande dont la **mission propriétaire avait disparu** (arrêt d'agent → contexte de run détruit) restait **orpheline à vie** | « verrou conservé pour ne rien perdre » → jamais libéré |
| 3 | Le **chien de garde antidatait sa propre preuve d'inactivité** (`resetTimeout` réécrivait `lastActivityAt` à chaque passage de rejeu) | Le verrou paraissait toujours actif ; le balayage **rafraîchissait le verrou qu'il devait faire tomber** |

## 1. Décision unique, pure et testable

Nouveau module **`src/js/verrou-de-run.js`** — aucun DOM, aucun import Tauri,
aucune I/O, aucun minuteur. Il est la **seule** source des règles :

| Export | Rôle |
|---|---|
| `decideQueueDrain(attempts, { blocked })` | Verdict d'une vidange : « lancé » = **un run a réellement démarré**, jamais « une entrée existait ». Les refus sont comptés, nommés, traduits en phrase. |
| `decideRunLockAfterDrain({ drain, pending, door })` | **Décision du verrou** après vidange (voir table ci-dessous). |
| `decideQueuedDemandPlacement({ ownerKey, ownerAlive })` | Une demande orpheline n'est **jamais** exécutée dans un contexte étranger. |
| `decideActivityStamp({ source, now, previous })` | Horodatage d'inactivité **monotone**, seulement pour une source qui prouve une activité. |

Règles de `decideRunLockAfterDrain`, **dans l'ordre** (c'est la spec) :

| Cas | Action |
|---|---|
| des demandes présentes n'ont **pas pu être tentées** (clé de file inutilisable : on ignore qui les porte) | **conservé** (`not-drainable`) — les abandonner perdrait une mission |
| un run a **réellement démarré** | **conservé** (`relaunched`) |
| au moins un lancement **refusé** | **libéré** (`replay-refused`), le refus est dit |
| rien n'a été tenté | **libéré** (`nothing-queued`) |

Invariants posés en tête du module (A→D) : un verrou n'est tenu que par un run
réellement démarré (A) ; un refus libère et le dit (B) ; un orphelin n'exécute
rien et ne bloque rien (C) ; seul un événement d'agent ou un lancement réel
horodate, et l'horodatage ne recule jamais (D).

## 2. Modifications ciblées (`agents-bus.js`)

- `drainExclusivityQueues` retourne `decideQueueDrain(attempts, { blocked })` au
  lieu d'un booléen ; `blocked` compte les demandes présentes mais **non
  tentables** (clé de file sans séparateur : impossible de nommer l'agent).
- `launchNextQueued` rend `{ launched, reason }` sur **tous** ses chemins
  (`no-demand`, `owner-gone`, `agent-missing`, `turn-not-started`, `launched`).
  Sur `owner-gone` : l'entrée **reste en file** (jamais supprimée), marquée
  `ownerMissingReported`, tracée (`reason=queue-replay-no-owner`) et signalée.
- `runAgentTurn` rend un **booléen** : `true` seulement après envoi réel du
  prompt (c'est la seule preuve qu'un verrou peut invoquer), `false` sur agent
  introuvable, modèle manquant et exception.
- `stampRunActivity(ctx, source, at)` = **seul** point d'écriture de
  `lastActivityAt` ; `armInactivityTimeout(ctx)` réarme **sans horodater**.
  `resetTimeout` est supprimé (plus aucune occurrence).
- Le chien de garde (`releaseStuckRunLockForKey`) et le balayage « stopping »
  passent par `decideRunLockAfterDrain` : `RUN_LOCK_KEEP` → `armInactivityTimeout`.
  La branche « `pending > 0` conserve le verrou » est **supprimée** (cause #1) :
  les demandes restantes restent en file, visibles et abandonnables, mais elles
  ne tiennent plus le projet.
- **Aucun second mécanisme** : la libération passe par les sorties existantes
  (`releaseStuckRunLock`, `releaseOrphanRunLock`, `launchNextQueuedForProject`).

## 3. Ce qui est préservé (garde-fous intacts)

- La porte `orphanQueue` exige **deux mesures concordantes**
  (`watchdogConfirmDelayMs` = 7 s, `0` en test) : la première arme une
  revérification, la seconde libère. **Non contournée** — les nouveaux tests
  font bien deux balayages espacés.
- La file n'est **jamais** supprimée ni vidée ; aucune demande en attente n'est
  perdue, aucune n'est dupliquée.
- `verrou-orphelin.test.js` (mission 380), `verrou-par-projet.test.js` (C1),
  `file-attente-*`, `project-task-queue.test.js`, `agents-bus.test.js` : tous
  verts, **aucun test assoupli ni sauté**.

## 4. Preuves par mutation

Chaque mutation appliquée seule au code final, puis restaurée (`cmp` identique
après restauration).

| Mutation | Tests rouges |
|---|---|
| **A** — `decideQueueDrain` : `launched: list.length > 0` (retour à la cause #1 : « une entrée existe = c'est lancé ») | **5** : A, B, « orphelin libéré », « nouvelle demande démarre après arrêt », « le balayage périodique libère le verrou » |
| **B** — `decideRunLockAfterDrain` : early-return `RUN_LOCK_KEEP` si `pending > 0` (retour à la cause #2) | **4** : B, orphelin, nouvelle demande après arrêt, balayage périodique |
| **C** — `decideActivityStamp` : `proven = true` (le chien de garde peut horodater — cause #3) | **1** : D |
| **D** — `armInactivityTimeout` réécrit `ctx.lastActivityAt` (le réarmement antidate sa preuve) | **1** : invariant de câblage « un seul écrivain de `lastActivityAt` » |
| **E** — `decideQueueDrain` : `blocked: 0` (les demandes non tentables sont comptées comme « rien à faire ») | **2** : `agents-bus.test.js` > « file NON drainable (clé invalide) → verrou CONSERVÉ » **et** le nouveau test « demandes non tentables » |

La mutation E est la plus instructive : elle prouve que le garde-fou existant
`file NON drainable → verrou CONSERVÉ` (issue #87) **dépend réellement** du
nouveau canal `blocked` — il n'a pas été assoupli, il est désormais tenu par une
décision explicite au lieu d'un `continue` implicite dans la boucle.

## 5. Couverture

`src/js/verrou-de-run-bloque-la-file.test.js` — **12 tests**, quatre familles :

1. **Décisions pures** A/B/C/D (dont la priorité du `blocked` sur le refus).
2. **Rejeu d'une demande orpheline** : elle reste en file, signalée, et libère
   le verrou au plus tard à la revérification.
3. **Arrêt d'agent puis nouvelle demande** : le verrou est réellement libéré et
   la demande suivante démarre tout de suite.
4. **Chien de garde** : quatre passages espacés ne rallument plus le verrou ;
   un verrou encore tenu doit prouver une activité **antérieure** à l'idle ;
   une relance réelle conserve le verrou ; des demandes **non tentables** le
   conservent sans les perdre.
5. **Invariants de câblage** : `lastActivityAt` écrit à un seul endroit,
   `resetTimeout` absent, `decideRunLockAfterDrain` appelé aux deux portes,
   seuils inchangés (`RUN_LOCK_SWEEP_MIN_IDLE_MS`, `RUN_LOCK_SWEEP_START_GRACE_MS`).

## 6. Résultats

| Commande | Résultat |
|---|---|
| `npx vitest run src/js/verrou-de-run-bloque-la-file.test.js` | PASS (12) / FAIL (0) |
| `npm test` | **330 fichiers / 6078 tests**, PASS (6078) / FAIL (0) |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib` | **990 passed**, 0 failed, 3 ignored |
| `node --check` sur les fichiers touchés | OK |

## 7. Documentation mise à jour

- `spec_gestion_agents.md` : nouvelle sous-section « Le verrou de run ne survit
  jamais à son propriétaire » (table des décisions) + ligne du module dans le
  tableau des modules + bloc `<!-- HELP:agents -->` enrichi (« Un projet bloqué
  se débloque tout seul »).
- `AGENTS.md` : la ligne `agents-bus.js` renvoie à la décision unique
  `verrou-de-run.js` et à son verrou de test.
- `help/handbook.md` régénéré (`npm run build:handbook`).

## 8. Limite assumée

Une demande **non tentable** (clé de file inutilisable) conserve le verrou : on
ne peut pas prouver qu'elle est orpheline, et la libérer reviendrait à
l'abandonner en silence. Ce cas est **dit** (avertissement + phrase de décision)
et reste visible dans la file ; il ne peut venir que d'une corruption de clé,
jamais du fonctionnement normal.
