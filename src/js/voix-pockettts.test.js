// voix-pockettts.test.js — la voix PocketTTS dans la lecture des réponses.
//
// Mission tenue ici, contrôle par contrôle (exigences de l'utilisateur) :
//   1. elle est AJOUTÉE à la liste unique des voix : aucune voix existante ne
//      disparaît, ne change de valeur ni de libellé (Piper, voix imitée, voix
//      du système) ;
//   2. elle n'est JAMAIS le choix par défaut, et rien ne l'active à la place de
//      l'utilisateur (réglage inchangé, aucun champ de configuration écrit par
//      ce moteur) ;
//   3. AUCUN téléchargement sans geste : la seule fonction capable de faire
//      descendre les poids est appelée par le seul clic du bouton dédié ;
//   4. le repli est ANNONCÉ et la lecture CONTINUE (voix locale puis voix du
//      système) : jamais un silence, jamais un gel, et le mode Vocal sait que
//      Pilot parle pendant ce repli ;
//   5. le genre de chaque voix est écrit EN CLAIR ;
//   6. une voix clonée déposée par l'utilisateur est une voix ORDINAIRE de la
//      même liste (aucun second réglage, aucun mécanisme séparé) ;
//   7. un choix mémorisé ne disparaît jamais de la liste (une panne d'état ne
//      réécrit pas le réglage dans le dos de l'utilisateur) ;
//   8. l'attribution (CC BY 4.0) est écrite une seule fois et affichée.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  isPocketVoiceChoice,
  normalizePocketStatus,
  pocketStatusNote,
  pocketUnavailableLabel,
  pocketVoiceChoices,
  pocketVoiceIdFor,
  pocketVoiceValue,
  setPocketInvoker,
  setPocketStatus,
  synthesizePocketAudio,
  POCKET_ATTRIBUTION,
  POCKET_ENGINE,
  POCKET_INSTALL_LABEL,
  POCKET_NOT_INSTALLED_SUFFIX,
  POCKET_VOICE_PREFIX,
} from "./pocket-voice.js";
import { setLocalVoiceInvoker, setLocalVoiceStatus } from "./local-voice.js";
import { setVoiceStudioInvoker, setVoiceStudioStatus } from "./voicestudio-voice.js";
import {
  createSpeaker,
  isReadAloudSpeaking,
  readAloudPocketFallbackNotice,
  readAloudStateLabel,
  voiceChoiceOptions,
  voiceChoiceStatus,
} from "./read-aloud.js";
import { isUsableVoiceValue } from "./character-voices.js";
// Découpage de source VÉRIFIÉ (jamais `source.indexOf` en ligne : l'inventaire
// `source-slice.test.js` refuse un découpage non protégé).
import { sliceSource } from "./source-slice.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");

/** Lit un fichier du dépôt (fin de lignes normalisées : piège CI Windows). */
function read(relative) {
  return readFileSync(join(ROOT, relative), "utf8").replace(/\r\n/g, "\n");
}

const POCKET_JS = read("src/js/pocket-voice.js");
const READ_ALOUD_JS = read("src/js/read-aloud.js");
const SETTINGS_JS = read("src/js/settings.js");
const MAIN_JS = read("src/js/main.js");
const INDEX_HTML = read("index.html");
const RUST = read("src-tauri/src/tts_pocket.rs");
const LIB_RS = read("src-tauri/src/lib.rs");

// ── Doublures de fenêtre (aucun navigateur requis) ─────────────────────────

/** Voix « système » factice. */
function fakeVoice(name = "Microsoft Hortense", lang = "fr-FR") {
  return { name, lang, voiceURI: name, default: false, localService: true };
}

