// tts_pocket.rs — Voix PocketTTS (Kyutai), TROISIÈME moteur de lecture à voix
// haute, **à côté** de Piper et de la voix imitée, jamais à leur place.
//
// Ce que ce module tient, et tient seul :
//   - **rien n'est remplacé** : la voix française locale (`tts_local.rs`, Piper)
//     et la voix imitée (`tts_voicestudio.rs`) gardent leur valeur de réglage,
//     leur état et leur code. PocketTTS n'ajoute que la valeur `local:pocket` et
//     `local:pocket:<identifiant>` dans LE MÊME champ `read_aloud_voice` ;
//   - **aucun moteur installé par Pilot** : PocketTTS est un programme Python
//     séparé, présent ou absent sur l'ordinateur. Pilot ne télécharge pas
//     d'interpréteur, ne crée aucun environnement virtuel et n'installe aucun
//     paquet : il CHERCHE l'exécutable à un emplacement fixe et le DIT quand il
//     ne le trouve pas (voir `hint`) ;
//   - **les poids ne descendent QUE sur un geste** : [`install_weights`] est la
//     seule fonction qui peut provoquer un téléchargement, et elle n'est
//     appelée que par la commande `tts_pocket_install`, elle-même déclenchée par
//     le bouton de la section « Lecture des réponses ». La synthèse
//     ([`synthesize_base64`]) ne télécharge RIEN : sans poids installés, elle
//     ÉCHOUE avec une raison lisible (verrou de test) ;
//   - **hors ligne à la lecture** : la synthèse ne fait aucun appel réseau ;
//     elle lance le moteur local, qui écrit un WAV puis s'arrête ;
//   - **aucun fichier audio conservé** : le WAV de synthèse est un temporaire,
//     créé puis retiré ; le front reçoit des octets en base64, joués en mémoire ;
//   - **repli obligatoire et visible** : moteur absent, poids absents, synthèse
//     en échec, délai dépassé → une ligne datée dans le journal EXISTANT
//     `voix-locale.log` (préfixe `[PocketTTS]`) et une erreur explicite ; c'est
//     le front qui retombe sur Piper puis sur la voix du système, et qui le dit.
//
// Disposition sur le poste (tout est déduit d'UN SEUL dossier) :
//
//   <app_data_dir>/voix-pocket/
//     moteur/pocket-tts.exe        (ou moteur/.venv/Scripts/pocket-tts.exe)
//     voix/estelle.wav             (voix clonée déposée par l'utilisateur)
//     hf/hub/…                     (poids du modèle, cache du moteur)
//     tmp/                         (WAV de synthèse, retiré après lecture)
//
// Licence et attribution : code **MIT**, poids **CC-BY-4.0** → l'attribution
// `Pocket TTS © Kyutai Labs — CC BY 4.0` est portée par [`ATTRIBUTION`] et
// affichée par l'écran (aucune autre copie dans le dépôt).

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use base64::Engine as _;
use serde::Serialize;
use tauri::Manager;

/// Sous-dossier (dans le dossier de données de Pilot) de cette voix.
pub const POCKET_DIR: &str = "voix-pocket";
/// Sous-dossier qui contient l'exécutable du moteur.
pub const ENGINE_SUBDIR: &str = "moteur";
/// Sous-dossier des voix déposées par l'utilisateur (voix imitées).
pub const VOICES_SUBDIR: &str = "voix";
/// Sous-dossier du cache du moteur (poids du modèle) : `HF_HOME` du processus.
pub const CACHE_SUBDIR: &str = "hf";
/// Sous-dossier des WAV de synthèse (temporaires, toujours retirés).
pub const TMP_SUBDIR: &str = "tmp";

/// Nom lisible du moteur (écrit UNE fois : libellés, état, journal).
pub const ENGINE_NAME: &str = "PocketTTS";
/// Attribution OBLIGATOIRE (poids sous CC-BY-4.0).
pub const ATTRIBUTION: &str = "Pocket TTS © Kyutai Labs — CC BY 4.0";
/// Langue demandée au moteur (le français n'est pas la langue par défaut).
pub const LANGUAGE: &str = "french";
/// Voix française PRÉVUE par le moteur et incluse dans les poids français :
/// c'est la voix que désigne la valeur historique `local:pocket`.
pub const DEFAULT_VOICE_ID: &str = "estelle";
/// Préfixe de la valeur du réglage unique (`read_aloud_voice`).
pub const VOICE_VALUE_PREFIX: &str = "local:pocket";

/// Plafond d'une synthèse : chargement du modèle à froid + génération ≈ 3× le
/// temps réel sur processeur. Au-delà, le moteur est interrompu (jamais
/// d'attente infinie dans l'interface).
pub const SYNTH_TIMEOUT: Duration = Duration::from_secs(180);
/// Plafond de l'INSTALLATION des poids (≈ 209 Mo la première fois).
pub const INSTALL_TIMEOUT: Duration = Duration::from_secs(1800);
/// Taille minimale d'un poids français plausible : un fichier plus petit est un
/// téléchargement interrompu, jamais un modèle installé.
pub const MIN_WEIGHTS_BYTES: u64 = 50 * 1024 * 1024;

/// Une voix proposée par ce moteur.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PocketVoice {
    /// Identifiant transmis au moteur (`--voice <id>`).
    pub id: &'static str,
    /// Genre annoncé en clair (`femme` / `homme`), vide si inconnu.
    pub gender: &'static str,
}

/// Voix PRÉVUES par le moteur, incluses dans les poids français.
///
/// Une seule entrée : c'est la seule voix française livrée avec le modèle
/// (`estelle`, relevée dans les poids et employée par le banc). On n'invente
/// aucun nom : les voix clonées par l'utilisateur apparaissent à côté, lues sur
/// le disque (voir [`list_voices`]).
pub const VOICES: &[PocketVoice] = &[PocketVoice {
    id: DEFAULT_VOICE_ID,
    gender: "femme",
}];

