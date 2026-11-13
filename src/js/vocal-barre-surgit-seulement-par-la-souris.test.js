// Tests — LA BARRE DU BAS NE SURGIT QUE PAR LA SOURIS
// (`spec_modes_ecran_vocal.md` § 4bis ; decision du proprietaire du 2026-11-16).
//
// LA REGLE VOULUE, mot pour mot :
//   - au repos, la barre est INVISIBLE ;
//   - elle APPARAIT uniquement sur un geste de SOURIS (mouvement, clic, molette) ;
//   - elle redisparait seule apres un delai d'inactivite (ni souris, ni frappe) ;
//   - elle ne doit JAMAIS apparaitre a cause de la parole : ni le micro qui capte,
//     ni l'assistant qui parle, ni un changement d'etat (ecoute, veille, reveil,
//     transcription en cours).
//
// LE DEFAUT CONSTATÉ : la barre apparaissait aussi des que le proprietaire
// parlait. Trois chemins la rallumaient, tous supprimes ici :
//   a) `rec.onresult` (transcription) appelait le reveil des qu'un texte arrivait ;
//   b) `vocalBargeIn` (voix par-dessus la lecture) appelait aussi le reveil ;
//   c) la regle 2 « champ rempli » comptait le texte ecrit par la DICTEE.
//
// CE QUE CE FICHIER EMPECHE (chaque test echoue si le defaut revient) :
//   1. un `vocalWakeChrome()` ajoute ailleurs que dans les trois gestes de souris ;
//   2. un chemin de parole qui appelle le reveil (ou sa variante « prolonger ») ;
//   3. une touche qui ALLUME le bas au lieu de le prolonger ;
//   4. un texte dicte qui retient le bas par la regle 2 ;
//   5. un delai d'inactivite qui ne serait plus de 10 000 ms, ou un minuteur pose
//      a l'entree du mode (le bas doit etre efface d'emblee).
//
// Les commentaires sont en ASCII ; les chaines du source sont copiees telles
// quelles. Decoupage de source VERIFIE (`sliceSource` leve si une ancre
// disparait) : un fragment vide ne peut pas rendre une assertion vraie par
// construction.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sliceSource } from "./source-slice.js";
import {
  VOCAL_CHROME_HIDDEN_CLASS,
  VOCAL_CHROME_IDLE_MS,
  vocalChromeClass,
  vocalChromeMoved,
  vocalChromeWakeKey,
  vocalChromeVisible,
} from "./vocal-chrome.js";

const ICI = dirname(fileURLToPath(import.meta.url));
const SUPER = readFileSync(join(ICI, "super-agent.js"), "utf8").replace(/\r\n/g, "\n");

/** Corps d'une fonction du module (`sliceSource` LEVE si l'ancre a disparu). */
function corpsFonction(src, entete) {
  return sliceSource(src, entete, "\n  }", 2);
}

/** Toutes les lignes du fichier qui appellent REELLEMENT l'allumage. */
function lignesDAllumage(src) {
  return src
    .split("\n")
    .map((ligne) => ligne.trim())
    .filter((ligne) => /vocalWakeChrome\s*\(\s*\)\s*;/.test(ligne));
}

/** Le repos complet : rien ne retient le bas. */
const REPOS = {
  saisie: false,
  micFerme: "",
  pointeurActif: false,
  pointeurGeste: false,
  question: false,
};

