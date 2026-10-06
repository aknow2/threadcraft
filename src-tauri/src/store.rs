use crate::model::{AppError, Board, Group, Mutation, Thread};
use rusqlite::{params, Connection, TransactionBehavior};
use std::path::Path;

pub struct Store {
    connection: Connection,
}

impl Store {
    pub fn workspace_for_thread(&self, id: &str) -> Result<String, AppError> {
        use rusqlite::OptionalExtension;
        self.connection
            .query_row("SELECT cwd FROM threads WHERE id=?1", [id], |row| {
                row.get(0)
            })
            .optional()?
            .ok_or(AppError::NotFound)
    }
    pub fn open(path: &Path) -> Result<Self, AppError> {
        let connection = Connection::open(path)?;
        connection.busy_timeout(std::time::Duration::from_secs(5))?;
        connection.execute_batch("PRAGMA foreign_keys=ON;")?;
        let version: i64 = connection.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        if version > 3 {
            return Err(AppError::Storage);
        }
        if version == 0 {
            connection.execute_batch("BEGIN IMMEDIATE;
                CREATE TABLE groups(id TEXT PRIMARY KEY, name TEXT NOT NULL, position INTEGER NOT NULL);
                CREATE TABLE threads(id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at INTEGER NOT NULL, cwd TEXT NOT NULL, archived INTEGER NOT NULL);
                CREATE TABLE memberships(thread_id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE, position INTEGER NOT NULL);
                CREATE TABLE state(id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, last_sync INTEGER);
                INSERT INTO state VALUES(1,0,NULL);
                PRAGMA user_version=1;
                COMMIT;")?;
        }
        if version < 2 {
            connection.execute_batch(
                "BEGIN IMMEDIATE;
                ALTER TABLE threads ADD COLUMN updated_at INTEGER;
                ALTER TABLE threads ADD COLUMN read_at INTEGER;
                ALTER TABLE state ADD COLUMN unread_initialized INTEGER NOT NULL DEFAULT 0;
                PRAGMA user_version=2;
                COMMIT;",
            )?;
        }
        if version < 3 {
            connection.execute_batch("BEGIN IMMEDIATE;
                CREATE TABLE thread_aliases(local_id TEXT PRIMARY KEY, remote_id TEXT NOT NULL UNIQUE);
                PRAGMA user_version=3;
                COMMIT;")?;
        }
        Ok(Self { connection })
    }

    pub fn board(&self) -> Result<Board, AppError> {
        let tx = self.connection.unchecked_transaction()?;
        let (revision, last_sync) =
            tx.query_row("SELECT revision,last_sync FROM state WHERE id=1", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })?;
        let groups = tx
            .prepare("SELECT id,name FROM groups ORDER BY position,id")?
            .query_map([], |r| {
                Ok(Group {
                    id: r.get(0)?,
                    name: r.get(1)?,
                })
            })?
            .collect::<Result<_, _>>()?;
        let threads = self.connection.prepare("SELECT t.id,t.title,t.created_at,t.cwd,t.archived,m.group_id,COALESCE(m.position,0),COALESCE(t.updated_at,0),COALESCE(t.updated_at>t.read_at,0) FROM threads t LEFT JOIN memberships m ON m.thread_id=t.id ORDER BY t.created_at DESC,t.id")?.query_map([], |r| Ok(Thread { id:r.get(0)?,title:r.get(1)?,created_at:r.get(2)?,cwd:r.get(3)?,archived:r.get(4)?,group_id:r.get(5)?,position:r.get(6)?,updated_at:r.get(7)?,unread:r.get(8)? }))?.collect::<Result<_,_>>()?;
        tx.commit()?;
        Ok(Board {
            revision,
            groups,
            threads,
            last_sync,
        })
    }

    pub fn remote_id(&self, id: &str) -> Result<Option<String>, AppError> {
        use rusqlite::OptionalExtension;
        Ok(self
            .connection
            .query_row(
                "SELECT remote_id FROM thread_aliases WHERE local_id=?1",
                [id],
                |r| r.get(0),
            )
            .optional()?)
    }

    pub fn bind_remote(&mut self, id: &str, remote: &str) -> Result<(), AppError> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        tx.execute("INSERT INTO thread_aliases(local_id,remote_id) VALUES(?1,?2) ON CONFLICT(local_id) DO UPDATE SET remote_id=excluded.remote_id", params![id,remote])?;
        // Inventory may have discovered the new remote ID before the mapping was saved.
        tx.execute("DELETE FROM memberships WHERE thread_id=?1", [remote])?;
        tx.execute("DELETE FROM threads WHERE id=?1", [remote])?;
        tx.execute("UPDATE state SET revision=revision+1 WHERE id=1", [])?;
        tx.commit()?;
        Ok(())
    }

