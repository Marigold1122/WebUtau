using DiffSingerApi.Models;
using OpenUtau.Core;
using OpenUtau.Core.Render;
using Serilog;

namespace DiffSingerApi.Services;

public partial class SynthesisService {
    public PhonemeTimingEditResponse ApplyPhonemeTimingEditAndRerender(
        SynthesisJob job,
        PhonemeTimingEditRequest request) {
        EnsurePhonemeTimingContext(job);

        var previousStatus = job.Status;
        var previousProgress = job.Progress;
        var phaseStateResolved = false;
        EnterInteractivePreparationPhase(job, "Waiting for current render to yield...");
        PauseRenderLoopAndAwaitQuietPhrase(job, "Waiting for current render to yield...");

        try {
            var beforeSnapshot = PhonemeTimingAdapter.ReadSnapshot(job);
            EnsureFreshPhonemeTimingRevision(request, beforeSnapshot);

            var result = PhonemeTimingAdapter.ApplyEdit(job, request);
            if (!result.Changed) {
                RestoreInteractivePhaseState(job, previousStatus, previousProgress);
                phaseStateResolved = true;
                return PhonemeTimingResponse(beforeSnapshot, new List<int>());
            }

            var affectedIndices = RefreshPhonemeTimingRuntime(job, result);
            QueuePhonemeTimingRerender(job, affectedIndices);
            CleanupJobOutputArtifacts(job.JobId, CollectReferencedPhraseOutputPaths(job));

            var shouldStartDetachedRender = previousStatus is "completed" or "ready";
            TransitionToBackgroundRenderPhase(job, affectedIndices.Count, job.AllPhrases?.Count ?? 0);
            phaseStateResolved = true;

            if (shouldStartDetachedRender) {
                StartDetachedPhonemeTimingRender(job, job.AllPhrases!, job.Renderer!);
            }

            var snapshot = PhonemeTimingAdapter.ReadSnapshot(job);
            Log.Information(
                "[phoneme-timings] job={JobId} editType={EditType} part={PartIndex} noteKey={NoteKey} phoneme={PhonemeIndex} affected=[{Affected}] revision={Before}->{After}",
                job.JobId,
                request.EditType,
                request.PartIndex,
                request.NoteKey,
                request.PhonemeIndex,
                string.Join(", ", affectedIndices),
                beforeSnapshot.Revision,
                snapshot.Revision);
            return PhonemeTimingResponse(snapshot, affectedIndices);
        } finally {
            if (!phaseStateResolved) {
                RestoreInteractivePhaseState(job, previousStatus, previousProgress);
            }
            job.RenderGate.Set();
        }
    }

    private static void EnsurePhonemeTimingContext(SynthesisJob job) {
        if (job.Project != null && job.VoiceParts != null && job.AllPhrases != null && job.Renderer != null) {
            return;
        }
        throw new PhonemeTimingEditException(409, "phonemes_not_ready", "Job has no prepared OpenUtau render context.");
    }

    private static void EnsureFreshPhonemeTimingRevision(
        PhonemeTimingEditRequest request,
        PhonemeTimingSnapshotResponse snapshot) {
        if (string.IsNullOrWhiteSpace(request.ClientRevision)) {
            return;
        }
        if (request.ClientRevision == snapshot.Revision) {
            return;
        }
        throw new PhonemeTimingEditException(409, "snapshot_conflict", "Phoneme timing snapshot is stale.");
    }

    private List<int> RefreshPhonemeTimingRuntime(SynthesisJob job, PhonemeTimingEditResult result) {
        try {
            job.Progress = "Refreshing phoneme timing...";
            job.Project!.Validate(new ValidateOptions {
                SkipTiming = true,
                Part = result.Part,
                SkipPhonemizer = true,
            });
        } catch (Exception ex) {
            PhonemeTimingAdapter.RestoreEdit(result);
            TryRestorePhonemeTimingRuntime(job, result.Part);
            throw new PhonemeTimingEditException(409, "phoneme_validate_failed", ex.Message);
        }

        var allPhrases = CollectAllPhrases(job.VoiceParts!);
        job.AllPhrases = allPhrases;
        var changedPhraseJobs = SyncPhonemeTimingPhraseJobs(job, allPhrases);
        var ranges = CollectPhonemeTimingRanges(result);
        var fromRanges = CollectAffectedPhraseIndices(allPhrases, ranges);
        return MergePhonemeTimingAffectedIndices(fromRanges, changedPhraseJobs, allPhrases.Count);
    }

    private static void TryRestorePhonemeTimingRuntime(SynthesisJob job, OpenUtau.Core.Ustx.UVoicePart part) {
        try {
            job.Project?.Validate(new ValidateOptions {
                SkipTiming = true,
                Part = part,
                SkipPhonemizer = true,
            });
        } catch (Exception ex) {
            Log.Warning(ex, "Failed to restore phoneme timing runtime after validate failure.");
        }
    }

