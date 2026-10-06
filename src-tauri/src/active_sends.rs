use crate::model::AppError;
use std::{collections::HashMap, sync::Mutex};
use tokio::sync::{mpsc, oneshot, watch};

pub struct SteerRequest {
    pub response: Option<(String, serde_json::Value)>,
    pub text: String,
    pub images: Vec<String>,
    pub reply: oneshot::Sender<Result<(), AppError>>,
}

struct Entry {
    stop: watch::Sender<bool>,
    steer: mpsc::Sender<SteerRequest>,
}

#[derive(Default)]
pub struct ActiveSends {
    entries: Mutex<HashMap<String, Entry>>,
}

pub struct ActiveSend<'a> {
    registry: &'a ActiveSends,
    id: String,
}

impl ActiveSends {
    pub fn begin(
        &self,
        id: &str,
    ) -> Result<
        (
            ActiveSend<'_>,
            watch::Receiver<bool>,
            mpsc::Receiver<SteerRequest>,
        ),
        AppError,
    > {
        let mut entries = self.entries.lock().map_err(|_| AppError::Storage)?;
        if entries.contains_key(id) {
            return Err(AppError::Validation(
                "このチャットはすでに実行中です。".into(),
            ));
        }
        let (sender, receiver) = watch::channel(false);
        let (steer, requests) = mpsc::channel(8);
        entries.insert(
            id.to_owned(),
            Entry {
                stop: sender,
                steer,
            },
        );
        Ok((
            ActiveSend {
                registry: self,
                id: id.to_owned(),
            },
            receiver,
            requests,
        ))
    }

    pub async fn steer(&self, id: &str, text: String, images: Vec<String>) -> Result<(), AppError> {
        let sender = self
            .entries
            .lock()
            .map_err(|_| AppError::Storage)?
            .get(id)
            .map(|entry| entry.steer.clone())
            .ok_or_else(|| {
                AppError::ChatNotSent("応答が終了しました。通常の送信を使ってください。".into())
            })?;
        let (reply, result) = oneshot::channel();
        sender
            .try_send(SteerRequest {
                response: None,
                text,
                images,
                reply,
            })
            .map_err(|_| AppError::ChatNotSent("追加指示を受け付けられません。".into()))?;
        result.await.map_err(|_| {
            AppError::SourceUnavailable(
                "追加指示の送信結果を確認できません。再送前に履歴を確認してください。".into(),
            )
        })?
    }

    pub async fn respond(
        &self,
        id: &str,
        request_id: String,
        answer: serde_json::Value,
    ) -> Result<(), AppError> {
        let sender = self
            .entries
            .lock()
            .map_err(|_| AppError::Storage)?
            .get(id)
            .map(|entry| entry.steer.clone())
            .ok_or_else(|| AppError::Validation("この会話は終了しています。".into()))?;
        let (reply, result) = oneshot::channel();
        sender
            .try_send(SteerRequest {
                response: Some((request_id, answer)),
                text: String::new(),
                images: vec![],
                reply,
            })
            .map_err(|_| {
                AppError::Validation("回答を送れませんでした。もう一度お試しください。".into())
            })?;
        result.await.map_err(|_| {
            AppError::SourceUnavailable(
                "回答の送信結果を確認できません。履歴を確認してください。".into(),
            )
        })?
    }

    pub fn stop(&self, id: &str) -> Result<(), AppError> {
        if let Some(sender) = self.entries.lock().map_err(|_| AppError::Storage)?.get(id) {
            sender.stop.send_replace(true);
        }
        Ok(())
    }
}

impl Drop for ActiveSend<'_> {
    fn drop(&mut self) {
        if let Ok(mut entries) = self.registry.entries.lock() {
            entries.remove(&self.id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn separate_threads_can_run_and_stop_independently() {
        let registry = ActiveSends::default();
        let (first, first_rx, _first_commands) = registry.begin("first").unwrap();
        let (_second, second_rx, _second_commands) = registry.begin("second").unwrap();
        assert!(registry.begin("first").is_err());
        registry.stop("first").unwrap();
        assert!(*first_rx.borrow());
        assert!(!*second_rx.borrow());
        drop(first);
        let (_retry, retry_rx, _retry_commands) = registry.begin("first").unwrap();
        assert!(!*retry_rx.borrow());
        assert!(registry.begin("second").is_err());
    }

    #[test]
    fn early_return_releases_only_its_registration() {
        let registry = ActiveSends::default();
        let (_other, _, _) = registry.begin("other").unwrap();
        let result: Result<(), AppError> = (|| {
            let (_guard, _, _) = registry.begin("failed")?;
            Err(AppError::NotFound)
        })();
        assert!(result.is_err());
        assert!(registry.begin("failed").is_ok());
        assert!(registry.begin("other").is_err());
        registry.stop("unknown").unwrap();
    }
}
