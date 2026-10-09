fn main() {
    println!("cargo:rerun-if-changed=Info.plist");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        let manifest = std::env::var("CARGO_MANIFEST_DIR").expect("Cargo manifest directory");
        let plist = std::path::Path::new(&manifest).join("Info.plist");
        // Embed microphone usage text in the CLI Mach-O. macOS retains control
        // of the actual microphone permission prompt and approval.
        println!(
            "cargo:rustc-link-arg=-Wl,-sectcreate,__TEXT,__info_plist,{}",
            plist.display()
        );
    }
}
