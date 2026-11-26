//! The brightness keys: a laptop's built-in screen through WMI (WmiMonitorBrightnessMethods), external monitors
//! through DDC/CI. Ten steps from dark to bright.
use windows::Win32::Devices::Display::{DestroyPhysicalMonitors, GetMonitorBrightness, GetNumberOfPhysicalMonitorsFromHMONITOR,
    GetPhysicalMonitorsFromHMONITOR, SetMonitorBrightness, PHYSICAL_MONITOR};
use windows::Win32::Foundation::POINT;
use windows::Win32::Graphics::Gdi::{MonitorFromPoint, MONITOR_DEFAULTTOPRIMARY};

pub fn step(up: bool) {
    if ddc(up) { return; }
    wmi(up);
}

/// External monitors that speak DDC/CI.
fn ddc(up: bool) -> bool {
    unsafe {
        let m = MonitorFromPoint(POINT { x: 0, y: 0 }, MONITOR_DEFAULTTOPRIMARY);
        let mut n = 0u32;
        if GetNumberOfPhysicalMonitorsFromHMONITOR(m, &mut n).is_err() || n == 0 { return false; }
        let mut list = vec![PHYSICAL_MONITOR::default(); n as usize];
        if GetPhysicalMonitorsFromHMONITOR(m, &mut list).is_err() { return false; }
        let mut done = false;
        for pm in &list {
            let (mut min, mut cur, mut max) = (0u32, 0u32, 0u32);
            if GetMonitorBrightness(pm.hPhysicalMonitor, &mut min, &mut cur, &mut max) != 0 && max > min {
                let step = ((max - min) / 10).max(1);
                let v = if up { (cur + step).min(max) } else { cur.saturating_sub(step).max(min) };
                done |= SetMonitorBrightness(pm.hPhysicalMonitor, v) != 0;
            }
        }
        let _ = DestroyPhysicalMonitors(&list);
        done
    }
}

/// Built-in screens: WMI, through PowerShell (rare enough that its start-up time doesn't matter).
fn wmi(up: bool) {
    let script = format!(
        "$b=(Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightness -ErrorAction Stop|Select-Object -First 1).CurrentBrightness;\
         $n=[Math]::Max(0,[Math]::Min(100,$b{}10));\
         Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightnessMethods|Invoke-CimMethod -MethodName WmiSetBrightness -Arguments @{{Timeout=1;Brightness=[byte]$n}}|Out-Null",
        if up { "+" } else { "-" });
    let mut cmd = std::process::Command::new("powershell.exe");
    cmd.args(["-NoProfile", "-NonInteractive", "-Command", &script]);
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(0x0800_0000);
    let _ = cmd.spawn();
}
