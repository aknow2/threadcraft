#[tokio::main(flavor = "current_thread")]
async fn main() {
    let path = std::env::args_os()
        .nth(1)
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| "codex".into());
    match treadcraft_lib::codex::list_threads(&path, "probe").await {
        Ok(threads) => println!(
            "Retrieved {} metadata records (including archived); no contents logged.",
            threads.len()
        ),
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    }
}