// ---------------------------------------------------------------------------
describe("1. la souris est la SEULE cause d'apparition", () => {
  it("les trois gestes de souris allument le bas, et eux seuls", () => {
    // Mouvement au-dela de 4 px, clic, molette : les trois ecouteurs de
    // `super-agent.js`. Si l'un perd son appel, la barre ne se rallume plus ; si
    // un quatrieme appel apparait, il y a une cause d'apparition en trop.
    expect(corpsFonction(SUPER, "const onVocalChromePointerMove = (e) =>")).toMatch(
      /vocalWakeChrome\(\);/,
    );
    expect(corpsFonction(SUPER, "const onVocalChromePointerDown = (e) =>")).toMatch(
      /vocalWakeChrome\(\);/,
    );
    expect(corpsFonction(SUPER, "const onVocalChromeWheel = () =>")).toMatch(/vocalWakeChrome\(\);/);
    // TROIS appels dans tout le fichier, pas un de plus : c'est le compte qui
    // garantit qu'aucun autre chemin (parole, etat, transcription, question) ne
    // peut rallumer la barre.
    const appels = lignesDAllumage(SUPER);
    expect(appels, `appels trouves : ${JSON.stringify(appels)}`).toEqual([
      "vocalWakeChrome();",
      "vocalWakeChrome();",
      "vocalWakeChrome();",
    ]);
  });

  it("la decision pure ne connait AUCUN etat de conversation", () => {
    // Le module ne recoit que des faits d'usage : un appelant ne PEUT pas lui
    // dire « Pilot parle » ou « le micro ecoute » pour retenir le bas.
    for (const etat of [
      "speaking",
      "listening",
      "thinking",
      "veille",
      "reveil",
      "transcription",
    ]) {
      expect(vocalChromeVisible({ ...REPOS, etat }), `etat retenant le bas : ${etat}`).toBe(false);
      expect(vocalChromeVisible({ etat }), `etat retenant le bas (faits nus) : ${etat}`).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
describe("2. aucun chemin de la PAROLE n'allume le bas", () => {
  it("la transcription (`rec.onresult`) ne reveille plus rien", () => {
    const dictee = sliceSource(SUPER, "rec.onresult = (e) => {", "rec.onerror = (ev) => {", 400);
    expect(dictee).not.toMatch(/vocalWakeChrome\s*\(/);
    expect(dictee).not.toMatch(/vocalKeepChromeAlive\s*\(/);
    // Elle rejoue la decision (le champ a pu changer) : aucune minuterie.
    expect(dictee).toMatch(/vocalSyncChrome\(\);/);
  });

  it("la voix par-dessus la lecture (`vocalBargeIn`) ne reveille plus rien", () => {
    const prise = sliceSource(SUPER, "function vocalBargeIn(rapport) {", "\n  function ", 400);
    expect(prise).not.toMatch(/vocalWakeChrome\s*\(/);
    expect(prise).not.toMatch(/vocalKeepChromeAlive\s*\(/);
    expect(prise).toMatch(/applyVocalState\(\);/);
  });

  it("ni demarrage, ni fin, ni panne de l'ecoute ne reveillent le bas", () => {
    // Tout le cycle de la dictee. Un seul de ces chemins suffirait a rallumer la
    // barre a chaque phrase, sans qu'on voie pourquoi.
    for (const [debut, fin] of [
      ["function startVoiceInput() {", "\n  function "],
      ["function stopVoiceInput() {", "\n  function "],
      ["rec.onerror = (ev) => {", "\n    rec.onend"],
      ["rec.onend = () => {", "\n    }"],
      ["function vocalEnterVeille(", "\n  function "],
      ["function vocalExitVeille(", "\n  function "],
      ["function vocalSetLevel(", "\n  function "],
      ["function applyVocalState() {", "\n  function "],
    ]) {
      const corps = sliceSource(SUPER, debut, fin, 20);
      expect(corps, `reveil par ${debut}`).not.toMatch(/vocalWakeChrome\s*\(/);
      expect(corps, `prolongation par ${debut}`).not.toMatch(/vocalKeepChromeAlive\s*\(/);
    }
  });

  it("le texte DICTE ne retient pas le bas par la regle 2", () => {
    // Sans cette exclusion, chaque phrase prononcee rallumait la barre pour la
    // duree d'un envoi, meme sans reveil : la regle 2 aurait garde le defaut.
    const sync = sliceSource(SUPER, "function vocalSyncChrome(state)", "\n  }", 200);
    expect(sync).toMatch(/saisie:\s*texte\.trim\(\) !== "" && !vocalChampDicte/);
    // Pose par l'ecrivain unique du moteur, retire par la frappe de l'utilisateur.
    const dictee = sliceSource(SUPER, "rec.onresult = (e) => {", "rec.onerror = (ev) => {", 400);
    expect(dictee).toMatch(/vocalChampDicte = true;/);
    const frappe = sliceSource(SUPER, 'inputEl.addEventListener("input"', "});", 60);
    expect(frappe).toMatch(/vocalChampDicte = false;/);
  });
});

// ---------------------------------------------------------------------------
describe("3. une touche PROLONGE, elle n'ALLUME pas", () => {
  it("l'ecouteur clavier passe par la prolongation, jamais par l'allumage", () => {
    const touche = corpsFonction(SUPER, "const onVocalChromeKeydown = (e) =>");
    expect(touche).toMatch(/vocalKeepChromeAlive\(\);/);
    expect(touche).not.toMatch(/vocalWakeChrome\s*\(/);
    // Echap sort du mode : il ne prolonge rien (comportement inchange).
    expect(touche).toMatch(/vocalChromeWakeKey\(e && e\.key\)/);
  });

  it("la prolongation ne repose le minuteur que s'il tourne deja", () => {
    // C'est LA garde qui fait la difference entre « prolonger » et « allumer » :
    // sans decompte en cours, aucune touche ne met la barre en marche.
    const prolonge = corpsFonction(SUPER, "function vocalKeepChromeAlive()");
    expect(prolonge).toContain("if (vocalChromeTimer) vocalRestartChromeTimer();");
    // Aucune pose inconditionnelle : la seule ligne qui repose le minuteur est
    // celle qui vient d'etre lue, garde comprise.
    const poses = prolonge
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => /vocalRestartChromeTimer\(\)/.test(l));
    expect(poses).toEqual(["if (vocalChromeTimer) vocalRestartChromeTimer();"]);
    // La decision est quand meme rejouee (un texte saisi retient le bas, regle 2).
    expect(prolonge).toMatch(/vocalSyncChrome\(\);/);
  });

  it("la frappe de l'utilisateur prolonge, et le clavier reste filtre par le module", () => {
    const frappe = sliceSource(SUPER, 'inputEl.addEventListener("input"', "});", 60);
    expect(frappe).toMatch(/vocalKeepChromeAlive\(\);/);
    expect(frappe).not.toMatch(/vocalWakeChrome\s*\(/);
    // Echap ne prolonge pas : il sort du mode (decision inchangee du module).
    expect(vocalChromeWakeKey("Escape")).toBe(false);
    expect(vocalChromeWakeKey("a")).toBe(true);
    // Et un deplacement de souris sous le seuil n'est pas un geste.
    expect(vocalChromeMoved({ x: 102, y: 400 }, { x: 100, y: 400 })).toBe(false);
    expect(vocalChromeMoved({ x: 106, y: 400 }, { x: 100, y: 400 })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("4. la disparition apres inactivite est celle du module", () => {
  it("au repos, le bas est efface (aucune minuterie n'est necessaire)", () => {
    expect(vocalChromeVisible(REPOS)).toBe(false);
    expect(vocalChromeClass(false)).toBe(VOCAL_CHROME_HIDDEN_CLASS);
    expect(VOCAL_CHROME_HIDDEN_CLASS).toBe("vocal-chrome-hidden");
  });

  it("le delai de repos est 10 000 ms, et un seul minuteur le porte", () => {
    expect(VOCAL_CHROME_IDLE_MS).toBe(10_000);
    // Un seul `setTimeout` dans tout le fichier, et il utilise le delai du module.
    const poses = SUPER.match(/vocalChromeTimer = setTimeout\(/g) || [];
    expect(poses).toHaveLength(1);
    const minuteur = corpsFonction(SUPER, "function vocalRestartChromeTimer()");
    expect(minuteur).toContain("clearVocalChromeTimer();");
    expect(minuteur).toContain("VOCAL_CHROME_IDLE_MS");
    // A l'echeance : le decompte retombe, la decision est rejouee, et le minuteur
    // n'est PAS repose (sinon la barre ne s'effacerait jamais).
    expect(minuteur).toMatch(/vocalChromeTimer = 0;/);
    expect(minuteur).toMatch(/vocalSyncChrome\(\);/);
    expect(minuteur.split("vocalRestartChromeTimer").length - 1).toBe(1);
  });

  it("l'entree dans le mode ne pose aucun minuteur (le bas est efface d'emblee)", () => {
    const entree = sliceSource(SUPER, "function enterVocal() {", "vocalSyncSides();", 200);
    expect(entree).not.toMatch(/vocalRestartChromeTimer\(\)/);
    expect(entree).toContain("document.body.appendChild(vocalOverlay)");
  });
});
