mod active_sends;
mod attachments;
pub mod codex;
mod conversation;
mod editor;
mod interactions;
mod model;
mod models;
mod store;

use model::{AppError, Board, ChatPage, Mutation};
use std::{
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};
use store::Store;
use tauri::Manager;

struct State {
    store: Arc<Mutex<Store>>,
    refresh: tokio::sync::Mutex<()>,
    reading: tokio::sync::Mutex<()>,
    sending: tokio::sync::RwLock<()>,
    cancel: active_sends::ActiveSends,
    executable: std::path::PathBuf,
    source: String,
    shutdown: tokio::sync::watch::Sender<bool>,
}

async fn database<T: Send + 'static>(
    store: Arc<Mutex<Store>>,
    work: impl FnOnce(&mut Store) -> Result<T, AppError> + Send + 'static,
) -> Result<T, AppError> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut db = store.lock().map_err(|_| AppError::Storage)?;
        work(&mut db)
    })
    .await
    .map_err(|_| AppError::Storage)?
}

fn authorize(window: &tauri::WebviewWindow) -> Result<(), AppError> {
    if window.label() != "main" {
        return Err(AppError::Validation(
            "許可されていないウィンドウです。".into(),
        ));
    }
    Ok(())
}

#[tauri::command]
async fn get_board(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, State>,
) -> Result<Board, AppError> {
    authorize(&window)?;
    database(Arc::clone(&state.store), |s| s.board()).await
}

#[tauri::command]
async fn mutate_board(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, State>,
    expected_revision: i64,
    mutation: Mutation,
) -> Result<Board, AppError> {
    authorize(&window)?;
    database(Arc::clone(&state.store), move |s| {
        s.mutate(expected_revision, mutation)
    })
    .await
}

#[tauri::command]
async fn refresh_threads(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, State>,
) -> Result<Board, AppError> {
    authorize(&window)?;
    let Ok(_guard) = state.refresh.try_lock() else {
        return Err(AppError::SourceUnavailable(
            "同期はすでに実行中です。".into(),
        ));
    };
    if *state.shutdown.borrow() {
        return Err(AppError::SourceUnavailable("終了処理中です。".into()));
    }
    let threads = codex::list_threads_with_cancel(
        &state.executable,
        &state.source,
        state.shutdown.subscribe(),
    )
    .await?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| AppError::Storage)?
        .as_secs() as i64;
    database(Arc::clone(&state.store), move |s| s.sync(&threads, now)).await
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct CreatedThread {
    board: Board,
    thread_id: String,
}

#[tauri::command]
async fn create_thread(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, State>,
    cwd: String,
    group_id: Option<String>,
) -> Result<CreatedThread, AppError> {
    authorize(&window)?;
    let check_group = group_id.clone();
    database(Arc::clone(&state.store), move |s| {
        let board = s.board()?;
        if check_group.is_some_and(|id| !board.groups.iter().any(|g| g.id == id)) {
            return Err(AppError::NotFound);
        }
        Ok(())
    })
    .await?;
    let folder = tauri::async_runtime::spawn_blocking(move || editor::workspace(cwd.trim()))
        .await
        .map_err(|_| AppError::Storage)??;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| AppError::Storage)?
        .as_secs() as i64;
    let thread = model::Thread {
        id: serde_json::to_string(&(&state.source, format!("draft:{}", uuid::Uuid::new_v4())))
            .map_err(|_| AppError::Storage)?,
        title: "新しいチャット".into(),
        created_at: now,
        updated_at: now,
        unread: false,
        cwd: folder.to_string_lossy().into_owned(),
        archived: false,
        group_id: None,
        position: 0,
    };
    let thread_id = thread.id.clone();
    let board = database(Arc::clone(&state.store), move |s| {
        s.insert_thread(&thread, group_id.as_deref())
    })
    .await?;
    Ok(CreatedThread { board, thread_id })
}

#[tauri::command]
async fn fork_thread(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, State>,
    id: String,
) -> Result<CreatedThread, AppError> {
    authorize(&window)?;
    let _guard = state.refresh.lock().await;
    let _running = state.sending.read().await;
    if *state.shutdown.borrow() {
        return Err(AppError::Validation("終了処理中です。".into()));
    }
    let lookup = id.clone();
    let (remote, group) = database(Arc::clone(&state.store), move |store| {
        let board = store.board()?;
        let thread = board
            .threads
            .iter()
            .find(|thread| thread.id == lookup)
            .ok_or(AppError::NotFound)?;
        Ok((
            store.remote_id(&lookup)?.unwrap_or(lookup),
            thread.group_id.clone(),
        ))
    })
    .await?;
    let (source, raw): (String, String) =
        serde_json::from_str(&remote).map_err(|_| AppError::NotFound)?;
    if source != state.source || raw.starts_with("draft:") {
        return Err(AppError::Validation(
            "会話を開始してから分岐してください。".into(),
        ));
    }
    let thread = codex::fork_thread(
        &state.executable,
        &state.source,
        &raw,
        state.shutdown.subscribe(),
    )
    .await
    .map_err(|error| {
        AppError::SourceUnavailable(format!(
            "分岐結果を確認できませんでした。一覧を更新して確認してから再操作してください。{error}"
        ))
    })?;
    let thread_id = thread.id.clone();
    let board = database(Arc::clone(&state.store), move |store| {
        store.insert_thread(&thread, group.as_deref())
    })
    .await?;
    Ok(CreatedThread { board, thread_id })
}

