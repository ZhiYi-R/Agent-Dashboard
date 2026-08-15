//! Check GitHub Releases for a newer app version (notify + open download page).
//! Does not implement signed in-app binary install (that needs tauri-plugin-updater).

use crate::models::UpdateCheckResult;
use serde::Deserialize;

const GITHUB_OWNER: &str = "ZhiYi-R";
const GITHUB_REPO: &str = "Agent-Dashboard";
const USER_AGENT: &str = "Agent-Statistics-Updater";

#[derive(Debug, Deserialize)]
struct GhRelease {
    tag_name: String,
    html_url: String,
    body: Option<String>,
    draft: bool,
    prerelease: bool,
    published_at: Option<String>,
    assets: Vec<GhAsset>,
}

#[derive(Debug, Deserialize)]
struct GhAsset {
    name: String,
    browser_download_url: String,
    content_type: Option<String>,
}

/// Normalize `Release-`, optional `v`, and surrounding whitespace from a version string.
fn normalize_version(raw: &str) -> String {
    let trimmed = raw.trim();
    let without_release = trimmed
        .strip_prefix("Release-")
        .or_else(|| trimmed.strip_prefix("release-"))
        .unwrap_or(trimmed);
    without_release.trim_start_matches(['v', 'V']).to_string()
}

/// Parse `1.2.3`, `v1.2.3`, `Release-1.2.3`, `1.2.3-beta.1` → (major, minor, patch, prerelease_flag)
fn parse_semver(raw: &str) -> Option<(u64, u64, u64, bool)> {
    let s = normalize_version(raw);
    if s.is_empty() {
        return None;
    }
    let (core, pre) = match s.split_once(|c| c == '-' || c == '+') {
        Some((c, rest)) => (c, !rest.is_empty()),
        None => (s.as_str(), false),
    };
    let mut parts = core.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next().unwrap_or("0").parse().ok()?;
    let patch = parts.next().unwrap_or("0").parse().ok()?;
    Some((major, minor, patch, pre))
}

/// Compare two version strings. Returns Ordering of a vs b (numeric core only).
/// Pre-release is considered lower than the same core release.
fn cmp_version(a: &str, b: &str) -> Option<std::cmp::Ordering> {
    let (am, an, ap, apre) = parse_semver(a)?;
    let (bm, bn, bp, bpre) = parse_semver(b)?;
    use std::cmp::Ordering;
    match (am, an, ap).cmp(&(bm, bn, bp)) {
        Ordering::Equal => match (apre, bpre) {
            (false, true) => Some(Ordering::Greater),
            (true, false) => Some(Ordering::Less),
            _ => Some(Ordering::Equal),
        },
        other => Some(other),
    }
}

fn pick_download_url(assets: &[GhAsset]) -> Option<String> {
    // Prefer installers for current OS.
    #[cfg(target_os = "windows")]
    let prefer = [".exe", ".msi"];
    #[cfg(target_os = "macos")]
    let prefer = [".dmg", ".app.tar.gz"];
    #[cfg(target_os = "linux")]
    let prefer = [".AppImage", ".deb", ".rpm"];
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    let prefer: [&str; 0] = [];

    for ext in prefer {
        if let Some(a) = assets.iter().find(|a| a.name.ends_with(ext)) {
            return Some(a.browser_download_url.clone());
        }
    }
    // Fallback: any non-signature asset
    assets
        .iter()
        .find(|a| {
            let n = a.name.to_lowercase();
            !n.ends_with(".sig")
                && !n.ends_with(".json")
                && a.content_type
                    .as_deref()
                    .map(|c| !c.contains("json"))
                    .unwrap_or(true)
        })
        .map(|a| a.browser_download_url.clone())
}

pub fn current_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

pub fn check_latest_release() -> Result<UpdateCheckResult, String> {
    let current = current_version();
    let url = format!("https://api.github.com/repos/{GITHUB_OWNER}/{GITHUB_REPO}/releases/latest");

    let client = reqwest::blocking::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;

    let resp = client
        .get(&url)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .send()
        .map_err(|e| format!("network error: {e}"))?;

    let status = resp.status();
    if status.as_u16() == 404 {
        return Ok(UpdateCheckResult {
            current_version: current,
            latest_version: None,
            update_available: false,
            release_url: Some(format!(
                "https://github.com/{GITHUB_OWNER}/{GITHUB_REPO}/releases"
            )),
            download_url: None,
            notes: None,
            published_at: None,
            checked_at: chrono::Utc::now().to_rfc3339(),
            message: "No GitHub release found yet.".into(),
        });
    }
    if !status.is_success() {
        let body = resp.text().unwrap_or_default();
        return Err(format!("GitHub API {status}: {body}"));
    }

    let release: GhRelease = resp.json().map_err(|e| format!("parse release: {e}"))?;
    if release.draft {
        return Ok(UpdateCheckResult {
            current_version: current,
            latest_version: None,
            update_available: false,
            release_url: Some(release.html_url),
            download_url: None,
            notes: None,
            published_at: release.published_at,
            checked_at: chrono::Utc::now().to_rfc3339(),
            message: "Latest release is a draft.".into(),
        });
    }

    let latest_tag = release.tag_name.clone();
    let newer = cmp_version(&latest_tag, &current)
        .map(|o| o == std::cmp::Ordering::Greater)
        .unwrap_or(false);

    // If tags are non-semver, fall back to string inequality after normalizing release prefixes.
    let newer = if parse_semver(&latest_tag).is_none() || parse_semver(&current).is_none() {
        normalize_version(&latest_tag) != normalize_version(&current)
    } else {
        newer
    };

    // Ignore pure prerelease tags unless current is also prerelease-shaped and tag is newer.
    let update_available = if release.prerelease {
        let cur_pre = parse_semver(&current).map(|p| p.3).unwrap_or(false);
        newer && cur_pre
    } else {
        newer
    };

    let download_url = pick_download_url(&release.assets);
    let notes = release.body.filter(|s| !s.trim().is_empty());

    Ok(UpdateCheckResult {
        current_version: current,
        latest_version: Some(latest_tag),
        update_available,
        release_url: Some(release.html_url),
        download_url,
        notes,
        published_at: release.published_at,
        checked_at: chrono::Utc::now().to_rfc3339(),
        message: if update_available {
            "A newer release is available.".into()
        } else {
            "You are on the latest version.".into()
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cmp::Ordering;

    #[test]
    fn semver_compare() {
        assert_eq!(cmp_version("0.1.0", "0.1.0"), Some(Ordering::Equal));
        assert_eq!(cmp_version("v0.2.0", "0.1.9"), Some(Ordering::Greater));
        assert_eq!(cmp_version("Release-0.2.0", "0.2.0"), Some(Ordering::Equal));
        assert_eq!(
            cmp_version("Release-v0.3.0", "0.2.9"),
            Some(Ordering::Greater)
        );
        assert_eq!(cmp_version("release-0.1.0", "0.1.1"), Some(Ordering::Less));
        assert_eq!(cmp_version("0.1.0", "0.1.1"), Some(Ordering::Less));
        assert_eq!(cmp_version("1.0.0-beta", "1.0.0"), Some(Ordering::Less));
    }
}
