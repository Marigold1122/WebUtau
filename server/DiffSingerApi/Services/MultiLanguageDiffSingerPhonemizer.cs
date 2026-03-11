using DiffSingerApi.Models;
using OpenUtau.Api;
using OpenUtau.Core.Ustx;

namespace DiffSingerApi.Services;

public sealed class MultiLanguageDiffSingerPhonemizerOptions {
    public string TrackName { get; set; } = string.Empty;
    public string DefaultLanguageCode { get; set; } = DiffSingerLanguageCodes.Zh;
    public IReadOnlyCollection<string> SupportedLanguageCodes { get; set; } = DiffSingerLanguageCodes.All;
    public Dictionary<string, Phonemizer> ChildPhonemizers { get; set; } = new();
    public Dictionary<NoteLanguageKey, string> NoteLanguages { get; set; } = new();
}

public sealed class MultiLanguageDiffSingerPhonemizer : Phonemizer {
    private readonly MultiLanguageDiffSingerPhonemizerOptions _options;

    public MultiLanguageDiffSingerPhonemizer(MultiLanguageDiffSingerPhonemizerOptions options) {
        _options = options;
        Name = "Melody Singer Multi-Language DiffSinger Phonemizer";
        Tag = "MS DIFFS MULTI";
        Language = "MULTI";
    }

    public override void SetSinger(USinger singer) {
        foreach (var phonemizer in _options.ChildPhonemizers.Values) {
            phonemizer.SetSinger(singer);
        }
    }

    public override void SetUp(Note[][] notes, UProject project, UTrack track) {
        foreach (var phonemizer in _options.ChildPhonemizers.Values) {
            phonemizer.SetTiming(timeAxis);
            phonemizer.SetUp(notes, project, track);
        }
    }

    public override Result Process(Note[] notes, Note? prev, Note? next, Note? prevNeighbour, Note? nextNeighbour, Note[] prevs) {
        var leading = notes[0];
        var key = NoteLanguageKey.FromNote(leading);
        var languageResult = LanguageRoutingService.ResolveEffectiveLanguage(new ResolveEffectiveLanguageInput {
            Path = "phonemizer.route",
            TrackName = _options.TrackName,
            DefaultLanguageCode = _options.DefaultLanguageCode,
            LanguageOverride = _options.NoteLanguages.TryGetValue(key, out var languageOverride) ? languageOverride : null,
            NoteKey = key.ToString(),
            SupportedLanguageCodes = _options.SupportedLanguageCodes,
        });
        if (!languageResult.Ok || string.IsNullOrWhiteSpace(languageResult.EffectiveLanguageCode)) {
            throw new SynthesisOperationException(languageResult.Error ?? new SynthesisErrorContext {
                Path = "phonemizer.route",
                TrackName = _options.TrackName,
                NoteKey = key.ToString(),
                Reason = "Failed to resolve note language.",
            });
        }

        if (!_options.ChildPhonemizers.TryGetValue(languageResult.EffectiveLanguageCode, out var phonemizer)) {
            throw new SynthesisOperationException(new SynthesisErrorContext {
                Path = "phonemizer.route",
                TrackName = _options.TrackName,
                LanguageCode = languageResult.EffectiveLanguageCode,
                NoteKey = key.ToString(),
                Reason = $"DiffSinger phonemizer for language {languageResult.EffectiveLanguageCode} is unavailable.",
            });
        }

        return phonemizer.Process(notes, prev, next, prevNeighbour, nextNeighbour, prevs);
    }

    public override void CleanUp() {
        foreach (var phonemizer in _options.ChildPhonemizers.Values) {
            phonemizer.CleanUp();
        }
    }
}
