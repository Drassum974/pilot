// regles-communes-assistants.js — SOURCE UNIQUE des DEUX RÈGLES COMMUNES à
// TOUS les assistants de Pilot (décision du propriétaire, 13/11/2026).
//
// Ce ne sont PAS des règles de l'assistant de suivi : ce sont des règles de
// Pilot. Elles sont nées de deux fautes réelles :
//
//   RÈGLE 1 — LE VÉCU DU PROPRIÉTAIRE PRIME TOUJOURS SUR LA DOCUMENTATION.
//   Il avait cloné des voix d'essai EN FRANÇAIS avec PocketTTS et cela avait
//   FONCTIONNÉ ; l'assistant lui a quand même opposé une note de documentation
//   (« le français n'est pas officiellement pris en charge ») comme si elle
//   valait plus que son essai.
//
//   RÈGLE 2 — AUCUN SUJET VALIDÉ NE DISPARAÎT FAUTE DE DATE.
//   Il avait validé l'étude PocketTTS le 02/11 ; l'assistant l'a rangée sous un
//   statut « à trancher », sans échéance, sans porteur, sans rappel : 11 jours
//   de perdus, et il a dû le découvrir lui-même.
//
// LE TEXTE N'EST ÉCRIT QU'ICI (`REGLES_COMMUNES_ASSISTANTS`), et il atteint les
// assistants par TROIS chemins qui le LISENT tous les trois (aucune recopie) :
//
//   1. l'assistant de suivi (onglet 🧭) : `src-tauri/src/super_agent.rs`
//      embarque CE FICHIER ENTIER (`include_str!`) et extrait le bloc pour le
//      prompt système (`regles_communes_assistants_prompt`) ;
//   2. TOUT agent lancé par un assistant (codeur, agents d'un projet, agents
//      hors projet) : `structured-brief.js` compose l'enveloppe mécanique des
//      briefs avec `reglesCommunesAssistantsBlock()` — donc la règle voyage dans
//      la demande, pas dans un document que personne ne relit ;
//   3. l'agent principal du projet (onglet π) : l'extension pi
//      `pilot-context.ts` ajoute le même bloc au prompt système à chaque tour.
//
// CONTRAT à ne pas casser (lu littéralement par Rust, `REGLES_COMMUNES_OPEN` /
// `REGLES_COMMUNES_CLOSE` dans `super_agent.rs`) :
//   - DÉBUT : la déclaration de la constante `REGLES_COMMUNES_ASSISTANTS`
//     immédiatement suivie d'un accent grave ouvrant un gabarit de chaîne ;
//   - FIN   : un accent grave suivi d'un point-virgule fermant ce gabarit.
// Le texte ne contient donc NI accent grave NI ${. Renommer la constante ou
// changer les délimiteurs fait perdre les deux règles dans le prompt : les
// verrous `les_regles_communes_sont_injectees_dans_le_prompt` (Rust) et
// `regles-communes-assistants.test.js` (front) échouent alors.
//
// Le module est PUR : aucun import, aucune I/O, aucun DOM. Il porte aussi les
// CONTRÔLES qui rendent les règles visibles dans le comportement (et non
// seulement écrites) :
//   - `findDocumentationReserveSigns` / `documentationReserveNotice` : règle 1,
//     une réserve de documentation opposée à un fait constaté est SIGNALÉE ;
//   - `findUndatedDeferralSigns` / `auditUndatedDeferral` / `undatedDeferralNotice`
//     : règle 2, un report sans date est SIGNALÉ (et REFUSÉ à la création d'une
//     tâche de suivi, cf. `pilot-assistant-tools.ts`).

/**
 * LE BLOC DES DEUX RÈGLES, en clair, tel qu'il est injecté (aucune
 * reformulation ailleurs). Un seul texte, un seul endroit.
 */
