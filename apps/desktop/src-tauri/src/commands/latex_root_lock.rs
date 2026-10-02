//! Process-wide document locks. Only running/waiting compiles own strong refs.
use crate::error::AppError;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock, Weak};

#[derive(Default)]
struct RootLocks {
    entries: Mutex<HashMap<PathBuf, Weak<Mutex<()>>>>,
}

impl RootLocks {
    fn acquire(&self, root: &Path) -> Result<Arc<Mutex<()>>, AppError> {
        let mut entries = self
            .entries
            .lock()
            .map_err(|e| AppError::Io(format!("LaTeX lock registry poisoned: {e}")))?;
        entries.retain(|_, lock| lock.strong_count() > 0);
        if let Some(lock) = entries.get(root).and_then(Weak::upgrade) {
            return Ok(lock);
        }
        let lock = Arc::new(Mutex::new(()));
        entries.insert(root.to_owned(), Arc::downgrade(&lock));
        Ok(lock)
    }
}

/// `root` has already been canonicalized by document discovery. The registry
/// guard drops before callers wait for this lock, keeping other roots free.
pub(super) fn acquire(root: &Path) -> Result<Arc<Mutex<()>>, AppError> {
    static LOCKS: OnceLock<RootLocks> = OnceLock::new();
    LOCKS.get_or_init(RootLocks::default).acquire(root)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;

    #[test]
    fn live_roots_share_locks_and_expired_entries_are_replaced_and_pruned() {
        let locks = RootLocks::default();
        let a = Path::new("/a/main.tex");
        let b = Path::new("/b/main.tex");
        let first = locks.acquire(a).unwrap();
        assert!(Arc::ptr_eq(&first, &locks.acquire(a).unwrap()));
        let weak = Arc::downgrade(&first);
        drop(first);
        let next = locks.acquire(a).unwrap();
        assert!(weak.upgrade().is_none());
        assert_eq!(locks.entries.lock().unwrap().len(), 1);
        drop(next);
        let other = locks.acquire(b).unwrap();
        assert_eq!(locks.entries.lock().unwrap().len(), 1);
        assert!(!locks.entries.lock().unwrap().contains_key(a));
        drop(other);
    }

    #[test]
    fn a_waiter_for_one_root_does_not_block_another() {
        let locks = Arc::new(RootLocks::default());
        let root = locks.acquire(Path::new("/a.tex")).unwrap();
        let held = root.lock().unwrap();
        let (ready_tx, ready_rx) = mpsc::channel();
        let (done_tx, done_rx) = mpsc::channel();
        let waiter_locks = locks.clone();
        let waiter = std::thread::spawn(move || {
            let root = waiter_locks.acquire(Path::new("/a.tex")).unwrap();
            ready_tx.send(()).unwrap();
            let _guard = root.lock().unwrap();
        });
        let ready = ready_rx.recv_timeout(Duration::from_secs(2));
        let other = std::thread::spawn(move || {
            let root = locks.acquire(Path::new("/b.tex")).unwrap();
            let _guard = root.lock().unwrap();
            done_tx.send(()).unwrap();
        });
        let done = done_rx.recv_timeout(Duration::from_secs(2));
        drop(held);
        waiter.join().unwrap();
        other.join().unwrap();
        assert!(ready.is_ok());
        assert!(done.is_ok());
    }
}
