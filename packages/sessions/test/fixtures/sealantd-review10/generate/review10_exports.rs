//! Generates the stores in `packages/sessions/test/fixtures/sealantd-review10/`: sealant-capture
//! at sealantd 83588f6 (round 10, 4c94bd4 plus its docs), each a completed, sealed final flush
//! over a repository the tenth review named, exported as the daemon wrote it (`store/`, the
//! registrar's `head.json`):
//!
//! - `nested-linked-worktree`: a linked worktree inside the workspace, its `.git/worktrees/child`
//!   admin (index included) in the workspace class, its staged-only blob in the closure;
//! - `nested-alternate`: a nested repository whose alternates are the top-level object store,
//!   its objects in a further git pack;
//! - `wide-after`, `wide-before`: an untracked file, a tracked file, an untracked directory and
//!   a bulk file at 2286 (and at 1653) plus 123456789 ns — `mtime`s outside signed 64 bits.
//!
//! Run as `crates/sealant-capture/tests/review10_exports.rs` in a sealantd checkout, Ubuntu 24.04
//! with git 2.52, `/exports` writable: `cargo test -p sealant-capture --test review10_exports`.

use std::fs;
use std::os::unix::fs::{MetadataExt, symlink};
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::Arc;

use sealant_capture::{
    CadenceRunner, CaptureConfig, CaptureEngine, InMemoryRegistrar, LocalDir, MaterializeClass,
    MaterializeTargets, Materializer,
};

const EXECUTOR: &str = "exec-r8";

fn git_out(root: &Path, args: &[&str], input: Option<&[u8]>) -> Output {
    use std::io::Write;
    use std::process::Stdio;
    let mut child = Command::new("git")
        .current_dir(root)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("git");
    let mut stdin = child.stdin.take().unwrap();
    if let Some(input) = input {
        stdin.write_all(input).unwrap();
    }
    drop(stdin);
    child.wait_with_output().unwrap()
}

fn git(root: &Path, args: &[&str]) -> String {
    git_in(root, args, None)
}

