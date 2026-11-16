# Rapport — publication de Pilot v0.6.27

> Mission : publier **0.6.27** (dépôt `G:\IA_PL\pilot`), et rien d'autre. Le
> numéro `v0.6.26` ne se republie jamais.
> Toutes les valeurs de ce rapport ont été **relevées** sur le disque, sur le
> distant (`git ls-remote`) ou par l'API GitHub ; aucune n'est déduite.

---

## 1. Ce qui a été publié

| Élément | Valeur réelle |
|---|---|
| Branche | `main` |
| Commit de départ | `75b6622` « chore: bump version to 0.6.26 » |
| Commit d'épinglage | `5d1a891` « build(ci): epingler la version de Rust du depot (1.95.0) » |
| Commit de version | `c3cf34a` « chore: bump version to 0.6.27 » (= `HEAD` au tag) |
| Étiquette | `v0.6.27`, **annotée** (`cc71229` → commit `c3cf34a`), poussée |
| `origin/main` | `c3cf34a` (vérifié par `git ls-remote`) |
| `v0.6.26` | **intacte** : `e1b1e6c` → `75b6622`, ni déplacée, ni supprimée |
| Release GitHub | `v0.6.27`, `draft: false`, `prerelease: false`, publiée `2026-11-16T08:58:12Z` |
| `latest.json` | `version: 0.6.27`, `pub_date 2026-11-16T09:10:19Z` |

Contenu de la Release (assets réellement déposés) :

```
Pilot_0.6.27_x64-setup.exe       62,6 Mo   + .sig
Pilot_0.6.27_x64_en-US.msi       81,8 Mo   + .sig
Pilot_aarch64.app.tar.gz        102,1 Mo   + .sig
Pilot_x64.app.tar.gz             38,7 Mo   + .sig
Pilot_0.6.27_aarch64.dmg         99,7 Mo
Pilot_0.6.27_x64.dmg             38,4 Mo
latest.json
```

`latest.json` sert **trois** cibles, **toutes signées** :
`windows-x86_64` → `Pilot_0.6.27_x64-setup.exe` (NSIS retenu, MSI écarté),
`darwin-aarch64` → `Pilot_aarch64.app.tar.gz`, `darwin-x86_64` →
`Pilot_x64.app.tar.gz`. Le corps de la Release et les `notes` de `latest.json`
portent le changelog de `release-notes/v0.6.27.md`.

---

## 2. L'écart d'environnement Rust — traité d'abord, et c'était la cause

### 2.1 Le constat

La v0.6.26 s'était arrêtée sur l'étape **« Run Rust unit tests »** des **trois**
systèmes, deux tentatives identiques (donc pas un incident de runner), alors que
la même commande passait sur ce poste : **990 tests, 0 échec**. Le journal
détaillé de la CI n'est pas lisible depuis le poste (403 « Must have admin
rights ») : un écart d'environnement y est **indiscernable** d'un vrai défaut.

### 2.2 Ce qui différait

| | Poste (vert) | Machine de contrôle (rouge) |
|---|---|---|
| Version de Rust | `rustc 1.95.0 (59807616e 2026-04-14)` | `dtolnay/rust-toolchain@stable` = la dernière stable **du jour de l'exécution** |
| Épinglage dans le dépôt | **aucun** (`find` : aucun `rust-toolchain*`) | — |

Autrement dit, la CI ne compilait pas avec le même compilateur que le poste, et
elle changeait de compilateur toute seule d'un jour à l'autre.

### 2.3 La correction (justification en une ligne)

**Le dépôt fixe désormais la version de Rust de ce poste (1.95.0) par
`rust-toolchain.toml`, et les deux workflows passent cette même valeur à
l'action**, pour que la machine de contrôle compile avec exactement le
compilateur qui passe les 990 tests.

- `rust-toolchain.toml` (racine) : `channel = "1.95.0"` — c'est le **mécanisme
  standard de Rust** ; `rustup` le lit dans le dépôt, en local comme en CI.
- `.github/workflows/release.yml` (**4** étapes) et
  `.github/workflows/quality-gate.yml` (**2** étapes) :
  `with: toolchain: "1.95.0"`. **L'input est indispensable** : l'action fait un
  `rustup default` avec la valeur reçue, donc la seule présence du fichier ne
  suffit pas à garantir que l'action n'installe pas autre chose.
