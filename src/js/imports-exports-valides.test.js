// imports-exports-valides.test.js — VERROU : un import NOMMÉ doit désigner un
// symbole qui existe VRAIMENT dans le module local visé.
//
// Panne qui a motivé ce test (2026-11-16) : `src/js/read-aloud.js` importait
// `groupSentencesForPocket` depuis `./pocket-voice.js`, un symbole qui n'a
// JAMAIS existé. En mode dev, Vite sert les modules ES natifs : la LIAISON
// échoue AVANT la moindre exécution, `main.js` n'est donc jamais évalué et
// l'écran de chargement ne disparaît jamais (son filet de sécurité de 30 s est
// enregistré PAR `main.js` : il ne s'arme donc jamais). Le build de production
// passait, lui, parce que Rollup élimine un import inutilisé — et les 6 061
// tests existants restaient verts avec l'application cassée.
// Détail et preuves : docs/rapports/RAPPORT-mode-dev-blocage-demarrage.md
//
// Ce test ne vérifie donc QUE ce que les autres ne voyaient pas : la LIAISON
// statique entre un fichier et les symboles qu'il emprunte à ses voisins.
//
// LIMITES ASSUMÉES, exclues EN LE NOMMANT (jamais en silence) :
//   1. Les cibles NON locales (paquets npm, `node:*`) : elles ne sont pas dans
//      le dépôt, on ne peut rien conclure.
//   2. Les cibles non `.js` (`../../src-tauri/extensions/*.ts`, par exemple) :
//      hors du périmètre de ce balayage, la résolution est celle de Vite/TS.
//   3. Une cible `.js` RELATIVE INTROUVABLE sur le disque : la liaison n'est pas
//      vérifiée ici (on ne sait pas quel fichier viser) — mais le garde-fou de
//      portée, plus bas, REFUSE un import relatif vers un fichier absent : ce
//      cas-là n'est donc jamais silencieux non plus.
//   4. `import(...)` dynamique et `import x from "…"` (défaut) : aucun nom
//      nommé à confronter, donc rien à dire.
//   5. `import * as ns` : aucune liste de noms à confronter.
//   6. Un module qui fait `export * from "…"` vers une cible illisible est
//      réputé OPAQUE (on ne peut pas conclure) : on ne signale rien.
//   7. Le balayage est LEXICAL (commentaires retirés, chaînes respectées), pas
//      une analyse syntaxique complète : une construction exotique que ce
//      lecteur ne sait pas lire est simplement ignorée, jamais inventée.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_DIR = resolve(SRC_DIR, "..", "..");

// ─────────────────────────── lecture tolérante du source ───────────────────────

/**
 * Masque les commentaires, le CONTENU des chaînes et le CORPS des expressions
 * régulières, en gardant leur LONGUEUR et les retours à la ligne : les
 * décalages du source restent valables (on relit le fichier visé à la même
 * position dans le source original), et un module cité DANS une chaîne (une
 * fixture de test, par exemple) n'est jamais pris pour un vrai import. Les
 * guillemets et les barres obliques, eux, restent visibles.
 *
 * Les expressions régulières doivent être reconnues : `replace(/"/g, …)` met
 * un guillemet DANS un littéral d'expression régulière, et sans cette règle le
 * masque le prendrait pour le début d'une chaîne et avalerait la suite du
 * fichier (faux positifs constatés sur `agent-activity.js`).
 */
