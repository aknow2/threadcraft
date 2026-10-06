use crate::model::AppError;
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelOption {
    pub model: String,
    pub display_name: String,
    pub default_reasoning_effort: String,
    pub supported_reasoning_efforts: Vec<EffortOption>,
    pub is_default: bool,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EffortOption {
    pub reasoning_effort: String,
    pub description: String,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SendOptions {
    pub model: Option<String>,
    pub effort: Option<String>,
    #[serde(default)]
    pub permission: Permission,
}

#[derive(Debug, Default, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Permission {
    #[default]
    ReadOnly,
    WorkspaceWrite,
    DangerFullAccess,
}

impl SendOptions {
    pub fn validate(&self, models: &[ModelOption]) -> Result<(), AppError> {
        let invalid = || {
            AppError::Validation(
            "選択したモデルまたは推論強度を利用できません。モデル一覧を更新して選び直してください。".into(),
        )
        };
        match (&self.model, &self.effort) {
            (None, None) => Ok(()),
            (Some(model), None)
                if models
                    .iter()
                    .any(|m| m.model == *model && m.supported_reasoning_efforts.is_empty()) =>
            {
                Ok(())
            }
            (Some(model), Some(effort)) => {
                let available = models.iter().any(|m| {
                    m.model == *model
                        && m.supported_reasoning_efforts
                            .iter()
                            .any(|e| e.reasoning_effort == *effort)
                });
                if available {
                    Ok(())
                } else {
                    Err(invalid())
                }
            }
            _ => Err(invalid()),
        }
    }
}