    pub fn unbind_remote(&mut self, id: &str) -> Result<(), AppError> {
        self.connection
            .execute("DELETE FROM thread_aliases WHERE local_id=?1", [id])?;
        Ok(())
    }

    pub fn insert_thread(
        &mut self,
        thread: &Thread,
        group_id: Option<&str>,
    ) -> Result<Board, AppError> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        tx.execute("INSERT INTO threads(id,title,created_at,cwd,archived,updated_at,read_at) VALUES(?1,?2,?3,?4,0,?5,?5)",
            params![thread.id,thread.title,thread.created_at,thread.cwd,thread.updated_at])?;
        // A group deleted while Codex was starting leaves the new conversation in the inbox.
        if let Some(group) = group_id {
            tx.execute("INSERT INTO memberships(thread_id,group_id,position) SELECT ?1,id,COALESCE((SELECT MAX(position)+1 FROM memberships WHERE group_id=?2),0) FROM groups WHERE id=?2", params![thread.id,group])?;
        }
        tx.execute("UPDATE state SET revision=revision+1 WHERE id=1", [])?;
        tx.commit()?;
        self.board()
    }

    pub fn sync(&mut self, threads: &[Thread], now: i64) -> Result<Board, AppError> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let initialized: bool =
            tx.query_row("SELECT unread_initialized FROM state WHERE id=1", [], |r| {
                r.get(0)
            })?;
        let mut changed = false;
        for incoming in threads {
            use rusqlite::OptionalExtension;
            let alias: Option<String> = tx
                .query_row(
                    "SELECT local_id FROM thread_aliases WHERE remote_id=?1",
                    [&incoming.id],
                    |r| r.get(0),
                )
                .optional()?;
            let mut mapped;
            let t = if let Some(id) = alias {
                mapped = incoming.clone();
                mapped.id = id;
                &mapped
            } else {
                incoming
            };
            let advances: bool = tx.query_row("SELECT NOT EXISTS(SELECT 1 FROM threads WHERE id=?1 AND (updated_at IS NULL OR updated_at>=?2))", params![t.id,t.updated_at], |r| r.get(0))?;
            let renamed: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM threads WHERE id=?1 AND title<>?2)",
                params![t.id, t.title],
                |r| r.get(0),
            )?;
            changed |= renamed || (initialized && advances);
            tx.execute("INSERT INTO threads(id,title,created_at,cwd,archived,updated_at,read_at) VALUES(?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(id) DO UPDATE SET title=excluded.title,created_at=excluded.created_at,cwd=excluded.cwd,archived=excluded.archived,updated_at=MAX(COALESCE(threads.updated_at,0),excluded.updated_at),read_at=COALESCE(threads.read_at,excluded.updated_at)", params![t.id,t.title,t.created_at,t.cwd,t.archived,t.updated_at,if initialized {0} else {t.updated_at}])?;
        }
        // Absence in an inventory is not proof of deletion. Keep cached rows and memberships.
        tx.execute(
            "UPDATE state SET last_sync=?1,unread_initialized=1,revision=revision+?2 WHERE id=1",
            params![now, i64::from(changed)],
        )?;
        tx.commit()?;
        self.board()
    }

    pub fn observe_update(&mut self, id: &str, updated: i64) -> Result<(), AppError> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let changed = tx.execute("UPDATE threads SET updated_at=?2,read_at=COALESCE(read_at,?2) WHERE id=?1 AND COALESCE(updated_at,0)<?2", params![id,updated])?;
        if changed > 0 {
            tx.execute("UPDATE state SET revision=revision+1 WHERE id=1", [])?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn mark_read(&mut self, id: &str, observed: i64) -> Result<Board, AppError> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let latest: Option<i64> = tx
            .query_row("SELECT updated_at FROM threads WHERE id=?1", [id], |r| {
                r.get(0)
            })
            .map_err(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => AppError::NotFound,
                _ => AppError::Storage,
            })?;
        if observed < 0 || latest.is_none_or(|latest| observed > latest) {
            return Err(AppError::Validation(
                "取得済みの更新時刻ではありません。".into(),
            ));
        }
        let changed = tx.execute(
            "UPDATE threads SET read_at=?2 WHERE id=?1 AND COALESCE(read_at,0)<?2",
            params![id, observed],
        )?;
        if changed > 0 {
            tx.execute("UPDATE state SET revision=revision+1 WHERE id=1", [])?;
        }
        tx.commit()?;
        self.board()
    }

    pub fn mutate(&mut self, expected: i64, mutation: Mutation) -> Result<Board, AppError> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let revision: i64 =
            tx.query_row("SELECT revision FROM state WHERE id=1", [], |r| r.get(0))?;
        if expected != revision {
            return Err(AppError::Conflict);
        }
        match mutation {
            Mutation::CreateGroup { name } => {
                let name = validate_name(&name)?;
                tx.execute("INSERT INTO groups VALUES(?1,?2,(SELECT COALESCE(MAX(position),-1)+1 FROM groups))", params![uuid::Uuid::new_v4().to_string(),name])?;
            }
            Mutation::RenameGroup { id, name } => {
                let name = validate_name(&name)?;
                if tx.execute("UPDATE groups SET name=?1 WHERE id=?2", params![name, id])? == 0 {
                    return Err(AppError::NotFound);
                }
            }
            Mutation::DeleteGroup { id } => {
                if tx.execute("DELETE FROM groups WHERE id=?1", [id])? == 0 {
                    return Err(AppError::NotFound);
                }
            }
            Mutation::MoveThread {
                id,
                group_id,
                before_id,
            } => {
                let exists: bool = tx.query_row(
                    "SELECT EXISTS(SELECT 1 FROM threads WHERE id=?1)",
                    [&id],
                    |r| r.get(0),
                )?;
                if !exists {
                    return Err(AppError::NotFound);
                }
                if let Some(group) = group_id {
                    let exists: bool = tx.query_row(
                        "SELECT EXISTS(SELECT 1 FROM groups WHERE id=?1)",
                        [&group],
                        |r| r.get(0),
                    )?;
                    if !exists {
                        return Err(AppError::NotFound);
                    }
                    let mut order = tx.prepare("SELECT thread_id FROM memberships WHERE group_id=?1 ORDER BY position,thread_id")?.query_map([&group], |r| r.get::<_, String>(0))?.collect::<Result<Vec<_>,_>>()?;
                    move_before(&mut order, &id, before_id.as_deref())?;
                    for (position, thread) in order.iter().enumerate() {
                        tx.execute("INSERT INTO memberships VALUES(?1,?2,?3) ON CONFLICT(thread_id) DO UPDATE SET group_id=excluded.group_id,position=excluded.position", params![thread,group,position as i64])?;
                    }
                } else {
                    if before_id.is_some() {
                        return Err(AppError::Validation("未分類は作成日時順です。".into()));
                    }
                    tx.execute("DELETE FROM memberships WHERE thread_id=?1", [id])?;
                }
            }
            Mutation::ReorderGroup { id, before_id } => {
                let mut order = tx
                    .prepare("SELECT id FROM groups ORDER BY position,id")?
                    .query_map([], |r| r.get::<_, String>(0))?
                    .collect::<Result<Vec<_>, _>>()?;
                if !order.contains(&id) {
                    return Err(AppError::NotFound);
                }
                move_before(&mut order, &id, before_id.as_deref())?;
                for (position, group) in order.iter().enumerate() {
                    tx.execute(
                        "UPDATE groups SET position=?1 WHERE id=?2",
                        params![position as i64, group],
                    )?;
                }
            }
        }
        tx.execute("UPDATE state SET revision=revision+1 WHERE id=1", [])?;
        tx.commit()?;
        self.board()
    }
}