function maskCode(source) {
  const out = source.split("");
  const n = source.length;
  let i = 0;
  const blank = (from, to) => {
    for (let k = from; k < to && k < n; k += 1) {
      if (source[k] !== "\n") out[k] = " ";
    }
  };
  // Dernier caractère de CODE réel rencontré (hors blancs) : il dit si `/`
  // ouvre une expression régulière ou s'il divise — comme le ferait un lecteur.
  let previous = "";
  // Texte de gabarit (`` `…` ``) et expressions `${…}` : une pile, parce qu'un
  // gabarit peut en contenir un autre. Sans cela, une seule imbrication fait
  // déborder le masque et AVALE la suite du fichier (faux positifs constatés
  // sur `agent-activity.js` et `gds-status.js`).
  const expressions = [];
  let inTemplate = false;
  const REGEX_AFTER_CHARS = new Set("(,=:[!&|?{};+-*%<>~^".split(""));
  const REGEX_AFTER_WORDS = new Set([
    "return",
    "typeof",
    "instanceof",
    "in",
    "of",
    "new",
    "delete",
    "void",
    "case",
    "do",
    "else",
    "yield",
    "await",
    "throw",
  ]);
  const wordBefore = (index) => {
    let start = index - 1;
    while (start >= 0 && /\s/.test(source[start])) start -= 1;
    const end = start;
    while (start >= 0 && /[A-Za-z_$]/.test(source[start])) start -= 1;
    return source.slice(start + 1, end + 1);
  };

  while (i < n) {
    const c = source[i];
    const next = source[i + 1];

    // ── dans le TEXTE d'un gabarit : tout est masqué sauf `\`, `` ` `` et `${`
    if (inTemplate) {
      if (c === "\\") {
        blank(i, i + 2);
        i += 2;
        continue;
      }
      if (c === "`") {
        inTemplate = false;
        previous = "`";
        i += 1;
        continue;
      }
      if (c === "$" && next === "{") {
        expressions.push(0);
        inTemplate = false;
        previous = "{";
        i += 2;
        continue;
      }
      blank(i, i + 1);
      i += 1;
      continue;
    }

    // ── dans du CODE
    if (c === "/" && next === "/") {
      while (i < n && source[i] !== "\n") {
        out[i] = " ";
        i += 1;
      }
      continue;
    }
    if (c === "/" && next === "*") {
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) {
        if (source[i] !== "\n") out[i] = " ";
        i += 1;
      }
      blank(i, i + 2);
      i += 2;
      continue;
    }
    if (c === "/") {
      const opensRegex =
        previous === "" ||
        REGEX_AFTER_CHARS.has(previous) ||
        (/[A-Za-z_$]/.test(previous) && REGEX_AFTER_WORDS.has(wordBefore(i)));
      if (opensRegex) {
        let inClass = false;
        i += 1;
        while (i < n) {
          const ch = source[i];
          // Une expression régulière ne traverse JAMAIS une ligne : sans `/`
          // fermant, on s'arrête là (lecture prudente, rien n'est inventé).
          if (ch === "\n") break;
          if (ch === "\\") {
            blank(i, i + 2);
            i += 2;
            continue;
          }
          if (ch === "[") inClass = true;
          else if (ch === "]") inClass = false;
          else if (ch === "/" && !inClass) {
            i += 1;
            break;
          }
          blank(i, i + 1);
          i += 1;
        }
        while (i < n && /[A-Za-z]/.test(source[i])) {
          out[i] = " ";
          i += 1;
        }
        previous = "/";
        continue;
      }
    }
    if (c === '"' || c === "'") {
      const quote = c;
      i += 1;
      while (i < n) {
        if (source[i] === "\\") {
          blank(i, i + 2);
          i += 2;
          continue;
        }
        if (source[i] === quote) {
          i += 1;
          break;
        }
        if (source[i] !== "\n") out[i] = " ";
        i += 1;
      }
      previous = quote;
      continue;
    }
    if (c === "`") {
      inTemplate = true;
      previous = "`";
      i += 1;
      continue;
    }
    if (c === "{") {
      if (expressions.length) expressions[expressions.length - 1] += 1;
      previous = "{";
      i += 1;
      continue;
    }
    if (c === "}") {
      if (expressions.length && expressions[expressions.length - 1] === 0) {
        expressions.pop();
        inTemplate = true;
        previous = "}";
        i += 1;
        continue;
      }
      if (expressions.length) expressions[expressions.length - 1] -= 1;
      previous = "}";
      i += 1;
      continue;
    }
    if (!/\s/.test(c)) previous = c;
    i += 1;
  }
  return out.join("");
}

/** Texte ORIGINAL d'un groupe de capture (le masque ne garde que les positions). */
function groupText(match, group, source) {
  const range = match.indices?.[group];
  return range ? source.slice(range[0], range[1]) : "";
}

/** Numéro de ligne (1-based) d'un décalage dans le source. */
function lineAt(source, index) {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i += 1) {
    if (source[i] === "\n") line += 1;
  }
  return line;
}

// ─────────────────────────── côté IMPORT (ce qui est emprunté) ─────────────────

// Clause d'import sans `;` ni guillemet : `import { a, b as c } from "…"`.
// `import(` et `import.meta` ne peuvent pas correspondre (il faut un blanc puis
// le mot `from`).
const IMPORT_FROM_RE = /import\s+([^;"'`]*?)\s*from\s*(["'])([^"'\n]+)\2/gd;

