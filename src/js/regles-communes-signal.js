// regles-communes-signal.js — AFFICHAGE du signalement des DEUX RÈGLES COMMUNES
// DE PILOT (décision du propriétaire du 13/11/2026).
//
// La DÉCISION (ce qui est fautif, et pourquoi) vit dans la source unique
// `regles-communes-assistants.js` : ce module-ci ne décide RIEN, il écrit le
// signalement une seule fois, pour les TROIS écrans qui affichent une réponse
// d'assistant (assistant de suivi 🧭, agent du projet π, et tout appelant futur).
// Un seul écrivain = un seul style, une seule phrase, aucun risque de voir deux
// formulations divergentes de la même règle.
//
// Le module ne touche au DOM QUE dans `showReglesCommunesNotice` : il reste
// importable par Vitest sans navigateur, et l'affichage est fail-open — une
// panne d'affichage ne casse jamais le rendu d'une réponse.

import { reglesCommunesAnswerNotice } from "./regles-communes-assistants.js";

/** Classe CSS du signalement (une seule règle de style, dans style.css). */
export const REGLES_COMMUNES_NOTICE_CLASS = "super-rules-notice";

/**
 * Écrit (ou n'écrit pas) le signalement des deux règles, juste APRÈS la section
 * de texte qui vient d'être rendue.
 *
 * Rien n'est ajouté quand la réponse est saine : `reglesCommunesAnswerNotice`
 * rend une chaîne vide. Rien n'est écrit deux fois pour la même réponse si
 * l'appelant repasse sur la même section (le signalement porte la marque
 * `data-regles-communes`).
 *
 * @param {HTMLElement|null} section section de texte terminée (peut être null)
 * @param {string} text texte complet de cette section
 * @param {Document} [doc] document à utiliser (défaut : celui de la page)
 * @returns {HTMLElement|null} le nœud écrit, ou null si rien n'a été écrit
 */
export function showReglesCommunesNotice(section, text, doc) {
  try {
    if (!section || !text) return null;
    const phrase = reglesCommunesAnswerNotice(text);
    if (!phrase) return null;
    const d = doc || (typeof document !== "undefined" ? document : null);
    if (!d) return null;
    const parent = section.parentNode;
    if (!parent) return null;
    const previous = section.nextSibling;
    // Ne jamais empiler deux signalements identiques sur la même section.
    if (
      previous &&
      previous.nodeType === 1 &&
      previous.classList &&
      previous.classList.contains(REGLES_COMMUNES_NOTICE_CLASS) &&
      previous.textContent === phrase
    ) {
      return previous;
    }
    const notice = d.createElement("div");
    notice.className = REGLES_COMMUNES_NOTICE_CLASS;
    notice.dataset.reglesCommunes = "1";
    notice.textContent = phrase;
    parent.insertBefore(notice, section.nextSibling);
    return notice;
  } catch {
    /* fail-open : la réponse reste affichée, rien n'est cassé */
  }
  return null;
}
