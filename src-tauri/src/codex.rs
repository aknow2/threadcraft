use crate::model::{AppError, ChatMessage, ChatPage, Thread};
use crate::models::ModelOption;
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines},
    process::{Child, ChildStdout, Command},
    time::timeout,
};

const RPC_TIMEOUT: Duration = Duration::from_secs(15);

pub fn executable(home: &Path) -> PathBuf {
    if let Some(path) = std::env::var_os("TREADCRAFT_CODEX_BIN") {
        return PathBuf::from(path);
    }
    let name = if cfg!(windows) { "codex.exe" } else { "codex" };
    if let Some(paths) = std::env::var_os("PATH") {
        for path in std::env::split_paths(&paths) {
            let candidate = path.join(name);
            if candidate.is_file() {
                return candidate;
            }
        }
    }
    for candidate in [
        home.join(".cargo/bin").join(name),
        home.join(".local/bin").join(name),
        PathBuf::from("/opt/homebrew/bin/codex"),
        PathBuf::from("/usr/local/bin/codex"),
    ] {
        if candidate.is_file() {
            return candidate;
        }
    }
    PathBuf::from(name)
}

fn unavailable() -> AppError {
    AppError::SourceUnavailable("Codex に接続できません。CLI の導入・実行権限を確認してください。必要なら TREADCRAFT_CODEX_BIN に実行ファイルを指定してください。".into())
}

pub(crate) fn command(path: &Path) -> Command {
    let mut cmd = Command::new(path);
    cmd.kill_on_drop(true).stderr(Stdio::null());
    #[cfg(windows)]
    cmd.creation_flags(0x08000000);
    cmd
}

pub async fn list_threads(path: &Path, source: &str) -> Result<Vec<Thread>, AppError> {
    let (_sender, receiver) = tokio::sync::watch::channel(false);
    list_threads_with_cancel(path, source, receiver).await
}

pub(crate) async fn list_threads_with_cancel(
    path: &Path,
    source: &str,
    shutdown: tokio::sync::watch::Receiver<bool>,
) -> Result<Vec<Thread>, AppError> {
    match run_operation(path, Operation::Inventory(source), shutdown).await? {
        Response::Inventory(threads) => Ok(threads),
        _ => Err(AppError::UnsupportedVersion),
    }
}

enum Operation<'a> {
    Fork(&'a str),
    Models,
    Inventory(&'a str),
    Chat {
        thread_id: &'a str,
        cursor: Option<&'a str>,
    },
}
enum Response {
    Fork(RemoteThread),
    Models(Vec<ModelOption>),
    Inventory(Vec<Thread>),
    Chat(ChatPage),
}

pub async fn fork_thread(
    path: &Path,
    source: &str,
    thread_id: &str,
    shutdown: tokio::sync::watch::Receiver<bool>,
) -> Result<Thread, AppError> {
    match run_operation(path, Operation::Fork(thread_id), shutdown).await? {
        Response::Fork(thread) => Ok(Thread {
            id: serde_json::to_string(&(source, &thread.id)).map_err(|_| AppError::Storage)?,
            title: thread_title(thread.name.as_deref(), &thread.preview),
            created_at: thread.created_at,
            updated_at: thread.updated_at,
            cwd: thread.cwd,
            archived: false,
            unread: false,
            group_id: None,
            position: 0,
        }),
        _ => Err(AppError::UnsupportedVersion),
    }
}

pub async fn list_models(
    path: &Path,
    shutdown: tokio::sync::watch::Receiver<bool>,
) -> Result<Vec<ModelOption>, AppError> {
    match run_operation(path, Operation::Models, shutdown).await? {
        Response::Models(models) => Ok(models),
        _ => Err(AppError::UnsupportedVersion),
    }
}

pub(crate) async fn model_catalog(
    child: &mut Child,
    lines: &mut Lines<BufReader<ChildStdout>>,
) -> Result<Vec<ModelOption>, AppError> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct ModelPage {
        data: Vec<ModelOption>,
        next_cursor: Option<String>,
    }
    let mut models = Vec::new();
    let mut cursor: Option<String> = None;
    let mut cursors = HashSet::new();
    for id in 10..110 {
        let value = request(
            child,
            lines,
            id,
            "model/list",
            json!({"cursor":cursor,"limit":100,"includeHidden":false}),
        )
        .await?;
        let page: ModelPage =
            serde_json::from_value(value).map_err(|_| AppError::UnsupportedVersion)?;
        models.extend(page.data);
        cursor = page.next_cursor;
        let Some(next) = &cursor else {
            return Ok(models);
        };
        if !cursors.insert(next.clone()) {
            break;
        }
    }
    Err(AppError::SourceUnavailable(
        "モデル一覧のページングを完了できませんでした。".into(),
    ))
}

