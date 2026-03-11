using OpenUtau.Core.Ustx;

namespace DiffSingerApi.Models;

public static class DiffSingerLanguageCodes {
    public const string Zh = "ZH";
    public const string En = "EN";
    public const string Ja = "JA";

    public static readonly string[] All = [Zh, En, Ja];
}

public sealed class SynthesisErrorContext {
    public string Path { get; set; } = string.Empty;
    public string Reason { get; set; } = string.Empty;
    public string? JobId { get; set; }
    public string? TrackId { get; set; }
    public string? TrackName { get; set; }
    public string? LanguageCode { get; set; }
    public string? NoteKey { get; set; }
}

public sealed class SynthesisOperationException : Exception {
    public SynthesisErrorContext ErrorContext { get; }

    public SynthesisOperationException(SynthesisErrorContext errorContext)
        : base(errorContext.Reason) {
        ErrorContext = errorContext;
    }
}

public readonly record struct NoteLanguageKey(int Position, int Duration, int Tone, string Lyric) {
    public static NoteLanguageKey FromNote(UNote note) => new(note.position, note.duration, note.tone, note.lyric ?? string.Empty);

    public static NoteLanguageKey FromNote(OpenUtau.Api.Phonemizer.Note note) =>
        new(note.position, note.duration, note.tone, note.lyric ?? string.Empty);

    public static NoteLanguageKey FromRequest(NoteLanguageOverrideRequest request) =>
        new(request.Position, request.Duration, request.Tone, request.Lyric ?? string.Empty);

    public override string ToString() => $"{Position}:{Duration}:{Tone}:{Lyric}";
}

public sealed class NoteLanguageOverrideRequest {
    public int Position { get; set; }
    public int Duration { get; set; }
    public int Tone { get; set; }
    public string? Lyric { get; set; }
    public string? LanguageOverride { get; set; }
}

public sealed class ResolveEffectiveLanguageInput {
    public string Path { get; set; } = string.Empty;
    public string? TrackName { get; set; }
    public string DefaultLanguageCode { get; set; } = DiffSingerLanguageCodes.Zh;
    public string? LanguageOverride { get; set; }
    public string? NoteKey { get; set; }
    public IReadOnlyCollection<string> SupportedLanguageCodes { get; set; } = DiffSingerLanguageCodes.All;
}

public sealed class ResolveEffectiveLanguageResult {
    public bool Ok { get; set; }
    public string? EffectiveLanguageCode { get; set; }
    public SynthesisErrorContext? Error { get; set; }
}

public sealed class BindNoteLanguageOverridesInput {
    public string Path { get; set; } = string.Empty;
    public string? TrackName { get; set; }
    public string DefaultLanguageCode { get; set; } = DiffSingerLanguageCodes.Zh;
    public IReadOnlyCollection<string> SupportedLanguageCodes { get; set; } = DiffSingerLanguageCodes.All;
    public IReadOnlyCollection<UVoicePart> VoiceParts { get; set; } = Array.Empty<UVoicePart>();
    public IReadOnlyCollection<NoteLanguageOverrideRequest> Overrides { get; set; } = Array.Empty<NoteLanguageOverrideRequest>();
}

public sealed class BoundNoteLanguageOverrides {
    public string DefaultLanguageCode { get; set; } = DiffSingerLanguageCodes.Zh;
    public Dictionary<UNote, string> OverridesByNote { get; set; } = new();
}

public sealed class BindNoteLanguageOverridesResult {
    public bool Ok { get; set; }
    public BoundNoteLanguageOverrides? Value { get; set; }
    public SynthesisErrorContext? Error { get; set; }
}