/** Fenêtre factice : synthèse du système + lecteur audio factice. */
function fakeWindow({ voices = [fakeVoice()] } = {}) {
  const spoken = [];
  const events = [];
  const synth = {
    spoken,
    cancelCalls: 0,
    getVoices: () => voices.slice(),
    speak(utterance) {
      spoken.push(utterance);
      setTimeout(() => utterance.onend && utterance.onend(), 0);
    },
    cancel() {
      synth.cancelCalls += 1;
    },
    addEventListener() {},
    removeEventListener() {},
  };
  class Utterance {
    constructor(text) {
      this.text = text;
      this.lang = "";
      this.voice = null;
      this.onend = null;
      this.onerror = null;
    }
  }
  class FakeAudio {
    constructor(src) {
      this.src = src;
      this.paused = false;
      FakeAudio.played.push(this);
    }
    play() {
      setTimeout(() => this.onended && this.onended(), 0);
      return Promise.resolve();
    }
    pause() {
      this.paused = true;
    }
  }
  FakeAudio.played = [];
  class FakeCustomEvent {
    constructor(type, init) {
      this.type = type;
      this.detail = (init && init.detail) || null;
    }
  }
  return {
    win: {
      speechSynthesis: synth,
      SpeechSynthesisUtterance: Utterance,
      CustomEvent: FakeCustomEvent,
      dispatchEvent(event) {
        events.push(event);
        return true;
      },
      Audio: FakeAudio,
    },
    synth,
    events,
    FakeAudio,
  };
}

/** État PocketTTS « installée » (moteur + poids + voix du moteur). */
function pocketInstalled(extraVoices = []) {
  return {
    installed: true,
    engine: POCKET_ENGINE,
    engine_present: true,
    model_present: true,
    model_bytes: 209_000_000,
    voices: [
      {
        id: "estelle",
        value: pocketVoiceValue(""),
        label: `${POCKET_ENGINE} — voix de femme (estelle)`,
        gender: "femme",
        kind: "moteur",
      },
      ...extraVoices,
    ],
    missing: [],
    hint: "La voix est prête.",
  };
}

/**
 * Invocateur factice. `pocket: "absent"` fait échouer la synthèse PocketTTS
 * comme un moteur non installé ; Piper répond toujours (voix locale installée).
 */
function fakeInvoke(scenario = {}) {
  const calls = [];
  const invoke = async (command, args) => {
    calls.push({ command, args });
    if (command === "tts_pocket_status") {
      return scenario.status || pocketInstalled();
    }
    if (command === "tts_pocket_synthesize") {
      if (scenario.pocket === "absent") throw new Error("moteur PocketTTS introuvable");
      return "UklGRg==";
    }
    if (command === "tts_pocket_log") return null;
    if (command === "tts_local_status") {
      return {
        installed: true,
        voice: args && args.model,
        engine_present: true,
        model_present: true,
        dir: "C:/Pilot/voix-locale",
      };
    }
    if (command === "tts_local_synthesize") return "UklGRg==";
    if (command === "tts_local_log") return null;
    if (command === "tts_voicestudio_status") {
      return { reachable: true, profiles: [{ id: "a772c1b0", name: "Lucie" }], hint: "" };
    }
    if (command === "tts_voicestudio_log" || command === "tts_voicestudio_warmup") return null;
    throw new Error(`commande inattendue: ${command}`);
  };
  return { invoke, calls };
}

