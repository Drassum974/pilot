// Tests — AUCUN RESULTAT DE DICTEE NE REVEILLE LE BAS DE L'ECRAN VOCAL
// (`spec_modes_ecran_vocal.md` § 4bis ; decisions du 2026-11-15 puis du
// 2026-11-16).
//
// DEUX DEFAUTS, DANS L'ORDRE, ET LA MEME CONCLUSION :
//  - 2026-11-15 (« la barre du bas ne s'efface plus ») : dans le gestionnaire de
//    resultat de la dictee (`rec.onresult`), `vocalWakeChrome()` etait appele a
//    CHAQUE resultat, sans regarder s'il contenait un seul mot. Or le moteur
//    emet des resultats VIDES en continu — micro arme, piece silencieuse — et
//    l'ecran Vocal arme justement la dictee AU REPOS : le decompte repartait donc
//    avant son terme, a repetition. Le reveil avait ete reserve au texte REEL ;
//  - 2026-11-16 (« la barre apparait des qu'il parle ») : ce reste de reveil
//    etait encore un declencheur d'apparition. Le proprietaire a tranche : la
//    SEULE cause d'apparition est le mouvement de souris. La dictee n'appelle
//    donc PLUS le reveil du tout, et son texte ne compte pas comme un champ
//    rempli (regle 2).
//
// CE QUE CE FICHIER EXIGE, et pourquoi il echoue si l'on revient en arriere :
//   1. BRANCHEMENT — dans le gestionnaire, ZERO appel au reveil (ni nu, ni
//      gouverne par le texte). Le chemin ne fait que rejouer la decision
//      (`vocalSyncChrome()`), et le texte ecrit par le moteur est marque comme
//      DICTE (`vocalChampDicte = true`) : la regle 2 ne le retient plus ;
//   2. CONSEQUENCE — seul `vocalWakeChrome` (et sa variante « prolonger »)
//      repose le decompte (`vocalRestartChromeTimer`), `vocalSyncChrome` n'en
//      pose JAMAIS : une transcription ne peut donc pas relancer les 10 s
//      (`VOCAL_CHROME_IDLE_MS`) ;
//   3. SORTIE — un champ vide n'interdit pas le masquage (decision PURE de
//      `vocal-chrome.js`) : le decompte arrive a son terme et le bas s'efface.
////
// Les commentaires sont en ASCII ; les chaines du source sont copiees telles
// quelles. Decoupage de source VERIFIE (`sliceSource` leve si une ancre
// disparait) : un fragment vide ne peut pas rendre une assertion vraie par
// construction.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { sliceSource } from "./source-slice.js";
import {
  VOCAL_CHROME_IDLE_MS,
  vocalChromeClass,
  vocalChromeVisible,
} from "./vocal-chrome.js";

const ICI = dirname(fileURLToPath(import.meta.url));
const SUPER = readFileSync(join(ICI, "super-agent.js"), "utf8").replace(/\r\n/g, "\n");

/** Corps d'une fonction du module (`sliceSource` LEVE si l'ancre a disparu). */
function corpsFonction(src, entete) {
  return sliceSource(src, entete, "\n  }", 2);
}

/**
 * Le gestionnaire de RESULTAT de la dictee, seul endroit qui voit le texte
 * arriver du moteur. Borne a `onerror` : la suite (erreurs, fin d'ecoute) n'a
 * rien a voir avec le reveil du bas.
 */
const GESTIONNAIRE = sliceSource(
  SUPER,
  "rec.onresult = (e) => {",
  "rec.onerror = (ev) => {",
  400,
);

