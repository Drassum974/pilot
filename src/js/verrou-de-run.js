// verrou-de-run.js — DÉCISION UNIQUE du verrou de run d'un projet.
//
// FAIT (défaut prouvé, rapport docs/rapports/RAPPORT-verrou-de-run-bloque-la-file.md) :
// le verrou de run (`busState.runs[clé]`) pouvait survivre à la disparition de
// son propriétaire, et la file d'un projet restait bloquée « à vie ». Trois
// causes, toutes réunies ICI pour être décidées une seule fois :
//
//  1. « j'ai essayé de relancer » était confondu avec « j'ai relancé » : la
//     vidange de la file répondait `true` dès qu'une entrée existait, même quand
//     le lancement était REFUSÉ. Le verrou croyait donc avoir un propriétaire
//     alors qu'aucun run n'avait démarré ;
//  2. une demande dont la mission propriétaire avait disparu (arrêt d'agent →
//     contexte de run détruit) restait orpheline et tenait le verrou pour
//     toujours (« verrou conservé pour ne rien perdre ») ;
//  3. le chien de garde ANTIDAITAIT sa propre preuve d'inactivité : chaque
//     passage de rejeu réécrivait `lastActivityAt` à l'instant présent, donc le
//     balayage périodique rafraîchissait le verrou qu'il devait faire tomber.
//
// INVARIANTS DÉCIDÉS (et prouvés par les tests) :
//  A. un verrou n'est tenu que par un run RÉELLEMENT démarré : la seule action
//     qui CONSERVE le verrou est `launched === true` ;
//  B. un refus de lancement LIBÈRE le verrou et le DIT (la demande reste en
//     file — RÈGLE 4 —, visible et abandonnable, mais elle ne bloque plus le
//     projet) ;
//  C. une demande orpheline (mission propriétaire disparue) n'est jamais
//     exécutée dans un contexte étranger et ne tient jamais le verrou ;
//  D. seul un ÉVÉNEMENT d'agent ou un LANCEMENT réel horodate l'activité : le
//     chien de garde arme le minuteur d'inactivité sans jamais antidater sa
//     propre preuve, et l'horodatage est MONOTONE (il ne recule jamais).
//
// Module PUR : aucun DOM, aucun import Tauri, aucune I/O, aucun minuteur.

/** Action : le verrou reste tenu (un run vient RÉELLEMENT de démarrer). */
export const RUN_LOCK_KEEP = "keep";
/** Action : le verrou est libéré (plus aucun run ne le porte). */
export const RUN_LOCK_RELEASE = "release";

/** Source d'horodatage : un événement venu de l'agent (preuve de vie réelle). */
export const RUN_ACTIVITY_AGENT_EVENT = "agent-event";
/** Source d'horodatage : un tour réellement lancé (prompt envoyé). */
export const RUN_ACTIVITY_TURN_LAUNCHED = "turn-launched";
/** Source d'horodatage : le chien de garde lui-même — ne prouve RIEN. */
export const RUN_ACTIVITY_WATCHDOG = "watchdog";

/** Les sources qui prouvent une activité réelle. Les autres ne prouvent rien. */
export const RUN_ACTIVITY_PROVEN_SOURCES = Object.freeze([
  RUN_ACTIVITY_AGENT_EVENT,
  RUN_ACTIVITY_TURN_LAUNCHED,
]);

/** Raison d'un refus de rejeu : la mission propriétaire n'existe plus. */
export const QUEUE_REFUSED_OWNER_GONE = "owner-gone";

/**
 * Pure : faut-il horodater l'activité de la run pour cette source ?
 *
 * Le chien de garde ne doit JAMAIS écrire `lastActivityAt` : c'est sa propre
 * preuve d'inactivité, et l'antidater rendait le verrou éternellement « actif ».
 * L'horodatage est MONOTONE : une preuve ne recule jamais, même si une horloge
 * de test (ou un événement tardif) fournit un instant antérieur.
 *
 * @param {{source?:string, now?:number, previous?:number|null}} [input]
 * @returns {{stamped:boolean, lastActivityAt:number|null}}
 */
export function decideActivityStamp(input = {}) {
  const at = Number(input.now) > 0 ? Number(input.now) : Date.now();
  const previous = Number(input.previous) > 0 ? Number(input.previous) : null;
  const proven = RUN_ACTIVITY_PROVEN_SOURCES.includes(input.source);
  if (!proven) return { stamped: false, lastActivityAt: previous };
  return { stamped: true, lastActivityAt: previous === null ? at : Math.max(previous, at) };
}

/**
 * Pure : où va une demande en tête de file d'exclusivité ?
 *
 * Sans propriétaire identifié (entrée héritée d'une version antérieure), c'est
 * la run appelante qui l'a mise en file : elle peut la lancer dans SON contexte.
 * Un propriétaire identifié mais DISPARU interdit le lancement (le rapport
 * partirait à une autre mission) : la demande reste en file, marquée orpheline.
 *
 * @param {{ownerKey?:string|null, ownerAlive?:boolean}} [input]
 * @returns {{placement:"launch"|"keep-orphan", reason:string}}
 */
export function decideQueuedDemandPlacement(input = {}) {
  const ownerKey = typeof input.ownerKey === "string" ? input.ownerKey.trim() : "";
  if (!ownerKey) return { placement: "launch", reason: "owner-unknown" };
  if (input.ownerAlive === true) return { placement: "launch", reason: "owner-alive" };
  return { placement: "keep-orphan", reason: QUEUE_REFUSED_OWNER_GONE };
}

/**
 * Phrase (français simple) qui DIT ce qu'il est advenu de la vidange.
 * @param {{launchedAgents:string[], refused:Array<{agentId:string,reason:string}>}} drain
 * @returns {string}
 */
