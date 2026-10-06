use serde::{Deserialize, Serialize};

#[derive(Debug, thiserror::Error, Serialize)]
#[serde(tag = "code", content = "message")]
pub enum AppError {
    #[error("{0}")]
    Validation(String),
    #[error("対象が見つかりません。再読み込みしてください。")]
    NotFound,
    #[error("分類が変更されています。再読み込みしてやり直してください。")]
    Conflict,
    #[error("保存に失敗しました。空き容量とアクセス権を確認してください。")]
    Storage,
    #[error("{0}")]
    SourceUnavailable(String),
    #[error("{0}")]
    ThreadInUse(String),
    #[error("{0}")]
    ChatNotSent(String),
    #[error("{0}")]
    EditorUnavailable(String),
    #[error("この Codex バージョンの応答に対応していません。")]
    UnsupportedVersion,
}

impl From<rusqlite::Error> for AppError {
    fn from(_: rusqlite::Error) -> Self {
        Self::Storage
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Thread {
    pub id: String,
    pub title: String,
    pub created_at: i64,
    #[serde(default)]
    pub updated_at: i64,
    #[serde(default)]
    pub unread: bool,
    pub cwd: String,
    pub archived: bool,
    pub group_id: Option<String>,
    pub position: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Group {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub id: String,
    pub role: String,
    pub text: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatPage {
    pub observed_updated_at: Option<i64>,
    pub messages: Vec<ChatMessage>,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Board {
    pub revision: i64,
    pub groups: Vec<Group>,
    pub threads: Vec<Thread>,
    pub last_sync: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Mutation {
    CreateGroup {
        name: String,
    },
    RenameGroup {
        id: String,
        name: String,
    },
    DeleteGroup {
        id: String,
    },
    MoveThread {
        id: String,
        group_id: Option<String>,
        before_id: Option<String>,
    },
    ReorderGroup {
        id: String,
        before_id: Option<String>,
    },
}