/** Les lignes du gestionnaire qui appellent REELLEMENT le reveil. */
function lignesDeReveil(src) {
  return src
    .split("\n")
    .filter((ligne) => /vocalWakeChrome\s*\(/.test(ligne))
    .map((ligne) => ligne.trim());
}

// ---------------------------------------------------------------------------
describe("1. le branchement : la dictee ne reveille plus le bas", () => {
  it("un resultat VIDE comme un resultat PARLE reste sans effet sur le bas", () => {
    // Le defaut d'origine, tel qu'il etait ecrit : un appel a chaque resultat. Puis
    // sa correction du 2026-11-15, gouvernee par le texte — encore un declencheur
    // d'apparition, refuse le 2026-11-16 (« la barre apparait des qu'il parle »).
    const appels = lignesDeReveil(GESTIONNAIRE);
    expect(appels, `appels trouves : ${JSON.stringify(appels)}`).toEqual([]);
    expect(GESTIONNAIRE).not.toMatch(/(^|\n)\s*vocalWakeChrome\(\);/);
    expect(GESTIONNAIRE).not.toMatch(/transcript\.trim\(\)\) vocalWakeChrome/);
    // La variante « prolonger seulement » est elle aussi interdite ici : une
    // transcription n'est pas une frappe.
    expect(GESTIONNAIRE).not.toMatch(/vocalKeepChromeAlive\(/);
  });

  it("le chemin rejoue la decision sans toucher au decompte", () => {
    // `vocalSyncChrome` applique la classe sans jamais reposer de minuteur (voir
    // le bloc 2) : le decompte en cours continue sa route, il ne repart pas.
    expect(GESTIONNAIRE).toMatch(/vocalSyncChrome\(\);/);
    // Le commentaire du correctif est toujours la : il porte la cause, pas une
    // seconde logique.
    expect(GESTIONNAIRE).toMatch(/CORRECTIF « la barre du bas ne s'efface plus »/);
  });

  it("le texte pose par le moteur est marque DICTE, apres l'ecriture du champ", () => {
    // L'ordre compte : le drapeau se pose sur le texte qui vient d'etre ecrit
    // (sinon la regle 2 pourrait lire l'ancien etat du champ). Ce point est celui
    // du test du masque, verifie ici sur le meme fragment pour que ce fichier
    // tienne seul.
    const iEcriture = GESTIONNAIRE.indexOf("inputEl.value = preText + sep + transcript;");
    const iResize = GESTIONNAIRE.indexOf("resizeInput();", iEcriture);
    const iDrapeau = GESTIONNAIRE.indexOf("vocalChampDicte = true;");
    expect(iEcriture).toBeGreaterThan(-1);
    expect(iResize).toBeGreaterThan(iEcriture);
    expect(iDrapeau).toBeGreaterThan(iResize);
  });

  it("aucun AUTRE chemin de la dictee ne reveille le bas", () => {
    // Tout le demarrage de la dictee : le bouton 🎙️ et l'armement automatique y
    // passent. Un appel (dans `onstart`, `onend`, une reprise de session)
    // rallumerait le bas sans qu'on le voie.
    const session = sliceSource(SUPER, "function startVoiceInput(", "function immersiveAssistantName(", 400);
    expect(lignesDeReveil(session)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe("2. la consequence : seul le reveil repose les 10 s", () => {
  it("`vocalWakeChrome` remet le decompte a zero", () => {
    const corps = corpsFonction(SUPER, "function vocalWakeChrome(");
    expect(corps).toMatch(/vocalRestartChromeTimer\(\)/);
    expect(corps).toMatch(/vocalSyncChrome\(\)/);
  });

  it("`vocalSyncChrome` ne pose JAMAIS de minuteur (il ne peut donc pas relancer le delai)", () => {
    const corps = corpsFonction(SUPER, "function vocalSyncChrome(");
    expect(corps).not.toMatch(/vocalRestartChromeTimer/);
    expect(corps).not.toMatch(/setTimeout/);
    // Il ne fait que lire les faits, trancher et ecrire la classe.
    expect(corps).toMatch(/vocalChromeVisible\(faits\)/);
    expect(corps).toMatch(/vocalChromeClass\(visible\)/);
  });

  it("le delai protege reste 10 000 ms, dans une seule constante", () => {
    // Un decompte plus long (ou plus court) changerait la promesse du §4bis et
    // masquerait le defaut au lieu de le corriger.
    expect(VOCAL_CHROME_IDLE_MS).toBe(10_000);
  });
});

// ---------------------------------------------------------------------------
describe("3. la sortie : un champ vide laisse le bas s'effacer", () => {
  it("au repos, champ VIDE, rien ne retient le bas (donc le decompte aboutit)", () => {
    // Etat de l'ecran Vocal APRES un resultat vide : le texte n'a pas change
    // (le champ est vide), le micro est ouvert, aucune question, pointeur
    // ailleurs. C'est exactement le cas ou le bas doit s'effacer.
    expect(
      vocalChromeVisible({
        saisie: false,
        micFerme: "",
        pointeurActif: false,
        pointeurGeste: false,
        question: false,
      }),
    ).toBe(false);
    // Et la classe posee est bien celle de l'effacement.
    expect(vocalChromeClass(false)).toBe("vocal-chrome-hidden");
  });

  it("des que le champ CONTIENT le mot, le bas revient (l'autre sens de la regle)", () => {
    // Meme diction de decision, uniquement le fait `saisie` qui change : c'est
    // la preuve que le correctif distingue le resultat VIDE du resultat PARLE,
    // et non qu'il a supprime le reveil.
    expect(vocalChromeVisible({ saisie: true })).toBe(true);
    expect(vocalChromeClass(true)).toBe("");
  });
});
