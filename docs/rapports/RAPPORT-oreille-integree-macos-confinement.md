# Rapport — le moteur d'écoute intégré est confiné à Windows, et la branche Apple est contrôlée avant publication

Date : 2026-11-16 · Projet : `G:\IA_PL\pilot` · Suite directe de la publication **0.6.25**
(tag publié — **non retouché, non republié, non retagé**).

Demande du propriétaire, en deux gestes bornés :

1. **Confinement (une ligne)** : conditionner la feature du moteur d'écoute
   (`--features whisper`) à la cible **Windows uniquement** dans
   `.github/workflows/release.yml`, pour que les fabrications macOS redeviennent
   vertes comme en 0.6.24. Rien d'autre ne bouge dans le workflow. Le moteur
   n'existe donc que sur Windows pour l'instant : **voulu**, et **dit** dans la
   documentation et les notes de version.
2. **Contrôle préalable** : ajouter au workflow de contrôle qualité un job
   **macOS** qui compile **la même** commande avec la feature, **sans** fabrication
   d'installateur ni signature, **tolérant à l'échec**, et qui dépose son journal
   en **artefact** — pour compiler la branche Apple avant toute publication
   future, et obtenir le journal exact au premier échec.

---

## 1. La ligne modifiée

La matrice du job `build` de `.github/workflows/release.yml` porte désormais, par
cible, les drapeaux Cargo à passer à `tauri-action` :

```yaml
        include:
          - platform: windows-latest
            rust_target: x86_64-pc-windows-msvc
            laya_platform: win32/x64
            rust_cache_targets: "true"
            rust_features: "--features whisper"      # ← la seule ligne qui change
          - platform: macos-latest
            rust_target: aarch64-apple-darwin
            laya_platform: darwin/arm64
            rust_cache_targets: "false"
          - platform: macos-latest
            rust_target: x86_64-apple-darwin
            laya_platform: darwin/x64
            laya_allow_missing: "1"
            rust_cache_targets: "false"
```

et la ligne de commande de fabrication devient :

```yaml
          args: --target ${{ matrix.rust_target }} ${{ matrix.rust_features || '' }}
```

Trois détails délibérés :

- **La clé `rust_features` n'existe que sur la ligne Windows.** Le repli `|| ''`
  fait que la ligne `args:` est la même pour les trois cibles, et qu'aucune valeur
  vide ne traîne dans la matrice (une valeur vide dans `matrix.include` est un
  piège d'expression que ce fichier n'a pas besoin de courir).
- **Aucune condition écrite dans la commande** (`matrix.platform == …` reste hors
  de `args:`) : la matrice dit ce qu'elle veut, la commande ne fait que la lire.
  Il n'y a donc **qu'un seul endroit** où l'on décide de la présence du moteur.
- **Les deux entrées Apple sont maintenant identiques à la 0.6.24** (qui était
  verte) : mêmes cibles, mêmes clés, aucun drapeau. C'est exactement la seule
  différence de fabrication entre la 0.6.25 et la 0.6.24.

Ce qui **n'est pas** touché, et ne devait pas l'être : la chaîne C++ du moteur
(`GGML_BLAS`, Accelerate, noyaux ILP64, version de déploiement macOS, options de
`cmake`, copie locale `vendor/whisper-rs-sys`). Le journal de l'échec macOS de la
0.6.25 n'étant pas lisible (403 anonyme, `gh` absent), **rien n'a été changé au
jugé**.

---

## 2. Ce que le nouveau contrôle fera au prochain passage

Nouveau job **`check-macos-whisper`** dans `.github/workflows/quality-gate.yml`,
à côté du job `tests` (qui reste **seul juge** des suites) :

| Point | Ce qui est fait |
|---|---|
| Machine | `runs-on: macos-latest` (Apple Silicon), `timeout-minutes: 60` |
| Tolérance | `continue-on-error: true` — **le seul job du fichier** dans ce cas |
| Prérequis | `actions/checkout`, `dtolnay/rust-toolchain@stable`, Node 24, `npm ci`, `npm run build:mcp` (le bundle MCP est un `include_str!` : sans lui, la compilation échoue pour une raison étrangère au moteur) |
| Compilation | `cargo build --manifest-path src-tauri/Cargo.toml --release --features whisper 2>&1 \| tee whisper-macos-build.log` — **la même feature** que la publication, profil `release`, même caisse `whisper-rs-sys` patchée |
| Journal | `actions/upload-artifact@v4`, étape `if: always()`, nom `whisper-macos-build.log`, conservation 30 jours |
| Ce qu'il ne fait **pas** | aucun installateur, aucune signature (`tauri-action` absent du job), aucun secret, aucune Release, aucun test, aucun cache Rust (le budget de 10 Go reste tenu par la publication) |

