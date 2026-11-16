// VERROU DE RUN — « un verrou ne survit JAMAIS à la disparition de son
// propriétaire » (docs/rapports/RAPPORT-verrou-de-run-bloque-la-file.md).
//
// Trois causes réunies ici, chacune mise en échec par un test :
//   1. la vidange de file répondait « lancé » même quand le lancement était
//      REFUSÉ (une entrée présente suffisait) → le verrou croyait avoir un
//      propriétaire alors qu'aucun run n'avait démarré ;
//   2. une demande dont la mission propriétaire a disparu (arrêt d'agent →
//      contexte de run détruit) tenait le verrou À VIE ;
//   3. le chien de garde ANTIDAITAIT sa propre preuve d'inactivité : chaque
//      passage réécrivait `lastActivityAt` à l'instant présent, donc le
//      balayage périodique rafraîchissait le verrou qu'il devait faire tomber.
//
// Les décisions vivent dans le module PUR `verrou-de-run.js` (invariants A/B/C/D
// documentés en tête) ; les tests de comportement passent par le VRAI bus
// (`agents-bus.js`) avec le même harnais que `file-attente-regle-4.test.js`
// (aucun DOM, aucun accès Tauri réel).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.hoisted(() => {
  const noop = () => {};
  const el = () => ({
    addEventListener: noop,
    removeEventListener: noop,
    appendChild: noop,
    remove: noop,
    classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
    style: {},
    dataset: {},
    querySelector: () => null,
    querySelectorAll: () => [],
    setAttribute: noop,
    getAttribute: () => null,
    focus: noop,
    scrollIntoView: noop,
    insertAdjacentHTML: noop,
    innerHTML: "",
    textContent: "",
    value: "",
  });
  globalThis.window = globalThis;
  globalThis.addEventListener = noop;
  globalThis.removeEventListener = noop;
  globalThis.dispatchEvent = noop;
  globalThis.document = {
    createElement: el,
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: noop,
    removeEventListener: noop,
    body: el(),
    documentElement: el(),
  };
  globalThis.localStorage = { getItem: () => null, setItem: noop, removeItem: noop };
  globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(0), 0);
  globalThis.cancelAnimationFrame = () => {};
  globalThis.matchMedia = () => ({ matches: false, addEventListener: noop, removeEventListener: noop });
});

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: vi.fn(async () => true),
  requestPermission: vi.fn(async () => "granted"),
  sendNotification: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: vi.fn(), exit: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import {
  beginRun,
  endRun,
  initAgentsBus,
  launchNextQueuedForProject,
  exclusivityQueueOfProject,
  sweepOrphanRunLocks,
  getProjectRunLockInfo,
  RUN_LOCK_SWEEP_MIN_IDLE_MS,
  RUN_LOCK_SWEEP_START_GRACE_MS,
} from "./agents-bus.js";
import { enqueueExclusivity, exclusivityKey } from "./exclusivity-queue.js";
import {
  decideActivityStamp,
  decideQueueDrain,
  decideQueuedDemandPlacement,
  decideRunLockAfterDrain,
  RUN_ACTIVITY_AGENT_EVENT,
  RUN_ACTIVITY_TURN_LAUNCHED,
  RUN_ACTIVITY_WATCHDOG,
  RUN_LOCK_KEEP,
  RUN_LOCK_RELEASE,
  QUEUE_REFUSED_OWNER_GONE,
} from "./verrou-de-run.js";

const T0 = Date.parse("2026-11-16T10:00:00.000Z");
const P = "verrou-de-run-projet";

