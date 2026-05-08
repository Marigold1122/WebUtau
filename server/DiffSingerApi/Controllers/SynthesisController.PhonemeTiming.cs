using DiffSingerApi.Models;
using DiffSingerApi.Services;
using Microsoft.AspNetCore.Mvc;
using OpenUtau.Core.Ustx;

namespace DiffSingerApi.Controllers;

public partial class SynthesisController {
    [HttpPost("jobs/{id}/phoneme-timings")]
    public IActionResult ApplyPhonemeTiming(string id, [FromBody] PhonemeTimingEditRequest? request) {
        var job = _synthesis.GetJob(id);
        if (job == null) {
            return NotFound(new { error = "job_not_found" });
        }
        if (request == null) {
            return BadRequest(new { error = "invalid_request" });
        }

        try {
            var response = _synthesis.ApplyPhonemeTimingEditAndRerender(job, request);
            if (response.AffectedIndices.Count > 0) {
                response.Phrases = BuildPhonemeTimingPhraseResponses(job);
            }
            return Ok(response);
        } catch (PhonemeTimingEditException ex) {
            return StatusCode(ex.StatusCode, new {
                error = ex.Code,
                message = ex.Message,
            });
        } catch (PhonemeTimingReadException ex) {
            return StatusCode(ex.StatusCode, new {
                error = ex.Code,
                message = ex.Message,
            });
        } catch (Exception ex) {
            return StatusCode(500, new {
                error = "phoneme_timing_internal_error",
                message = ex.Message,
            });
        }
    }

    private List<PhonemeTimingPhraseDto> BuildPhonemeTimingPhraseResponses(SynthesisJob job) {
        var noteLookup = BuildNoteLookup(job);
        var responses = new List<PhonemeTimingPhraseDto>();
        lock (job.RenderLock) {
            if (job.Phrases == null) {
                return responses;
            }
            for (var index = 0; index < job.Phrases.Count; index++) {
                responses.Add(BuildPhonemeTimingPhrase(job, noteLookup, index));
            }
        }
        return responses;
    }

    private PhonemeTimingPhraseDto BuildPhonemeTimingPhrase(
        SynthesisJob job,
        Dictionary<string, Queue<UNote>> noteLookup,
        int index) {
        var phraseJob = job.Phrases![index];
        var renderPhrase = job.AllPhrases != null && index < job.AllPhrases.Count
            ? job.AllPhrases[index]
            : null;
        return new PhonemeTimingPhraseDto {
            Index = phraseJob.Index,
            StartMs = phraseJob.StartMs,
            DurationMs = phraseJob.DurationMs,
            Status = phraseJob.Status,
            Notes = BuildPhonemeTimingNotes(renderPhrase, noteLookup),
        };
    }

    private static List<PhonemeTimingNoteDto> BuildPhonemeTimingNotes(
        OpenUtau.Core.Render.RenderPhrase? renderPhrase,
        Dictionary<string, Queue<UNote>> noteLookup) {
        var notes = new List<PhonemeTimingNoteDto>();
        if (renderPhrase?.notes == null) {
            return notes;
        }
        foreach (var renderNote in renderPhrase.notes) {
            notes.Add(BuildPhonemeTimingNote(renderPhrase, renderNote, noteLookup));
        }
        return notes;
    }

    private static PhonemeTimingNoteDto BuildPhonemeTimingNote(
        OpenUtau.Core.Render.RenderPhrase renderPhrase,
        OpenUtau.Core.Render.RenderNote renderNote,
        Dictionary<string, Queue<UNote>> noteLookup) {
        var absolutePosition = renderPhrase.position + renderNote.position;
        var key = BuildNoteKey(absolutePosition, renderNote.duration, renderNote.tone);
        var sourceNote = TakeSourceNote(noteLookup, key);
        return new PhonemeTimingNoteDto {
            Position = absolutePosition,
            Duration = renderNote.duration,
            Tone = renderNote.tone,
            Lyric = sourceNote?.lyric ?? renderNote.lyric,
            Tuning = sourceNote?.tuning ?? renderNote.tuning,
            Pitch = BuildPitchDataResponse(sourceNote?.pitch),
            Vibrato = BuildVibratoDataResponse(sourceNote?.vibrato),
        };
    }

    private static UNote? TakeSourceNote(Dictionary<string, Queue<UNote>> noteLookup, string key) {
        if (!noteLookup.TryGetValue(key, out var queue) || queue.Count == 0) {
            return null;
        }
        return queue.Dequeue();
    }
}
