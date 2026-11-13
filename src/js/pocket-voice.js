// pocket-voice.js — Voix PocketTTS (Kyutai), TROISIÈME voix de la lecture à voix
// haute, **à côté** de la voix française locale (Piper, `local-voice.js`) et de
// la voix imitée (`voicestudio-voice.js`) — jamais à leur place.
//
// Contraintes tenues, et tenues ICI seulement :
//   - **rien n'est remplacé** : ces deux voix gardent leur valeur de réglage,
//     leurs libellés et leur code. Ce module n'ajoute QUE la valeur
//     `local:pocket` (voix française du moteur) et `local:pocket:<identifiant>`
//     (voix clonée déposée par l'utilisateur), dans LE MÊME champ unique
//     `read_aloud_voice` — aucun second réglage de voix n'est créé ;
//   - **le moteur n'est pas installé par Pilot** : PocketTTS est un programme
//     séparé, présent ou absent selon les ordinateurs. La fenêtre ne le lance
//     jamais elle-même : elle passe par les commandes Tauri `tts_pocket_*` ;
//   - **les poids ne descendent QUE sur un geste** : [`installPocketWeights`] est
//     la seule fonction de tout le front capable de provoquer un téléchargement,
//     et elle n'est appelée que par le clic du bouton de la section « Lecture des
//     réponses » (verrou de test : aucun autre appelant) ;
//   - **aucun fichier audio écrit côté fenêtre** : le WAV revient en mémoire
//     (base64) et vit le temps de la lecture ;
//   - **repli obligatoire et visible** : moteur absent, poids absents, synthèse
//     en échec → la lecture reprend avec la voix locale (Piper), puis avec la
//     voix du système, et l'écran le dit. Jamais un silence, jamais un gel.
//
// Répartition des rôles (aucun doublon) :
//   - `pocket-voice.js` (ce fichier) : SAIT quelles voix Pocket existent, si le
//     moteur et ses poids sont là, demande le son, journalise un repli ;
//   - `read-aloud.js` : décide QUOI lire, choisit le moteur d'après LE réglage
//     unique, joue le son et publie l'état de lecture ;
//   - `settings.js` : affiche le réglage et l'état (un seul endroit).

import { LOCAL_AUDIO_PREFIX } from "./local-voice.js";

/**
 * Préfixe de la valeur du réglage unique (`read_aloud_voice`) qui désigne cette
 * voix. La valeur complète est `local:pocket` (voix française du moteur) ou
 * `local:pocket:<identifiant>` (une voix clonée déposée sur le disque).
 *
 * Le préfixe reste `local:` : comme Piper et la voix imitée, le son est fabriqué
 * **sur cet ordinateur** puis joué par la fenêtre.
 */
export const POCKET_VOICE_PREFIX = "local:pocket";

/** Nom du moteur, écrit une seule fois (libellés de la liste des voix). */
export const POCKET_ENGINE = "PocketTTS";

/** Attribution OBLIGATOIRE des poids (CC-BY-4.0) — jamais recopiée ailleurs. */
export const POCKET_ATTRIBUTION = "Pocket TTS © Kyutai Labs — CC BY 4.0";

/** Commandes Tauri utilisées (une seule porte vers la machine). */
export const POCKET_COMMAND_STATUS = "tts_pocket_status";
export const POCKET_COMMAND_SYNTHESIZE = "tts_pocket_synthesize";
export const POCKET_COMMAND_INSTALL = "tts_pocket_install";
export const POCKET_COMMAND_LOG = "tts_pocket_log";

/** Libellé du bouton qui télécharge les poids (sur GESTE seulement). */
export const POCKET_INSTALL_LABEL = "Installer la voix PocketTTS";

/** Suffixe d'un choix dont les poids ne sont pas encore installés. */
export const POCKET_NOT_INSTALLED_SUFFIX = " — modèle à télécharger";

/** Phrase affichée tant que le moteur n'a pas été interrogé. */
export const POCKET_UNKNOWN_HINT =
  `L'état de la voix ${POCKET_ENGINE} n'a pas encore été vérifié : la lecture utilise la voix ` +
  "choisie, et se rabat sur la voix locale (Piper) si le moteur manque.";

// ── Valeur du réglage (une seule grammaire) ────────────────────────────────