- `scripts/rust-toolchain-pin.test.js` : verrou (le canal doit être **chiffré**,
  jamais `stable`/`beta`/`nightly` ; **chaque** étape doit passer exactement ce
  canal ; 6 étapes attendues au total — en ajouter une sans l'épingler échoue).

Le verrou a été **prouvé par mutation**, deux fois :

| Mutation | Résultat attendu | Constaté |
|---|---|---|
| Retirer `with: toolchain:` d'une étape de `quality-gate.yml` | ce bloc et lui seul échoue | ✅ (« une étape … n'épingle aucune version ») |
| Passer le canal à `1.96.0` sans toucher aux workflows | divergence signalée sur les deux workflows | ✅ (« version divergente … expected '1.95.0' to be '1.96.0' ») |

Un premier jet du verrou **passait à vide** : il découpait le bloc d'étape sur
l'indentation de la ligne `uses:` (plus profonde que le tiret), si bien que le
bloc débordait sur les étapes suivantes et y lisait le `toolchain:` du voisin.
La mutation l'a démasqué ; la découpe se fait maintenant sur l'indentation du
tiret. C'est noté dans le commentaire du test pour que personne ne la « simplifie ».

### 2.4 La preuve que c'était bien la cause

Sur le run publié (`43834683723`), l'étape qui échouait **quatre fois de suite**
est passée **verte sur les trois systèmes** :

| Job | « Run Rust unit tests » |
|---|---|
| `test (ubuntu-22.04)` | ✅ success |
| `test (windows-latest)` | ✅ success |
| `test-macos` | ✅ success |
| `quality-gate` / `tests` (ubuntu-22.04) | ✅ success |
| `quality-gate` / `check-macos-whisper` (branche Apple) | ✅ success |

Aucune autre hypothèse n'a été nécessaire, et les journaux détaillés n'ont pas
eu à être lus : l'écart supprimé, la porte est devenue verte.

---

## 3. La version 0.6.27 dans les quatre fichiers

| Fichier | Avant | Après |
|---|---|---|
| `package.json` | `0.6.26` | `0.6.27` |
| `src-tauri/tauri.conf.json` | `0.6.26` | `0.6.27` |
| `src-tauri/Cargo.toml` | `0.6.26` | `0.6.27` |
| `Cargo.lock` (racine) | `0.6.26` | `0.6.27` |

**Piège du fichier de verrouillage évité** : aucun remplacement global. Le
`Cargo.lock` contient des dizaines de lignes `version = "…"` (une par
dépendance) ; la modification a ciblé le bloc
`[[package]] / name = "pilot" / version = …` par expression régulière. Contrôles
après coup :

- `grep '0.6.27' Cargo.lock` → **une seule** ligne (3409), celle du paquet
  `pilot` ;
- `git diff Cargo.lock` → **une seule ligne changée** (`+1 −1`) ;
- aucune trace de `0.6.26` ne subsiste dans les quatre fichiers.

---

## 4. Changelog utilisateur

`release-notes/v0.6.27.md` **reprend intégralement** `release-notes/v0.6.26.md`
(rien n'a été retiré) et n'ajoute qu'une chose : une note d'introduction qui
explique au lecteur pourquoi le numéro change alors que le contenu ne change
pas. Reprise vérifiée par `diff` sur le corps des deux fichiers : la **seule**
différence est le bloc ajouté.

Rien d'autre n'a été ajouté, parce que **rien d'autre n'a changé** : entre
`v0.6.26` (`75b6622`) et le commit de version, aucun changement visible pour
l'utilisateur n'est intervenu. La porte interne du changelog l'a accepté
(`hasReadableNotes` → `true`, `evaluateReleaseNotes` → `ok: true`).

---

## 5. Contrôles avant envoi

| Contrôle | Commande | Résultat réel |
|---|---|---|
| Suite front **complète** | `npm test` | **6 096 tests / 332 fichiers, 0 échec** (23,4 s) |
| Rust, commande **exacte de la CI** | `cargo test --manifest-path src-tauri/Cargo.toml --lib` | **990 passés, 0 échec, 3 ignorés** (10,5 s) |
| Rust, espace de travail complet | `cargo test --workspace` | **1 163 passés** (990 + 139 + 34), **0 échec**, 14 ignorés |
| Verrou d'épinglage | `npx vitest run scripts/rust-toolchain-pin.test.js` | 4 tests verts, **et rouges sous mutation** (cf. § 2.3) |
| Portes de publication | `npx vitest run scripts/` | 169 tests verts |
| Fabrication de l'application | `npm run tauri build -- --features whisper` | **2 paquets produits** : `Pilot_0.6.27_x64-setup.exe` (65,2 Mo) et `Pilot_0.6.27_x64_en-US.msi` (85,2 Mo) ; arrêt **uniquement** à la signature (« a public key has been found, but no private key »), la clé privée n'existant pas sur ce poste — c'est la CI qui signe |

Les 6 096 tests front incluent les 4 tests neufs du verrou d'épinglage (6 092
avant). Aucun test n'a été assoupli, sauté ni retiré.