export const REGLES_COMMUNES_ASSISTANTS = `
## Règles communes des assistants de Pilot — décision du propriétaire (13/11/2026)
Ces deux règles valent pour TOUS les assistants de Pilot (assistant de suivi, agent d'un projet, agent hors projet, codeur). Elles viennent de deux fautes réelles et ne sont pas négociables.

### Règle 1 — Le vécu du propriétaire prime toujours sur la documentation
Un fait constaté SUR SA MACHINE par un essai réel ne se discute plus : il devient la vérité de référence. Une limite tirée d'une documentation ne s'oppose JAMAIS à un essai réussi : au pire elle est signalée comme une inconnue À VÉRIFIER, jamais présentée comme un refus, jamais transformée en « ce n'est pas pris en charge ». Une réserve que le propriétaire a DÉMENTIE par son propre essai ne revient plus jamais dans une réponse.

### Règle 2 — Aucun sujet validé ne disparaît faute de date
Un sujet que le propriétaire a validé mais qui n'est pas lancé devient IMMÉDIATEMENT une tâche DATÉE, avec un porteur nommé et un rappel programmé. Les états sans échéance — « à trancher », « plus tard », « à voir » — ne sont plus des états valides : soit une DATE, soit une CLÔTURE explicite. Avant de dire qu'un sujet est « reporté », vérifie qu'il figure encore dans les tâches ouvertes AVEC une date ; sinon il n'existe plus que dans la conversation, et il est perdu.`;

/**
 * Le bloc prêt à concaténer (extensions pi, enveloppe de brief). Aucune copie
 * du texte : c'est la constante ci-dessus, telle quelle.
 *
 * @returns {string} le bloc des deux règles, sans blanc de tête ni de queue
 */
export function reglesCommunesAssistantsBlock() {
  return REGLES_COMMUNES_ASSISTANTS.trim();
}

/** Repères stables des deux règles (libellés, journaux, tests). */
export const REGLES_COMMUNES_REPERE_1 = "Règle 1 — Le vécu du propriétaire prime";
export const REGLES_COMMUNES_REPERE_2 = "Règle 2 — Aucun sujet validé ne disparaît";

// ─────────────────────────────────────────────────────────────────────────────
// CONTRÔLE DE LA RÈGLE 1 — une limite de documentation opposée au vécu
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Formulations qui CITENT une documentation comme autorité.
 * Une entrée = un fragment réellement employé, jamais une phrase entière.
 */
export const MARQUEURS_DOCUMENTATION = [
  "d'apres la documentation",
  "d'apres la doc",
  "selon la documentation",
  "selon la doc",
  "la documentation indique",
  "la documentation precise",
  "dans la documentation",
  "according to the documentation",
  "the documentation says",
  "per the docs",
];

/**
 * Formulations qui transforment une limite de documentation en REFUS.
 * C'est la combinaison des deux listes qui est signalée : citer une
 * documentation n'est pas une faute, la brandir contre un essai réussi en est
 * une.
 */
export const MARQUEURS_LIMITE_DOCUMENTAIRE = [
  "pas officiellement pris en charge",
  "n'est pas pris en charge",
  "n'est pas prise en charge",
  "non pris en charge",
  "non prise en charge",
  "pas officiellement supporte",
  "n'est pas supporte",
  "n'est pas supportee",
  "non supporte",
  "non supportee",
  "not officially supported",
  "is not supported",
  "unsupported",
];

/**
 * Normalise pour comparer sans casse, sans accents, sans apostrophes
 * typographiques et sans espaces superflus : « D'après la documentation » et
 * « d'apres la  documentation » sont la même formule.
 *
 * @param {string} text
 * @returns {string}
 */
function foldForScan(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\u2018\u2019\u02bc]/g, "'")
    .replace(/\s+/g, " ");
}

