// Verrou du lot B, trou C7.6 : CONTROLE AUTOMATIQUE DES PROPOSITIONS DE
// MODIFICATION ET DE LA BRANCHE PRINCIPALE
// (docs/rapports/RAPPORT-voies-de-contournement-livraison.md).
//
// Ce qui etait ouvert : aucun enchainement ne tournait sur une proposition de
// modification ni sur une poussee vers `main` (seuls `release.yml` sur etiquette
// `v*` et une image GDS manuelle existaient). Une suite rouge pouvait donc
// rester sur la branche principale jusqu'au tag — donc jusqu'aux utilisateurs
// installes.
//
// Ce fichier verifie quatre choses, dans cet ordre :
//   1. le controle EXISTE et se declenche sur les propositions ET sur `main` ;
//   2. il ECHOUE quand les tests echouent (aucun `continue-on-error` sur le job
//      de tests, aucune etape conditionnee) ;
//   3. il ne peut RIEN publier (aucune permission d'ecriture, aucun secret, et
//      la topologie de `release.yml` reste intacte) ;
//   4. le controle de compilation de la branche APPLE du moteur d'ecoute
//      (`check-macos-whisper`) existe, est le SEUL job tolerant a l'echec, ne
//      lance aucun test et depose TOUJOURS son journal en artefact (decision du
//      2026-11-16, `docs/rapports/RAPPORT-oreille-integree-macos-confinement.md`).
//
// Preuve par mutation : ajouter `continue-on-error: true` dans ce fichier, ou
// retirer le declencheur `pull_request`, fait echouer ce bloc — et lui seul.
//
// La lecture normalise les fins de ligne (worktree CRLF) :
// cf. `.pi/skills/quality-gate/SKILL.md` § 3.4.

