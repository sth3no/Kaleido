//! The list of bindings the shortcuts page shows (spec 8.10), worked out from mpv's
//! `input-bindings` property: one [`Binding`] per key, with where it comes from, and the edit
//! that moves a binding to another key. Pure: the player and the file are
//! [`super`]'s business, the file editor is [`super::input_conf`].

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use super::SettingsError;
use super::input_conf::{InputConf, check_key};

/// One entry of mpv's `input-bindings`: a binding of an input section, active or not, also one
/// that another binding of the same key overrides.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct RawBinding {
    pub key: String,
    #[serde(default)]
    pub cmd: String,
    /// The section's place among the active ones; negative for a section that is not active.
    #[serde(default)]
    pub priority: i64,
    /// A default of mpv or of a script, which what the user binds overrides.
    #[serde(default)]
    pub is_weak: bool,
    /// The script (its name) that defined the section.
    pub owner: Option<String>,
    /// The `#@` description of the line in input.conf.
    pub comment: Option<String>,
}

/// Parses `input-bindings` as mpv gives it as text (JSON).
pub fn parse_raw(json: &str) -> Result<Vec<RawBinding>, serde_json::Error> {
    serde_json::from_str(json)
}

/// Where a binding comes from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum BindingSource {
    /// A line of Kaleido's own default `input.conf`, as it ships.
    Kaleido,
    /// The user's: a line of input.conf of their own, or one set from the settings.
    User,
    /// One of mpv's built-in bindings.
    Mpv,
    /// A script's; `name` is the script.
    Plugin { name: String },
}

/// A key and what it does now, for the shortcuts page.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Binding {
    pub key: String,
    /// The mpv command. A key the user silenced has `ignore`.
    pub command: String,
    pub source: BindingSource,
    pub comment: Option<String>,
}

/// Whether `candidate` beats `current` for the same key, as mpv's own scripts decide it from
/// this list: a binding of the user over a weak one, then the section enabled later. Of two
/// equal ones the first stays.
fn beats(candidate: &RawBinding, current: &RawBinding) -> bool {
    (current.is_weak && !candidate.is_weak)
        || (candidate.is_weak == current.is_weak && candidate.priority > current.priority)
}

/// The script a binding belongs to, if it has one.
fn owner(entry: &RawBinding) -> Option<&str> {
    entry.owner.as_deref().filter(|name| !name.is_empty())
}

fn same_command(a: &str, b: &str) -> bool {
    a.trim() == b.trim()
}

/// Where the binding that is active for a key comes from. `weak` is the best default (of mpv or
/// a script) the key has underneath, `kaleido` the command of Kaleido's own line for the key.
fn source_of(
    winner: &RawBinding,
    weak: Option<&RawBinding>,
    kaleido: Option<&str>,
) -> BindingSource {
    let weak_source = |entry: &RawBinding| match owner(entry) {
        Some(name) => BindingSource::Plugin {
            name: name.to_owned(),
        },
        None => BindingSource::Mpv,
    };
    if owner(winner).is_some() || winner.is_weak {
        return weak_source(winner);
    }
    if kaleido.is_some_and(|default| same_command(default, &winner.cmd)) {
        return BindingSource::Kaleido;
    }
    // mpv has no live unbind, so a reset binds a weak default's command by hand (see
    // `fallback_command`); the label is the default's, which is what it is after a restart.
    match weak {
        Some(weak) if same_command(&weak.cmd, &winner.cmd) => weak_source(weak),
        _ => BindingSource::User,
    }
}

/// One binding per key, the one that is active, in the order mpv lists the keys. Sections that
/// are not active (a script's that is not enabled yet) are left out. `kaleido` has the commands
/// of Kaleido's default input.conf (see [`InputConf::commands`]).
pub fn derive(raw: &[RawBinding], kaleido: &HashMap<String, String>) -> Vec<Binding> {
    let mut keys: Vec<&str> = Vec::new();
    let mut entries: HashMap<&str, Vec<&RawBinding>> = HashMap::new();
    for entry in raw
        .iter()
        .filter(|entry| entry.priority >= 0 && !entry.key.is_empty())
    {
        let same_key = entries.entry(entry.key.as_str()).or_default();
        if same_key.is_empty() {
            keys.push(entry.key.as_str());
        }
        same_key.push(entry);
    }
    keys.into_iter()
        .filter_map(|key| {
            let same_key = entries.get(key)?;
            let winner = pick(same_key.iter().copied(), beats)?;
            let weak = pick(
                same_key.iter().copied().filter(|entry| entry.is_weak),
                |entry, best| entry.priority > best.priority,
            );
            Some(Binding {
                key: key.to_owned(),
                command: winner.cmd.clone(),
                source: source_of(winner, weak, kaleido.get(key).map(String::as_str)),
                comment: winner.comment.clone().filter(|comment| !comment.is_empty()),
            })
        })
        .collect()
}

