# Rapport — PocketTTS comme voix de lecture SUPPLÉMENTAIRE

Date : 2026-11-16
Demande du propriétaire : « ajouter PocketTTS comme voix de lecture en plus, pas à la place ».

Rapport écrit **avant** les longues séries de tests, comme demandé (il est le plan
de bataille : ce qui est ajouté, ce qui ne bouge pas, ce qui reste bloqué).

---

## 1. Ce qui est ajouté, en une phrase

Une **quatrième entrée** dans la liste de voix existante (Paramètres → Assistant →
« Lecture des réponses ») : `PocketTTS`, à côté de « Automatique », des voix
imitées (`VoiceStudio`), des voix françaises locales (`Piper`) et des voix du
système. Même réglage unique `read_aloud_voice`, même liste, même bouton
« Écouter » d'aperçu, même mécanisme de repli annoncé. **Rien n'est remplacé,
renommé, retiré ni rendu inatteignable.**

## 2. Ce qui ne bouge PAS (contrat anti-régression)

| Élément existant | État après ce lot |
|---|---|
| `local:piper` / `local:piper:<modèle>` (Piper, 4 voix, femme + homme) | intact, toujours proposé, toujours premier moteur local |
| `local:voicestudio:<profil>` (« Ma voix imitée ») | intact, toujours proposé |
| Voix du système + « Automatique » (valeur `""`) | intact, **toujours premier** de la liste et toujours le défaut |
| Réglage `read_aloud_voice` (clé unique) | inchangé ; aucune seconde clé de voix n'est créée |
| `character_voices` (voix par personnage) | inchangé, accepte en plus une valeur Pocket |
| Bouton « Installer la voix locale » (Piper) | inchangé, aucun téléchargement automatique |
| Repli Piper → voix du système | inchangé ; Pocket ajoute un maillon **avant** Piper |
| Aucun téléchargement sans geste | étendu à Pocket : mêmes règles, même bouton dédié |

## 3. Décision de conception (reprise du plan déjà écrit)

`RAPPORT-chaine-vocale-integree-pilot.md` § 2.2 avait déjà arrêté la forme :

- **Valeur du réglage** : `local:pocket` (voix française par défaut du moteur) ou
  `local:pocket:<identifiant>` (une voix déposée dans le dossier de PocketTTS).
  Le préfixe reste `local:` : le son est fabriqué **sur cet ordinateur**.
- **Fichiers neufs** (un rôle par fichier, aucun doublon) :
  - `src-tauri/src/tts_pocket.rs` — le moteur vu par Pilot : chemins, état,
    synthèse WAV en mémoire, journal, **installation sur geste** ;
  - `src/js/pocket-voice.js` — la valeur du réglage, les libellés, l'état ;
  - `src/js/voix-pockettts.test.js` — les verrous exigés.
