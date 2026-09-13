//! Keep webviews alive until their drawing exports and writes finish.
use std::collections::{HashSet, VecDeque};
use std::sync::Mutex;
use tauri::{Emitter, Manager};

#[derive(Default)]
pub struct Shutdown(Mutex<State>);

#[derive(Default)]
struct State {
    ready: HashSet<String>,
    pending: Option<Request>,
    next_id: u64,
    allow_exit: bool,
    queued: VecDeque<Option<String>>,
}

struct Request {
    id: u64,
    waiting: HashSet<String>,
    target: Option<String>,
}

impl Request {
    fn acknowledge(&mut self, label: &str, id: u64) -> bool {
        self.id == id && self.waiting.remove(label) && self.waiting.is_empty()
    }
}

#[tauri::command]
pub fn drawing_shutdown_ready(window: tauri::WebviewWindow, state: tauri::State<Shutdown>) {
    state.0.lock().unwrap().ready.insert(window.label().into());
}

// Returns true when the native request has been deferred.
pub fn request(app: &tauri::AppHandle, target: Option<String>) -> bool {
    let coordinator = app.state::<Shutdown>();
    let mut state = coordinator.0.lock().unwrap();
    if state.allow_exit {
        return false;
    }
    if let Some(pending) = &state.pending {
        if pending.target != target && !state.queued.contains(&target) {
            state.queued.push_back(target);
        }
        return true;
    }
    let waiting: HashSet<String> = state
        .ready
        .iter()
        .filter(|label| {
            app.get_webview_window(label).is_some() && target.as_ref().is_none_or(|t| t == *label)
        })
        .cloned()
        .collect();
    if waiting.is_empty() {
        return false;
    }
    state.next_id += 1;
    let id = state.next_id;
    state.pending = Some(Request {
        id,
        waiting: waiting.clone(),
        target,
    });
    drop(state);
    for label in waiting {
        if let Err(error) = app.emit_to(&label, "drawing:prepare-close", id) {
            eprintln!("Could not request drawing save: {error}");
            cancel(app, id);
            break;
        }
    }
    true
}

fn cancel(app: &tauri::AppHandle, id: u64) {
    let coordinator = app.state::<Shutdown>();
    let mut state = coordinator.0.lock().unwrap();
    if state
        .pending
        .as_ref()
        .is_some_and(|request| request.id == id)
    {
        state.pending = None;
        state.queued.clear();
        drop(state);
        let _ = app.emit("drawing:close-cancelled", id);
    }
}

#[tauri::command]
pub fn drawing_shutdown_complete(window: tauri::WebviewWindow, id: u64, success: bool) {
    let app = window.app_handle();
    if !success {
        cancel(app, id);
        return;
    }
    let coordinator = app.state::<Shutdown>();
    let mut state = coordinator.0.lock().unwrap();
    let Some(request) = state.pending.as_mut() else {
        return;
    };
    if !request.acknowledge(window.label(), id) {
        return;
    }
    let target = request.target.clone();
    state.pending = None;
    let next = state.queued.pop_front();
    if target.is_none() {
        state.allow_exit = true;
    }
    drop(state);
    if let Some(label) = target {
        if let Some(window) = app.get_webview_window(&label) {
            if let Err(error) = window.destroy() {
                eprintln!("Could not close window: {error}");
                let _ = app.emit("drawing:close-cancelled", id);
            }
        }
        if let Some(target) = next {
            if !self::request(app, target.clone()) {
                if let Some(label) = target {
                    if let Some(window) = app.get_webview_window(&label) {
                        let _ = window.close();
                    }
                } else {
                    app.exit(0);
                }
            }
        }
    } else {
        app.exit(0);
    }
}

pub fn destroyed(app: &tauri::AppHandle, label: &str) {
    app.state::<Shutdown>()
        .0
        .lock()
        .unwrap()
        .ready
        .remove(label);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request() -> Request {
        Request {
            id: 2,
            waiting: HashSet::from(["a".into(), "b".into()]),
            target: None,
        }
    }

    #[test]
    fn waits_for_every_window_and_ignores_stale_or_duplicate_acknowledgments() {
        let mut request = request();
        assert!(!request.acknowledge("a", 1));
        assert_eq!(request.waiting.len(), 2);
        assert!(!request.acknowledge("unknown", 2));
        assert!(!request.acknowledge("a", 2));
        assert!(!request.acknowledge("a", 2));
        assert_eq!(request.waiting.len(), 1);
        assert!(request.acknowledge("b", 2));
    }

    #[test]
    fn window_close_waits_only_for_its_target() {
        let mut request = Request {
            id: 3,
            waiting: HashSet::from(["a".into()]),
            target: Some("a".into()),
        };
        assert!(!request.acknowledge("b", 3));
        assert!(request.acknowledge("a", 3));
        assert_eq!(request.target.as_deref(), Some("a"));
    }
}

// AppKit's terminate: bypasses Tauri's ExitRequested. Route menu/Dock Quit
// through app.exit instead, retaining the existing application delegate.
#[cfg(target_os = "macos")]
pub fn install_macos(app: &tauri::AppHandle) -> Result<(), String> {
    use objc2::ffi::class_addMethod;
    use objc2::runtime::{AnyClass, AnyObject, Imp, Sel};
    use objc2::{msg_send, sel};
    use std::sync::OnceLock;
    static APP: OnceLock<tauri::AppHandle> = OnceLock::new();

    unsafe extern "C-unwind" fn should_terminate(
        _delegate: *mut AnyObject,
        _cmd: Sel,
        _sender: *mut AnyObject,
    ) -> usize {
        if let Some(app) = APP.get() {
            app.exit(0);
        }
        0 // NSTerminateCancel; the coordinator will exit after saves succeed.
    }

    if APP.get().is_some() {
        return Ok(());
    }
    unsafe {
        let delegate = crate::macos::app_delegate().ok_or("Application delegate unavailable")?;
        let class: *mut AnyClass = msg_send![delegate, class];
        if class.is_null() {
            return Err("Application delegate class unavailable".into());
        }
        let implementation: Imp = std::mem::transmute::<
            unsafe extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject) -> usize,
            Imp,
        >(should_terminate);
        if !class_addMethod(
            class,
            sel!(applicationShouldTerminate:),
            implementation,
            c"Q@:@".as_ptr(),
        )
        .as_bool()
        {
            return Err("Could not install application termination save barrier".into());
        }
    }
    let _ = APP.set(app.clone());
    Ok(())
}
