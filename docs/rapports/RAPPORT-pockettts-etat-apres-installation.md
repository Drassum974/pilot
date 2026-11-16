# Rapport — PocketTTS : l'état se met à jour APRÈS l'installation

Date : 2026-11-16 · Branche courante · Aucune version publiée, aucun tag.

## 1. Ce qui était constaté avant (lecture seule, rien modifié)

Le propriétaire : « après le téléchargement / l'installation, l'état affiché ne
se met pas à jour — il faut cliquer « Vérifier à nouveau » pour voir que c'est
prêt ».

Chaîne réelle, relevée dans le code **avant** correction :

1. `settings.js`, gestionnaire du bouton `#btn-read-aloud-pocket-install` :
   `await installPocketWeights()` — puis, juste après,
   `refreshReadAloudVoice(selectReadAloudVoice.value)`.
2. `refreshReadAloudVoice(choice, options)` **sans** `options.gesture` : la seule
   relecture d'état de la section (`ensureLocalVoiceChecked`) n'est demandée que
   si `options.gesture` est vrai, sinon seulement `si (!localVoiceAutoChecked)`.
   Or `localVoiceAutoChecked` vaut déjà `true` (la vérification automatique de
   l'ouverture des Options a eu lieu). **Aucune relecture n'était donc demandée.**
3. `renderReadAloudVoice` repeignait la section avec l'état **mémorisé**, périmé
   (`installed: false`, poids absents) : la liste gardait le suffixe
   « — modèle à télécharger », le bouton d'installation restait affiché, et la
   ligne d'état — que le gestionnaire venait d'écrire — était **écrasée** par la
   phrase de l'ancien état.

Autrement dit : le seul chemin capable de voir les fichiers nouvellement
installés (`checkLocalVoiceStatus` → `refreshPocketStatus` → `tts_pocket_status`)
n'était pas emprunté. Il fallait le bouton « Vérifier à nouveau », qui l'appelle
directement.

Côté machine, rien à corriger : `tts_pocket_install` **relit l'état réel** et ne
répond `Ok` que si les poids sont sur le disque (`install_weights`, module
`tts_pocket.rs`) ; `tts_pocket_status` ne fait que **lire** des fichiers.

## 2. Le correctif (minimal, sans second mécanisme)

Aucune nouvelle commande, aucun nouvel évènement, aucun délai, aucun minuteur.

**Deux décisions pures**, dans `src/js/pocket-voice.js` (la source unique de
l'état de cette voix) :

- `pocketRefreshAfterInstall(result)` → **vrai** seulement sur un retour
  d'installation `{ ok: true }`. Un échec, un retour absent ou un `ok` non
  booléen ⇒ **faux** : on ne relit rien.
- `pocketInstallOutcomeNote(result, status)` → ce que la ligne d'état doit dire
  et dans quel état la peindre : échec ⇒ phrase « Installation impossible
  (cause)… repli sur Piper » (l'état connu n'est pas touché) ; succès **confirmé**
  par l'état relu ⇒ la voix est prête ; succès **non confirmé** ⇒ la phrase du
  module dit aussi ce qui manque encore (`pocketStatusNote`, formulation
  existante, réutilisée — aucune seconde formulation de l'état).

**Un seul branchement**, dans le gestionnaire du bouton (`settings.js`) :

```
const result = await installPocketWeights();
if (pocketRefreshAfterInstall(result)) {
  await checkLocalVoiceStatus(selectReadAloudVoice ? selectReadAloudVoice.value : "");
} else {
  refreshReadAloudVoice(selectReadAloudVoice ? selectReadAloudVoice.value : "");
}
const outcome = pocketInstallOutcomeNote(result, getPocketStatus());
→ la note affiche outcome.text / outcome.state
```

- la relecture est **celle du bouton « Vérifier à nouveau »**, une seule fonction
  (`checkLocalVoiceStatus`), donc une seule commande et un seul traitement :
  aucun mécanisme parallèle, aucune duplication ;
- elle suit la **fin réelle** de l'installation (le `await` de la commande), pas
  un délai deviné, et elle est **unique** : une seule relecture par installation ;
- un **échec** ne relit pas et ne remet rien à zéro (la liste, le bouton et la
  ligne restent sur l'état connu, désormais rendus **après** la note pour qu'elle
  ne soit plus écrasée) ;
- le bouton « Vérifier à nouveau » est **inchangé** ;
- aucun réglage nouveau, aucun téléchargement : on **relit** seulement.

## 3. Tests (écrits d'abord : ils échouaient sur le code d'avant)

`src/js/pocket-etat-apres-installation.test.js` — 14 contrôles, 5 groupes :

1. décision de relecture : succès ⇒ relire ; échec ⇒ non ; aucun retour ⇒ non ;
   `{ ok: "true" }` ⇒ non ;
2. branchement : le gestionnaire appelle `pocketRefreshAfterInstall(result)` puis
   `checkLocalVoiceStatus(...)` **une seule fois**, sous cette garde, sans
   `setTimeout`/`setInterval`, sans `refreshLocalVoiceStatus`, et
   `checkLocalVoiceStatus` n'existe **qu'une fois** dans le fichier (mesure
   chiffrée) ;
3. la phrase de fin : succès confirmé ⇒ état `ok` sans le suffixe « modèle à
   télécharger » ; succès non confirmé ⇒ état `missing` **et** la phrase de
   l'état (jamais un succès qui ment) ; échec ⇒ « Installation impossible »,
   cause nommée, `Piper` rappelé, état connu conservé ; cause vide ⇒ aucune
   parenthèse vide ;
4. chaîne réelle : état « poids absents » ⇒ ligne suffixée ; après
   `refreshPocketStatus` (même commande `tts_pocket_status`, invocateur factice
   « installé ») ⇒ `installed: true`, **sans** suffixe, valeur
   `local:pocket:estelle` choisissable ; une relecture en **échec** ne fait pas
   disparaître la voix (« état non vérifié ») ;
5. « Vérifier à nouveau » : appelle toujours `checkLocalVoiceStatus`, ne relit
   pas lui-même `refreshPocketStatus`, ne touche pas à la décision d'après
   installation.

## 4. Preuve par mutation (les tests mordent)

| Mutation appliquée | Résultat |
|---|---|
| `if (pocketRefreshAfterInstall(result))` → `if (false)` (comportement d'avant : on ne relit jamais) | **2 tests ÉCHOUENT** |
| `pocketRefreshAfterInstall` → `return result !== undefined;` (un échec relirait comme un succès) | **4 tests ÉCHOUENT** |
| Code restauré (identique au bit : `diff` vide) | 14/14 verts |

## 5. Vérifications lancées

- `npm test` → **331 fichiers, 6092 tests, tous verts** (suite entière, pas
  seulement les fichiers touchés).
- `cargo test --manifest-path src-tauri/Cargo.toml --lib tts_pocket` → **14
  tests verts** (le moteur, son état et sa synthèse n'ont pas bougé).
- `npm run build:handbook` → `help/handbook.md` régénéré (bloc
  `HELP:lire-reponses` mis à jour).

## 6. Doc et aide intégrée

- `spec_read_aloud.md` § 4 quinquies : nouveau point **12** (rafraîchissement de
  l'état sur la fin réelle d'une installation, chemin unique, jamais après un
  échec, jamais de boucle) + couverture du nouveau fichier de tests.
- `help/overview.md`, bloc `HELP:lire-reponses` : la phrase visible par
  l'utilisateur — « dès que l'installation se termine, l'état se met à jour tout
  seul », « Vérifier à nouveau » reste là pour relire à la demande, et un échec
  n'est jamais présenté comme réussi.

## 7. Ce qui n'a pas été touché (volontairement)

- le moteur PocketTTS, ses arguments, sa synthèse et ses commandes Rust ;
- les trois autres voix (système, Piper, VoiceStudio) et le champ unique
  `read_aloud_voice` ;
- aucun réglage nouveau, aucun téléchargement : `installPocketWeights` reste le
  seul chemin de téléchargement, appelé par un seul clic ;
- aucun test existant assoupli ni sauté.
