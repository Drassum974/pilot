// regles-communes-assistants.test.js — VERROUS des DEUX RÈGLES COMMUNES à tous
// les assistants de Pilot (décision du propriétaire, 13/11/2026).
//
// Ces tests ÉCHOUENT si :
//   - une des deux règles disparaît de la source unique (ou perd son sens) ;
//   - un chemin par lequel un assistant la LIT cesse de la lire (brief délégué,
//     extension de contexte, outils de suivi, prompt de l'assistant) ;
//   - le texte est RECOPIÉ ailleurs (il n'existe qu'à un seul endroit) ;
//   - le contrôle « sujet reporté sans date » cesse de refuser, ou refuse à tort.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  REGLES_COMMUNES_ASSISTANTS,
  REGLES_COMMUNES_REPERE_1,
  REGLES_COMMUNES_REPERE_2,
  auditUndatedDeferral,
  displayDeferralMarker,
  documentationReserveNotice,
  findDocumentationReserveSigns,
  findUndatedDeferralSigns,
  hasDeadline,
  hasExplicitClosure,
  reglesCommunesAnswerNotice,
  reglesCommunesAssistantsBlock,
  undatedDeferralNotice,
} from "./regles-communes-assistants.js";
import { REGLES_COMMUNES_NOTICE_CLASS } from "./regles-communes-signal.js";
import {
  applyAssistantBriefEnvelope,
  buildStructuredBrief,
  ensureStructuredBrief,
  reglesCommunesInstruction,
} from "./structured-brief.js";

const RACINE = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const lire = (rel) => readFileSync(join(RACINE, rel), "utf8").replace(/\r\n/g, "\n");

describe("source unique — les deux règles existent, en clair", () => {
  it("la règle 1 dit que le vécu du propriétaire prime sur la documentation", () => {
    // Les fragments sont ceux du TEXTE de la règle : les supprimer de la source
    // fait échouer ce test (c'est le verrou demandé).
    expect(REGLES_COMMUNES_ASSISTANTS).toContain(REGLES_COMMUNES_REPERE_1);
    expect(REGLES_COMMUNES_ASSISTANTS).toContain(
      "Un fait constaté SUR SA MACHINE par un essai réel ne se discute plus"
    );
    expect(REGLES_COMMUNES_ASSISTANTS).toContain(
      "Une limite tirée d'une documentation ne s'oppose JAMAIS à un essai réussi"
    );
    expect(REGLES_COMMUNES_ASSISTANTS).toContain(
      "Une réserve que le propriétaire a DÉMENTIE par son propre essai ne revient plus jamais"
    );
    expect(REGLES_COMMUNES_ASSISTANTS).toContain("13/11/2026");
  });

  it("la règle 2 dit qu'aucun sujet validé ne disparaît faute de date", () => {
    expect(REGLES_COMMUNES_ASSISTANTS).toContain(REGLES_COMMUNES_REPERE_2);
    expect(REGLES_COMMUNES_ASSISTANTS).toContain("tâche DATÉE");
    expect(REGLES_COMMUNES_ASSISTANTS).toContain("porteur nommé");
    expect(REGLES_COMMUNES_ASSISTANTS).toContain("rappel programmé");
    expect(REGLES_COMMUNES_ASSISTANTS).toContain("à trancher");
    expect(REGLES_COMMUNES_ASSISTANTS).toContain("CLÔTURE explicite");
    expect(REGLES_COMMUNES_ASSISTANTS).toContain("AVEC une date");
  });

  it("le bloc est rendu sans blanc de tête ni de queue (injectable tel quel)", () => {
    const bloc = reglesCommunesAssistantsBlock();
    expect(bloc).toBe(bloc.trim());
    expect(bloc.startsWith("## Règles communes")).toBe(true);
    expect(bloc).toContain(REGLES_COMMUNES_REPERE_1);
    expect(bloc).toContain(REGLES_COMMUNES_REPERE_2);
  });

  it("le texte ne contient ni accent grave ni ${ (CONTRAT d'extraction côté Rust)", () => {
    const bloc = reglesCommunesAssistantsBlock();
    expect(bloc).not.toContain("`");
    expect(bloc).not.toContain("${");
  });
});