const busRuns = () => globalThis.__agentBusState.runs;
/** Runs vivantes d'un projet (contexte encore présent dans le bus). */
const lockInfo = (project = P) => getProjectRunLockInfo(project);
/** Journal des arrêts automatiques réellement ÉCRITS par l'application. */
function journalLines() {
  return vi
    .mocked(invoke)
    .mock.calls.filter(
      ([cmd, args]) => cmd === "write_file_content" && args && args.path && /agent-stops\.log$/.test(args.path),
    )
    .map(([, args]) => String(args.content || ""));
}
const lastJournal = () => {
  const lines = journalLines();
  return lines.length ? lines[lines.length - 1] : "";
};
/** Laisse tourner les écritures de journal lancées sans `await` (`.catch()`). */
const flushAsync = async () => {
  for (let i = 0; i < 12; i++) await new Promise((r) => setImmediate(r));
};

/**
 * Pose une demande en file d'exclusivité dont la mission propriétaire n'existe
 * plus (arrêt d'agent → contexte de run détruit). C'est l'état exact du défaut :
 * la file vit au niveau du PROJET et survit donc à la run qui l'a remplie.
 */
function orphanDemandInQueue(project = P, agentId = "codeur", brief = "demande restée en file") {
  const queue = exclusivityQueueOfProject(project);
  enqueueExclusivity(queue, agentId, project, { agentId, brief, project });
  const entry = queue[exclusivityKey(project, agentId)][0];
  entry.ownerRunKey = `${project}#read:404`; // run inexistante (contexte détruit)
  return queue[exclusivityKey(project, agentId)];
}

beforeEach(() => {
  // Horloge figée pour les décisions de temps ; `setImmediate` reste RÉEL pour
  // pouvoir laisser tourner les écritures de journal lancées sans `await`.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(T0);
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async (cmd) => {
    if (cmd === "list_agents") {
      return {
        agents: [
          { id: "codeur", name: "Codeur", readonly: false, models: { pi: "openai/gpt-4o" }, keep_context: true },
        ],
      };
    }
    if (cmd === "get_config") return {};
    // Aucune session ne travaille : le propriétaire est bien mort.
    if (cmd === "list_agent_sessions" || cmd === "agent_activity_probe") return { sessions: [] };
    return undefined;
  });
});

afterEach(() => {
  for (const key of Object.keys(busRuns())) delete busRuns()[key];
  // La file d'exclusivité vit au niveau du PROJET (elle survit aux runs) : on la
  // vide entre deux tests, sans quoi les demandes s'y accumuleraient.
  const projectQueue = exclusivityQueueOfProject(P);
  for (const key of Object.keys(projectQueue)) delete projectQueue[key];
  vi.useRealTimers();
});