Conséquences concrètes :

- **À chaque proposition de modification et à chaque poussée sur `main`**, la
  branche Apple de `whisper.cpp` est réellement compilée. Le confinement n'est
  donc pas un angle mort : si le problème de fond subsiste, on le voit **avant**
  une publication, pas pendant.
- **Au premier échec, le journal est lisible** dans l'onglet *Actions* du run
  (artefact téléchargeable), sans authentification supplémentaire : le texte exact
  du compilateur remplace la supposition de la 0.6.25. C'est **la** raison d'être
  du job — c'est cette pièce qui manquait pour trancher la chaîne C++.
- **Le contrôle ne peut pas bloquer le travail** : il est toléré à l'échec, il ne
  lance aucun test (ces derniers restent entièrement dans `tests`, dont le verdict
  est le seul qui compte), et il ne publie rien.
- **Il ne ralentit pas la publication** : il n'est ni dans `release.yml`, ni dans
  la chaîne critique ; un run macOS indisponible n'affecte aucune livraison.

### Un détail vérifié, qui aurait pu faire échouer le job pour de mauvaises raisons

`tauri::generate_context!` **panique à la compilation** si `frontendDist`
(`../dist`) n'existe pas… sauf quand la compilation est « dev », c'est-à-dire
quand la feature `tauri/custom-protocol` n'est pas activée
(`tauri-macros-2.6.3/src/context.rs`, `dev: cfg!(not(feature = "custom-protocol"))`).
Le job ne l'active pas : il n'a donc besoin **ni** du front bâti, **ni** du service
Laya, et la compilation demandée est bien celle qui intéresse la chaîne C++.
Vérifié à la lecture de la caisse ; rien n'est supposé.

---

## 3. Ce qui reste inchangé

Rien de fonctionnel ne bouge, et en particulier :

- **Oreille du service de voix local (VoiceStudio)** : intacte, et **toujours le
  défaut** (`local_dictation_engine = "voicestudio"`). Aucun réglage par défaut
  n'est modifié.
- **Piper** (voix françaises locales de la lecture à voix haute) : intact.
- **Synthèse VoiceStudio** (voix imitée) : intacte.
- **Web Speech** (dictée du navigateur, web distant) : intact.
- **Garde du nom** (§ 6quater), **échéance de silence repoussée par la voix**,
  **veille de 20 s**, **envoi automatique** : intacts, aucune ligne touchée.
- **La feature Cargo reste optionnelle** (`default = []`) : un build sans drapeau
  reste vert, et c'est ce que lancent `cargo test` et le job `tests`.
- **Le comportement quand le moteur n'est pas compilé ne change pas** : le module
  compile quand même et répond `moteur-non-compile` avec une phrase française —
  jamais un échec, jamais un silence. C'est **déjà** ce que macOS fait
  naturellement depuis ce confinement.
- **Topologie de la chaîne de publication** : `test` (chemin critique, aucune
  machine Apple), `test-macos` hors chaîne, `build` Windows + les deux macOS,
  `build-linux` séparé, `latest-json` dépendant de `build` seulement. Aucun
  `needs` n'a été ajouté, aucun job déplacé.
- **Version, tag, publication** : aucune modification. `v0.6.25` reste tel quel ;
  la publication de la version suivante reste une **demande explicite** du
  propriétaire.

### Ce qui est dit, désormais

- `spec_voice_input.md` § 9bis point 8 : le drapeau n'est posé que sur Windows,
  avec la raison (0.6.25, branche Apple, journal illisible), et la mention du
  contrôle `check-macos-whisper`.
- `spec_voice_input.md` (aide intégrée, bloc `<!-- HELP:dictee-vocale -->`) : le
  moteur intégré **n'est livré que dans la version Windows** pour l'instant, et
  sous macOS Pilot le dit puis revient à la dictée du navigateur.
- `AGENTS.md` : la ligne de navigation rapide porte le confinement et le contrôle
  amont.
- `spec_registre_comportements_valides.md`, **entrée n° 30** : le comportement
  attendu et le test qui le protège.

---

## 4. La phrase exacte pour les notes de la prochaine version

À recopier telle quelle dans `release-notes/vX.Y.Z.md` (section
**⚡ Améliorations** ou **🐛 Corrections**, au choix de la rédaction) :

