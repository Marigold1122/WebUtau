use axum::{
    body::Body,
    extract::{Request, State},
    http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode},
    response::{IntoResponse, Response},
    routing::any,
    Router,
};
use futures_util::StreamExt;
use std::{net::SocketAddr, path::PathBuf};
use tauri::{path::BaseDirectory, AppHandle, Manager};
use tokio::net::TcpListener;
use tower_http::services::ServeDir;

const BACKEND_BASE: &str = "http://127.0.0.1:5000";
const SEEDVC_BASE: &str = "http://127.0.0.1:5001";

#[derive(Clone)]
struct ProxyState {
    client: reqwest::Client,
}

pub struct LocalServerHandle {
    pub port: u16,
}

pub fn resolve_frontend_dist(app: &AppHandle) -> Option<PathBuf> {
    let candidates: Vec<PathBuf> = {
        let mut paths = Vec::new();
        if let Ok(p) = app.path().resolve("dist", BaseDirectory::Resource) {
            paths.push(p);
        }
        if let Ok(p) = app.path().resolve("frontend", BaseDirectory::Resource) {
            paths.push(p);
        }
        let dev_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../dist");
        paths.push(dev_dir);
        paths
    };

    candidates.into_iter().find(|p| p.is_dir())
}

pub async fn spawn_local_server(dist_dir: PathBuf) -> Result<LocalServerHandle, String> {
    let client = reqwest::Client::builder()
        .no_proxy()
        .build()
        .map_err(|err| format!("failed to build reqwest client: {err}"))?;
    let proxy_state = ProxyState { client };

    let serve_dir = ServeDir::new(&dist_dir).append_index_html_on_directories(true);

    let app = Router::new()
        .route("/api/*rest", any(proxy_backend))
        .route("/seedvc/api/*rest", any(proxy_seedvc))
        .fallback_service(serve_dir)
        .with_state(proxy_state);

    let listener = TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0)))
        .await
        .map_err(|err| format!("failed to bind local server: {err}"))?;
    let port = listener
        .local_addr()
        .map_err(|err| format!("failed to read local server addr: {err}"))?
        .port();

    tokio::spawn(async move {
        if let Err(err) = axum::serve(listener, app).await {
            eprintln!("[local_server] axum serve error: {err}");
        }
    });

    Ok(LocalServerHandle { port })
}

async fn proxy_backend(State(state): State<ProxyState>, req: Request) -> Response {
    proxy_request(state, req, BACKEND_BASE, "").await
}

async fn proxy_seedvc(State(state): State<ProxyState>, req: Request) -> Response {
    // 前端调 /seedvc/api/foo → 后端 http://127.0.0.1:5001/api/foo
    proxy_request(state, req, SEEDVC_BASE, "/seedvc").await
}

async fn proxy_request(
    state: ProxyState,
    req: Request,
    target_base: &str,
    strip_prefix: &str,
) -> Response {
    let (parts, body) = req.into_parts();
    let mut path_and_query = parts
        .uri
        .path_and_query()
        .map(|pq| pq.as_str().to_string())
        .unwrap_or_else(|| "/".to_string());
    if !strip_prefix.is_empty() && path_and_query.starts_with(strip_prefix) {
        path_and_query = path_and_query[strip_prefix.len()..].to_string();
        if path_and_query.is_empty() {
            path_and_query.push('/');
        }
    }
    let target_url = format!("{target_base}{path_and_query}");

    let body_bytes = match axum::body::to_bytes(body, usize::MAX).await {
        Ok(bytes) => bytes,
        Err(err) => {
            return error_response(
                StatusCode::BAD_GATEWAY,
                format!("failed to read request body: {err}"),
            );
        }
    };

    let method = match reqwest_method(&parts.method) {
        Some(m) => m,
        None => {
            return error_response(
                StatusCode::METHOD_NOT_ALLOWED,
                "unsupported HTTP method".into(),
            );
        }
    };

    let mut request_builder = state.client.request(method, &target_url);
    for (name, value) in parts.headers.iter() {
        if matches!(name.as_str(), "host" | "connection" | "content-length") {
            continue;
        }
        if let Ok(header_value) = reqwest::header::HeaderValue::from_bytes(value.as_bytes()) {
            request_builder = request_builder.header(name.as_str(), header_value);
        }
    }
    if !body_bytes.is_empty() {
        request_builder = request_builder.body(body_bytes.to_vec());
    }

    let upstream = match request_builder.send().await {
        Ok(res) => res,
        Err(err) => {
            return error_response(
                StatusCode::BAD_GATEWAY,
                format!("upstream request failed: {err}"),
            );
        }
    };

    let status = StatusCode::from_u16(upstream.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    let mut headers = HeaderMap::new();
    for (name, value) in upstream.headers().iter() {
        if matches!(
            name.as_str(),
            "transfer-encoding" | "connection" | "content-length"
        ) {
            continue;
        }
        if let (Ok(name), Ok(value)) = (
            HeaderName::from_bytes(name.as_str().as_bytes()),
            HeaderValue::from_bytes(value.as_bytes()),
        ) {
            headers.append(name, value);
        }
    }

    let stream = upstream
        .bytes_stream()
        .map(|chunk| chunk.map_err(|err| std::io::Error::new(std::io::ErrorKind::Other, err)));
    let body = Body::from_stream(stream);
    let mut response = Response::new(body);
    *response.status_mut() = status;
    *response.headers_mut() = headers;
    response
}

fn error_response(status: StatusCode, message: String) -> Response {
    eprintln!("[local_server] {status}: {message}");
    let mut res = (status, message).into_response();
    *res.status_mut() = status;
    res
}

fn reqwest_method(method: &Method) -> Option<reqwest::Method> {
    reqwest::Method::from_bytes(method.as_str().as_bytes()).ok()
}
