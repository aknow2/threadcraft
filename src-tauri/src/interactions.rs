use crate::model::AppError;
use serde_json::{json, Value};

pub fn supported(method: &str) -> bool {
    matches!(
        method,
        "item/commandExecution/requestApproval"
            | "item/fileChange/requestApproval"
            | "item/permissions/requestApproval"
            | "item/tool/requestUserInput"
            | "mcpServer/elicitation/request"
    )
}

pub fn response(method: &str, params: &Value, answer: &Value) -> Result<Value, AppError> {
    let invalid = || AppError::Validation("回答の内容を確認してください。".into());
    let action = answer["action"].as_str().ok_or_else(invalid)?;
    match method {
        "item/commandExecution/requestApproval" | "item/fileChange/requestApproval" => {
            if !matches!(action, "accept" | "decline" | "cancel") {
                return Err(invalid());
            }
            if let Some(allowed) = params["availableDecisions"].as_array() {
                if !allowed.iter().any(|value| value == action) {
                    return Err(invalid());
                }
            }
            Ok(json!({"decision":action}))
        }
        "item/permissions/requestApproval" => {
            if !matches!(action, "accept" | "decline") {
                return Err(invalid());
            }
            let mut permissions = serde_json::Map::new();
            if action == "accept" {
                for key in ["network", "fileSystem"] {
                    if let Some(value) = params["permissions"]
                        .get(key)
                        .filter(|value| !value.is_null())
                    {
                        permissions.insert(key.to_owned(), value.clone());
                    }
                }
            }
            Ok(json!({"permissions":permissions,"scope":"turn"}))
        }
        "item/tool/requestUserInput" => {
            if action == "cancel" {
                return Ok(json!({"answers":{}}));
            }
            if action != "answer" {
                return Err(invalid());
            }
            let mut answers = serde_json::Map::new();
            for question in params["questions"].as_array().ok_or_else(invalid)? {
                let id = question["id"].as_str().ok_or_else(invalid)?;
                let text = answer["answers"][id]
                    .as_str()
                    .filter(|text| !text.trim().is_empty() && text.len() <= 32_000)
                    .ok_or_else(invalid)?;
                answers.insert(id.to_owned(), json!({"answers":[text]}));
            }
            Ok(json!({"answers":answers}))
        }
        "mcpServer/elicitation/request" => {
            if !matches!(action, "accept" | "decline" | "cancel") {
                return Err(invalid());
            }
            let content = if action == "accept" && params["mode"] != "url" {
                let content = &answer["content"];
                validate_form(&params["requestedSchema"], content)?;
                content.clone()
            } else {
                Value::Null
            };
            Ok(json!({"action":action,"content":content,"_meta":null}))
        }
        _ => Err(invalid()),
    }
}

// Only expose forms whose fields we can validate and render faithfully.
pub fn form_supported(schema: &Value) -> bool {
    schema["type"] == "object"
        && schema["properties"].as_object().is_some_and(|properties| {
            properties.values().all(|field| {
                matches!(
                    field["type"].as_str(),
                    Some("string" | "boolean" | "number" | "integer")
                ) && [
                    "oneOf",
                    "anyOf",
                    "allOf",
                    "pattern",
                    "format",
                    "not",
                    "$ref",
                    "multipleOf",
                    "exclusiveMinimum",
                    "exclusiveMaximum",
                ]
                .iter()
                .all(|key| field.get(key).is_none())
            })
        })
}
fn validate_form(schema: &Value, content: &Value) -> Result<(), AppError> {
    let invalid =
        || AppError::Validation("フォームの必須項目・入力内容を確認してください。".into());
    if !form_supported(schema) {
        return Err(invalid());
    }
    let fields = schema["properties"].as_object().ok_or_else(invalid)?;
    let values = content.as_object().ok_or_else(invalid)?;
    if values.keys().any(|key| !fields.contains_key(key)) {
        return Err(invalid());
    }
    for (key, field) in fields {
        let required = schema["required"]
            .as_array()
            .is_some_and(|items| items.iter().any(|item| item == key));
        let Some(value) = values.get(key) else {
            if required {
                return Err(invalid());
            } else {
                continue;
            }
        };
        let valid = match field["type"].as_str() {
            Some("string") => value.as_str().is_some_and(|text| {
                let len = text.chars().count() as u64;
                len <= 32_000
                    && (!required || !text.is_empty())
                    && field["minLength"].as_u64().is_none_or(|min| len >= min)
                    && field["maxLength"].as_u64().is_none_or(|max| len <= max)
            }),
            Some("boolean") => value.is_boolean(),
            Some("integer") => value.as_i64().is_some() || value.as_u64().is_some(),
            Some("number") => value.is_number(),
            _ => false,
        };
        if !valid
            || field["enum"]
                .as_array()
                .is_some_and(|items| !items.contains(value))
        {
            return Err(invalid());
        }
        if let Some(n) = value.as_f64() {
            if field["minimum"].as_f64().is_some_and(|min| n < min)
                || field["maximum"].as_f64().is_some_and(|max| n > max)
            {
                return Err(invalid());
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn approval_obeys_available_decisions_and_does_not_grant_extra_permissions() {
        assert!(response("item/commandExecution/requestApproval", &json!({"availableDecisions":["decline"]}), &json!({"action":"accept"})).is_err());
        assert_eq!(response("item/permissions/requestApproval", &json!({"permissions":{"network":{"enabled":true},"fileSystem":null}}), &json!({"action":"accept","permissions":{"fileSystem":{"write":["/"]}}})).unwrap(), json!({"permissions":{"network":{"enabled":true}},"scope":"turn"}));
        assert_eq!(response("item/fileChange/requestApproval", &json!({}), &json!({"action":"decline"})).unwrap(), json!({"decision":"decline"}));
    }
    #[test]
    fn questions_require_answers_and_preserve_question_ids() {
        let params = json!({"questions":[{"id":"color"}]});
        assert!(response("item/tool/requestUserInput", &params, &json!({"action":"answer","answers":{}})).is_err());
        assert_eq!(response("item/tool/requestUserInput", &params, &json!({"action":"answer","answers":{"color":"青"}})).unwrap(), json!({"answers":{"color":{"answers":["青"]}}}));
    }
}
