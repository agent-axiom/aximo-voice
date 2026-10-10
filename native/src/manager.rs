//! Dependency-free end-user package management. Claude configuration is changed
//! only through its official CLI; models and microphone permissions stay separate.
use anyhow::{bail, Context, Result};
use aximo_voice::lifecycle_lock;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    fs,
    io::{self, Read, Write},
    path::{Component, Path, PathBuf},
    process::Command,
};

const VERSION: &str = env!("CARGO_PKG_VERSION");
const ID: &str = "aximo-voice@aximo";
const FORMULA: &str = "agent-axiom/tap/aximo-voice";
const META: &str = "share/aximo-voice/KIT-METADATA.json";
const PLUGIN: &str = "share/aximo-voice/plugin";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Kit {
    schema_version: u32,
    version: String,
    plugin_version: String,
    runtime_version: String,
    cli_version: String,
    platform: String,
    #[serde(default)]
    compatibility: Value,
    files: Vec<KitFile>,
}
#[derive(Deserialize)]
struct KitFile {
    file: String,
    sha256: String,
    size: u64,
}

fn main() {
    if let Err(error) = dispatch() {
        eprintln!("Aximo Voice: {error:#}");
        std::process::exit(1);
    }
}
fn dispatch() -> Result<()> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    match args
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>()
        .as_slice()
    {
        ["--version"] => {
            println!("{}", json!({"version":VERSION}));
            Ok(())
        }
        [] | ["--help"] | ["help"] => {
            println!("Aximo Voice\n  setup                  Connect this verified kit to Claude Code (user scope)\n  doctor                 Check kit, runtime and Claude registration\n  doctor --package-only  Check kit/runtime without Claude\n  update                 Upgrade Brew package, then update Claude registration\n  uninstall              Disconnect; retain downloaded models\n  uninstall --delete-models  Also ask before removing Aximo model weights\n\nNo command opens the microphone. Run /av in Claude to choose a model and start.");
            Ok(())
        }
        ["setup"] => setup(&kit_root()?),
        ["doctor"] => doctor(&kit_root()?, false),
        ["doctor", "--package-only"] => doctor(&kit_root()?, true),
        ["update"] => update(),
        ["uninstall"] => uninstall(false),
        ["uninstall", "--delete-models"] => uninstall(true),
        _ => bail!("unknown command or option; run aximo-voice --help"),
    }
}
fn kit_root() -> Result<PathBuf> {
    let exe = std::env::current_exe()?.canonicalize()?;
    Ok(exe
        .parent()
        .and_then(Path::parent)
        .context("invalid package layout")?
        .to_owned())
}
fn hash(path: &Path) -> Result<String> {
    let mut input = fs::File::open(path)?;
    let mut digest = Sha256::new();
    let mut buf = [0u8; 65536];
    loop {
        let n = input.read(&mut buf)?;
        if n == 0 {
            break;
        }
        digest.update(&buf[..n]);
    }
    Ok(format!("{:x}", digest.finalize()))
}
fn safe_relative(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"/_.-".contains(&c))
        && Path::new(value)
            .components()
            .all(|p| matches!(p, Component::Normal(_)))
}
fn all_files(root: &Path, dir: &Path, out: &mut BTreeSet<String>) -> Result<()> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        let meta = fs::symlink_metadata(&path)?;
        if meta.file_type().is_symlink() {
            bail!("package contains a link: {}", path.display());
        }
        if meta.is_dir() {
            all_files(root, &path, out)?;
        } else if meta.is_file() {
            out.insert(
                path.strip_prefix(root)?
                    .to_str()
                    .context("non-UTF8 package filename")?
                    .replace('\\', "/"),
            );
        } else {
            bail!("package contains a non-regular file");
        }
    }
    Ok(())
}
fn verify(root: &Path) -> Result<Kit> {
    let root_meta = fs::symlink_metadata(root)?;
    if !root_meta.is_dir() || root_meta.file_type().is_symlink() {
        bail!("kit root is not a regular directory");
    }
    let mut actual = BTreeSet::new();
    all_files(root, root, &mut actual)?;
    let kit: Kit = serde_json::from_slice(
        &fs::read(root.join(META))
            .context("not a complete Aximo kit; use the packaged distribution")?,
    )?;
    if kit.schema_version != 1
        || [&kit.plugin_version, &kit.runtime_version, &kit.cli_version]
            .iter()
            .any(|v| *v != &kit.version)
    {
        bail!("kit component version mismatch");
    }
    let expected_platform = match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => "macos-aarch64",
        ("macos", "x86_64") => "macos-x86_64",
        ("linux", "x86_64") => "linux-x86_64",
        _ => bail!("package manager preview supports Mac and Linux x86-64 only"),
    };
    if kit.platform != expected_platform {
        bail!("kit architecture does not match this computer");
    }
    if std::env::consts::OS == "macos" {
        let floor = kit.compatibility["minimumMacOS"]
            .as_str()
            .context("kit has no verified minimum macOS version")?;
        let current = output(Command::new("/usr/bin/sw_vers").arg("-productVersion"))?;
        if version_numbers(current.trim())? < version_numbers(floor)? {
            bail!(
                "this kit requires macOS {floor} or newer (installed {})",
                current.trim()
            );
        }
    }
    let mut declared = BTreeSet::from([META.to_owned()]);
    for item in &kit.files {
        if !safe_relative(&item.file)
            || !declared.insert(item.file.clone())
            || item.sha256.len() != 64
            || !item.sha256.bytes().all(|c| c.is_ascii_hexdigit())
        {
            bail!("invalid kit file manifest");
        }
        let path = root.join(&item.file);
        if fs::symlink_metadata(&path)?.len() != item.size || hash(&path)? != item.sha256 {
            bail!("kit integrity failed for {}", item.file);
        }
    }
    if actual != declared {
        bail!("kit contains missing or unlisted files");
    }
    let plugin: Value = serde_json::from_slice(&fs::read(
        root.join(PLUGIN).join(".claude-plugin/plugin.json"),
    )?)?;
    if plugin["name"] != "aximo-voice" || plugin["version"] != kit.version {
        bail!("plugin manifest version mismatch");
    }
    let market: Value = serde_json::from_slice(&fs::read(
        root.join(PLUGIN).join(".claude-plugin/marketplace.json"),
    )?)?;
    let entries = market["plugins"]
        .as_array()
        .context("invalid local marketplace")?;
    if market["name"] != "aximo"
        || entries.len() != 1
        || entries[0]["name"] != "aximo-voice"
        || entries[0]["source"] != "./"
    {
        bail!("kit marketplace must contain only the local Aximo plugin");
    }
    Ok(kit)
}
fn output(command: &mut Command) -> Result<String> {
    let result = command
        .output()
        .with_context(|| format!("could not run {command:?}"))?;
    if !result.status.success() {
        bail!(
            "{command:?} failed: {}{}",
            String::from_utf8_lossy(&result.stderr),
            String::from_utf8_lossy(&result.stdout)
        );
    }
    String::from_utf8(result.stdout).context("command returned invalid UTF-8")
}
fn claude(args: &[&str]) -> Result<String> {
    output(Command::new("claude").args(args)).context("Claude Code command failed; install/update it from https://code.claude.com/docs/en/setup and retry")
}
fn cli_json(args: &[&str]) -> Result<Value> {
    serde_json::from_str(&claude(args)?)
        .context("unsupported Claude JSON response; no configuration files were edited")
}
fn cli_mutate(args: &[&str]) -> Result<()> {
    let text = claude(args)?;
    let value: Value =
        serde_json::from_str(text.lines().last().context("Claude returned no result")?)?;
    if value["outcome"] != "ok" {
        bail!("Claude did not confirm the operation: {text}");
    }
    Ok(())
}
fn version_numbers(version: &str) -> Result<[u32; 3]> {
    let parts = version
        .split('.')
        .map(str::parse::<u32>)
        .collect::<std::result::Result<Vec<_>, _>>()?;
    if parts.is_empty() || parts.len() > 3 {
        bail!("invalid version");
    }
    let mut result = [0; 3];
    result[..parts.len()].copy_from_slice(&parts);
    Ok(result)
}
fn check_claude() -> Result<()> {
    let text = claude(&["--version"])?;
    let components: Vec<_> = text
        .split_whitespace()
        .next()
        .unwrap_or("")
        .split('.')
        .map(str::parse::<u32>)
        .collect::<std::result::Result<_, _>>()
        .context("cannot read Claude Code version")?;
    if components.len() != 3 || components.as_slice() < [2, 1, 293].as_slice() {
        bail!("Claude Code 2.1.293 or newer is required; update Claude and retry setup");
    }
    Ok(())
}
fn expected_plugin(data: &Path) -> PathBuf {
    data.join("installed").join(PLUGIN)
}
fn check_registration(data: &Path) -> Result<(bool, bool)> {
    check_claude()?;
    let markets = cli_json(&["plugin", "marketplace", "list", "--json"])?;
    let entries = markets
        .as_array()
        .context("unsupported marketplace listing")?;
    let mut registered = false;
    for m in entries.iter().filter(|m| m["name"] == "aximo") {
        if registered
            || m["source"] != "directory"
            || m["path"].as_str() != expected_plugin(data).to_str()
        {
            bail!("An aximo marketplace already uses another source. Keep that channel, or explicitly remove its Aximo plugin/marketplace in Claude before retrying setup. No existing registration was changed.");
        }
        registered = true;
    }
    let plugins = cli_json(&["plugin", "list", "--json"])?;
    let mut installed = false;
    for p in plugins.as_array().context("unsupported plugin listing")? {
        let id = p["id"].as_str().context("plugin listing lacks id")?;
        if id.starts_with("aximo-voice@") || id.ends_with("@aximo") {
            if id != ID || p["scope"] != "user" || installed {
                bail!("Aximo is installed from another channel or scope; resolve it in Claude before using this manager. Nothing was changed.");
            }
            let loaded = p["readFromFolder"]
                .as_str()
                .or_else(|| p["installPath"].as_str());
            if loaded != expected_plugin(data).to_str() || !registered {
                bail!("existing Aximo installation is not owned by this manager");
            }
            installed = true;
        }
    }
    Ok((registered, installed))
}
fn runtime_doctor(root: &Path, version: &str) -> Result<Value> {
    let value: Value = serde_json::from_str(&output(
        Command::new(root.join(PLUGIN).join("bin/aximo-voice-native")).arg("doctor"),
    )?)?;
    if value["type"] != "doctor"
        || value["version"] != version
        || value["runtimeLoaded"] != true
        || value["microphoneChecked"] != false
        || value["telemetryEnabled"] != false
        || value["setupProgressProtocol"] != 1
    {
        bail!("bundled runtime failed its version, ABI or privacy contract");
    }
    Ok(value)
}
fn copy_kit(source: &Path, destination: &Path) -> Result<()> {
    let kit = verify(source)?;
    for name in kit
        .files
        .iter()
        .map(|f| f.file.as_str())
        .chain(std::iter::once(META))
    {
        let dest = destination.join(name);
        fs::create_dir_all(dest.parent().context("missing parent")?)?;
        fs::copy(source.join(name), dest)?;
    }
    verify(destination)?;
    Ok(())
}
fn verify_installed(data: &Path, version: &str) -> Result<()> {
    let (registered, installed) = check_registration(data)?;
    if !registered || !installed {
        bail!("Claude registration was not confirmed; run aximo-voice setup again");
    }
    let entries = cli_json(&["plugin", "list", "--json"])?;
    let item = entries
        .as_array()
        .context("invalid plugin list")?
        .iter()
        .find(|p| p["id"] == ID)
        .context("plugin not listed")?;
    let loaded_version = item["folderVersion"]
        .as_str()
        .or_else(|| item["version"].as_str());
    if loaded_version != Some(version)
        || item["enabled"] != true
        || item["errors"].as_array().is_some_and(|e| !e.is_empty())
    {
        bail!("Claude reports the plugin disabled, blocked, or at a different version; inspect claude plugin list and retry setup");
    }
    Ok(())
}
fn setup(root: &Path) -> Result<()> {
    let _guard = lifecycle_lock::exclusive()?;
    let data = lifecycle_lock::data_dir()?;
    let kit = verify(root)?;
    if kit.cli_version != VERSION {
        bail!("manager version differs from kit; run the manager bundled with this kit");
    }
    runtime_doctor(root, &kit.version)?;
    let (registered, installed) = check_registration(&data)?;
    let active = data.join("installed");
    if active.exists() {
        verify(&active).context("refusing to replace an unrecognized or damaged installed kit")?;
    }
    let stage = tempfile::Builder::new()
        .prefix(".kit-stage-")
        .tempdir_in(&data)?;
    copy_kit(root, stage.path())?;
    runtime_doctor(stage.path(), &kit.version)?;
    let backup = data.join(format!(".kit-previous-{}", uuid::Uuid::new_v4()));
    let had_old = active.exists();
    println!("Connecting Aximo Voice {} to Claude Code for your user account. Models are downloaded later with your consent in /av.", kit.version);
    if had_old {
        fs::rename(&active, &backup)?;
    }
    if let Err(error) = fs::rename(stage.path(), &active) {
        if had_old {
            fs::rename(&backup, &active).context("could not restore previous kit")?;
        }
        return Err(error.into());
    }
    let result = (|| {
        if !registered {
            cli_mutate(&[
                "plugin",
                "marketplace",
                "add",
                expected_plugin(&data).to_str().context("non-UTF8 path")?,
                "--scope",
                "user",
                "--json",
            ])?;
        }
        if installed {
            cli_mutate(&["plugin", "update", ID, "--scope", "user", "--json"])?;
        } else {
            cli_mutate(&["plugin", "install", ID, "--scope", "user", "--json"])?;
        }
        verify_installed(&data, &kit.version)
    })();
    if let Err(error) = result {
        if had_old {
            let failed = data.join(format!(".kit-failed-{}", uuid::Uuid::new_v4()));
            fs::rename(&active, &failed)?;
            fs::rename(&backup, &active).context("could not restore previous kit")?;
            let restore = if installed {
                cli_mutate(&["plugin", "update", ID, "--scope", "user", "--json"])
            } else {
                Ok(())
            };
            let _ = fs::remove_dir_all(failed);
            if let Err(restore_error) = restore {
                bail!("{error:#}; previous kit restored on disk but Claude refresh failed: {restore_error:#}. Run aximo-voice setup again.");
            }
        }
        return Err(error).context(
            "setup did not complete; previous models were retained. Run aximo-voice setup to retry",
        );
    }
    if had_old {
        if let Err(error) = fs::remove_dir_all(&backup) {
            eprintln!(
                "Connected, but the previous kit could not be cleaned up at {}: {error}",
                backup.display()
            );
        }
    }
    println!("Connected. Restart/reload Claude Code, then run /av. Choose a model, review its download, and press Start when ready.");
    Ok(())
}
fn doctor(root: &Path, package_only: bool) -> Result<()> {
    let kit = verify(root)?;
    let runtime = runtime_doctor(root, &kit.version)?;
    if !package_only {
        let data = lifecycle_lock::data_dir()?;
        verify_installed(&data, &kit.version)?;
        let active = data.join("installed");
        let active_kit = verify(&active)?;
        if active_kit.version != kit.version {
            bail!("Brew and installed plugin differ; run aximo-voice setup");
        }
        runtime_doctor(&active, &kit.version)?;
    }
    println!(
        "{}",
        json!({"type":"doctor","version":kit.version,"kitIntegrity":true,"runtimeLoaded":true,"registrationChecked":!package_only,"modelReady":runtime["modelReady"],"modelPath":runtime["modelPath"],"microphoneChecked":false})
    );
    Ok(())
}
fn update() -> Result<()> {
    {
        let _guard = lifecycle_lock::exclusive()?;
        let data = lifecycle_lock::data_dir()?;
        let (registered, installed) = check_registration(&data)?;
        if !registered || !installed {
            bail!("run aximo-voice setup before update");
        }
        println!("Upgrading the Brew package, then refreshing Aximo in Claude. The installed copy and models remain available if Brew fails.");
        let status = Command::new("brew")
            .args(["upgrade", FORMULA])
            .env("HOMEBREW_NO_INSTALL_CLEANUP", "1")
            .status()
            .context("Homebrew unavailable; see https://brew.sh")?;
        if !status.success() {
            bail!("Brew upgrade failed; installed copy retained. Retry aximo-voice update");
        }
    }
    let prefix = output(Command::new("brew").args(["--prefix", FORMULA]))?;
    let path = PathBuf::from(prefix.trim());
    if !path.is_absolute() {
        bail!("Homebrew returned an invalid package path");
    }
    let status = Command::new(path.join("bin/aximo-voice"))
        .arg("setup")
        .status()?;
    if !status.success() {
        bail!("Brew package updated, but plugin setup did not complete. Retry aximo-voice setup");
    }
    Ok(())
}
fn model_bytes(path: &Path) -> Result<u64> {
    if !path.exists() {
        return Ok(0);
    }
    let meta = fs::symlink_metadata(path)?;
    if meta.file_type().is_symlink() {
        return Ok(0);
    }
    if meta.is_file() {
        return Ok(meta.len());
    }
    if !meta.is_dir() {
        bail!("model storage contains a special file");
    }
    let mut bytes = 0;
    for entry in fs::read_dir(path)? {
        bytes += model_bytes(&entry?.path())?;
    }
    Ok(bytes)
}
fn remove_owned_models(models: &Path) -> Result<()> {
    let metadata = fs::symlink_metadata(models)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        bail!("refusing linked or non-directory model storage");
    }
    let manifest: Value = serde_json::from_str(include_str!("../models.json"))?;
    for (engine, model) in manifest.as_object().context("invalid model manifest")? {
        let revision = model["revision"]
            .as_str()
            .context("missing model revision")?;
        for name in [
            engine.clone(),
            format!(".model-download-{engine}-{revision}"),
            format!(".model-backup-{engine}"),
        ] {
            let dir = models.join(name);
            let Ok(meta) = fs::symlink_metadata(&dir) else {
                continue;
            };
            if !meta.is_dir() || meta.file_type().is_symlink() {
                continue;
            }
            for file in model["files"].as_array().context("missing model files")? {
                let name = file["name"].as_str().context("missing model filename")?;
                if !safe_relative(name) || Path::new(name).components().count() != 1 {
                    bail!("invalid model filename");
                }
                let path = dir.join(name);
                if fs::symlink_metadata(&path)
                    .is_ok_and(|m| m.is_file() && !m.file_type().is_symlink())
                {
                    fs::remove_file(path)?;
                }
            }
            // Unknown files and unrecognized revisions belong to the user.
            // Only remove an empty known directory, never recursively erase it.
            let _ = fs::remove_dir(dir);
        }
    }
    let _ = fs::remove_dir(models);
    Ok(())
}
fn uninstall(delete_models: bool) -> Result<()> {
    let _guard = lifecycle_lock::exclusive()?;
    let data = lifecycle_lock::data_dir()?;
    let (registered, installed) = check_registration(&data)?;
    let models = data.join("models");
    let bytes = model_bytes(&models)?;
    let mut remove_models = false;
    if delete_models {
        print!("Permanently remove only Aximo model weights at {} ({:.1} MB)? Type DELETE to confirm: ", models.display(), bytes as f64 / 1_000_000.0);
        io::stdout().flush()?;
        let mut answer = String::new();
        io::stdin().read_line(&mut answer)?;
        remove_models = answer.trim() == "DELETE";
        if !remove_models {
            println!("Model removal cancelled; weights will be retained.");
        }
    }
    if installed {
        cli_mutate(&[
            "plugin",
            "uninstall",
            ID,
            "--scope",
            "user",
            "--keep-data",
            "--json",
        ])?;
    }
    if registered {
        cli_mutate(&[
            "plugin",
            "marketplace",
            "remove",
            "aximo",
            "--scope",
            "user",
            "--json",
        ])?;
    }
    let state = check_registration(&data)?;
    if state != (false, false) {
        bail!("Claude registration remains; inspect claude plugin list");
    }
    if remove_models && models.exists() {
        remove_owned_models(&models)?;
    }
    let active = data.join("installed");
    if active.exists() {
        verify(&active)
            .context("registration removed; refusing to delete an unrecognized installed kit")?;
        fs::remove_dir_all(active)?;
    }
    println!("Disconnected from Claude. {} models at {} ({:.1} MB).\nTo remove the Brew package: brew uninstall {}", if remove_models {"Removed known files from"} else {"Retained"}, models.display(), bytes as f64/1_000_000.0, FORMULA);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_relative_normal_paths() {
        for path in ["", "../x", "/x", "a/../b", "a\\b", "./x"] {
            assert!(!safe_relative(path));
        }
        assert!(safe_relative("share/aximo-voice/plugin/hooks/register.js"));
    }
    #[test]
    fn model_sizes_and_unknown_files_are_preserved_by_default() {
        let d = tempfile::tempdir().unwrap();
        fs::write(d.path().join("a"), b"abc").unwrap();
        assert_eq!(model_bytes(d.path()).unwrap(), 3);
    }
    #[cfg(unix)]
    #[test]
    fn model_symlinks_cannot_trigger_recursive_delete() {
        let d = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink("/tmp", d.path().join("link")).unwrap();
        assert_eq!(model_bytes(d.path()).unwrap(), 0);
    }
}