import { existsSync, readFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";
// Découpage de source VÉRIFIÉ (ancre absente = échec bruyant, jamais un
// fragment vide qui rendrait une assertion négative vraie par construction) :
// `src/js/source-slice.js`, imposé par l'inventaire de `source-slice.test.js`.
import { sliceFrom } from "../src/js/source-slice.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = resolve(HERE, "../.github/workflows");

/** Lit un workflow en normalisant les fins de ligne (piege CRLF). */
function lire(name) {
  return readFileSync(resolve(DIR, name), "utf8").replace(/\r\n/g, "\n");
}

/** Le code sans les commentaires : la prose ne doit pas satisfaire un verrou. */
function sansCommentaires(src) {
  return src
    .split("\n")
    .map((l) => l.replace(/(^|\s)#.*$/, "$1"))
    .join("\n");
}

const QG_FILE = "quality-gate.yml";
const QG = existsSync(resolve(DIR, QG_FILE)) ? lire(QG_FILE) : "";
const QG_CODE = sansCommentaires(QG);

/**
 * Bloc YAML d'un job (meme lecture que `scripts/release-workflow.test.js`) : de
 * «   <nom>: » jusqu'au prochain en-tete de job. Rend "" si le job n'existe pas.
 */
function blocJob(nom) {
  const lignes = QG.split("\n");
  const debut = lignes.findIndex((l) => l === `  ${nom}:`);
  if (debut === -1) return "";
  const sortie = [];
  for (let i = debut + 1; i < lignes.length; i++) {
    if (/^ {2}[a-z][a-z0-9-]*:\s*$/.test(lignes[i])) break;
    sortie.push(lignes[i]);
  }
  return sortie.join("\n");
}

describe("quality-gate.yml — le controle existe et se declenche au bon endroit", () => {
  it("le workflow existe", () => {
    expect(QG, `${QG_FILE} doit exister`).not.toBe("");
  });

  it("il tourne sur les propositions de modification", () => {
    expect(QG_CODE).toMatch(/^on:/m);
    // Forme courte (`pull_request:`) ou longue (`pull_request:` + cles).
    expect(QG_CODE).toMatch(/^\s{2}pull_request:\s*$/m);
  });

  it("il tourne sur les poussees vers la branche principale", () => {
    expect(QG_CODE).toMatch(/^\s{2}push:\s*$/m);
    expect(QG_CODE).toMatch(/^\s{4}branches:\s*$/m);
    expect(QG_CODE).toMatch(/^\s{6}-\s*main\s*$/m);
  });

  it("il lance les DEUX suites (front et Rust), pas seulement une", () => {
    // Une seule des deux suites laisserait la moitie du code sans controle.
    expect(QG_CODE).toContain("npm test");
    expect(QG_CODE).toMatch(/cargo test[^\n]*src-tauri\/Cargo\.toml[^\n]*--lib/);
  });
});

describe("quality-gate.yml — un test rouge fait echouer la proposition", () => {
  it("le job de tests n'est jamais rendu optionnel", () => {
    // C'est LE point du verrou : un « continue-on-error » sur le job de tests
    // transformerait le controle en decoration verte. Le seul job autorise a
    // etre tolerant est celui de compilation macOS, decrit plus bas (il ne
    // lance aucun test).
    const tests = sansCommentaires(blocJob("tests"));
    expect(tests).not.toBe("");
    expect(tests).not.toContain("continue-on-error");
  });

  it("aucune etape du job de tests n'est conditionnee", () => {
    const tests = sansCommentaires(blocJob("tests"));
    const lignes = tests.split("\n");
    for (let i = 0; i < lignes.length; i++) {
      const l = lignes[i];
      if (!/^\s*run:/.test(l)) continue;
      const suite = `${l} ${lignes[i + 1] || ""}`;
      if (!/npm test|cargo test/.test(suite)) continue;
      // Remonter jusqu'a l'en-tete de l'etape et verifier qu'aucun `if:` ne
      // l'entoure (une etape conditionnee ne s'execute pas toujours).
      for (let j = i - 1; j >= 0; j--) {
        if (/^\s{6}- /.test(lignes[j]) || /^\s{6}- name:/.test(lignes[j])) break;
        expect(lignes[j], `etape conditionnee ligne ${j + 1}`).not.toMatch(/^\s+if:/);
      }
    }
  });

  it("le job de tests n'est pas rendu optionnel par un plafond de duree nul", () => {
    const m = blocJob("tests").match(/timeout-minutes:\s*(\d+)/);
    expect(m).not.toBeNull();
    expect(Number(m[1])).toBeGreaterThan(0);
  });
});

describe("quality-gate.yml — il ne peut RIEN publier", () => {
  it("aucune permission d'ecriture", () => {
    expect(QG_CODE).toContain("permissions:");
    const bloc = sliceFrom(QG_CODE, "permissions:");
    expect(bloc).toContain("contents: read");
    expect(QG_CODE).not.toMatch(/contents:\s*write/);
  });

  it("aucun secret de publication, aucune release, aucun tag", () => {
    expect(QG_CODE).not.toContain("TAURI_SIGNING_PRIVATE_KEY");
    expect(QG_CODE).not.toContain("secrets.");
    expect(QG_CODE).not.toMatch(/tauri-action/);
    expect(QG_CODE).not.toMatch(/gh release|create-release\.js|gen-latest-json\.js/);
    expect(QG_CODE).not.toMatch(/git tag|git push/);
  });

  it("la topologie de release.yml reste intacte", () => {
    const release = sansCommentaires(lire("release.yml"));
    // Ce nouveau fichier ne doit ni remplacer ni modifier la chaine de
    // publication : elle reste decrite a un seul endroit.
    expect(release).toContain("scripts/create-release.js");
    expect(release).toMatch(/latest-json:[\s\S]{0,400}?needs:\s*build/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Le controle de la branche APPLE du moteur d'ecoute (decision du 2026-11-16,
// `docs/rapports/RAPPORT-oreille-integree-macos-confinement.md`).
//
// Contexte : la feature `whisper` est desormais CONFINEE A WINDOWS dans la
// fabrication de publication (`release.yml`), parce que les deux fabrications
// macOS de la 0.6.25 ont echoue dessus — la branche Apple de `whisper.cpp`
// (Accelerate, BLAS Apple, noyaux ILP64) n'avait jamais ete compilee, aucun job
// ne la compilait, et le journal de l'echec etait inaccessible.
//
// Consequence a empecher : que le confinement devienne un angle mort (plus
// jamais compile avant le jour de la publication). Ce job la compile donc a
// chaque proposition et a chaque poussee sur `main`, sans installateur ni
// signature, et depose son journal.
// ───────────────────────────────────────────────────────────────────────────
describe("quality-gate.yml — la branche Apple du moteur d'ecoute est compilee", () => {
  const CHECK = blocJob("check-macos-whisper");

  it("le job existe, sur une machine Apple", () => {
    expect(CHECK, "job `check-macos-whisper` absent").not.toBe("");
    expect(CHECK).toContain("runs-on: macos-latest");
  });

  it("il compile la MEME feature que la publication", () => {
    expect(CHECK).toContain("--features whisper");
    // Meme caisse que la publication (manifeste du bureau), profil release.
    expect(CHECK).toMatch(/cargo build[^\n]*src-tauri\/Cargo\.toml/);
    expect(CHECK).toContain("--release");
    // Le bundle MCP est un prerequis de compilation (include_str!), pas un test.
    expect(CHECK).toContain("npm run build:mcp");
  });

  it("il ne fabrique rien, ne signe rien, ne lance aucun test", () => {
    // Un installateur ou une signature n'ont rien a faire dans un controle.
    expect(CHECK).not.toContain("tauri-action");
    expect(CHECK).not.toContain("TAURI_SIGNING_PRIVATE_KEY");
    // Les suites restent dans le job `tests` : leur verdict est le seul qui
    // compte, et un echec ici ne doit jamais masquer un test rouge.
    expect(CHECK).not.toMatch(/npm test/);
    expect(CHECK).not.toMatch(/cargo test/);
  });

  it("il est TOLERANT a l'echec, et c'est le SEUL job qui l'est", () => {
    expect(CHECK).toContain("continue-on-error: true");
    // Aucun autre job du fichier ne porte ce drapeau.
    const autres = QG_CODE.split("\n")
      .filter((l) => /continue-on-error/.test(l))
      .length;
    expect(autres).toBe(1);
    // Un plafond de duree existe (pas de job suspendu indefiniment).
    const m = CHECK.match(/timeout-minutes:\s*(\d+)/);
    expect(m).not.toBeNull();
    expect(Number(m[1])).toBeGreaterThanOrEqual(30);
  });

  it("le journal est TOUJOURS depose en artefact", () => {
    // C'est la raison d'etre du job : le prochain echec donne le texte exact du
    // compilateur au lieu d'une supposition.
    expect(CHECK).toContain("actions/upload-artifact@");
    expect(CHECK).toContain("whisper-macos-build.log");
    // La ligne `if: always()` precede le depot : sans elle, un echec n'aurait
    // aucun journal.
    expect(CHECK).toMatch(/if:\s*always\(\)[\s\S]{0,200}upload-artifact/);
    // Le journal est ecrit par le tee de la compilation elle-meme.
    expect(CHECK).toMatch(/tee\s+whisper-macos-build\.log/);
  });
});
