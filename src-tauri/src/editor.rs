use crate::model::AppError;
use std::{
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};

pub(crate) fn workspace(cwd: &str) -> Result<PathBuf, AppError> {
    let path = Path::new(cwd);
    if !path.is_absolute() || !path.is_dir() {
        return Err(AppError::Validation(
            "作業フォルダが見つかりません。移動・削除されていないか確認してください。".into(),
        ));
    }
    path.canonicalize()
        .map_err(|_| AppError::Validation("作業フォルダにアクセスできません。".into()))
}

pub async fn open_zed(cwd: String) -> Result<(), AppError> {
    let folder = tauri::async_runtime::spawn_blocking(move || workspace(&cwd))
        .await
        .map_err(|_| AppError::Storage)??;
    // Pass the verified directory as a single argument, never through a shell.
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = tokio::process::Command::new("/usr/bin/open");
        command.args(["-a", "Zed", "--"]);
        command
    };
    #[cfg(not(target_os = "macos"))]
    let mut command = {
        let mut command =
            tokio::process::Command::new(if cfg!(windows) { "zed.exe" } else { "zed" });
        command.arg("--");
        command
    };
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    command
        .arg(folder)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let status = tokio::time::timeout(Duration::from_secs(10), command.status()).await
        .map_err(|_| AppError::EditorUnavailable("Zed の起動要求がタイムアウトしました。".into()))?
        .map_err(|_| AppError::EditorUnavailable("Zed を起動できません。インストール状況を確認してください。Windows / Linux では zed コマンドを PATH に追加してください。".into()))?;
    if !status.success() {
        return Err(AppError::EditorUnavailable("Zed でフォルダを開けませんでした。Zed のインストール状況とフォルダへのアクセス権を確認してください。".into()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_empty_relative_and_missing_directories() {
        for path in ["", ".", "-n", "/treadcraft/nonexistent/workspace"] {
            assert!(workspace(path).is_err());
        }
    }
    #[test]
    fn accepts_directory_with_spaces_and_shell_metacharacters_as_literal_path() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("my project ; $name");
        std::fs::create_dir(&dir).unwrap();
        assert_eq!(
            workspace(dir.to_str().unwrap()).unwrap(),
            dir.canonicalize().unwrap()
        );
    }
    #[test]
    fn rejects_file_instead_of_directory() {
        let file = tempfile::NamedTempFile::new().unwrap();
        assert!(workspace(file.path().to_str().unwrap()).is_err());
    }
}