// ── Le module de décision (invariants A, B, C, D) ──────────────────────────
describe("verrou-de-run (décisions pures)", () => {
  it("A — « lancé » veut dire qu'un run a RÉELLEMENT démarré, jamais qu'une entrée existait", () => {
    const refused = decideQueueDrain([{ agentId: "codeur", launched: false, reason: QUEUE_REFUSED_OWNER_GONE }]);
    expect(refused.launched).toBe(false);
    expect(refused.orphans.map((o) => o.agentId)).toEqual(["codeur"]);
    expect(refused.sentence).toContain("n'existe plus");

    const launched = decideQueueDrain([{ agentId: "codeur", launched: true, reason: "launched" }]);
    expect(launched.launched).toBe(true);
    expect(launched.launchedAgents).toEqual(["codeur"]);

    expect(decideQueueDrain([])).toMatchObject({ launched: false, refused: [] });
  });

  it("B — un refus LIBÈRE le verrou même s'il reste des demandes en file, et le dit", () => {
    const drain = decideQueueDrain([{ agentId: "codeur", launched: false, reason: QUEUE_REFUSED_OWNER_GONE }]);
    const decision = decideRunLockAfterDrain({ drain, pending: 3, door: "ghosts" });
    expect(decision.action).toBe(RUN_LOCK_RELEASE);
    expect(decision.reason).toBe("replay-refused");
    expect(decision.sentence).toContain("LIBÉRÉ");
    // Les demandes restent VISIBLES et abandonnables : elles ne sont pas niées.
    expect(decision.sentence).toContain("3 demande(s) restent en file");

    // Un run réellement démarré conserve le verrou.
    const ok = decideRunLockAfterDrain({
      drain: decideQueueDrain([{ agentId: "codeur", launched: true }]),
      pending: 2,
      door: "ghosts",
    });
    expect(ok.action).toBe(RUN_LOCK_KEEP);

    // Rien de tenté → rien ne porte le verrou.
    expect(decideRunLockAfterDrain({ drain: decideQueueDrain([]), pending: 0 }).action).toBe(RUN_LOCK_RELEASE);
  });

  it("C — une demande orpheline n'est jamais exécutée dans un contexte étranger", () => {
    expect(decideQueuedDemandPlacement({ ownerKey: "", ownerAlive: true })).toMatchObject({
      placement: "launch",
      reason: "owner-unknown",
    });
    expect(decideQueuedDemandPlacement({ ownerKey: "p#read:7", ownerAlive: true })).toMatchObject({
      placement: "launch",
    });
    expect(decideQueuedDemandPlacement({ ownerKey: "p#read:404", ownerAlive: false })).toMatchObject({
      placement: "keep-orphan",
      reason: QUEUE_REFUSED_OWNER_GONE,
    });
  });

  it("D — le chien de garde n'horodate jamais l'activité, et l'horodatage ne recule jamais", () => {
    const previous = T0 - 10 * 60 * 1000;
    // Le chien de garde ne prouve RIEN : sa propre preuve n'est pas antidatée.
    expect(decideActivityStamp({ source: RUN_ACTIVITY_WATCHDOG, now: T0, previous })).toEqual({
      stamped: false,
      lastActivityAt: previous,
    });
    // Une preuve réelle horodate…
    expect(decideActivityStamp({ source: RUN_ACTIVITY_AGENT_EVENT, now: T0, previous })).toEqual({
      stamped: true,
      lastActivityAt: T0,
    });
    expect(decideActivityStamp({ source: RUN_ACTIVITY_TURN_LAUNCHED, now: T0, previous: null }).lastActivityAt).toBe(T0);
    // …mais ne fait JAMAIS reculer l'horodatage (monotonie).
    expect(decideActivityStamp({ source: RUN_ACTIVITY_AGENT_EVENT, now: previous, previous: T0 }).lastActivityAt).toBe(T0);
  });
});

// ── 1. Le rejeu d'une demande orpheline est un REFUS, et il est dit ────────
describe("rejeu d'une demande dont la mission propriétaire a disparu", () => {
  it("le rejeu rend « launched: false » (motif nommé), CONSERVE la demande et journalise — jamais un faux lancement", async () => {
    await initAgentsBus({});
    const ctx = beginRun(P, {});
    ctx.lastActivityAt = T0 - 10 * 60 * 1000;
    const entries = orphanDemandInQueue();

    const outcome = await launchNextQueuedForProject("codeur", P);
    expect(outcome, "le rejeu doit rendre son verdict à l'appelant").toMatchObject({
      launched: false,
      reason: QUEUE_REFUSED_OWNER_GONE,
    });
    // RÈGLE 4 : la demande est CONSERVÉE, jamais perdue et jamais exécutée pour
    // une autre mission.
    expect(entries).toHaveLength(1);
    expect(entries[0].brief).toBe("demande restée en file");
    // Le refus est DIT (journal des arrêts, motif existant).
    await flushAsync();
    expect(lastJournal()).toContain("reason=queue-replay-no-owner");
    expect(lastJournal()).toContain("agent=codeur");
  });
});

