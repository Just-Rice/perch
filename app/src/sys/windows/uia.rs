//! Whether whatever has the keyboard focus on the PC now takes typing (and whether it is a password box), from UI
//! Automation, so a phone can bring up its own keyboard by itself after a click.
#![allow(non_upper_case_globals)]
use windows::Win32::System::Com::*;
use windows::Win32::UI::Accessibility::*;

thread_local! {
    static UIA: Option<IUIAutomation> = unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER).ok()
    };
}

/// (editable, secure), or None when it can't be told.
pub fn text_focus() -> Option<(bool, bool)> {
    UIA.with(|uia| unsafe {
        let el = uia.as_ref()?.GetFocusedElement().ok()?;
        let control = el.CurrentControlType().ok()?;
        let secure = el.CurrentIsPassword().map(|b| b.as_bool()).unwrap_or(false);
        let editable = match control {
            UIA_EditControlTypeId | UIA_DocumentControlTypeId => {
                // A read-only document (a web page being read) doesn't take typing; its text boxes do.
                match el.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId) {
                    Ok(v) => !v.CurrentIsReadOnly().map(|b| b.as_bool()).unwrap_or(false),
                    Err(_) => control == UIA_EditControlTypeId,
                }
            }
            UIA_ComboBoxControlTypeId => el.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)
                .map(|v| !v.CurrentIsReadOnly().map(|b| b.as_bool()).unwrap_or(true)).unwrap_or(false),
            _ => false,
        };
        Some((editable || secure, secure))
    })
}