/// Vrai si l'identifiant désigne une voix de la table ci-dessus.
pub fn is_catalog_voice(id: &str) -> bool {
    VOICES.iter().any(|voice| voice.id == id)
}

/// Identifiant de voix désigné par une valeur du réglage unique.
///
/// `""`, une valeur d'un autre type et un identifiant douteux retombent sur la
/// voix par défaut : une configuration ne casse jamais. Un identifiant est
/// « douteux » s'il contient un séparateur de chemin ou un `..` — il ne doit
/// jamais permettre de sortir du dossier des voix.
pub fn voice_id_for(value: Option<&str>) -> String {
    let raw = value.unwrap_or("").trim();
    if raw.is_empty() {
        return DEFAULT_VOICE_ID.to_string();
    }
    let id = match raw.strip_prefix(VOICE_VALUE_PREFIX) {
        // `local:pocket` seul = la voix par défaut.
        Some(rest) => match rest.strip_prefix(':') {
            Some(name) => name.trim(),
            None => return DEFAULT_VOICE_ID.to_string(),
        },
        // Valeur d'un autre moteur (`local:piper`, voix du système) : on ne
        // l'interprète pas ici, mais l'appelant n'aurait pas dû nous la passer.
        None => return DEFAULT_VOICE_ID.to_string(),
    };
    if id.is_empty() || !voice_id_is_clean(id) {
        return DEFAULT_VOICE_ID.to_string();
    }
    id.to_string()
}

/// Vrai si un identifiant de voix ne peut pas sortir du dossier des voix.
pub fn voice_id_is_clean(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 96
        && !id.contains('/')
        && !id.contains('\\')
        && !id.contains(':')
        && id != "."
        && id != ".."
        && !id.starts_with('.')
}

/// Genre lu dans un NOM DE FICHIER de voix imitée (`ma-voix-femme.wav`).
///
/// Renvoie `""` quand le nom ne dit rien : on n'invente jamais un genre.
pub fn gender_of_name(name: &str) -> &'static str {
    let lower = name.to_lowercase();
    let has = |markers: &[&str]| markers.iter().any(|marker| lower.contains(marker));
    if has(&["homme", "masculin", "-h-", "_h_", "-man", "male"]) {
        return "homme";
    }
    if has(&["femme", "feminin", "féminin", "-f-", "_f_", "-woman", "female"]) {
        return "femme";
    }
    ""
}

/// Libellé d'une voix, genre écrit EN CLAIR (exigence utilisateur).
pub fn voice_label(id: &str, gender: &str, cloned: bool) -> String {
    if cloned {
        return format!("{} — voix imitée ({})", ENGINE_NAME, id);
    }
    let genre = match gender {
        "homme" => "voix d'homme".to_string(),
        "femme" => "voix de femme".to_string(),
        _ => "genre non précisé".to_string(),
    };
    format!("{} — {} ({})", ENGINE_NAME, genre, id)
}

// ── Disposition sur le poste ────────────────────────────────────────────────

/// Racine du dossier de cette voix (`<app_data_dir>/voix-pocket`).
pub fn pocket_root(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(POCKET_DIR)
}

/// Dossier du moteur.
pub fn engine_dir(root: &Path) -> PathBuf {
    root.join(ENGINE_SUBDIR)
}

/// Dossier des voix déposées par l'utilisateur.
pub fn voices_dir(root: &Path) -> PathBuf {
    root.join(VOICES_SUBDIR)
}

/// `HF_HOME` du processus du moteur : c'est là que vivent les poids.
pub fn cache_dir(root: &Path) -> PathBuf {
    root.join(CACHE_SUBDIR)
}

/// Dossier des WAV temporaires.
pub fn tmp_dir(root: &Path) -> PathBuf {
    root.join(TMP_SUBDIR)
}

/// Nom de l'exécutable du moteur selon la plateforme.
pub fn engine_exe_name() -> &'static str {
    if cfg!(windows) {
        "pocket-tts.exe"
    } else {
        "pocket-tts"
    }
}

/// Emplacements où l'exécutable du moteur est cherché, DANS L'ORDRE.
///
/// Aucun autre emplacement n'est fouillé : l'utilisateur sait où déposer le
/// moteur, et l'état affiché nomme le premier chemin attendu.
pub fn engine_candidates(root: &Path) -> Vec<PathBuf> {
    let name = engine_exe_name();
    vec![
        engine_dir(root).join(name),
        engine_dir(root).join("Scripts").join(name),
        engine_dir(root).join(".venv").join("Scripts").join(name),
        engine_dir(root).join(".venv").join("bin").join(name),
        engine_dir(root).join("venv").join("Scripts").join(name),
        engine_dir(root).join("venv").join("bin").join(name),
    ]
}

/// Exécutable réellement présent (`None` si le moteur n'est pas installé).
pub fn find_engine(root: &Path) -> Option<PathBuf> {
    engine_candidates(root)
        .into_iter()
        .find(|candidate| candidate.is_file())
}

/// Chemin attendu « principal » (celui que l'état affiche).
pub fn engine_exe(root: &Path) -> PathBuf {
    engine_dir(root).join(engine_exe_name())
}

