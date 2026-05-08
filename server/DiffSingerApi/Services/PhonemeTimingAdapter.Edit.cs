using DiffSingerApi.Models;
using OpenUtau.Core.Ustx;

namespace DiffSingerApi.Services;

public class PhonemeTimingEditException : Exception {
    public PhonemeTimingEditException(int statusCode, string code, string message) : base(message) {
        StatusCode = statusCode;
        Code = code;
    }

    public int StatusCode { get; }
    public string Code { get; }
}

public readonly record struct PhonemeTimingRange(int StartTick, int EndTick);
public readonly record struct PhonemeTimingOverrideState(int? Offset, float? PreutterDelta, float? OverlapDelta);

public sealed class PhonemeTimingEditResult {
    public required UVoicePart Part { get; init; }
    public required UNote Note { get; init; }
    public required int PhonemeIndex { get; init; }
    public required List<PhonemeTimingRange> AffectedRanges { get; init; }
    public required PhonemeTimingOverrideState PreviousState { get; init; }
    public bool Changed { get; init; }
}

public static partial class PhonemeTimingAdapter {
    private static readonly HashSet<string> EditTypes = new(StringComparer.Ordinal) {
        "offsetTick",
        "preutterDeltaMs",
        "overlapDeltaMs",
        "resetOffset",
        "resetPreutter",
        "resetOverlap",
    };

    public static PhonemeTimingEditResult ApplyEdit(SynthesisJob job, PhonemeTimingEditRequest request) {
        if (!EditTypes.Contains(request.EditType)) {
            throw EditError(400, "invalid_edit_type", $"Unsupported editType: {request.EditType}");
        }
        var target = ResolveTarget(job, request);
        var before = CollectAffectedRange(target.Part, target.Phoneme);
        var previousState = CaptureState(target.Note, request.PhonemeIndex);
        var changed = ApplyOverride(target.Note, request);
        return new PhonemeTimingEditResult {
            Part = target.Part,
            Note = target.Note,
            PhonemeIndex = request.PhonemeIndex,
            AffectedRanges = new List<PhonemeTimingRange> { before },
            PreviousState = previousState,
            Changed = changed,
        };
    }

    public static void RestoreEdit(PhonemeTimingEditResult result) {
        var entry = result.Note.GetPhonemeOverride(result.PhonemeIndex);
        entry.offset = result.PreviousState.Offset;
        entry.preutterDelta = result.PreviousState.PreutterDelta;
        entry.overlapDelta = result.PreviousState.OverlapDelta;
    }

    public static PhonemeTimingRange CollectAffectedRange(UVoicePart part, UNote note, int phonemeIndex) {
        var phoneme = part.phonemes.FirstOrDefault(phoneme => IsTargetPhoneme(phoneme, note, phonemeIndex));
        if (phoneme == null) {
            return new PhonemeTimingRange(part.position + note.position, part.position + note.End);
        }
        return CollectAffectedRange(part, phoneme);
    }

    private static (UVoicePart Part, UNote Note, UPhoneme Phoneme) ResolveTarget(
        SynthesisJob job,
        PhonemeTimingEditRequest request) {
        if (job.VoiceParts == null || job.VoiceParts.Count == 0) {
            throw EditError(409, "phonemes_not_ready", "Job has no voice parts.");
        }
        var key = ParseNoteKey(request.NoteKey);
        if (request.PartIndex != key.PartIndex || request.PartIndex < 0 || request.PartIndex >= job.VoiceParts.Count) {
            throw EditError(404, "note_not_found", "Target part was not found.");
        }

        var part = job.VoiceParts[request.PartIndex];
        var note = ResolveNote(part, key);
        var phoneme = part.phonemes.FirstOrDefault(phoneme => IsTargetPhoneme(phoneme, note, request.PhonemeIndex));
        if (phoneme == null) {
            throw EditError(404, "phoneme_not_found", "Target phoneme was not found.");
        }
        return (part, note, phoneme);
    }

    private static UNote ResolveNote(UVoicePart part, NoteKey key) {
        if (key.NoteOrdinal < 0 || key.NoteOrdinal >= part.notes.Count) {
            throw EditError(404, "note_not_found", "Target note ordinal is out of range.");
        }
        var note = part.notes.ElementAt(key.NoteOrdinal);
        if (note.position == key.Position && note.duration == key.Duration && note.tone == key.Tone) {
            return note;
        }
        throw EditError(404, "note_not_found", "Target note key does not match current note state.");
    }

    private static bool ApplyOverride(UNote note, PhonemeTimingEditRequest request) {
        return request.EditType switch {
            "offsetTick" => SetOffset(note, request.PhonemeIndex, ReadIntValue(request)),
            "preutterDeltaMs" => SetPreutter(note, request.PhonemeIndex, ReadFloatValue(request)),
            "overlapDeltaMs" => SetOverlap(note, request.PhonemeIndex, ReadFloatValue(request)),
            "resetOffset" => ResetOffset(note, request),
            "resetPreutter" => ResetPreutter(note, request),
            "resetOverlap" => ResetOverlap(note, request),
            _ => false,
        };
    }

