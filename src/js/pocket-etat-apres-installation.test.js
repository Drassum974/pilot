// pocket-etat-apres-installation.test.js — APRÈS une installation réussie de la
// voix PocketTTS, l'état affiché se rafraîchit TOUT SEUL.
//
// Défaut constaté par le propriétaire : après le téléchargement/installation des
// poids, la section « Lecture des réponses » continuait d'afficher « — modèle à
// télécharger » et il fallait cliquer « Vérifier à nouveau » pour voir que la
// voix était prête. Le gestionnaire du bouton d'installation se contentait de
// RE-RENDRE l'écran avec l'état MÉMORISÉ (périmé) : il ne relisait rien.
//
// Ce que ces contrôles tiennent, dans l'ordre :
//   1. la relecture suit la FIN RÉELLE de l'installation — jamais un délai qui
//      devine, jamais une boucle : une seule relecture par installation
//      terminée (`pocketRefreshAfterInstall`) ;
//   2. elle passe par le rafraîchissement d'état DÉJÀ existant : la SEULE
//      vérification de la section (`checkLocalVoiceStatus`, celle du bouton
//      « Vérifier à nouveau ») — aucun second mécanisme, aucune duplication ;
//   3. un ÉCHEC ne relit rien et n'efface pas l'état connu, et il n'est jamais
//      annoncé comme un succès ;
//   4. la voix devient réellement disponible et choisissable (le suffixe
//      « modèle à télécharger » disparaît de la liste) ;
//   5. le bouton « Vérifier à nouveau » reste inchangé et utile.
//
// Preuve que ces contrôles mordent : ils ÉCHOUENT sur le code d'avant (les deux
// décisions pures n'existaient pas, et le gestionnaire du bouton ne relisait
// pas l'état) — voir docs/rapports/RAPPORT-pockettts-etat-apres-installation.md.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  getPocketStatus,
  normalizePocketStatus,
  pocketInstallOutcomeNote,
  pocketRefreshAfterInstall,
  pocketStatusNote,
  pocketVoiceChoices,
  refreshPocketStatus,
  setPocketInvoker,
  setPocketStatus,
  POCKET_ENGINE,
  POCKET_NOT_INSTALLED_SUFFIX,
} from "./pocket-voice.js";
import { sliceSource } from "./source-slice.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");

/** Lit un fichier du dépôt (fins de ligne normalisées : piège CI Windows). */
function read(relative) {
  return readFileSync(join(ROOT, relative), "utf8").replace(/\r\n/g, "\n");
}

const SETTINGS_JS = read("src/js/settings.js");
const POCKET_JS = read("src/js/pocket-voice.js");

/** Compte les occurrences d'un motif (les assertions doivent être chiffrées). */
function countOf(text, needle) {
  return text.split(needle).length - 1;
}

/**
 * Le gestionnaire du bouton « Installer la voix PocketTTS » (découpé entre son
 * ouverture et le commentaire du bouton suivant — repères du fichier).
 * @returns {string}
 */
function installHandler() {
  return sliceSource(
    SETTINGS_JS,
    'if (btnReadAloudPocketInstall) {\n    btnReadAloudPocketInstall.addEventListener("click"',
    "// Bouton d'arrêt du téléchargement en cours",
    200,
  );
}

/** État « poids absents » (moteur présent, rien de téléchargé). */
function poidsAbsents() {
  return normalizePocketStatus({
    installed: false,
    engine: POCKET_ENGINE,
    engine_present: true,
    model_present: false,
    engine_absent: false,
    voice: "estelle",
    voice_present: true,
    voices: [{ id: "estelle", label: "PocketTTS — voix de femme (estelle)", gender: "femme" }],
    missing: ["les poids du modèle français (à télécharger sur un geste)"],
    hint: `Les poids de ${POCKET_ENGINE} ne sont pas encore là : un clic sur « Installer la voix ${POCKET_ENGINE} » les télécharge une seule fois.`,
  });
}

/** État « tout installé » (moteur, poids, voix). */
function toutInstalle() {
  return normalizePocketStatus({
    installed: true,
    engine: POCKET_ENGINE,
    engine_present: true,
    model_present: true,
    model_bytes: 209_000_000,
    voice: "estelle",
    voice_present: true,
    voices: [{ id: "estelle", label: "PocketTTS — voix de femme (estelle)", gender: "femme" }],
    missing: [],
    hint: `La voix ${POCKET_ENGINE} est prête : elle fonctionne hors ligne.`,
  });
}

