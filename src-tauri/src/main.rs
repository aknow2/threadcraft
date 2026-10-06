#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if treadcraft_lib::run().is_err() {
        eprintln!("treadcraft could not start. Check application data directory permissions.");
        std::process::exit(1);
    }
}
