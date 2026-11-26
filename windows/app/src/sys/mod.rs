//! The operating system's side: Windows for real (sys/windows), and a stand-in elsewhere so the app builds, runs
//! with --synthetic and is tested on any development machine.
#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub use self::windows::*;

#[cfg(not(windows))]
mod other;
#[cfg(not(windows))]
pub use other::*;

pub use crate::mic::MicPlayer;