/// Fichier de voix imitée déposé par l'utilisateur (`None` s'il n'existe pas).
///
/// Deux formats acceptés : un WAV (audio de référence) et un `.safetensors`
/// (sortie de `pocket-tts export_voice`). Aucun autre fichier n'est considéré.
pub fn find_voice_file(root: &Path, id: &str) -> Option<PathBuf> {
    if !voice_id_is_clean(id) {
        return None;
    }
    for extension in ["wav", "safetensors"] {
        let candidate = voices_dir(root).join(format!("{}.{}", id, extension));
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

/// Vrai si la voix demandée est utilisable : une voix du moteur (incluse dans
/// les poids français) ou un fichier déposé dans le dossier des voix.
pub fn voice_is_available(root: &Path, id: &str) -> bool {
    is_catalog_voice(id) || find_voice_file(root, id).is_some()
}

/// Ce que le moteur reçoit pour `--voice` : l'identifiant d'une voix du moteur,
/// ou le CHEMIN ABSOLU d'une voix imitée.
pub fn engine_voice_arg(root: &Path, id: &str) -> String {
    if is_catalog_voice(id) {
        return id.to_string();
    }
    match find_voice_file(root, id) {
        Some(path) => path.to_string_lossy().to_string(),
        // Voix inconnue : on transmet l'identifiant tel quel ; le moteur refusera
        // et la raison remontera (jamais un silence).
        None => id.to_string(),
    }
}

// ── Poids du modèle (présence RÉELLE, jamais supposée) ──────────────────────

/// Cherche un poids français dans un dossier (parcours borné).
///
/// Le cache du moteur range ses fichiers sous `<cache>/hub/models--*/snapshots/
/// <empreinte>/languages/french/model.safetensors`. On accepte n'importe quelle
/// arborescence dont le fichier s'appelle `model.safetensors`, se trouve dans un
/// dossier `french` et atteint la taille minimale : aucun nom d'empreinte n'est
/// codé en dur.
pub fn french_weights_in(dir: &Path, depth: usize) -> Option<PathBuf> {
    if depth == 0 {
        return None;
    }
    let entries = std::fs::read_dir(dir).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        // `metadata` suit les liens : le cache du moteur en pose sur certaines
        // plateformes, et un lien mort est simplement ignoré.
        let Ok(meta) = std::fs::metadata(&path) else {
            continue;
        };
        if meta.is_dir() {
            if let Some(found) = french_weights_in(&path, depth - 1) {
                return Some(found);
            }
            continue;
        }
        if !meta.is_file() || meta.len() < MIN_WEIGHTS_BYTES {
            continue;
        }
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default();
        if name != "model.safetensors" {
            continue;
        }
        let in_french = path
            .parent()
            .and_then(|parent| parent.file_name())
            .and_then(|parent| parent.to_str())
            .map(|parent| parent.eq_ignore_ascii_case("french"))
            .unwrap_or(false);
        if in_french {
            return Some(path);
        }
    }
    None
}

/// Poids français installés (`None` tant qu'ils ne sont pas sur le disque).
pub fn french_weights_path(root: &Path) -> Option<PathBuf> {
    french_weights_in(&cache_dir(root), 8)
}

// ── Journal ─────────────────────────────────────────────────────────────────

/// Ajoute une ligne au journal EXISTANT de la chaîne vocale
/// (`<app_data>/voix-locale/voix-locale.log`), préfixée `[PocketTTS]`.
///
/// Une seule destination pour toute la chaîne vocale : aucun second journal.
/// Jamais d'exception (un journal indisponible ne doit pas empêcher la lecture).
pub fn log_into_chain(app: &tauri::AppHandle, message: &str) {
    let owned = String::from(message);
    let text = owned.trim();
    if text.is_empty() {
        return;
    }
    if let Some(chain_root) = crate::tts_local::local_voice_root(app) {
        crate::tts_local::append_log(&chain_root, &format!("[{}] {}", ENGINE_NAME, text));
    }
}

// ── État ────────────────────────────────────────────────────────────────────

/// Une voix telle qu'elle apparaît dans la liste des voix.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct PocketVoiceEntry {
    /// Identifiant (`estelle`, nom d'un fichier de voix imitée).
    pub id: String,
    /// Valeur complète du réglage (`local:pocket:<id>`).
    pub value: String,
    /// Libellé, genre écrit en clair.
    pub label: String,
    /// Genre (`femme` / `homme` / `""` si le nom ne dit rien).
    pub gender: String,
    /// `moteur` (prévue par le moteur) ou `imitee` (déposée par l'utilisateur).
    pub kind: String,
}

/// État de cette voix, tel qu'affiché par les Paramètres.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct PocketStatus {
    /// Vrai si le moteur, les poids ET la voix demandée sont présents.
    pub installed: bool,
    /// Nom lisible du moteur.
    pub engine: String,
    /// Vrai si l'exécutable du moteur a été trouvé.
    pub engine_present: bool,
    /// Exécutable réellement trouvé (vide s'il est absent).
    pub exe: String,
    /// Emplacement attendu (celui qu'on affiche quand rien n'est trouvé).
    pub exe_expected: String,
    /// Dossier des poids du modèle.
    pub cache_dir: String,
    /// Vrai si les poids français sont installés.
    pub model_present: bool,
    /// Taille des poids trouvés (octets).
    pub model_bytes: u64,
    /// Voix demandée (identifiant).
    pub voice: String,
    /// Vrai si la voix demandée est utilisable.
    pub voice_present: bool,
    /// Toutes les voix proposées (moteur + voix imitées trouvées).
    pub voices: Vec<PocketVoiceEntry>,
    /// Ce qui manque, en clair (liste vide si tout est là).
    pub missing: Vec<String>,
    /// Phrase unique expliquant la situation, et le repli appliqué.
    pub hint: String,
    /// Attribution obligatoire (poids CC-BY-4.0).
    pub attribution: String,
    /// Dossier de cette voix (affiché à l'utilisateur).
    pub dir: String,
    /// Journal de la chaîne vocale (une ligne par repli).
    pub log: String,
}