    private static List<(int StartTick, int EndTick)> CollectPhonemeTimingRanges(PhonemeTimingEditResult result) {
        var ranges = result.AffectedRanges
            .Select(range => (range.StartTick, range.EndTick))
            .ToList();
        var after = PhonemeTimingAdapter.CollectAffectedRange(result.Part, result.Note, result.PhonemeIndex);
        ranges.Add((after.StartTick, after.EndTick));
        return ranges;
    }

    private static List<int> SyncPhonemeTimingPhraseJobs(SynthesisJob job, List<RenderPhrase> allPhrases) {
        lock (job.RenderLock) {
            if (job.Phrases == null || job.Phrases.Count != allPhrases.Count) {
                job.Phrases = allPhrases.Select((phrase, index) => NewPhraseJob(phrase, index)).ToList();
                return Enumerable.Range(0, allPhrases.Count).ToList();
            }
            return UpdatePhonemeTimingPhraseJobs(job.Phrases, allPhrases);
        }
    }

    private static List<int> UpdatePhonemeTimingPhraseJobs(List<PhraseJob> phraseJobs, List<RenderPhrase> allPhrases) {
        var changed = new List<int>();
        for (var index = 0; index < allPhrases.Count; index++) {
            var phraseJob = phraseJobs[index];
            var renderPhrase = allPhrases[index];
            if (!PhraseTimingChanged(phraseJob, renderPhrase)) {
                continue;
            }
            phraseJob.StartMs = renderPhrase.positionMs - renderPhrase.leadingMs;
            phraseJob.DurationMs = renderPhrase.durationMs + renderPhrase.leadingMs;
            changed.Add(index);
        }
        return changed;
    }

    private static PhraseJob NewPhraseJob(RenderPhrase phrase, int index) {
        return new PhraseJob {
            Index = index,
            StartMs = phrase.positionMs - phrase.leadingMs,
            DurationMs = phrase.durationMs + phrase.leadingMs,
            Status = "pending",
        };
    }

    private static bool PhraseTimingChanged(PhraseJob phraseJob, RenderPhrase renderPhrase) {
        var nextStart = renderPhrase.positionMs - renderPhrase.leadingMs;
        var nextDuration = renderPhrase.durationMs + renderPhrase.leadingMs;
        return Math.Abs(phraseJob.StartMs - nextStart) > 0.001
            || Math.Abs(phraseJob.DurationMs - nextDuration) > 0.001;
    }

    private static List<int> MergePhonemeTimingAffectedIndices(
        IEnumerable<int> fromRanges,
        IEnumerable<int> changedPhraseJobs,
        int phraseCount) {
        var affected = fromRanges.Concat(changedPhraseJobs)
            .Where(index => index >= 0 && index < phraseCount)
            .Distinct()
            .OrderBy(index => index)
            .ToList();
        if (affected.Count > 0 || phraseCount == 0) {
            return affected;
        }
        return Enumerable.Range(0, phraseCount).ToList();
    }

    private static void QueuePhonemeTimingRerender(SynthesisJob job, List<int> affectedIndices) {
        lock (job.RenderLock) {
            foreach (var index in affectedIndices) {
                job.RenderedSet.Remove(index);
                ResetPhonemeTimingPhraseJob(job.Phrases, index);
            }
            job.PriorityPhraseIndex = affectedIndices.Count > 0 ? affectedIndices.Min() : -1;
        }
    }

    private static void ResetPhonemeTimingPhraseJob(List<PhraseJob>? phrases, int index) {
        if (phrases == null || index < 0 || index >= phrases.Count) {
            return;
        }
        phrases[index].Status = "pending";
        phrases[index].Error = null;
        phrases[index].OutputPath = null;
    }

    private void StartDetachedPhonemeTimingRender(SynthesisJob job, List<RenderPhrase> phrases, IRenderer renderer) {
        Task.Run(() => {
            try {
                RenderPhrases(job, phrases, renderer);
                CompletePhonemeTimingRenderIfDone(job);
            } catch (Exception ex) {
                Log.Error(ex, "Job {JobId}: re-render after phoneme timing edit failed.", job.JobId);
            }
        });
    }

    private void CompletePhonemeTimingRenderIfDone(SynthesisJob job) {
        if (!AllPhonemeTimingPhrasesRendered(job)) {
            return;
        }
        try {
            var fullOutputPath = Path.Combine(_outputDir, $"{job.JobId}.wav");
            MergePhrasesToWav(job, fullOutputPath, 44100);
            job.OutputPath = fullOutputPath;
        } catch (Exception ex) {
            Log.Warning("Job {JobId}: full WAV merge after phoneme timing edit failed: {Error}", job.JobId, ex.Message);
        }
        job.Status = "completed";
        job.Progress = null;
    }

    private static bool AllPhonemeTimingPhrasesRendered(SynthesisJob job) {
        lock (job.RenderLock) {
            return job.RenderedSet.Count >= (job.AllPhrases?.Count ?? 0);
        }
    }

    private static PhonemeTimingEditResponse PhonemeTimingResponse(
        PhonemeTimingSnapshotResponse snapshot,
        List<int> affectedIndices) {
        return new PhonemeTimingEditResponse {
            Snapshot = snapshot,
            AffectedIndices = affectedIndices,
        };
    }
}
