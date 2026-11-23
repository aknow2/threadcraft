use crate::model::AppError;
use serde_json::{json, Value};

pub fn supported(method: &str) -> bool {
    matches!(
        method,
        "item/commandExecution/requestApproval"
            | "item/fileChange/requestApproval"
            | "item/permissions/requestApproval"
            | "item/tool/requestUserInput"
            | "tool/requestUserInput"
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
        "item/tool/requestUserInput" | "tool/requestUserInput" => {
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

// Corroborate the connector's approval question with its actual in-flight tool
// item. Ordinary agent questions, including similarly worded text, aren't grants.
pub fn tool_approval(
    params: &Value,
    calls: &std::collections::HashMap<String, Value>,
) -> Option<Value> {
    let questions = params["questions"].as_array()?;
    if questions.len() != 1 {
        return None;
    }
    let question = &questions[0];
    if question["isSecret"] == true || question["isOther"] == true {
        return None;
    }
    let options = question["options"].as_array()?;
    if !(2..=3).contains(&options.len()) { return None; }
    let label = |expected: &[&str]| options.iter().find_map(|option| option["label"].as_str()
        .filter(|label| expected.iter().any(|expected| label.eq_ignore_ascii_case(expected))));
    let accept = label(&["Accept", "Allow", "Approve", "許可", "承認"])?;
    let decline = label(&["Decline", "Deny", "Reject", "拒否"])?;
    let cancel = label(&["Cancel", "キャンセル"]);
    if options.len() == 3 && cancel.is_none() { return None; }
    let call = if let Some(call) = params["itemId"].as_str().and_then(|id| calls.get(id)) {
        call
    } else {
        // For independently numbered requests, require the generated confirmation
        // text as well as one unambiguous live tool. Never infer from text alone.
        let text = question["question"].as_str()?.strip_prefix("Allow ")?;
        let (app, tool) = text.split_once(" to run tool \"")?;
        let tool = tool.strip_suffix("\"?")?;
        if app.is_empty() || tool.is_empty() { return None; }
        let mut candidates = calls.values().filter(|call| {
            (call["tool"] == tool || call["appContext"]["actionName"] == tool
                || call["server"].as_str().zip(call["tool"].as_str()).is_some_and(|(server, name)| format!("{server}.{name}") == tool))
                && call["appContext"]["appName"].as_str().is_none_or(|name| name.eq_ignore_ascii_case(app))
        });
        let call = candidates.next()?;
        if candidates.next().is_some() { return None; }
        call
    };
    // Even a linked confirmation must name this tool; unrelated questions are
    // not permission grants. Display names and translated prose may vary.
    let text = question["question"].as_str()?;
    let named = call["tool"].as_str().is_some_and(|name| text.contains(name))
        || call["appContext"]["actionName"].as_str().is_some_and(|name| text.contains(name));
    if !named { return None; }
    let server = call["server"].as_str()?;
    let name = call["tool"].as_str()?;
    let mut approval = json!({"server":server,"tool":name,"connectorId":call["appContext"]["connectorId"],
        "linkId":call["appContext"]["linkId"],"questionId":question["id"].as_str()?,
        "acceptLabel":accept,"declineLabel":decline});
    if let Some(cancel) = cancel { approval["cancelLabel"] = json!(cancel); }
    Some(approval)
}

// Only an empty, input-free form is a repeatable confirmation. OAuth flows
// and forms that collect values must always remain interactive.
pub fn mcp_tool_approval(params: &Value, calls: &std::collections::HashMap<String, Value>) -> Option<Value> {
    if !matches!(params["mode"].as_str(), Some("form" | "openai/form")) { return None; }
    let schema = &params["requestedSchema"];
    if !form_supported(schema) || !schema["properties"].as_object()?.is_empty()
        || schema["required"].as_array().is_some_and(|required| !required.is_empty())
        || params["message"].as_str()?.trim().is_empty()
        || !schema.as_object()?.keys().all(|key| ["type", "properties", "required", "additionalProperties", "title", "description", "$schema"].contains(&key.as_str())) {
        return None;
    }
    let server = params["serverName"].as_str()?;
    let matches = |call: &&Value| call["server"] == server
        || call["appContext"]["connectorId"] == server
        || call["appContext"]["appName"].as_str().is_some_and(|name| name.eq_ignore_ascii_case(server));
    let call = if let Some(call) = params["itemId"].as_str().and_then(|id| calls.get(id)) {
        if !matches(&call) { return None; }
        call
    } else {
        let mut candidates = calls.values().filter(matches);
        let call = candidates.next()?;
        if candidates.next().is_some() { return None; }
        call
    };
    Some(json!({"protocol":"elicitation","server":call["server"].as_str()?,"tool":call["tool"].as_str()?,
        "connectorId":call["appContext"]["connectorId"],"linkId":call["appContext"]["linkId"]}))
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
    fn tool_approval_requires_matching_live_tool_and_fixed_confirmation_choices() {
        use std::collections::HashMap;
        let params = json!({"itemId":"call","questions":[{"id":"q","question":"Allow GitHub to run tool \"github.update_issue\"?","options":[{"label":"Accept"},{"label":"Decline"},{"label":"Cancel"}]}]});
        let calls = HashMap::from([(
            "call".to_owned(),
            json!({"server":"codex_apps","tool":"github.update_issue","appContext":{"appName":"GitHub","connectorId":"github"}}),
        )]);
        let approval = tool_approval(&params, &calls).unwrap();
        assert_eq!(approval["tool"], "github.update_issue");
        assert_eq!(approval["questionId"], "q");
        assert!(tool_approval(&params, &HashMap::new()).is_none());
        let mut different = params.clone();
        different["questions"][0]["question"] = json!("Which issue should I update?");
        assert!(tool_approval(&different, &calls).is_none());
        let mut wrong_tool = calls.clone();
        wrong_tool.get_mut("call").unwrap()["tool"] = json!("github.delete_issue");
        assert!(tool_approval(&params, &wrong_tool).is_none());
        let mut extra = params.clone();
        extra["questions"]
            .as_array_mut()
            .unwrap()
            .push(json!({"id":"other","question":"extra"}));
        assert!(tool_approval(&extra, &calls).is_none());
        let mut nonstandard = params.clone();
        nonstandard["questions"][0]["options"][0]["label"] = json!("Delete everything");
        assert!(tool_approval(&nonstandard, &calls).is_none());
    }

    #[test]
    fn approval_obeys_available_decisions_and_does_not_grant_extra_permissions() {
        assert!(response(
            "item/commandExecution/requestApproval",
            &json!({"availableDecisions":["decline"]}),
            &json!({"action":"accept"})
        )
        .is_err());
        assert_eq!(
            response(
                "item/permissions/requestApproval",
                &json!({"permissions":{"network":{"enabled":true},"fileSystem":null}}),
                &json!({"action":"accept","permissions":{"fileSystem":{"write":["/"]}}})
            )
            .unwrap(),
            json!({"permissions":{"network":{"enabled":true}},"scope":"turn"})
        );
        assert_eq!(
            response(
                "item/fileChange/requestApproval",
                &json!({}),
                &json!({"action":"decline"})
            )
            .unwrap(),
            json!({"decision":"decline"})
        );
    }
    #[test]
    fn questions_require_answers_and_preserve_question_ids() {
        let params = json!({"questions":[{"id":"color"}]});
        assert!(response(
            "item/tool/requestUserInput",
            &params,
            &json!({"action":"answer","answers":{}})
        )
        .is_err());
        assert_eq!(
            response(
                "item/tool/requestUserInput",
                &params,
                &json!({"action":"answer","answers":{"color":"青"}})
            )
            .unwrap(),
            json!({"answers":{"color":{"answers":["青"]}}})
        );
    }
}
