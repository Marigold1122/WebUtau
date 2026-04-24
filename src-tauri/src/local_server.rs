use axum::{
    body::Body,
    extract::{Request, State},
    http::{header, HeaderMap, HeaderName, HeaderValue, Method, StatusCode},
    response::{IntoResponse, Response},
    routing::any,
    Router,
};
use futures_util::StreamExt;
use std::{net::SocketAddr, path::PathBuf};
use tauri::AppHandle;
use tokio::net::TcpListener;
use tower::ServiceExt;
use tower_http::services::ServeDir;

const BACKEND_BASE: &str = "http://127.0.0.1:38510";
const SEEDVC_BASE: &str = "http://127.0.0.1:38511";

#[derive(Clone)]
struct AppState {
    client: reqwest::Client,
    app: AppHandle,
    // 开发态回退：若二进制未嵌入前端（例如 `tauri dev` 前未构建 dist），
    // 退而从工作区 ../dist/ 读取；生产构建永远命中 asset_resolver。
    dev_dist: Option<PathBuf>,
}

pub struct LocalServerHandle {
    pub port: u16,
}

pub async fn spawn_local_server(app: AppHandle) -> Result<LocalServerHandle, String> {
    let client = reqwest::Client::builder()
        .no_proxy()
        .build()
        .map_err(|err| format!("failed to build reqwest client: {err}"))?;

    let dev_dist = {
        let p = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../dist");
        p.is_dir().then_some(p)
    };

    let state = AppState {
        client,
        app,
        dev_dist,
    };

    let router = Router::new()
        .route("/api/*rest", any(proxy_backend))
        .route("/seedvc/api/*rest", any(proxy_seedvc))
        .fallback(serve_asset)
        .with_state(state);

    let listener = TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0)))
        .await
        .map_err(|err| format!("failed to bind local server: {err}"))?;
    let port = listener
        .local_addr()
        .map_err(|err| format!("failed to read local server addr: {err}"))?
        .port();

    tokio::spawn(async move {
        if let Err(err) = axum::serve(listener, router).await {
            eprintln!("[local_server] axum serve error: {err}");
        }
    });

    Ok(LocalServerHandle { port })
}

async fn serve_asset(State(state): State<AppState>, req: Request) -> Response {
    let raw_path = req.uri().path().to_string();

    // 1. 命中 Tauri 编译期嵌入的前端资源（生产链路）。
    //    asset_resolver 内部已处理 percent-decode、去前导 `/`、空路径→index.html 等逻辑。
    if let Some(asset) = state.app.asset_resolver().get(raw_path.clone()) {
        let mut headers = HeaderMap::new();
        if let Ok(value) = HeaderValue::from_str(&asset.mime_type) {
            headers.insert(header::CONTENT_TYPE, value);
        }
        let mut res = Response::new(Body::from(asset.bytes));
        *res.headers_mut() = headers;
        *res.status_mut() = StatusCode::OK;
        return res;
    }

    // 2. 开发态回退：从磁盘 dist/ 读取（dev 或未启用 custom-protocol 的调试构建）
    if let Some(dev_dist) = state.dev_dist.clone() {
        let service = ServeDir::new(dev_dist).append_index_html_on_directories(true);
        let Ok(res) = service.oneshot(req).await;
        return res.into_response();
    }

    error_response(StatusCode::NOT_FOUND, format!("asset not found: {}", raw_path))
}

async fn proxy_backend(State(state): State<AppState>, req: Request) -> Response {
    proxy_request(&state.client, req, BACKEND_BASE, "").await
}

async fn proxy_seedvc(State(state): State<AppState>, req: Request) -> Response {
    // 前端调 /seedvc/api/foo → 后端 http://127.0.0.1:38511/api/foo
    proxy_request(&state.client, req, SEEDVC_BASE, "/seedvc").await
}

async fn proxy_request(
    client: &reqwest::Client,
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

    let mut request_builder = client.request(method, &target_url);
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
