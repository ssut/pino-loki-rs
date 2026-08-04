use std::collections::{BTreeMap, HashMap};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{Map, Value};

pub struct BuiltLog {
    pub labels_key: String,
    pub labels: BTreeMap<String, String>,
    pub ts_ns: String,
    pub line: String,
    pub meta: Option<Value>,
}

pub struct Builder {
    pub extra_labels: BTreeMap<String, String>,
    pub props_to_labels: Vec<String>,
    pub replace_timestamp: bool,
    pub convert_arrays: bool,
    pub structured_meta_key: Option<String>,
}

impl Builder {
    pub fn build(&self, mut log: Map<String, Value>) -> BuiltLog {
        let level = level_label(log.get("level"));
        let ts_ns = timestamp_ns(log.get("time"), self.replace_timestamp);
        let hostname = match log.remove("hostname") {
            Some(Value::String(s)) => Some(s),
            Some(Value::Null) | None => None,
            Some(other) => Some(other.to_string()),
        };
        let mut labels: BTreeMap<String, String> = BTreeMap::new();
        labels.insert("level".to_string(), level.to_string());
        if let Some(h) = hostname {
            labels.insert("hostname".to_string(), h);
        }
        for (k, v) in &self.extra_labels {
            labels.insert(k.clone(), v.clone());
        }
        for prop in &self.props_to_labels {
            if let Some(v) = log.get(prop) {
                if truthy(v) {
                    let s = match v {
                        Value::String(s) => s.clone(),
                        other => other.to_string(),
                    };
                    labels.insert(prop.clone(), s);
                }
            }
        }
        let meta = self
            .structured_meta_key
            .as_ref()
            .and_then(|k| log.get(k).cloned());
        let line_value = if self.convert_arrays {
            convert_arrays(Value::Object(log))
        } else {
            Value::Object(log)
        };
        let line = serde_json::to_string(&line_value).unwrap_or_default();
        let labels_key = serde_json::to_string(&labels).unwrap_or_default();
        BuiltLog {
            labels_key,
            labels,
            ts_ns,
            line,
            meta,
        }
    }
}

fn level_label(level: Option<&Value>) -> &'static str {
    match level.and_then(Value::as_i64) {
        Some(10) | Some(20) => "debug",
        Some(40) => "warning",
        Some(50) => "error",
        Some(60) => "critical",
        _ => "info",
    }
}

fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().map(|f| f != 0.0).unwrap_or(true),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

fn now_ns() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0)
}

fn timestamp_ns(time: Option<&Value>, replace: bool) -> String {
    if replace {
        return now_ns().to_string();
    }
    let int = time.and_then(|t| {
        t.as_u64()
            .map(u128::from)
            .filter(|u| *u > 0)
            .or_else(|| t.as_f64().filter(|f| *f > 0.0).map(|f| f as u128))
    });
    match int {
        None => now_ns().to_string(),
        Some(int) => {
            let digits = int.to_string().len();
            if digits >= 19 {
                int.to_string()
            } else {
                (int * 10u128.pow((19 - digits) as u32)).to_string()
            }
        }
    }
}

fn convert_arrays(v: Value) -> Value {
    match v {
        Value::Array(items) => Value::Object(
            items
                .into_iter()
                .enumerate()
                .map(|(i, x)| (i.to_string(), convert_arrays(x)))
                .collect(),
        ),
        Value::Object(m) => {
            Value::Object(m.into_iter().map(|(k, x)| (k, convert_arrays(x))).collect())
        }
        other => other,
    }
}

