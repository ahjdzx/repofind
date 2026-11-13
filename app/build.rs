//! 本地 embedding 引擎 (ONNX Runtime) 只在有预编译库的平台上编译:
//! Apple 芯片的 Mac、x86_64 / arm64 Linux、x86_64 / arm64 Windows。
//! 浏览器和 Intel Mac 上没有, 那边只能用本地服务或外部 API。
//! 条件要和 Cargo.toml 里 ort 等依赖的 target 条件保持一致。

fn main() {
    println!("cargo::rustc-check-cfg=cfg(local_engine)");
    let arch = std::env::var("CARGO_CFG_TARGET_ARCH").unwrap_or_default();
    let os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let unsupported = arch == "wasm32" || (os == "macos" && arch == "x86_64");
    if !unsupported {
        println!("cargo::rustc-cfg=local_engine");
    }
}
