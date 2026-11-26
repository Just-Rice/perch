//! On Windows targets: gives roost.exe its icon (drawn by src/icon.rs, the same drawing as the tray's), its
//! version information and its manifest (Windows 10/11, per-monitor DPI, long paths).
#[allow(dead_code)]
#[path = "src/icon.rs"]
mod icon;

fn main() {
    println!("cargo:rerun-if-changed=src/icon.rs");
    println!("cargo:rerun-if-changed=res/roost.manifest");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") { return; }
    let out = std::path::PathBuf::from(std::env::var("OUT_DIR").unwrap());
    let ico = out.join("roost.ico");
    std::fs::write(&ico, icon::ico(icon::Variant::Normal)).expect("icon");
    let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("res").join("roost.manifest");
    let version = env!("CARGO_PKG_VERSION");
    let nums: Vec<&str> = version.split(['.', '-']).take(3).collect();
    let comma = format!("{},{},{},0", nums.first().unwrap_or(&"0"), nums.get(1).unwrap_or(&"0"), nums.get(2).unwrap_or(&"0"));
    let rc = format!(r#"#pragma code_page(65001)
1 ICON "{ico}"
1 24 "{manifest}"
1 VERSIONINFO
FILEVERSION {comma}
PRODUCTVERSION {comma}
FILEOS 0x40004
FILETYPE 0x1
BEGIN
  BLOCK "StringFileInfo"
  BEGIN
    BLOCK "040904B0"
    BEGIN
      VALUE "CompanyName", "Roost"
      VALUE "FileDescription", "Roost"
      VALUE "FileVersion", "{version}"
      VALUE "InternalName", "roost"
      VALUE "LegalCopyright", "Apache License 2.0"
      VALUE "OriginalFilename", "roost.exe"
      VALUE "ProductName", "Roost"
      VALUE "ProductVersion", "{version}"
    END
  END
  BLOCK "VarFileInfo"
  BEGIN
    VALUE "Translation", 0x409, 1200
  END
END
"#, ico = ico.display().to_string().replace('\\', "\\\\"), manifest = manifest.display().to_string().replace('\\', "\\\\"));
    let rc_path = out.join("roost.rc");
    std::fs::write(&rc_path, rc).expect("rc");
    if let Err(e) = embed_resource::compile(&rc_path, embed_resource::NONE).manifest_required() {
        println!("cargo:warning=no icon or manifest in roost.exe: {e}");
    }
}
