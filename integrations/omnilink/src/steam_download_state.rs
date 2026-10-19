use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::SystemTime;

use windows_sys::Win32::System::Registry::{
    RegCloseKey, RegOpenKeyExW, RegQueryValueExW, HKEY_CURRENT_USER, KEY_READ, REG_SZ,
};

const MAX_LOG_TAIL_BYTES: u64 = 1024 * 1024;

#[derive(Default)]
struct LogCache {
    stamp: Option<(u64, Option<SystemTime>)>,
    active: bool,
}

static STEAM_ROOT: OnceLock<Option<PathBuf>> = OnceLock::new();
static LOG_CACHE: OnceLock<Mutex<LogCache>> = OnceLock::new();

/// Reads Steam's own content state instead of inferring a game download from any Steam traffic.
/// Workshop checks, browser traffic, and small background requests do not set the App download
/// state to `Downloading` in `logs/content_log.txt`.
pub fn is_game_download_active() -> bool {
    let Some(root) = STEAM_ROOT.get_or_init(find_steam_root).as_ref() else {
        return false;
    };
    let path = root.join("logs").join("content_log.txt");
    let Ok(metadata) = fs::metadata(&path) else {
        return false;
    };
    let stamp = (metadata.len(), metadata.modified().ok());
    let cache = LOG_CACHE.get_or_init(|| Mutex::new(LogCache::default()));
    let Ok(mut cache) = cache.lock() else {
        return false;
    };
    if cache.stamp.as_ref() == Some(&stamp) {
        return cache.active;
    }

    cache.active = read_log_tail(&path)
        .map(|text| has_active_game_download(&text))
        .unwrap_or(false);
    cache.stamp = Some(stamp);
    cache.active
}

fn find_steam_root() -> Option<PathBuf> {
    let subkey: Vec<u16> = "Software\\Valve\\Steam\0".encode_utf16().collect();
    let value_name: Vec<u16> = "SteamPath\0".encode_utf16().collect();
    let mut key = std::ptr::null_mut();

    let opened =
        unsafe { RegOpenKeyExW(HKEY_CURRENT_USER, subkey.as_ptr(), 0, KEY_READ, &mut key) };
    if opened != 0 {
        return fallback_steam_root();
    }

    let mut value_type = 0u32;
    let mut byte_len = 0u32;
    let queried = unsafe {
        RegQueryValueExW(
            key,
            value_name.as_ptr(),
            std::ptr::null_mut(),
            &mut value_type,
            std::ptr::null_mut(),
            &mut byte_len,
        )
    };
    if queried != 0 || value_type != REG_SZ || byte_len < 2 {
        unsafe { RegCloseKey(key) };
        return fallback_steam_root();
    }

    let mut value = vec![0u16; (byte_len as usize).div_ceil(2)];
    let queried = unsafe {
        RegQueryValueExW(
            key,
            value_name.as_ptr(),
            std::ptr::null_mut(),
            &mut value_type,
            value.as_mut_ptr() as *mut u8,
            &mut byte_len,
        )
    };
    unsafe { RegCloseKey(key) };
    if queried != 0 {
        return fallback_steam_root();
    }

    let end = value.iter().position(|&c| c == 0).unwrap_or(value.len());
    let root = PathBuf::from(String::from_utf16_lossy(&value[..end]).replace('/', "\\"));
    root.join("logs")
        .join("content_log.txt")
        .is_file()
        .then_some(root)
}

fn fallback_steam_root() -> Option<PathBuf> {
    [
        std::env::var_os("ProgramFiles(x86)").map(|path| PathBuf::from(path).join("Steam")),
        std::env::var_os("ProgramFiles").map(|path| PathBuf::from(path).join("Steam")),
    ]
    .into_iter()
    .flatten()
    .find(|root| root.join("logs").join("content_log.txt").is_file())
}

fn read_log_tail(path: &PathBuf) -> std::io::Result<String> {
    let mut file = File::open(path)?;
    let length = file.metadata()?.len();
    file.seek(SeekFrom::Start(length.saturating_sub(MAX_LOG_TAIL_BYTES)))?;
    let mut bytes = Vec::with_capacity(length.min(MAX_LOG_TAIL_BYTES) as usize);
    file.read_to_end(&mut bytes)?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

fn has_active_game_download(log: &str) -> bool {
    let mut app_states = HashMap::<u32, bool>::new();
    for line in log.lines() {
        let Some((prefix, state)) = line.split_once(" App update changed : ") else {
            continue;
        };
        let Some(app_id) = prefix
            .strip_prefix('[')
            .and_then(|line| line.split_once("] AppID ").map(|(_, id)| id))
            .and_then(|id| id.split_whitespace().next())
            .and_then(|id| id.parse::<u32>().ok())
        else {
            continue;
        };
        let tokens: Vec<&str> = state
            .trim()
            .trim_end_matches(',')
            .split(',')
            .map(str::trim)
            .collect();
        let downloading = app_id != 0
            && tokens.contains(&"Downloading")
            && !tokens.contains(&"Paused")
            && !tokens.contains(&"Stopping");
        app_states.insert(app_id, downloading);
    }
    app_states.values().any(|&downloading| downloading)
}

#[cfg(test)]
mod tests {
    use super::has_active_game_download;

    #[test]
    fn detects_steam_game_download_state() {
        let log = "[2026-10-19 07:02:40] AppID 714010 App update changed : Running Update,Downloading,Staging,\n";
        assert!(has_active_game_download(log));
    }

    #[test]
    fn ignores_idle_and_workshop_activity() {
        let log = "[2026-10-19 07:41:17] AppID 241100 Workshop update changed : Running Update,\n[2026-10-19 07:41:18] AppID 241100 Workshop update changed : Running Update,Staging,\n";
        assert!(!has_active_game_download(log));
    }

    #[test]
    fn clears_download_state_when_paused_or_stopping() {
        let paused = "[2026-10-19 07:02:40] AppID 10 App update changed : Running Update,Downloading,Staging,\n[2026-10-19 07:03:00] AppID 10 App update changed : Running Update,Downloading,Paused,\n";
        let stopped = "[2026-10-19 07:02:40] AppID 10 App update changed : Running Update,Downloading,Staging,\n[2026-10-19 07:03:00] AppID 10 App update changed : Running Update,Stopping,\n";
        assert!(!has_active_game_download(paused));
        assert!(!has_active_game_download(stopped));
    }
}
