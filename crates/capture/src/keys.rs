//! Key names and the privacy rules for `key` lines in `events.jsonl` (keypress overlay design,
//! section "Privacy"). Portable and pure: the Windows hook in `win::input` passes virtual-key codes
//! and the held modifiers, this module decides what may be written.
//!
//! Written: a key pressed while Ctrl, Alt or Win is held; a named key (Enter, Esc, Tab, Delete,
//! Insert, Home, End, PageUp, PageDown, arrows, F1..F24, PrintScreen) with Shift or alone.
//! Never written: letters, digits, symbols, Space, Backspace and numpad digits or operators without
//! Ctrl, Alt or Win (typed text); anything while AltGr is held without Win; the recorder hotkeys.
//! The password field check lives in the hook (it needs Windows).

/// The modifiers held when a key went down. `alt` is either Alt key, `altgr` is Right Alt
/// (Windows sends AltGr as Ctrl+Alt, so `ctrl` is usually set with it).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Mods {
    pub ctrl: bool,
    pub alt: bool,
    pub shift: bool,
    pub win: bool,
    pub altgr: bool,
}

/// Virtual-key codes used here (Windows values, kept as numbers so this module stays portable).
mod vk {
    pub const BACK: u32 = 0x08;
    pub const TAB: u32 = 0x09;
    pub const RETURN: u32 = 0x0D;
    pub const ESCAPE: u32 = 0x1B;
    pub const SPACE: u32 = 0x20;
    pub const PRIOR: u32 = 0x21;
    pub const NEXT: u32 = 0x22;
    pub const END: u32 = 0x23;
    pub const HOME: u32 = 0x24;
    pub const LEFT: u32 = 0x25;
    pub const UP: u32 = 0x26;
    pub const RIGHT: u32 = 0x27;
    pub const DOWN: u32 = 0x28;
    pub const SNAPSHOT: u32 = 0x2C;
    pub const INSERT: u32 = 0x2D;
    pub const DELETE: u32 = 0x2E;
    pub const NUMPAD0: u32 = 0x60;
    pub const NUMPAD9: u32 = 0x69;
    pub const MULTIPLY: u32 = 0x6A;
    pub const ADD: u32 = 0x6B;
    pub const SUBTRACT: u32 = 0x6D;
    pub const DECIMAL: u32 = 0x6E;
    pub const DIVIDE: u32 = 0x6F;
    pub const F1: u32 = 0x70;
    pub const F24: u32 = 0x87;
}

/// Keys written even with no modifier or with Shift only.
fn is_named(vk: u32) -> bool {
    matches!(
        vk,
        vk::TAB
            | vk::RETURN
            | vk::ESCAPE
            | vk::PRIOR
            | vk::NEXT
            | vk::END
            | vk::HOME
            | vk::LEFT
            | vk::UP
            | vk::RIGHT
            | vk::DOWN
            | vk::SNAPSHOT
            | vk::INSERT
            | vk::DELETE
    ) || (vk::F1..=vk::F24).contains(&vk)
}

/// OEM symbol keys (`;`, `=`, `,`, `-`, `.`, `/`, backtick, `[`, `\`, `]`, quote, the ISO extra key).
fn is_oem_symbol(vk: u32) -> bool {
    (0xBA..=0xC0).contains(&vk) || (0xDB..=0xDF).contains(&vk) || vk == 0xE2
}

