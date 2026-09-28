//! Generates a capture store written by sealant-capture whose names and symlink texts are not
//! UTF-8, or hold characters of the key escape range (sealantd `tree.rs`), for Mend's reader to
//! cross-check against: ignored files in the workspace class, a bulk tree with a hardlink pair
//! and a symlink, and a tracked file the worktree metadata overlay names by `raw_path`. Every
//! path is recorded as the hex of its bytes.
use std::collections::BTreeMap;
use std::ffi::OsStr;
use std::fs;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;

use sealant_capture::manifest::DirFormat;
use sealant_capture::{
    BlobSink, CaptureConfig, CaptureEngine, CaptureKind, Class, InMemoryRegistrar, LocalDir,
    Registrar, SnapRequest,
};
use sha2::{Digest, Sha256};

fn git(root: &Path, args: &[&[u8]]) {
    let out = Command::new("git")
        .current_dir(root)
        .args(args.iter().map(|a| OsStr::from_bytes(a)))
        .output()
        .unwrap();
    assert!(out.status.success(), "git: {}", String::from_utf8_lossy(&out.stderr));
}

/// Set `path`'s mtime (not following a symlink) to `ns` nanoseconds since the epoch.
fn set_mtime(path: &Path, ns: i64) {
    let stamp = format!("@{}.{:09}", ns / 1_000_000_000, ns % 1_000_000_000);
    let out = Command::new("touch")
        .args(["-h", "-m", "-d", &stamp])
        .arg(path)
        .output()
        .unwrap();
    assert!(out.status.success(), "touch: {}", String::from_utf8_lossy(&out.stderr));
}

/// Every path under `dir`, deepest first (a directory after what it holds), each on its own
/// mtime: `base + i` nanoseconds, odd digits a double rounds away.
fn stamp_mtimes(dir: &Path, base: i64) {
    let mut paths: Vec<PathBuf> = walkdir::WalkDir::new(dir)
        .min_depth(1)
        .contents_first(true)
        .into_iter()
        .map(|entry| entry.unwrap().into_path())
        .collect();
    paths.push(dir.to_path_buf());
    for (i, path) in paths.iter().enumerate() {
        set_mtime(path, base + i64::try_from(i).unwrap() * 1_000_003);
    }
}

fn at(root: &Path, rel: &[u8]) -> PathBuf {
    root.join(OsStr::from_bytes(rel))
}

/// `x` + U+10FFA0 + `y`: valid UTF-8 whose middle character is in the escape range.
const ESCAPE_RANGE: &[u8] = b"x\xf4\x8f\xbe\xa0y";

fn workspace(root: &Path) {
    fs::create_dir_all(root).unwrap();
    git(root, &[b"init", b"-q", b"-b", b"main"]);
    git(root, &[b"config", b"user.email", b"t@t"]);
    git(root, &[b"config", b"user.name", b"t"]);
    let _ = fs::remove_dir_all(root.join(".git/hooks"));
    fs::write(root.join(".gitignore"), "ignored/\nnode_modules/\n").unwrap();
    // A tracked file whose name is not UTF-8: the metadata overlay names it by `raw_path`.
    fs::write(at(root, b"tracked-\xe9.txt"), "tracked\n").unwrap();
    fs::set_permissions(at(root, b"tracked-\xe9.txt"), fs::Permissions::from_mode(0o640))
        .unwrap();
    git(root, &[b"add", b"-A"]);
    git(root, &[b"commit", b"-q", b"-m", b"one"]);

    // The workspace class: ignored files and links.
    let ignored = root.join("ignored");
    fs::create_dir_all(at(&ignored, b"dir-\xfe")).unwrap();
    fs::write(at(&ignored, b"caf\xe9"), "latin-1 name\n").unwrap();
    fs::write(at(&ignored, ESCAPE_RANGE), "escape-range name\n").unwrap();
    fs::write(at(&ignored, b"dir-\xfe/inner"), "inside a dir whose name is not UTF-8\n").unwrap();
    std::os::unix::fs::symlink(OsStr::from_bytes(b"\xff"), at(&ignored, b"link-ff")).unwrap();
    std::os::unix::fs::symlink(OsStr::from_bytes(ESCAPE_RANGE), at(&ignored, b"link-escape"))
        .unwrap();

    // The bulk class: a package dir, a hardlink pair and a symlink, all named in raw bytes.
    let nm = root.join("node_modules");
    fs::create_dir_all(at(&nm, b"pkg-\xe9")).unwrap();
    fs::write(at(&nm, b"pkg-\xe9/index.js"), "module.exports = 1;\n").unwrap();
    fs::hard_link(at(&nm, b"pkg-\xe9/index.js"), at(&nm, b"copy-\xff.js")).unwrap();
    std::os::unix::fs::symlink(OsStr::from_bytes(b"pkg-\xe9"), at(&nm, b"link-\xe9")).unwrap();

    stamp_mtimes(&ignored, 1_790_544_318_479_764_701);
    stamp_mtimes(&nm, 1_790_544_318_479_864_703);
}