/**
 * Valeur complète du réglage pour un identifiant de voix Pocket.
 * @param {string} [id] identifiant (`""` = voix française du moteur)
 * @returns {string}
 */
export function pocketVoiceValue(id) {
  const voice = String(id == null ? "" : id).trim();
  return voice ? `${POCKET_VOICE_PREFIX}:${voice}` : POCKET_VOICE_PREFIX;
}

/**
 * Identifiant de voix désigné par une valeur du réglage, ou `null` si la valeur
 * ne désigne pas cette voix (valeur vide, voix du système, AUTRE moteur local).
 * @param {string} value
 * @returns {string|null}
 */
export function pocketVoiceIdFor(value) {
  const raw = String(value == null ? "" : value).trim();
  if (!raw) return null;
  if (raw === POCKET_VOICE_PREFIX) return "";
  const prefix = `${POCKET_VOICE_PREFIX}:`;
  if (!raw.startsWith(prefix)) return null;
  return raw.slice(prefix.length).trim();
}

/**
 * Vrai si la valeur du réglage désigne CETTE voix.
 * @param {string} value
 * @returns {boolean}
 */
export function isPocketVoiceChoice(value) {
  return pocketVoiceIdFor(value) !== null;
}

// ── État (une seule copie en mémoire) ──────────────────────────────────────

/** Dernier état connu du moteur (`null` tant qu'il n'a pas été demandé). */
let pocketStatus = null;

/** Invocateur Tauri mémorisé (injectable pour les tests). */
let invokeRef = null;

/**
 * Injecte l'invocateur Tauri (utile aux tests, ou pour réutiliser celui déjà
 * importé par l'appelant). `null` rétablit le chargement à la demande.
 * @param {Function|null} fn
 */
export function setPocketInvoker(fn) {
  invokeRef = typeof fn === "function" ? fn : null;
}

/**
 * Rend l'invocateur à utiliser : celui fourni, celui déjà mémorisé, ou celui de
 * la fenêtre chargé à la demande.
 * @param {{invoke?: Function}} [options]
 * @returns {Promise<Function>}
 */
async function resolveInvoke(options = {}) {
  if (options && typeof options.invoke === "function") return options.invoke;
  if (invokeRef) return invokeRef;
  const mod = await import("@tauri-apps/api/core");
  invokeRef = mod.invoke;
  return invokeRef;
}

/**
 * Normalise un état brut renvoyé par la machine : jamais de champ manquant,
 * jamais de valeur inventée (un état absent est « inconnu », jamais « en
 * panne »).
 * @param {object|null} raw
 * @returns {object}
 */
export function normalizePocketStatus(raw) {
  const src = raw && typeof raw === "object" ? raw : null;
  if (!src) {
    return {
      unknown: true,
      installed: false,
      engine: POCKET_ENGINE,
      engine_present: false,
      exe: "",
      exe_expected: "",
      cache_dir: "",
      model_present: false,
      model_bytes: 0,
      voice: "",
      voice_present: false,
      voices: [],
      missing: [],
      hint: POCKET_UNKNOWN_HINT,
      attribution: POCKET_ATTRIBUTION,
      dir: "",
      log: "",
    };
  }
  const voices = (Array.isArray(src.voices) ? src.voices : [])
    .filter((entry) => entry && String(entry.id || "").trim())
    .map((entry) => {
      const id = String(entry.id).trim();
      return {
        id,
        value: String(entry.value || "").trim() || pocketVoiceValue(id),
        label: String(entry.label || "").trim() || `${POCKET_ENGINE} (${id})`,
        gender: String(entry.gender || ""),
        kind: String(entry.kind || ""),
      };
    });
  return {
    unknown: false,
    installed: src.installed === true,
    engine: String(src.engine || POCKET_ENGINE),
    engine_present: src.engine_present === true,
    exe: String(src.exe || ""),
    exe_expected: String(src.exe_expected || ""),
    cache_dir: String(src.cache_dir || ""),
    model_present: src.model_present === true,
    model_bytes: Number(src.model_bytes) || 0,
    voice: String(src.voice || ""),
    voice_present: src.voice_present === true,
    voices,
    missing: (Array.isArray(src.missing) ? src.missing : []).map((item) => String(item)),
    hint: String(src.hint || "") || POCKET_UNKNOWN_HINT,
    attribution: String(src.attribution || "") || POCKET_ATTRIBUTION,
    dir: String(src.dir || ""),
    log: String(src.log || ""),
  };
}