/// Voix proposées : la voix du moteur, puis chaque fichier de voix imitée.
///
/// Le contenu du dossier est lu à chaque appel (un fichier déposé ou retiré est
/// vu tout de suite). Aucune entrée n'est inventée : un dossier vide ne donne
/// qu'une voix, celle du moteur.
pub fn list_voices(root: &Path) -> Vec<PocketVoiceEntry> {
    let mut list: Vec<PocketVoiceEntry> = VOICES
        .iter()
        .map(|voice| PocketVoiceEntry {
            id: voice.id.to_string(),
            value: voice_value(voice.id),
            label: voice_label(voice.id, voice.gender, false),
            gender: voice.gender.to_string(),
            kind: "moteur".to_string(),
        })
        .collect();
    let mut files: Vec<String> = std::fs::read_dir(voices_dir(root))
        .map(|entries| {
            entries
                .flatten()
                .filter_map(|entry| {
                    let path = entry.path();
                    if !path.is_file() {
                        return None;
                    }
                    let extension = path
                        .extension()
                        .and_then(|value| value.to_str())
                        .map(|value| value.to_ascii_lowercase())
                        .unwrap_or_default();
                    if extension != "wav" && extension != "safetensors" {
                        return None;
                    }
                    path.file_stem()
                        .and_then(|value| value.to_str())
                        .map(|value| value.to_string())
                })
                .collect()
        })
        .unwrap_or_default();
    files.sort();
    for id in files {
        if !voice_id_is_clean(&id) || list.iter().any(|entry| entry.id == id) {
            continue;
        }
        let gender = gender_of_name(&id);
        list.push(PocketVoiceEntry {
            value: voice_value(&id),
            label: voice_label(&id, gender, true),
            gender: gender.to_string(),
            kind: "imitee".to_string(),
            id,
        });
    }
    list
}

/// Valeur complète du réglage pour un identifiant (`local:pocket:<id>`).
pub fn voice_value(id: &str) -> String {
    if id == DEFAULT_VOICE_ID {
        return VOICE_VALUE_PREFIX.to_string();
    }
    format!("{}:{}", VOICE_VALUE_PREFIX, id)
}

/// État calculé à partir des fichiers RÉELLEMENT présents.
pub fn status_for_dir(root: &Path, wanted: Option<&str>) -> PocketStatus {
    let voice = voice_id_for(wanted);
    let engine = find_engine(root);
    let weights = french_weights_path(root);
    let voice_present = voice_is_available(root, &voice);
    let engine_present = engine.is_some();
    let model_present = weights.is_some();
    let installed = engine_present && model_present && voice_present;
    let mut missing: Vec<String> = Vec::new();
    if !engine_present {
        missing.push("le moteur PocketTTS (programme séparé, non installé par Pilot)".to_string());
    }
    if !model_present {
        missing.push("les poids du modèle français (à télécharger sur un geste)".to_string());
    }
    if !voice_present {
        missing.push(format!("la voix « {} »", voice));
    }
    let hint = if installed {
        format!(
            "Voix {} prête : elle fonctionne hors ligne, sans clé et sans carte graphique. \
             {}.",
            ENGINE_NAME, ATTRIBUTION
        )
    } else if !engine_present {
        format!(
            "{} est un logiciel séparé : Pilot ne l'installe pas. Déposez son programme dans \
             « {} » pour l'utiliser. En attendant, la lecture se rabat sur la voix locale (Piper), \
             puis sur la voix du système — et le dit. {}.",
            ENGINE_NAME,
            engine_dir(root).display(),
            ATTRIBUTION
        )
    } else if !model_present {
        format!(
            "Le moteur {} est présent mais ses poids français ne sont pas encore installés \
             (environ 209 Mo, sur un geste seulement). En attendant, la lecture se rabat sur la \
             voix locale (Piper), puis sur la voix du système.",
            ENGINE_NAME
        )
    } else {
        format!(
            "La voix « {} » est introuvable dans « {} ». Déposez-la ou choisissez-en une autre ; \
             en attendant, la lecture se rabat sur la voix locale (Piper).",
            voice,
            voices_dir(root).display()
        )
    };
    PocketStatus {
        installed,
        engine: ENGINE_NAME.to_string(),
        engine_present,
        exe: engine
            .as_ref()
            .map(|path| path.to_string_lossy().to_string())
            .unwrap_or_default(),
        exe_expected: engine_exe(root).to_string_lossy().to_string(),
        cache_dir: cache_dir(root).to_string_lossy().to_string(),
        model_present,
        model_bytes: weights
            .as_ref()
            .and_then(|path| std::fs::metadata(path).ok())
            .map(|meta| meta.len())
            .unwrap_or(0),
        voice,
        voice_present,
        voices: list_voices(root),
        missing,
        hint,
        attribution: ATTRIBUTION.to_string(),
        dir: root.to_string_lossy().to_string(),
        log: crate::tts_local::log_path(&chain_root_placeholder(root))
            .to_string_lossy()
            .to_string(),
    }
}

/// Le journal vit dans le dossier de la chaîne vocale (Piper), pas ici : cette
/// fonction ne sert qu'à donner un chemin LISIBLE dans l'état, jamais à écrire.
fn chain_root_placeholder(root: &Path) -> PathBuf {
    root.parent()
        .map(|parent| parent.join(crate::tts_local::LOCAL_VOICE_DIR))
        .unwrap_or_else(|| root.to_path_buf())
}

// ── Lancement du moteur ─────────────────────────────────────────────────────

/// Variable d'environnement qui place le cache des poids SOUS notre dossier.
const ENV_CACHE: &str = "HF_HOME";

/// Environnement du processus du moteur : cache local, aucune télémétrie, et une
/// entrée/sortie en UTF-8 (les accents français ne doivent pas se perdre).
pub fn engine_env(root: &Path) -> Vec<(String, String)> {
    vec![
        (ENV_CACHE.to_string(), cache_dir(root).to_string_lossy().to_string()),
        ("HF_HUB_DISABLE_TELEMETRY".to_string(), "1".to_string()),
        ("PYTHONIOENCODING".to_string(), "utf-8".to_string()),
        ("PYTHONUTF8".to_string(), "1".to_string()),
    ]
}

/// Arguments du moteur pour une synthèse (un seul endroit, testable).
pub fn synth_args(voice_arg: &str, out: &Path) -> Vec<String> {
    vec![
        "generate".to_string(),
        "--language".to_string(),
        LANGUAGE.to_string(),
        "--voice".to_string(),
        voice_arg.to_string(),
        "--device".to_string(),
        "cpu".to_string(),
        "--output-path".to_string(),
        out.to_string_lossy().to_string(),
        "--quiet".to_string(),
        // Le texte arrive par l'entrée standard : aucun plafond de longueur de
        // ligne de commande, et aucun accent abîmé par le shell.
        "--text".to_string(),
        "-".to_string(),
    ]
}

