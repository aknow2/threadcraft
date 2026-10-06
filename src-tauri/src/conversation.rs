use crate::models::SendOptions;
use crate::{codex, model::AppError};
use serde::Serialize;
use serde_json::{json, Value};
use std::{path::Path, process::Stdio, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, BufReader, Lines},
    process::{Child, ChildStdout},
    sync::watch,
    time::timeout,
};

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub(crate) enum ChatEvent {
    Ready,
    Request {
        id: String,
        method: String,
        params: Value,
    },
    RequestClosed {
        id: String,
    },
    Created {
        id: String,
    },
    CreationAbandoned,
    Delta {
        id: String,
        text: String,
    },
    Message {
        id: String,
        text: String,
    },
}

fn error(message: &str) -> AppError {
    AppError::SourceUnavailable(message.into())
}

pub(crate) fn validate(text: &str) -> Result<(), AppError> {
    if text.trim().is_empty() || text.chars().count() > 32_000 {
        return Err(AppError::Validation(
            "メッセージは 1〜32,000 文字で入力してください。".into(),
        ));
    }
    Ok(())
}

pub(crate) fn validate_input(text: &str, images: &[String]) -> Result<(), AppError> {
    if images.is_empty() {
        return validate(text);
    }
    if text.chars().count() > 32_000 || images.len() > 4 {
        return Err(AppError::Validation(
            "画像は4枚まで、メッセージは32,000文字までです。".into(),
        ));
    }
    for image in images {
        let valid = ["png", "jpeg", "webp", "gif"].iter().any(|kind| {
            image
                .strip_prefix(&format!("data:image/{kind};base64,"))
                .is_some_and(|data| {
                    !data.is_empty()
                        && data.len() <= 6_990_508
                        && data.len() % 4 == 0
                        && data.bytes().all(|b| {
                            b.is_ascii_alphanumeric() || b == b'+' || b == b'/' || b == b'='
                        })
                })
        });
        if !valid {
            return Err(AppError::Validation(
                "画像は1枚5MB以下のPNG・JPEG・WebP・GIFを指定してください。".into(),
            ));
        }
    }
    Ok(())
}

fn user_input(text: &str, images: &[String]) -> Vec<Value> {
    let mut input = Vec::new();
    if !text.trim().is_empty() {
        input.push(json!({"type":"text","text":text}));
    }
    input.extend(images.iter().map(|url| json!({"type":"image","url":url})));
    input
}

// A new owned connection per turn. Never retry turn/start: a lost response may
// mean the message was already accepted and replaying it would duplicate it.
pub(crate) struct MessageRequest<'a> {
    pub controls: Option<tokio::sync::mpsc::Receiver<crate::active_sends::SteerRequest>>,
    pub thread: &'a str,
    pub new_workspace: Option<&'a str>,
    pub text: &'a str,
    pub images: &'a [String],
    pub options: &'a SendOptions,
}

pub(crate) async fn run(
    path: &Path,
    message: MessageRequest<'_>,
    stop: watch::Receiver<bool>,
    shutdown: watch::Receiver<bool>,
    emit: impl Fn(ChatEvent) -> Result<(), AppError>,
) -> Result<String, AppError> {
    let mut attempted = false;
    let creating = message.new_workspace.is_some();
    let result = run_inner(path, message, stop, shutdown, &emit, &mut attempted).await;
    if creating && !attempted {
        // No turn was written: a stopped or failed preparation can safely start afresh.
        emit(ChatEvent::CreationAbandoned)?;
    }
    result.map_err(|error| classify_send_error(error, attempted))
}

fn classify_send_error(error: AppError, attempted: bool) -> AppError {
    if attempted {
        return error;
    }
    let detail = error.to_string();
    // Only classify this observed server message before turn/start. Do not infer
    // delivery from a missing frontend event or from errors after writing begins.
    if matches!(error, AppError::ThreadInUse(_)) || detail.contains("already has an active writer")
    {
        AppError::ThreadInUse(detail)
    } else {
        AppError::ChatNotSent(detail)
    }
}