/// Every path under `dir` (relative to `base`), keyed by the hex of its bytes: kind, mode, and
/// sha256 of content or the hex of the link text.
fn listing(base: &Path, dir: &Path) -> serde_json::Value {
    let mut out = BTreeMap::new();
    for entry in walkdir::WalkDir::new(dir).min_depth(1) {
        let entry = entry.unwrap();
        let rel = hex::encode(entry.path().strip_prefix(base).unwrap().as_os_str().as_bytes());
        let meta = fs::symlink_metadata(entry.path()).unwrap();
        let mode = meta.permissions().mode() & 0o7777;
        let mtime_ns = (meta.mtime() * 1_000_000_000 + meta.mtime_nsec()).to_string();
        let value = if meta.file_type().is_symlink() {
            let target = fs::read_link(entry.path()).unwrap();
            serde_json::json!({ "kind": "symlink", "target": hex::encode(target.as_os_str().as_bytes()), "mtime_ns": mtime_ns })
        } else if meta.is_dir() {
            serde_json::json!({ "kind": "dir", "mode": mode, "mtime_ns": mtime_ns })
        } else {
            let bytes = fs::read(entry.path()).unwrap();
            serde_json::json!({ "kind": "file", "mode": mode, "size": bytes.len(), "sha256": hex::encode(Sha256::digest(&bytes)), "nlink": meta.nlink(), "mtime_ns": mtime_ns })
        };
        out.insert(rel, value);
    }
    serde_json::to_value(out).unwrap()
}

fn main() {
    let out = PathBuf::from(std::env::args().nth(1).expect("output dir"));
    let tmp = std::env::temp_dir().join(format!("fixture-gen-raw-{}", std::process::id()));
    let _ = fs::remove_dir_all(&tmp);
    fs::create_dir_all(&tmp).unwrap();
    let root = tmp.join("ws");
    workspace(&root);
    let store_dir = tmp.join("store");
    let sink = Arc::new(LocalDir::new(&store_dir).unwrap());
    let registrar = Arc::new(InMemoryRegistrar::new("wt-raw", 1, None));
    let mut config = CaptureConfig::new("wt-raw", 1, &root);
    config.cpu_fraction = 1.0;
    config.dir_format = DirFormat::Packs;
    let mut engine = CaptureEngine::open(config, None).unwrap();
    engine.snap(SnapRequest { kind: CaptureKind::Checkpoint, class: Class::Small, seq: 1 }).unwrap();
    engine.snap(SnapRequest { kind: CaptureKind::Checkpoint, class: Class::Bulk, seq: 2 }).unwrap();
    let s: Arc<dyn BlobSink> = sink.clone();
    let r: Arc<dyn Registrar> = registrar.clone();
    engine.shipper(s, r).ship_pending().unwrap();
    let head = registrar.head().unwrap();
    let meta = head.manifest.sections.workspace.worktree_meta.as_ref();
    assert!(meta.is_some(), "the workspace section carries the metadata overlay");
    let record = serde_json::json!({
        "capture_id": head.capture_id,
        "manifest_key": head.manifest_key,
        "tree": listing(&root, &root.join("ignored")),
        "bulk": listing(&root, &root.join("node_modules")),
    });

    // Every object the head's workspace and bulk sections need, and the manifest; the git packs
    // stay behind, Mend's reader never opens them.
    let git_packs: std::collections::HashSet<String> = head
        .manifest
        .sections
        .git
        .packs
        .iter()
        .flat_map(|k| [k.clone(), format!("{k}.idx")])
        .collect();
    let _ = fs::remove_dir_all(out.join("store"));
    for entry in walkdir::WalkDir::new(&store_dir).min_depth(1) {
        let entry = entry.unwrap();
        if !entry.file_type().is_file() {
            continue;
        }
        let key = entry.path().strip_prefix(&store_dir).unwrap().to_string_lossy().into_owned();
        if git_packs.contains(&key) || key.ends_with(".tmp") {
            continue;
        }
        let to = out.join("store").join(&key);
        fs::create_dir_all(to.parent().unwrap()).unwrap();
        fs::copy(entry.path(), &to).unwrap();
    }
    fs::write(out.join("head.json"), serde_json::to_string_pretty(&record).unwrap() + "\n").unwrap();
    fs::remove_dir_all(&tmp).unwrap();
}