// ── 2. Le verrou ne survit pas à son propriétaire (arrêt d'agent) ──────────
describe("arrêt d'agent → le verrou du projet est réellement libéré", () => {
  it("un verrou dont la seule demande est orpheline est libéré (au plus tard à la revérification), la demande restant en file", async () => {
    await initAgentsBus({});
    const ctx = beginRun(P, {});
    // Travail encore attendu (pending > 0) mais plus AUCUN agent porteur :
    // c'est la porte `orphanQueue` — exactement l'état après l'arrêt d'un agent.
    ctx.parallelGroup = { assignments: [{ agentId: "codeur" }], pending: 1, results: {} };
    ctx.lastActivityAt = T0 - 5 * 60 * 1000;
    const entries = orphanDemandInQueue();
    expect(lockInfo().blocked, "le projet est bien verrouillé avant le balayage").toBe(true);

    const released = await sweepOrphanRunLocks(T0);
    // La porte `orphanQueue` exige DEUX mesures concordantes (garde-fou existant
    // conservé) : la première arme la revérification, la seconde libère.
    vi.setSystemTime(T0 + 31 * 1000);
    const released2 = await sweepOrphanRunLocks(T0 + 31 * 1000);
    expect([...released, ...released2], "le verrou doit être libéré, pas conservé pour une tentative ratée").toContain(P);
    expect(busRuns()[P]).toBeUndefined();
    expect(lockInfo().blocked, "une nouvelle demande doit pouvoir démarrer").toBe(false);
    // RÈGLE 4 : la demande n'a pas été sacrifiée pour libérer le verrou.
    expect(entries).toHaveLength(1);
  });

  it("après l'arrêt, une NOUVELLE demande démarre tout de suite (le verrou ne bloque plus)", async () => {
    await initAgentsBus({});
    const dead = beginRun(P, {});
    dead.parallelGroup = { assignments: [{ agentId: "codeur" }], pending: 1, results: {} };
    dead.lastActivityAt = T0 - 5 * 60 * 1000;
    orphanDemandInQueue();
    await sweepOrphanRunLocks(T0);
    vi.setSystemTime(T0 + 31 * 1000);
    await sweepOrphanRunLocks(T0 + 31 * 1000);
    expect(busRuns()[P]).toBeUndefined();

    // Nouvelle demande : une run NEUVE, sans attente.
    vi.setSystemTime(T0 + 40 * 1000);
    const fresh = beginRun(P, {});
    expect(fresh).toBeTruthy();
    expect(fresh.runState).toBe("running");
    expect(lockInfo().blocked).toBe(true);
    endRun(P, fresh.generation);
  });
});