async fn run_inner(
    path: &Path,
    mut message: MessageRequest<'_>,
    mut stop: watch::Receiver<bool>,
    mut shutdown: watch::Receiver<bool>,
    emit: impl Fn(ChatEvent) -> Result<(), AppError>,
    attempted: &mut bool,
) -> Result<String, AppError> {
    validate_input(message.text, message.images)?;
    let mut active_thread = message.thread.to_owned();
    if *stop.borrow() || *shutdown.borrow() {
        return Ok("interrupted".into());
    }
    let version = timeout(
        Duration::from_secs(15),
        codex::command(path).arg("--version").output(),
    )
    .await
    .map_err(|_| error("Codex の起動がタイムアウトしました。"))?
    .map_err(|_| error("Codex CLI を起動できません。"))?;
    if !version.status.success()
        || !codex::supported_version(&String::from_utf8_lossy(&version.stdout))
    {
        return Err(AppError::UnsupportedVersion);
    }
    let mut child = codex::command(path)
        .args(["app-server", "--listen", "stdio://"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .map_err(|_| error("Codex に接続できません。"))?;
    let output = child
        .stdout
        .take()
        .ok_or_else(|| error("Codex の応答を取得できません。"))?;
    let mut lines = BufReader::new(output).lines();
    let mut controls = message.controls.take();
    let mut turn = None;
    let result = tokio::select! {
        result = exchange(&mut child, &mut lines, &message, &mut active_thread, &mut turn, &emit, attempted, &mut controls) => result,
        _ = stop.changed() => Ok("interrupted".into()),
        _ = shutdown.changed() => Ok("interrupted".into()),
    };
    let thread = active_thread.as_str();
    // Interrupt our turn only, then allow the server to persist its terminal state.
    if !matches!(&result, Ok(status) if status == "completed" || status == "failed") {
        if let Some(turn) = turn {
            let _ = timeout(Duration::from_secs(5), async {
                codex::send(&mut child, json!({"id":4,"method":"turn/interrupt","params":{"threadId":thread,"turnId":turn}})).await?;
                loop {
                    let value = next(&mut lines).await?;
                    if value["method"] == "turn/completed" && value["params"]["threadId"] == thread && value["params"]["turn"]["id"] == turn { return Ok::<_,AppError>(()); }
                }
            }).await;
        }
    }
    let _ = child.kill().await;
    let _ = child.wait().await;
    result
}

async fn next(lines: &mut Lines<BufReader<ChildStdout>>) -> Result<Value, AppError> {
    let line = lines
        .next_line()
        .await
        .map_err(|_| error("Codex との接続が切れました。"))?
        .ok_or_else(|| error("Codex が終了しました。ログイン状態と利用上限を確認してください。"))?;
    serde_json::from_str(&line).map_err(|_| AppError::UnsupportedVersion)
}

async fn exchange(
    child: &mut Child,
    lines: &mut Lines<BufReader<ChildStdout>>,
    message: &MessageRequest<'_>,
    active_thread: &mut String,
    turn: &mut Option<String>,
    emit: &impl Fn(ChatEvent) -> Result<(), AppError>,
    attempted: &mut bool,
    controls: &mut Option<tokio::sync::mpsc::Receiver<crate::active_sends::SteerRequest>>,
) -> Result<String, AppError> {
    codex::request(child, lines, 1, "initialize", json!({"clientInfo":{"name":"treadcraft","version":"0.1.0"},"capabilities":{"experimentalApi":true}})).await?;
    codex::send(child, json!({"method":"initialized"})).await?;
    let thread = message.thread;
    let text = message.text;
    let options = message.options;
    if options.model.is_some() || options.effort.is_some() {
        options.validate(&codex::model_catalog(child, lines).await?)?;
    }
    let mut resume_params = json!({
        "threadId":thread,"excludeTurns":true,"sandbox":options.permission,
        "approvalPolicy":"on-request","approvalsReviewer":"user"
    });
    if let Some(model) = &options.model {
        resume_params["model"] = json!(model);
    }
    let resumed = if let Some(cwd) = message.new_workspace {
        resume_params.as_object_mut().unwrap().remove("threadId");
        resume_params
            .as_object_mut()
            .unwrap()
            .remove("excludeTurns");
        resume_params["cwd"] = json!(cwd);
        resume_params["ephemeral"] = json!(false);
        let value = codex::request(child, lines, 2, "thread/start", resume_params).await?;
        *active_thread = value["thread"]["id"]
            .as_str()
            .ok_or(AppError::UnsupportedVersion)?
            .to_owned();
        // Persist the mapping before attempting a turn; retries must never create a second conversation.
        emit(ChatEvent::Created {
            id: active_thread.clone(),
        })?;
        value
    } else {
        codex::request(child, lines, 2, "thread/resume", resume_params).await?
    };
    let thread = active_thread.as_str();
    if resumed["thread"]["status"]["type"] == "active" {
        return Err(AppError::ThreadInUse("このスレッドは実行中です。".into()));
    }
    let cwd = resumed["thread"]["cwd"]
        .as_str()
        .filter(|cwd| std::path::Path::new(cwd).is_absolute())
        .ok_or(AppError::UnsupportedVersion)?;
    let sandbox_policy = match options.permission {
        crate::models::Permission::ReadOnly => json!({"type":"readOnly","networkAccess":false}),
        crate::models::Permission::WorkspaceWrite => {
            json!({"type":"workspaceWrite","writableRoots":[cwd],"networkAccess":false,
                "excludeTmpdirEnvVar":false,"excludeSlashTmp":false})
        }
        crate::models::Permission::DangerFullAccess => json!({"type":"dangerFullAccess"}),
    };
    let mut params = json!({
        "threadId":thread,"input":user_input(text, message.images),
        "approvalPolicy":"on-request","approvalsReviewer":"user",
        "sandboxPolicy":sandbox_policy,
        "environments":[{"environmentId":"local","cwd":cwd}]
    });
    if let Some(model) = &options.model {
        params["model"] = json!(model);
    }
    if let Some(effort) = &options.effort {
        params["effort"] = json!(effort);
    }
    *attempted = true;
    codex::send(child, json!({"id":3,"method":"turn/start","params":params})).await?;
    let start_deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    let mut next_request = 1000u64;
    let mut pending = std::collections::HashMap::new();
    let mut interactions: std::collections::HashMap<String, Value> =
        std::collections::HashMap::new();
    let mut file_changes: std::collections::HashMap<String, Value> =
        std::collections::HashMap::new();
    loop {
        let value = tokio::select! {
          request = async {
            match controls.as_mut() {
              Some(rx) => rx.recv().await,
              None => std::future::pending().await,
            }
          } => {
            let Some(request) = request else { *controls = None; continue; };
            if request.reply.is_closed() { continue; }
            if let Some((id, answer)) = request.response {
                let Some(original) = interactions.get(&id) else {
                    let _ = request.reply.send(Err(AppError::Validation("この確認はすでに終了しています。".into())));
                    continue;
                };
                let result = match crate::interactions::response(original["method"].as_str().unwrap_or(""), &original["params"], &answer) {
                    Ok(result) => result,
                    Err(error) => { let _ = request.reply.send(Err(error)); continue; }
                };
                codex::send(child, json!({"id":original["id"],"result":result})).await?;
                interactions.remove(&id);
                emit(ChatEvent::RequestClosed { id })?;
                let _ = request.reply.send(Ok(()));
                continue;
            }
            let Some(current) = turn.as_deref() else {
              let _ = request.reply.send(Err(AppError::ChatNotSent("まだ応答が始まっていません。".into())));
              continue;
            };
            let id = next_request;
            next_request += 1;
            codex::send(child, json!({"id":id,"method":"turn/steer","params":{
              "threadId":thread,"expectedTurnId":current,
              "input":user_input(&request.text, &request.images)
            }})).await?;
            pending.insert(id, request.reply);
            continue;
          },
          value = async { let value = if turn.is_none() {
            tokio::time::timeout_at(start_deadline, next(lines))
                .await
                .map_err(|_| {
                    error("送信結果を確認できませんでした。再送信前に履歴を確認してください。")
                })??
        } else {
            if interactions.is_empty() {
                timeout(Duration::from_secs(600), next(lines)).await.map_err(|_| error("応答がタイムアウトしました。履歴を確認してください。"))??
            } else { next(lines).await? }
        }; Ok::<Value, AppError>(value) } => value?,
        };
        if value.get("method").is_none() {
            if let Some(reply) = value["id"].as_u64().and_then(|id| pending.remove(&id)) {
                let outcome = if let Some(reason) = value.get("error") {
                    Err(AppError::ChatNotSent(server_error(reason).to_string()))
                } else {
                    Ok(())
                };
                let _ = reply.send(outcome);
                continue;
            }
        }
        // Notifications can precede the turn/start response; process both in order.
        if value.get("method").is_some() && value.get("id").is_some() {
            let method = value["method"].as_str().unwrap_or("");
            let valid_thread = value["params"]["threadId"] == thread;
            let valid_turn = value["params"]["turnId"].is_null()
                || turn
                    .as_deref()
                    .is_some_and(|id| value["params"]["turnId"] == id);
            if crate::interactions::supported(method)
                && valid_thread
                && valid_turn
                && controls.is_some()
            {
                let id = uuid::Uuid::new_v4().to_string();
                let mut params = value["params"].clone();
                if let Some(changes) = params["itemId"]
                    .as_str()
                    .and_then(|item| file_changes.get(item))
                {
                    params["changes"] = changes.clone();
                }
                if method == "mcpServer/elicitation/request" {
                    params["formSupported"] = json!(crate::interactions::form_supported(
                        &params["requestedSchema"]
                    ));
                }
                emit(ChatEvent::Request {
                    id: id.clone(),
                    method: method.to_owned(),
                    params,
                })?;
                interactions.insert(id, value);
            } else {
                codex::send(child, json!({"id":value["id"],"error":{"code":-32601,"message":"Unsupported interactive request"}})).await?;
                if controls.is_none() {
                    return Err(error("承認要求に回答できる画面がありません。"));
                }
            }
            continue;
        }
        if value["method"] == "serverRequest/resolved" && value["params"]["threadId"] == thread {
            let ids: Vec<_> = interactions
                .iter()
                .filter(|(_, original)| original["id"] == value["params"]["requestId"])
                .map(|(id, _)| id.clone())
                .collect();
            for id in ids {
                interactions.remove(&id);
                emit(ChatEvent::RequestClosed { id })?;
            }
            continue;
        }
        if value["method"] == "item/started"
            && value["params"]["threadId"] == thread
            && value["params"]["item"]["type"] == "fileChange"
        {
            if let Some(id) = value["params"]["item"]["id"].as_str() {
                file_changes.insert(id.to_owned(), value["params"]["item"]["changes"].clone());
            }
        }

        if value.get("method").is_none() && value["id"] == 3 {
            if let Some(reason) = value.get("error") {
                return Err(server_error(reason));
            }
            let was_ready = turn.is_some();
            *turn = Some(
                value["result"]["turn"]["id"]
                    .as_str()
                    .ok_or(AppError::UnsupportedVersion)?
                    .into(),
            );
            if !was_ready {
                emit(ChatEvent::Ready)?;
            }
        }
        let params = &value["params"];
        if params["threadId"] != thread {
            continue;
        }
        if value["method"] == "turn/started" && turn.is_none() {
            *turn = params["turn"]["id"].as_str().map(str::to_owned);
            if turn.is_some() {
                emit(ChatEvent::Ready)?;
            }
        }
        let Some(current) = turn.as_deref() else {
            continue;
        };
        if value["method"] == "turn/completed" && params["turn"]["id"] == current {
            *turn = None;
            return match params["turn"]["status"].as_str() {
                Some("completed") => Ok("completed".into()),
                Some("interrupted") => Ok("interrupted".into()),
                Some("failed") => Err(server_error(&params["turn"]["error"])),
                _ => Err(AppError::UnsupportedVersion),
            };
        }
        if params["turnId"] != current {
            continue;
        }
        if let Some(event) = message_event(&value) {
            emit(event)?;
        }
    }
}

fn server_error(reason: &Value) -> AppError {
    let detail: String = reason["message"]
        .as_str()
        .unwrap_or("応答に失敗しました。ログイン状態・利用上限・ネットワークを確認してください。")
        .chars()
        .take(1000)
        .collect();
    error(&format!("Codex: {detail}"))
}

fn message_event(value: &Value) -> Option<ChatEvent> {
    let p = &value["params"];
    match value["method"].as_str()? {
        "item/agentMessage/delta" => Some(ChatEvent::Delta {
            id: p["itemId"].as_str()?.into(),
            text: p["delta"].as_str()?.into(),
        }),
        "item/completed" if p["item"]["type"] == "agentMessage" => Some(ChatEvent::Message {
            id: p["item"]["id"].as_str()?.into(),
            text: p["item"]["text"].as_str()?.into(),
        }),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    async fn run(
        path: &Path,
        thread: &str,
        text: &str,
        stop: watch::Receiver<bool>,
        shutdown: watch::Receiver<bool>,
        emit: impl Fn(ChatEvent) -> Result<(), AppError>,
    ) -> Result<String, AppError> {
        super::run(
            path,
            MessageRequest {
                controls: None,
                new_workspace: None,
                thread,
                text,
                images: &[],
                options: &SendOptions::default(),
            },
            stop,
            shutdown,
            emit,
        )
        .await
    }
    #[test]
    fn image_inputs_are_validated_and_forwarded_without_text() {
        let images = vec!["data:image/png;base64,aGVsbG8=".to_owned()];
        assert!(validate_input("", &images).is_ok());
        assert_eq!(
            user_input("", &images),
            vec![json!({"type":"image","url":images[0]})]
        );
        assert_eq!(user_input("describe", &images).len(), 2);
        assert!(validate_input("", &[]).is_err());
        assert!(validate_input("", &vec![images[0].clone(); 5]).is_err());
        assert!(validate_input("", &["https://example.com/image.png".into()]).is_err());
    }

    #[test]
    fn writer_conflict_before_start_is_unsent() {
        assert!(matches!(
            classify_send_error(error("thread test already has an active writer"), false),
            AppError::ThreadInUse(_)
        ));
    }
    #[test]
    fn preparation_failure_is_unsent() {
        assert!(matches!(
            classify_send_error(error("connection lost"), false),
            AppError::ChatNotSent(_)
        ));
    }
    #[test]
    fn errors_after_write_begins_do_not_claim_unsent() {
        assert!(matches!(
            classify_send_error(error("already has an active writer"), true),
            AppError::SourceUnavailable(_)
        ));
    }
    #[test]
    fn rejects_empty_input() {
        assert!(validate(" \n ").is_err());
    }
    #[test]
    fn rejects_oversized_input() {
        assert!(validate(&"あ".repeat(32_001)).is_err());
    }
    #[test]
    fn accepts_unicode_input() {
        assert!(validate("こんにちは").is_ok());
    }
    #[test]
    fn streams_text_not_reasoning() {
        assert!(message_event(
            &json!({"method":"item/reasoning/textDelta","params":{"delta":"private"}})
        )
        .is_none());
    }
    #[test]
    fn maps_final_message() {
        assert!(
            matches!(message_event(&json!({"method":"item/completed","params":{"item":{"type":"agentMessage","id":"a","text":"answer"}}})),Some(ChatEvent::Message {text,..}) if text=="answer")
        );
    }

    #[cfg(unix)]
    fn fixture() -> std::path::PathBuf {
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/chat-server.mjs")
    }

    #[tokio::test]
    async fn stopping_new_chat_before_send_keeps_it_available_for_retry() {
        let (_stop, rx) = watch::channel(true);
        let (_shutdown, shutdown) = watch::channel(false);
        let events = std::sync::Mutex::new(Vec::new());
        let result = super::run(
            Path::new("unused"),
            MessageRequest {
                controls: None,
                thread: "draft:local",
                new_workspace: Some("/new-workspace"),
                text: "hello",
                images: &[],
                options: &SendOptions::default(),
            },
            rx,
            shutdown,
            |event| {
                events.lock().unwrap().push(event);
                Ok(())
            },
        )
        .await
        .unwrap();
        assert_eq!(result, "interrupted");
        assert!(matches!(
            events.into_inner().unwrap().as_slice(),
            [ChatEvent::CreationAbandoned]
        ));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn creates_and_sends_first_message_on_same_connection() {
        let (_stop, rx) = watch::channel(false);
        let (_shutdown, shutdown) = watch::channel(false);
        let events = std::sync::Mutex::new(Vec::new());
        let result = super::run(
            &fixture(),
            MessageRequest {
                controls: None,
                thread: "draft:local",
                new_workspace: Some("/new-workspace"),
                text: "hello",
                images: &[],
                options: &SendOptions::default(),
            },
            rx,
            shutdown,
            |event| {
                events.lock().unwrap().push(event);
                Ok(())
            },
        )
        .await
        .unwrap();
        assert_eq!(result, "completed");
        let events = events.into_inner().unwrap();
        assert!(matches!(events.first(), Some(ChatEvent::Created { id }) if id == "thread-test"));
        assert!(events
            .iter()
            .any(|e| matches!(e, ChatEvent::Message { text, .. } if text == "こんにちは")));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn sends_image_only_turn_to_server() {
        let (_stop, rx) = watch::channel(false);
        let (_shutdown, shutdown) = watch::channel(false);
        let result = super::run(
            &fixture(),
            MessageRequest {
                controls: None,
                thread: "thread-test",
                new_workspace: None,
                text: "",
                images: &["data:image/png;base64,aGVsbG8=".into()],
                options: &SendOptions::default(),
            },
            rx,
            shutdown,
            |_| Ok(()),
        )
        .await
        .unwrap();
        assert_eq!(result, "completed");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn forwards_permissions_for_new_and_existing_threads() {
        use crate::models::Permission;
        for new_workspace in [None, Some("/new-workspace")] {
            for (permission, name) in [
                (Permission::ReadOnly, "read-only"),
                (Permission::WorkspaceWrite, "workspace-write"),
                (Permission::DangerFullAccess, "danger-full-access"),
            ] {
                let (_stop, rx) = watch::channel(false);
                let (_shutdown, shutdown) = watch::channel(false);
                let result = super::run(
                    &fixture(),
                    MessageRequest {
                        controls: None,
                        new_workspace,
                        thread: "thread-test",
                        images: &[],
                        text: &format!("permission:{name}"),
                        options: &SendOptions {
                            permission,
                            ..SendOptions::default()
                        },
                    },
                    rx,
                    shutdown,
                    |_| Ok(()),
                )
                .await
                .unwrap();
                assert_eq!(result, "completed");
            }
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn forwards_selected_model_and_effort_without_changing_sandbox() {
        let (_stop, rx) = watch::channel(false);
        let (_shutdown, shutdown) = watch::channel(false);
        let result = super::run(
            &fixture(),
            MessageRequest {
                controls: None,
                new_workspace: None,
                thread: "thread-test",
                text: "selected-model",
                images: &[],
                options: &SendOptions {
                    model: Some("test-model".into()),
                    effort: Some("high".into()),
                    ..SendOptions::default()
                },
            },
            rx,
            shutdown,
            |_| Ok(()),
        )
        .await
        .unwrap();
        assert_eq!(result, "completed");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn rejects_unavailable_selection_before_resume_or_send() {
        let (_stop, rx) = watch::channel(false);
        let (_shutdown, shutdown) = watch::channel(false);
        let result = super::run(
            &fixture(),
            MessageRequest {
                controls: None,
                new_workspace: None, // Fixture rejects this ID on resume, proving validation precedes it.
                thread: "must-not-resume",
                text: "hello",
                images: &[],
                options: &SendOptions {
                    model: Some("test-model".into()),
                    effort: Some("ultra".into()),
                    ..SendOptions::default()
                },
            },
            rx,
            shutdown,
            |_| panic!("must not send"),
        )
        .await;
        assert!(
            matches!(result, Err(AppError::ChatNotSent(detail)) if detail.contains("推論強度"))
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn resume_writer_conflict_returns_specific_unsent_error() {
        let (_stop, rx) = watch::channel(false);
        let (_shutdown, shutdown) = watch::channel(false);
        let result = run(&fixture(), "writer-conflict", "hello", rx, shutdown, |_| {
            panic!("No turn events should be emitted after resume rejection")
        })
        .await;
        assert!(matches!(result, Err(AppError::ThreadInUse(_))));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn processes_notifications_before_start_response_and_filters_other_threads() {
        let (_stop, rx) = watch::channel(false);
        let (_shutdown, shutdown) = watch::channel(false);
        let events = std::sync::Mutex::new(Vec::new());
        let result = run(&fixture(), "thread-test", "hello", rx, shutdown, |event| {
            events.lock().unwrap().push(event);
            Ok(())
        })
        .await
        .unwrap();
        assert_eq!(result, "completed");
        let events = events.into_inner().unwrap();
        let text: String = events
            .iter()
            .filter_map(|event| match event {
                ChatEvent::Delta { text, .. } => Some(text.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(text, "こんにちは");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn steers_on_the_owned_connection_without_resending_the_turn() {
        let (_stop, stop) = watch::channel(false);
        let (_shutdown, shutdown) = watch::channel(false);
        let (sender, controls) = tokio::sync::mpsc::channel(1);
        let (reply, result) = tokio::sync::oneshot::channel();
        let reply = std::sync::Mutex::new(Some(reply));
        let status = super::run(
            &fixture(),
            MessageRequest {
                controls: Some(controls),
                thread: "thread-test",
                new_workspace: None,
                text: "steer",
                images: &[],
                options: &SendOptions::default(),
            },
            stop,
            shutdown,
            |event| {
                if matches!(event, ChatEvent::Ready) {
                    sender
                        .try_send(crate::active_sends::SteerRequest {
                            response: None,
                            text: "追加指示".into(),
                            images: vec![],
                            reply: reply.lock().unwrap().take().unwrap(),
                        })
                        .unwrap();
                }
                Ok(())
            },
        )
        .await
        .unwrap();
        assert_eq!(status, "completed");
        assert!(result.await.unwrap().is_ok());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn stop_interrupts_owned_turn() {
        let (stop, rx) = watch::channel(false);
        let (_shutdown, shutdown) = watch::channel(false);
        let result = run(&fixture(), "thread-test", "stop", rx, shutdown, |event| {
            if matches!(event, ChatEvent::Ready) {
                stop.send_replace(true);
            }
            Ok(())
        })
        .await
        .unwrap();
        assert_eq!(result, "interrupted");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn approval_can_be_answered_without_ending_the_conversation() {
        let (_stop, stop) = watch::channel(false);
        let (_shutdown, shutdown) = watch::channel(false);
        let (sender, controls) = tokio::sync::mpsc::channel(1);
        let (reply, received) = tokio::sync::oneshot::channel();
        let reply = std::sync::Mutex::new(Some(reply));
        let result = super::run(&fixture(), MessageRequest { controls: Some(controls), thread: "thread-test", new_workspace: None, text: "approval", images: &[], options: &SendOptions::default() }, stop, shutdown, |event| {
            if let ChatEvent::Request { id, .. } = event {
                sender.try_send(crate::active_sends::SteerRequest { response: Some((id, json!({"action":"accept"}))), text: String::new(), images: vec![], reply: reply.lock().unwrap().take().unwrap() }).unwrap();
            }
            Ok(())
        }).await.unwrap();
        assert_eq!(result, "completed");
        assert!(received.await.unwrap().is_ok());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn approval_request_is_rejected_without_hanging() {
        let (_stop, rx) = watch::channel(false);
        let (_shutdown, shutdown) = watch::channel(false);
        let result = run(&fixture(), "thread-test", "approval", rx, shutdown, |_| {
            Ok(())
        })
        .await;
        assert!(matches!(result, Err(AppError::SourceUnavailable(text)) if text.contains("承認")));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn disconnect_is_not_reported_as_success() {
        let (_stop, rx) = watch::channel(false);
        let (_shutdown, shutdown) = watch::channel(false);
        assert!(run(
            &fixture(),
            "thread-test",
            "disconnect",
            rx,
            shutdown,
            |_| Ok(())
        )
        .await
        .is_err());
    }
}
