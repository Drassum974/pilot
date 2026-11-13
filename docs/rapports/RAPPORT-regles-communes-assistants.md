# Rapport — les deux règles communes à tous les assistants

**Décision du propriétaire : 13/11/2026.** Deux fautes réelles ont conduit à
deux règles. Ce lot les rend **systématiques** : un seul texte de référence,
lu par tous les assistants, et un **contrôle visible** qui signale le cas
fautif — pas un paragraphe de consignes de plus.

| Règle | Ce qu'elle interdit | Ce qui le prouve |
|---|---|---|
| 1 | Opposer une limite tirée d'une **documentation** à un fait constaté chez le propriétaire par un essai réel ; faire revenir une réserve qu'il a démentie | `src/js/regles-communes-assistants.test.js` (source + contrôle) et `super_agent::tests::les_regles_communes_sont_injectees_dans_le_prompt` |
| 2 | Laisser un sujet validé sans date (« à trancher », « plus tard », « à voir ») jusqu'à ce qu'il disparaisse | `src/js/regles-communes-assistants.test.js` :: *refuse la création d'une tâche reportée sans date (porte visible)* |

---

## 1. Où vivaient les consignes, avant

Rien n'était commun. Chaque assistant recevait **son** prompt, écrit à part :

| Assistant | Où vivait son prompt | Les deux règles y étaient-elles ? |
|---|---|---|
| Assistant de suivi (🧭) | `src-tauri/src/super_agent.rs` : constantes `SUPER_AGENT_*_PROMPT` assemblées par `assemble_super_agent_system_prompt` | Non |
| Agent d'un projet (onglet π) et agents multi-rôles | `src-tauri/extensions/pilot-context.ts` (`before_agent_start`) + le prompt de la session | Non |
| Agent délégué par l'assistant | `src/js/structured-brief.js` (`buildStructuredBrief` / `ensureStructuredBrief`) — l'enveloppe du brief, plus le protocole quality-gate | Non |
| Codeur / agents hors projet | mêmes voies que ci-dessus | Non |

Une recherche `consignes communes`, `règles communes`, `COMMON_RULES` avant ce
lot ne rendait **aucun** résultat : le sujet n'existait nulle part.

## 2. Ce qui a été ajouté, et où

### 2.1 Une source unique (le patron existant de `agent-lifespan-rule.js`)

`src/js/regles-communes-assistants.js` — module **pur** : aucun import, aucune
I/O, aucun DOM, aucun Tauri. Il contient :

- `REGLES_COMMUNES_ASSISTANTS` : le **texte des deux règles**, en français, tel
  qu'un assistant doit les lire. Rédigé **sans accent grave et sans `${`** :
  c'est le contrat qui permet à Rust de l'extraire entre deux délimiteurs
  littéraux (`export const REGLES_COMMUNES_ASSISTANTS = \`` … `\`;`). Un verrou
  front le vérifie (`le texte ne contient ni accent grave ni ${`).
- `reglesCommunesAssistantsBlock()` : le bloc prêt à injecter (titre + deux
  règles), et `REGLES_COMMUNES_REPERE_1` / `_2` : les repères de chaque règle,
  utilisés par tous les tests.
- **Le contrôle de chaque règle** (c'est ce qui rend la règle visible dans le
  comportement) :
  - règle 1 : `findDocumentationReserveSigns()` repère une **citation de
    documentation accompagnée d'une limite opposée** ; `documentationReserveNotice()`
    écrit la phrase qui la rappelle. Une documentation citée **sans** être
    opposée ne déclenche rien.
  - règle 2 : `findUndatedDeferralSigns()`, `hasDeadline()`,
    `hasExplicitClosure()` (frontière de mot : « disclosed » n'est pas
    « clos »), `auditUndatedDeferral()` et `undatedDeferralNotice()`.
    `displayDeferralMarker()` rend le marqueur **en français correct**
    (« à trancher », pas « a trancher ») : le repérage ignore les accents, la
    phrase affichée les remet.
