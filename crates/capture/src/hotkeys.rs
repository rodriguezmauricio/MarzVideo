//! The recorder's global hotkeys as combos he can rebind (Settings). Portable: no Windows calls.
//! `win::input::Hotkey` asks [`combo_for`] for the keys to register, so a rebinding set here is
//! used the next time the hotkeys are registered (recorder opened, recording started).
//! The same rules live in `apps/desktop/src/settings/hotkeyMap.ts` for instant feedback.

use std::collections::BTreeMap;
use std::fmt;
use std::sync::RwLock;

/// Every rebindable action: id (as stored in `settings.json`), default combo, name shown to people.
pub const ACTIONS: [(&str, &str, &str); 19] = [
    ("recordStop", "Ctrl+Shift+R", "Record and stop"),
    ("pause", "Ctrl+Shift+P", "Pause and resume"),
    ("mute", "Ctrl+Shift+M", "Mute mic"),
    ("preset1", "Ctrl+1", "Zoom preset 1"),
    ("preset2", "Ctrl+2", "Zoom preset 2"),
    ("preset3", "Ctrl+3", "Zoom preset 3"),
    ("preset4", "Ctrl+4", "Zoom preset 4"),
    ("preset5", "Ctrl+5", "Zoom preset 5"),
    ("preset6", "Ctrl+6", "Zoom preset 6"),
    ("preset7", "Ctrl+7", "Zoom preset 7"),
    ("preset8", "Ctrl+8", "Zoom preset 8"),
    ("preset9", "Ctrl+9", "Zoom preset 9"),
    ("zoomOut", "Ctrl+0", "Zoom out"),
    ("layout1", "Ctrl+Shift+1", "Layout: corner"),
    ("layout2", "Ctrl+Shift+2", "Layout: side"),
    ("layout3", "Ctrl+Shift+3", "Layout: camera"),
    ("layout4", "Ctrl+Shift+4", "Layout: screen"),
    ("draw", "Ctrl+Shift+D", "Draw on screen"),
    ("check", "Ctrl+Shift+K", "Tick next topic"),
];

/// Combos that belong to the editor or to Windows, with the reason shown when one is picked.
pub const RESERVED: [(&str, &str); 9] = [
    ("Ctrl+Z", "Ctrl+Z is the editor's undo."),
    ("Ctrl+Shift+Z", "Ctrl+Shift+Z is the editor's redo."),
    ("Ctrl+Y", "Ctrl+Y is the editor's redo."),
    ("Ctrl+E", "Ctrl+E opens the export panel."),
    ("Ctrl+C", "Ctrl+C is copy."),
    ("Ctrl+V", "Ctrl+V is paste."),
    ("Ctrl+X", "Ctrl+X is cut."),
    ("Ctrl+A", "Ctrl+A is select all."),
    ("Alt+F4", "Alt+F4 closes windows."),
];

/// A key combination: modifiers plus one key (A to Z, 0 to 9, F1 to F12).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Combo {
    pub ctrl: bool,
    pub alt: bool,
    pub shift: bool,
    /// "A".."Z", "0".."9", "F1".."F12".
    pub key: String,
}

impl Combo {
    /// Parse "Ctrl+Shift+R" (any order of modifiers, any case). None when it is not a combo.
    pub fn parse(text: &str) -> Option<Combo> {
        let mut c = Combo { ctrl: false, alt: false, shift: false, key: String::new() };
        let parts: Vec<&str> = text.split('+').map(str::trim).collect();
        let (key, mods) = parts.split_last()?;
        for m in mods {
            match m.to_ascii_lowercase().as_str() {
                "ctrl" | "control" if !c.ctrl => c.ctrl = true,
                "alt" if !c.alt => c.alt = true,
                "shift" if !c.shift => c.shift = true,
                _ => return None,
            }
        }
        let key = key.to_ascii_uppercase();
        let ok = match key.len() {
            1 => key.chars().all(|ch| ch.is_ascii_alphanumeric()),
            _ => key.strip_prefix('F').and_then(|n| n.parse::<u8>().ok()).is_some_and(|n| (1..=12).contains(&n) && !key.starts_with("F0")),
        };
        if !ok {
            return None;
        }
        c.key = key;
        Some(c)
    }

    /// The Windows virtual-key code of the key.
    pub fn vk(&self) -> u32 {
        match self.key.strip_prefix('F').and_then(|n| n.parse::<u32>().ok()) {
            Some(n) if self.key.len() > 1 => 0x70 + n - 1, // VK_F1
            _ => u32::from(self.key.as_bytes()[0]),        // 'A'..'Z', '0'..'9'
        }
    }
}

impl fmt::Display for Combo {
    /// "Ctrl+Alt+Shift+K": the order used everywhere in the app.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        for (on, name) in [(self.ctrl, "Ctrl+"), (self.alt, "Alt+"), (self.shift, "Shift+")] {
            if on {
                f.write_str(name)?;
            }
        }
        f.write_str(&self.key)
    }
}

fn name_of(id: &str) -> &'static str {
    ACTIONS.iter().find(|a| a.0 == id).map_or("another hotkey", |a| a.2)
}

/// The default combo of an action id.
pub fn default_combo(id: &str) -> Option<Combo> {
    ACTIONS.iter().find(|a| a.0 == id).and_then(|a| Combo::parse(a.1))
}

