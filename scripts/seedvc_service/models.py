from dataclasses import dataclass


@dataclass(slots=True)
class VoiceConversionParams:
    diffusion_steps: int
    length_adjust: float
    cfg_rate: float
    f0_condition: bool
    auto_f0_adjust: bool
    pitch_shift: int


def build_params(
    diffusion_steps: int,
    length_adjust: float,
    cfg_rate: float,
    f0_condition: bool,
    auto_f0_adjust: bool,
    pitch_shift: int,
) -> VoiceConversionParams:
    return VoiceConversionParams(
        diffusion_steps=max(1, int(diffusion_steps)),
        length_adjust=max(0.5, min(2.0, float(length_adjust))),
        cfg_rate=max(0.0, min(1.0, float(cfg_rate))),
        f0_condition=bool(f0_condition),
        auto_f0_adjust=bool(auto_f0_adjust),
        pitch_shift=int(pitch_shift),
    )