/** Dernier état connu (`null` = jamais demandé), pour l'affichage synchrone. */
export function getPocketStatus() {
  return pocketStatus;
}

/** Mémorise un état déjà normalisé (utilisé par l'écran et par les tests). */
export function setPocketStatus(raw) {
  pocketStatus = raw == null ? null : normalizePocketStatus(raw);
  return pocketStatus;
}

/**
 * Interroge la machine sur l'état réel du moteur et de ses poids.
 *
 * Jamais d'exception : une panne devient un état lisible (`installed: false`).
 * Aucun téléchargement n'est déclenché ici.
 * @param {{invoke?: Function, voice?: string}} [options]
 * @returns {Promise<object>} l'état normalisé
 */
export async function refreshPocketStatus(options = {}) {
  const voice = String(options.voice == null ? "" : options.voice).trim();
  try {
    const invoke = await resolveInvoke(options);
    const raw = await invoke(POCKET_COMMAND_STATUS, { voice: voice || null });
    pocketStatus = normalizePocketStatus(raw);
  } catch (error) {
    // Une panne de la commande ne condamne PAS la voix : l'état reste inconnu,
    // et la liste garde ses entrées (voir `pocketVoiceChoices`).
    pocketStatus = normalizePocketStatus({
      installed: false,
      hint:
        `L'état de la voix ${POCKET_ENGINE} n'a pas pu être lu : la lecture se rabat sur la voix ` +
        "locale (Piper) si le moteur manque.",
    });
    pocketStatus.unknown = true;
  }
  return pocketStatus;
}

// ── Liste des voix (le genre est écrit EN CLAIR) ───────────────────────────

/**
 * Choix proposés pour cette voix, tels qu'ils apparaissent dans la liste
 * UNIQUE des voix.
 *
 * Chaque entrée porte le genre en clair (exigence de l'utilisateur) et son état
 * d'installation : `label` est complet, prêt à afficher.
 * @param {object|null} status état normalisé (sans lui : aucune ligne)
 * @returns {{value: string, label: string, id: string, gender: string, kind: string, installed: boolean}[]}
 */
export function pocketVoiceChoices(status) {
  // `undefined` = l'appelant ne parle PAS de cette voix (il ne l'a pas
  // interrogée) : on n'ajoute rien. `null` = l'appelant la connaît mais son
  // état n'a pas pu être lu : une ligne honnête est proposée quand même.
  if (status === undefined) return [];
  const etat = status && typeof status === "object" ? status : null;
  const voices = etat && Array.isArray(etat.voices) ? etat.voices : [];
  if (!etat || etat.unknown === true || !voices.length) {
    // État non vérifié (ou illisible) : la voix reste PROPOSÉE — elle ne
    // disparaît jamais de la liste à cause d'une panne — et le libellé dit
    // franchement que l'état n'est pas connu.
    return [
      {
        value: POCKET_VOICE_PREFIX,
        label: `${POCKET_ENGINE} — état non vérifié`,
        id: "",
        gender: "",
        kind: "moteur",
        installed: false,
      },
    ];
  }
  // L'installation vaut pour le moteur ET ses poids : une voix sans poids n'est
  // pas utilisable, et la ligne doit le dire.
  const installed = etat.installed === true;
  return voices.map((entry) => ({
    value: entry.value,
    label: `${entry.label}${installed ? "" : POCKET_NOT_INSTALLED_SUFFIX}`,
    id: entry.id,
    gender: entry.gender,
    kind: entry.kind,
    installed,
  }));
}

/**
 * Libellé d'un choix Pocket MÉMORISÉ que l'état ne porte pas (moteur jamais
 * interrogé, dossier vidé, voix retirée du disque).
 *
 * Le choix ne disparaît JAMAIS de la liste : sinon l'enregistrement l'écraserait
 * dans le dos de l'utilisateur.
 * @param {string} value
 * @param {object|null} status
 * @returns {string}
 */
