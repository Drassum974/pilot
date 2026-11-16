// VERROU DE L'ÉPINGLAGE DE RUST (v0.6.27, décision du 2026-11-16).
//
// Ce qui était ouvert : le dépôt ne fixait AUCUNE version de Rust. Les cinq
// étapes « Setup Rust » des deux workflows utilisaient `dtolnay/rust-toolchain@stable`,
// donc la dernière stable du jour de l'exécution. La v0.6.26 s'est arrêtée sur
// l'étape « Run Rust unit tests » des TROIS systèmes alors que la même commande
// passait sur le poste (990 tests, rustc 1.95.0), et le journal de la CI n'est
// pas lisible depuis le poste (403 « Must have admin rights »). Un écart
// d'environnement y est indiscernable d'un vrai défaut : la seule façon de
// sortir de l'ignorance est de SUPPRIMER l'écart.
//
// Ce fichier vérifie trois choses :
//   1. `rust-toolchain.toml` existe à la racine et donne un canal EXPLICITE
//      (jamais `stable` : un canal flottant ne fige rien) ;
//   2. chaque étape « Setup Rust » des deux workflows passe EXACTEMENT cette
//      version à l'action (`with: toolchain:`), pour que l'installation ET la
//      sélection soient identiques — l'action fait `rustup default`, donc
//      l'omettre reviendrait à ne rien épingler ;
//   3. aucune étape ne revient à un `@stable` nu, ni à une version divergente.
//
// Preuve par mutation : retirer `with: toolchain:` d'une étape de `release.yml`,
// ou changer la version dans `rust-toolchain.toml` sans toucher aux workflows,
// fait échouer ce bloc — et lui seul.
//
// La lecture normalise les fins de ligne (worktree CRLF) :
// cf. `.pi/skills/quality-gate/SKILL.md` § 3.4.

import { existsSync, readFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const RACINE = resolve(HERE, "..");
const WORKFLOWS = resolve(RACINE, ".github/workflows");

/** Lit un fichier en normalisant les fins de ligne (piège CRLF). */
function lire(chemin) {
  return readFileSync(chemin, "utf8").replace(/\r\n/g, "\n");
}

/**
 * Canal épinglé lu dans `rust-toolchain.toml` : la première ligne
 * `channel = "…"` hors commentaire. Rend "" si le fichier manque ou si aucune
 * ligne n'est trouvée (le test échoue alors explicitement, jamais en silence).
 */
function canalEpingles() {
  const chemin = resolve(RACINE, "rust-toolchain.toml");
  if (!existsSync(chemin)) return "";
  for (const ligne of lire(chemin).split("\n")) {
    const sansCommentaire = ligne.replace(/(^|\s)#.*$/, "$1");
    const m = /^\s*channel\s*=\s*"([^"]+)"\s*$/.exec(sansCommentaire);
    if (m) return m[1];
  }
  return "";
}

/**
 * Étapes « Setup Rust » d'un workflow, telles qu'écrites.
 *
 * Découpage par INDENTATION du tiret : une étape de `steps:` commence par une
 * ligne `<indent>- `, et court jusqu'à la prochaine ligne `<indent>- ` de MÊME
 * indentation. Prendre l'indentation de la ligne `uses:` (plus profonde que le
 * tiret) ne découpe rien et fait déborder le bloc sur toutes les étapes
 * suivantes — au point de lire le `toolchain:` du voisin et de rendre
 * l'assertion vraie à vide (défaut constaté par mutation avant livraison).
 *
 * On rend le texte de chaque étape qui contient `dtolnay/rust-toolchain` ;
 * `with:` est lu par expression régulière (aucun parseur YAML n'est une
 * dépendance du projet, et le format d'une étape est stable).
 */
function etapesRust(nomFichier) {
  const chemin = resolve(WORKFLOWS, nomFichier);
  expect(existsSync(chemin), `${nomFichier} doit exister`).toBe(true);
  const lignes = lire(chemin).split("\n");
  const blocs = [];
  let courant = null;
  let indentation = -1;
  for (const ligne of lignes) {
    const m = /^(\s*)- /.exec(ligne);
    if (m) {
      // Nouvelle étape : on solde la précédente.
      if (courant) blocs.push(courant.join("\n"));
      courant = [ligne];
      indentation = m[1].length;
      continue;
    }
    // Une ligne moins indentée que le tiret ferme le bloc `steps:`.
    if (courant && ligne.trim() !== "") {
      const profondeur = /^(\s*)/.exec(ligne)[1].length;
      if (profondeur <= indentation) {
        blocs.push(courant.join("\n"));
        courant = null;
        indentation = -1;
        continue;
      }
    }
    if (courant) courant.push(ligne);
  }
  if (courant) blocs.push(courant.join("\n"));
  return blocs.filter((b) => b.includes("dtolnay/rust-toolchain"));
}

/** Version passée à l'action dans un bloc d'étape (`toolchain: "x"`), ou "". */
function versionPassee(bloc) {
  const m = /^\s*toolchain:\s*"?([^"\n]+?)"?\s*$/m.exec(bloc);
  return m ? m[1].trim() : "";
}

const VERSION = canalEpingles();

describe("épingle de la version de Rust", () => {
  it("rust-toolchain.toml existe et fixe un canal explicite, jamais flottant", () => {
    expect(VERSION, "rust-toolchain.toml manquant ou sans canal lisible").not.toBe("");
    // Un canal flottant (`stable`, `beta`, `nightly`) ne fige rien : c'est
    // exactement la situation qui a bloqué la v0.6.26.
    expect(["stable", "beta", "nightly"]).not.toContain(VERSION);
    // Une version chiffrée complète : majeure.mineure.correctif.
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  for (const fichier of ["release.yml", "quality-gate.yml"]) {
    it(`${fichier} : chaque Setup Rust passe la version épinglée, aucune étape nue`, () => {
      const blocs = etapesRust(fichier);
      // Les workflows ont 4 et 2 étapes : un bloc vide signifierait que la
      // lecture n'a rien trouvé, et les assertions suivantes passeraient à vide.
      expect(blocs.length).toBeGreaterThan(0);
      for (const bloc of blocs) {
        const version = versionPassee(bloc);
        expect(
          version,
          `une étape « Setup Rust » de ${fichier} n'épingle aucune version (elle installerait la stable du jour) :\n${bloc}`
        ).not.toBe("");
        expect(version, `version divergente de rust-toolchain.toml dans ${fichier}`).toBe(
          VERSION
        );
      }
    });
  }

  it("les deux workflows épinglent la même version, sur toutes leurs étapes", () => {
    const total =
      etapesRust("release.yml").length + etapesRust("quality-gate.yml").length;
    // 4 étapes dans release.yml (test, test-macos, build, build-linux) et
    // 2 dans quality-gate.yml (tests, check-macos-whisper) : en ajouter une
    // sans l'épingler serait une régression silencieuse.
    expect(total).toBe(6);
  });
});