/** Attend qu'une condition devienne vraie (jamais un délai arbitraire). */
async function waitUntil(condition, timeoutMs = 5000) {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("condition non atteinte dans le délai imparti (5 s)");
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

beforeEach(() => {
  setPocketStatus(null);
  setPocketInvoker(null);
  setLocalVoiceStatus(null);
  setLocalVoiceInvoker(null);
  setVoiceStudioStatus(null);
  setVoiceStudioInvoker(null);
});

afterEach(() => {
  setPocketStatus(null);
  setPocketInvoker(null);
  setLocalVoiceStatus(null);
  setLocalVoiceInvoker(null);
  setVoiceStudioStatus(null);
  setVoiceStudioInvoker(null);
});

// ---------------------------------------------------------------------------
describe("1. AJOUT et non remplacement : aucune voix existante ne disparaît", () => {
  it("Piper, la voix imitée et les voix du système restent proposées telles quelles", () => {
    const voices = [fakeVoice("Amelie"), fakeVoice("Thomas")];
    setLocalVoiceStatus({
      installed: true,
      model: "fr_FR-siwis-medium",
      engine_present: true,
      model_present: true,
    });
    setVoiceStudioStatus({
      reachable: true,
      profiles: [{ id: "a772c1b0", name: "Lucie" }],
    });
    const pocket = normalizePocketStatus(pocketInstalled());
    const options = voiceChoiceOptions(
      voices,
      { installed: true },
      { reachable: true, profiles: [{ id: "a772c1b0", name: "Lucie" }] },
      "",
      pocket,
    );
    const values = options.map((option) => option.value);
    // Le choix « automatique » reste le PREMIER : le comportement par défaut ne
    // bouge pas d'un pouce.
    expect(values[0]).toBe("");
    // Les voix françaises locales (Piper) sont toujours là, avec leurs valeurs.
    expect(values).toContain("local:piper");
    // La voix imitée aussi.
    expect(values).toContain("local:voicestudio:a772c1b0");
    // Les voix du système aussi.
    expect(values).toContain("Amelie");
    expect(values).toContain("Thomas");
    // …et la nouvelle venue est AJOUTÉE, pas substituée.
    expect(values).toContain(POCKET_VOICE_PREFIX);
    // Chaque valeur est unique : aucune voix n'en écrase une autre.
    expect(new Set(values).size).toBe(values.length);
  });

  it("les libellés existants ne sont ni renommés ni réécrits par ce moteur", () => {
    // `voiceChoiceOptions` ne réécrit QUE les libellés Pocket : ceux de Piper
    // viennent de `local-voice.js` et ceux de la voix imitée de
    // `voicestudio-voice.js` — ce fichier ne les touche pas.
    expect(POCKET_JS).not.toMatch(/voix d'homme\b(?!.*Piper)/);
    expect(POCKET_JS).not.toMatch(/Ma voix imitée/);
    expect(READ_ALOUD_JS).not.toMatch(/LOCAL_VOICE_INSTALL_LABEL\s*=/);
  });
});

// ---------------------------------------------------------------------------
describe("2. Jamais par défaut : personne ne l'active à la place de l'utilisateur", () => {
  it("le champ de réglage n'est jamais écrit par ce moteur (aucun auto-choix)", () => {
    // Le module ne connaît AUCUN chemin d'écriture de configuration : il ne
    // sauvegarde rien, il ne choisit rien.
    expect(POCKET_JS).not.toMatch(/save_config|setConfig|applyVoicePreference/);
    // Et le module Rust non plus (le réglage de voix ne le concerne pas : il ne
    // lit ni n'écrit aucune configuration).
    expect(RUST).not.toMatch(/AppConfig|save_config|set_config/);
    // Aucune valeur Pocket n'est fabriquée sans que l'utilisateur l'ait choisie :
    // la valeur par défaut du réglage reste la chaîne vide (« automatique »).
    expect(LIB_RS).toMatch(/read_aloud_voice/);
    expect(pocketVoiceIdFor("")).toBe(null);
    expect(isPocketVoiceChoice("")).toBe(false);
  });

  it("le choix « automatique » passe avant PocketTTS, dans les deux fonctions", () => {
    const voices = [fakeVoice("Amelie")];
    const pocket = normalizePocketStatus(pocketInstalled());
    // Rendu sans aucun choix mémorisé : la valeur renvoyée reste « automatique ».
    const status = voiceChoiceStatus(voices, "", null, null, pocket);
    expect(status.value).toBe("");
    expect(status.kind).not.toBe("pocket-unknown");
    expect(status.kind).not.toBe("pocket-missing");
    // Et la première option reste la valeur vide.
    expect(voiceChoiceOptions(voices, null, null, "", pocket)[0].value).toBe("");
  });

  it("aucun réglage de démarrage ne la sélectionne (main.js ne la connaît pas)", () => {
    expect(MAIN_JS).not.toMatch(/pocket/i);
  });
});

// ---------------------------------------------------------------------------
describe("3. Aucun téléchargement sans geste", () => {
  it("la seule fonction qui télécharge est appelée par le seul clic du bouton", () => {
    // Une seule définition, dans le module de la voix.
    const definitions = POCKET_JS.match(/export async function installPocketWeights/g) || [];
    expect(definitions).toHaveLength(1);
    // Aucun autre fichier de production ne l'appelle.
    const appels = ["src/js/read-aloud.js", "src/js/character-voices.js", "src/js/main.js"].map(
      (file) => (read(file).match(/installPocketWeights/g) || []).length,
    );
    expect(appels).toEqual([0, 0, 0]);
    // Dans les Paramètres : un seul appel, DANS le gestionnaire du bouton.
    const handler = sliceSource(
      SETTINGS_JS,
      'if (btnReadAloudPocketInstall) {\n    btnReadAloudPocketInstall.addEventListener("click"',
      "// Bouton d'arrêt du téléchargement en cours",
      200,
    );
    expect(handler).toContain("installPocketWeights(");
    const total = (SETTINGS_JS.match(/installPocketWeights\(/g) || []).length;
    // import + un appel dans le gestionnaire = 2 occurrences au plus.
    expect(total).toBeLessThanOrEqual(2);
  });

  it("la lecture et l'ouverture de l'écran ne déclenchent aucun téléchargement", () => {
    // La vérification d'état (au rendu, au démarrage, avant lecture) ne peut pas
    // télécharger : la commande de statut NE FAIT QUE LIRE des fichiers.
    expect(POCKET_JS).toMatch(/POCKET_COMMAND_STATUS = "tts_pocket_status"/);
    expect(RUST).toMatch(/pub fn tts_pocket_status/);
    const status_fonction = sliceSource(RUST, "pub fn status_for_dir", "/// ", 200);
    // Aucun appel du moteur (donc aucune requête réseau) dans la lecture d'état.
    expect(status_fonction).not.toMatch(/run_engine|install_weights/);
    // Et la synthèse ne télécharge rien : son seul appelant réseau possible est
    // un `run_engine`, exécuté sur un texte déjà fourni.
    const synthese = sliceSource(RUST, "pub fn synthesize_base64", "/// ", 200);
    expect(synthese).not.toMatch(/install_weights/);
  });

  it("le libellé du bouton dit ce qu'il fait, et il n'apparaît que s'il manque quelque chose", () => {
    expect(POCKET_INSTALL_LABEL).toBe("Installer la voix PocketTTS");
    expect(INDEX_HTML).toContain(POCKET_INSTALL_LABEL);
    expect(SETTINGS_JS).toMatch(/btnReadAloudPocketInstall\.style\.display = manque \? "" : "none";/);
  });
});

// ---------------------------------------------------------------------------
describe("4. Repli ANNONCÉ : la lecture continue, et l'écran le dit", () => {
  it("moteur absent : l'état `pocket-fallback` est publié, puis Piper parle", async () => {
    const { win, events } = fakeWindow();
    const { invoke, calls } = fakeInvoke({ pocket: "absent" });
    const speaker = createSpeaker(win, {
      invoke,
      voiceName: pocketVoiceValue("estelle"),
    });
    const states = [];
    const ok = await speaker.speak("Bonjour. Voici une phrase courte.", {
      onstate: (state) => states.push(state),
    });
    expect(ok).toBe(true);
    // PocketTTS a bien été DEMANDÉE (aucun contournement silencieux).
    expect(calls.some((call) => call.command === "tts_pocket_synthesize")).toBe(true);
    // Le repli est DIT.
    expect(states).toContain("pocket-fallback");
    // …et il est JOURNALISÉ (une ligne, comme les autres replis).
    await waitUntil(() => calls.some((call) => call.command === "tts_pocket_log"));
    // …puis c'est bien la voix locale (Piper) qui a parlé.
    await waitUntil(() => calls.some((call) => call.command === "tts_local_synthesize"));
    // L'état publié aux autres écrans (mode Vocal) annonce le repli : le micro
    // sait donc que Pilot parle, et la veille ne s'arme pas en pleine phrase.
    const fallback = events.find(
      (event) => event.detail && event.detail.state === "pocket-fallback",
    );
    expect(fallback, "l'état de repli doit être publié").toBeTruthy();
    expect(isReadAloudSpeaking("pocket-fallback")).toBe(true);
    expect(isReadAloudSpeaking("speaking")).toBe(true);
    expect(isReadAloudSpeaking("idle")).toBe(false);
  });

  it("la phrase du repli nomme la voix qui parle à la place", () => {
    const phrase = readAloudPocketFallbackNotice("moteur introuvable");
    expect(phrase).toContain(POCKET_ENGINE);
    expect(phrase).toContain("indisponible");
    expect(phrase).toContain("Piper");
    // Sans cause connue, la phrase reste complète (jamais une parenthèse vide).
    expect(readAloudPocketFallbackNotice()).not.toContain("()");
    // L'état des Paramètres dit la même chose, avec le journal.
    expect(readAloudStateLabel("pocket-fallback")).toContain(POCKET_ENGINE);
    expect(readAloudStateLabel("pocket-fallback")).toContain("Piper");
    // Le chemin existe bien dans le module de lecture (aucun repli muet).
    expect(READ_ALOUD_JS).toContain('notify("pocket-fallback"');
  });

  it("un moteur qui parle ne déclenche aucun repli (le chemin normal marche)", async () => {
    const { win, events } = fakeWindow();
    const { invoke, calls } = fakeInvoke();
    const speaker = createSpeaker(win, { invoke, voiceName: pocketVoiceValue("estelle") });
    const states = [];
    await speaker.speak("Bonjour. Voici une phrase courte.", {
      onstate: (state) => states.push(state),
    });
    expect(calls.some((call) => call.command === "tts_pocket_synthesize")).toBe(true);
    expect(states).not.toContain("pocket-fallback");
    expect(states).toContain("ended");
    // Aucun repli Piper quand le moteur répond.
    expect(calls.some((call) => call.command === "tts_local_synthesize")).toBe(false);
    const ended = events.find((event) => event.detail && event.detail.state === "ended");
    expect(ended).toBeTruthy();
  });

  it("une panne de la synthèse ne lève jamais : elle rend une cause lisible", async () => {
    setPocketInvoker(async () => {
      throw new Error("service injoignable");
    });
    const result = await synthesizePocketAudio("Bonjour.", { voice: "estelle" });
    expect(result.audio).toBe(null);
    expect(result.reason).toContain("service injoignable");
    // Un texte vide ne demande rien du tout.
    const vide = await synthesizePocketAudio("   ", { voice: "estelle" });
    expect(vide.audio).toBe(null);
    expect(vide.reason).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
describe("5. Le genre est écrit EN CLAIR", () => {
  it("chaque voix annoncée dit son genre en toutes lettres", () => {
    const options = pocketVoiceChoices(normalizePocketStatus(pocketInstalled()));
    expect(options).toHaveLength(1);
    expect(options[0].label).toContain("voix de femme");
    expect(options[0].label).toContain("estelle");
    // Une voix imitée n'invente pas de genre : elle est dite « imitée ».
    const avecImitee = pocketVoiceChoices(
      normalizePocketStatus(
        pocketInstalled([
          {
            id: "ma-voix",
            value: pocketVoiceValue("ma-voix"),
            label: `${POCKET_ENGINE} — voix imitée (ma-voix)`,
            gender: "",
            kind: "imitee",
          },
        ]),
      ),
    );
    expect(avecImitee[1].label).toContain("voix imitée");
    expect(avecImitee[1].label).not.toContain("voix de femme");
  });

  it("le module Rust écrit le genre dans la MÊME table que la voix", () => {
    expect(RUST).toMatch(/voix de femme/);
    expect(RUST).toMatch(/voix d'homme/);
  });
});

// ---------------------------------------------------------------------------
describe("6. Une voix clonée est une voix ORDINAIRE de la même liste", () => {
  it("les voix déposées par l'utilisateur apparaissent sans mécanisme séparé", () => {
    const status = normalizePocketStatus(
      pocketInstalled([
        {
          id: "voix-de-test",
          value: pocketVoiceValue("voix-de-test"),
          label: `${POCKET_ENGINE} — voix imitée (voix-de-test)`,
          gender: "",
          kind: "imitee",
        },
      ]),
    );
    const options = pocketVoiceChoices(status);
    expect(options.map((option) => option.value)).toEqual([
      POCKET_VOICE_PREFIX,
      `${POCKET_VOICE_PREFIX}:voix-de-test`,
    ]);
    // Les deux valeurs sont utilisables COMME N'IMPORTE QUELLE AUTRE VOIX,
    // y compris comme voix d'un personnage : aucune grammaire séparée.
    expect(isUsableVoiceValue(POCKET_VOICE_PREFIX)).toBe(true);
    expect(isUsableVoiceValue(`${POCKET_VOICE_PREFIX}:voix-de-test`)).toBe(true);
    // …et la valeur voyage dans le MÊME champ que les autres voix.
    expect(RUST).toMatch(/VOICE_VALUE_PREFIX: &str = "local:pocket";/);
  });

  it("la valeur du réglage fait l'aller-retour sans rien perdre", () => {
    expect(pocketVoiceValue("")).toBe(POCKET_VOICE_PREFIX);
    expect(pocketVoiceIdFor(POCKET_VOICE_PREFIX)).toBe("");
    expect(pocketVoiceValue("ma-voix")).toBe(`${POCKET_VOICE_PREFIX}:ma-voix`);
    expect(pocketVoiceIdFor(`${POCKET_VOICE_PREFIX}:ma-voix`)).toBe("ma-voix");
    // Les autres moteurs ne sont JAMAIS pris pour celui-ci.
    expect(pocketVoiceIdFor("local:piper")).toBe(null);
    expect(pocketVoiceIdFor("local:voicestudio:abc")).toBe(null);
    expect(pocketVoiceIdFor("Amelie")).toBe(null);
    expect(pocketVoiceIdFor("localhost")).toBe(null);
  });
});

// ---------------------------------------------------------------------------
describe("7. Un choix mémorisé ne disparaît jamais de la liste", () => {
  it("une voix retirée du disque reste annoncée, et le réglage n'est pas réécrit", () => {
    const status = normalizePocketStatus(pocketInstalled());
    const options = voiceChoiceOptions(
      [fakeVoice("Amelie")],
      null,
      null,
      `${POCKET_VOICE_PREFIX}:disparue`,
      status,
    );
    const entry = options.find((option) => option.value === `${POCKET_VOICE_PREFIX}:disparue`);
    expect(entry, "le choix mémorisé doit rester dans la liste").toBeTruthy();
    expect(entry.label).toContain("disparue");
    expect(pocketUnavailableLabel(`${POCKET_VOICE_PREFIX}:disparue`, status)).toBeTruthy();
  });

  it("un état illisible ne fait pas disparaître la voix non plus", () => {
    const inconnu = normalizePocketStatus(null);
    expect(inconnu.unknown).toBe(true);
    const options = pocketVoiceChoices(inconnu);
    expect(options).toHaveLength(1);
    expect(options[0].value).toBe(POCKET_VOICE_PREFIX);
    expect(options[0].label).toContain("état non vérifié");
    // La phrase d'état rappelle toujours le repli (jamais un silence).
    expect(pocketStatusNote(inconnu)).toContain("Piper");
    // Et un état « absent » garde la voix proposée, avec l'état d'installation.
    const absent = normalizePocketStatus({
      installed: false,
      engine_present: false,
      model_present: false,
      voices: [],
      hint: "Le moteur n'est pas là.",
    });
    expect(pocketStatusNote(absent)).toBe("Le moteur n'est pas là.");
    expect(pocketVoiceChoices(absent)).toHaveLength(1);
    expect(pocketVoiceChoices(absent)[0].label).toContain("état non vérifié");
  });

  it("une voix installée mais sans poids est dite « à télécharger »", () => {
    const status = normalizePocketStatus({
      installed: false,
      engine_present: true,
      model_present: false,
      voices: [
        {
          id: "estelle",
          value: POCKET_VOICE_PREFIX,
          label: `${POCKET_ENGINE} — voix de femme (estelle)`,
          gender: "femme",
        },
      ],
      hint: "Les poids manquent.",
    });
    const options = pocketVoiceChoices(status);
    expect(options[0].label).toContain(POCKET_NOT_INSTALLED_SUFFIX);
    expect(options[0].installed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe("8. Attribution (CC BY 4.0) : écrite une seule fois, et affichée", () => {
  it("la phrase d'attribution est unique dans tout le front", () => {
    expect(POCKET_ATTRIBUTION).toBe("Pocket TTS © Kyutai Labs — CC BY 4.0");
    const fichiers = ["src/js/pocket-voice.js", "src/js/settings.js", "src/js/read-aloud.js"];
    const porteurs = fichiers.filter((file) => read(file).includes("Kyutai Labs"));
    expect(porteurs).toEqual(["src/js/pocket-voice.js"]);
    // Affichée dans la section « Lecture des réponses », avec la mention de licence.
    expect(INDEX_HTML).toContain("Kyutai Labs");
    expect(INDEX_HTML).toContain("CC BY 4.0");
    // Et côté machine, une seule constante, testée par Rust.
    const constante = RUST.match(/pub const ATTRIBUTION: &str = "[^"]+";/g) || [];
    expect(constante).toHaveLength(1);
    expect(constante[0]).toContain("Kyutai Labs");
  });
});