// ── 3. Le chien de garde ne rafraîchit plus le verrou qu'il doit faire tomber ─
describe("chien de garde — l'horodatage d'inactivité est fiable", () => {
  it("le balayage périodique libère le verrou : chaque passage ne réarme plus le compte à zéro", async () => {
    await initAgentsBus({});
    const ctx = beginRun(P, {});
    ctx.parallelGroup = { assignments: [{ agentId: "codeur" }], pending: 1, results: {} };
    const idleSince = T0 - 5 * 60 * 1000;
    ctx.lastActivityAt = idleSince;
    orphanDemandInQueue();

    // Quatre passages espacés de RUN_LOCK_SWEEP_MS : le verrou tombe au premier
    // et surtout il ne se RALLUME pas tout seul (avant le correctif, chaque
    // passage réécrivait `lastActivityAt` et repoussait la libération de
    // RUN_LOCK_SWEEP_MIN_IDLE_MS à chaque fois → jamais libéré).
    for (let i = 0; i < 4; i++) {
      vi.setSystemTime(T0 + i * 31 * 1000);
      await sweepOrphanRunLocks(T0 + i * 31 * 1000);
      if (busRuns()[P]) {
        // Le verrou encore tenu doit prouver une activité RÉELLE, jamais celle
        // de son observateur.
        expect(busRuns()[P].lastActivityAt).toBeLessThanOrEqual(idleSince);
      }
    }
    expect(busRuns()[P], "un verrou bloqué ne se rafraîchit plus lui-même").toBeUndefined();
    expect(lockInfo().blocked).toBe(false);
  });

  it("des demandes présentes mais NON tentables (clé de file inutilisable) conservent le verrou — aucune mission perdue", async () => {
    await initAgentsBus({});
    const ctx = beginRun(P, {});
    ctx.parallelGroup = { assignments: [{ agentId: "codeur" }], pending: 1, results: {} };
    ctx.lastActivityAt = T0 - 5 * 60 * 1000;
    // Clé sans séparateur : le rejeu ne peut pas nommer l'agent à relancer. On
    // ignore alors qui porte la demande — libérer le verrou l'abandonnerait.
    ctx.exclusivityQueue["cle-invalide"] = [{ agentId: "codeur", brief: "travail en attente", project: P }];

    await sweepOrphanRunLocks(T0);
    vi.setSystemTime(T0 + 31 * 1000);
    await sweepOrphanRunLocks(T0 + 31 * 1000);

    expect(busRuns()[P], "une demande non tentable ne justifie pas d'abandonner le verrou").toBeTruthy();
    expect(ctx.exclusivityQueue["cle-invalide"], "la demande reste intacte en file").toHaveLength(1);
  });

  it("un run réellement relancé CONSERVE le verrou (le correctif ne casse pas le cas légitime)", async () => {
    await initAgentsBus({});
    const ctx = beginRun(P, {});
    // Demande en file dont le propriétaire est la run VIVANTE : elle peut être
    // relancée dans son propre contexte.
    const queue = exclusivityQueueOfProject(P);
    enqueueExclusivity(queue, "codeur", P, { agentId: "codeur", brief: "mission légitime A", project: P });
    queue[exclusivityKey(P, "codeur")][0].ownerRunKey = ctx.runKey;
    ctx.parallelGroup = { assignments: [{ agentId: "codeur" }], pending: 1, results: {} };
    ctx.lastActivityAt = T0 - 5 * 60 * 1000;

    await sweepOrphanRunLocks(T0);
    expect(busRuns()[P], "une relance RÉELLE conserve le verrou").toBeTruthy();
    // Le lancement réel est la SEULE preuve d'activité, et elle est fraîche.
    expect(busRuns()[P].lastActivityAt).toBeGreaterThanOrEqual(T0);
    // Le prompt est bien parti vers l'agent (lancement effectif, pas « essayé »).
    const prompts = vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === "send_agent_process_prompt");
    expect(prompts.length).toBeGreaterThan(0);
  });
});

// ── Invariants de câblage : une seule décision, aucun second mécanisme ────
describe("verrou-de-run — invariants de câblage", () => {
  it("agents-bus.js n'horodate l'activité que par `stampRunActivity` (aucun réarmement ne réécrit la preuve)", async () => {
    const { readFileSync } = await import("node:fs");
    const busSrc = readFileSync(new URL("./agents-bus.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
    // Un seul endroit écrit `lastActivityAt` : la décision du module pur.
    const writes = busSrc.match(/ctx\.lastActivityAt\s*=/g) || [];
    expect(writes, "`lastActivityAt` doit être écrit à UN seul endroit").toHaveLength(1);
    expect(busSrc).toContain("const decision = decideActivityStamp({ source, now: at, previous: ctx.lastActivityAt });");
    // Le chien de garde ne fait que réarmer la surveillance.
    expect(busSrc).not.toContain("function resetTimeout(ctx)");
    // La décision du verrou après vidange vient du module pur, une seule fois.
    expect((busSrc.match(/decideRunLockAfterDrain\(/g) || []).length).toBe(2);
    expect(busSrc).toContain("if (decision.action === RUN_LOCK_KEEP) {");
  });

  it("les seuils de protection existent toujours (aucun garde-fou neutralisé)", () => {
    expect(RUN_LOCK_SWEEP_MIN_IDLE_MS).toBe(2 * 60 * 1000);
    expect(RUN_LOCK_SWEEP_START_GRACE_MS).toBe(60 * 1000);
  });
});
