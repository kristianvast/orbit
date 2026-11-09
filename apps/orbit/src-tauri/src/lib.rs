use rand::RngCore;
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Manager, RunEvent, State};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

const READY_LINE_PREFIX: &str = "ORION_READY ";
const MAX_AUTO_RESTARTS: u32 = 5;
const STDERR_TAIL_LINES: usize = 20;

#[derive(Clone, Serialize)]
pub struct OrionEndpoint {
  pub url: String,
  pub token: String,
}

#[derive(Deserialize)]
struct ReadyPayload {
  port: u16,
}

#[derive(Default)]
pub struct OrionSidecarState {
  pub endpoint: Mutex<Option<OrionEndpoint>>,
  pub child: Mutex<Option<CommandChild>>,
  /// Why the sidecar is not running (spawn failure or exit plus its last stderr lines).
  pub stopped: Mutex<Option<String>>,
  pub restarts: AtomicU32,
  pub shutting_down: AtomicBool,
}

fn set_stopped(app: &AppHandle, reason: Option<String>) {
  let state = app.state::<OrionSidecarState>();
  if let Ok(mut guard) = state.stopped.lock() {
    *guard = reason;
  };
}

fn generate_hex_token() -> String {
  let mut bytes = [0u8; 32];
  rand::thread_rng().fill_bytes(&mut bytes);
  let mut out = String::with_capacity(64);
  for b in bytes {
    out.push_str(&format!("{:02x}", b));
  }
  out
}

fn parse_ready_port(line: &str) -> Option<u16> {
  let trimmed = line.trim();
  let rest = trimmed.strip_prefix(READY_LINE_PREFIX)?;
  let parsed: ReadyPayload = serde_json::from_str(rest).ok()?;
  if parsed.port > 0 {
    Some(parsed.port)
  } else {
    None
  }
}

fn spawn_orion_sidecar(app: &AppHandle) -> Result<(), String> {
  let token = generate_hex_token();
  let data_dir = app
    .path()
    .app_data_dir()
    .map_err(|e| format!("failed to resolve app data dir: {e}"))?;
  std::fs::create_dir_all(&data_dir)
    .map_err(|e| format!("failed to create app data dir: {e}"))?;

  let data_dir_str = data_dir.to_string_lossy().to_string();
  let mut args = vec![
    "--port".to_string(),
    "0".to_string(),
    "--token".to_string(),
    token.clone(),
    "--data-dir".to_string(),
    data_dir_str,
    "--parent-watch".to_string(),
  ];

  if std::env::var("ORION_MOCK_MODEL").ok().as_deref() == Some("1") {
    args.push("--mock-model".to_string());
  }
  if std::env::var("ORION_SEED").ok().as_deref() == Some("1") {
    args.push("--seed".to_string());
  }

  let sidecar_cmd = app
    .shell()
    .sidecar("orion")
    .map_err(|e| format!("failed to create sidecar command: {e}"))?
    .args(args);

  let (mut rx, child) = sidecar_cmd
    .spawn()
    .map_err(|e| format!("failed to spawn orion sidecar: {e}"))?;

  {
    let state = app.state::<OrionSidecarState>();
    if let Ok(mut guard) = state.child.lock() {
      *guard = Some(child);
    };
  }
  set_stopped(app, None);

  let app_handle = app.clone();
  tauri::async_runtime::spawn(async move {
    let mut stderr_tail: VecDeque<String> = VecDeque::with_capacity(STDERR_TAIL_LINES);
    while let Some(event) = rx.recv().await {
      match event {
        CommandEvent::Stdout(line_bytes) => {
          let line = String::from_utf8_lossy(&line_bytes);
          if let Some(port) = parse_ready_port(&line) {
            let endpoint = OrionEndpoint {
              url: format!("ws://127.0.0.1:{port}/ws"),
              token: token.clone(),
            };
            let state = app_handle.state::<OrionSidecarState>();
            if let Ok(mut guard) = state.endpoint.lock() {
              *guard = Some(endpoint);
            };
            state.restarts.store(0, Ordering::SeqCst);
          }
        }
        CommandEvent::Stderr(line_bytes) => {
          let line = String::from_utf8_lossy(&line_bytes).trim_end().to_string();
          eprintln!("{line}");
          if stderr_tail.len() == STDERR_TAIL_LINES {
            stderr_tail.pop_front();
          }
          stderr_tail.push_back(line);
        }
        CommandEvent::Terminated(payload) => {
          on_sidecar_exit(&app_handle, payload.code, &stderr_tail);
          break;
        }
        _ => {}
      }
    }
  });

  Ok(())
}