/// The best of `entries` by `better(entry, best_so_far)`; the first of equal ones.
fn pick<'a>(
    entries: impl Iterator<Item = &'a RawBinding>,
    better: impl Fn(&RawBinding, &RawBinding) -> bool,
) -> Option<&'a RawBinding> {
    entries.fold(None, |best, entry| match best {
        Some(best) if !better(entry, best) => Some(best),
        _ => Some(entry),
    })
}

/// What the running player is to bind on `key` when the user's binding on it is taken away from
/// input.conf. mpv cannot unbind a key at run time, so the key is bound to what it does without
/// the user's binding:
/// - `None`: the user has no binding of their own on the key (what is active is mpv's or a
///   plugin's already); there is nothing to bind.
/// - `Some(command)`: the command of the best default (mpv's or a plugin's) under the user's.
/// - `Some("ignore")`: there is none under it; the key is to do nothing, as it will be after the
///   next start.
pub fn fallback_command(raw: &[RawBinding], key: &str) -> Option<String> {
    let active: Vec<&RawBinding> = raw
        .iter()
        .filter(|entry| entry.key == key && entry.priority >= 0)
        .collect();
    let overridden = active
        .iter()
        .any(|entry| !entry.is_weak && owner(entry).is_none());
    if !overridden {
        return None;
    }
    let weak = pick(
        active.iter().copied().filter(|entry| entry.is_weak),
        |entry, best| entry.priority > best.priority,
    );
    Some(weak.map_or_else(|| "ignore".to_owned(), |entry| entry.cmd.clone()))
}