/// Every action with its combo: the defaults with `overrides` on top. Unknown ids are left out;
/// an override that does not parse is reported as a problem.
pub fn resolve(overrides: &BTreeMap<String, String>) -> Result<BTreeMap<String, Combo>, Vec<(String, String)>> {
    let mut out = BTreeMap::new();
    let mut problems = Vec::new();
    for (id, default, _) in ACTIONS {
        match overrides.get(id) {
            Some(text) => match Combo::parse(text) {
                Some(c) => {
                    out.insert(id.to_string(), c);
                }
                None => problems.push((id.to_string(), format!("{text} is not a key combination."))),
            },
            None => {
                out.insert(id.to_string(), Combo::parse(default).expect("default combos parse"));
            }
        }
    }
    if problems.is_empty() { Ok(out) } else { Err(problems) }
}

/// Problems with a full set of bindings, as (action id, sentence). Empty when all are fine.
pub fn check(all: &BTreeMap<String, Combo>) -> Vec<(String, String)> {
    let mut problems = Vec::new();
    for (id, c) in all {
        let label = c.to_string();
        if !c.ctrl && !c.alt {
            problems.push((id.clone(), "Needs Ctrl or Alt.".to_string()));
        } else if let Some((_, why)) = RESERVED.iter().find(|r| r.0 == label) {
            problems.push((id.clone(), (*why).to_string()));
        } else if let Some((other, _)) = all.iter().find(|(o, oc)| *o != id && **oc == *c) {
            problems.push((id.clone(), format!("Already used by {}.", name_of(other))));
        }
    }
    problems
}

static BINDINGS: RwLock<Option<BTreeMap<String, Combo>>> = RwLock::new(None);

/// Use these rebindings (action id to combo text) from now on. Refused, with the problems, when a
/// combo does not parse, lacks Ctrl or Alt, is reserved, or is used twice; the old ones stay.
pub fn set_overrides(overrides: &BTreeMap<String, String>) -> Result<(), Vec<(String, String)>> {
    let all = resolve(overrides)?;
    let problems = check(&all);
    if !problems.is_empty() {
        return Err(problems);
    }
    *BINDINGS.write().unwrap_or_else(std::sync::PoisonError::into_inner) = Some(all);
    Ok(())
}

/// The combo in force for an action id (its default until `set_overrides` ran).
pub fn combo_for(id: &str) -> Combo {
    let g = BINDINGS.read().unwrap_or_else(std::sync::PoisonError::into_inner);
    g.as_ref().and_then(|m| m.get(id).cloned()).or_else(|| default_combo(id)).expect("known action id")
}

/// Every action id with the label of its combo in force.
pub fn labels() -> BTreeMap<String, String> {
    ACTIONS.iter().map(|a| (a.0.to_string(), combo_for(a.0).to_string())).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn map(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs.iter().map(|(a, b)| (a.to_string(), b.to_string())).collect()
    }

    #[test]
    fn parses_and_prints_in_one_order() {
        let c = Combo::parse("shift+ctrl+r").unwrap();
        assert_eq!(c.to_string(), "Ctrl+Shift+R");
        assert_eq!(Combo::parse("Alt+Shift+Ctrl+k").unwrap().to_string(), "Ctrl+Alt+Shift+K");
        assert_eq!(Combo::parse("Ctrl+F12").unwrap().to_string(), "Ctrl+F12");
        for bad in ["", "Ctrl+", "Ctrl+Ctrl+R", "Win+R", "Ctrl+F13", "Ctrl+F0", "Ctrl+Space", "Ctrl+RR", "Ctrl+-"] {
            assert!(Combo::parse(bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn virtual_keys() {
        assert_eq!(Combo::parse("Ctrl+R").unwrap().vk(), u32::from(b'R'));
        assert_eq!(Combo::parse("Ctrl+0").unwrap().vk(), u32::from(b'0'));
        assert_eq!(Combo::parse("Alt+F1").unwrap().vk(), 0x70);
        assert_eq!(Combo::parse("Alt+F12").unwrap().vk(), 0x7B);
    }

    #[test]
    fn defaults_are_valid_and_distinct() {
        let all = resolve(&BTreeMap::new()).unwrap();
        assert_eq!(all.len(), 19);
        assert!(check(&all).is_empty());
    }

    #[test]
    fn refuses_clashes_reserved_and_bare_keys() {
        let all = resolve(&map(&[("pause", "Ctrl+Shift+R")])).unwrap();
        let p = check(&all);
        assert!(p.contains(&("pause".into(), "Already used by Record and stop.".into())), "{p:?}");
        assert!(p.contains(&("recordStop".into(), "Already used by Pause and resume.".into())));
        let all = resolve(&map(&[("draw", "Ctrl+Z")])).unwrap();
        assert_eq!(check(&all), vec![("draw".to_string(), "Ctrl+Z is the editor's undo.".to_string())]);
        let all = resolve(&map(&[("draw", "Shift+D")])).unwrap();
        assert_eq!(check(&all), vec![("draw".to_string(), "Needs Ctrl or Alt.".to_string())]);
        assert!(resolve(&map(&[("draw", "Hello")])).is_err());
    }

    #[test]
    fn overrides_take_effect_and_bad_ones_keep_the_old() {
        // One test owns the global table so tests running in parallel do not race.
        assert_eq!(combo_for("recordStop").to_string(), "Ctrl+Shift+R");
        set_overrides(&map(&[("recordStop", "Ctrl+Alt+F9")])).unwrap();
        assert_eq!(combo_for("recordStop").to_string(), "Ctrl+Alt+F9");
        assert_eq!(labels()["recordStop"], "Ctrl+Alt+F9");
        assert!(set_overrides(&map(&[("recordStop", "Ctrl+C")])).is_err());
        assert_eq!(combo_for("recordStop").to_string(), "Ctrl+Alt+F9");
        set_overrides(&BTreeMap::new()).unwrap();
        assert_eq!(combo_for("recordStop").to_string(), "Ctrl+Shift+R");
    }
}
