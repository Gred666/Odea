fn main() {
    println!("cargo:rustc-check-cfg=cfg(desktop)");
    println!("cargo:rustc-check-cfg=cfg(mobile)");

    // 纯领域单测不需要窗口资源，也不链接 WebView2；桌面构建和类型导出
    // 仍走标准 Tauri build script。
    if std::env::var_os("CARGO_FEATURE_DESKTOP_RUNTIME").is_some()
        || std::env::var_os("CARGO_FEATURE_TYPEGEN").is_some()
    {
        tauri_build::build();
    }

    // 导出 TS 绑定的 example（export_bindings）也链进了对话框插件，它要 comctl32 v6 的 TaskDialogIndirect；
    // tauri-build 只给主程序嵌应用清单，example 一跑就 STATUS_ENTRYPOINT_NOT_FOUND（0xc0000139）。
    // 给 example 自己嵌一份只声明 comctl32 v6 的清单
    if std::env::var_os("CARGO_FEATURE_TYPEGEN").is_some()
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc")
    {
        println!("cargo:rustc-link-arg-examples=/MANIFEST:EMBED");
        println!(
            "cargo:rustc-link-arg-examples=/MANIFESTDEPENDENCY:type='win32' name='Microsoft.Windows.Common-Controls' version='6.0.0.0' processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'"
        );
    }
}