/**
 * CONTRÔLE (règle 1) : ce texte oppose-t-il une limite de documentation à ce
 * que le propriétaire a constaté ?
 *
 * Fonction PURE : elle ne juge pas l'intention, elle nomme les marqueurs
 * trouvés. Vide (aucun des deux listes) = aucune réserve brandie en refus.
 *
 * @param {string} text texte à contrôler (réponse d'un assistant, brief, note)
 * @returns {{ documentation: string, limite: string }[]} paires trouvées (vide = rien à signaler)
 */
export function findDocumentationReserveSigns(text) {
  const folded = foldForScan(text);
  if (!folded) return [];
  const docs = MARQUEURS_DOCUMENTATION.filter((m) => folded.includes(foldForScan(m)));
  const limits = MARQUEURS_LIMITE_DOCUMENTAIRE.filter((m) => folded.includes(foldForScan(m)));
  if (docs.length === 0 || limits.length === 0) return [];
  const signs = [];
  for (const documentation of docs) {
    for (const limite of limits) {
      signs.push({ documentation, limite });
    }
  }
  return signs;
}

/**
 * Phrase affichée quand la règle 1 est sur le point d'être enfreinte. Chaîne
 * VIDE quand il n'y a rien à signaler : aucun bruit inutile.
 *
 * @param {string} text
 * @returns {string}
 */