pub(crate) async fn read_chat(
    path: &Path,
    thread_id: &str,
    cursor: Option<&str>,
    shutdown: tokio::sync::watch::Receiver<bool>,
) -> Result<ChatPage, AppError> {
    match run_operation(path, Operation::Chat { thread_id, cursor }, shutdown).await? {
        Response::Chat(page) => Ok(page),
        _ => Err(AppError::UnsupportedVersion),
    }
}

async fn run_operation(
    path: &Path,
    operation: Operation<'_>,
    mut shutdown: tokio::sync::watch::Receiver<bool>,
) -> Result<Response, AppError> {
    if *shutdown.borrow() {
        return Err(unavailable());
    }
    // Older servers may silently ignore useStateDbOnly. Do not fall back to metadata repair.
    let version = tokio::select! {
        value = timeout(RPC_TIMEOUT, command(path).arg("--version").output()) => value,
        _ = shutdown.changed() => return Err(unavailable()),
    }
    .map_err(|_| unavailable())?
    .map_err(|_| unavailable())?;
    if !version.status.success() || !supported_version(&String::from_utf8_lossy(&version.stdout)) {
        return Err(AppError::UnsupportedVersion);
    }
    let mut child = command(path)
        .args(["app-server", "--listen", "stdio://"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .map_err(|_| unavailable())?;
    let output = child.stdout.take().ok_or_else(unavailable)?;
    let mut lines = BufReader::new(output).lines();
    let result = tokio::select! {
        value = timeout(
        Duration::from_secs(90),
        perform(&mut child, &mut lines, operation),
        ) => value,
        _ = shutdown.changed() => Ok(Err(unavailable())),
    }
    .map_err(|_| {
        AppError::SourceUnavailable(
            "一覧取得がタイムアウトしました。キャッシュを保持しています。".into(),
        )
    })
    .and_then(|v| v);
    // Every success/error/timeout path reaps only the child owned by this operation.
    let _ = child.kill().await;
    let _ = child.wait().await;
    result
}

async fn perform(
    child: &mut Child,
    lines: &mut Lines<BufReader<ChildStdout>>,
    operation: Operation<'_>,
) -> Result<Response, AppError> {
    request(child,lines,1,"initialize",json!({"clientInfo":{"name":"treadcraft","version":"0.1.0"},"capabilities":{"experimentalApi":true}})).await?;
    send(child, json!({"method":"initialized"})).await?;
    match operation {
        Operation::Fork(id) => {
            let result = request(child, lines, 2, "thread/fork", json!({"threadId":id,"ephemeral":false,"excludeTurns":true,"deferGoalContinuation":true})).await?;
            let fork: RemoteThread = serde_json::from_value(result["thread"].clone())
                .map_err(|_| AppError::UnsupportedVersion)?;
            if fork.id == id {
                return Err(AppError::UnsupportedVersion);
            }
            Ok(Response::Fork(fork))
        }
        Operation::Models => Ok(Response::Models(model_catalog(child, lines).await?)),
        Operation::Inventory(source) => {
            Ok(Response::Inventory(inventory(child, lines, source).await?))
        }
        Operation::Chat { thread_id, cursor } => {
            // Capture the watermark before fetching items, not afterwards: a later
            // update may not be part of the page the user actually receives.
            let observed = if cursor.is_none() {
                let metadata = request(
                    child,
                    lines,
                    2,
                    "thread/read",
                    json!({"threadId":thread_id,"includeTurns":false}),
                )
                .await?;
                Some(
                    metadata["thread"]["updatedAt"]
                        .as_i64()
                        .ok_or(AppError::UnsupportedVersion)?,
                )
            } else {
                None
            };
            let value = request(
                child,
                lines,
                3,
                "thread/items/list",
                json!({"threadId":thread_id,"cursor":cursor,"limit":100,"sortDirection":"desc"}),
            )
            .await?;
            let mut page = parse_chat_page(value)?;
            page.observed_updated_at = observed;
            page.messages.reverse();
            Ok(Response::Chat(page))
        }
    }
}

fn parse_chat_page(value: Value) -> Result<ChatPage, AppError> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct ItemsPage {
        data: Vec<Entry>,
        next_cursor: Option<String>,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Entry {
        turn_id: String,
        item: Value,
    }
    let page: ItemsPage =
        serde_json::from_value(value).map_err(|_| AppError::UnsupportedVersion)?;
    let messages = page
        .data
        .into_iter()
        .map(|entry| {
            let item = entry.item;
            let kind = item
                .get("type")
                .and_then(Value::as_str)
                .ok_or(AppError::UnsupportedVersion)?;
            let item_id = item
                .get("id")
                .and_then(Value::as_str)
                .ok_or(AppError::UnsupportedVersion)?;
            let (role, text) = match kind {
                "userMessage" => {
                    let content = item
                        .get("content")
                        .and_then(Value::as_array)
                        .ok_or(AppError::UnsupportedVersion)?;
                    let parts: Vec<String> = content
                        .iter()
                        .map(|part| match part.get("type").and_then(Value::as_str) {
                            Some("text") => part
                                .get("text")
                                .and_then(Value::as_str)
                                .unwrap_or("")
                                .to_owned(),
                            Some("image" | "localImage") => {
                                "[画像の添付 — このビューでは表示しません]".into()
                            }
                            Some("audio" | "localAudio") => {
                                "[音声の添付 — このビューでは再生しません]".into()
                            }
                            _ => "[テキスト以外の添付]".into(),
                        })
                        .collect();
                    ("user", parts.join("\n"))
                }
                "agentMessage" => (
                    "assistant",
                    item.get("text")
                        .and_then(Value::as_str)
                        .ok_or(AppError::UnsupportedVersion)?
                        .to_owned(),
                ),
                _ => ("activity", format!("{kind}（操作ログ・詳細は未表示）")),
            };
            Ok(ChatMessage {
                id: serde_json::to_string(&(entry.turn_id, item_id))
                    .map_err(|_| AppError::UnsupportedVersion)?,
                role: role.into(),
                text,
            })
        })
        .collect::<Result<Vec<_>, AppError>>()?;
    Ok(ChatPage {
        observed_updated_at: None,
        messages,
        next_cursor: page.next_cursor,
    })
}

pub(crate) fn supported_version(value: &str) -> bool {
    let Some(version) = value.split_whitespace().nth(1) else {
        return false;
    };
    let parts: Vec<_> = version.split('.').map(str::parse::<u32>).collect();
    matches!(parts.as_slice(),[Ok(major),Ok(minor),Ok(patch)] if (*major,*minor,*patch)>=(0,153,4))
}

pub(crate) async fn send(child: &mut Child, value: Value) -> Result<(), AppError> {
    let mut bytes = serde_json::to_vec(&value).map_err(|_| AppError::UnsupportedVersion)?;
    bytes.push(b'\n');
    child
        .stdin
        .as_mut()
        .ok_or_else(unavailable)?
        .write_all(&bytes)
        .await
        .map_err(|_| unavailable())
}

pub(crate) async fn request(
    child: &mut Child,
    lines: &mut Lines<BufReader<ChildStdout>>,
    id: u64,
    method: &str,
    params: Value,
) -> Result<Value, AppError> {
    timeout(RPC_TIMEOUT, async {
        send(child,json!({"id":id,"method":method,"params":params})).await?;
        loop {
            let line=lines.next_line().await.map_err(|_|unavailable())?.ok_or_else(unavailable)?;
            let response:Value=serde_json::from_str(&line).map_err(|_|AppError::UnsupportedVersion)?;
            if response.get("id")==Some(&json!(id)) {
                if let Some(error) = response.get("error") {
                    let detail: String = error["message"].as_str().unwrap_or("API request failed").chars().take(1000).collect();
                    return Err(AppError::SourceUnavailable(format!("Codex: {detail}")));
                }
                return response.get("result").cloned().ok_or(AppError::UnsupportedVersion);
            }
            // An inventory client never approves server-initiated actions.
            if response.get("method").is_some() && response.get("id").is_some() {
                send(child,json!({"id":response["id"],"error":{"code":-32601,"message":"Read-only client"}})).await?;
            }
        }
    }).await.map_err(|_|unavailable())?
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Page {
    data: Vec<RemoteThread>,
    next_cursor: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteThread {
    id: String,
    name: Option<String>,
    #[serde(default)]
    preview: String,
    created_at: i64,
    updated_at: i64,
    cwd: String,
}

fn thread_title(name: Option<&str>, preview: &str) -> String {
    if let Some(name) = name.filter(|name| !name.trim().is_empty()) {
        return name.to_owned();
    }
    let compact = preview.split_whitespace().collect::<Vec<_>>().join(" ");
    if compact.is_empty() {
        return "無題のスレッド".into();
    }
    let mut chars = compact.chars();
    let mut title: String = chars.by_ref().take(60).collect();
    if chars.next().is_some() {
        title.push('…');
    }
    title
}

async fn inventory(
    child: &mut Child,
    lines: &mut Lines<BufReader<ChildStdout>>,
    source: &str,
) -> Result<Vec<Thread>, AppError> {
    let mut threads = HashMap::new();
    let mut id = 2;
    // Query archived explicitly so archived threads disappear without losing their memberships.
    for archived in [false, true] {
        let mut cursor: Option<String> = None;
        let mut cursors = HashSet::new();
        loop {
            let response=request(child,lines,id,"thread/list",json!({"cursor":cursor,"limit":100,"sortKey":"created_at","sortDirection":"desc","archived":archived,"modelProviders":[],"sourceKinds":["cli","vscode","appServer"],"useStateDbOnly":true})).await?;
            id += 1;
            let page: Page =
                serde_json::from_value(response).map_err(|_| AppError::UnsupportedVersion)?;
            for t in page.data {
                let key = serde_json::to_string(&(source, &t.id))
                    .map_err(|_| AppError::UnsupportedVersion)?;
                let title = thread_title(t.name.as_deref(), &t.preview);
                threads.insert(
                    key.clone(),
                    Thread {
                        id: key,
                        title,
                        created_at: t.created_at,
                        updated_at: t.updated_at,
                        unread: false,
                        cwd: t.cwd,
                        archived,
                        group_id: None,
                        position: 0,
                    },
                );
            }
            cursor = page.next_cursor;
            let Some(ref next) = cursor else {
                break;
            };
            if !cursors.insert(next.clone()) || id > 1002 {
                return Err(AppError::SourceUnavailable(
                    "一覧のページングを完了できませんでした。".into(),
                ));
            }
        }
    }
    Ok(threads.into_values().collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    #[tokio::test]
    async fn lists_models_across_pages_without_resuming_threads() {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/chat-server.mjs");
        let (_sender, shutdown) = tokio::sync::watch::channel(false);
        let models = list_models(&path, shutdown).await.unwrap();
        assert_eq!(
            models.iter().map(|m| m.model.as_str()).collect::<Vec<_>>(),
            vec!["test-model", "plain-model"]
        );
    }
    #[test]
    fn chat_page_preserves_text_order_and_cursor() {
        let page = parse_chat_page(json!({"data":[
            {"turnId":"turn1","item":{"id":"u","type":"userMessage","content":[{"type":"text","text":"質問\nコード"},{"type":"localImage","path":"/private/image.png"}]}},
            {"turnId":"turn1","item":{"id":"a","type":"agentMessage","text":"回答"}}
        ],"nextCursor":"next"})).unwrap();
        assert_eq!(
            page.messages
                .iter()
                .map(|m| m.role.as_str())
                .collect::<Vec<_>>(),
            vec!["user", "assistant"]
        );
        assert!(page.messages[0].text.starts_with("質問\nコード"));
        assert!(!page.messages[0].text.contains("/private"));
        assert_eq!(page.next_cursor.as_deref(), Some("next"));
    }
    #[test]
    fn tool_output_is_not_exposed_as_assistant_text() {
        let page=parse_chat_page(json!({"data":[{"turnId":"t","item":{"id":"c","type":"commandExecution","aggregatedOutput":"private-output"}}]})).unwrap();
        assert_eq!(page.messages[0].role, "activity");
        assert!(!page.messages[0].text.contains("private-output"));
    }
    #[test]
    fn malformed_chat_response_is_not_treated_as_empty_history() {
        assert!(parse_chat_page(json!({"other":[]})).is_err());
    }
    #[test]
    fn repeated_item_ids_in_different_turns_have_distinct_keys() {
        let page = parse_chat_page(json!({"data":[
            {"turnId":"one","item":{"id":"same","type":"agentMessage","text":"1"}},
            {"turnId":"two","item":{"id":"same","type":"agentMessage","text":"2"}}
        ]}))
        .unwrap();
        assert_ne!(page.messages[0].id, page.messages[1].id);
    }
    #[test]
    fn refuses_versions_before_state_db_only_baseline() {
        assert!(!supported_version("codex-cli 0.100.0"));
        assert!(supported_version("codex-cli 0.153.4"));
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn forks_history_without_starting_a_turn() {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/chat-server.mjs");
        let (_shutdown, rx) = tokio::sync::watch::channel(false);
        let fork = fork_thread(&path, "source", "thread-test", rx).await.unwrap();
        assert_eq!(fork.id, serde_json::to_string(&("source", "forked-thread")).unwrap());
        assert_eq!(fork.title, "分岐元の会話");
    }

    #[test]
    fn untitled_threads_use_conversation_preview_but_preserve_explicit_names() {
        assert_eq!(
            thread_title(None, "  最初の相談\n続き  "),
            "最初の相談 続き"
        );
        assert_eq!(thread_title(Some("名前"), "相談"), "名前");
        assert_eq!(thread_title(Some(" "), "相談"), "相談");
        assert_eq!(thread_title(None, ""), "無題のスレッド");
        assert_eq!(
            thread_title(None, &"あ".repeat(61)),
            format!("{}…", "あ".repeat(60))
        );
    }

    #[test]
    fn parses_metadata_without_requiring_or_retaining_transcript() {
        let thread: RemoteThread = serde_json::from_value(
            json!({"id":"a","createdAt":1,"updatedAt":2,"cwd":"/test","preview":"not retained"}),
        )
        .unwrap();
        assert!(thread.name.is_none());
    }
}
