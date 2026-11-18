// Garde des écritures de l'Assistant (pilot-assistant-files.ts) — tests de
// COMPORTEMENT (lot 5, AST-01 partiel : refus sûr + liens symboliques).
//
// On importe la VRAIE extension TypeScript, on enregistre son VRAI callback
// `tool_call` avec un faux `pi` minimal, et on vérifie les décisions réelles
// sur un vrai système de fichiers temporaire. Le dossier personnel est SIMULÉ
// (`node:os.homedir` remplacé) : le vrai `~/.pilot/assistant` et le vrai HOME
// ne sont jamais touchés. Tous les fichiers et liens vivent sous un dossier
// temporaire créé à côté de ce test, supprimé à la fin.
//
// Hors périmètre (NON couvert par ce garde, voir AST-01) : `bash`, les outils
// intégrés de pi, les sessions lancées sans extension, le mode discussion
// seule, les délégations. Les courses entre validation et écriture effective
// ne sont pas éliminables par un hook de validation.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

// Simulated home: the extension computes its root from homedir() at load time.
// Throw if not set so the real home directory can never be used.
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal();
  const homedir = () => {
    const fake = globalThis.__ASSISTANT_GARDE_FAKE_HOME__;
    if (!fake) throw new Error("fake home not set: refusing to use the real home");
    return fake;
  };
  return { ...actual, default: { ...actual, homedir }, homedir };
});

const HERE = dirname(fileURLToPath(import.meta.url));
let BASE;
let HOME;
let ROOT;
let OUTSIDE;
let hook;

/** Ctx ordinaire : cwd dans l'espace assistant, notify enregistré. */
function makeCtx(extra = {}) {
  const notes = [];
  return {
    notes,
    ctx: { cwd: ROOT, ui: { notify: (msg, level) => notes.push({ msg, level }) }, ...extra },
  };
}

async function decide(toolName, input, ctx = makeCtx().ctx) {
  return hook({ toolName, input }, ctx);
}

function expectBlocked(result) {
  expect(result, "le garde devait REFUSER cet appel").toBeTruthy();
  expect(result.block).toBe(true);
  expect(typeof result.reason).toBe("string");
  expect(result.reason.length).toBeGreaterThan(0);
}

beforeAll(async () => {
  BASE = mkdtempSync(join(HERE, ".tmp-assistant-files-garde-"));
  HOME = join(BASE, "home");
  ROOT = join(HOME, ".pilot", "assistant");
  OUTSIDE = join(BASE, "projet-hors-espace");
  mkdirSync(ROOT, { recursive: true });
  mkdirSync(OUTSIDE, { recursive: true });
  writeFileSync(join(OUTSIDE, "existant.txt"), "contenu projet");
  globalThis.__ASSISTANT_GARDE_FAKE_HOME__ = HOME;

  const mod = await import("../../src-tauri/extensions/pilot-assistant-files.ts");
  const hooks = {};
  mod.default({
    on: (event, handler) => {
      (hooks[event] = hooks[event] || []).push(handler);
    },
    registerTool: () => {},
  });
  expect(hooks.tool_call?.length, "un seul hook tool_call enregistré").toBe(1);
  hook = hooks.tool_call[0];
});

afterAll(() => {
  delete globalThis.__ASSISTANT_GARDE_FAKE_HOME__;
  if (BASE) rmSync(BASE, { recursive: true, force: true });
});

describe("défaut 1 — le garde refuse de manière sûre (plus d'autorisation par défaut)", () => {
  it("refuse un write/edit sans chemin, avec un chemin vide ou non textuel", async () => {
    expectBlocked(await decide("write", { content: "x" }));
    expectBlocked(await decide("edit", undefined));
    expectBlocked(await decide("write", { path: "   ", content: "x" }));
    expectBlocked(await decide("edit", { path: 42 }));
  });

  it("refuse un chemin invalide (octet nul) même s'il paraît sous la racine", async () => {
    expectBlocked(await decide("write", { path: join(ROOT, "a\0b", "n.md"), content: "x" }));
  });

  it("refuse sur erreur interne sans planter pi, même si ctx.ui manque ou notify échoue", async () => {
    // No cwd + relative path → internal resolution error.
    await expect(hook({ toolName: "write", input: { path: "n.md" } }, {})).resolves.toMatchObject({
      block: true,
    });
    const throwingUi = {
      ui: {
        notify: () => {
          throw new Error("notify cassé");
        },
      },
    };
    await expect(
      hook({ toolName: "edit", input: { path: "n.md" } }, throwingUi),
    ).resolves.toMatchObject({ block: true });
  });

  it("refuse toujours une écriture hors de l'espace assistant", async () => {
    expectBlocked(await decide("write", { path: join(OUTSIDE, "x.md"), content: "x" }));
    expectBlocked(await decide("edit", { path: join(ROOT, "..", "..", "..", "projet-hors-espace", "existant.txt") }));
  });

  it("laisse passer les appels de consultation et les autres outils (inchangé)", async () => {
    expect(await decide("read", { path: join(OUTSIDE, "existant.txt") })).toBeUndefined();
    expect(await decide("read", {})).toBeUndefined();
    expect(await decide("grep", { pattern: "x", path: OUTSIDE })).toBeUndefined();
    // Bash is NOT covered by this guard (out of scope of this lot, AST-01 remains).
    expect(await decide("bash", { command: "ls" })).toBeUndefined();
  });

  it("autorise une écriture légitime et crée les nouveaux sous-dossiers client/projet", async () => {
    const target = join(ROOT, "client-a", "projet-b", "notes.md");
    expect(await decide("write", { path: target, content: "x" })).toBeUndefined();
    expect(existsSync(dirname(target)), "dossiers parents créés").toBe(true);
    // Relative path from cwd = root.
    expect(await decide("write", { path: "client-c/projet-d/n.md", content: "x" })).toBeUndefined();
    expect(existsSync(join(ROOT, "client-c", "projet-d"))).toBe(true);
    // Existing file edit inside root.
    writeFileSync(join(ROOT, "client-a", "projet-b", "notes.md"), "v1");
    expect(await decide("edit", { path: join(ROOT, "client-a", "projet-b", "notes.md") })).toBeUndefined();
  });
});