- `reglesCommunesAnswerNotice(text)` : le contrôle **unique** appliqué à une
  réponse — chaîne vide quand tout va bien.

### 2.2 Trois voies de lecture, aucune recopie

| Voie | Fichier | Ce qui a changé |
|---|---|---|
| Prompt de l'assistant de suivi | `src-tauri/src/super_agent.rs` | `REGLES_COMMUNES_SOURCE = include_str!("../../src/js/regles-communes-assistants.js")`, `extract_regles_communes()` (pure, fermée : sans délimiteurs ⇒ `None`), `regles_communes_assistants_prompt()`, poussé dans le prompt juste après `SUPER_AGENT_HOWTO_PROMPT` |
| Toute demande déléguée | `src/js/structured-brief.js` | `reglesCommunesInstruction()` préfixe **les deux** branches de `ensureStructuredBrief` et `buildStructuredBrief` (donc y compris un brief déjà structuré par l'assistant), **et aussi** le cas `forceStructured: false` de `applyAssistantBriefEnvelope` : les règles ne font pas partie de l'enveloppe qu'un réglage peut désactiver |
| Agent d'un projet / agents multi-rôles | `src-tauri/extensions/pilot-context.ts` | `rules` en **premier** dans `parts` du hook `before_agent_start` |

Le module est **écrit sur disque à côté des extensions** par
`AgentService::write_regles_communes()` (`include_str!` + `write_embedded`),
appelé dans **trois** chemins : agents lancés par l'assistant (hors
`conversation_only`), agents multi-rôles qui héritent du contexte, et
`spawn_session` (agent principal du projet). Sans ce fichier, `pilot-context.ts`
et `pilot-assistant-tools.ts` ne se chargent plus — c'est pour cela que le
verrou Rust existe.

### 2.3 Le contrôle est VISIBLE

- **`src/js/regles-communes-signal.js`** — l'**écrivain unique** du signalement
  (`showReglesCommunesNotice`) : il ne décide rien, il n'écrit rien sur une
  réponse saine, il ne double jamais son propre signalement, et il est
  **fail-open**. Classe CSS unique `.super-rules-notice` (une seule règle de
  style dans `src/css/style.css`).
- Branché sur les **deux** écrans qui affichent une réponse d'assistant :
  l'assistant de suivi (`src/js/super-agent.js`, fin de section de texte) et
  l'agent du projet (`src/js/agent-pi.js`, `text_end`).
- **`src-tauri/extensions/pilot-assistant-tools.ts`** — la règle 2 devient une
  **porte** : `create_task` appelle `auditUndatedDeferral()` **avant** toute
  écriture et **refuse** une tâche reportée sans date, en nommant le marqueur
  trouvé et la sortie (« donne une DATE (`deadline`, AAAA-MM-JJ) avec un porteur
  nommé, ou dis explicitement que le sujet est clos »). Une consigne de plus
  n'aurait rien empêché ; un refus, si.

## 3. Budget de prompt

`SUPER_AGENT_FIXED_PROMPT_BUDGET` a été relevé : **6 150 → 7 650**.

Mesures réelles (`super_agent_fixed_prompt_stays_under_budget`,
`--nocapture`) : textes fixes **7 262** caractères, dont **1 315** pour le bloc
des règles. La règle appliquée est celle du dépôt (valeur mesurée majorée de
5 %, arrondie au multiple de 50 supérieur) : 7 262 × 1,05 = 7 625 → **7 650**.
Le commentaire de la constante porte la mesure et sa date.

Le test `assistant_prompt_designates_no_doc_files` compare le prompt complet à
la concaténation **exacte** des textes figés : le bloc des règles y a été
ajouté **à sa place réelle** (après `SUPER_AGENT_HOWTO_PROMPT`, avant
`SUPER_AGENT_SCHEDULE_PROMPT`). Sans cela, ce verrou échoue — c'est voulu : il
interdit toute insertion silencieuse dans le prompt.

