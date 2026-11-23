fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "terminal_open",
            "terminal_write",
            "terminal_resize",
            "terminal_close",
            "get_board",
            "create_thread",
            "fork_thread",
            "update_thread",
            "mutate_board",
            "refresh_threads",
            "read_thread",
            "mark_thread_read",
            "open_in_zed",
            "send_message",
            "list_models",
            "stop_message",
            "steer_message",
            "respond_to_request",
        ]),
    ))
    .expect("Tauri build configuration failed");
}