describe("défaut 2 — un lien symbolique dans l'espace assistant ne permet pas d'écrire ailleurs", () => {
  it("refuse d'écrire à travers un lien de DOSSIER sortant, sans rien créer hors de l'espace", async () => {
    const link = join(ROOT, "lien-dossier");
    symlinkSync(OUTSIDE, link, "dir");
    expectBlocked(await decide("write", { path: join(link, "x.md"), content: "x" }));
    expectBlocked(await decide("edit", { path: join(link, "existant.txt") }));
    // Deeper target not yet created: nothing may be created outside the space.
    expectBlocked(await decide("write", { path: join(link, "nouveau", "sous", "x.md"), content: "x" }));
    expect(existsSync(join(OUTSIDE, "nouveau")), "aucun dossier créé hors de l'espace").toBe(false);
    // Relative path through the link.
    expectBlocked(await decide("write", { path: "lien-dossier/y.md", content: "x" }));
  });

  it("refuse d'écrire à travers un lien de dossier sortant placé en profondeur", async () => {
    mkdirSync(join(ROOT, "client-z"), { recursive: true });
    symlinkSync(OUTSIDE, join(ROOT, "client-z", "projet"), "dir");
    expectBlocked(await decide("write", { path: join(ROOT, "client-z", "projet", "a", "b.md"), content: "x" }));
    expect(existsSync(join(OUTSIDE, "a"))).toBe(false);
  });

  it("refuse d'écrire à travers un lien de FICHIER sortant existant", async () => {
    const link = join(ROOT, "lien-fichier.txt");
    symlinkSync(join(OUTSIDE, "existant.txt"), link, "file");
    expectBlocked(await decide("write", { path: link, content: "écrasé" }));
    expectBlocked(await decide("edit", { path: link }));
    expect(readFileSync(join(OUTSIDE, "existant.txt"), "utf8")).toBe("contenu projet");
  });

  it("refuse un lien de fichier dont la cible finale n'existe pas encore (hors de l'espace)", async () => {
    const link = join(ROOT, "lien-pendant.md");
    symlinkSync(join(OUTSIDE, "pas-encore-cree.md"), link, "file");
    expectBlocked(await decide("write", { path: link, content: "x" }));
    expect(existsSync(join(OUTSIDE, "pas-encore-cree.md"))).toBe(false);
  });

  it("refuse un « .. » qui, après un lien, sortirait de l'espace", async () => {
    // OS semantics resolve ".." AFTER following the link: root/lien-dossier/../x
    // really is OUTSIDE/../x, while a lexical resolve() says root/x.
    // Raw string on purpose: path.join() would collapse the "..".
    const raw = [ROOT, "lien-dossier", "..", "x.md"].join(sep);
    expectBlocked(await decide("write", { path: raw, content: "x" }));
    expectBlocked(await decide("write", { path: "lien-dossier/../x.md", content: "x" }));
    expect(existsSync(join(BASE, "x.md"))).toBe(false);
  });

  it("autorise encore un lien qui reste DANS l'espace, et les écritures normales à côté des liens", async () => {
    mkdirSync(join(ROOT, "reel", "projet"), { recursive: true });
    symlinkSync(join(ROOT, "reel"), join(ROOT, "alias-interne"), "dir");
    expect(await decide("write", { path: join(ROOT, "alias-interne", "projet", "n.md"), content: "x" })).toBeUndefined();
    expect(await decide("write", { path: join(ROOT, "alias-interne", "neuf", "n.md"), content: "x" })).toBeUndefined();
    expect(existsSync(join(ROOT, "reel", "neuf")), "sous-dossier créé dans l'espace réel").toBe(true);
    expect(await decide("write", { path: join(ROOT, "client-n", "projet-n", "n.md"), content: "x" })).toBeUndefined();
    expect(existsSync(join(ROOT, "client-n", "projet-n"))).toBe(true);
  });

  it("refuse sur erreur de droits pendant la résolution (EACCES), sans autoriser", async () => {
    const closed = join(ROOT, "ferme");
    mkdirSync(join(closed, "sous"), { recursive: true });
    chmodSync(closed, 0o000);
    try {
      // Running as root would bypass permissions: the check would be meaningless.
      expect(process.getuid?.(), "test à lancer sans droits root").not.toBe(0);
      expectBlocked(await decide("write", { path: join(closed, "sous", "x.md"), content: "x" }));
    } finally {
      chmodSync(closed, 0o755);
    }
  });

  it("refuse si un composant intermédiaire est un fichier ordinaire", async () => {
    writeFileSync(join(ROOT, "fichier-plat"), "x");
    expectBlocked(await decide("write", { path: join(ROOT, "fichier-plat", "n.md"), content: "x" }));
  });
});
