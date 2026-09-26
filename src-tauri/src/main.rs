#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("tasks") {
        if let Err(e) = hangar_lib::tasks::cli(&args[1..]) {
            eprintln!("{e}");
            std::process::exit(1);
        }
        return;
    }
    if args.first().map(String::as_str) == Some("--daemon") {
        if let Err(e) = hangard::run_default(env!("HANGAR_BUILD_ID")) {
            eprintln!("hangard failed: {e:#}");
            std::process::exit(1);
        }
        return;
    }
    hangar_lib::run()
}