fn validate_name(name: &str) -> Result<&str, AppError> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 100 {
        return Err(AppError::Validation(
            "グループ名は1〜100文字で入力してください。".into(),
        ));
    }
    Ok(name)
}

fn move_before(order: &mut Vec<String>, id: &str, before: Option<&str>) -> Result<(), AppError> {
    if before == Some(id) {
        return Ok(());
    }
    order.retain(|item| item != id);
    let index = match before {
        Some(target) => order
            .iter()
            .position(|item| item == target)
            .ok_or(AppError::NotFound)?,
        None => order.len(),
    };
    order.insert(index, id.into());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> Store {
        let mut store = Store::open(Path::new(":memory:")).unwrap();
        store
            .sync(
                &[Thread {
                    id: "t".into(),
                    title: "Thread".into(),
                    created_at: 1,
                    updated_at: 1,
                    unread: false,
                    cwd: String::new(),
                    archived: false,
                    group_id: None,
                    position: 0,
                }],
                1,
            )
            .unwrap();
        store
    }
    #[test]
    fn updates_become_unread_and_stale_ack_does_not_clear_newer_update() {
        let mut s = fixture();
        let mut threads = s.board().unwrap().threads;
        assert!(!threads[0].unread);
        threads[0].updated_at = 2;
        assert!(s.sync(&threads, 2).unwrap().threads[0].unread);
        threads[0].updated_at = 3;
        s.sync(&threads, 3).unwrap();
        assert!(s.mark_read("t", 2).unwrap().threads[0].unread);
        assert!(!s.mark_read("t", 3).unwrap().threads[0].unread);
        assert!(s.mark_read("t", 4).is_err());
    }

    #[test]
    fn new_threads_after_baseline_are_unread() {
        let mut s = fixture();
        let mut threads = s.board().unwrap().threads;
        threads[0].id = "new".into();
        let b = s.sync(&threads, 2).unwrap();
        assert!(b.threads.iter().find(|t| t.id == "new").unwrap().unread);
    }

    #[test]
    fn read_watermark_survives_reopen_and_older_sync() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("read.sqlite");
        let mut threads = fixture().board().unwrap().threads;
        {
            let mut s = Store::open(&path).unwrap();
            s.sync(&threads, 1).unwrap();
            threads[0].updated_at = 3;
            s.sync(&threads, 3).unwrap();
            s.mark_read("t", 3).unwrap();
        }
        let mut s = Store::open(&path).unwrap();
        threads[0].updated_at = 2;
        let b = s.sync(&threads, 4).unwrap();
        assert_eq!((b.threads[0].updated_at, b.threads[0].unread), (3, false));
    }

    #[test]
    fn migration_baselines_existing_threads_without_losing_groups() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("old.sqlite");
        let connection = Connection::open(&path).unwrap();
        connection.execute_batch("CREATE TABLE groups(id TEXT PRIMARY KEY,name TEXT NOT NULL,position INTEGER NOT NULL);
            CREATE TABLE threads(id TEXT PRIMARY KEY,title TEXT NOT NULL,created_at INTEGER NOT NULL,cwd TEXT NOT NULL,archived INTEGER NOT NULL);
            CREATE TABLE memberships(thread_id TEXT PRIMARY KEY,group_id TEXT,position INTEGER);
            CREATE TABLE state(id INTEGER PRIMARY KEY,revision INTEGER NOT NULL,last_sync INTEGER);
            INSERT INTO state VALUES(1,7,1);
            INSERT INTO groups VALUES('g','Group',0);
            INSERT INTO threads VALUES('t','Thread',1,'',0);
            INSERT INTO memberships VALUES('t','g',0);
            PRAGMA user_version=1;").unwrap();
        drop(connection);
        let mut s = Store::open(&path).unwrap();
        let mut threads = fixture().board().unwrap().threads;
        threads[0].updated_at = 100;
        let b = s.sync(&threads, 100).unwrap();
        assert_eq!(
            (
                b.revision,
                b.threads[0].unread,
                b.threads[0].group_id.as_deref()
            ),
            (7, false, Some("g"))
        );
    }

    #[test]
    fn deleting_group_returns_thread_to_inbox() {
        let mut s = fixture();
        let b = s
            .mutate(0, Mutation::CreateGroup { name: " A ".into() })
            .unwrap();
        let id = b.groups[0].id.clone();
        s.mutate(
            1,
            Mutation::MoveThread {
                id: "t".into(),
                group_id: Some(id.clone()),
                before_id: None,
            },
        )
        .unwrap();
        let b = s.mutate(2, Mutation::DeleteGroup { id }).unwrap();
        assert_eq!((b.threads.len(), b.threads[0].group_id.clone()), (1, None));
    }
    #[test]
    fn stale_revision_does_not_write() {
        let mut s = fixture();
        s.mutate(0, Mutation::CreateGroup { name: "A".into() })
            .unwrap();
        assert!(matches!(
            s.mutate(0, Mutation::CreateGroup { name: "B".into() }),
            Err(AppError::Conflict)
        ));
        assert_eq!(s.board().unwrap().groups.len(), 1);
    }
    #[test]
    fn invalid_destination_rolls_back() {
        let mut s = fixture();
        assert!(s
            .mutate(
                0,
                Mutation::MoveThread {
                    id: "t".into(),
                    group_id: Some("missing".into()),
                    before_id: None
                }
            )
            .is_err());
        assert_eq!(s.board().unwrap().revision, 0);
    }
    #[test]
    fn sync_does_not_reset_membership_or_revision() {
        let mut s = fixture();
        let b = s
            .mutate(0, Mutation::CreateGroup { name: "A".into() })
            .unwrap();
        s.mutate(
            1,
            Mutation::MoveThread {
                id: "t".into(),
                group_id: Some(b.groups[0].id.clone()),
                before_id: None,
            },
        )
        .unwrap();
        let b = s.sync(&[], 2).unwrap();
        assert_eq!((b.revision, b.threads[0].group_id.is_some()), (2, true));
    }
    #[test]
    fn persistence_survives_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.sqlite");
        {
            let mut s = Store::open(&path).unwrap();
            s.mutate(
                0,
                Mutation::CreateGroup {
                    name: "保存".into(),
                },
            )
            .unwrap();
        }
        assert_eq!(
            Store::open(&path).unwrap().board().unwrap().groups[0].name,
            "保存"
        );
    }
    #[test]
    fn empty_and_long_names_are_rejected() {
        assert!(validate_name("  ").is_err());
        assert!(validate_name(&"あ".repeat(101)).is_err());
    }
    #[test]
    fn moving_between_groups_leaves_one_membership() {
        let mut s = fixture();
        s.mutate(0, Mutation::CreateGroup { name: "A".into() })
            .unwrap();
        let b = s
            .mutate(1, Mutation::CreateGroup { name: "B".into() })
            .unwrap();
        for (i, g) in b.groups.iter().enumerate() {
            s.mutate(
                2 + i as i64,
                Mutation::MoveThread {
                    id: "t".into(),
                    group_id: Some(g.id.clone()),
                    before_id: None,
                },
            )
            .unwrap();
        }
        assert_eq!(
            s.board().unwrap().threads[0].group_id,
            Some(b.groups[1].id.clone())
        );
    }
    #[test]
    fn reorder_inserts_before_target() {
        let mut order = vec!["a".into(), "b".into(), "c".into()];
        move_before(&mut order, "c", Some("a")).unwrap();
        assert_eq!(order, vec!["c", "a", "b"]);
    }

    #[test]
    fn workspace_lookup_rejects_unknown_threads() {
        let s = fixture();
        assert!(matches!(
            s.workspace_for_thread("unknown"),
            Err(AppError::NotFound)
        ));
    }

    #[test]
    fn workspace_lookup_uses_cached_path() {
        let s = fixture();
        s.connection
            .execute(
                "UPDATE threads SET cwd=?1 WHERE id='t'",
                ["/workspace with spaces"],
            )
            .unwrap();
        assert_eq!(
            s.workspace_for_thread("t").unwrap(),
            "/workspace with spaces"
        );
    }

    #[test]
    fn database_failure_rolls_back_group_deletion_and_membership() {
        let mut s = fixture();
        let b = s
            .mutate(0, Mutation::CreateGroup { name: "A".into() })
            .unwrap();
        let group = b.groups[0].id.clone();
        s.mutate(
            1,
            Mutation::MoveThread {
                id: "t".into(),
                group_id: Some(group.clone()),
                before_id: None,
            },
        )
        .unwrap();
        s.connection.execute_batch("CREATE TRIGGER fail_revision BEFORE UPDATE ON state BEGIN SELECT RAISE(ABORT, 'injected failure'); END;").unwrap();
        assert!(matches!(
            s.mutate(2, Mutation::DeleteGroup { id: group.clone() }),
            Err(AppError::Storage)
        ));
        let b = s.board().unwrap();
        assert_eq!(
            (b.revision, b.groups.len(), b.threads[0].group_id.clone()),
            (2, 1, Some(group))
        );
    }

    #[test]
    fn archived_sync_keeps_membership() {
        let mut s = fixture();
        let b = s
            .mutate(0, Mutation::CreateGroup { name: "A".into() })
            .unwrap();
        let mut b = s
            .mutate(
                1,
                Mutation::MoveThread {
                    id: "t".into(),
                    group_id: Some(b.groups[0].id.clone()),
                    before_id: None,
                },
            )
            .unwrap();
        b.threads[0].archived = true;
        let b = s.sync(&b.threads, 2).unwrap();
        assert!(b.threads[0].archived && b.threads[0].group_id.is_some());
    }

    #[test]
    fn new_chat_survives_reopen_and_remote_sync_without_duplicate_or_lost_group() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("board.sqlite");
        let mut s = Store::open(&path).unwrap();
        let board = s
            .mutate(
                0,
                Mutation::CreateGroup {
                    name: "開発".into(),
                },
            )
            .unwrap();
        let group = board.groups[0].id.clone();
        let mut thread = fixture().board().unwrap().threads.remove(0);
        thread.id = "draft:local".into();
        let board = s.insert_thread(&thread, Some(&group)).unwrap();
        assert_eq!(board.threads[0].group_id.as_deref(), Some(group.as_str()));
        assert!(!board.threads[0].unread);
        drop(s);
        let mut s = Store::open(&path).unwrap();
        assert_eq!(s.board().unwrap().threads.len(), 1);
        thread.id = "remote".into();
        s.sync(&[thread.clone()], 10).unwrap();
        s.bind_remote("draft:local", "remote").unwrap();
        let board = s.sync(&[thread], 11).unwrap();
        assert_eq!(board.threads.len(), 1);
        assert_eq!(board.threads[0].id, "draft:local");
        assert_eq!(board.threads[0].group_id.as_deref(), Some(group.as_str()));
    }

    #[test]
    fn deleted_group_falls_back_to_inbox_when_creating() {
        let mut s = fixture();
        let mut thread = s.board().unwrap().threads.remove(0);
        thread.id = "new".into();
        let board = s.insert_thread(&thread, Some("deleted")).unwrap();
        assert!(board
            .threads
            .iter()
            .find(|t| t.id == "new")
            .unwrap()
            .group_id
            .is_none());
    }

    #[test]
    fn future_database_schema_is_not_downgraded() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("future.sqlite");
        let connection = Connection::open(&path).unwrap();
        connection.execute_batch("PRAGMA user_version=4;").unwrap();
        assert!(matches!(Store::open(&path), Err(AppError::Storage)));
    }
}