describe("la règle n'est écrite QU'À UN SEUL ENDROIT", () => {
  const phrasesUniques = [
    "vécu du propriétaire prime toujours sur la documentation",
    "Aucun sujet validé ne disparaît faute de date",
  ];

  it("aucun autre fichier du dépôt ne recopie les phrases de la règle", () => {
    const fichiers = [
      "src/js/structured-brief.js",
      "src/js/regles-communes-signal.js",
      "src/js/super-agent.js",
      "src/js/agent-pi.js",
      "src-tauri/extensions/pilot-context.ts",
      "src-tauri/extensions/pilot-assistant-tools.ts",
      "src-tauri/src/super_agent.rs",
      "src-tauri/src/agent_service.rs",
    ];
    for (const rel of fichiers) {
      const src = lire(rel);
      for (const phrase of phrasesUniques) {
        expect(
          src.includes(phrase),
          `${rel} RECOPIE la règle (« ${phrase} ») : elle ne doit vivre que dans src/js/regles-communes-assistants.js`
        ).toBe(false);
      }
    }
  });

  it("les lecteurs RÉFÉRENCENT le module sans le réécrire", () => {
    expect(lire("src/js/structured-brief.js")).toContain(
      'from "./regles-communes-assistants.js"'
    );
    expect(lire("src/js/regles-communes-signal.js")).toContain(
      'from "./regles-communes-assistants.js"'
    );
    expect(lire("src/js/super-agent.js")).toContain('from "./regles-communes-signal.js"');
    expect(lire("src/js/agent-pi.js")).toContain('from "./regles-communes-signal.js"');
    expect(lire("src-tauri/extensions/pilot-context.ts")).toContain(
      'from "./regles-communes-assistants.js"'
    );
    expect(lire("src-tauri/extensions/pilot-assistant-tools.ts")).toContain(
      'from "./regles-communes-assistants.js"'
    );
  });
});

describe("les assistants LISENT réellement les deux règles", () => {
  it("toute demande déléguée (brief structuré) porte les deux règles", () => {
    const brief = buildStructuredBrief("Corrige le bouton", true);
    expect(brief).toContain(reglesCommunesAssistantsBlock());
    expect(brief).toContain(REGLES_COMMUNES_REPERE_1);
    expect(brief).toContain(REGLES_COMMUNES_REPERE_2);
  });

  it("un brief DÉJÀ structuré par l'assistant les porte aussi (aucun oubli)", () => {
    const deja = "## Contexte\nx\n## Objectif\ny\n## Consignes\nz\n## Ce qu'il ne faut PAS faire\nw";
    const out = ensureStructuredBrief(deja, true);
    expect(out).toContain(reglesCommunesAssistantsBlock());
    // Les sections du brief ne sont pas dupliquées pour autant.
    expect(out.split("## Objectif").length - 1).toBe(1);
  });

  it("la consigne quality-gate et les règles cohabitent (quality-gate désactivé)", () => {
    const out = ensureStructuredBrief("Tâche simple", false);
    expect(out).not.toContain("Respecte le protocole quality-gate");
    expect(out).toContain(reglesCommunesAssistantsBlock());
  });

  it("l'enveloppe de brief est le SEUL point d'ajout des règles côté JS délégué", () => {
    expect(reglesCommunesInstruction()).toBe(reglesCommunesAssistantsBlock() + "\n\n");
  });

  it("même SANS brief structuré (réglage désactivé), l'agent reçoit les deux règles", () => {
    const out = applyAssistantBriefEnvelope("Corrige le bouton", { forceStructured: false });
    expect(out).toContain(reglesCommunesAssistantsBlock());
    // Aucune section structurée n'est ajoutée dans ce cas (comportement d'avant).
    expect(out).not.toContain("## Objectif");
  });
});