const IMPORT_MODULE_RE = /import\s*(["'])([^"'\n]+)\1/gd;

const SPECIFIER_RE = /^(?:([A-Za-z_$][\w$]*)\s+as\s+)?([A-Za-z_$][\w$]*)$/;

/** Noms NOMMÉS importés par un module, avec leur ligne et leur cible écrite. */
function parseNamedImports(source) {
  const masked = maskCode(source);
  const found = [];
  for (const match of masked.matchAll(IMPORT_FROM_RE)) {
    const clause = match[1] ?? "";
    const target = groupText(match, 3, source);
    const braces = /\{([\s\S]*?)\}/.exec(clause);
    if (!braces) continue;
    const line = lineAt(masked, match.index);
    for (const raw of braces[1].split(",")) {
      const part = raw.trim();
      if (!part || /^type\s/.test(part)) continue;
      const spec = SPECIFIER_RE.exec(part);
      if (!spec) continue;
      // `import { origine as local }` : c'est ORIGINE qui doit exister.
      const name = spec[1] ?? spec[2];
      found.push({ name, target, line });
    }
  }
  return found;
}

/** Modules .js importés sans liaison nommée (pour la portée du balayage). */
function parseImportedPaths(source) {
  const masked = maskCode(source);
  const targets = new Set();
  for (const match of masked.matchAll(IMPORT_FROM_RE)) targets.add(groupText(match, 3, source));
  for (const match of masked.matchAll(IMPORT_MODULE_RE)) targets.add(groupText(match, 2, source));
  return [...targets];
}

/** `export { a, b as c } from "./x.js"` : noms empruntés puis réexportés. */
function parseNamedReexports(source) {
  const masked = maskCode(source);
  const found = [];
  const re = /export\s*\{([\s\S]*?)\}\s*from\s*(["'])([^"'\n]+)\2/gd;
  for (const match of masked.matchAll(re)) {
    const target = groupText(match, 3, source);
    const line = lineAt(masked, match.index);
    for (const raw of match[1].split(",")) {
      const part = raw.trim();
      if (!part || /^type\s/.test(part)) continue;
      const spec = SPECIFIER_RE.exec(part);
      if (!spec) continue;
      found.push({ name: spec[1] ?? spec[2], target, line });
    }
  }
  return found;
}

// ─────────────────────────── côté EXPORT (ce qui est offert) ───────────────────

const EXPORT_DECL_RE =
  /export\s+(?:async\s+)?(?:function\s*\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)/g;

const EXPORT_LIST_RE = /export\s*\{([\s\S]*?)\}/g;

const EXPORT_STAR_RE = /export\s*\*\s*from\s*(["'])([^"'\n]+)\1/gd;

const EXPORT_STAR_AS_RE = /export\s*\*\s*as\s+([A-Za-z_$][\w$]*)\s*from\s*(["'])([^"'\n]+)\2/gd;

/**
 * Ce qu'un module offre : ses noms locaux, ses `export * from` (à résoudre) et
 * son caractère éventuellement OPAQUE (un `export *` illisible : on ne conclut
 * plus rien sur ce module).
 */
function parseExports(source) {
  const masked = maskCode(source);
  const names = new Set();
  for (const match of masked.matchAll(EXPORT_DECL_RE)) names.add(match[1]);
  if (/export\s+default\b/.test(masked)) names.add("default");
  for (const match of masked.matchAll(EXPORT_LIST_RE)) {
    for (const raw of match[1].split(",")) {
      const part = raw.trim();
      if (!part || /^type\s/.test(part)) continue;
      const spec = SPECIFIER_RE.exec(part);
      if (!spec) continue;
      // `export { locale as publique }` : le nom offert est celui de DROITE.
      names.add(spec[2]);
    }
  }
  for (const match of masked.matchAll(EXPORT_STAR_AS_RE)) names.add(match[1]);
  const stars = [];
  for (const match of masked.matchAll(EXPORT_STAR_RE)) stars.push(groupText(match, 2, source));
  return { names, stars };
}

// ─────────────────────────── le balayage, injectable (donc testable) ───────────

/**
 * Résout un chemin importé vers un fichier `.js` du dépôt, ou `null` si la
 * cible sort du périmètre (limites 1 à 3 du commentaire d'en-tête).
 */
function localTarget(fromFile, target, exists) {
  if (!target.startsWith("./") && !target.startsWith("../")) return null;
  if (!target.endsWith(".js")) return null;
  const resolved = resolve(dirname(fromFile), target);
  return exists(resolved) ? resolved : null;
}

/** Table d'exports d'un module, `export *` résolu (opaque si indécidable). */
function exportTable(filePath, { readSource, exists, cache = new Map(), seen = new Set() }) {
  const key = resolve(filePath);
  if (cache.has(key)) return cache.get(key);
  const table = { names: new Set(), opaque: false };
  cache.set(key, table);
  if (seen.has(key)) return table;
  seen.add(key);
  const source = readSource(key);
  if (source === null) {
    table.opaque = true;
    return table;
  }
  const parsed = parseExports(source);
  for (const name of parsed.names) table.names.add(name);
  for (const star of parsed.stars) {
    const target = localTarget(key, star, exists);
    if (!target) {
      // Limite 6 : une cible qu'on ne sait pas lire rend le module opaque.
      table.opaque = true;
      continue;
    }
    const inner = exportTable(target, { readSource, exists, cache, seen });
    for (const name of inner.names) table.names.add(name);
    if (inner.opaque) table.opaque = true;
  }
  return table;
}

/**
 * Cherche les liaisons cassées dans un ensemble de modules.
 * `modules` : Map<chemin absolu, source>. Rend des phrases lisibles.
 */
function findBrokenImports(modules, { projectRoot } = {}) {
  const readSource = (filePath) => (modules.has(resolve(filePath)) ? modules.get(resolve(filePath)) : null);
  const exists = (filePath) => modules.has(resolve(filePath));
  const cache = new Map();
  const problems = [];
  const shown = (filePath) =>
    projectRoot ? relative(projectRoot, filePath).split(sep).join("/") : filePath;
  for (const [filePath, source] of modules) {
    const checks = [
      ...parseNamedImports(source),
      ...parseNamedReexports(source),
    ];
    for (const check of checks) {
      const target = localTarget(filePath, check.target, exists);
      if (!target) continue; // limites 1 à 3 : hors périmètre, jamais en silence
      const table = exportTable(target, { readSource, exists, cache });
      if (table.opaque) continue; // limite 6
      if (table.names.has(check.name)) continue;
      problems.push(
        `${shown(filePath)}:${check.line} → « ${check.name} » n'est pas exporté par ` +
          `${shown(target)} (import nommé depuis « ${check.target} »)`,
      );
    }
  }
  return problems;
}

// ─────────────────────────── le test lui-même ──────────────────────────────────

describe("imports-exports-valides", () => {
  it("le détecteur reconnaît la panne réelle (il ne peut pas être un test vide)", () => {
    const modules = new Map([
      [
        resolve("project/src/js/a.js"),
        'import { exists, nullePart } from "./b.js";\nconsole.log(exists, nullePart);\n',
      ],
      [
        resolve("project/src/js/b.js"),
        "export const exists = 1;\nexport function presente() {}\n",
      ],
    ]);
    const problems = findBrokenImports(modules, { projectRoot: resolve("project") });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("src/js/a.js:1");
    expect(problems[0]).toContain("« nullePart »");
    expect(problems[0]).toContain("src/js/b.js");
  });

  it("le détecteur accepte les formes légitimes (alias, export *, ré-export)", () => {
    const modules = new Map([
      [
        resolve("project/src/js/a.js"),
        [
          'import { renommee, parEtoile, reexportee, offerte } from "./b.js";',
          'import defaut from "./c.js";',
          "console.log(renommee, parEtoile, reexportee, offerte, defaut);",
          "",
        ].join("\n"),
      ],
      [
        resolve("project/src/js/b.js"),
        [
          'export { locale as renommee } from "./c.js";',
          'export * from "./c.js";',
          "export const offerte = 1;",
          "",
        ].join("\n"),
      ],
      [
        resolve("project/src/js/c.js"),
        [
          "export const locale = 1;",
          "export const parEtoile = 2;",
          "export const reexportee = 3;",
          "export default 4;",
          "",
        ].join("\n"),
      ],
    ]);
    expect(findBrokenImports(modules, { projectRoot: resolve("project") })).toEqual([]);
  });

  it("chaque module de src/js n'importe que des symboles réellement exportés", () => {
    const files = readdirSync(SRC_DIR)
      .filter((name) => name.endsWith(".js"))
      .map((name) => join(SRC_DIR, name));
    const modules = new Map();
    for (const file of files) {
      // `.replace(/\r\n/g, "\n")` : un worktree Windows (CRLF) reste lisible.
      modules.set(resolve(file), readFileSync(file, "utf8").replace(/\r\n/g, "\n"));
    }
    const problems = findBrokenImports(modules, { projectRoot: REPO_DIR });
    // Le message nomme le fichier, la ligne et le symbole manquant.
    expect(problems.join("\n")).toBe("");
  });

  it("le balayage couvre bien les imports nommés locaux (garde-fou de portée)", () => {
    const files = readdirSync(SRC_DIR).filter((name) => name.endsWith(".js"));
    let named = 0;
    for (const name of files) {
      const source = readFileSync(join(SRC_DIR, name), "utf8").replace(/\r\n/g, "\n");
      for (const check of parseNamedImports(source)) {
        if (check.target.startsWith("./") && check.target.endsWith(".js")) named += 1;
      }
      for (const target of parseImportedPaths(source)) {
        if (target.startsWith("./") && !existsSync(resolve(SRC_DIR, target))) {
          throw new Error(`${name} importe un fichier introuvable : ${target}`);
        }
      }
    }
    // Si le balayage ne voyait plus rien, le verrou passerait sans rien vérifier.
    expect(named).toBeGreaterThan(500);
  });
});
