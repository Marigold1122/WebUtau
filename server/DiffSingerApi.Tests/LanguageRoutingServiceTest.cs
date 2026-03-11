using DiffSingerApi.Models;
using DiffSingerApi.Services;
using OpenUtau.Api;
using OpenUtau.Core.Ustx;
using Xunit;

namespace DiffSingerApi.Tests;

public class LanguageRoutingServiceTest {
    [Fact]
    public void ResolveEffectiveLanguage_UsesOverride_WhenPresent() {
        var result = LanguageRoutingService.ResolveEffectiveLanguage(new ResolveEffectiveLanguageInput {
            Path = "prepare.resolve-language",
            TrackName = "Lead",
            DefaultLanguageCode = DiffSingerLanguageCodes.Zh,
            LanguageOverride = DiffSingerLanguageCodes.En,
            NoteKey = "0:60",
            SupportedLanguageCodes = DiffSingerLanguageCodes.All,
        });

        Assert.True(result.Ok);
        Assert.Equal(DiffSingerLanguageCodes.En, result.EffectiveLanguageCode);
        Assert.Null(result.Error);
    }

    [Fact]
    public void ResolveEffectiveLanguage_ReturnsExplicitError_WhenLanguageUnsupported() {
        var result = LanguageRoutingService.ResolveEffectiveLanguage(new ResolveEffectiveLanguageInput {
            Path = "prepare.resolve-language",
            TrackName = "Lead",
            DefaultLanguageCode = "XX",
            LanguageOverride = null,
            NoteKey = "0:60",
            SupportedLanguageCodes = DiffSingerLanguageCodes.All,
        });

        Assert.False(result.Ok);
        Assert.NotNull(result.Error);
        Assert.Equal("prepare.resolve-language", result.Error!.Path);
        Assert.Equal("Lead", result.Error.TrackName);
        Assert.Equal("XX", result.Error.LanguageCode);
    }

    [Fact]
    public void BindOverrides_BindsSingleMatchingNote() {
        var note = UNote.Create();
        note.position = 0;
        note.duration = 120;
        note.tone = 60;
        note.lyric = "你";

        var part = new UVoicePart();
        part.notes.Add(note);

        var result = LanguageRoutingService.BindNoteLanguageOverrides(new BindNoteLanguageOverridesInput {
            Path = "prepare.bind-overrides",
            TrackName = "Lead",
            DefaultLanguageCode = DiffSingerLanguageCodes.Zh,
            SupportedLanguageCodes = DiffSingerLanguageCodes.All,
            VoiceParts = new[] { part },
            Overrides = new[] {
                new NoteLanguageOverrideRequest {
                    Position = 0,
                    Duration = 120,
                    Tone = 60,
                    Lyric = "你",
                    LanguageOverride = DiffSingerLanguageCodes.En,
                },
            },
        });

        Assert.True(result.Ok);
        Assert.NotNull(result.Value);
        Assert.Single(result.Value!.OverridesByNote);
        Assert.Equal(DiffSingerLanguageCodes.En, result.Value.OverridesByNote[note]);
    }

    [Fact]
    public void BindOverrides_ReturnsExplicitError_WhenNoteMissing() {
        var result = LanguageRoutingService.BindNoteLanguageOverrides(new BindNoteLanguageOverridesInput {
            Path = "prepare.bind-overrides",
            TrackName = "Lead",
            DefaultLanguageCode = DiffSingerLanguageCodes.Zh,
            SupportedLanguageCodes = DiffSingerLanguageCodes.All,
            VoiceParts = Array.Empty<UVoicePart>(),
            Overrides = new[] {
                new NoteLanguageOverrideRequest {
                    Position = 480,
                    Duration = 120,
                    Tone = 64,
                    Lyric = "la",
                    LanguageOverride = DiffSingerLanguageCodes.Ja,
                },
            },
        });

        Assert.False(result.Ok);
        Assert.NotNull(result.Error);
        Assert.Equal("prepare.bind-overrides", result.Error!.Path);
        Assert.Equal(DiffSingerLanguageCodes.Ja, result.Error.LanguageCode);
        Assert.Contains("480", result.Error.NoteKey ?? string.Empty);
    }

    [Fact]
    public void MultiLanguagePhonemizer_RoutesToDelegateByResolvedLanguage() {
        var zh = new FakePhonemizer("ZH");
        var en = new FakePhonemizer("EN");
        var ja = new FakePhonemizer("JA");
        var phonemizer = new MultiLanguageDiffSingerPhonemizer(new MultiLanguageDiffSingerPhonemizerOptions {
            TrackName = "Lead",
            DefaultLanguageCode = DiffSingerLanguageCodes.Zh,
            SupportedLanguageCodes = DiffSingerLanguageCodes.All,
            ChildPhonemizers = new Dictionary<string, Phonemizer> {
                [DiffSingerLanguageCodes.Zh] = zh,
                [DiffSingerLanguageCodes.En] = en,
                [DiffSingerLanguageCodes.Ja] = ja,
            },
            NoteLanguages = new Dictionary<NoteLanguageKey, string> {
                [new NoteLanguageKey(0, 120, 60, "hello")] = DiffSingerLanguageCodes.En,
            },
        });

        var result = phonemizer.Process(
            new[] { new Phonemizer.Note { position = 0, duration = 120, tone = 60, lyric = "hello" } },
            null,
            null,
            null,
            null,
            Array.Empty<Phonemizer.Note>());

        Assert.Single(result.phonemes);
        Assert.Equal("EN", result.phonemes[0].phoneme);
        Assert.Equal(0, zh.ProcessCallCount);
        Assert.Equal(1, en.ProcessCallCount);
        Assert.Equal(0, ja.ProcessCallCount);
    }

    private sealed class FakePhonemizer : Phonemizer {
        private readonly string _value;

        public int ProcessCallCount { get; private set; }

        public FakePhonemizer(string value) {
            _value = value;
        }

        public override void SetSinger(USinger singer) {
        }

        public override Result Process(Note[] notes, Note? prev, Note? next, Note? prevNeighbour, Note? nextNeighbour, Note[] prevs) {
            ProcessCallCount++;
            return new Result {
                phonemes = new[] {
                    new Phoneme { phoneme = _value, position = 0 },
                },
            };
        }
    }
}