describe("CONTRÔLE de la règle 1 — une limite de documentation brandie en refus", () => {
  it("signale la combinaison « citation de doc + limite opposée »", () => {
    const texte =
      "D'après la documentation, le français n'est pas pris en charge par ce moteur.";
    const signes = findDocumentationReserveSigns(texte);
    expect(signes.length).toBeGreaterThan(0);
    const phrase = documentationReserveNotice(texte);
    expect(phrase).toContain("vécu du propriétaire prime");
    expect(phrase).toContain("règle commune n°1");
  });

  it("ne signale rien quand la documentation est citée SANS être opposée", () => {
    const texte = "D'après la documentation, voici la liste des options disponibles.";
    expect(findDocumentationReserveSigns(texte)).toEqual([]);
    expect(documentationReserveNotice(texte)).toBe("");
  });

  it("ne signale rien sur une réponse saine", () => {
    const texte = "La tâche 12 est livrée : les tests passent, rien à signaler.";
    expect(findDocumentationReserveSigns(texte)).toEqual([]);
    expect(reglesCommunesAnswerNotice(texte)).toBe("");
  });
});

describe("CONTRÔLE de la règle 2 — un sujet reporté sans date", () => {
  it("reconnaît les statuts sans échéance que le propriétaire a interdits", () => {
    expect(findUndatedDeferralSigns("Faut voir ça plus tard")).toContain("plus tard");
    expect(findUndatedDeferralSigns("Sujet à trancher")).toContain("a trancher");
    expect(findUndatedDeferralSigns("À voir quand on aura le temps").length).toBeGreaterThan(0);
  });

  it("refuse la création d'une tâche reportée sans date (porte visible)", () => {
    const decision = auditUndatedDeferral({
      title: "Étude PocketTTS en français — à trancher",
      description: "voix clonées d'essai",
    });
    expect(decision.refuse).toBe(true);
    expect(decision.marqueurs).toContain("a trancher");
    expect(decision.phrase).toContain("règle commune n°2");
    expect(decision.phrase).toContain("Étude PocketTTS");
    expect(decision.phrase).toContain("deadline");
  });

  it("accepte le même sujet dès qu'il est DATÉ (le report daté est permis)", () => {
    const decision = auditUndatedDeferral({
      title: "Étude PocketTTS en français — à trancher",
      deadline: "2026-11-20",
    });
    expect(decision.refuse).toBe(false);
    expect(decision.phrase).toBe("");
  });

  it("accepte une clôture explicite (soit une date, soit une fermeture dite)", () => {
    expect(auditUndatedDeferral({ title: "Étude PocketTTS — abandonnée" }).refuse).toBe(false);
    expect(auditUndatedDeferral({ title: "Sujet clos, sans suite" }).refuse).toBe(false);
    expect(auditUndatedDeferral({ title: "Piste écartée" }).refuse).toBe(false);
  });

  it("n'accuse jamais un titre ordinaire", () => {
    expect(auditUndatedDeferral({ title: "Corriger le bouton d'export PDF" }).refuse).toBe(false);
    expect(auditUndatedDeferral({}).refuse).toBe(false);
    expect(auditUndatedDeferral(null).refuse).toBe(false);
  });

  it("nomme le marqueur en français correct dans la phrase rendue", () => {
    expect(displayDeferralMarker("a trancher")).toBe("à trancher");
    const phrase = undatedDeferralNotice("On verra ça plus tard; le sujet est à trancher.");
    expect(phrase).toContain("« à trancher »");
    expect(phrase).toContain("règle commune n°2");
  });

  it("reconnaît une échéance réelle et une clôture explicite (détails)", () => {
    expect(hasDeadline("2026-11-20")).toBe(true);
    expect(hasDeadline("")).toBe(false);
    expect(hasDeadline(undefined)).toBe(false);
    expect(hasExplicitClosure("sujet abandonné")).toBe(true);
    // Frontière de mot : « disclosed » n'est pas « clos ».
    expect(hasExplicitClosure("the value is disclosed")).toBe(false);
  });
});

describe("le signalement est AFFICHÉ par un seul écrivain", () => {
  it("la classe CSS du signalement est unique et stylée", () => {
    expect(REGLES_COMMUNES_NOTICE_CLASS).toBe("super-rules-notice");
    const css = lire("src/css/style.css");
    expect(css).toContain(".super-rules-notice");
  });

  it("les DEUX écrans de réponse appellent le même écrivain", () => {
    for (const rel of ["src/js/super-agent.js", "src/js/agent-pi.js"]) {
      expect(lire(rel)).toContain("showReglesCommunesNotice(");
    }
  });
});
