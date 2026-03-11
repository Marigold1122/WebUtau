using DiffSingerApi.Models;
using OpenUtau.Core.Ustx;

namespace DiffSingerApi.Services;

public static class LanguageRoutingService {
    public static ResolveEffectiveLanguageResult ResolveEffectiveLanguage(ResolveEffectiveLanguageInput input) {
        var candidate = NormalizeLanguageCode(string.IsNullOrWhiteSpace(input.LanguageOverride)
            ? input.DefaultLanguageCode
            : input.LanguageOverride);

        if (string.IsNullOrWhiteSpace(candidate) || !input.SupportedLanguageCodes.Contains(candidate)) {
            return new ResolveEffectiveLanguageResult {
                Ok = false,
                Error = new SynthesisErrorContext {
                    Path = input.Path,
                    TrackName = input.TrackName,
                    LanguageCode = candidate,
                    NoteKey = input.NoteKey,
                    Reason = $"Unsupported DiffSinger language code: {candidate ?? "<null>"}.",
                },
            };
        }

        return new ResolveEffectiveLanguageResult {
            Ok = true,
            EffectiveLanguageCode = candidate,
        };
    }

    public static BindNoteLanguageOverridesResult BindNoteLanguageOverrides(BindNoteLanguageOverridesInput input) {
        var defaultLanguage = ResolveEffectiveLanguage(new ResolveEffectiveLanguageInput {
            Path = input.Path,
            TrackName = input.TrackName,
            DefaultLanguageCode = input.DefaultLanguageCode,
            SupportedLanguageCodes = input.SupportedLanguageCodes,
        });
        if (!defaultLanguage.Ok || defaultLanguage.EffectiveLanguageCode == null) {
            return new BindNoteLanguageOverridesResult {
                Ok = false,
                Error = defaultLanguage.Error,
            };
        }

        var notes = input.VoiceParts
            .SelectMany(part => part.notes)
            .ToArray();

        var value = new BoundNoteLanguageOverrides {
            DefaultLanguageCode = defaultLanguage.EffectiveLanguageCode,
        };

        foreach (var request in input.Overrides) {
            var languageResult = ResolveEffectiveLanguage(new ResolveEffectiveLanguageInput {
                Path = input.Path,
                TrackName = input.TrackName,
                DefaultLanguageCode = defaultLanguage.EffectiveLanguageCode,
                LanguageOverride = request.LanguageOverride,
                NoteKey = NoteLanguageKey.FromRequest(request).ToString(),
                SupportedLanguageCodes = input.SupportedLanguageCodes,
            });
            if (!languageResult.Ok || languageResult.EffectiveLanguageCode == null) {
                return new BindNoteLanguageOverridesResult {
                    Ok = false,
                    Error = languageResult.Error,
                };
            }

            var matches = notes
                .Where(note => note.position == request.Position
                    && note.duration == request.Duration
                    && note.tone == request.Tone
                    && (request.Lyric == null || (note.lyric ?? string.Empty) == request.Lyric))
                .ToArray();

            if (matches.Length == 0) {
                return new BindNoteLanguageOverridesResult {
                    Ok = false,
                    Error = new SynthesisErrorContext {
                        Path = input.Path,
                        TrackName = input.TrackName,
                        LanguageCode = languageResult.EffectiveLanguageCode,
                        NoteKey = NoteLanguageKey.FromRequest(request).ToString(),
                        Reason = "Language override target note was not found.",
                    },
                };
            }

            if (matches.Length > 1) {
                return new BindNoteLanguageOverridesResult {
                    Ok = false,
                    Error = new SynthesisErrorContext {
                        Path = input.Path,
                        TrackName = input.TrackName,
                        LanguageCode = languageResult.EffectiveLanguageCode,
                        NoteKey = NoteLanguageKey.FromRequest(request).ToString(),
                        Reason = "Language override target note is ambiguous.",
                    },
                };
            }

            value.OverridesByNote[matches[0]] = languageResult.EffectiveLanguageCode;
        }

        return new BindNoteLanguageOverridesResult {
            Ok = true,
            Value = value,
        };
    }

    public static Dictionary<NoteLanguageKey, string> BuildSnapshot(Dictionary<UNote, string> overridesByNote) {
        var snapshot = new Dictionary<NoteLanguageKey, string>();
        foreach (var (note, languageCode) in overridesByNote) {
            snapshot[NoteLanguageKey.FromNote(note)] = NormalizeLanguageCode(languageCode) ?? languageCode;
        }
        return snapshot;
    }

    public static SynthesisErrorContext? FindPhonemizerError(
        IReadOnlyCollection<UVoicePart> voiceParts,
        string defaultLanguageCode,
        Dictionary<UNote, string> overridesByNote,
        string path,
        string? jobId,
        string? trackName) {

        foreach (var phoneme in voiceParts.SelectMany(part => part.phonemes)) {
            if (phoneme.rawPhoneme != "error" || phoneme.Parent == null) {
                continue;
            }

            var note = phoneme.Parent;
            var resolved = ResolveEffectiveLanguage(new ResolveEffectiveLanguageInput {
                Path = path,
                TrackName = trackName,
                DefaultLanguageCode = defaultLanguageCode,
                LanguageOverride = overridesByNote.TryGetValue(note, out var overrideCode) ? overrideCode : null,
                NoteKey = NoteLanguageKey.FromNote(note).ToString(),
                SupportedLanguageCodes = DiffSingerLanguageCodes.All,
            });

            return new SynthesisErrorContext {
                Path = path,
                JobId = jobId,
                TrackName = trackName,
                LanguageCode = resolved.EffectiveLanguageCode ?? overrideCode ?? defaultLanguageCode,
                NoteKey = NoteLanguageKey.FromNote(note).ToString(),
                Reason = $"Lyric \"{note.lyric}\" failed to phonemize under language {resolved.EffectiveLanguageCode ?? overrideCode ?? defaultLanguageCode}.",
            };
        }

        return null;
    }

    public static string? NormalizeLanguageCode(string? value) {
        if (string.IsNullOrWhiteSpace(value)) {
            return null;
        }

        return value.Trim().ToUpperInvariant();
    }
}
