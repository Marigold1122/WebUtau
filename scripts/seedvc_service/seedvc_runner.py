import sys
from pathlib import Path

import soundfile as sf

from models import VoiceConversionParams


REPO_ROOT = Path(__file__).resolve().parents[2]
SEED_VC_ROOT = REPO_ROOT / "external" / "seed-vc"

if str(SEED_VC_ROOT) not in sys.path:
    sys.path.insert(0, str(SEED_VC_ROOT))

from seed_vc_wrapper import SeedVCWrapper  # noqa: E402


_WRAPPER = None


def get_wrapper() -> SeedVCWrapper:
    global _WRAPPER
    if _WRAPPER is None:
        _WRAPPER = SeedVCWrapper()
    return _WRAPPER


def convert_to_file(source_path: Path, reference_path: Path, output_path: Path, params: VoiceConversionParams) -> int:
    wrapper = get_wrapper()
    generator = wrapper.convert_voice(
        source=str(source_path),
        target=str(reference_path),
        diffusion_steps=params.diffusion_steps,
        length_adjust=params.length_adjust,
        inference_cfg_rate=params.cfg_rate,
        f0_condition=params.f0_condition,
        auto_f0_adjust=params.auto_f0_adjust,
        pitch_shift=params.pitch_shift,
        stream_output=False,
    )

    full_audio = None
    try:
        while True:
            next(generator)
    except StopIteration as stop:
        full_audio = stop.value

    if full_audio is None:
        raise RuntimeError("SeedVC did not return audio.")

    sample_rate = 44100 if params.f0_condition else 22050
    output_path.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(output_path), full_audio, sample_rate)
    return sample_rate