afterEach(() => {
  setPocketStatus(null);
  setPocketInvoker(null);
});

// ── 1. La décision : relire suit la FIN RÉELLE de l'installation ───────────

describe("1. La relecture suit la fin réelle de l'installation", () => {
  it("une installation réussie demande UNE relecture", () => {
    expect(pocketRefreshAfterInstall({ ok: true, message: "Voix PocketTTS installée." })).toBe(true);
  });

  it("un échec ne relit rien (jamais un succès déguisé)", () => {
    expect(pocketRefreshAfterInstall({ ok: false, message: "réseau indisponible" })).toBe(false);
  });

  it("sans installation (aucun retour), rien n'est relu", () => {
    expect(pocketRefreshAfterInstall(null)).toBe(false);
    expect(pocketRefreshAfterInstall(undefined)).toBe(false);
    expect(pocketRefreshAfterInstall({})).toBe(false);
    expect(pocketRefreshAfterInstall("ok")).toBe(false);
    // Un `ok` qui n'est pas le vrai booléen ne vaut pas un succès.
    expect(pocketRefreshAfterInstall({ ok: "true" })).toBe(false);
  });
});

// ── 2. Le branchement : le chemin de vérification DÉJÀ existant ─────────────

describe("2. Le rafraîchissement passe par le chemin existant", () => {
  it("le gestionnaire du bouton relit l'état par `checkLocalVoiceStatus`", () => {
    const handler = installHandler();
    // La décision d'abord…
    expect(handler).toContain("pocketRefreshAfterInstall(result)");
    // …puis LA vérification de la section (celle du bouton « Vérifier à nouveau »).
    expect(handler).toContain("checkLocalVoiceStatus(");
    // Une seule relecture par installation terminée : jamais une boucle.
    expect(countOf(handler, "checkLocalVoiceStatus(")).toBe(1);
    // Aucune seconde source d'état, aucun second mécanisme.
    expect(handler).not.toContain("refreshLocalVoiceStatus(");
    expect(countOf(SETTINGS_JS, "async function checkLocalVoiceStatus(")).toBe(1);
    // Aucun délai qui « devine » la fin du téléchargement, aucune boucle.
    expect(handler).not.toContain("setTimeout");
    expect(handler).not.toContain("setInterval");
  });

  it("l'état relu est celui de la voix Pocket affichée (pas d'un autre moteur)", () => {
    const handler = installHandler();
    // La relecture concerne la valeur courante du réglage : c'est elle que
    // `checkLocalVoiceStatus` transmet à `refreshPocketStatus`.
    expect(handler).toMatch(
      /checkLocalVoiceStatus\(\s*selectReadAloudVoice \? selectReadAloudVoice\.value : ""\s*\)/,
    );
    // Le module de la voix reste le SEUL à interroger la machine pour son état.
    expect(countOf(POCKET_JS, 'POCKET_COMMAND_STATUS = "tts_pocket_status"')).toBe(1);
  });

  it("un échec ne relit pas et n'efface pas l'état connu", () => {
    const handler = installHandler();
    // La relecture est SOUS la garde de la décision (jamais inconditionnelle).
    const garde = handler.indexOf("pocketRefreshAfterInstall(result)");
    const relecture = handler.indexOf("checkLocalVoiceStatus(");
    expect(garde).toBeGreaterThan(-1);
    expect(relecture).toBeGreaterThan(garde);
    // Le chemin d'échec re-rend l'état CONNU (aucune remise à zéro).
    expect(handler).toContain("refreshReadAloudVoice(");
    expect(handler).not.toContain("setPocketStatus(null)");
  });
});

// ── 3. Ce que la ligne d'état dit à la fin ─────────────────────────────────