export function pocketUnavailableLabel(value, status) {
  const id = pocketVoiceIdFor(value);
  const nom = id ? `${POCKET_ENGINE} (${id})` : POCKET_ENGINE;
  if (!status || status.unknown === true) {
    return `${nom} — état non vérifié`;
  }
  if (!status.engine_present) {
    return `${nom} — moteur absent`;
  }
  if (!status.model_present) {
    return `${nom}${POCKET_NOT_INSTALLED_SUFFIX}`;
  }
  return `${nom} — voix introuvable`;
}

/**
 * Phrase d'état de la section « Lecture des réponses », pour un choix Pocket.
 * @param {object|null} status
 * @returns {string}
 */
export function pocketStatusNote(status) {
  if (!status || status.unknown === true) return POCKET_UNKNOWN_HINT;
  const hint = String(status.hint || "").trim();
  return hint || POCKET_UNKNOWN_HINT;
}

// ── Synthèse ───────────────────────────────────────────────────────────────

/**
 * Message court d'une erreur (jamais un objet brut dans une phrase).
 * @param {*} error
 * @returns {string}
 */
function shortCause(error) {
  const text = String(
    (error && error.message) || (error && error.toString ? error.toString() : "") || error || "",
  )
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "cause inconnue";
  return text.length > 140 ? `${text.slice(0, 137)}…` : text;
}

/**
 * Demande le son d'un morceau à la machine.
 *
 * Le repli n'est pas décidé ici : on renvoie une cause claire et c'est
 * `read-aloud.js` qui reprend avec la voix locale.
 * @param {string} text morceau DÉJÀ nettoyé et découpé
 * @param {{invoke?: Function, voice?: string}} [options] `voice` = identifiant
 *   (`""` = voix française du moteur)
 * @returns {Promise<{audio: string|null, reason: string}>}
 */
export async function synthesizePocketAudio(text, options = {}) {
  const payload = String(text == null ? "" : text).trim();
  if (!payload) return { audio: null, reason: "aucun texte à lire" };
  const voice = String(options.voice == null ? "" : options.voice).trim();
  try {
    const invoke = await resolveInvoke(options);
    const encoded = await invoke(POCKET_COMMAND_SYNTHESIZE, {
      text: payload,
      voice: voice || null,
    });
    if (!encoded || typeof encoded !== "string") {
      const reason = "le moteur n'a renvoyé aucun son";
      await logPocket(`Aucun son (${reason}) : repli sur la voix locale.`, options);
      return { audio: null, reason };
    }
    return { audio: `${LOCAL_AUDIO_PREFIX}${encoded}`, reason: "" };
  } catch (error) {
    const reason = shortCause(error);
    await logPocket(`Synthèse impossible (${reason}) : repli sur la voix locale.`, options);
    return { audio: null, reason };
  }
}

/**
 * Ajoute une ligne au journal de la chaîne vocale (`voix-locale.log`, préfixée
 * côté machine). Jamais d'exception : un journal indisponible ne doit pas
 * empêcher la lecture.
 * @param {string} message
 * @param {{invoke?: Function}} [options]
 * @returns {Promise<void>}
 */
export async function logPocket(message, options = {}) {
  const text = String(message == null ? "" : message).trim();
  if (!text) return;
  try {
    const invoke = await resolveInvoke(options);
    await invoke(POCKET_COMMAND_LOG, { message: text });
  } catch (_) {
    // Journal indisponible : la lecture continue, rien n'est bloqué.
  }
}

/**
 * Télécharge les poids du modèle français — **GESTE EXPLICITE UNIQUEMENT**.
 *
 * SEULE fonction du front capable de provoquer un téléchargement pour cette
 * voix. Elle est appelée par le clic du bouton « Installer la voix PocketTTS »
 * (`settings.js`), et par lui seul : aucun démarrage, aucune ouverture des
 * Paramètres, aucune lecture ne la déclenche (verrou de test).
 * @param {{invoke?: Function}} [options]
 * @returns {Promise<{ok: boolean, message: string}>}
 */
export async function installPocketWeights(options = {}) {
  try {
    const invoke = await resolveInvoke(options);
    const message = await invoke(POCKET_COMMAND_INSTALL);
    return { ok: true, message: String(message || "Voix PocketTTS installée.") };
  } catch (error) {
    return { ok: false, message: shortCause(error) };
  }
}
