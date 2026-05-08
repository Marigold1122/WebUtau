using System.Security.Cryptography;
using System.Text;
using System.Globalization;
using DiffSingerApi.Models;
using OpenUtau.Core.Render;
using OpenUtau.Core.Ustx;

namespace DiffSingerApi.Services;

public class PhonemeTimingReadException : Exception {
    public PhonemeTimingReadException(int statusCode, string code, string message) : base(message) {
        StatusCode = statusCode;
        Code = code;
    }

    public int StatusCode { get; }
    public string Code { get; }
}

public static partial class PhonemeTimingAdapter {
    private const int OpenUtauTickPpq = 480;

    public static PhonemeTimingSnapshotResponse ReadSnapshot(SynthesisJob job) {
        if (job.Project == null || job.VoiceParts == null || job.VoiceParts.Count == 0) {
            throw new PhonemeTimingReadException(
                StatusCodes.Status409Conflict,
                "phonemes_not_ready",
                "Job has no prepared OpenUtau phoneme context.");
        }
        if (job.VoiceParts.Any(part => !part.PhonemesUpToDate)) {
            throw new PhonemeTimingReadException(
                StatusCodes.Status409Conflict,
                "phonemes_not_ready",
                "Job phonemes are not up to date.");
        }

        var items = new List<PhonemeTimingItemDto>();
        var phrases = job.AllPhrases ?? new List<RenderPhrase>();

        for (int partIndex = 0; partIndex < job.VoiceParts.Count; partIndex++) {
            var part = job.VoiceParts[partIndex];
            var noteOrdinals = part.notes
                .Select((note, index) => new { note, index })
                .ToDictionary(entry => entry.note, entry => entry.index);

            foreach (var phoneme in part.phonemes) {
                var note = phoneme.Parent?.Extends ?? phoneme.Parent;
                if (note == null) {
                    continue;
                }

                var noteFound = noteOrdinals.TryGetValue(note, out var noteOrdinal);
                var safeNoteOrdinal = noteFound ? noteOrdinal : -1;
                var phraseIndex = FindPhraseIndex(phrases, part.position + phoneme.position);
                var timingOverride = note.phonemeOverrides.FirstOrDefault(item => item.index == phoneme.index);
                var error = phoneme.Error ? "phoneme_error" : null;
                var hiddenReason = GetHiddenReason(phoneme, note, noteFound, phraseIndex);

                items.Add(new PhonemeTimingItemDto {
                    PhraseIndex = phraseIndex,
                    PartIndex = partIndex,
                    NoteKey = BuildNoteKey(partIndex, safeNoteOrdinal, note),
                    PhonemeIndex = phoneme.index,
                    Label = GetLabel(phoneme),
                    RawLabel = phoneme.rawPhoneme ?? string.Empty,
                    PositionTick = phoneme.position,
                    EndTick = phoneme.End,
                    PositionMs = phoneme.PositionMs,
                    EndMs = phoneme.EndMs,
                    PreutterMs = phoneme.preutter,
                    OverlapMs = phoneme.overlap,
                    AutoPreutterMs = phoneme.autoPreutter,
                    AutoOverlapMs = phoneme.autoOverlap,
                    OffsetTick = timingOverride?.offset,
                    PreutterDeltaMs = timingOverride?.preutterDelta,
                    OverlapDeltaMs = timingOverride?.overlapDelta,
                    HasOffsetOverride = timingOverride?.offset.HasValue ?? false,
                    HasPreutterOverride = timingOverride?.preutterDelta.HasValue ?? false,
                    HasOverlapOverride = timingOverride?.overlapDelta.HasValue ?? false,
                    EnvelopePoints = phoneme.envelope.data
                        .Select(point => new PhonemeTimingEnvelopePointDto {
                            XMs = point.X,
                            YPercent = point.Y,
                        })
                        .ToList(),
                    Error = error,
                    HiddenReason = hiddenReason,
                });
            }
        }

        if (items.Count == 0) {
            throw new PhonemeTimingReadException(
                StatusCodes.Status409Conflict,
                "phonemes_not_ready",
                "Job has no readable phonemes.");
        }

        return new PhonemeTimingSnapshotResponse {
            JobId = job.JobId,
            MidiPpq = OpenUtauTickPpq,
            Revision = BuildRevision(items),
            Items = items,
        };
    }