/// Lance le moteur sur un texte et renvoie le WAV produit.
///
/// Le texte part par un thread dédié (un long texte ne doit jamais bloquer sur
/// le tampon du système) et les deux flux sont drainés par des threads (sinon un
/// flux non lu bloque le processus). Un plafond de temps interrompt le moteur.
fn run_engine(
    root: &Path,
    exe: &Path,
    voice_arg: &str,
    text: &str,
    out: &Path,
    timeout: Duration,
) -> Result<(), String> {
    let mut cmd = Command::new(exe);
    cmd.current_dir(engine_dir(root))
        .args(synth_args(voice_arg, out))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (key, value) in engine_env(root) {
        cmd.env(key, value);
    }
    crate::hide_console(&mut cmd);

    let mut child = cmd.spawn().map_err(|e| {
        format!(
            "Impossible de lancer le moteur {} ({}) : {}",
            ENGINE_NAME,
            exe.display(),
            e
        )
    })?;

    if let Some(mut stdin) = child.stdin.take() {
        let payload = format!("{}\n", text.trim());
        std::thread::spawn(move || {
            let _ = stdin.write_all(payload.as_bytes());
            let _ = stdin.flush();
        });
    }
    let mut out_child = child.stdout.take();
    let mut err_child = child.stderr.take();
    let out_handle = std::thread::spawn(move || {
        let mut buffer = Vec::with_capacity(4096);
        if let Some(ref mut stream) = out_child {
            let _ = stream.read_to_end(&mut buffer);
        }
        buffer
    });
    let err_handle = std::thread::spawn(move || {
        let mut buffer = Vec::with_capacity(4096);
        if let Some(ref mut stream) = err_child {
            let _ = stream.read_to_end(&mut buffer);
        }
        buffer
    });

    let start = Instant::now();
    let mut timed_out = false;
    let mut exit_ok = false;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                exit_ok = status.success();
                break;
            }
            Ok(None) => {
                if start.elapsed() >= timeout {
                    let _ = child.kill();
                    timed_out = true;
                    break;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(_) => {
                let _ = child.kill();
                break;
            }
        }
    }
    let _ = out_handle.join();
    let stderr = err_handle.join().unwrap_or_default();

    if timed_out {
        return Err(format!(
            "la synthèse {} n'a pas répondu en {} s (moteur interrompu)",
            ENGINE_NAME,
            timeout.as_secs()
        ));
    }
    if !exit_ok {
        let detail = String::from_utf8_lossy(&stderr).trim().to_string();
        let detail = if detail.len() > 400 {
            format!("…{}", &detail[detail.len() - 400..])
        } else {
            detail
        };
        return Err(if detail.is_empty() {
            format!("le moteur {} s'est arrêté sans produire de son", ENGINE_NAME)
        } else {
            format!("le moteur {} a échoué : {}", ENGINE_NAME, detail)
        });
    }
    Ok(())
}

/// Vrai si les octets commencent par un en-tête WAV (`RIFF` … `WAVE`).
pub fn wav_looks_valid(bytes: &[u8]) -> bool {
    bytes.len() > 44 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WAVE"
}

/// Synthétise un texte en WAV et renvoie son contenu encodé en base64.
///
/// **Aucun téléchargement ici** : sans poids installés, la fonction ÉCHOUE avec
/// la raison de l'état (verrou de test). Aucun repli n'est décidé ici : on
/// journalise une ligne claire et on renvoie l'erreur ; c'est le front qui
/// retombe sur Piper puis sur la voix du système, et qui l'annonce.
pub fn synthesize_base64(root: &Path, voice: Option<&str>, text: &str) -> Result<String, String> {
    let payload = text.trim();
    if payload.is_empty() {
        return Err("texte vide : rien à synthétiser".to_string());
    }
    let status = status_for_dir(root, voice);
    if !status.installed {
        let reason = status.hint.clone();
        append_log_for(root, &format!("Repli (voix indisponible) — {}", reason));
        return Err(reason);
    }
    let exe = find_engine(root)
        .ok_or_else(|| format!("moteur {} introuvable", ENGINE_NAME))?;
    std::fs::create_dir_all(tmp_dir(root))
        .map_err(|e| format!("dossier temporaire de la voix {} : {}", ENGINE_NAME, e))?;
    let out = tmp_dir(root).join(format!("{}.wav", uuid::Uuid::new_v4()));
    let voice_arg = engine_voice_arg(root, &status.voice);
    let result = run_engine(root, &exe, &voice_arg, payload, &out, SYNTH_TIMEOUT);
    let bytes = std::fs::read(&out).unwrap_or_default();
    // Le WAV de synthèse est un temporaire : il est retiré dans TOUS les cas.
    let _ = std::fs::remove_file(&out);
    if let Err(reason) = result {
        append_log_for(
            root,
            &format!("Échec de la synthèse — {} (repli sur la voix locale)", reason),
        );
        return Err(reason);
    }
    if !wav_looks_valid(&bytes) {
        let reason = format!("le moteur {} n'a produit aucun son lisible", ENGINE_NAME);
        append_log_for(root, &format!("Échec de la synthèse — {}", reason));
        return Err(reason);
    }
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

/// Écrit dans le journal de la chaîne à partir du dossier de CETTE voix
/// (l'appelant n'a pas toujours le `AppHandle` : les tests, par exemple).
fn append_log_for(root: &Path, message: &str) {
    let chain = chain_root_placeholder(root);
    let chain = if chain.is_dir() { chain } else { root.to_path_buf() };
    crate::tts_local::append_log(&chain, &format!("[{}] {}", ENGINE_NAME, message));
}

/// Installe les poids du modèle français — **GESTE EXPLICITE UNIQUEMENT**.
///
/// Cette fonction est la SEULE du module qui peut provoquer un téléchargement :
/// elle n'est appelée que par la commande `tts_pocket_install`, elle-même
/// déclenchée par un clic dans la section « Lecture des réponses ». Elle ne
/// télécharge aucun moteur (Pilot ne l'installe pas), ne supprime aucun fichier,
/// et relit l'état RÉEL après coup : le succès n'est annoncé que si les poids
/// sont vraiment sur le disque.
pub fn install_weights(root: &Path) -> Result<String, String> {
    let exe = find_engine(root).ok_or_else(|| {
        format!(
            "{} est un logiciel séparé : Pilot ne l'installe pas. Déposez son programme dans « {} ».",
            ENGINE_NAME,
            engine_dir(root).display()
        )
    })?;
    std::fs::create_dir_all(tmp_dir(root))
        .map_err(|e| format!("dossier temporaire de la voix {} : {}", ENGINE_NAME, e))?;
    let out = tmp_dir(root).join(format!("{}.wav", uuid::Uuid::new_v4()));
    let voice_arg = engine_voice_arg(root, DEFAULT_VOICE_ID);
    // Phrase courte de français : elle ne sert qu'à faire charger le modèle au
    // moteur (et donc à télécharger ses poids). Son son n'est jamais joué.
    let probe = "Installation de la voix PocketTTS.";
    let result = run_engine(root, &exe, &voice_arg, probe, &out, INSTALL_TIMEOUT);
    let valid = std::fs::read(&out).map(|bytes| wav_looks_valid(&bytes)).unwrap_or(false);
    let _ = std::fs::remove_file(&out);
    let weights = french_weights_path(root);
    match (result, weights) {
        (_, Some(path)) => {
            let size = std::fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0);
            let message = format!(
                "Voix {} installée ({:.0} Mo) : elle fonctionne désormais hors ligne.",
                ENGINE_NAME,
                size as f64 / (1024.0 * 1024.0)
            );
            append_log_for(root, &message);
            Ok(message)
        }
        (Err(reason), None) => {
            append_log_for(root, &format!("Installation impossible — {}", reason));
            Err(reason)
        }
        (Ok(()), None) if valid => Err(format!(
            "le moteur {} a répondu mais ses poids français restent introuvables dans « {} »",
            ENGINE_NAME,
            cache_dir(root).display()
        )),
        (Ok(()), None) => Err(format!(
            "le moteur {} n'a produit aucun son et aucun poids n'a été installé",
            ENGINE_NAME
        )),
    }
}

