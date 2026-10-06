use crate::{conversation, model::AppError};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Deserialize;
use std::{fs::OpenOptions, io::Write, path::Path};

const MAX_BYTES: usize = 5 * 1024 * 1024;

#[derive(Deserialize)]
pub(crate) struct Attachment {
    name: String,
    url: String,
}

// Preserve extensions for document readers, but never accept paths from the client.
fn safe_name(name: &str) -> String {
    let mut result = String::from("file-");
    for ch in name.chars() {
        if result.len() + ch.len_utf8() > 200 {
            break;
        }
        result.push(if ch.is_control() || "/\\:*?\"<>|".contains(ch) {
            '_'
        } else {
            ch
        });
    }
    result.trim_end_matches(['.', ' ']).to_owned()
}

// Retain files across turns and restarts because Codex history refers to these paths.
pub(crate) fn prepare(
    mut text: String,
    attachments: Vec<Attachment>,
    folder: &Path,
) -> Result<(String, Vec<String>), AppError> {
    if attachments.len() > 4 || text.chars().count() > 32_000 {
        return Err(AppError::Validation(
            "添付は合計4ファイルまで、メッセージは32,000文字までです。".into(),
        ));
    }
    let mut images = Vec::new();
    let mut files = Vec::new();
    for attachment in attachments {
        let invalid =
            || AppError::Validation("添付は各5MB以下の空でないファイルを指定してください。".into());
        let (mime, encoded) = attachment
            .url
            .strip_prefix("data:")
            .and_then(|data| data.split_once(";base64,"))
            .ok_or_else(invalid)?;
        if encoded.len() > MAX_BYTES.div_ceil(3) * 4 {
            return Err(invalid());
        }
        let bytes = STANDARD.decode(encoded).map_err(|_| invalid())?;
        if bytes.is_empty() || bytes.len() > MAX_BYTES {
            return Err(invalid());
        }
        if matches!(
            mime,
            "image/png" | "image/jpeg" | "image/webp" | "image/gif"
        ) {
            images.push(attachment.url);
        } else {
            files.push((safe_name(&attachment.name), bytes));
        }
    }
    // Validate the entire batch before touching the filesystem.
    conversation::validate_input(
        if files.is_empty() {
            &text
        } else {
            "添付ファイル"
        },
        &images,
    )?;
    let batch = folder.join(uuid::Uuid::new_v4().to_string());
    let paths: Vec<_> = files
        .iter()
        .enumerate()
        .map(|(index, (name, _))| batch.join(format!("{index}-{name}")))
        .collect();
    for path in &paths {
        let quoted =
            serde_json::to_string(&path.to_string_lossy()).map_err(|_| AppError::Storage)?;
        text.push_str(&format!("\n\n添付ファイル（ローカルパス）: {quoted}"));
    }
    if !files.is_empty() {
        text.push_str("\n添付ファイルを必要に応じて読み取って回答してください。読み取れない場合は、その理由を説明してください。");
    }
    conversation::validate_input(&text, &images)?;
    if files.is_empty() {
        return Ok((text, images));
    }
    std::fs::create_dir_all(folder).map_err(|_| AppError::Storage)?;
    let mut builder = std::fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(&batch).map_err(|_| AppError::Storage)?;
    for (path, (_, bytes)) in paths.iter().zip(files.iter()) {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        if options
            .open(path)
            .and_then(|mut file| file.write_all(bytes))
            .is_err()
        {
            // Only remove the unique directory created by this invocation.
            let _ = std::fs::remove_dir_all(&batch);
            return Err(AppError::Storage);
        }
    }
    Ok((text, images))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn attachment(name: &str, mime: &str, bytes: &[u8]) -> Attachment {
        Attachment {
            name: name.into(),
            url: format!("data:{mime};base64,{}", STANDARD.encode(bytes)),
        }
    }
    fn saved_paths(text: &str) -> Vec<std::path::PathBuf> {
        text.lines()
            .filter_map(|line| line.strip_prefix("添付ファイル（ローカルパス）: "))
            .map(|value| std::path::PathBuf::from(serde_json::from_str::<String>(value).unwrap()))
            .collect()
    }
    #[test]
    fn preserves_document_code_media_and_unknown_file_bytes_and_extensions() {
        let folder = tempfile::tempdir().unwrap();
        for name in [
            "report.pdf",
            "表.csv",
            "book.xlsx",
            "slides.pptx",
            "document.docx",
            "main.rs",
            "audio.mp3",
            "video.mp4",
            "archive.zip",
            "Dockerfile",
            "unknown.custom",
        ] {
            let bytes = b"\x00\xfforiginal bytes";
            let (text, images) = prepare(
                String::new(),
                vec![attachment(name, "application/octet-stream", bytes)],
                folder.path(),
            )
            .unwrap();
            let paths = saved_paths(&text);
            assert_eq!(paths.len(), 1);
            assert!(paths[0]
                .file_name()
                .unwrap()
                .to_str()
                .unwrap()
                .ends_with(name));
            assert_eq!(std::fs::read(&paths[0]).unwrap(), bytes);
            assert!(images.is_empty());
        }
    }
    #[test]
    fn mixed_attachments_preserve_native_images_and_duplicate_filenames() {
        let folder = tempfile::tempdir().unwrap();
        let image = attachment("sample.png", "image/png", b"image");
        let url = image.url.clone();
        let (text, images) = prepare(
            "要約".into(),
            vec![
                image,
                attachment("same.txt", "text/plain", b"one"),
                attachment("same.txt", "", b"two"),
            ],
            folder.path(),
        )
        .unwrap();
        assert!(text.starts_with("要約"));
        assert_eq!(images, vec![url]);
        let paths = saved_paths(&text);
        assert_ne!(paths[0], paths[1]);
        assert_eq!(std::fs::read(&paths[0]).unwrap(), b"one");
        assert_eq!(std::fs::read(&paths[1]).unwrap(), b"two");
    }
    #[test]
    fn confines_untrusted_names_and_escapes_prompt_paths() {
        let folder = tempfile::tempdir().unwrap();
        let (text, _) = prepare(
            String::new(),
            vec![attachment("../../bad\\name\n\".txt", "text/plain", b"data")],
            folder.path(),
        )
        .unwrap();
        let path = &saved_paths(&text)[0];
        assert!(path
            .canonicalize()
            .unwrap()
            .starts_with(folder.path().canonicalize().unwrap()));
        assert!(!path.file_name().unwrap().to_str().unwrap().contains('\n'));
        assert!(path.extension().unwrap() == "txt");
    }
    #[test]
    fn rejects_invalid_oversized_empty_and_excess_attachments_without_writing() {
        let folder = tempfile::tempdir().unwrap();
        for attachments in [
            vec![Attachment {
                name: "x".into(),
                url: "https://example.com/file".into(),
            }],
            vec![Attachment {
                name: "x".into(),
                url: "data:text/plain;base64,!!!!".into(),
            }],
            vec![attachment(
                "big.txt",
                "text/plain",
                &vec![b'x'; MAX_BYTES + 1],
            )],
            vec![attachment("empty.txt", "text/plain", b"")],
            (0..5).map(|_| attachment("x", "", b"x")).collect(),
        ] {
            assert!(prepare(String::new(), attachments, folder.path()).is_err());
        }
        assert_eq!(std::fs::read_dir(folder.path()).unwrap().count(), 0);
    }
}