Le binaire local contient bien le moteur d'écoute embarqué (`grep` des symboles
`ggml_backend` / `whisper_init_from_file` : 24 occurrences), la feature
`whisper` ayant été demandée à la fabrication.

---

## 6. État réel des workflows après envoi

Relevé par l'API GitHub (`/actions/runs`), jamais supposé :

| Run | Objet | État relevé |
|---|---|---|
| `quality-gate` `43834667364` | `main` @ `c3cf34a` | `tests` ✅ · `check-macos-whisper` ✅ → **succès complet** |
| `release` `43834683723` | `v0.6.27` @ `c3cf34a` | `test (ubuntu)` ✅ · `test (windows)` ✅ · `test-macos` ✅ · `create-release` ✅ · `build` Windows ✅ · `build` macOS aarch64 ✅ · `build` macOS x64 ✅ · `latest-json` ✅ · `build-linux` **en cours** au moment de ce rapport |

`build-linux` est **hors du chemin critique** (plafond 90 min, toléré à
l'échec, aucun job ne dépend de lui) : `latest-json` a déjà tourné et publié, la
mise à jour est donc servie aux utilisateurs installés **avant** que Linux ne se
termine. C'est le comportement prévu par la topologie de la chaîne.

### Une fenêtre de 12 minutes à connaître

De `08:58:12Z` (`create-release`, Release créée sans asset) à `09:10:19Z`
(`latest-json`, `latest.json` déposé), l'adresse
`releases/latest/download/latest.json` a répondu **404** : la Release la plus
récente est celle du tag, et elle n'avait pas encore d'asset. C'est **transitoire
et sans danger** (aucune version fausse n'est servie, aucune rétrogradation :
l'application vérifie et réessaie plus tard), et c'est le comportement attendu de
`create-release.js`, dont le corps est volontairement vide puis rempli par
`gen-latest-json.js`. Vérifié après coup : `latest.json` sert bien `0.6.27`.

---

## 7. Ce qui est prouvé, et ce qui ne l'est pas

**Prouvé :**
- l'écart de compilateur est supprimé, et les six étapes « Setup Rust » du dépôt
  ne peuvent plus repartir sur un canal flottant sans faire échouer un test ;
- la porte qui bloquait la 0.6.26 est verte sur les trois systèmes ;
- la Release existe, n'est ni un brouillon ni une pré-version, et contient les
  installateurs Windows, les deux paquets macOS et `latest.json` ;
- `latest.json` liste `0.6.27` avec trois cibles signées ;
- `v0.6.26` est intacte sur le distant.

**Non prouvé (dit franchement) :**
- **Aucune mise à jour n'a été installée sur une machine réelle** : le chemin
  « l'application installée voit 0.6.27 et se met à jour » n'a pas été observé,
  seulement servi correctement. C'est le geste du propriétaire.
- `build-linux` n'était pas terminé à l'heure de ce rapport : sa réussite ou son
  échec ne change rien à ce qui précède, mais il n'est pas constaté.
- Les **3 tests Rust ignorés** (`#[ignore]`, services locaux) et les **11 tests
  GDS ignorés** (base PostgreSQL via `PILOT_GDS_TEST_URL`) n'ont pas tourné.
- Le rendu à l'écran n'a pas été regardé : cette publication ne change rien à
  l'interface, la question ne se posait pas.

---

## 8. Suites

1. **Relever la version d'outillage est désormais un geste, pas un oubli** :
   changer `rust-toolchain.toml` sans changer les workflows fait **échouer**
   `scripts/rust-toolchain-pin.test.js`. La procédure de montée est écrite en
   tête du fichier (relancer tests front, tests Rust et la fabrication avant de
   tagger).
2. **Le rapport de la 0.6.26 est joint à ce commit** : il était sur le disque
   mais non versionné, et il documente l'arrêt qui a motivé l'épinglage. Il
   n'était pas à la racine et n'a pas été modifié.
3. `docs/rapports/RAPPORT-mode-dev-blocage-demarrage.md` est resté **non
   versionné et intact**, comme demandé.