#[tauri::command]
async fn read_thread(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, State>,
    id: String,
    cursor: Option<String>,
) -> Result<ChatPage, AppError> {
    authorize(&window)?;
    let _guard = state.reading.lock().await;
    if *state.shutdown.borrow() {
        return Err(AppError::SourceUnavailable("終了処理中です。".into()));
    }
    let (source, thread_id): (String, String) =
        serde_json::from_str(&id).map_err(|_| AppError::NotFound)?;
    if source != state.source {
        return Err(AppError::SourceUnavailable(
            "このスレッドは別の Codex 保存先にあります。".into(),
        ));
    }
    let lookup = id.clone();
    database(Arc::clone(&state.store), move |s| {
        s.board()?
            .threads
            .iter()
            .find(|t| t.id == lookup)
            .map(|t| t.updated_at)
            .ok_or(AppError::NotFound)
    })
    .await?;
    let thread_id = if thread_id.starts_with("draft:") {
        let lookup = id.clone();
        let remote = database(Arc::clone(&state.store), move |s| s.remote_id(&lookup)).await?;
        match remote {
            Some(remote) => {
                serde_json::from_str::<(String, String)>(&remote)
                    .map_err(|_| AppError::Storage)?
                    .1
            }
            None => {
                return Ok(ChatPage {
                    messages: vec![],
                    next_cursor: None,
                    observed_updated_at: None,
                })
            }
        }
    } else {
        thread_id
    };
    let page = codex::read_chat(
        &state.executable,
        &thread_id,
        cursor.as_deref(),
        state.shutdown.subscribe(),
    )
    .await?;
    if let Some(observed) = page.observed_updated_at {
        database(Arc::clone(&state.store), move |s| {
            s.observe_update(&id, observed)
        })
        .await?;
    }
    Ok(page)
}

#[tauri::command]
async fn mark_thread_read(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, State>,
    id: String,
    observed_updated_at: i64,
) -> Result<Board, AppError> {
    authorize(&window)?;
    database(Arc::clone(&state.store), move |s| {
        s.mark_read(&id, observed_updated_at)
    })
    .await
}

#[tauri::command]
async fn open_in_zed(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, State>,
    id: String,
) -> Result<(), AppError> {
    authorize(&window)?;
    let folder = database(Arc::clone(&state.store), move |store| {
        store.workspace_for_thread(&id)
    })
    .await?;
    editor::open_zed(folder).await
}

#[tauri::command]
async fn list_models(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, State>,
) -> Result<Vec<models::ModelOption>, AppError> {
    authorize(&window)?;
    let _guard = state.reading.lock().await;
    codex::list_models(&state.executable, state.shutdown.subscribe()).await
}

