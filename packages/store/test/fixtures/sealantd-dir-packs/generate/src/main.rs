//! Generates a capture store written by sealant-capture (sealantd PR #99, dir packs) for Mend's
//! reader to cross-check against: a format-1 head, a mixed head (format-2 workspace over the
//! format-1 bulk section it carries), and a format-2 head whose bulk section lists two dir packs.
use std::collections::BTreeMap;
use std::fs;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;

use sealant_capture::manifest::{DirFormat, FORMAT_DIR_OBJECTS, FORMAT_DIR_PACKS};
use sealant_capture::{
    BlobSink, CaptureConfig, CaptureEngine, CaptureKind, Class, InMemoryRegistrar, LocalDir,
    MaterializeClass, MaterializeTargets, Materializer, Registrar, SnapRequest,
};
use sha2::{Digest, Sha256};

fn git(root: &Path, args: &[&str]) {
    let out = Command::new("git").current_dir(root).args(args).output().unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
}

fn workspace(root: &Path) {
    fs::create_dir_all(root.join("src")).unwrap();
    git(root, &["init", "-q", "-b", "main"]);
    git(root, &["config", "user.email", "t@t"]);
    git(root, &["config", "user.name", "t"]);
    // No sample hooks: keep the workspace class small.
    let _ = fs::remove_dir_all(root.join(".git/hooks"));
    fs::write(root.join(".gitignore"), ".env\nnode_modules/\n").unwrap();
    fs::write(root.join("src/lib.rs"), "pub fn f() {}\n").unwrap();
    git(root, &["add", "-A"]);
    git(root, &["commit", "-q", "-m", "one"]);
    fs::write(root.join(".env"), "SECRET=1\n").unwrap();
    let nm = root.join("node_modules");
    for p in 0..3 {
        let name = format!("pkg{p}");
        let pkg = package_dir(root, p);
        fs::create_dir_all(pkg.join("lib/util")).unwrap();
        fs::create_dir_all(pkg.join("dist")).unwrap();
        fs::write(pkg.join("package.json"), format!("{{\"name\":\"{name}\"}}\n")).unwrap();
        fs::write(pkg.join("lib/index.js"), format!("module.exports = {p};\n")).unwrap();
        fs::write(pkg.join("lib/util/u.js"), format!("exports.u = {p};\n")).unwrap();
        fs::write(pkg.join("dist/d.cjs"), format!("exports.d = {p};\n").repeat(3)).unwrap();
        fs::set_permissions(pkg.join("dist"), fs::Permissions::from_mode(0o750)).unwrap();
        std::os::unix::fs::symlink(format!(".pnpm/{name}@1.0.0/node_modules/{name}"), nm.join(&name))
            .unwrap();
    }
    // An executable, an empty file, a hardlink pair and a file of several CDC chunks.
    let bin = nm.join(".bin");
    fs::create_dir_all(&bin).unwrap();
    fs::write(bin.join("tool"), "#!/bin/sh\necho tool\n").unwrap();
    fs::set_permissions(bin.join("tool"), fs::Permissions::from_mode(0o755)).unwrap();
    fs::write(nm.join(".modules.yaml"), "").unwrap();
    fs::hard_link(package_dir(root, 0).join("package.json"), nm.join(".pnpm/lock-copy.json")).unwrap();
    // Past the 4 MiB chunk cap, so the file is several chunks; zeros keep the fixture small.
    let mut big = vec![0_u8; 4 * 1024 * 1024 + 300 * 1024];
    big.extend_from_slice(b"the tail of a file several chunks long\n");
    fs::write(package_dir(root, 1).join("dist/blob.bin"), &big).unwrap();
}

fn package_dir(root: &Path, p: usize) -> PathBuf {
    let name = format!("pkg{p}");
    root.join("node_modules/.pnpm").join(format!("{name}@1.0.0")).join("node_modules").join(name)
}

/// Every path under `dir` (relative to `base`): kind, mode, and sha256 of content or link text.
fn listing(base: &Path, dir: &Path) -> serde_json::Value {
    let mut out = BTreeMap::new();
    for entry in walkdir::WalkDir::new(dir).min_depth(1) {
        let entry = entry.unwrap();
        let rel = entry.path().strip_prefix(base).unwrap().to_string_lossy().into_owned();
        let meta = fs::symlink_metadata(entry.path()).unwrap();
        let mode = meta.permissions().mode() & 0o7777;
        let value = if meta.file_type().is_symlink() {
            serde_json::json!({ "kind": "symlink", "target": fs::read_link(entry.path()).unwrap().to_string_lossy() })
        } else if meta.is_dir() {
            serde_json::json!({ "kind": "dir", "mode": mode })
        } else {
            let bytes = fs::read(entry.path()).unwrap();
            serde_json::json!({ "kind": "file", "mode": mode, "size": bytes.len(), "sha256": hex::encode(Sha256::digest(&bytes)), "nlink": meta.nlink() })
        };
        out.insert(rel, value);
    }
    serde_json::to_value(out).unwrap()
}