// ── Commandes Tauri ─────────────────────────────────────────────────────────

/// Dossier de CETTE instance de Pilot (`<app_data_dir>/voix-pocket`).
pub fn pocket_root_for(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|dir| pocket_root(&dir))
}

/// État du moteur PocketTTS (présence réelle du programme, des poids et de la
/// voix demandée). `voice` est la valeur du réglage ou un identifiant.
#[tauri::command]
pub fn tts_pocket_status(app: tauri::AppHandle, voice: Option<String>) -> PocketStatus {
    match pocket_root_for(&app) {
        Some(root) => status_for_dir(&root, voice.as_deref()),
        None => PocketStatus {
            installed: false,
            engine: ENGINE_NAME.to_string(),
            engine_present: false,
            exe: String::new(),
            exe_expected: String::new(),
            cache_dir: String::new(),
            model_present: false,
            model_bytes: 0,
            voice: voice_id_for(voice.as_deref()),
            voice_present: false,
            voices: Vec::new(),
            missing: vec!["dossier de données de Pilot introuvable".to_string()],
            hint: format!(
                "Dossier de données de Pilot introuvable : la lecture se rabat sur la voix locale \
                 (Piper), puis sur la voix du système."
            ),
            attribution: ATTRIBUTION.to_string(),
            dir: String::new(),
            log: String::new(),
        },
    }
}

/// Synthétise un morceau de texte (WAV en base64).
///
/// Commande **async** : la synthèse dure plusieurs secondes (modèle à froid) →
/// exécutée hors du thread de la fenêtre (jamais de gel de l'interface).
#[tauri::command]
pub async fn tts_pocket_synthesize(
    app: tauri::AppHandle,
    text: String,
    voice: Option<String>,
) -> Result<String, String> {
    let root = pocket_root_for(&app)
        .ok_or_else(|| "dossier de données de Pilot introuvable".to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        synthesize_base64(&root, voice.as_deref(), &text)
    })
    .await
    .map_err(|e| format!("Erreur interne (join) tts_pocket_synthesize: {}", e))?
}

/// Télécharge les poids du modèle français — **sur geste de l'utilisateur**.
#[tauri::command]
pub async fn tts_pocket_install(app: tauri::AppHandle) -> Result<String, String> {
    let root = pocket_root_for(&app)
        .ok_or_else(|| "dossier de données de Pilot introuvable".to_string())?;
    tauri::async_runtime::spawn_blocking(move || install_weights(&root))
        .await
        .map_err(|e| format!("Erreur interne (join) tts_pocket_install: {}", e))?
}

