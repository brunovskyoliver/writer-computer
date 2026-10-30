pub mod ai;
pub mod calendar;
pub mod fonts;
pub mod fs;
pub mod git;
pub mod images;
pub mod latex;
pub mod latex_compile;
mod latex_output;
mod latex_root_lock;
pub mod mcp;
pub mod recents;
pub mod search;
pub mod settings;
#[cfg(target_os = "macos")]
pub mod shell_install;
pub mod startup;
pub mod workspace;