    private static PhonemeTimingOverrideState CaptureState(UNote note, int index) {
        var entry = note.GetPhonemeOverride(index);
        return new PhonemeTimingOverrideState(entry.offset, entry.preutterDelta, entry.overlapDelta);
    }

    private static bool SetOffset(UNote note, int index, int value) {
        var entry = note.GetPhonemeOverride(index);
        int? next = value == 0 ? null : value;
        if (entry.offset == next) return false;
        entry.offset = next;
        return true;
    }

    private static bool SetPreutter(UNote note, int index, float value) {
        var entry = note.GetPhonemeOverride(index);
        float? next = value == 0 ? null : value;
        if (entry.preutterDelta == next) return false;
        entry.preutterDelta = next;
        return true;
    }

    private static bool SetOverlap(UNote note, int index, float value) {
        var entry = note.GetPhonemeOverride(index);
        float? next = value == 0 ? null : value;
        if (entry.overlapDelta == next) return false;
        entry.overlapDelta = next;
        return true;
    }

    private static bool ResetOffset(UNote note, PhonemeTimingEditRequest request) {
        EnsureNullValue(request);
        var entry = note.GetPhonemeOverride(request.PhonemeIndex);
        if (entry.offset == null) return false;
        entry.offset = null;
        return true;
    }

    private static bool ResetPreutter(UNote note, PhonemeTimingEditRequest request) {
        EnsureNullValue(request);
        var entry = note.GetPhonemeOverride(request.PhonemeIndex);
        if (entry.preutterDelta == null) return false;
        entry.preutterDelta = null;
        return true;
    }

    private static bool ResetOverlap(UNote note, PhonemeTimingEditRequest request) {
        EnsureNullValue(request);
        var entry = note.GetPhonemeOverride(request.PhonemeIndex);
        if (entry.overlapDelta == null) return false;
        entry.overlapDelta = null;
        return true;
    }

    private static PhonemeTimingRange CollectAffectedRange(UVoicePart part, UPhoneme phoneme) {
        var affected = new[] { phoneme.Prev, phoneme, phoneme.Next }.Where(item => item != null).ToList();
        var start = affected.Min(item => part.position + item!.position);
        var end = affected.Max(item => part.position + item!.End);
        return new PhonemeTimingRange(Math.Min(start, end), Math.Max(start, end));
    }

    private static bool IsTargetPhoneme(UPhoneme phoneme, UNote note, int phonemeIndex) {
        var parent = phoneme.Parent?.Extends ?? phoneme.Parent;
        return phoneme.index == phonemeIndex && ReferenceEquals(parent, note);
    }

    private static NoteKey ParseNoteKey(string? noteKey) {
        if (string.IsNullOrWhiteSpace(noteKey)) {
            throw InvalidNoteKey("noteKey is empty.");
        }
        var fields = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var field in noteKey.Split('|')) {
            var parts = field.Split(':', 2);
            if (parts.Length != 2 || !fields.TryAdd(parts[0], parts[1])) {
                throw InvalidNoteKey("noteKey has malformed or duplicate fields.");
            }
        }
        if (!TryRead(fields, "part", out var part) || !TryRead(fields, "note", out var note)) {
            throw InvalidNoteKey("noteKey is missing part or note.");
        }
        if (!TryRead(fields, "pos", out var pos) || !TryRead(fields, "dur", out var dur) || !TryRead(fields, "tone", out var tone)) {
            throw InvalidNoteKey("noteKey is missing note identity fields.");
        }
        return new NoteKey(part, note, pos, dur, tone);
    }

    private static PhonemeTimingEditException InvalidNoteKey(string message) {
        return EditError(400, "invalid_note_key", message);
    }

    private static bool TryRead(Dictionary<string, string> fields, string key, out int value) {
        value = 0;
        return fields.TryGetValue(key, out var raw) && int.TryParse(raw, out value);
    }

    private static int ReadIntValue(PhonemeTimingEditRequest request) {
        var value = ReadNumber(request);
        if (Math.Abs(value - Math.Round(value)) > 0.0001) {
            throw EditError(400, "invalid_value", "offsetTick value must be an integer tick.");
        }
        return (int)Math.Round(value);
    }

    private static float ReadFloatValue(PhonemeTimingEditRequest request) {
        return (float)ReadNumber(request);
    }

    private static double ReadNumber(PhonemeTimingEditRequest request) {
        if (!request.Value.HasValue || double.IsNaN(request.Value.Value) || double.IsInfinity(request.Value.Value)) {
            throw EditError(400, "invalid_value", $"{request.EditType} value must be a finite number.");
        }
        return request.Value.Value;
    }

    private static void EnsureNullValue(PhonemeTimingEditRequest request) {
        if (request.Value != null) {
            throw EditError(400, "invalid_value", $"{request.EditType} value must be null.");
        }
    }

    private static PhonemeTimingEditException EditError(int statusCode, string code, string message) {
        return new PhonemeTimingEditException(statusCode, code, message);
    }

    private sealed record NoteKey(int PartIndex, int NoteOrdinal, int Position, int Duration, int Tone);
}
