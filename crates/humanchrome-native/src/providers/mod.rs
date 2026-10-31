//! Real external agent provider integrations.

pub mod claude;

/// Optional executable locations, preferring materialized bundle runtimes over external tools.
#[derive(Clone, Debug, Eq, PartialEq)]
#[non_exhaustive]
pub struct OptionalEnginePaths {
    /// Node runtime used by the real Claude SDK and DevTools adapters.
    pub node: std::path::PathBuf,
    /// Actual Codex CLI executable.
    pub codex: std::path::PathBuf,
}

/// Resolve optional bundle engines without launching them or requiring Node for the core.
///
/// # Errors
/// Reports an unavailable executable directory when no adapter override was configured.
pub fn engine_paths() -> std::io::Result<OptionalEnginePaths> {
    let directory = adapter_path()?.with_file_name("runtime").join("bin");
    Ok(OptionalEnginePaths {
        node: bundled_or_external(
            directory.join(if cfg!(windows) { "node.exe" } else { "node" }),
            "node",
        ),
        codex: bundled_or_external(
            directory.join(if cfg!(windows) { "codex.exe" } else { "codex" }),
            if cfg!(windows) { "codex.cmd" } else { "codex" },
        ),
    })
}

fn bundled_or_external(path: std::path::PathBuf, external: &str) -> std::path::PathBuf {
    // Only absence permits PATH lookup. A broken or inaccessible packaged executable must
    // fail when requested, rather than silently running a different globally installed version.
    if matches!(std::fs::symlink_metadata(&path), Err(error) if error.kind() == std::io::ErrorKind::NotFound)
    {
        external.into()
    } else {
        path
    }
}

/// Resolve the optional dependency adapter without starting Node or requiring it to exist.
///
/// # Errors
/// Reports an unavailable executable path when no explicit adapter was configured.
pub fn adapter_path() -> std::io::Result<std::path::PathBuf> {
    if let Some(path) = std::env::var_os("HC_THIRD_PARTY_ADAPTER") {
        return Ok(path.into());
    }
    let executable = std::env::current_exe()?;
    let directory = executable
        .parent()
        .ok_or_else(|| std::io::Error::other("native executable has no parent directory"))?;
    Ok(directory.join("adapters/third-party.mjs"))
}