fn snap(engine: &mut CaptureEngine, class: Class, seq: u64) {
    engine.snap(SnapRequest { kind: CaptureKind::Checkpoint, class, seq }).unwrap();
}

fn main() {
    let out = PathBuf::from(std::env::args().nth(1).expect("output dir"));
    let tmp = std::env::temp_dir().join(format!("fixture-gen-{}", std::process::id()));
    let _ = fs::remove_dir_all(&tmp);
    fs::create_dir_all(&tmp).unwrap();
    let root = tmp.join("ws");
    workspace(&root);
    let store_dir = tmp.join("store");
    let sink = Arc::new(LocalDir::new(&store_dir).unwrap());
    let registrar = Arc::new(InMemoryRegistrar::new("wt-fixture", 1, None));
    let engine_for = |format: DirFormat, previous| {
        let mut config = CaptureConfig::new("wt-fixture", 1, &root);
        config.cpu_fraction = 1.0;
        config.dir_format = format;
        CaptureEngine::open(config, previous).unwrap()
    };
    let ship = |engine: &CaptureEngine| {
        let s: Arc<dyn BlobSink> = sink.clone();
        let r: Arc<dyn Registrar> = registrar.clone();
        engine.shipper(s, r).ship_pending().unwrap();
    };
    let mut heads = serde_json::Map::new();
    let mut record = |name: &str, root: &Path| {
        let head = registrar.head().unwrap();
        heads.insert(
            name.to_owned(),
            serde_json::json!({
                "capture_id": head.capture_id,
                "manifest_key": head.manifest_key,
                "bulk": listing(root, &root.join("node_modules")),
                "env_sha256": hex::encode(Sha256::digest(fs::read(root.join(".env")).unwrap())),
            }),
        );
        head
    };

    // 1. An executor that writes one object per directory.
    let mut old = engine_for(DirFormat::Objects, None);
    snap(&mut old, Class::Small, 1);
    snap(&mut old, Class::Bulk, 2);
    ship(&old);
    let head = record("v1", &root);
    assert_eq!(head.manifest.sections.bulk.section().unwrap().format, FORMAT_DIR_OBJECTS);
    drop(old);

    // 2. A dir-packs executor boots from that head (materialize, then open) and snaps small.
    let restore = tmp.join("restore");
    Materializer::new(sink.as_ref(), MaterializeTargets::new(&restore, None))
        .materialize(&head.manifest, MaterializeClass::All)
        .unwrap();
    let encoded = Materializer::new(sink.as_ref(), MaterializeTargets::new(&restore, None))
        .fetch_manifest(&head.manifest_key, &head.capture_id)
        .unwrap();
    fs::remove_dir_all(&root).unwrap();
    fs::rename(&restore, &root).unwrap();
    let mut new = engine_for(DirFormat::Packs, Some(encoded));
    new.seed_tips_from_repo().unwrap();
    fs::write(root.join(".env"), "SECRET=2\n").unwrap();
    snap(&mut new, Class::Small, 3);
    ship(&new);
    let head = record("mixed", &root);
    assert_eq!(head.manifest.sections.workspace.format, FORMAT_DIR_PACKS);
    assert_eq!(head.manifest.sections.bulk.section().unwrap().format, FORMAT_DIR_OBJECTS);

    // 3. Two bulk edits: every dir object packed anew, then the edited path in a second pack.
    fs::write(package_dir(&root, 2).join("lib/index.js"), "edited once\n").unwrap();
    snap(&mut new, Class::Bulk, 4);
    ship(&new);
    fs::write(package_dir(&root, 0).join("lib/util/u.js"), "edited twice\n").unwrap();
    snap(&mut new, Class::Bulk, 5);
    ship(&new);
    let head = record("v2", &root);
    let bulk = head.manifest.sections.bulk.section().unwrap();
    assert_eq!(bulk.format, FORMAT_DIR_PACKS);
    assert_eq!(bulk.dir_packs.len(), 2, "{bulk:?}");

    // Copy every object the three heads' workspace and bulk sections need (and the manifests);
    // the git packs stay behind, Mend's reader never opens them.
    let git_packs: std::collections::HashSet<String> = registrar
        .chain()
        .iter()
        .flat_map(|h| h.manifest.sections.git.packs.iter().flat_map(|k| [k.clone(), format!("{k}.idx")]))
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
    fs::write(out.join("heads.json"), serde_json::to_string_pretty(&heads).unwrap() + "\n").unwrap();
    fs::remove_dir_all(&tmp).unwrap();
}
