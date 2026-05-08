using DiffSingerApi.Services;
using OpenUtau.Core.Ustx;
using Xunit;

namespace DiffSingerApi.Tests;

public sealed class PhonemeTimingAdapterTests {
    [Fact]
    public void ApplyEdit_offsetTick_onlyChangesOffset() {
        var fixture = new PhonemeTimingTestFixture();
        var entry = fixture.SeedOverride();

        var result = PhonemeTimingAdapter.ApplyEdit(
            fixture.Job,
            fixture.Request("offsetTick", 24));

        Assert.True(result.Changed);
        Assert.Equal(24, entry.offset);
        Assert.Equal(7, entry.preutterDelta);
        Assert.Equal(9, entry.overlapDelta);
    }

    [Fact]
    public void ApplyEdit_preutterDeltaMs_onlyChangesPreutterDelta() {
        var fixture = new PhonemeTimingTestFixture();
        var entry = fixture.SeedOverride();

        PhonemeTimingAdapter.ApplyEdit(fixture.Job, fixture.Request("preutterDeltaMs", 12.5));

        Assert.Equal(5, entry.offset);
        Assert.Equal(12.5f, entry.preutterDelta);
        Assert.Equal(9, entry.overlapDelta);
    }

    [Fact]
    public void ApplyEdit_overlapDeltaMs_onlyChangesOverlapDelta() {
        var fixture = new PhonemeTimingTestFixture();
        var entry = fixture.SeedOverride();

        PhonemeTimingAdapter.ApplyEdit(fixture.Job, fixture.Request("overlapDeltaMs", -3.25));

        Assert.Equal(5, entry.offset);
        Assert.Equal(7, entry.preutterDelta);
        Assert.Equal(-3.25f, entry.overlapDelta);
    }

    [Fact]
    public void ApplyEdit_zeroValueStoresNullLikeOpenUtau() {
        var fixture = new PhonemeTimingTestFixture();
        var entry = fixture.SeedOverride();

        PhonemeTimingAdapter.ApplyEdit(fixture.Job, fixture.Request("offsetTick", 0));
        PhonemeTimingAdapter.ApplyEdit(fixture.Job, fixture.Request("preutterDeltaMs", 0));
        PhonemeTimingAdapter.ApplyEdit(fixture.Job, fixture.Request("overlapDeltaMs", 0));

        Assert.Null(entry.offset);
        Assert.Null(entry.preutterDelta);
        Assert.Null(entry.overlapDelta);
    }

    [Theory]
    [InlineData("resetOffset", null, 7.0, 9.0)]
    [InlineData("resetPreutter", 5, null, 9.0)]
    [InlineData("resetOverlap", 5, 7.0, null)]
    public void ApplyEdit_resetOnlyClearsTargetField(
        string editType,
        int? expectedOffset,
        double? expectedPreutter,
        double? expectedOverlap) {
        var fixture = new PhonemeTimingTestFixture();
        var entry = fixture.SeedOverride();

        PhonemeTimingAdapter.ApplyEdit(fixture.Job, fixture.Request(editType, null));

        Assert.Equal(expectedOffset, entry.offset);
        Assert.Equal(ToFloat(expectedPreutter), entry.preutterDelta);
        Assert.Equal(ToFloat(expectedOverlap), entry.overlapDelta);
    }

    [Fact]
    public void ApplyEdit_rejectsInvalidEditType() {
        var fixture = new PhonemeTimingTestFixture();
        fixture.SeedOverride();

        var error = Assert.Throws<PhonemeTimingEditException>(
            () => PhonemeTimingAdapter.ApplyEdit(fixture.Job, fixture.Request("badType", 1)));

        Assert.Equal(400, error.StatusCode);
        Assert.Equal("invalid_edit_type", error.Code);
        AssertOverride(fixture.Note.GetPhonemeOverride(0), 5, 7, 9);
    }

    [Fact]
    public void ApplyEdit_rejectsWrongPartIndex() {
        var fixture = new PhonemeTimingTestFixture();
        var request = fixture.Request("offsetTick", 12, partIndex: 0);
        request.PartIndex = 1;

        var error = Assert.Throws<PhonemeTimingEditException>(
            () => PhonemeTimingAdapter.ApplyEdit(fixture.Job, request));

        Assert.Equal(404, error.StatusCode);
        Assert.Equal("note_not_found", error.Code);
    }

