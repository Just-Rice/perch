// Small readers for values out of JSONSerialization dictionaries. Commands and input come from the host process,
// which has already validated them, but the app still never trusts a type it hasn't checked.
import Foundation

public enum JSONValue {
    /// A finite number (JSON true/false are NSNumbers too; they are not numbers here).
    public static func number(_ value: Any?) -> Double? {
        guard let n = value as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID() else { return nil }
        let d = n.doubleValue
        return d.isFinite ? d : nil
    }

    public static func int(_ value: Any?) -> Int? {
        guard let d = number(value), d >= Double(Int32.min), d <= Double(Int32.max) else { return nil }
        return Int(d.rounded())
    }

    public static func bool(_ value: Any?) -> Bool? {
        guard let n = value as? NSNumber, CFGetTypeID(n) == CFBooleanGetTypeID() else { return nil }
        return n.boolValue
    }

    public static func string(_ value: Any?) -> String? { value as? String }

    public static func object(_ value: Any?) -> [String: Any]? { value as? [String: Any] }
}