/// Ajoute une ligne au journal de la chaîne vocale (repli décidé côté fenêtre).
#[tauri::command]
pub fn tts_pocket_log(app: tauri::AppHandle, message: String) {
    log_into_chain(&app, &message);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "pilot-tts-pocket-{}-{}",
            tag,
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).expect("dossier temporaire");
        dir
    }

    /// Écrit un fichier de la taille EXACTE demandée sans écrire les octets
    /// (`set_len` réserve la taille) : un poids « installé » n'a pas besoin de
    /// peser 209 Mo sur le disque de test.
    fn write_sized(path: &Path, len: u64) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        let file = std::fs::File::create(path).expect("fichier de test");
        file.set_len(len).expect("taille du fichier de test");
    }

    #[test]
    fn la_valeur_du_reglage_designe_toujours_une_voix() {
        // Valeur historique : la voix par défaut du moteur.
        assert_eq!(voice_id_for(None), DEFAULT_VOICE_ID);
        assert_eq!(voice_id_for(Some("")), DEFAULT_VOICE_ID);
        assert_eq!(voice_id_for(Some("   ")), DEFAULT_VOICE_ID);
        assert_eq!(voice_id_for(Some("local:pocket")), DEFAULT_VOICE_ID);
        assert_eq!(voice_id_for(Some("local:pocket:estelle")), "estelle");
        // Une valeur d'un AUTRE moteur n'est jamais interprétée ici.
        assert_eq!(voice_id_for(Some("local:piper")), DEFAULT_VOICE_ID);
        assert_eq!(voice_id_for(Some("local:voicestudio:abc")), DEFAULT_VOICE_ID);
        // Identifiant douteux : jamais de sortie du dossier des voix.
        for bad in [
            "local:pocket:../../secret",
            "local:pocket:a/b",
            "local:pocket:..",
        ] {
            assert_eq!(voice_id_for(Some(bad)), DEFAULT_VOICE_ID, "{bad}");
        }
    }

    #[test]
    fn la_valeur_du_reglage_est_stable_dans_les_deux_sens() {
        assert_eq!(voice_value(DEFAULT_VOICE_ID), VOICE_VALUE_PREFIX);
        let cloned = voice_value("ma-voix");
        assert_eq!(cloned, "local:pocket:ma-voix");
        assert_eq!(voice_id_for(Some(&cloned)), "ma-voix");
        // Le préfixe reste `local:` : le son est fabriqué sur cet ordinateur.
        assert!(cloned.starts_with("local:"));
        // Aucune collision avec les deux moteurs existants.
        assert!(!cloned.starts_with("local:piper"));
        assert!(!cloned.starts_with("local:voicestudio"));
    }

    #[test]
    fn le_genre_est_ecrit_en_clair_dans_les_libelles() {
        assert!(voice_label(DEFAULT_VOICE_ID, "femme", false).contains("voix de femme"));
        assert!(voice_label("x", "homme", false).contains("voix d'homme"));
        assert!(voice_label("x", "", false).contains("genre non précisé"));
        assert!(voice_label("ma-voix", "", true).contains("voix imitée"));
        // Le nom du moteur et l'identifiant sont toujours là.
        let label = voice_label(DEFAULT_VOICE_ID, "femme", false);
        assert!(label.contains(ENGINE_NAME) && label.contains(DEFAULT_VOICE_ID));
        // Genre lu dans un nom de fichier, jamais inventé.
        assert_eq!(gender_of_name("ma-voix-femme"), "femme");
        assert_eq!(gender_of_name("voix_homme_2"), "homme");
        assert_eq!(gender_of_name("estelle"), "");
    }

    #[test]
    fn l_attribution_est_presente_une_seule_fois() {
        assert!(ATTRIBUTION.contains("Kyutai"));
        assert!(ATTRIBUTION.contains("CC BY 4.0"));
        let status = status_for_dir(&temp_root("attr"), None);
        assert_eq!(status.attribution, ATTRIBUTION);
        // Elle est dite dans la phrase d'état, donc visible à l'écran.
        assert!(status.hint.contains("Kyutai"));
    }

    #[test]
    fn la_table_des_voix_du_moteur_est_coherente() {
        assert!(!VOICES.is_empty());
        // La voix par défaut est bien dans la table, et son genre est écrit.
        assert!(is_catalog_voice(DEFAULT_VOICE_ID));
        assert_eq!(VOICES[0].id, DEFAULT_VOICE_ID);
        assert!(VOICES.iter().all(|voice| voice_id_is_clean(voice.id)));
        // Aucun identifiant en double.
        for (index, voice) in VOICES.iter().enumerate() {
            assert!(
                !VOICES[index + 1..].iter().any(|other| other.id == voice.id),
                "{} en double",
                voice.id
            );
        }
    }

    #[test]
    fn l_etat_derive_des_fichiers_reellement_presents() {
        let root = temp_root("etat");
        let mut status = status_for_dir(&root, None);
        assert!(!status.installed);
        assert!(!status.engine_present);
        assert!(!status.model_present);
        // Une voix du moteur est toujours « disponible » une fois les poids là.
        assert!(status.voice_present);
        // Ce qui manque est NOMMÉ (jamais une liste vide trompeuse).
        assert_eq!(status.missing.len(), 2);
        assert!(status.hint.contains("Piper"));

        // Moteur posé (fichier factice) : il est vu tel quel.
        write_sized(&engine_exe(&root), 8);
        status = status_for_dir(&root, None);
        assert!(status.engine_present);
        assert!(!status.model_present);
        assert_eq!(status.exe, engine_exe(&root).to_string_lossy().to_string());

        // Poids français posés à l'emplacement du cache du moteur.
        let weights = cache_dir(&root)
            .join("hub")
            .join("models--kyutai--pocket-tts-without-voice-cloning")
            .join("snapshots")
            .join("abc")
            .join("languages")
            .join("french")
            .join("model.safetensors");
        write_sized(&weights, MIN_WEIGHTS_BYTES + 1);
        status = status_for_dir(&root, None);
        assert!(status.model_present);
        assert_eq!(status.model_bytes, MIN_WEIGHTS_BYTES + 1);
        // Moteur + poids + voix du moteur : la voix est installée.
        assert!(status.installed);
        assert!(status.missing.is_empty());
    }

    #[test]
    fn un_poids_tronque_n_est_jamais_un_modele_installe() {
        let root = temp_root("tronque");
        let weights = cache_dir(&root)
            .join("hub")
            .join("models--x")
            .join("snapshots")
            .join("abc")
            .join("languages")
            .join("french")
            .join("model.safetensors");
        write_sized(&weights, 4);
        assert!(french_weights_path(&root).is_none());
        // Un fichier du bon nom mais hors du dossier `french` n'est pas retenu.
        let ailleurs = cache_dir(&root).join("model.safetensors");
        write_sized(&ailleurs, MIN_WEIGHTS_BYTES + 1);
        assert!(french_weights_path(&root).is_none());
    }

    #[test]
    fn les_voix_imitees_deposees_sont_des_voix_ordinaires() {
        let root = temp_root("imitee");
        // Dossier vide : une seule voix, celle du moteur.
        assert_eq!(list_voices(&root).len(), VOICES.len());
        write_sized(&voices_dir(&root).join("ma-voix-femme.wav"), 16);
        let voices = list_voices(&root);
        assert_eq!(voices.len(), VOICES.len() + 1);
        let cloned = voices.iter().find(|v| v.id == "ma-voix-femme").unwrap();
        assert_eq!(cloned.kind, "imitee");
        assert_eq!(cloned.gender, "femme");
        assert_eq!(cloned.value, "local:pocket:ma-voix-femme");
        assert!(cloned.label.contains("voix imitée"));
        // Rien d'autre n'est proposé : aucun fichier inventé.
        assert!(voices.iter().all(|v| v.id == DEFAULT_VOICE_ID
            || v.id == "ma-voix-femme"));
    }

    #[test]
    fn la_synthese_ne_telecharge_jamais_rien() {
        // VERROU : sans moteur et sans poids, la synthèse ÉCHOUE et ne laisse
        // AUCUN fichier derrière elle (aucun téléchargement, aucune écriture).
        let root = temp_root("pas-de-telechargement");
        let error = synthesize_base64(&root, None, "Bonjour, ceci est un essai.")
            .expect_err("la synthèse doit échouer sans moteur");
        assert!(error.contains("PocketTTS"));
        assert!(french_weights_path(&root).is_none());
        assert!(!tmp_dir(&root).exists());
        assert!(!engine_dir(&root).exists());

        // Même chose avec un moteur factice mais SANS poids : aucun processus
        // n'est lancé (le fichier factice n'est pas exécutable, donc une
        // tentative d'exécution donnerait une autre erreur).
        write_sized(&engine_exe(&root), 8);
        let error = synthesize_base64(&root, None, "Encore un essai.")
            .expect_err("la synthèse doit échouer sans poids");
        assert!(error.contains("poids") || error.contains("PocketTTS"));
        assert!(french_weights_path(&root).is_none());
        assert!(!tmp_dir(&root).exists());
    }

    #[test]
    fn l_installation_refuse_sans_moteur_et_ne_cree_rien() {
        // VERROU : le geste d'installation ne peut pas inventer un moteur, et il
        // n'écrit aucun fichier quand il refuse.
        let root = temp_root("installation-sans-moteur");
        let error = install_weights(&root).expect_err("sans moteur, l'installation refuse");
        assert!(error.contains("logiciel séparé"));
        assert!(!tmp_dir(&root).exists());
        assert!(find_engine(&root).is_none());
    }

    #[test]
    fn les_arguments_du_moteur_sont_fixes_et_complets() {
        let out = PathBuf::from("/tmp/essai.wav");
        let args = synth_args("estelle", &out);
        // Le français est DEMANDÉ (ce n'est pas la langue par défaut du moteur).
        assert!(args.windows(2).any(|pair| pair[0] == "--language" && pair[1] == "french"));
        // Le processeur seul : aucune carte graphique exigée.
        assert!(args.windows(2).any(|pair| pair[0] == "--device" && pair[1] == "cpu"));
        // La voix est transmise telle quelle.
        assert!(args.windows(2).any(|pair| pair[0] == "--voice" && pair[1] == "estelle"));
        // Le texte arrive par l'entrée standard (aucun accent abîmé).
        assert!(args.windows(2).any(|pair| pair[0] == "--text" && pair[1] == "-"));
        // Le WAV va là où on l'attend, et nulle part ailleurs.
        assert!(args
            .windows(2)
            .any(|pair| pair[0] == "--output-path" && pair[1] == out.to_string_lossy()));
        // Le premier argument est bien la sous-commande.
        assert_eq!(args[0], "generate");
    }

    #[test]
    fn le_cache_du_moteur_reste_dans_notre_dossier() {
        let root = temp_root("cache");
        let env = engine_env(&root);
        let cache = env.iter().find(|(key, _)| key == ENV_CACHE).unwrap();
        assert_eq!(cache.1, cache_dir(&root).to_string_lossy().to_string());
        // Aucune télémétrie, et des accents qui survivent au passage.
        assert!(env.iter().any(|(key, _)| key == "HF_HUB_DISABLE_TELEMETRY"));
        assert!(env
            .iter()
            .any(|(key, value)| key == "PYTHONIOENCODING" && value == "utf-8"));
    }

    #[test]
    fn un_wav_tronque_est_refuse() {
        assert!(!wav_looks_valid(b""));
        assert!(!wav_looks_valid(b"RIFF"));
        let mut fake = vec![0u8; 64];
        fake[0..4].copy_from_slice(b"RIFF");
        fake[8..12].copy_from_slice(b"WAVE");
        assert!(wav_looks_valid(&fake));
        fake[8..12].copy_from_slice(b"AVI ");
        assert!(!wav_looks_valid(&fake));
    }

    #[test]
    fn le_moteur_est_cherche_a_un_seul_endroit_connu() {
        let root = temp_root("moteur");
        let candidates = engine_candidates(&root);
        assert!(candidates.len() >= 2);
        // Le premier chemin attendu est celui qu'affiche l'état.
        assert_eq!(candidates[0], engine_exe(&root));
        // Tous les chemins restent DANS notre dossier (aucune recherche ailleurs
        // sur le disque, aucune variable d'environnement détournée).
        assert!(candidates.iter().all(|path| path.starts_with(&root)));
        assert!(find_engine(&root).is_none());
        // Un exécutable posé dans l'environnement virtuel est trouvé.
        let venv = engine_dir(&root)
            .join(".venv")
            .join("Scripts")
            .join(engine_exe_name());
        write_sized(&venv, 4);
        assert_eq!(find_engine(&root), Some(venv));
    }
}
