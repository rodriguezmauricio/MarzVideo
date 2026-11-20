//! The Anthropic API key, kept only in Windows Credential Manager (design
//! `docs/superpowers/specs/2026-11-19-ai-provider-design.md`). Never in `settings.json`, never sent
//! back to the webview, never logged: the key lives in `Secret`, whose `Debug` prints `***`.

use std::fmt;

/// The credential's name in Credential Manager.
pub const TARGET: &str = "Marz Recorder/anthropic-api-key";

/// A key in memory. No `Display`, and `Debug` hides it, so a `{:?}` in a log cannot leak it.
#[derive(Clone, PartialEq, Eq)]
pub struct Secret(String);

impl Secret {
    /// Trimmed; None when empty.
    pub fn new(raw: &str) -> Option<Secret> {
        let t = raw.trim();
        (!t.is_empty()).then(|| Secret(t.to_string()))
    }
    pub fn expose(&self) -> &str {
        &self.0
    }
    /// The last 4 characters, the only part Settings shows.
    pub fn last4(&self) -> String {
        let n = self.0.chars().count();
        self.0.chars().skip(n.saturating_sub(4)).collect()
    }
}

impl fmt::Debug for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Secret(***)")
    }
}

#[cfg(windows)]
mod imp {
    use super::Secret;
    use windows::Win32::Security::Credentials::{CredDeleteW, CredFree, CredReadW, CredWriteW, CREDENTIALW, CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC};
    use windows::core::{HSTRING, PWSTR};

    pub fn save(target: &str, key: &Secret) -> Result<(), String> {
        let name = HSTRING::from(target);
        let user = HSTRING::from("api-key");
        let mut blob = key.expose().as_bytes().to_vec();
        let cred = CREDENTIALW {
            Type: CRED_TYPE_GENERIC,
            TargetName: PWSTR(name.as_ptr() as *mut u16),
            CredentialBlobSize: blob.len() as u32,
            CredentialBlob: blob.as_mut_ptr(),
            Persist: CRED_PERSIST_LOCAL_MACHINE,
            UserName: PWSTR(user.as_ptr() as *mut u16),
            ..Default::default()
        };
        // SAFETY: every pointer in `cred` points into `name`, `user` and `blob`, alive for the call.
        let r = unsafe { CredWriteW(&cred, 0) };
        blob.fill(0);
        r.map_err(|e| format!("Windows Credential Manager refused the key ({}).", e.code()))
    }

    pub fn load(target: &str) -> Option<Secret> {
        let name = HSTRING::from(target);
        let mut out: *mut CREDENTIALW = std::ptr::null_mut();
        // SAFETY: `out` receives a buffer owned by Windows, freed with CredFree below.
        unsafe {
            CredReadW(&name, CRED_TYPE_GENERIC, None, &mut out).ok()?;
            let c = &*out;
            let bytes = std::slice::from_raw_parts(c.CredentialBlob, c.CredentialBlobSize as usize).to_vec();
            CredFree(out as *const _);
            String::from_utf8(bytes).ok().and_then(|s| Secret::new(&s))
        }
    }

    pub fn delete(target: &str) -> Result<(), String> {
        let name = HSTRING::from(target);
        // SAFETY: plain call with a valid string.
        match unsafe { CredDeleteW(&name, CRED_TYPE_GENERIC, None) } {
            Ok(()) => Ok(()),
            // Not found: already gone.
            Err(e) if e.code().0 as u32 == 0x8007_0490 => Ok(()),
            Err(e) => Err(format!("Windows Credential Manager could not remove the key ({}).", e.code())),
        }
    }
}

#[cfg(not(windows))]
mod imp {
    use super::Secret;
    pub fn save(_target: &str, _key: &Secret) -> Result<(), String> {
        Err("Saving the key needs Windows Credential Manager.".into())
    }
    pub fn load(_target: &str) -> Option<Secret> {
        None
    }
    pub fn delete(_target: &str) -> Result<(), String> {
        Ok(())
    }
}

pub fn save_in(target: &str, key: &Secret) -> Result<(), String> {
    imp::save(target, key)
}
pub fn load_from(target: &str) -> Option<Secret> {
    imp::load(target)
}
pub fn delete_in(target: &str) -> Result<(), String> {
    imp::delete(target)
}

pub fn save(key: &Secret) -> Result<(), String> {
    save_in(TARGET, key)
}
pub fn load() -> Option<Secret> {
    load_from(TARGET)
}
pub fn delete() -> Result<(), String> {
    delete_in(TARGET)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn debug_never_shows_the_key() {
        let k = Secret::new("  sk-ant-api03-SECRETVALUE-wxyz \n").unwrap();
        assert_eq!(format!("{k:?}"), "Secret(***)");
        assert!(!format!("{:?}", Some(&k)).contains("SECRET"));
        assert_eq!(k.expose(), "sk-ant-api03-SECRETVALUE-wxyz");
        assert_eq!(k.last4(), "wxyz");
        assert_eq!(Secret::new("   "), None);
        assert_eq!(Secret::new("ab").unwrap().last4(), "ab");
    }

    #[cfg(windows)]
    #[test]
    fn credential_manager_round_trip() {
        let target = format!("Marz Recorder test/{}", std::process::id());
        let k = Secret::new("sk-ant-test-not-a-real-key-1234").unwrap();
        save_in(&target, &k).unwrap();
        assert_eq!(load_from(&target), Some(k));
        let k2 = Secret::new("sk-ant-test-replaced-5678").unwrap();
        save_in(&target, &k2).unwrap();
        assert_eq!(load_from(&target).unwrap().last4(), "5678");
        delete_in(&target).unwrap();
        assert_eq!(load_from(&target), None);
        delete_in(&target).unwrap();
    }
}