/// The name of a key, or None for modifiers and keys with no name (media keys, unknown keys).
/// `symbol` is what an OEM symbol key types without Shift on the current layout (the caller reads
/// it with `MapVirtualKeyW(vk, MAPVK_VK_TO_CHAR)`); it is ignored for every other key.
pub fn key_name(vk: u32, symbol: Option<char>) -> Option<String> {
    let fixed = match vk {
        vk::BACK => "Backspace",
        vk::TAB => "Tab",
        vk::RETURN => "Enter",
        vk::ESCAPE => "Esc",
        vk::SPACE => "Space",
        vk::PRIOR => "PageUp",
        vk::NEXT => "PageDown",
        vk::END => "End",
        vk::HOME => "Home",
        vk::LEFT => "Left",
        vk::UP => "Up",
        vk::RIGHT => "Right",
        vk::DOWN => "Down",
        vk::SNAPSHOT => "PrintScreen",
        vk::INSERT => "Insert",
        vk::DELETE => "Delete",
        vk::MULTIPLY => "Num*",
        vk::ADD => "Num+",
        vk::SUBTRACT => "Num-",
        vk::DECIMAL => "Num.",
        vk::DIVIDE => "Num/",
        _ => "",
    };
    if !fixed.is_empty() {
        return Some(fixed.to_string());
    }
    match vk {
        0x30..=0x39 | 0x41..=0x5A => char::from_u32(vk).map(String::from),
        vk::NUMPAD0..=vk::NUMPAD9 => Some(format!("Num{}", vk - vk::NUMPAD0)),
        vk::F1..=vk::F24 => Some(format!("F{}", vk - vk::F1 + 1)),
        _ if is_oem_symbol(vk) => {
            let c = symbol?;
            if c.is_control() || c.is_whitespace() {
                return None;
            }
            Some(c.to_lowercase().collect())
        }
        _ => None,
    }
}

/// The `keys` of a `key` line for a press, or None when the privacy rules say it is not written.
/// Order: Ctrl, Alt, Shift, Win, then the key.
pub fn combo_to_log(mods: Mods, vk: u32, symbol: Option<char>) -> Option<Vec<String>> {
    if mods.altgr && !mods.win {
        return None; // AltGr types characters (@, euro sign, braces) on many layouts
    }
    let name = key_name(vk, symbol)?;
    let shortcut = mods.ctrl || mods.alt || mods.win;
    if !shortcut && !is_named(vk) {
        return None; // typing: letters, digits, symbols, Space, Backspace, numpad, with or without Shift
    }
    let mut keys = Vec::with_capacity(5);
    for (on, m) in [(mods.ctrl, "Ctrl"), (mods.alt, "Alt"), (mods.shift, "Shift"), (mods.win, "Win")] {
        if on {
            keys.push(m.to_string());
        }
    }
    keys.push(name);
    Some(keys)
}