fn git_in(root: &Path, args: &[&str], input: Option<&[u8]>) -> String {
    let out = git_out(root, args, input);
    assert!(
        out.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8(out.stdout).unwrap().trim().to_owned()
}

/// A commit no ref, reflog or `HEAD` reaches, holding one file with `contents`.
fn unreachable_commit(root: &Path, contents: &[u8]) -> String {
    let blob = git_in(root, &["hash-object", "-w", "--stdin"], Some(contents));
    let tree = git_in(
        root,
        &["mktree"],
        Some(format!("100644 blob {blob}\tunique.txt\n").as_bytes()),
    );
    git(
        root,
        &["commit-tree", &tree, "-m", "unique unreachable commit"],
    )
}

struct Fixture {
    tmp: tempfile::TempDir,
    root: PathBuf,
    store: Arc<LocalDir>,
    registrar: Arc<InMemoryRegistrar>,
}

impl Fixture {
    /// A repository with one commit on `main`: `a` holding `base\n`; `.gitignore` ignoring
    /// `ignored/` and `node_modules/`.
    fn new() -> Self {
        Self::with_format(None)
    }

    fn with_format(format: Option<&str>) -> Self {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("ws");
        fs::create_dir_all(&root).unwrap();
        let mut init = vec!["init", "-q", "-b", "main"];
        let flag = format.map(|f| format!("--object-format={f}"));
        if let Some(flag) = &flag {
            init.push(flag);
        }
        git(&root, &init);
        git(&root, &["config", "user.email", "t@t"]);
        git(&root, &["config", "user.name", "t"]);
        fs::write(root.join("a"), b"base\n").unwrap();
        fs::write(root.join(".gitignore"), b"ignored/\nnode_modules/\n").unwrap();
        git(&root, &["add", "-A"]);
        git(&root, &["commit", "-qm", "base"]);
        Self {
            store: Arc::new(LocalDir::new(&tmp.path().join("store")).unwrap()),
            registrar: Arc::new(InMemoryRegistrar::new("wt", 1, None).with_executor(EXECUTOR)),
            root,
            tmp,
        }
    }

    fn config(&self) -> CaptureConfig {
        let mut config = CaptureConfig::new("wt", 1, &self.root);
        config.executor = Some(EXECUTOR.to_owned());
        config
    }

    fn runner(&self, config: CaptureConfig) -> CadenceRunner {
        let engine = CaptureEngine::open(config, None).unwrap();
        let shipper = Arc::new(engine.shipper(self.store.clone(), self.registrar.clone()));
        CadenceRunner::new(engine, shipper)
    }

    /// A final flush that must say `complete` and seal the chain.
    fn final_flush(&self, config: CaptureConfig) {
        let result = self.runner(config).flush_final(None);
        assert!(result.complete(), "{result:?}");
        let head = self.registrar.head().unwrap();
        assert!(head.manifest.final_seal.is_some(), "the chain is sealed");
        assert!(
            !self.registrar.seals().is_empty(),
            "the registrar recorded it"
        );
    }

    /// A final flush that must not say `complete`; its reason and error text.
    fn incomplete_flush(&self, config: CaptureConfig) -> (String, String) {
        let result = self.runner(config).flush_final(None);
        let incomplete = result
            .incomplete
            .clone()
            .unwrap_or_else(|| panic!("the final flush said complete: {result:?}"));
        (incomplete.reason().to_owned(), incomplete.to_string())
    }

    fn export(&self,name: &str) {
        fn copy_tree(from:&Path,to:&Path) {
            fs::create_dir_all(to).unwrap();
            for entry in fs::read_dir(from).unwrap() {
                let entry=entry.unwrap();let target=to.join(entry.file_name());
                if entry.file_type().unwrap().is_dir() {copy_tree(&entry.path(),&target)}
                else if !target.exists() {fs::copy(entry.path(),target).unwrap();}
            }
        }
        let export=PathBuf::from("/exports").join(format!("export-{name}"));
        fs::create_dir_all(&export).unwrap();
        copy_tree(&self.tmp.path().join("store"),&export.join("store"));
        fs::write(export.join("chain.json"),serde_json::to_vec_pretty(&self.registrar.chain()).unwrap()).unwrap();
        fs::write(export.join("head.json"),serde_json::to_vec_pretty(&self.registrar.head().unwrap()).unwrap()).unwrap();
    }
    fn restore(&self, name: &str, harness: Option<PathBuf>) -> PathBuf {
        self.export(name);
        let out = self.tmp.path().join(name);
        Materializer::new(self.store.as_ref(), MaterializeTargets::new(&out, harness))
            .materialize(
                &self.registrar.head().unwrap().manifest,
                MaterializeClass::All,
            )
            .unwrap();
        out
    }
}



fn reflog_only_blob(reftable: bool) {
    let fx = Fixture::new();
    if reftable { git(&fx.root, &["refs", "migrate", "--ref-format=reftable"]); }
    let unique = b"unique user work kept only by a blob reflog\n";
    let blob = git_in(&fx.root, &["hash-object", "-w", "--stdin"], Some(unique));
    let next = git_in(&fx.root, &["hash-object", "-w", "--stdin"], Some(b"new blob\n"));
    git(&fx.root, &["update-ref", "--create-reflog", "refs/custom/work", &blob]);
    git(&fx.root, &["update-ref", "refs/custom/work", &next]);
    fx.final_flush(fx.config());
    let out = fx.restore(if reftable {"reflog-blob-reftable"} else {"reflog-blob-files"}, None);
    assert_eq!(git_out(&out, &["cat-file", "blob", &blob], None).stdout, unique);
}
#[test]
fn export_reflog_only_blob_files() { reflog_only_blob(false); }
#[test]
fn export_reflog_only_blob_reftable() { reflog_only_blob(true); }

#[test]
fn export_nested_linked_worktree() {
    let fx=Fixture::new();
    let child=fx.root.join("child");
    git(&fx.root, &["worktree", "add", "-qb", "child-branch", child.to_str().unwrap()]);
    let unique=b"unique work only staged in linked child\n";
    fs::write(child.join("staged.txt"),unique).unwrap();
    git(&child, &["add","staged.txt"]);
    let blob=git(&child,&["rev-parse",":staged.txt"]);
    fs::write(child.join("staged.txt"),b"newer unstaged child bytes\n").unwrap();
    fx.final_flush(fx.config());
    let out=fx.restore("nested-linked-worktree",None);
    assert_eq!(git_out(&out,&["cat-file","blob",&blob],None).stdout,unique);
    assert!(out.join(".git/worktrees/child/index").exists());
}

#[test]
fn export_nested_alternate() {
    let fx=Fixture::new();
    let oid=unreachable_commit(&fx.root,b"unique commit only used by nested alternate\n");
    let child=fx.root.join("child");
    fs::create_dir_all(&child).unwrap();
    git(&child,&["init","-q","-b","main"]);
    fs::create_dir_all(child.join(".git/objects/info")).unwrap();
    fs::write(child.join(".git/objects/info/alternates"),b"../../../.git/objects\n").unwrap();
    git(&child,&["update-ref","refs/heads/main",&oid]);
    fx.final_flush(fx.config());
    let out=fx.restore("nested-alternate",None);
    assert!(git_out(&out.join("child"),&["show","HEAD:unique.txt"],None).status.success());
}

fn wide(name: &str, secs: i64) {
    use std::time::{Duration, UNIX_EPOCH};
    let fx=Fixture::new();
    let d = Duration::new(secs.unsigned_abs(), 123_456_789);
    let at = if secs >= 0 { UNIX_EPOCH + d } else { UNIX_EPOCH - d };
    let ignored = fx.root.join("ignored/future.txt");
    fs::create_dir_all(ignored.parent().unwrap()).unwrap();
    fs::write(&ignored, b"future dated user work\n").unwrap();
    let dir = fx.root.join("ignored/dir");
    fs::create_dir_all(&dir).unwrap();
    let bulk = fx.root.join("node_modules/pkg/index.js");
    fs::create_dir_all(bulk.parent().unwrap()).unwrap();
    fs::write(&bulk, b"module.exports = 1;\n").unwrap();
    for p in [ignored.clone(), fx.root.join("a"), dir.clone(), bulk.clone()] {
        fs::File::options().read(true).open(&p).unwrap().set_times(fs::FileTimes::new().set_modified(at)).unwrap();
    }
    fx.final_flush(fx.config());
    let out = fx.restore(name, None);
    let meta = fs::symlink_metadata(out.join("ignored/future.txt")).unwrap();
    println!("{name}: restored mtime {}.{:09}", meta.mtime(), meta.mtime_nsec());
}
#[test]
fn export_wide_times_after_2262() { wide("wide-after", 10_000_000_000); }
#[test]
fn export_wide_times_before_1677() { wide("wide-before", -10_000_000_000); }
