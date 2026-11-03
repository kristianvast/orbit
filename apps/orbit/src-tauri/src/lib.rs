use rand::RngCore;
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, RunEvent, State};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

const READY_LINE_PREFIX: &str = "ORION_READY ";

#[derive(Clone, Serialize)]
pub struct OrionEndpoint {
  pub url: String,
  pub token: String,
}

#[derive(Deserialize)]
struct ReadyPayload {
  port: u16,
}

pub struct OrionSidecarState {
  pub endpoint: Mutex<Option<OrionEndpoint>>,
  pub child: Mutex<Option<CommandChild>>,
}

impl Default for OrionSidecarState {
  fn default() -> Self {
    Self {
      endpoint: Mutex::new(None),
      child: Mutex::new(None),
    }
  }
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
  ];

  if std::env::var("ORION_MOCK_MODEL").ok().as_deref() == Some("1") {
    args.push("--mock-model".to_string());
  }
  if std::env::var("ORION_SEED").ok().as_deref() == Some("1") {
    args.push("--seed".to_string());
  }

  let sidecar_cmd = app
    .shell()
    .sidecar("binaries/orion")
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

  let app_handle = app.clone();
  tauri::async_runtime::spawn(async move {
    while let Some(event) = rx.recv().await {
      if let CommandEvent::Stdout(line_bytes) = event {
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
          break;
        }
      }
    }
  });

  Ok(())
}

// Commands in lib.rs must not be `pub` (Tauri glue-code limitation, E0255).
#[tauri::command]
fn orion_endpoint(state: State<'_, OrionSidecarState>) -> Result<OrionEndpoint, String> {
  let guard = state
    .endpoint
    .lock()
    .map_err(|_| "sidecar state lock poisoned".to_string())?;
  guard
    .clone()
    .ok_or_else(|| "Orion sidecar is still starting".to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  let app = tauri::Builder::default()
    .plugin(tauri_plugin_shell::init())
    .plugin(tauri_plugin_updater::Builder::new().build())
    .plugin(tauri_plugin_process::init())
    .manage(OrionSidecarState::default())
    .setup(|app| {
      if let Err(err) = spawn_orion_sidecar(app.handle()) {
        eprintln!("orbit: sidecar startup warning: {err}");
      }
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![orion_endpoint])
    .build(tauri::generate_context!())
    .expect("error while building Orbit Tauri application");

  app.run(|app_handle, event| {
    if let RunEvent::Exit = event {
      let state = app_handle.state::<OrionSidecarState>();
      if let Ok(mut guard) = state.child.lock() {
        if let Some(child) = guard.take() {
          let _ = child.kill();
        }
      };
    }
  });
}