describe("3. La ligne d'état dit la vérité à la fin de l'installation", () => {
  it("succès confirmé par l'état relu : la voix est annoncée prête", () => {
    const outcome = pocketInstallOutcomeNote(
      { ok: true, message: "Voix PocketTTS installée (200 Mo) : elle fonctionne désormais hors ligne." },
      toutInstalle(),
    );
    expect(outcome.state).toBe("ok");
    expect(outcome.text).toContain("installée");
    // Jamais le suffixe des voix non installées sur une voix prête.
    expect(outcome.text).not.toContain(POCKET_NOT_INSTALLED_SUFFIX);
  });

  it("succès NON confirmé par l'état relu : on dit ce qui manque encore", () => {
    const outcome = pocketInstallOutcomeNote(
      { ok: true, message: "Voix PocketTTS installée." },
      poidsAbsents(),
    );
    // Jamais un succès qui mentirait sur ce que l'utilisateur peut choisir.
    expect(outcome.state).toBe("missing");
    expect(outcome.text).toContain("installée");
    expect(outcome.text).toContain(pocketStatusNote(poidsAbsents()));
  });

  it("échec : la phrase le dit, avec sa cause, et sans effacer l'état connu", () => {
    const etat = poidsAbsents();
    setPocketStatus(etat);
    const outcome = pocketInstallOutcomeNote({ ok: false, message: "réseau indisponible" }, etat);
    expect(outcome.state).toBe("missing");
    expect(outcome.text).toContain("Installation impossible");
    expect(outcome.text).toContain("réseau indisponible");
    expect(outcome.text).toContain("Piper");
    // L'état connu n'est pas effacé par un échec.
    expect(getPocketStatus()).not.toBeNull();
    expect(getPocketStatus().engine_present).toBe(true);
  });

  it("échec sans cause lisible : la phrase reste complète (aucune parenthèse vide)", () => {
    const outcome = pocketInstallOutcomeNote({ ok: false, message: "" }, poidsAbsents());
    expect(outcome.text).toContain("Installation impossible");
    expect(outcome.text).not.toContain("()");
    expect(outcome.text).not.toContain("( )");
  });

  it("le gestionnaire affiche cette phrase unique (aucune seconde formulation)", () => {
    const handler = installHandler();
    expect(handler).toContain("pocketInstallOutcomeNote(");
    expect(handler).toContain("readAloudPocketNote.textContent = outcome.text");
    expect(handler).toContain("readAloudPocketNote.dataset.state = outcome.state");
  });
});

// ── 4. La chaîne RÉELLE : l'état relu rend la voix choisissable ────────────

describe("4. Après relecture, la voix est disponible et choisissable", () => {
  it("le suffixe « modèle à télécharger » disparaît de la liste", async () => {
    // Avant l'installation : l'état connu est « poids absents ».
    setPocketStatus(poidsAbsents());
    const avant = pocketVoiceChoices(getPocketStatus());
    expect(avant).toHaveLength(1);
    expect(avant[0].installed).toBe(false);
    expect(avant[0].label).toContain(POCKET_NOT_INSTALLED_SUFFIX);

    // Fin d'installation : la machine répond « installé » (même commande de
    // statut qu'avant, aucun second mécanisme).
    const calls = [];
    setPocketInvoker(async (command, args) => {
      calls.push({ command, args });
      if (command === "tts_pocket_status") return toutInstalle();
      return null;
    });
    await refreshPocketStatus({ voice: "estelle" });
    expect(calls.map((call) => call.command)).toEqual(["tts_pocket_status"]);

    // …et la liste la propose SANS suffixe : elle est choisissable.
    const apres = pocketVoiceChoices(getPocketStatus());
    expect(apres).toHaveLength(1);
    expect(apres[0].installed).toBe(true);
    expect(apres[0].label).not.toContain(POCKET_NOT_INSTALLED_SUFFIX);
    expect(apres[0].value).toBe("local:pocket:estelle");
  });

  it("une relecture en échec ne fait pas disparaître la voix de la liste", async () => {
    setPocketStatus(toutInstalle());
    setPocketInvoker(async () => {
      throw new Error("IPC indisponible");
    });
    await refreshPocketStatus({ voice: "estelle" });
    const choix = pocketVoiceChoices(getPocketStatus());
    // La panne rend l'état inconnu, jamais « aucune voix » : une ligne honnête
    // reste proposée (le choix mémorisé ne disparaît pas).
    expect(getPocketStatus().unknown).toBe(true);
    expect(choix.length).toBeGreaterThan(0);
    expect(choix[0].label).toContain("état non vérifié");
  });
});

// ── 5. Le bouton « Vérifier à nouveau » reste inchangé et utile ─────────────

describe("5. « Vérifier à nouveau » reste la relecture à la demande", () => {
  it("le bouton appelle toujours la même vérification, sans doublon", () => {
    const bouton = sliceSource(
      SETTINGS_JS,
      "btnReadAloudRecheck.addEventListener",
      "// Progression poussée par le moteur local",
    );
    expect(bouton).toContain("checkLocalVoiceStatus(");
    expect(bouton).not.toContain("refreshPocketStatus(");
    expect(bouton).not.toContain("pocketRefreshAfterInstall(");
    expect(countOf(SETTINGS_JS, "async function checkLocalVoiceStatus(")).toBe(1);
  });
});
