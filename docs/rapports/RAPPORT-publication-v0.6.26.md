# Rapport de publication — Pilot v0.6.26

- **Date** : 2026-11-16 (heure locale du poste).
- **Demande** : publier une nouvelle version de Pilot (procédure `AGENTS.md`
  § « Publication des versions »), jusqu'au tag poussé et à la mise à jour
  proposée aux utilisateurs installés.
- **Version choisie** : **0.6.26** (incrément de correction après 0.6.25 —
  dernier tag existant, commit `3db8721`, vérifié sur le distant avant de
  choisir le numéro ; aucun numéro n'a été deviné).
- **Tag** : **`v0.6.26`**, annoté (`e1b1e6c`), pointant le commit
  **`75b6622`** — poussé et **vérifié sur le distant**.
- **Commit de bump + changelog** : **`75b6622`** (« chore: bump version to
  0.6.26 »), poussé sur `main` (`refs/heads/main` = `75b6622` sur le distant).

---

## 1. État net — ce qui est publié, et ce qui ne l'est pas

| Question | Réponse |
|---|---|
| Le tag `v0.6.26` est-il sur GitHub ? | **Oui** (`refs/tags/v0.6.26` → `e1b1e6c`, pointé `75b6622`). |
| La **Release** `v0.6.26` existe-t-elle ? | **Non.** L'API répond `404` sur `releases/tags/v0.6.26`. |
| Un installateur a-t-il été publié ? | **Non.** Le job `build` a été **sauté** (`create-release` n'a jamais tourné). |
| `latest.json` a-t-il été mis à jour ? | **Non** (le job `latest-json` a échoué **avant** toute écriture). |
| Que voient les utilisateurs installés ? | **Rien de nouveau** : la dernière Release publiée reste **v0.6.25** (12/11/2026). Aucune mise à jour ne leur sera proposée. |
| Une autorisation de secours a-t-elle été forcée ? | **Non** : aucun `ALLOW_*` posé, rien n'a été poussé en force. |

**En une phrase** : la version est *étiquetée* mais **non publiée** ; la chaîne
s'est arrêtée d'elle-même sur un test rouge, ce qui est exactement le
comportement attendu — **rien n'est parti chez les utilisateurs**.

---

## 2. Ce qui a été fait, dans l'ordre

1. **Lecture de l'état réel du disque** (jamais de version devinée) : branche
   `main`, `HEAD` = `525ca59`, dernier tag `v0.6.25` (`3db8721`), 8 commits
   depuis, `origin/main` en retard de 7 commits.
2. **Contrôle GDS d'abord** : `.pilot/gds.json` → `"enabled": false`,
   `server_url` vide, `.pilot/` non versionné ⇒ **projet non porté par GDS**,
   la publication GitHub est donc autorisée.
3. **Changelog utilisateur** `release-notes/v0.6.26.md` rédigé en français,
   par catégories, sans jargon ni nom de fichier, **incluant les corrections
   antérieures non publiées** (verrou de run, PocketTTS, mode dev, barre du
   bas du mode Vocal, règles communes).
4. **Bump identique dans les quatre fichiers** : `package.json`,
   `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, `Cargo.lock` (ciblé sur
   le paquet `pilot` — **une seule** occurrence de `0.6.26` vérifiée dans
   `Cargo.lock`, plus aucune trace de `0.6.25`). `Cargo.toml` racine = workspace,
   sans version : normal.
5. **Quality-gate local complet AVANT tout envoi** (§ 3 ci-dessous) : tout vert.
6. **Commit** `75b6622` (5 fichiers), arbre propre.
7. **Fabrication locale** (Windows, feature `whisper`) : paquets produits
   (§ 4), arrêt **uniquement** à la signature (clé privée non posée sur ce
   poste — c'est la CI qui signe).
8. **`git push origin main`** puis **`git tag -a v0.6.26`** et
   **`git push origin v0.6.26`**, puis **vérification sur le distant**
   (`git ls-remote`) : `main` et le tag sont identiques au local.
9. **Surveillance de la chaîne de publication** : run `release` n° `190`
   (`43809251062`) et run `quality-gate` (`43809241214`). **Les deux sont
   rouges sur l'étape « Run Rust unit tests »** ⇒ arrêt de la publication
   (§ 5), aucun contournement.

---

## 3. Contrôles locaux mesurés (avant envoi)

| Contrôle | Commande | Résultat |
|---|---|---|
| Front | `npm test` | **331 fichiers, 6 092 tests passés**, 0 échec |
| Rust, espace de travail | `cargo test --workspace` | **exit 0 — 1 163 passés, 14 ignorés** (6 suites) |
| Rust, desktop + oreille intégrée | `cargo test --manifest-path src-tauri/Cargo.toml --features whisper --lib` | **exit 0 — 991 passés, 3 ignorés** |
| Rust, commande **exacte** de la CI | `cargo test --manifest-path src-tauri/Cargo.toml --lib` | **exit 0 — 990 passés, 3 ignorés** |

Aucun test rouge, aucune réserve : les trois portes sont franchies.

---

## 4. Fabrication locale (preuve que le code fabrique)

`npm run tauri build -- --features whisper` :

- `vite build` : OK ;
- `target/release/pilot.exe` — 51 615 232 o ;
- `target/release/bundle/nsis/Pilot_0.6.26_x64-setup.exe` — 68 347 109 o
  (`sha256 419c20cf…efc29c`) ;
- `target/release/bundle/msi/Pilot_0.6.26_x64_en-US.msi` — 89 391 104 o
  (`sha256 ded3c4eb…09ce5b0`) ;
- le binaire contient bien le moteur d'écoute intégré (symboles `whisper_*` et
  `ggml_backend*` présents) ;
- **arrêt attendu à la signature** : « A public key has been found, but no
  private key… `TAURI_SIGNING_PRIVATE_KEY` ». Même condition qu'en 0.6.25 : la
  signature est faite par la CI, jamais sur le poste ; aucune conséquence sur
  la livraison.

---

## 5. Le point d'arrêt : la CI est rouge sur les tests Rust

### 5.1 Ce que montrent les deux runs

| Run | Job | Étape en échec | Durée de l'étape |
|---|---|---|---|
| `release` `43809251062` | `test (windows-latest)` | **Run Rust unit tests** | 2 min 36 |
| `release` `43809251062` | `test (ubuntu-22.04)` | **Run Rust unit tests** | 1 min 55 |
| `release` `43809251062` | `test-macos` | **Run Rust unit tests** | 2 min 03 |
| `quality-gate` `43809241214` | `tests` | **Run Rust unit tests** | 1 min 46 |

Conséquence en cascade, conforme aux verrous : `create-release` **sauté**,
`build` **sauté**, `build-linux` **sauté**, `latest-json` et
`latest-json-linux` **échoués sur leur garde** (ils exigent un verdict de
tests favorable). `check-macos-whisper` est rouge aussi, mais il est **toléré**
et hors chaîne critique — ce n'est pas lui qui arrête la publication.

Pour comparaison : la même étape, même workflow, passait le **12/11/2026** sur
`6d57ddd` (ubuntu 3 min 32, macOS 2 min 25, Windows 4 min 56).

### 5.2 Ce que l'API publique ne donne pas

Le journal des étapes exige des droits d'administration :
`GET /actions/jobs/<id>/logs` → **403 « Must have admin rights to
Repository »** (dépôt public, mais l'accès au journal ne l'est pas).
`gh` n'est pas installé sur ce poste, aucun jeton n'est disponible ici. Les
*annotations* du run ne contiennent qu'un avertissement (« Node.js 20 is
deprecated »), **pas** l'erreur réelle.

⇒ **La cause exacte n'est pas lisible depuis ce poste.** Elle est lisible par
vous, en une minute, sur la page du run (lien au § 7).

### 5.3 Ce que j'ai essayé pour la retrouver (et qui est vert)

| Reproduction | Résultat |
|---|---|
| Commande exacte de la CI, dans le dépôt | **990 passés, exit 0** |
| **Copie propre** du commit `75b6622` (`git worktree`, uniquement les fichiers versionnés) + `pilot-mcp-client.ts` régénéré + **répertoire de compilation séparé** (compilation réelle, pas de cache) | **990 passés, exit 0** |
| Environnement de CI simulé (`TZ=UTC CI=true GITHUB_ACTIONS=true`) | **990 passés, exit 0** |
| Dossier personnel **vidé** (`USERPROFILE`/`HOME`/`APPDATA`/`LOCALAPPDATA` → dossier vide, binaire de test lancé directement) | **990 passés, exit 0** |

Autrement dit : **le code versionné passe les tests Rust sur une copie propre
de ce poste**. Ce qui reste différent en CI est donc l'**environnement du
runner** (version de `rustc` installée par `dtolnay/rust-toolchain@stable`, qui
n'est pas épinglée dans le dépôt ; image du runner ; espace disque), **pas** le
contenu du tag.

Hypothèses, de la plus probable à la moins probable :

1. **Nouvelle version stable de `rustc` sur les runners** (le dépôt n'épingle
   aucune version) : code ou test refusé au profit d'une règle plus récente.
   C'est la seule variable que ce poste ne peut pas reproduire (`rustc 1.95.0`
   ici).
2. **Test dépendant du temps ou d'une ressource du runner** (délai court,
   commande externe, port) qui devient rouge sur une machine plus lente ou plus
   contrainte — les quatre exécutions ont échoué en ~2 min, ce qui peut
   correspondre à une compilation suivie de tests très courts.
3. **Incident de runners GitHub** au moment du run (les quatre jobs ont
   démarré dans la même minute).

Aucune de ces hypothèses n'autorise à publier : une porte rouge arrête la
chaîne, et c'est ce qui s'est produit.

---

## 6. Ce que les utilisateurs voient aujourd'hui

**Rien de nouveau, et c'est le comportement voulu.** `latest.json` n'a pas été
réécrit, aucune Release `v0.6.26` n'existe : la vérification de mise à jour des
applications installées continue de proposer **0.6.25** (dernière Release
publiée, 12/11/2026). Les deux correctifs et les deux nouveautés embarqués dans
le tag `v0.6.26` **n'atteindront personne** tant qu'une publication n'aura pas
abouti.

---

## 7. Ce qu'il reste à faire (votre décision)

**Option A — relancer la chaîne sur le MÊME tag (la moins coûteuse, et elle est
permise).** Aucune Release n'existe pour `v0.6.26`, donc `create-release` peut
encore s'exécuter : rien à « dé-publier », aucun tag à recréer. Sur
<https://github.com/pleveneur/pilot/actions/runs/43809251062> (et
`43809241214` pour le quality-gate) → bouton **« Re-run failed jobs »**. Si
l'hypothèse 3 est la bonne, la publication repart seule jusqu'à `latest.json`.

**Option B — lire le journal, puis corriger.** Ouvrir le run, job
`test (ubuntu-22.04)` → étape **« Run Rust unit tests »**, et copier la ligne
d'erreur (le nom du test et son message, ou l'erreur de compilation). Avec
cette ligne, le correctif est immédiat — puis **nouvelle version 0.6.27**
(jamais republier un tag existant ; `v0.6.26` reste le tag d'une tentative
avortée, sans Release).

Deux points restent ouverts, indépendamment de la CI :

- **macOS** : aucun installateur macOS n'est produit sur ce poste. À la
  publication, la règle reste celle du dépôt — `detect-macos-gap.js` constate
  l'absence sur les fichiers réellement déposés et **annonce** la livraison
  incomplète (Windows seul) ; jamais de silence.
- **Clé de signature** : le poste n'a pas `TAURI_SIGNING_PRIVATE_KEY` (c'est
  normal, elle vit dans les secrets GitHub). C'est pourquoi la fabrication
  locale s'arrête à la signature ; la CI signe.

---

## 8. Ce que vous devez vérifier vous-même

1. **La page du run rouge** (lien au § 7) et **la ligne d'erreur** de l'étape
   « Run Rust unit tests » — c'est la seule information que ce poste ne peut
   pas lire.
2. **Qu'aucune Release 0.6.26 n'existe** :
   <https://github.com/pleveneur/pilot/releases> doit s'arrêter à `v0.6.25`.
3. **Que les applications installées ne proposent rien** : ouvrir Pilot, laisser
   passer la vérification de mise à jour → doit rester en 0.6.25.
4. **Le texte du changelog** `release-notes/v0.6.26.md` (il partira tel quel
   dans la Release et dans la modale de mise à jour dès que la publication
   aboutira) : relire les quatre corrections et les deux nouveautés.
5. **Le contenu du tag** : `git show --stat v0.6.26` doit montrer
   `75b6622` et 5 fichiers (les quatre versions + le changelog).

---

## 9. Fichiers touchés par cette session

| Fichier | Nature |
|---|---|
| `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, `Cargo.lock` | version `0.6.26` (aucun autre changement) |
| `release-notes/v0.6.26.md` | **nouveau** — changelog utilisateur |
| `docs/rapports/RAPPORT-publication-v0.6.26.md` | **nouveau** — ce rapport |

**Laissé intact** : `docs/rapports/RAPPORT-mode-dev-blocage-demarrage.md`
(fichier non versionné déjà présent), les deux fichiers des correctifs validés
(`src/js/verrou-de-run.js`, `src/js/pocket-voice.js`), et tout fichier
partagé/serveur (`gds-core`, `gds-server`).
