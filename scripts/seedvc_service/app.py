import os
import logging
from logging.handlers import RotatingFileHandler
from pathlib import Path
from urllib.parse import urljoin
from urllib.parse import urlparse
from urllib.request import urlopen

import uvicorn
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from models import build_params
from seedvc_runner import convert_to_file
from storage import build_output_path, build_upload_paths, create_task_id, ensure_runtime_dirs, OUTPUT_ROOT, RUNTIME_ROOT

RENDER_SOURCE_BASE_URL = os.getenv("SEEDVC_RENDER_SOURCE_BASE_URL", "http://127.0.0.1:5000").rstrip("/")
LOG_PATH = RUNTIME_ROOT / "seedvc-service.log"


def configure_logger() -> logging.Logger:
    logger = logging.getLogger("seedvc_service")
    if logger.handlers:
        return logger

    logger.setLevel(logging.INFO)
    formatter = logging.Formatter("%(asctime)s %(levelname)s %(message)s")

    stream_handler = logging.StreamHandler()
    stream_handler.setFormatter(formatter)

    file_handler = RotatingFileHandler(LOG_PATH, maxBytes=2_000_000, backupCount=3, encoding="utf-8")
    file_handler.setFormatter(formatter)

    logger.addHandler(stream_handler)
    logger.addHandler(file_handler)
    logger.propagate = False
    return logger

app = FastAPI(title="Local SeedVC Service")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

ensure_runtime_dirs()
logger = configure_logger()
app.mount("/assets", StaticFiles(directory=str(OUTPUT_ROOT)), name="assets")


async def save_upload(upload: UploadFile, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    with destination.open("wb") as handle:
        while True:
            chunk = await upload.read(1024 * 1024)
            if not chunk:
                break
            handle.write(chunk)
    await upload.close()


def validate_source_url(source_url: str) -> str:
    if source_url.startswith("/"):
        source_url = urljoin(f"{RENDER_SOURCE_BASE_URL}/", source_url.lstrip("/"))

    parsed = urlparse(source_url)
    allowed_base = urlparse(RENDER_SOURCE_BASE_URL)
    if parsed.scheme not in {"http", "https"}:
        raise HTTPException(status_code=400, detail="Invalid source URL scheme.")
    if parsed.hostname != allowed_base.hostname:
        raise HTTPException(status_code=400, detail=f"Source URL host must match render backend host: {allowed_base.hostname}.")
    expected_port = allowed_base.port or (443 if allowed_base.scheme == "https" else 80)
    actual_port = parsed.port or (443 if parsed.scheme == "https" else 80)
    if actual_port != expected_port:
        raise HTTPException(status_code=400, detail=f"Source URL port must match render backend port: {expected_port}.")
    if "/api/jobs/" not in parsed.path:
        raise HTTPException(status_code=400, detail="Invalid source URL path.")
    return source_url


def download_source(source_url: str, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    with urlopen(source_url, timeout=120) as response, destination.open("wb") as handle:
        while True:
            chunk = response.read(1024 * 1024)
            if not chunk:
                break
            handle.write(chunk)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/api/voice-conversion")
async def voice_conversion(
    request: Request,
    source: UploadFile | None = File(None),
    sourceUrl: str | None = Form(None),
    reference: UploadFile = File(...),
    diffusionSteps: int = Form(20),
    lengthAdjust: float = Form(1.0),
    cfgRate: float = Form(0.7),
    f0Condition: bool = Form(True),
    autoF0Adjust: bool = Form(False),
    pitchShift: int = Form(0),
) -> dict:
    if not reference.filename:
        raise HTTPException(status_code=400, detail="Missing reference audio.")
    if source is None and not sourceUrl:
        raise HTTPException(status_code=400, detail="Missing source audio.")

    task_id = create_task_id()
    source_name = source.filename if source and source.filename else "source.wav"
    source_path, reference_path = build_upload_paths(task_id, source_name, reference.filename)
    output_path = build_output_path(task_id)
    params = build_params(diffusionSteps, lengthAdjust, cfgRate, f0Condition, autoF0Adjust, pitchShift)

    try:
        if source is not None:
            logger.info(
                "Voice conversion request task_id=%s source_upload=%s reference=%s params=%s",
                task_id,
                source.filename or "source.wav",
                reference.filename,
                params,
            )
            await save_upload(source, source_path)
        else:
            resolved_source_url = validate_source_url(sourceUrl or "")
            logger.info(
                "Voice conversion request task_id=%s source_url=%s reference=%s params=%s",
                task_id,
                resolved_source_url,
                reference.filename,
                params,
            )
            download_source(resolved_source_url, source_path)
        await save_upload(reference, reference_path)
        sample_rate = convert_to_file(source_path, reference_path, output_path, params)
        logger.info(
            "Voice conversion completed task_id=%s output=%s sample_rate=%s",
            task_id,
            output_path.name,
            sample_rate,
        )
    except HTTPException:
        raise
    except Exception as error:  # noqa: BLE001
        logger.exception(
            "Voice conversion failed task_id=%s source_path=%s reference_path=%s output_path=%s",
            task_id,
            source_path,
            reference_path,
            output_path,
        )
        raise HTTPException(status_code=500, detail=f"{type(error).__name__}: {error}") from error

    asset_url = str(request.base_url).rstrip("/") + f"/assets/{output_path.name}"
    return {
        "taskId": task_id,
        "status": "completed",
        "assetUrl": asset_url,
        "sampleRate": sample_rate,
        "meta": {
            "diffusionSteps": params.diffusion_steps,
            "lengthAdjust": params.length_adjust,
            "cfgRate": params.cfg_rate,
            "f0Condition": params.f0_condition,
            "autoF0Adjust": params.auto_f0_adjust,
            "pitchShift": params.pitch_shift,
        },
    }


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=38511, reload=False)