/// Changes `conf` to move the command of the active binding of `key` to `new_key` and to silence
/// `key`. Returns that command, for the player to bind live; `None` if `key` and `new_key` are
/// the same and nothing is to be done. The command comes from the binding that is active for
/// `key` (`bindings`) and from nowhere else, so the UI cannot bind a command of its own: a key
/// that has no binding is refused, and so is a silenced one (there is nothing to move).
///
/// `new_key` may be bound already. Its line is then rewritten (the last line of a key wins in
/// mpv), and any default it had under it is simply overridden.
pub fn move_binding(
    conf: &mut InputConf,
    bindings: &[Binding],
    key: &str,
    new_key: &str,
) -> Result<Option<String>, SettingsError> {
    check_key("key", key)?;
    check_key("newKey", new_key)?;
    let current = bindings
        .iter()
        .find(|binding| binding.key == key)
        .filter(|binding| !same_command(&binding.command, "ignore"))
        .ok_or_else(|| SettingsError::NotAllowed {
            key: key.to_owned(),
        })?;
    if key == new_key {
        return Ok(None);
    }
    conf.bind(new_key, &current.command)?;
    conf.silence(key)?;
    Ok(Some(current.command.clone()))
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::thread;
    use std::time::{Duration, Instant};

    use super::*;
    use crate::player::Engine;
    use crate::player::options::{DEFAULT_INPUT_CONF, ensure_defaults};
    use crate::player::testing::{NoEvents, headless, temp_paths};
    use crate::settings::input_conf::kaleido_default;
    use crate::settings::{INPUT_CONF, bindings as player_bindings, rebind, reset_binding};

    const KALEIDO_S: &str = "script-message kaleido screenshot subtitles";

    /// The prefixes mpv's input commands may start with (mpv's input/cmd.c).
    const MPV_COMMAND_PREFIXES: [&str; 12] = [
        "no-osd",
        "osd-bar",
        "osd-msg",
        "osd-msg-bar",
        "osd-auto",
        "expand-properties",
        "raw",
        "repeatable",
        "nonrepeatable",
        "nonscalable",
        "async",
        "sync",
    ];

    fn binding(key: &str, command: &str, source: BindingSource) -> Binding {
        Binding {
            key: key.to_owned(),
            command: command.to_owned(),
            source,
            comment: None,
        }
    }

    fn raw(json: &str) -> Vec<RawBinding> {
        parse_raw(json).unwrap()
    }

    #[test]
    fn rebind_moves_the_command_and_silences_the_old_key() {
        let mut conf = InputConf::parse("# keys\ns shot\nx other\n");
        let bindings = [binding("s", "shot", BindingSource::Kaleido)];

        // The command is the one of the active binding; `n` is new, `s` is silenced in place.
        let moved = move_binding(&mut conf, &bindings, "s", "n").unwrap();
        assert_eq!(moved.as_deref(), Some("shot"));
        assert_eq!(conf.render(), "# keys\ns ignore\nx other\nn shot\n");

        // Onto a key that is bound: its line is rewritten, so the old binding is overridden.
        let mut conf = InputConf::parse("# keys\ns shot\nx other\n");
        move_binding(&mut conf, &bindings, "s", "x").unwrap();
        assert_eq!(conf.render(), "# keys\ns ignore\nx shot\n");

        // A binding that no line of input.conf has (mpv's own, a script's) is moved the same
        // way: the new key gets the command, the old key a line that silences it.
        let space = [binding("SPACE", "cycle pause", BindingSource::Mpv)];
        let mut conf = InputConf::parse("# keys\n");
        move_binding(&mut conf, &space, "SPACE", "p").unwrap();
        assert_eq!(conf.render(), "# keys\np cycle pause\nSPACE ignore\n");

        // The same key twice changes nothing.
        let mut conf = InputConf::parse("s shot\n");
        assert_eq!(move_binding(&mut conf, &bindings, "s", "s").unwrap(), None);
        assert_eq!(conf.render(), "s shot\n");

        // A silenced key has nothing to move.
        let silenced = [binding("s", "ignore", BindingSource::User)];
        let mut conf = InputConf::parse("s ignore\n");
        assert_eq!(
            move_binding(&mut conf, &silenced, "s", "n"),
            Err(SettingsError::NotAllowed { key: "s".into() })
        );
        assert_eq!(conf.render(), "s ignore\n");
    }

    #[test]
    fn rebinding_an_unknown_key_fails() {
        // The UI sends keys, never a command: a key with no binding has none to move.
        let bindings = [binding("s", "shot", BindingSource::Kaleido)];
        let text = "s shot\n";
        let mut conf = InputConf::parse(text);
        assert_eq!(
            move_binding(&mut conf, &bindings, "F13", "q"),
            Err(SettingsError::NotAllowed { key: "F13".into() })
        );
        assert_eq!(
            move_binding(&mut conf, &[], "s", "q"),
            Err(SettingsError::NotAllowed { key: "s".into() })
        );
        // Keys are case-sensitive here too.
        assert_eq!(
            move_binding(&mut conf, &bindings, "S", "q"),
            Err(SettingsError::NotAllowed { key: "S".into() })
        );
        assert_eq!(conf.render(), text);
    }

    #[test]
    fn rebinding_with_invalid_key_names_fails() {
        let long = "x".repeat(33);
        let bad = [
            "",
            "a b",
            "x\ny",
            "\t",
            "#x",
            "{x}",
            "{section",
            long.as_str(),
        ];
        let bindings = [binding("s", "shot", BindingSource::Kaleido)];
        for key in bad {
            let mut conf = InputConf::parse("s shot\n");
            let invalid = |error: SettingsError| matches!(error, SettingsError::Invalid { .. });
            assert!(
                invalid(move_binding(&mut conf, &bindings, key, "q").unwrap_err()),
                "{key:?}"
            );
            assert!(
                invalid(move_binding(&mut conf, &bindings, "s", key).unwrap_err()),
                "{key:?}"
            );
            assert_eq!(conf.render(), "s shot\n", "{key:?}");
        }
        // A command that cannot be written to a line is refused too, with nothing changed.
        let hostile = [binding("s", "a\nb ignore", BindingSource::Kaleido)];
        let mut conf = InputConf::parse("s shot\n");
        assert!(matches!(
            move_binding(&mut conf, &hostile, "s", "q"),
            Err(SettingsError::Invalid { .. })
        ));
        assert_eq!(conf.render(), "s shot\n");
    }

    #[test]
    fn bindings_are_worked_out_from_input_bindings() {
        let raw = raw(r#"[
            {"key":"s","cmd":"screenshot","section":"default","priority":0,"is_weak":true},
            {"key":"s","cmd":"script-message kaleido screenshot subtitles","section":"default",
             "priority":0,"is_weak":false},
            {"key":"x","cmd":"add sub-delay +0.1","section":"default","priority":0,"is_weak":true},
            {"key":"x","cmd":"script-binding testbind/test-x","section":"input_testbind",
             "priority":1,"is_weak":true,"owner":"testbind"},
            {"key":"SPACE","cmd":"cycle pause","section":"default","priority":0,"is_weak":true},
            {"key":"F12","cmd":"show-text mine","section":"default","priority":0,
             "is_weak":false,"comment":"my text"},
            {"key":"y","cmd":"later","section":"input_later","priority":-1,"is_weak":true,
             "owner":"later"},
            {"key":"q","cmd":"quit","section":"default","priority":0,"is_weak":true},
            {"key":"q","cmd":"ignore","section":"default","priority":0,"is_weak":false},
            {"key":"m","cmd":"script-binding forced/m","section":"input_forced_forced",
             "priority":2,"is_weak":false,"owner":"forced"},
            {"key":"m","cmd":"cycle mute","section":"default","priority":0,"is_weak":false}
        ]"#);
        let kaleido = InputConf::parse(DEFAULT_INPUT_CONF).commands();
        let listed = derive(&raw, &kaleido);
        let find = |key: &str| listed.iter().find(|b| b.key == key).unwrap();

        // One binding per key, the active one, in the order mpv lists the keys.
        let keys: Vec<&str> = listed.iter().map(|b| b.key.as_str()).collect();
        assert_eq!(keys, ["s", "x", "SPACE", "F12", "q", "m"]);

        // The user's line over mpv's own, and equal to Kaleido's default: Kaleido's.
        assert_eq!(find("s").command, KALEIDO_S);
        assert_eq!(find("s").source, BindingSource::Kaleido);
        // A script's default over mpv's.
        assert_eq!(find("x").command, "script-binding testbind/test-x");
        assert_eq!(
            find("x").source,
            BindingSource::Plugin {
                name: "testbind".into()
            }
        );
        assert_eq!(find("SPACE").source, BindingSource::Mpv);
        // A line of the user's own, with its description.
        assert_eq!(find("F12").source, BindingSource::User);
        assert_eq!(find("F12").comment.as_deref(), Some("my text"));
        assert_eq!(find("SPACE").comment, None);
        // Silenced: listed as what it is.
        assert_eq!(find("q").command, "ignore");
        assert_eq!(find("q").source, BindingSource::User);
        // A script's binding that is not weak, over the user's: the script's.
        assert_eq!(
            find("m").source,
            BindingSource::Plugin {
                name: "forced".into()
            }
        );
        // A section that is not active is not listed.
        assert!(!keys.contains(&"y"));
    }

    #[test]
    fn a_key_put_back_by_hand_is_still_the_default_it_was() {
        // mpv has no unbind, so after a reset the key is bound to the command of the default.
        let raw = raw(r#"[
            {"key":"SPACE","cmd":"cycle pause","priority":0,"is_weak":true},
            {"key":"SPACE","cmd":"cycle pause","priority":0,"is_weak":false},
            {"key":"x","cmd":"script-binding testbind/test-x","priority":1,"is_weak":true,
             "owner":"testbind"},
            {"key":"x","cmd":"script-binding testbind/test-x","priority":0,"is_weak":false},
            {"key":"p","cmd":"cycle pause","priority":0,"is_weak":true},
            {"key":"p","cmd":"cycle mute","priority":0,"is_weak":false},
            {"key":"Ctrl+F11","cmd":"show-text hi","priority":0,"is_weak":false},
            {"key":"m","cmd":"script-binding forced/m","priority":2,"is_weak":false,
             "owner":"forced"}
        ]"#);
        let listed = derive(&raw, &HashMap::new());
        let find = |key: &str| listed.iter().find(|b| b.key == key).unwrap();
        assert_eq!(find("SPACE").source, BindingSource::Mpv);
        assert_eq!(
            find("x").source,
            BindingSource::Plugin {
                name: "testbind".into()
            }
        );
        assert_eq!(find("p").source, BindingSource::User);
        assert_eq!(find("Ctrl+F11").source, BindingSource::User);
    }

    #[test]
    fn the_live_fallback_of_a_reset_key_has_three_outcomes() {
        let raw = raw(r#"[
            {"key":"SPACE","cmd":"cycle pause","priority":0,"is_weak":true},
            {"key":"SPACE","cmd":"ignore","priority":0,"is_weak":false},
            {"key":"x","cmd":"add sub-delay +0.1","priority":0,"is_weak":true},
            {"key":"x","cmd":"script-binding testbind/test-x","priority":1,"is_weak":true,
             "owner":"testbind"},
            {"key":"x","cmd":"mine","priority":0,"is_weak":false},
            {"key":"Ctrl+F11","cmd":"show-text hi","priority":0,"is_weak":false},
            {"key":"m","cmd":"script-binding forced/m","priority":2,"is_weak":false,
             "owner":"forced"},
            {"key":"y","cmd":"later","priority":-1,"is_weak":true,"owner":"later"},
            {"key":"y","cmd":"mine","priority":0,"is_weak":false}
        ]"#);
        // A default of mpv under the user's binding: its command is bound again.
        assert_eq!(
            fallback_command(&raw, "SPACE").as_deref(),
            Some("cycle pause")
        );
        // The best default counts, a script's too.
        assert_eq!(
            fallback_command(&raw, "x").as_deref(),
            Some("script-binding testbind/test-x")
        );
        // Nothing under the user's binding: the key is to do nothing.
        assert_eq!(
            fallback_command(&raw, "Ctrl+F11").as_deref(),
            Some("ignore")
        );
        // A section that is not active is nothing under it either.
        assert_eq!(fallback_command(&raw, "y").as_deref(), Some("ignore"));
        // No binding of the user's on the key: nothing to bind. A script's own that is not weak
        // is not the user's, and a key nothing is bound to has none at all.
        assert_eq!(fallback_command(&raw, "m"), None);
        assert_eq!(fallback_command(&raw, "F12"), None);
        let only_default = [raw[0].clone()];
        assert_eq!(fallback_command(&only_default, "SPACE"), None);
    }

    #[test]
    fn bindings_serialize_for_the_ui() {
        let listed = [
            Binding {
                comment: Some("note".into()),
                ..binding("s", "shot", BindingSource::Kaleido)
            },
            binding(
                "x",
                "script-binding p/x",
                BindingSource::Plugin { name: "p".into() },
            ),
            binding("SPACE", "cycle pause", BindingSource::Mpv),
            binding("q", "ignore", BindingSource::User),
        ];
        assert_eq!(
            serde_json::to_value(listed).unwrap(),
            serde_json::json!([
                {"key":"s","command":"shot","source":{"type":"kaleido"},"comment":"note"},
                {"key":"x","command":"script-binding p/x",
                 "source":{"type":"plugin","name":"p"},"comment":null},
                {"key":"SPACE","command":"cycle pause","source":{"type":"mpv"},"comment":null},
                {"key":"q","command":"ignore","source":{"type":"user"},"comment":null}
            ])
        );
    }

    // --- the real libmpv --------------------------------------------------------------------

    /// The bindings of `engine` as the settings page gets them, once `done` accepts them; panics
    /// after 5 s. Scripts add theirs a moment after they were loaded.
    fn wait_for_bindings(
        engine: &Engine,
        what: &str,
        done: impl Fn(&[Binding]) -> bool,
    ) -> Vec<Binding> {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let listed = player_bindings(engine);
            if done(&listed) {
                return listed;
            }
            assert!(Instant::now() < deadline, "timed out waiting until {what}");
            thread::sleep(Duration::from_millis(20));
        }
    }

    fn command_of(listed: &[Binding], key: &str) -> Option<String> {
        listed
            .iter()
            .find(|binding| binding.key == key)
            .map(|binding| binding.command.clone())
    }

    fn source_of_key(listed: &[Binding], key: &str) -> Option<BindingSource> {
        listed
            .iter()
            .find(|binding| binding.key == key)
            .map(|binding| binding.source.clone())
    }

    #[test]
    fn bindings_list_marks_sources() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = temp_paths(tmp.path());
        fs::write(
            paths.config_dir.join(INPUT_CONF),
            format!("{DEFAULT_INPUT_CONF}F12 show-text mine\n"),
        )
        .unwrap();
        // A script's own binding; its name is the file's.
        let script = tmp.path().join("testbind.lua");
        fs::write(
            &script,
            "mp.add_key_binding(\"x\", \"test-x\", function() end)\n",
        )
        .unwrap();
        let engine = Engine::start(headless(paths.clone()), NoEvents).unwrap();
        engine.command(&["load-script", &script.to_string_lossy()]);

        let listed = wait_for_bindings(&engine, "the script's binding is listed", |listed| {
            matches!(
                source_of_key(listed, "x"),
                Some(BindingSource::Plugin { .. })
            )
        });
        assert_eq!(
            source_of_key(&listed, "x"),
            Some(BindingSource::Plugin {
                name: "testbind".into()
            })
        );
        // The command is mpv's as it holds it, with the input prefixes a script's binding gets
        // (`nonscalable` in the pinned build): a rebind writes it to input.conf as it is, so the
        // key behaves the same on its new place. The shortcuts page leaves mpv's own `nonscalable`
        // out when it shows the command (src/settings/shortcuts.ts `displayCommand`).
        let x = command_of(&listed, "x").unwrap();
        let raw_x = engine.call(|mpv| {
            let raw = parse_raw(&mpv.get_string("input-bindings").unwrap()).unwrap();
            raw.into_iter()
                .find(|entry| entry.key == "x" && entry.owner.as_deref() == Some("testbind"))
                .map(|entry| entry.cmd)
        });
        assert_eq!(Some(x.as_str()), raw_x.as_deref());
        let words: Vec<&str> = x.split_whitespace().collect();
        assert!(words.len() >= 2, "{x}");
        let (prefixes, rest) = words.split_at(words.len() - 2);
        assert_eq!(rest, ["script-binding", "testbind/test-x"], "{x}");
        assert!(
            prefixes
                .iter()
                .all(|word| MPV_COMMAND_PREFIXES.contains(word)),
            "{x}"
        );
        // Kaleido's line over mpv's own `s`.
        assert_eq!(source_of_key(&listed, "s"), Some(BindingSource::Kaleido));
        assert_eq!(command_of(&listed, "s").as_deref(), Some(KALEIDO_S));
        // Nothing overrides `SPACE`: it is mpv's.
        assert_eq!(source_of_key(&listed, "SPACE"), Some(BindingSource::Mpv));
        // A line of the user's own.
        assert_eq!(source_of_key(&listed, "F12"), Some(BindingSource::User));
        // One entry per key, however many bindings mpv holds for it.
        for key in ["s", "x", "SPACE", "F12"] {
            assert_eq!(listed.iter().filter(|b| b.key == key).count(), 1, "{key}");
        }

        // Moved to another key, the script's binding keeps its prefixes, live and in input.conf.
        rebind(&engine, &paths.config_dir, "x", "Ctrl+F11").unwrap();
        let file =
            InputConf::parse(&fs::read_to_string(paths.config_dir.join(INPUT_CONF)).unwrap());
        assert_eq!(file.get("Ctrl+F11").as_deref(), Some(x.as_str()));
        assert_eq!(
            command_of(&player_bindings(&engine), "Ctrl+F11").as_deref(),
            Some(x.as_str())
        );
    }

    #[test]
    fn keybind_applies_live() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = temp_paths(tmp.path());
        ensure_defaults(&paths).unwrap();
        let input_conf = paths.config_dir.join(INPUT_CONF);
        let file = || InputConf::parse(&fs::read_to_string(&input_conf).unwrap());
        let engine = Engine::start(headless(paths.clone()), NoEvents).unwrap();
        let listed = player_bindings(&engine);
        assert_eq!(command_of(&listed, "s").as_deref(), Some(KALEIDO_S));
        assert_eq!(command_of(&listed, "Ctrl+F11"), None);

        // Moved to another key: the new key is listed with the command at once, the old one is
        // silenced, and input.conf has both lines for the next start.
        rebind(&engine, &paths.config_dir, "s", "Ctrl+F11").unwrap();
        let listed = player_bindings(&engine);
        assert_eq!(command_of(&listed, "Ctrl+F11").as_deref(), Some(KALEIDO_S));
        assert_eq!(command_of(&listed, "s").as_deref(), Some("ignore"));
        assert_eq!(source_of_key(&listed, "s"), Some(BindingSource::User));
        assert_eq!(file().get("Ctrl+F11").as_deref(), Some(KALEIDO_S));
        assert_eq!(file().get("s").as_deref(), Some("ignore"));
        // The rest of the file is as it was.
        let text = fs::read_to_string(&input_conf).unwrap();
        assert!(text.starts_with(DEFAULT_INPUT_CONF.lines().next().unwrap()));
        assert_eq!(file().get("S"), kaleido_default("S"));

        // Rebinding a key nothing is bound to is refused; the file stays as it is.
        assert_eq!(
            rebind(&engine, &paths.config_dir, "Ctrl+F10", "q"),
            Err(SettingsError::NotAllowed {
                key: "Ctrl+F10".into()
            })
        );
        assert!(rebind(&engine, &paths.config_dir, "s", "a b").is_err());
        assert_eq!(fs::read_to_string(&input_conf).unwrap(), text);

        // Reset: Kaleido's line is back for `s`, live and in the file.
        reset_binding(&engine, &paths.config_dir, "s").unwrap();
        let listed = player_bindings(&engine);
        assert_eq!(command_of(&listed, "s").as_deref(), Some(KALEIDO_S));
        assert_eq!(source_of_key(&listed, "s"), Some(BindingSource::Kaleido));
        assert_eq!(file().get("s").as_deref(), Some(KALEIDO_S));
        // The key that got the command has no default, and neither has mpv a binding for it:
        // its line goes, and the player, which cannot unbind, has the key do nothing.
        reset_binding(&engine, &paths.config_dir, "Ctrl+F11").unwrap();
        assert_eq!(file().get("Ctrl+F11"), None);
        let listed = player_bindings(&engine);
        assert_eq!(command_of(&listed, "Ctrl+F11").as_deref(), Some("ignore"));
        assert_eq!(
            source_of_key(&listed, "Ctrl+F11"),
            Some(BindingSource::User)
        );
        assert!(reset_binding(&engine, &paths.config_dir, "").is_err());
    }

    /// A name that passes `valid_key` but is no key: mpv's `keybind` refuses it, and then the
    /// player keeps the old key and input.conf is not touched.
    #[test]
    fn rebinding_to_a_name_mpv_refuses_changes_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = temp_paths(tmp.path());
        ensure_defaults(&paths).unwrap();
        let input_conf = paths.config_dir.join(INPUT_CONF);
        let before = fs::read(&input_conf).unwrap();
        let engine = Engine::start(headless(paths.clone()), NoEvents).unwrap();

        let result = rebind(&engine, &paths.config_dir, "s", "NoSuchKey");
        assert!(
            matches!(&result, Err(SettingsError::Invalid { key, .. }) if key == "newKey"),
            "{result:?}"
        );
        assert_eq!(fs::read(&input_conf).unwrap(), before);
        let listed = player_bindings(&engine);
        assert_eq!(command_of(&listed, "s").as_deref(), Some(KALEIDO_S));
        assert_eq!(source_of_key(&listed, "s"), Some(BindingSource::Kaleido));
        assert_eq!(command_of(&listed, "NoSuchKey"), None);
    }

    #[test]
    fn reset_hands_a_key_back_to_the_binding_mpv_has_for_it() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = temp_paths(tmp.path());
        ensure_defaults(&paths).unwrap();
        let input_conf = paths.config_dir.join(INPUT_CONF);
        let engine = Engine::start(headless(paths.clone()), NoEvents).unwrap();
        let space = command_of(&player_bindings(&engine), "SPACE").expect("mpv binds SPACE");

        rebind(&engine, &paths.config_dir, "SPACE", "Ctrl+F11").unwrap();
        let listed = player_bindings(&engine);
        assert_eq!(command_of(&listed, "SPACE").as_deref(), Some("ignore"));
        assert_eq!(command_of(&listed, "Ctrl+F11"), Some(space.clone()));
        assert!(
            InputConf::parse(&fs::read_to_string(&input_conf).unwrap())
                .get("SPACE")
                .is_some()
        );

        // No line of input.conf is left for SPACE, and the player has mpv's binding again.
        reset_binding(&engine, &paths.config_dir, "SPACE").unwrap();
        assert_eq!(
            InputConf::parse(&fs::read_to_string(&input_conf).unwrap()).get("SPACE"),
            None
        );
        let listed = player_bindings(&engine);
        assert_eq!(command_of(&listed, "SPACE"), Some(space));
        assert_eq!(source_of_key(&listed, "SPACE"), Some(BindingSource::Mpv));

        // A key that already has mpv's own binding active is left alone by a reset.
        reset_binding(&engine, &paths.config_dir, "p").unwrap();
        let listed = player_bindings(&engine);
        assert_eq!(source_of_key(&listed, "p"), Some(BindingSource::Mpv));
    }
}