export function documentationReserveNotice(text) {
  const signs = findDocumentationReserveSigns(text);
  if (signs.length === 0) return "";
  return (
    "Réserve de documentation signalée : le vécu du propriétaire prime toujours sur la documentation " +
    "(règle commune n°1). Un essai réussi chez lui ne se discute pas ; cette limite est à présenter " +
    "comme une inconnue à vérifier, jamais comme un refus."
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// CONTRÔLE DE LA RÈGLE 2 — un report sans date
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Statuts / formulations qui REPOUSSENT un sujet sans lui donner d'échéance.
 * Le propriétaire les a explicitement sortis des états valides.
 */
export const MARQUEURS_REPORT_SANS_DATE = [
  "a trancher",
  "plus tard",
  "a voir",
  "on verra",
  "un de ces jours",
  "quand on aura le temps",
  "reporte",
  "reportee",
  "to be decided",
  "someday",
];

/**
 * Forme AFFICHÉE d'un marqueur de report : le repérage se fait sans accents,
 * mais la phrase rendue au propriétaire s'écrit en français correct. Un marqueur
 * inconnu est rendu tel qu'il a été trouvé.
 *
 * @param {string} marker marqueur renvoyé par `findUndatedDeferralSigns`
 * @returns {string}
 */
export function displayDeferralMarker(marker) {
  const affichage = {
    "a trancher": "à trancher",
    "plus tard": "plus tard",
    "a voir": "à voir",
    "on verra": "on verra",
    "un de ces jours": "un de ces jours",
    "quand on aura le temps": "quand on aura le temps",
    reporte: "reporté",
    reportee: "reportée",
    "to be decided": "to be decided",
    someday: "someday",
  };
  return affichage[marker] || marker;
}

/**
 * Formulations d'une FERMETURE explicite : elles rendent la règle 2 satisfaite
 * sans date (le sujet n'est plus en attente, il est clos — et il le dit).
 */
export const MARQUEURS_CLOTURE_EXPLICITE = [
  "clos",
  "close",
  "cloture",
  "cloturee",
  "abandonne",
  "abandonnee",
  "ecarte",
  "ecartee",
  "refuse",
  "refusee",
  "annule",
  "annulee",
];

/**
 * CONTRÔLE (règle 2) : ce texte reporte-t-il un sujet SANS date ?
 *
 * @param {string} text
 * @returns {string[]} marqueurs de report trouvés (vide = rien à signaler)
 */
export function findUndatedDeferralSigns(text) {
  const folded = foldForScan(text);
  if (!folded) return [];
  return MARQUEURS_REPORT_SANS_DATE.filter((m) => folded.includes(foldForScan(m)));
}

/**
 * Une fermeture explicite est-elle dite dans ce texte ?
 *
 * @param {string} text
 * @returns {boolean}
 */
export function hasExplicitClosure(text) {
  const folded = foldForScan(text);
  if (!folded) return false;
  return MARQUEURS_CLOTURE_EXPLICITE.some((m) => {
    const marker = foldForScan(m);
    // Frontière de mot : « close » ne doit pas se déclencher dans « disclosed ».
    return new RegExp("(^|[^a-z0-9])" + marker + "([^a-z0-9]|$)").test(folded);
  });
}

/**
 * Une échéance est-elle réellement donnée ? Toute date ISO (AAAA-MM-JJ)
 * convient ; une chaîne vide, `null` ou `undefined` ne compte pas.
 *
 * @param {string} deadline
 * @returns {boolean}
 */
export function hasDeadline(deadline) {
  return /\d{4}-\d{2}-\d{2}/.test(String(deadline || ""));
}

/**
 * CONTRÔLE (règle 2), DÉCISION de la porte de création d'une tâche de suivi.
 *
 * Ordre des règles (c'est la spec) :
 *   1. une échéance réelle ⇒ rien à refuser, même si le texte dit « à trancher »
 *      (le sujet EST daté, la règle est satisfaite) ;
 *   2. une fermeture explicite ⇒ rien à refuser (le sujet est clos et le dit) ;
 *   3. sinon, un marqueur de report ⇒ REFUS, avec les marqueurs nommés ;
 *   4. sinon ⇒ rien à refuser (un titre ordinaire n'est jamais suspect).
 *
 * @param {{title?: string, description?: string, deadline?: string}} [task]
 * @returns {{ refuse: boolean, marqueurs: string[], phrase: string }}
 */
export function auditUndatedDeferral(task) {
  const t = task || {};
  const texte = [t.title, t.description].filter(Boolean).join("\n");
  const aucun = { refuse: false, marqueurs: [], phrase: "" };
  if (hasDeadline(t.deadline)) return aucun;
  if (hasExplicitClosure(texte)) return aucun;
  const marqueurs = findUndatedDeferralSigns(texte);
  if (marqueurs.length === 0) return aucun;
  const liste = marqueurs.map((m) => "« " + displayDeferralMarker(m) + " »").join(", ");
  return {
    refuse: true,
    marqueurs,
    phrase:
      "Refusé (règle commune n°2 — aucun sujet validé ne disparaît faute de date) : " +
      "« " +
      String(t.title || "").trim() +
      " » est reporté sans échéance (" +
      liste +
      "). Donne une DATE (champ deadline, AAAA-MM-JJ) avec un porteur nommé, " +
      "ou dis explicitement que le sujet est clos (clos, abandonné, écarté, refusé, annulé). " +
      "Un report sans date n'est plus un état valide : le sujet disparaîtrait des bilans.",
  };
}

/**
 * Phrase affichée quand une réponse d'assistant reporte un sujet sans date.
 * Chaîne VIDE quand il n'y a rien à signaler.
 *
 * @param {string} text
 * @returns {string}
 */
export function undatedDeferralNotice(text) {
  if (hasExplicitClosure(text)) return "";
  const marqueurs = findUndatedDeferralSigns(text);
  if (marqueurs.length === 0) return "";
  return (
    "Report sans date signalé (" +
    marqueurs.map((m) => "« " + displayDeferralMarker(m) + " »").join(", ") +
    ") : règle commune n°2 — un sujet validé non lancé devient une tâche datée, " +
    "avec un porteur nommé et un rappel. Soit une date, soit une clôture explicite."
  );
}

/**
 * CONTRÔLE UNIQUE appliqué à une réponse d'assistant : les deux règles, une
 * seule phrase de signalement (chaîne vide = réponse saine, rien n'est affiché).
 *
 * @param {string} text réponse de l'assistant
 * @returns {string}
 */
export function reglesCommunesAnswerNotice(text) {
  const phrases = [documentationReserveNotice(text), undatedDeferralNotice(text)].filter(Boolean);
  return phrases.join(" ");
}
