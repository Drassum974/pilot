# Rapport — la barre de saisie de l'écran Vocal ne surgit plus que par la souris

> **Demande du propriétaire (2026-11-16).** « La barre du bas ne doit apparaître
> que sur mouvement de souris. Elle apparaît aussi dès que je parle : le
> mouvement de souris doit être la SEULE cause d'apparition. »
>
> **État constaté au départ** : dernier commit `e6d1c75` (`feat(assistants):
> deux règles communes, source unique et contrôle visible`), Pilot 0.6.25.
> Aucune version publiée, aucun tag : **rien n'a été republié**.

---

## 1. Ce que la règle dit maintenant, mot pour mot

| Situation | Comportement |
|---|---|
| Au repos | la barre (ligne d'état + zone de saisie) est **effacée** — c'est l'état par défaut, dès l'entrée dans le mode |
| Mouvement de souris de 4 px, clic, molette | elle **apparaît** (les **trois seules** causes d'apparition) |
| Frappe au clavier | elle **prolonge** un bas déjà visible — elle ne l'allume **jamais** |
| Ni souris, ni frappe pendant **10 000 ms** | elle **redisparaît seule** |
| La parole (micro qui capte), Pilot qui parle, un changement d'état (écoute, veille, réveil, transcription) | **aucun effet** : rien n'apparaît (seule exception, décidée le même jour : la **ligne d'état de la veille**, § 7) |

Le bouton discret de masquage/réaffichage, la question en attente qui retient le
bas, la panne de micro qui reste lisible et la touche `Échap` qui sort du mode
sont **inchangés** (voir le § 6).

---

## 2. Ce qui déclenchait l'apparition (les cinq chemins trouvés)

| # | Chemin | Ce qu'il faisait | Sort |
|---|---|---|---|
| 1 | `onVocalChromePointerMove` / `PointerDown` / `Wheel` | réveillaient le bas (geste de souris) | **conservé** — c'est la règle voulue |
| 2 | `onVocalChromeKeydown` | **allumait** le bas avec `vocalWakeChrome()` | **changé** : prolonge seulement (`vocalKeepChromeAlive`) |
| 3 | `rec.onresult` (dictée) | appelait `vocalWakeChrome()` dès qu'une **transcription réelle** arrivait — reste du correctif du 2026-11-15, qui n'avait traité que les résultats **vides** | **supprimé** : ne fait plus que rejouer la décision |
| 4 | `vocalBargeIn` (voix par-dessus la lecture) | appelait `vocalWakeChrome()` quand l'utilisateur prenait la parole | **supprimé** : `applyVocalState()` seul |
| 5 | règle 2 de `vocal-chrome.js` (« le champ contient du texte ») | comptait le texte écrit par la **dictée** : chaque phrase prononcée remplissait le champ, donc retenait le bas pendant tout l'envoi | **corrigé** : un texte dicté n'est pas un texte saisi |

**Le défaut principal était le n° 3** : la conversation parlée est armée **au
repos** et le moteur de reconnaissance émet des résultats en continu ; chaque
phrase prononcée allumait donc la barre et relançait les 10 s. Le n° 4 la
rallumait en parlant par-dessus une lecture, et le n° 5 la retenait tant que le
texte dicté restait dans le champ (le temps des deux secondes de silence avant
l'envoi).

---

## 3. Ce qui a été changé

Périmètre : **deux fichiers de production** et **cinq fichiers de tests**.

### `src/js/super-agent.js`

1. **`vocalKeepChromeAlive()` — nouveau point d'entrée du clavier** (à côté du
   réveil, qui ne change pas de forme) :

   ```js
   function vocalKeepChromeAlive() {
     if (!vocalOverlay) return;
     if (vocalChromeTimer) vocalRestartChromeTimer();
     vocalSyncChrome();
   }
   ```

   La garde `if (vocalChromeTimer)` est **toute** la différence entre
   « prolonger » et « allumer » : sans décompte en cours, aucune touche ne met la
   barre en marche. Aucun second minuteur, aucune seconde règle.

2. **L'écouteur `input` du champ et l'écouteur clavier** passent par
   `vocalKeepChromeAlive()` au lieu de `vocalWakeChrome()`.

3. **`rec.onresult`** ne réveille plus rien : il écrit le texte, redimensionne,
   marque le champ comme dicté et **rejoue la décision** (`vocalSyncChrome()`).

4. **`vocalBargeIn`** appelle `applyVocalState()` au lieu du réveil : l'écran
   suit la lecture sans poser de décompte.

5. **Nouveau drapeau `vocalChampDicte`** (mémoire seulement, aucun réglage) :
   posé par le **seul** écrivain du moteur de reconnaissance (`rec.onresult`),
   retiré par la frappe de l'utilisateur (écouteur `input`). Il alimente la
   règle 2 :

   ```js
   saisie: texte.trim() !== "" && !vocalChampDicte,
   ```

   Un texte **saisi** retient donc le bas comme avant ; un texte **dicté** non.

6. **Documentation du minuteur** réécrite : seuls un geste de souris et sa
   variante clavier mettent le décompte en marche — **la parole ne le peut pas**.

### `src/js/vocal-chrome.js`

Aucune règle n'a changé de forme ni d'ordre : ce module est **pur** et ne reçoit
**aucun état de conversation** (c'était déjà le cas ; un test le vérifie
désormais explicitement). Trois commentaires/documentations ont été mis à jour :
état par défaut masqué, règle 2 = texte **saisi par l'utilisateur**, et
suppression de l'ancienne phrase qui présentait la parole comme une raison de
retour.

---

## 4. Comment la règle est garantie (mécanismes, pas intentions)

1. **Trois appels au réveil dans tout `super-agent.js`**, et ce sont les trois
   gestes de souris. Un seul fichier, un compte vérifié.
2. **La décision pure ignore la conversation** : `vocalChromeVisible` ne reçoit
   que `saisie`, `micFerme`, `pointeurActif`, `pointeurGeste`, `question`. Il
   n'existe aucun fait « Pilot parle », « le micro écoute » ou « je transcris »
   qu'un appelant pourrait transmettre.
3. **Un seul minuteur** (`vocalChromeTimer`), un seul `setTimeout`, **aucune
   pose à l'entrée du mode** : le bas naît effacé.
4. **Un seul point d'écriture de la classe** (`vocalSyncChrome`), en dernière
   ligne de `applyVocalState`.
5. **La frappe ne peut pas allumer** : la seule pose inconditionnelle du
   minuteur est celle du réveil ; `vocalKeepChromeAlive` est gardée.

---

## 5. Tests

### Ajouté — `src/js/vocal-barre-surgit-seulement-par-la-souris.test.js` (12 tests)

Quatre sections, chacune échoue si le défaut revient :

1. **la souris est la seule cause d'apparition** — les trois gestes allument ;
   le fichier ne contient **que trois** appels `vocalWakeChrome();` ; la
   décision pure ne connaît aucun état de conversation (`speaking`,
   `listening`, `thinking`, `veille`, `reveil`, `transcription`).
2. **aucun chemin de la parole n'allume le bas** — `rec.onresult`,
   `rec.onerror`, `rec.onend`, `startVoiceInput`, `stopVoiceInput`,
   `vocalEnterVeille`, `vocalExitVeille`, `vocalSetLevel`, `applyVocalState`,
   `vocalBargeIn` : ni réveil, ni prolongation ; et le texte dicté ne retient
   pas le bas (`saisie: … && !vocalChampDicte`, drapeau posé/retiré aux bons
   endroits).
3. **une touche prolonge, elle n'allume pas** — l'écouteur clavier et la frappe
   passent par `vocalKeepChromeAlive` ; la **seule** pose du minuteur dans cette
   fonction est la ligne gardée ; `Échap` ne prolonge pas ; 2 px ne sont pas un
   geste, 6 px oui.
4. **la disparition après inactivité** — au repos le bas est effacé,
   `VOCAL_CHROME_IDLE_MS === 10_000`, **un seul** `setTimeout`, le décompte
   retombe, rejoue la décision et **n'est pas reposé** ; l'entrée dans le mode
   ne pose aucun minuteur.

Le découpage de source passe par `sliceSource` (il **lève** si une ancre
disparaît) : un fragment vide ne peut pas rendre une assertion vraie.

### Adaptés (4 fichiers)

| Fichier | Ce qui change |
|---|---|
| `ecran-vocal-saisie-disparait-apres-dix-secondes.test.js` | deux poses de minuteur attendues (réveil + prolongation gardée) ; titre du test : « un mouvement RAMENE le bas ; une frappe le PROLONGE, elle ne le rallume pas » |
| `vocal-chrome-masque.test.js` | la frappe prolonge un bas déjà là, la dictée ne le rallume plus |
| `vocal-barre-effacee-pendant-la-parole.test.js` | la parole ne fait plus revenir la barre : prise de parole, dictée et exclusion du texte dicté |
| `vocal-resultat-vide-ne-reveille-pas-le-bas.test.js` | plus **aucun** réveil venu de la dictée (vide **ou** parlée) ; ordre écriture → redimensionnement → marque |

### Preuves par mutation (le test échoue-t-il vraiment ?)

| Mutation appliquée au code | Résultat observé |
|---|---|
| réintroduire `if (transcript.trim()) vocalWakeChrome();` dans `rec.onresult` | **6 échecs** (dont « appels trouves : 4 » et « reveil par function startVoiceInput() ») |
| remplacer `vocalKeepChromeAlive();` par `vocalWakeChrome();` dans l'écouteur clavier | **2 échecs** |
| retirer `&& !vocalChampDicte` de `saisie` | **1 échec** |

Chaque mutation a été annulée immédiatement (`git diff` vérifié après coup) :
c'est le code voulu qui est committé, pas la mutation.

### Résultats

- Tests ciblés (les sept fichiers de l'écran Vocal, nouveau compris) :
  **93 passés, 0 échec**.
- **Suite complète** : `npx vitest run` → **6061 passés, 0 échec**.
- Garde-fou du registre : `registre-comportements-valides.test.js` →
  **10 passés, 0 échec** (nouvelle entrée n° 33).

---

## 6. Ce qui n'a **pas** changé (comportements existants préservés)

- **Le masquage manuel** (bouton discret de masquage/réaffichage) : intact, un
  seul bouton, un seul appel — il n'entre pas dans la décision du bas.
- **La question en attente** retient toujours le bas (sa rangée de boutons y
  vit) : une question ne doit jamais être invisible.
- **La panne de micro** reste lisible, avec son bouton « Autoriser le micro ».
- **Un champ rempli par l'utilisateur** retient toujours le bas, sans échéance.
- **Le pointeur posé** sur la bande du bas ne retient rien (défaut du
  2026-10-03), et le geste expire avec le décompte.
- **`Échap`** sort du mode et ne prolonge rien.
- **Les trois sorties** (logo, `Échap`, fermeture de l'onglet), les colonnes, le
  portrait, l'état nu, l'enveloppe de parole, la dictée, la veille et les mots de
  réveil : **aucun fichier de voix, de synthèse ou d'un autre écran n'a été
  touché**.

---

## 7. Une exception DÉJÀ décidée le même jour, et volontairement conservée

Pendant la **veille** (20 s sans qu'on ait prononcé son nom), la **ligne d'état**
revient et reste visible — elle est la seule chose qui demande le nom. C'est une
décision du propriétaire du **2026-11-16** (§ 6quater.3 de
`spec_modes_ecran_vocal.md`, registre n° 29, verrou
`src/js/ecran-vocal-veille-affichee.test.js`), et elle ne concerne **que la ligne
d'état** : la **zone de saisie** et le bouton de dépannage restent effacés, la
règle CSS ne prend aucun clic (`pointer-events: none`, issue #381) et aucun nœud
n'est ajouté. Je ne l'ai pas rouverte : elle est antérieure d'une heure à la
demande de cette tâche et porte sur un autre nœud. Si le propriétaire veut que
la veille aussi reste muette à l'écran, c'est **une ligne de CSS à retirer** — à
demander explicitement, ce n'est pas un changement d'affichage anodin.

## 8. Limite connue, dite franchement

Une touche pressée **sans** que la barre soit visible ne la fait pas
apparaître — c'est la règle voulue — **y compris** si l'on tape directement dans
la zone de saisie alors qu'elle est effacée. Comme un bas effacé a
`pointer-events: none` et `visibility: hidden`, on ne peut de toute façon pas y
placer le curseur : pour écrire, il faut d'abord un geste de souris. C'est
exactement ce que le propriétaire a demandé (« bouger la souris pour pouvoir
cliquer et taper »).

---

## 9. Fichiers touchés

| Fichier | Nature |
|---|---|
| `src/js/super-agent.js` | production (6 blocs) |
| `src/js/vocal-chrome.js` | production (documentation des règles, aucun changement de forme) |
| `src/js/vocal-barre-surgit-seulement-par-la-souris.test.js` | **nouveau** (12 tests) |
| `src/js/ecran-vocal-saisie-disparait-apres-dix-secondes.test.js` | adapté |
| `src/js/vocal-chrome-masque.test.js` | adapté |
| `src/js/vocal-barre-effacee-pendant-la-parole.test.js` | adapté |
| `src/js/vocal-resultat-vide-ne-reveille-pas-le-bas.test.js` | adapté |
| `spec_modes_ecran_vocal.md` | § 4bis : la souris est la seule cause d'apparition + correctif daté |
| `spec_registre_comportements_valides.md` | entrée n° 33 |
| `AGENTS.md` | ligne `vocal-chrome.js` (règles réelles + verrou) |
| `docs/rapports/RAPPORT-vocal-barre-saisie.md` | ce rapport |

Aucune version publiée, aucun tag, aucune republication de la 0.6.25.
