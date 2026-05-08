using DiffSingerApi.Models;
using OpenUtau.Core.Ustx;

namespace DiffSingerApi.Tests;

internal sealed class PhonemeTimingTestFixture {
    public SynthesisJob Job { get; } = new() { JobId = "test-job" };
    public UVoicePart Part { get; } = new() { position = 120, duration = 1920 };
    public UNote Note { get; }
    public UPhoneme Phoneme { get; }
    public UCurve PitdCurve { get; } = new("pitd") {
        xs = new List<int> { 0, 5, 15 },
        ys = new List<int> { 1, -2, 3 },
    };

    public PhonemeTimingTestFixture() {
        Job.VoiceParts = new List<UVoicePart> { Part };
        Part.curves.Add(PitdCurve);
        Note = AddNote(240, 480, 60, "la");
        Phoneme = AddPhoneme(Note, 0, 240);
    }

    public UNote AddNote(int position, int duration, int tone, string lyric) {
        var note = UNote.Create();
        note.position = position;
        note.duration = duration;
        note.tone = tone;
        note.lyric = lyric;
        note.tuning = 17;
        note.vibrato.length = 45;
        note.vibrato.period = 180;
        note.pitch.snapFirst = false;
        note.pitch.AddPoint(new OpenUtau.Core.Ustx.PitchPoint(0, 0));
        note.pitch.AddPoint(new OpenUtau.Core.Ustx.PitchPoint(120, 1.5f, PitchPointShape.l));
        Part.notes.Add(note);
        return note;
    }

    public UPhoneme AddPhoneme(UNote note, int index, int position) {
        var phoneme = new UPhoneme {
            Parent = note,
            index = index,
            rawPosition = position,
            position = position,
            rawPhoneme = $"ph{index}",
            phoneme = $"ph{index}",
        };
        Part.phonemes.Add(phoneme);
        RelinkPhonemes();
        return phoneme;
    }

    public PhonemeTimingEditRequest Request(
        string editType,
        double? value,
        UNote? note = null,
        UPhoneme? phoneme = null,
        int partIndex = 0) {
        var targetNote = note ?? Note;
        var targetPhoneme = phoneme ?? Phoneme;
        return new PhonemeTimingEditRequest {
            PartIndex = partIndex,
            NoteKey = NoteKey(partIndex, targetNote),
            PhonemeIndex = targetPhoneme.index,
            EditType = editType,
            Value = value,
            ClientRevision = "rev",
        };
    }

    public string NoteKey(int partIndex, UNote note) {
        var ordinal = Part.notes
            .Select((candidate, index) => new { candidate, index })
            .First(entry => ReferenceEquals(entry.candidate, note))
            .index;
        return $"part:{partIndex}|note:{ordinal}|pos:{note.position}|dur:{note.duration}|tone:{note.tone}";
    }

    public UPhonemeOverride SeedOverride(
        UNote? note = null,
        int phonemeIndex = 0,
        int? offset = 5,
        float? preutter = 7,
        float? overlap = 9) {
        var entry = (note ?? Note).GetPhonemeOverride(phonemeIndex);
        entry.offset = offset;
        entry.preutterDelta = preutter;
        entry.overlapDelta = overlap;
        return entry;
    }

    private void RelinkPhonemes() {
        UPhoneme? previous = null;
        foreach (var phoneme in Part.phonemes.OrderBy(phoneme => phoneme.position)) {
            if (previous != null) {
                phoneme.Prev = previous;
                previous.Next = phoneme;
            } else {
                phoneme.Prev = null!;
            }
            previous = phoneme;
        }
        if (previous != null) {
            previous.Next = null!;
        }
    }
}