function drainSentence(drain) {
  const launched = drain.launchedAgents || [];
  const refused = drain.refused || [];
  const blocked = Number(drain.blocked) > 0 ? Number(drain.blocked) : 0;
  const parts = [];
  if (blocked > 0) {
    parts.push(
      `${blocked} demande(s) en file n'ont pas pu être tentées (clé de file inutilisable) : ` +
        "elles ne sont donc pas déclarées orphelines.",
    );
  }
  if (launched.length > 0) {
    parts.push(`demande(s) en file réellement démarrée(s) : ${launched.join(", ")}.`);
  }
  if (refused.length > 0) {
    const orphans = refused.filter((r) => r.reason === QUEUE_REFUSED_OWNER_GONE).map((r) => r.agentId);
    const others = refused.filter((r) => r.reason !== QUEUE_REFUSED_OWNER_GONE).map((r) => r.agentId);
    if (orphans.length > 0) {
      parts.push(
        `demande(s) non relancée(s) — la mission qui les avait mises en file n'existe plus (${orphans.join(", ")}) : ` +
          `elles restent en file, visibles et abandonnables, mais ne tiennent plus le projet.`,
      );
    }
    if (others.length > 0) {
      parts.push(`lancement refusé (${others.join(", ")}) : le projet n'est pas bloqué pour autant.`);
    }
  }
  return parts.join(" ");
}

/**
 * Pure : verdict de la VIDANGE d'une file d'exclusivité.
 *
 * « Lancé » signifie qu'un run a réellement démarré, jamais qu'une entrée
 * existait dans la file. Un refus est compté, nommé et traduit en phrase.
 *
 * `blocked` compte les demandes présentes que le rejeu n'a même pas pu TENTER
 * (clé de file inutilisable : on ne sait alors ni qui les porte, ni si son
 * propriétaire vit). Elles ne sont pas un refus : les abandonner pour libérer
 * le verrou perdrait une mission.
 *
 * @param {Array<{agentId?:string, launched?:boolean, reason?:string}>} [attempts]
 * @param {{blocked?:number}} [info]
 * @returns {{launched:boolean, launchedAgents:string[], refused:Array<{agentId:string,reason:string}>, orphans:Array<{agentId:string,reason:string}>, blocked:number, sentence:string}}
 */
export function decideQueueDrain(attempts = [], info = {}) {
  const list = (Array.isArray(attempts) ? attempts : []).filter((a) => a && a.agentId);
  const launchedAgents = list.filter((a) => a.launched === true).map((a) => String(a.agentId));
  const refused = list
    .filter((a) => a.launched !== true)
    .map((a) => ({ agentId: String(a.agentId), reason: String(a.reason || "not-launched") }));
  const drain = {
    launched: launchedAgents.length > 0,
    launchedAgents,
    refused,
    orphans: refused.filter((r) => r.reason === QUEUE_REFUSED_OWNER_GONE),
    blocked: Number(info && info.blocked) > 0 ? Number(info.blocked) : 0,
  };
  drain.sentence = drainSentence(drain);
  return drain;
}

/**
 * Pure : DÉCISION UNIQUE du verrou de run après une vidange de file.
 *
 * Règles, DANS L'ORDRE (c'est la spec) :
 *  0. des demandes présentes n'ont même pas pu être TENTÉES (clé de file
 *     inutilisable : impossible de savoir qui les porte) → verrou CONSERVÉ :
 *     libérer ici abandonnerait une mission sans preuve qu'elle est orpheline ;
 *  1. un run a réellement démarré → le verrou est CONSERVÉ (c'est lui qui porte
 *     la mission, son sink et son groupe parallèle) ;
 *  2. au moins un lancement a été REFUSÉ → le verrou est LIBÉRÉ et le refus est
 *     dit : une tentative ratée n'est pas un propriétaire ;
 *  3. rien n'a été tenté → le verrou est LIBÉRÉ (plus rien ne le porte).
 *
 * `pending` ne conserve JAMAIS le verrou : il ne sert qu'à nommer, dans la
 * phrase, les demandes qui restent en file.
 *
 * @param {{drain?:object, pending?:number, door?:string}} [input]
 * @returns {{action:"keep"|"release", reason:string, sentence:string}}
 */
export function decideRunLockAfterDrain(input = {}) {
  const drain = input.drain && typeof input.drain === "object" ? input.drain : {};
  const pending = Number(input.pending) > 0 ? Number(input.pending) : 0;
  const refused = Array.isArray(drain.refused) ? drain.refused : [];
  const blocked = Number(drain.blocked) > 0 ? Number(drain.blocked) : 0;
  if (blocked > 0) {
    return {
      action: RUN_LOCK_KEEP,
      reason: "not-drainable",
      sentence:
        `${blocked} demande(s) en file n'ont pas pu être tentées (clé de file inutilisable) : ` +
        "le verrou est CONSERVÉ, aucune mission n'est abandonnée.",
    };
  }
  if (drain.launched === true) {
    return {
      action: RUN_LOCK_KEEP,
      reason: "relaunched",
      sentence: drain.sentence || "demande(s) en file réellement démarrée(s).",
    };
  }
  if (refused.length > 0) {
    const rest = pending > 0 ? ` ${pending} demande(s) restent en file d'attente (visibles et abandonnables).` : "";
    return {
      action: RUN_LOCK_RELEASE,
      reason: "replay-refused",
      sentence: `${drain.sentence || "Aucune demande n'a pu être relancée."} Le verrou de run est LIBÉRÉ.${rest}`,
    };
  }
  return {
    action: RUN_LOCK_RELEASE,
    reason: "nothing-queued",
    sentence: pending > 0 ? `${pending} demande(s) restent en file d'attente (non relançables en l'état).` : "",
  };
}