> **Le moteur d'écoute intégré est pour l'instant réservé à Windows.** Sous macOS,
> Pilot vous le dit et revient à la dictée du navigateur, comme avant : rien n'est
> cassé et rien ne change pour vous. La compilation macOS de ce moteur est
> désormais contrôlée **avant** chaque publication, et son journal est conservé :
> il reviendra sur Mac dès qu'elle sera verte.

Variante courte, si les notes sont très serrées :

> **Moteur d'écoute intégré : Windows uniquement pour l'instant.** Sous macOS,
> Pilot l'annonce et revient à la dictée du navigateur. Sa compilation macOS est
> désormais contrôlée avant chaque publication (journal conservé), pour qu'il
> revienne sur Mac dès qu'elle sera verte.

Ce qu'il ne faut **pas** écrire, pour éviter de promettre ce qui n'est pas fait :
aucune date, aucune version cible, aucune cause technique affirmée (le journal de
la 0.6.25 n'a pas été lu — c'est précisément ce que le nouveau contrôle apporte).

---

## 5. Verrous (tests qui tiennent la décision)

| Fichier | Ce qu'il refuse désormais |
|---|---|
| `src/js/oreille-integree-whisper-livraison.test.js` (12 verrous) | que le drapeau quitte la cible Windows, qu'il **revienne** sur une cible Apple, que la ligne `args:` cesse de lire la matrice, qu'une seconde compilation apparaisse à côté de `tauri-action`, que les trois cibles publiées changent, que la feature cesse d'être optionnelle, ou que le défaut `voicestudio` bouge — **et** que le contrôle amont `check-macos-whisper` disparaisse |
| `scripts/quality-gate-workflow.test.js` (19 verrous) | que le job `check-macos-whisper` manque, qu'il ne compile pas la bonne feature, qu'il fabrique ou signe quoi que ce soit, qu'il lance des tests, qu'il **cesse** d'être toléré, qu'un **autre** job devienne tolérant, ou que son journal cesse d'être déposé (`if: always()`) — le job `tests`, lui, reste interdit de `continue-on-error` |
| `scripts/release-workflow.test.js`, `scripts/publication-sans-macos.test.js` | inchangés et verts : la topologie de publication et la livraison sans macOS ne sont pas affectées |
| `src/js/registre-comportements-valides.test.js` | que l'entrée n° 30 cite un test absent, sauté, creux, ou qu'un numéro manque |

Preuves d'exécution (poste Windows, `G:\IA_PL\pilot`) : `npx vitest run`
sur les quatre fichiers concernés → **vert** ; suite complète `npm test` → voir
§ 6.

---

## 6. Vérifications exécutées

| Commande | Résultat |
|---|---|
| `python -c "yaml.safe_load(...)"` sur les deux workflows | YAML valide ; la matrice `build` rend bien trois entrées (`windows-latest` avec `rust_features: "--features whisper"`, les deux `macos-latest` sans la clé), et `args` vaut `--target ${{ matrix.rust_target }} ${{ matrix.rust_features || '' }}` |
| `npx vitest run src/js/oreille-integree-whisper-livraison.test.js` | 12 tests, **vert** (échoue sur l'ancien verrou, qui exigeait le drapeau sur les trois cibles) |
| `npx vitest run scripts/quality-gate-workflow.test.js scripts/release-workflow.test.js scripts/publication-sans-macos.test.js` | 41 tests, **vert** |
| `npx vitest run src/js/registre-comportements-valides.test.js` | 10 tests, **vert** (entrée n° 30 acceptée) |
| `npm test` (suite complète, sur le poste Windows) | **325 fichiers / 6 002 tests — vert** |
| `npm run build:handbook` | handbook régénéré (le bloc `HELP:dictee-vocale` a changé) |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib` | **non relancé** : aucun fichier Rust n'a été modifié (ni `Cargo.toml`, ni la feature, ni la chaîne C++) |

Ce qui **n'a pas** été fait, volontairement : aucune fabrication complète
(`npm run tauri build`), aucune compilation macOS locale (impossible depuis ce
poste), aucune publication. La vérification de la branche Apple relève du service
d'intégration : c'est exactement ce que le nouveau job rend possible.

---

## 7. Limite connue, dite franchement

Le confinement **ne corrige pas** l'échec macOS de la 0.6.25 : il le met **de
côté** pour rendre la publication verte, et il installe le moyen de le
comprendre. Tant que la branche Apple n'est pas verte dans
`check-macos-whisper`, le moteur d'écoute intégré reste **Windows seulement** —
et chaque version publiée doit le dire (phrases du § 4). Le jour où ce job passe
au vert, la ligne `rust_features: "--features whisper"` pourra être remise sur
les deux entrées Apple **avec la certitude** que la fabrication aboutit.
