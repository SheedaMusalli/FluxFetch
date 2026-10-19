use std::collections::HashSet;
use std::path::PathBuf;

pub const DEFAULT_TARGETS: &[&str] = &[
    "steam.exe",
    "EpicGamesLauncher.exe",
    "EpicWebHelper.exe",
    "Battle.net.exe",
    "UbisoftConnect.exe",
    "upc.exe",
    "EADesktop.exe",
    "EABackgroundService.exe",
    "GalaxyClient.exe",
    "GalaxyClientService.exe",
    "GalaxyCommunication.exe",
    "RiotClientServices.exe",
    "RiotClientUx.exe",
    "RockstarService.exe",
];

pub fn config_path() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA").map(|root| {
        PathBuf::from(root)
            .join("FluxFetch")
            .join("OmniLink")
            .join("launchers.txt")
    })
}

/// Additional executables are opt-in; names must never be interpreted as paths or commands.
pub fn parse_targets(text: &str) -> HashSet<String> {
    text.lines()
        .map(str::trim)
        .filter(|name| {
            name.to_ascii_lowercase().ends_with(".exe")
                && name.len() > 4
                && name.len() <= 128
                && name
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b" ._-".contains(&c))
        })
        .map(str::to_ascii_lowercase)
        .collect()
}

pub fn target_names() -> HashSet<String> {
    let mut names: HashSet<String> = DEFAULT_TARGETS
        .iter()
        .map(|s| s.to_ascii_lowercase())
        .collect();
    if let Some(path) = config_path() {
        if let Ok(text) = std::fs::read_to_string(path) {
            names.extend(parse_targets(&text));
        }
    }
    names
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn custom_targets_accept_only_executable_names() {
        let names = parse_targets("Other Client.exe\nCUSTOM.exe\n../bad.exe\nC:\\bad.exe\n# comment\n.exe\ncmd.exe /c run\n");
        assert_eq!(
            names,
            HashSet::from(["other client.exe".into(), "custom.exe".into()])
        );
    }
    #[test]
    fn includes_steam_epic_and_download_services() {
        let names = target_names();
        for name in [
            "steam.exe",
            "epicgameslauncher.exe",
            "eabackgroundservice.exe",
            "riotclientservices.exe",
        ] {
            assert!(names.contains(name));
        }
    }
}