pub fn payload(batch: Vec<BuiltLog>) -> (String, u64) {
    let entries = batch.len() as u64;
    let mut order: Vec<String> = Vec::new();
    let mut groups: HashMap<String, (BTreeMap<String, String>, Vec<Value>)> = HashMap::new();
    for b in batch {
        let entry = match b.meta {
            Some(m) => Value::Array(vec![Value::String(b.ts_ns), Value::String(b.line), m]),
            None => Value::Array(vec![Value::String(b.ts_ns), Value::String(b.line)]),
        };
        match groups.get_mut(&b.labels_key) {
            Some((_, values)) => values.push(entry),
            None => {
                order.push(b.labels_key.clone());
                groups.insert(b.labels_key, (b.labels, vec![entry]));
            }
        }
    }
    let streams: Vec<Value> = order
        .into_iter()
        .filter_map(|k| groups.remove(&k))
        .map(|(labels, values)| {
            let stream: Map<String, Value> = labels
                .into_iter()
                .map(|(k, v)| (k, Value::String(v)))
                .collect();
            let mut obj = Map::new();
            obj.insert("stream".to_string(), Value::Object(stream));
            obj.insert("values".to_string(), Value::Array(values));
            Value::Object(obj)
        })
        .collect();
    let mut root = Map::new();
    root.insert("streams".to_string(), Value::Array(streams));
    (
        serde_json::to_string(&Value::Object(root)).unwrap_or_default(),
        entries,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn base_builder() -> Builder {
        Builder {
            extra_labels: BTreeMap::new(),
            props_to_labels: vec![],
            replace_timestamp: false,
            convert_arrays: false,
            structured_meta_key: None,
        }
    }

    fn obj(v: Value) -> Map<String, Value> {
        match v {
            Value::Object(m) => m,
            _ => panic!("expected object"),
        }
    }

    #[test]
    fn timestamp_scales_ms_to_ns_exactly() {
        assert_eq!(
            timestamp_ns(Some(&json!(1754265600000u64)), false),
            "1754265600000000000"
        );
    }

    #[test]
    fn timestamp_passes_ns_through_exactly() {
        assert_eq!(
            timestamp_ns(Some(&json!(1754265600123456789u64)), false),
            "1754265600123456789"
        );
    }

    #[test]
    fn timestamp_missing_or_zero_uses_now() {
        assert_eq!(timestamp_ns(None, false).len(), 19);
        assert_eq!(timestamp_ns(Some(&json!(0)), false).len(), 19);
        assert_eq!(timestamp_ns(Some(&json!(1)), true).len(), 19);
    }

    #[test]
    fn level_maps_like_pino_loki() {
        assert_eq!(level_label(Some(&json!(10))), "debug");
        assert_eq!(level_label(Some(&json!(20))), "debug");
        assert_eq!(level_label(Some(&json!(30))), "info");
        assert_eq!(level_label(Some(&json!(40))), "warning");
        assert_eq!(level_label(Some(&json!(50))), "error");
        assert_eq!(level_label(Some(&json!(60))), "critical");
        assert_eq!(level_label(Some(&json!(99))), "info");
        assert_eq!(level_label(None), "info");
    }

    #[test]
    fn hostname_becomes_label_and_leaves_line() {
        let built = base_builder().build(obj(json!({
            "level": 30,
            "time": 1754265600000u64,
            "hostname": "task-1",
            "msg": "hello"
        })));
        assert_eq!(built.labels.get("hostname"), Some(&"task-1".to_string()));
        assert!(!built.line.contains("hostname"));
        assert!(built.line.contains("\"msg\":\"hello\""));
    }

    #[test]
    fn props_to_labels_respects_js_truthiness() {
        let mut b = base_builder();
        b.props_to_labels = vec!["reqId".into(), "zero".into(), "empty".into(), "flag".into()];
        let built = b.build(obj(json!({
            "level": 30,
            "reqId": "r-1",
            "zero": 0,
            "empty": "",
            "flag": false
        })));
        assert_eq!(built.labels.get("reqId"), Some(&"r-1".to_string()));
        assert!(!built.labels.contains_key("zero"));
        assert!(!built.labels.contains_key("empty"));
        assert!(!built.labels.contains_key("flag"));
    }

    #[test]
    fn payload_groups_streams_by_label_set() {
        let b = base_builder();
        let logs = vec![
            b.build(obj(json!({"level": 30, "hostname": "h", "msg": "a"}))),
            b.build(obj(json!({"level": 30, "hostname": "h", "msg": "b"}))),
            b.build(obj(json!({"level": 50, "hostname": "h", "msg": "c"}))),
        ];
        let (body, entries) = payload(logs);
        assert_eq!(entries, 3);
        let parsed: Value = serde_json::from_str(&body).unwrap();
        let streams = parsed["streams"].as_array().unwrap();
        assert_eq!(streams.len(), 2);
        let total: usize = streams
            .iter()
            .map(|s| s["values"].as_array().unwrap().len())
            .sum();
        assert_eq!(total, 3);
    }

    #[test]
    fn convert_arrays_rewrites_arrays_as_objects() {
        let mut b = base_builder();
        b.convert_arrays = true;
        let built = b.build(obj(json!({"level": 30, "items": [7, 8]})));
        assert!(built.line.contains("\"0\":7"));
        assert!(built.line.contains("\"1\":8"));
    }

    #[test]
    fn structured_meta_key_adds_third_tuple_element() {
        let mut b = base_builder();
        b.structured_meta_key = Some("meta".into());
        let logs = vec![b.build(obj(
            json!({"level": 30, "meta": {"traceId": "t1"}, "msg": "x"}),
        ))];
        let (body, _) = payload(logs);
        let parsed: Value = serde_json::from_str(&body).unwrap();
        let value = &parsed["streams"][0]["values"][0];
        assert_eq!(value.as_array().unwrap().len(), 3);
        assert_eq!(value[2]["traceId"], "t1");
    }
}