- **Fichiers seulement ÉTENDUS** (jamais réécrits) : `src/js/read-aloud.js`
  (liste + branche de lecture + phrase de repli), `src/js/settings.js` (affichage
  + geste d'installation), `src/js/character-voices.js` (accepte la valeur),
  `index.html` (une ligne d'état + un bouton), `src-tauri/src/lib.rs`
  (déclaration du module + 4 commandes).

## 4. Le moteur, tel qu'il est réellement

Mesures du banc (`.pilot/assistant/banc/pocket-tts/`, rapport du banc) :

- tourne **sur le processeur seul** (`--device cpu`), **aucune carte graphique** ;
- **hors ligne après installation** : la synthèse ne fait aucun appel réseau ;
- ≈ **3× temps réel** sur CPU ; premier appel à froid plus lent (chargement du
  modèle) → d'où un plafond de temps généreux et une synthèse **hors du thread de
  la fenêtre** ;
- poids du modèle français **≈ 209 Mo**, téléchargés **une seule fois**, sur geste.

Pilot **n'installe pas** PocketTTS : il ne télécharge pas Python, il ne crée aucun
environnement virtuel, il n'installe aucun paquet. Il **utilise** un moteur déjà
présent sur l'ordinateur (voir § 7).

## 5. Licences et attribution

- **Code** : MIT (dépôt `kyutai-labs/pocket-tts`).
- **Poids** : **CC-BY-4.0** → l'attribution est **obligatoire** et affichée à deux
  endroits, écrits une seule fois :
  - `Pocket TTS © Kyutai Labs — CC BY 4.0` (constante `ATTRIBUTION` dans
    `tts_pocket.rs`, ligne d'état de la section des Paramètres) ;
  - la même phrase dans `help/` (aide embarquée) et dans `spec_read_aloud.md`.

## 6. Repli : jamais un silence, jamais un mensonge

Chaîne, dans cet ordre, avec **annonce visible à chaque marche** :

```
PocketTTS  →  Piper (voix française locale)  →  voix du système
```

- Pocket absent / non installé / en échec → état `pocket-fallback`, phrase sous le
  bouton « Écouter » : « Voix PocketTTS indisponible (…ça) : lecture avec la voix
  locale (Piper). » — **même ligne, même endroit, même style** que les replis
  existants (`readAloudFallbackNotice`, `readAloudVoiceStudioFallbackNotice`) :
  aucun nouveau mécanisme d'affichage.
- Une ligne est écrite dans le journal existant `voix-locale.log`
  (préfixe `[PocketTTS]`), comme pour les deux autres moteurs.
- Le réglage de l'utilisateur **n'est jamais réécrit** par un repli.

## 7. Limites et points bloqués (écrits ici, pas de question posée)

1. **Le moteur n'est pas embarqué.** Pilot ne peut pas, à lui seul, rendre
   PocketTTS disponible : il faut un exécutable `pocket-tts` présent sur
   l'ordinateur (environnement Python du dépôt kyutai-labs). Pilot le cherche à un
   emplacement fixe et **dit** où il le cherche (`<données de Pilot>/voix-pocket/moteur/`).
   C'est un **choix** : embarquer un interpréteur Python multiplierait la taille du
   paquet et serait une régression pour tous ceux qui n'utilisent pas cette voix.
   Conséquence assumée : sans moteur, PocketTTS est **proposé mais annoncé
   indisponible**, et la lecture reste sur Piper — jamais de blocage.
2. **Voix françaises clonées : poids « clonage » sous autorisation** (constat du
   banc). Les voix **prévues par le moteur** (`estelle`, incluse dans les poids
   français non-clonage) fonctionnent sans jeton. Une voix **clonée** déposée par
   l'utilisateur dans `voix/` est acceptée et transmise telle quelle : si ses poids
   manquent, le moteur refuse, et le repli annoncé s'applique. Le propriétaire a
   constaté que ses voix de test se clonent : **rien n'est remis en cause ici**, on
   transmet le chemin et on rapporte l'erreur telle quelle si elle survient.
3. **Téléchargement des poids** : il passe par l'outil du moteur (mise en cache
   `HF_HOME` locale). Pilot ne fait que **lancer** ce geste, avec un plafond de
   temps, et **relit ensuite l'état réel** des fichiers.

## 8. Tests (verrous)

Front (`src/js/voix-pockettts.test.js`) :

1. Pocket apparaît **en plus** de Piper et de VoiceStudio, dans **la même** liste ;
2. **aucune voix existante ne disparaît** (échec si Piper ou VoiceStudio sort de la
   liste après l'ajout) ;
3. **Pocket n'est jamais le défaut** (échec si le premier choix n'est plus la
   valeur vide / si une valeur Pocket devenait le défaut) ;
4. **aucun téléchargement sans geste** : la commande d'installation n'est appelée
   nulle part hors du gestionnaire de clic du bouton dédié (analyse du source) ;
5. le **repli est annoncé** (phrase non vide, nommant Piper) ;
6. le **genre est écrit en clair** dans les libellés, et l'état d'installation
   aussi ;
7. une voix clonée est une entrée **ordinaire** de la même liste (aucun réglage
   séparé).

Rust (`src-tauri/src/tts_pocket.rs`, `mod tests`) : lecture de la valeur du
réglage, libellés, découverte du moteur, détection des poids français,
**`synthesize` ne télécharge rien**, validation RIFF/WAVE, journal, attribution
présente.

## 9. Rien de publié

Aucun tag, aucun envoi GitHub, aucun nouveau numéro de version : **commit local
seulement**, comme demandé.

## 10. État final mesuré (après les longues suites)

| Suite | Résultat |
|---|---|
| Front (`npx vitest run`) | **6 023 passés, 0 échec** (dont `src/js/voix-pockettts.test.js` : 20/20) |
| Rust desktop (`cargo test --manifest-path src-tauri/Cargo.toml --lib`) | **988 passés, 3 ignorés, 0 échec** (dont `tts_pocket::` : 14/14) |
| Rust espace de travail (`cargo test --workspace`) | **1 161 passés, 14 ignorés, 0 échec** |

Totaux **non réduits** : les seules retouches de tests existants sont des
**ajouts** (`READ_ALOUD_SPEAKING_STATES` passe de quatre à cinq états dans
`vocal-correctifs-revue.test.js`, exactement ce que ce verrou demande de faire
« en connaissance de cause » quand un état de lecture est ajouté).

### Ce qui a été corrigé en cours de route (et qui reste verrouillé)

1. Une **seconde** interrogation de la voix imitée s'était glissée dans la
   vérification unique (`refreshVoiceStudioStatus` appelée deux fois) — retirée,
   la vérification reste unique.
2. `pocketVoiceChoices(undefined)` n'ajoute plus aucune ligne : un appelant qui
   ne parle pas de cette voix n'en voit pas l'entrée (compatibilité des tests
   existants de la liste), tandis qu'un état **illisible** (`null` / `unknown`)
   garde la ligne « état non vérifié ».
3. La **comparaison d'une voix PocketTTS se fait par VALEUR**, pas par
   identifiant : la voix par défaut du moteur porte la valeur courte
   `local:pocket` (et non `local:pocket:estelle`), sans quoi une voix par défaut
   installée aurait été jugée « introuvable ».

### Points ouverts (dits, non contournés)

- **Pilot n'installe pas PocketTTS** : sans le programme dans
  `<app_data_dir>/voix-pocket/moteur/`, la section dit où le déposer et le bouton
  d'installation reste inactif (aucun paquet, aucune commande, aucune adresse
  inventée).
- **Les poids français avec clonage** du moteur sont protégés par une
  autorisation Hugging Face : le clonage de voix se fait donc **dans le moteur**,
  par l'utilisateur, et Pilot ne fait que proposer les voix déposées.
