from pathlib import Path
from uuid import uuid4


RUNTIME_ROOT = Path(__file__).resolve().parent / "runtime"
UPLOAD_ROOT = RUNTIME_ROOT / "uploads"
OUTPUT_ROOT = RUNTIME_ROOT / "assets"


def ensure_runtime_dirs() -> None:
    UPLOAD_ROOT.mkdir(parents=True, exist_ok=True)
    OUTPUT_ROOT.mkdir(parents=True, exist_ok=True)


def create_task_id() -> str:
    return f"vc-{uuid4().hex[:12]}"


def build_upload_paths(task_id: str, source_name: str, reference_name: str) -> tuple[Path, Path]:
    source_suffix = Path(source_name).suffix or ".wav"
    reference_suffix = Path(reference_name).suffix or ".wav"
    return (
        UPLOAD_ROOT / f"{task_id}-source{source_suffix}",
        UPLOAD_ROOT / f"{task_id}-reference{reference_suffix}",
    )


def build_output_path(task_id: str) -> Path:
    return OUTPUT_ROOT / f"{task_id}.wav"
