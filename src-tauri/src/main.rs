#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if std::env::args().any(|a| a == "--daemon") {
        if let Err(e) = hangard::run_default() {
            eprintln!("hangard failed: {e:#}");
            std::process::exit(1);
        }
        return;
    }
    hangar_lib::run()
}