/// Clears the dead endpoint and restarts Orion with backoff, unless the app is quitting or
/// Orion keeps dying; then the reason stays in `stopped` for the UI to show.
fn on_sidecar_exit(app: &AppHandle, code: Option<i32>, stderr_tail: &VecDeque<String>) {
  let state = app.state::<OrionSidecarState>();
  if let Ok(mut guard) = state.endpoint.lock() {
    *guard = None;
  };
  if let Ok(mut guard) = state.child.lock() {
    *guard = None;
  };
  if state.shutting_down.load(Ordering::SeqCst) {
    return;
  }

  let tail: Vec<&str> = stderr_tail.iter().map(String::as_str).collect();
  let reason = match code {
    Some(code) => format!("Orion exited with code {code}"),
    None => "Orion was stopped by a signal".to_string(),
  };
  let reason = if tail.is_empty() { reason } else { format!("{reason}\n{}", tail.join("\n")) };
  eprintln!("orbit: {reason}");

  let attempt = state.restarts.fetch_add(1, Ordering::SeqCst);
  if attempt >= MAX_AUTO_RESTARTS {
    set_stopped(app, Some(reason));
    return;
  }
  let delay = Duration::from_millis((500u64 << attempt).min(8_000));
  let app = app.clone();
  std::thread::spawn(move || {
    std::thread::sleep(delay);
    let state = app.state::<OrionSidecarState>();
    let already_running = state.child.lock().map(|guard| guard.is_some()).unwrap_or(false);
    if state.shutting_down.load(Ordering::SeqCst) || already_running {
      return;
    }
    if let Err(err) = spawn_orion_sidecar(&app) {
      eprintln!("orbit: {err}");
      set_stopped(&app, Some(err));
    }
  });
}

// Commands in lib.rs must not be `pub` (Tauri glue-code limitation, E0255).
/// Errors start with `starting` (keep polling) or `stopped: <reason>` (show it to the farmer).
#[tauri::command]
fn orion_endpoint(state: State<'_, OrionSidecarState>) -> Result<OrionEndpoint, String> {
  if let Some(endpoint) = state.endpoint.lock().ok().and_then(|guard| guard.clone()) {
    return Ok(endpoint);
  }
  match state.stopped.lock().ok().and_then(|guard| guard.clone()) {
    Some(reason) => Err(format!("stopped: {reason}")),
    None => Err("starting".to_string()),
  }
}

#[tauri::command]
fn orion_restart(app: AppHandle, state: State<'_, OrionSidecarState>) -> Result<(), String> {
  if state.child.lock().map(|guard| guard.is_some()).unwrap_or(false) {
    return Ok(());
  }
  state.restarts.store(0, Ordering::SeqCst);
  spawn_orion_sidecar(&app).inspect_err(|err| set_stopped(&app, Some(err.clone())))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  #[allow(unused_mut)]
  let mut builder = tauri::Builder::default();
  // Must be the first plugin: a second launch focuses the running window and exits
  // before it can spawn a second Orion sidecar against the same data dir.
  #[cfg(desktop)]
  {
    builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
      if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
      }
    }));
  }

  let app = builder
    .plugin(tauri_plugin_shell::init())
    .plugin(tauri_plugin_updater::Builder::new().build())
    .plugin(tauri_plugin_process::init())
    .manage(OrionSidecarState::default())
    .setup(|app| {
      if let Err(err) = spawn_orion_sidecar(app.handle()) {
        eprintln!("orbit: {err}");
        set_stopped(app.handle(), Some(err));
      }
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![orion_endpoint, orion_restart])
    .build(tauri::generate_context!())
    .expect("error while building Orbit Tauri application");

  app.run(|app_handle, event| {
    if let RunEvent::Exit = event {
      let state = app_handle.state::<OrionSidecarState>();
      state.shutting_down.store(true, Ordering::SeqCst);
      if let Ok(mut guard) = state.child.lock() {
        if let Some(child) = guard.take() {
          let _ = child.kill();
        }
      };
    }
  });
}
