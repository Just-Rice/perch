//! Lenient readers for JSON values from the host, mirroring PerchCore's JSONValue: a wrong type is "missing".
use serde_json::{Map, Value};

pub type Obj = Map<String, Value>;

pub fn s<'a>(o: &'a Obj, k: &str) -> Option<&'a str> { o.get(k).and_then(Value::as_str) }
pub fn b(o: &Obj, k: &str) -> Option<bool> { o.get(k).and_then(Value::as_bool) }
pub fn n(o: &Obj, k: &str) -> Option<f64> { o.get(k).and_then(Value::as_f64).filter(|v| v.is_finite()) }
/// A whole number (2.0 counts; 2.5 doesn't).
pub fn i(o: &Obj, k: &str) -> Option<i64> {
    n(o, k).filter(|v| v.fract() == 0.0 && v.abs() < 9.0e15).map(|v| v as i64)
}
pub fn obj<'a>(o: &'a Obj, k: &str) -> Option<&'a Obj> { o.get(k).and_then(Value::as_object) }