#[tauri::command]
async fn send_message(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, State>,
    id: String,
    text: String,
    options: Option<models::SendOptions>,
    images: Option<Vec<attachments::Attachment>>,
    on_event: tauri::ipc::Channel<conversation::ChatEvent>,
) -> Result<String, AppError> {
    authorize(&window)?;
    let images = images.unwrap_or_default();
    let folder = window.path().app_data_dir().map_err(|_| AppError::Storage)?;
    let (text, images) = tauri::async_runtime::spawn_blocking(move || {
        attachments::prepare(text, images, &folder.join("attachments"))
    })
    .await
    .map_err(|_| AppError::Storage)??;
    let _guard = state
        .sending
        .try_read()
        .map_err(|_| AppError::Validation("別の送信が実行中です。".into()))?;
    if *state.shutdown.borrow() {
        return Err(AppError::Validation("終了処理中です。".into()));
    }
    let (_active, receiver, controls) = state.cancel.begin(&id)?;
    let (source, raw_id): (String, String) =
        serde_json::from_str(&id).map_err(|_| AppError::NotFound)?;
    if source != state.source {
        return Err(AppError::NotFound);
    }
    let lookup = id.clone();
    let (cwd, remote) = database(Arc::clone(&state.store), move |s| {
        let board = s.board()?;
        let thread = board
            .threads
            .iter()
            .find(|t| t.id == lookup)
            .ok_or(AppError::NotFound)?;
        if thread.archived {
            return Err(AppError::Validation(
                "アーカイブ済みスレッドには送信できません。".into(),
            ));
        }
        Ok((thread.cwd.clone(), s.remote_id(&lookup)?))
    })
    .await?;
    let is_new = raw_id.starts_with("draft:") && remote.is_none();
    let raw_id = match remote {
        Some(remote) => {
            serde_json::from_str::<(String, String)>(&remote)
                .map_err(|_| AppError::Storage)?
                .1
        }
        None => raw_id,
    };
    let local_id = id.clone();
    let result = conversation::run(
        &state.executable,
        conversation::MessageRequest {
            controls: Some(controls),
            thread: &raw_id,
            new_workspace: is_new.then_some(cwd.as_str()),
            text: &text,
            images: &images,
            options: &options.unwrap_or_default(),
        },
        receiver,
        state.shutdown.subscribe(),
        |event| {
            if matches!(&event, conversation::ChatEvent::CreationAbandoned) {
                state
                    .store
                    .lock()
                    .map_err(|_| AppError::Storage)?
                    .unbind_remote(&local_id)?;
                return Ok(());
            }
            if let conversation::ChatEvent::Created { id: remote } = &event {
                let remote = serde_json::to_string(&(&state.source, remote))
                    .map_err(|_| AppError::Storage)?;
                state
                    .store
                    .lock()
                    .map_err(|_| AppError::Storage)?
                    .bind_remote(&local_id, &remote)?;
                return Ok(());
            }
            on_event.send(event).map_err(|_| {
                AppError::SourceUnavailable("チャット画面との接続が切れました。".into())
            })
        },
    )
    .await;
    result
}

#[tauri::command]
async fn steer_message(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, State>,
    id: String,
    text: String,
    images: Vec<attachments::Attachment>,
) -> Result<(), AppError> {
    authorize(&window)?;
    let folder = window.path().app_data_dir().map_err(|_| AppError::Storage)?;
    let (text, images) = tauri::async_runtime::spawn_blocking(move || {
        attachments::prepare(text, images, &folder.join("attachments"))
    })
    .await
    .map_err(|_| AppError::Storage)??;
    state.cancel.steer(&id, text, images).await
}

#[tauri::command]
async fn respond_to_request(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, State>,
    id: String,
    request_id: String,
    answer: serde_json::Value,
) -> Result<(), AppError> {
    authorize(&window)?;
    state.cancel.respond(&id, request_id, answer).await
}

#[tauri::command]
fn stop_message(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, State>,
    id: String,
) -> Result<(), AppError> {
    authorize(&window)?;
    state.cancel.stop(&id)
}

/// Starts the desktop app. Conversations are resumed only on explicit send.
pub fn run() -> Result<(), tauri::Error> {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_opener::Builder::new()
                .open_js_links_on_click(false)
                .build(),
        )
        .setup(|app| {
            let folder = app.path().app_data_dir()?;
            std::fs::create_dir_all(&folder)?;
            let home = app.path().home_dir()?;
            let source = std::env::var_os("CODEX_HOME")
                .map(std::path::PathBuf::from)
                .unwrap_or_else(|| home.join(".codex"));
            let source = source
                .canonicalize()
                .unwrap_or(source)
                .to_string_lossy()
                .into_owned();
            app.manage(State {
                store: Arc::new(Mutex::new(Store::open(&folder.join("board.sqlite"))?)),
                refresh: tokio::sync::Mutex::new(()),
                reading: tokio::sync::Mutex::new(()),
                sending: tokio::sync::RwLock::new(()),
                cancel: active_sends::ActiveSends::default(),
                executable: codex::executable(&home),
                source,
                shutdown: tokio::sync::watch::channel(false).0,
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_board,
            create_thread,
            fork_thread,
            mutate_board,
            refresh_threads,
            read_thread,
            mark_thread_read,
            open_in_zed,
            send_message,
            list_models,
            stop_message,
            steer_message,
            respond_to_request
        ])
        .build(tauri::generate_context!())?
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                let state = app.state::<State>();
                state.shutdown.send_replace(true);
                if state.refresh.try_lock().is_err()
                    || state.reading.try_lock().is_err()
                    || state.sending.try_write().is_err()
                {
                    api.prevent_exit();
                    let app = app.clone();
                    tauri::async_runtime::spawn(async move {
                        {
                            let state = app.state::<State>();
                            let _guard = state.refresh.lock().await;
                            let _reading_guard = state.reading.lock().await;
                            let _sending_guard = state.sending.write().await;
                        }
                        app.exit(0);
                    });
                }
            }
        });
    Ok(())
}