    [Fact]
    public void ApplyEdit_rejectsUnknownNoteKey() {
        var fixture = new PhonemeTimingTestFixture();
        var request = fixture.Request("offsetTick", 12);
        request.NoteKey = "part:0|note:0|pos:999|dur:480|tone:60";

        var error = Assert.Throws<PhonemeTimingEditException>(
            () => PhonemeTimingAdapter.ApplyEdit(fixture.Job, request));

        Assert.Equal(404, error.StatusCode);
        Assert.Equal("note_not_found", error.Code);
    }

    [Theory]
    [InlineData("")]
    [InlineData("part:0|part:1|note:0|pos:240|dur:480|tone:60")]
    [InlineData("part:0|note:0|pos:240")]
    public void ApplyEdit_rejectsMalformedNoteKey(string noteKey) {
        var fixture = new PhonemeTimingTestFixture();
        var request = fixture.Request("offsetTick", 12);
        request.NoteKey = noteKey;

        var error = Assert.Throws<PhonemeTimingEditException>(
            () => PhonemeTimingAdapter.ApplyEdit(fixture.Job, request));

        Assert.Equal(400, error.StatusCode);
        Assert.Equal("invalid_note_key", error.Code);
    }

    [Fact]
    public void ApplyEdit_rejectsUnknownPhonemeIndex() {
        var fixture = new PhonemeTimingTestFixture();
        var request = fixture.Request("offsetTick", 12);
        request.PhonemeIndex = 99;

        var error = Assert.Throws<PhonemeTimingEditException>(
            () => PhonemeTimingAdapter.ApplyEdit(fixture.Job, request));

        Assert.Equal(404, error.StatusCode);
        Assert.Equal("phoneme_not_found", error.Code);
        Assert.DoesNotContain(fixture.Note.phonemeOverrides, entry => entry.index == 99);
    }

    [Fact]
    public void ApplyEdit_duplicateNotesUseNoteOrdinalFromNoteKey() {
        var fixture = new PhonemeTimingTestFixture();
        var second = fixture.AddNote(240, 480, 60, "la");
        var secondPhoneme = fixture.AddPhoneme(second, 0, 320);

        PhonemeTimingAdapter.ApplyEdit(
            fixture.Job,
            fixture.Request("offsetTick", 18, second, secondPhoneme));

        Assert.Empty(fixture.Note.phonemeOverrides);
        Assert.Equal(18, second.GetPhonemeOverride(0).offset);
    }

    [Fact]
    public void ApplyEdit_doesNotChangePitchVibratoTuningLyricOrPitd() {
        var fixture = new PhonemeTimingTestFixture();
        var before = NonTimingState.Capture(fixture);

        PhonemeTimingAdapter.ApplyEdit(fixture.Job, fixture.Request("offsetTick", 31));

        before.AssertUnchanged(fixture);
    }

    [Theory]
    [InlineData("offsetTick", 1.2)]
    [InlineData("resetOffset", 1.0)]
    public void ApplyEdit_rejectsInvalidValuesWithoutMutating(string editType, double? value) {
        var fixture = new PhonemeTimingTestFixture();
        fixture.SeedOverride();

        var error = Assert.Throws<PhonemeTimingEditException>(
            () => PhonemeTimingAdapter.ApplyEdit(fixture.Job, fixture.Request(editType, value)));

        Assert.Equal(400, error.StatusCode);
        Assert.Equal("invalid_value", error.Code);
        AssertOverride(fixture.Note.GetPhonemeOverride(0), 5, 7, 9);
    }

    private static void AssertOverride(UPhonemeOverride entry, int? offset, float? preutter, float? overlap) {
        Assert.Equal(offset, entry.offset);
        Assert.Equal(preutter, entry.preutterDelta);
        Assert.Equal(overlap, entry.overlapDelta);
    }

    private static float? ToFloat(double? value) {
        return value.HasValue ? (float)value.Value : null;
    }

    private sealed record NonTimingState(
        string Lyric,
        int Tuning,
        float VibratoLength,
        float VibratoPeriod,
        bool PitchSnapFirst,
        string PitchData,
        string PitdXs,
        string PitdYs) {
        public static NonTimingState Capture(PhonemeTimingTestFixture fixture) {
            var note = fixture.Note;
            return new NonTimingState(
                note.lyric,
                note.tuning,
                note.vibrato.length,
                note.vibrato.period,
                note.pitch.snapFirst,
                string.Join(';', note.pitch.data.Select(point => $"{point.X},{point.Y},{point.shape}")),
                string.Join(',', fixture.PitdCurve.xs),
                string.Join(',', fixture.PitdCurve.ys));
        }

        public void AssertUnchanged(PhonemeTimingTestFixture fixture) {
            Assert.Equal(this, Capture(fixture));
        }
    }
}