    private static string BuildNoteKey(int partIndex, int noteOrdinal, UNote note) {
        return $"part:{partIndex}|note:{noteOrdinal}|pos:{note.position}|dur:{note.duration}|tone:{note.tone}";
    }

    private static int FindPhraseIndex(List<RenderPhrase> phrases, int absoluteTick) {
        for (int index = 0; index < phrases.Count; index++) {
            var phrase = phrases[index];
            var phraseStart = phrase.position - phrase.leading;
            var phraseEnd = phrase.position + phrase.duration;
            if (absoluteTick >= phraseStart && absoluteTick <= phraseEnd) {
                return index;
            }
        }
        return -1;
    }

    private static string GetLabel(UPhoneme phoneme) {
        if (!string.IsNullOrWhiteSpace(phoneme.phonemeMapped)) {
            return phoneme.phonemeMapped;
        }
        if (!string.IsNullOrWhiteSpace(phoneme.phoneme)) {
            return phoneme.phoneme;
        }
        return phoneme.rawPhoneme ?? string.Empty;
    }

    private static string? GetHiddenReason(UPhoneme phoneme, UNote note, bool noteFound, int phraseIndex) {
        if (!noteFound) {
            return "note_not_found";
        }
        if (note.OverlapError) {
            return "note_overlap_error";
        }
        if (note.Error) {
            return "note_error";
        }
        if (phoneme.Error) {
            return "phoneme_error";
        }
        if (phraseIndex < 0) {
            return "phrase_not_found";
        }
        return null;
    }

    private static string BuildRevision(IEnumerable<PhonemeTimingItemDto> items) {
        var builder = new StringBuilder();
        foreach (var item in items.OrderBy(item => item.PartIndex).ThenBy(item => item.NoteKey).ThenBy(item => item.PhonemeIndex)) {
            AppendField(builder, item.PhraseIndex);
            AppendField(builder, item.PartIndex);
            AppendField(builder, item.NoteKey);
            AppendField(builder, item.PhonemeIndex);
            AppendField(builder, item.Label);
            AppendField(builder, item.RawLabel);
            AppendField(builder, item.PositionTick);
            AppendField(builder, item.EndTick);
            AppendField(builder, item.PositionMs);
            AppendField(builder, item.EndMs);
            AppendField(builder, item.PreutterMs);
            AppendField(builder, item.OverlapMs);
            AppendField(builder, item.AutoPreutterMs);
            AppendField(builder, item.AutoOverlapMs);
            AppendField(builder, item.OffsetTick);
            AppendField(builder, item.PreutterDeltaMs);
            AppendField(builder, item.OverlapDeltaMs);
            AppendField(builder, item.HasOffsetOverride);
            AppendField(builder, item.HasPreutterOverride);
            AppendField(builder, item.HasOverlapOverride);
            foreach (var point in item.EnvelopePoints) {
                AppendField(builder, point.XMs);
                AppendField(builder, point.YPercent);
            }
            AppendField(builder, item.Error);
            AppendField(builder, item.HiddenReason);
            builder.Append('\n');
        }
        var hash = SHA256.HashData(Encoding.UTF8.GetBytes(builder.ToString()));
        return Convert.ToHexString(hash).ToLowerInvariant();
    }

    private static void AppendField(StringBuilder builder, string? value) {
        if (value == null) {
            builder.Append("<null>");
        } else {
            builder.Append(value.Length.ToString(CultureInfo.InvariantCulture)).Append(':').Append(value);
        }
        builder.Append('|');
    }

    private static void AppendField(StringBuilder builder, int value) {
        builder.Append(value.ToString(CultureInfo.InvariantCulture)).Append('|');
    }

    private static void AppendField(StringBuilder builder, int? value) {
        builder.Append(value.HasValue ? value.Value.ToString(CultureInfo.InvariantCulture) : "<null>").Append('|');
    }

    private static void AppendField(StringBuilder builder, double value) {
        builder.Append(value.ToString("R", CultureInfo.InvariantCulture)).Append('|');
    }

    private static void AppendField(StringBuilder builder, double? value) {
        builder.Append(value.HasValue ? value.Value.ToString("R", CultureInfo.InvariantCulture) : "<null>").Append('|');
    }

    private static void AppendField(StringBuilder builder, bool value) {
        builder.Append(value ? "true" : "false").Append('|');
    }
}
