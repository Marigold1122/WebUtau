namespace DiffSingerApi.Models;

public class PhonemeTimingSnapshotResponse {
    public string JobId { get; set; } = string.Empty;
    public int MidiPpq { get; set; } = 480;
    public string Revision { get; set; } = string.Empty;
    public List<PhonemeTimingItemDto> Items { get; set; } = new();
}

public class PhonemeTimingItemDto {
    public int PhraseIndex { get; set; }
    public int PartIndex { get; set; }
    public string NoteKey { get; set; } = string.Empty;
    public int PhonemeIndex { get; set; }
    public string Label { get; set; } = string.Empty;
    public string RawLabel { get; set; } = string.Empty;
    public int PositionTick { get; set; }
    public int EndTick { get; set; }
    public double PositionMs { get; set; }
    public double EndMs { get; set; }
    public double PreutterMs { get; set; }
    public double OverlapMs { get; set; }
    public double AutoPreutterMs { get; set; }
    public double AutoOverlapMs { get; set; }
    public int? OffsetTick { get; set; }
    public double? PreutterDeltaMs { get; set; }
    public double? OverlapDeltaMs { get; set; }
    public bool HasOffsetOverride { get; set; }
    public bool HasPreutterOverride { get; set; }
    public bool HasOverlapOverride { get; set; }
    public List<PhonemeTimingEnvelopePointDto> EnvelopePoints { get; set; } = new();
    public string? Error { get; set; }
    public string? HiddenReason { get; set; }
}

public class PhonemeTimingEnvelopePointDto {
    public double XMs { get; set; }
    public double YPercent { get; set; }
}

public class PhonemeTimingEditRequest {
    public int PartIndex { get; set; }
    public string NoteKey { get; set; } = string.Empty;
    public int PhonemeIndex { get; set; }
    // Field-level timing command: offsetTick is ticks; preutter/overlap deltas are milliseconds.
    public string EditType { get; set; } = string.Empty;
    // Reset commands must send null so no pointer geometry can cross the API boundary.
    public double? Value { get; set; }
    public string ClientRevision { get; set; } = string.Empty;
}

public class PhonemeTimingEditResponse {
    public bool Ok { get; set; } = true;
    public PhonemeTimingSnapshotResponse Snapshot { get; set; } = new();
    public List<int> AffectedIndices { get; set; } = new();
    public List<PhonemeTimingPhraseDto>? Phrases { get; set; }

    // Server-only flag: true when Validate changed phrase count or split. Controller
    // uses this to decide whether to populate Phrases; never serialized to clients.
    [System.Text.Json.Serialization.JsonIgnore]
    public bool PhrasesChanged { get; set; }
}

public class PhonemeTimingPhraseDto {
    public int Index { get; set; }
    public double StartMs { get; set; }
    public double DurationMs { get; set; }
    public string Status { get; set; } = "pending";
    public List<PhonemeTimingNoteDto> Notes { get; set; } = new();
}

public class PhonemeTimingNoteDto {
    public int Position { get; set; }
    public int Duration { get; set; }
    public int Tone { get; set; }
    public string Lyric { get; set; } = "a";
    public int Tuning { get; set; }
    public NotePitchData? Pitch { get; set; }
    public NoteVibratoData? Vibrato { get; set; }
}
