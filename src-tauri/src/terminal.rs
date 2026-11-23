use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::{
    collections::HashMap,
    io::{Read, Write},
    path::Path,
    sync::{Arc, Mutex},
};
use tauri::ipc::Channel;

#[derive(Clone, Default)]
pub(crate) struct Terminals(Arc<Mutex<Registry>>);
#[derive(Default)]
struct Registry {
    sessions: HashMap<String, Session>,
    shutting_down: bool,
}
struct Session {
    master: Box<dyn MasterPty + Send>,
    input: std::sync::mpsc::SyncSender<Vec<u8>>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}
impl Drop for Session {
    fn drop(&mut self) {
        let _ = self.killer.kill();
    }
}
#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub(crate) enum TerminalEvent {
    Data { bytes: Vec<u8> },
    Exit,
    Error { message: String },
}
fn size(cols: u16, rows: u16) -> Result<PtySize, String> {
    if !(2..=500).contains(&cols) || !(1..=200).contains(&rows) {
        return Err("ターミナルのサイズが不正です。".into());
    }
    Ok(PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    })
}
impl Terminals {
    pub fn open(
        &self,
        cwd: &str,
        cols: u16,
        rows: u16,
        emit: impl Fn(TerminalEvent) -> bool + Send + Sync + 'static,
    ) -> Result<String, String> {
        let path = Path::new(cwd);
        if !path.is_absolute() || !path.is_dir() {
            return Err(
                "作業フォルダが存在しません。スレッドの作業フォルダを確認してください。".into(),
            );
        }
        let mut registry = self
            .0
            .lock()
            .map_err(|_| "ターミナルの状態を取得できません。")?;
        if registry.shutting_down || registry.sessions.len() >= 4 {
            return Err("ターミナルを起動できません。既存のターミナルを終了してください。".into());
        }
        let pair = native_pty_system()
            .openpty(size(cols, rows)?)
            .map_err(|e| e.to_string())?;
        let mut command = CommandBuilder::new_default_prog();
        command.cwd(path);
        command.env("TERM", "xterm-256color");
        let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
        let mut writer = pair.master.take_writer().map_err(|e| e.to_string())?;
        let mut child = pair
            .slave
            .spawn_command(command)
            .map_err(|e| format!("シェルを起動できません: {e}"))?;
        drop(pair.slave);
        let id = uuid::Uuid::new_v4().to_string();
        let (input, receiver) = std::sync::mpsc::sync_channel::<Vec<u8>>(32);
        registry.sessions.insert(
            id.clone(),
            Session {
                master: pair.master,
                input,
                killer: child.clone_killer(),
            },
        );
        drop(registry);
        let emit = Arc::new(emit);
        let writer_emit = Arc::clone(&emit);
        std::thread::spawn(move || {
            for bytes in receiver {
                if let Err(error) = writer.write_all(&bytes).and_then(|_| writer.flush()) {
                    writer_emit(TerminalEvent::Error {
                        message: format!("入力を送信できません: {error}"),
                    });
                    break;
                }
            }
        });
        let owner = self.clone();
        let read_id = id.clone();
        std::thread::spawn(move || {
            let mut buffer = [0; 8192];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(n) => {
                        if !emit(TerminalEvent::Data {
                            bytes: buffer[..n].to_vec(),
                        }) {
                            break;
                        }
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                    // PTYs on some platforms report EIO when the slave closes.
                    Err(_) => break,
                }
            }
            let _ = owner.close(&read_id);
            emit(TerminalEvent::Exit);
        });
        let owner = self.clone();
        let wait_id = id.clone();
        std::thread::spawn(move || {
            let _ = child.wait();
            let _ = owner.close(&wait_id);
        });
        Ok(id)
    }
    pub fn write(&self, id: &str, bytes: Vec<u8>) -> Result<(), String> {
        if bytes.len() > 4096 {
            return Err("入力は4096バイト以下で送信してください。".into());
        }
        let registry = self
            .0
            .lock()
            .map_err(|_| "ターミナルの状態を取得できません。")?;
        let session = registry
            .sessions
            .get(id)
            .ok_or("ターミナルは終了しています。")?;
        session
            .input
            .try_send(bytes)
            .map_err(|_| "入力が混み合っています。少し待って再入力してください。".into())
    }
    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let registry = self
            .0
            .lock()
            .map_err(|_| "ターミナルの状態を取得できません。")?;
        registry
            .sessions
            .get(id)
            .ok_or("ターミナルは終了しています。")?
            .master
            .resize(size(cols, rows)?)
            .map_err(|e| e.to_string())
    }
    pub fn close(&self, id: &str) -> Result<(), String> {
        self.0
            .lock()
            .map_err(|_| "ターミナルの状態を取得できません。")?
            .sessions
            .remove(id);
        Ok(())
    }
    pub fn shutdown(&self) {
        if let Ok(mut registry) = self.0.lock() {
            registry.shutting_down = true;
            registry.sessions.clear();
        }
    }
}
fn authorize(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() != "main" {
        return Err("許可されていないウィンドウです。".into());
    }
    Ok(())
}
#[tauri::command]
pub(crate) async fn terminal_open(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Terminals>,
    cwd: String,
    cols: u16,
    rows: u16,
    on_event: Channel<TerminalEvent>,
) -> Result<String, String> {
    authorize(&window)?;
    let terminals = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        terminals.open(&cwd, cols, rows, move |event| on_event.send(event).is_ok())
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub(crate) fn terminal_write(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Terminals>,
    id: String,
    bytes: Vec<u8>,
) -> Result<(), String> {
    authorize(&window)?;
    state.write(&id, bytes)
}
#[tauri::command]
pub(crate) fn terminal_resize(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Terminals>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    authorize(&window)?;
    state.resize(&id, cols, rows)
}
#[tauri::command]
pub(crate) fn terminal_close(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Terminals>,
    id: String,
) -> Result<(), String> {
    authorize(&window)?;
    state.close(&id)
}
