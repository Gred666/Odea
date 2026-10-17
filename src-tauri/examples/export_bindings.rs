fn main() {
    let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../src/lib/bindings.ts");
    odea_lib::export_typescript_bindings(&path);
    println!("generated {}", path.display());
}