/// True when the press is one of the recorder hotkeys in the combos in force (`crate::hotkeys`,
/// every action in `hotkeys::ACTIONS`, so rebinds and new hotkeys are covered).
pub fn is_recorder_hotkey(mods: Mods, vk: u32) -> bool {
    if mods.win {
        return false; // recorder hotkeys never use Win
    }
    crate::hotkeys::ACTIONS.iter().any(|(id, _, _)| {
        let c = crate::hotkeys::combo_for(id);
        c.ctrl == mods.ctrl && c.alt == mods.alt && c.shift == mods.shift && c.vk() == vk
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const NONE: Mods = Mods { ctrl: false, alt: false, shift: false, win: false, altgr: false };
    const CTRL: Mods = Mods { ctrl: true, ..NONE };
    const SHIFT: Mods = Mods { shift: true, ..NONE };
    const ALT: Mods = Mods { alt: true, ..NONE };
    const WIN: Mods = Mods { win: true, ..NONE };
    const CTRL_SHIFT: Mods = Mods { ctrl: true, shift: true, ..NONE };
    const ALTGR: Mods = Mods { ctrl: true, alt: true, altgr: true, ..NONE };

    fn log(mods: Mods, vk: u32) -> Option<Vec<String>> {
        combo_to_log(mods, vk, None)
    }

    fn keys(v: &[&str]) -> Option<Vec<String>> {
        Some(v.iter().map(|s| s.to_string()).collect())
    }

    #[test]
    fn names() {
        assert_eq!(key_name(u32::from(b'A'), None).as_deref(), Some("A"));
        assert_eq!(key_name(u32::from(b'Z'), None).as_deref(), Some("Z"));
        assert_eq!(key_name(u32::from(b'0'), None).as_deref(), Some("0"));
        assert_eq!(key_name(0x70, None).as_deref(), Some("F1"));
        assert_eq!(key_name(0x87, None).as_deref(), Some("F24"));
        assert_eq!(key_name(0x60, None).as_deref(), Some("Num0"));
        assert_eq!(key_name(0x69, None).as_deref(), Some("Num9"));
        for (vk, n) in [
            (0x08, "Backspace"),
            (0x09, "Tab"),
            (0x0D, "Enter"),
            (0x1B, "Esc"),
            (0x20, "Space"),
            (0x21, "PageUp"),
            (0x22, "PageDown"),
            (0x23, "End"),
            (0x24, "Home"),
            (0x25, "Left"),
            (0x26, "Up"),
            (0x27, "Right"),
            (0x28, "Down"),
            (0x2C, "PrintScreen"),
            (0x2D, "Insert"),
            (0x2E, "Delete"),
            (0x6A, "Num*"),
            (0x6B, "Num+"),
            (0x6D, "Num-"),
            (0x6E, "Num."),
            (0x6F, "Num/"),
        ] {
            assert_eq!(key_name(vk, None).as_deref(), Some(n), "{vk:#x}");
        }
        assert_eq!(key_name(0xBF, Some('/')).as_deref(), Some("/"));
        assert_eq!(key_name(0xBA, Some(';')).as_deref(), Some(";"));
        assert_eq!(key_name(0xDB, Some('[')).as_deref(), Some("["));
        assert_eq!(key_name(0xBD, Some('-')).as_deref(), Some("-"));
        assert_eq!(key_name(0xBA, Some('Ç')).as_deref(), Some("ç"), "the unshifted character");
        assert_eq!(key_name(0xBF, None), None, "a symbol key with no character has no name");
        // Modifiers, locks, media and unknown keys have no name.
        for vk in [0x10, 0x11, 0x12, 0x5B, 0x5C, 0xA0, 0xA1, 0xA2, 0xA3, 0xA4, 0xA5, 0x14, 0x90, 0xAD, 0xB3, 0xFF, 0x0C] {
            assert_eq!(key_name(vk, Some('x')), None, "{vk:#x}");
        }
    }

    #[test]
    fn typing_is_never_written() {
        let a = u32::from(b'A');
        assert_eq!(log(NONE, a), None, "plain a");
        assert_eq!(log(SHIFT, a), None, "Shift+a");
        assert_eq!(log(SHIFT, u32::from(b'1')), None, "Shift+1");
        assert_eq!(log(NONE, u32::from(b'1')), None);
        assert_eq!(log(NONE, 0x20), None, "Space");
        assert_eq!(log(SHIFT, 0x20), None, "Shift+Space");
        assert_eq!(log(NONE, 0x08), None, "Backspace");
        assert_eq!(log(SHIFT, 0x08), None, "Shift+Backspace");
        assert_eq!(combo_to_log(NONE, 0xBF, Some('/')), None, "symbol");
        assert_eq!(combo_to_log(SHIFT, 0xBF, Some('/')), None, "Shift+symbol");
        for vk in 0x60..=0x6F {
            assert_eq!(log(NONE, vk), None, "numpad {vk:#x}");
            assert_eq!(log(SHIFT, vk), None, "Shift+numpad {vk:#x}");
        }
    }

    #[test]
    fn named_keys_alone_and_with_shift() {
        assert_eq!(log(NONE, 0x0D), keys(&["Enter"]));
        assert_eq!(log(NONE, 0x1B), keys(&["Esc"]));
        assert_eq!(log(NONE, 0x09), keys(&["Tab"]));
        assert_eq!(log(SHIFT, 0x09), keys(&["Shift", "Tab"]));
        assert_eq!(log(SHIFT, 0x0D), keys(&["Shift", "Enter"]));
        assert_eq!(log(SHIFT, 0x74), keys(&["Shift", "F5"]));
        assert_eq!(log(SHIFT, 0x25), keys(&["Shift", "Left"]));
        for vk in [0x2E, 0x2D, 0x24, 0x23, 0x21, 0x22, 0x25, 0x26, 0x27, 0x28, 0x2C, 0x70, 0x7B, 0x87] {
            assert!(log(NONE, vk).is_some(), "{vk:#x}");
        }
    }

    #[test]
    fn shortcuts_with_ctrl_alt_or_win() {
        assert_eq!(log(CTRL, u32::from(b'S')), keys(&["Ctrl", "S"]));
        assert_eq!(log(CTRL, 0x08), keys(&["Ctrl", "Backspace"]));
        assert_eq!(log(CTRL, 0x20), keys(&["Ctrl", "Space"]));
        assert_eq!(log(CTRL_SHIFT, u32::from(b'S')), keys(&["Ctrl", "Shift", "S"]));
        assert_eq!(log(ALT, 0x09), keys(&["Alt", "Tab"]));
        assert_eq!(log(Mods { win: true, shift: true, ..NONE }, u32::from(b'S')), keys(&["Shift", "Win", "S"]));
        assert_eq!(log(WIN, u32::from(b'E')), keys(&["Win", "E"]));
        assert_eq!(log(Mods { ctrl: true, alt: true, ..NONE }, 0x2E), keys(&["Ctrl", "Alt", "Delete"]));
        assert_eq!(log(Mods { ctrl: true, alt: true, shift: true, win: true, altgr: false }, u32::from(b'K')), keys(&["Ctrl", "Alt", "Shift", "Win", "K"]));
        assert_eq!(combo_to_log(CTRL, 0xBF, Some('/')), keys(&["Ctrl", "/"]));
        assert_eq!(log(CTRL, 0x6B), keys(&["Ctrl", "Num+"]));
        assert_eq!(log(CTRL, 0x11), None, "a modifier on its own is not a key");
        assert_eq!(log(CTRL, 0xAD), None, "media keys have no name");
    }

    #[test]
    fn altgr_is_never_written_without_win() {
        assert_eq!(log(ALTGR, u32::from(b'Q')), None, "AltGr+Q types @ on German layouts");
        assert_eq!(log(ALTGR, 0x0D), None);
        assert_eq!(log(Mods { altgr: true, alt: true, ..NONE }, u32::from(b'E')), None);
        assert_eq!(log(Mods { win: true, ..ALTGR }, u32::from(b'Q')), keys(&["Ctrl", "Alt", "Win", "Q"]));
    }

    #[test]
    fn recorder_hotkeys_are_recognized() {
        // recordStop is left out: the hotkeys tests rebind it while running in parallel.
        assert!(is_recorder_hotkey(CTRL_SHIFT, u32::from(b'P')));
        assert!(is_recorder_hotkey(CTRL, u32::from(b'1')));
        assert!(is_recorder_hotkey(CTRL, u32::from(b'0')));
        assert!(is_recorder_hotkey(CTRL_SHIFT, u32::from(b'5')));
        assert!(is_recorder_hotkey(CTRL_SHIFT, u32::from(b'K')));
        assert!(!is_recorder_hotkey(CTRL, u32::from(b'S')));
        assert!(!is_recorder_hotkey(CTRL_SHIFT, u32::from(b'S')));
        assert!(!is_recorder_hotkey(Mods { win: true, ..CTRL_SHIFT }, u32::from(b'P')));
        assert!(!is_recorder_hotkey(Mods { alt: true, ..CTRL_SHIFT }, u32::from(b'P')));
        assert!(!is_recorder_hotkey(SHIFT, u32::from(b'P')));
    }
}