## 4. Comment vérifier

```bash
# Front — les deux règles, leur unicité, leur lecture, les deux contrôles
npx vitest run src/js/regles-communes-assistants.test.js

# Rust — les règles sont réellement dans le prompt assemblé (les deux modes)
cargo test --manifest-path src-tauri/Cargo.toml --lib les_regles_communes_sont_injectees
cargo test --manifest-path src-tauri/Cargo.toml --lib write_regles_communes_ecrit_la_source_unique
cargo test --manifest-path src-tauri/Cargo.toml --lib super_agent_fixed_prompt_stays_under_budget -- --nocapture

# Suites complètes
npm test
cargo test --workspace
```

Relevé de cette session : `npm test` **6 048 passed / 0 failed** ;
`cargo test --workspace` **1 163 passed / 14 ignored** ; garde-fou du registre
**10 passed**.

**Preuve qu'un assistant lancé APRÈS la modification reçoit bien les deux
règles** (pas seulement l'intention) :

1. `les_regles_communes_sont_injectees_dans_le_prompt` lit la source embarquée,
   exige les repères des deux règles, puis vérifie que le prompt assemblé
   **contient ce texte** en mode normal *et* coordinateur.
2. `write_regles_communes_ecrit_la_source_unique` lit le fichier **écrit sur
   disque** à côté des extensions et exige qu'il soit **identique à la source
   unique**, avec le bloc extractible et `auditUndatedDeferral` présent.
3. `toute demande déléguée (brief structuré) porte les deux règles` vérifie le
   texte réellement envoyé à l'agent délégué.

### Contre-épreuve (le test peut échouer)

Supprimer la phrase `vécu du propriétaire prime toujours sur la documentation`
de `REGLES_COMMUNES_ASSISTANTS` fait échouer :

- `la règle 1 dit que le vécu du propriétaire prime sur la documentation`
  (assertion sur le texte de la source) ;
- `toute demande déléguée (brief structuré) porte les deux règles` (le brief
  n'a plus le repère) ;
- `les_regles_communes_sont_injectees_dans_le_prompt` (« Règle 1 » toujours là
  mais « prime toujours sur la documentation » absent).

Supprimer le champ `deadline` de la porte, ou retirer la porte de `create_task`,
fait échouer *refuse la création d'une tâche reportée sans date (porte
visible)*.

## 5. Décisions prises, et ce qui reste ouvert

- **Source unique, zéro recopie** : le verrou
  *aucun autre fichier du dépôt ne recopie les phrases de la règle* lit huit
  fichiers lecteurs et refuse la phrase exacte. Les tests Rust citent des
  **fragments** (« prime toujours sur la documentation »), jamais la phrase
  entière : un fragment de vérification n'est pas une seconde formulation de la
  règle.
- **Agent π branché comme l'assistant 🧭** : la même fonction d'affichage, une
  seule classe CSS. Décision prise sans demander, parce qu'une règle propre à un
  seul assistant était explicitement interdite.
- **Contrôle de la règle 1 volontairement prudent** : il ne signale que la
  combinaison « citation de documentation **+** limite opposée ». Une
  documentation citée pour informer ne déclenche rien — un faux signalement
  permanent rendrait le signalement invisible.
- **Rien d'automatique côté règle 2 dans les anciennes tâches** : la porte
  s'applique à l'écriture (création de tâche). Les tâches déjà ouvertes sans
  date ne sont pas réécrites d'office : ce serait une décision du propriétaire,
  pas la nôtre.
- **Aucune publication** : pas de tag, pas de release, `0.6.25` n'a pas été
  retaguée. Le chantier PocketTTS (lecture des réponses, voix) n'a pas été
  touché.

## 6. Registre des comportements validés

Deux entrées ajoutées (`spec_registre_comportements_valides.md`, n° 31 et 32),
chacune avec le test qui la protège réellement.
