using DiffSingerApi.Models;
using DiffSingerApi.Services;
using Microsoft.AspNetCore.Mvc;
using OpenUtau.Core.Ustx;
using System.Text.Json;

namespace DiffSingerApi.Controllers;

[ApiController]
[Route("api")]
public partial class SynthesisController : ControllerBase {
    private readonly SynthesisService _synthesis;

    public SynthesisController(SynthesisService synthesis) {
        _synthesis = synthesis;
    }

    private PitchResponse BuildPitchResponse(SynthesisJob job, List<int>? affectedIndices = null) {
        var (devXs, devYs) = _synthesis.GetPitchDeviation(job);
        int ppq = job.MidiPPQ > 0 ? job.MidiPPQ : (short)480;
        int pitchStepTick = Math.Max(1, (int)Math.Round(5.0 * ppq / 480.0));

        return new PitchResponse {
            PitchCurve = (job.PitchCurve ?? new List<DiffSingerApi.Models.PitchPoint>())
                .Select(p => new PitchCurvePointResponse {
                    Tick = p.Tick * ppq / 480,
                    Pitch = p.Pitch,
                })
                .ToList(),
            PitchDeviation = new PitchDeviationResponse {
                Xs = devXs.Select(x => x * ppq / 480).ToList(),
                Ys = devYs,
            },
            MidiPpq = ppq,
            PitchStepTick = pitchStepTick,
            AffectedIndices = affectedIndices,
        };
    }

    private static string BuildNoteKey(int position, int duration, int tone) {
        return $"{position}:{duration}:{tone}";
    }

    private static NotePitchData? BuildPitchDataResponse(UPitch? pitch) {
        if (pitch == null) {
            return null;
        }
        return new NotePitchData {
            SnapFirst = pitch.snapFirst,
            Data = pitch.data.Select(point => new NotePitchPointData {
                X = point.X,
                Y = point.Y,
                Shape = point.shape.ToString(),
            }).ToList(),
        };
    }

    private static NoteVibratoData? BuildVibratoDataResponse(UVibrato? vibrato) {
        if (vibrato == null) {
            return null;
        }
        return new NoteVibratoData {
            Length = vibrato.length,
            Period = vibrato.period,
            Depth = vibrato.depth,
            In = vibrato.@in,
            Out = vibrato.@out,
            Shift = vibrato.shift,
            Drift = vibrato.drift,
            VolLink = vibrato.volLink,
        };
    }

    private static Dictionary<string, Queue<UNote>> BuildNoteLookup(SynthesisJob job) {
        var lookup = new Dictionary<string, Queue<UNote>>();
        foreach (var part in job.VoiceParts ?? new List<UVoicePart>()) {
            foreach (var note in part.notes.OrderBy(note => note.position).ThenBy(note => note.tone)) {
                var key = BuildNoteKey(part.position + note.position, note.duration, note.tone);
                if (!lookup.TryGetValue(key, out var queue)) {
                    queue = new Queue<UNote>();
                    lookup[key] = queue;
                }
                queue.Enqueue(note);
            }
        }
        return lookup;
    }

    private List<PhraseDetailResponse> BuildPhraseResponses(SynthesisJob job) {
        var noteLookup = BuildNoteLookup(job);
        var responses = new List<PhraseDetailResponse>();
        lock (job.RenderLock) {
            if (job.Phrases == null) {
                return responses;
            }
            for (int index = 0; index < job.Phrases.Count; index++) {
                var phraseJob = job.Phrases[index];
                var renderPhrase = (job.AllPhrases != null && index < job.AllPhrases.Count)
                    ? job.AllPhrases[index]
                    : null;
                var notes = new List<NoteDetailResponse>();
                if (renderPhrase?.notes != null) {
                    foreach (var renderNote in renderPhrase.notes) {
                        int absolutePosition = renderPhrase.position + renderNote.position;
                        var key = BuildNoteKey(absolutePosition, renderNote.duration, renderNote.tone);
                        UNote? sourceNote = null;
                        if (noteLookup.TryGetValue(key, out var queue) && queue.Count > 0) {
                            sourceNote = queue.Dequeue();
                        }
                        notes.Add(new NoteDetailResponse {
                            Position = absolutePosition,
                            Duration = renderNote.duration,
                            Tone = renderNote.tone,
                            Lyric = sourceNote?.lyric ?? renderNote.lyric,
                            Tuning = sourceNote?.tuning ?? renderNote.tuning,
                            Pitch = BuildPitchDataResponse(sourceNote?.pitch),
                            Vibrato = BuildVibratoDataResponse(sourceNote?.vibrato),
                        });
                    }
                }
                responses.Add(new PhraseDetailResponse {
                    Index = phraseJob.Index,
                    StartMs = phraseJob.StartMs,
                    DurationMs = phraseJob.DurationMs,
                    Status = phraseJob.Status,
                    Notes = notes,
                });
            }
        }
        return responses;
    }

    private NoteParamsResponse BuildNoteParamsResponse(SynthesisJob job, List<int>? affectedIndices = null) {
        var pitchResponse = BuildPitchResponse(job, affectedIndices);
        return new NoteParamsResponse {
            Ok = true,
            AffectedIndices = pitchResponse.AffectedIndices,
            PitchCurve = pitchResponse.PitchCurve,
            PitchDeviation = pitchResponse.PitchDeviation,
            MidiPpq = pitchResponse.MidiPpq,
            PitchStepTick = pitchResponse.PitchStepTick,
            Phrases = BuildPhraseResponses(job),
        };
    }

    [HttpPost("synthesize")]
    [RequestSizeLimit(50_000_000)] // 50MB max for MIDI
    public IActionResult Synthesize(
        [FromForm] IFormFile midi,
        [FromForm] string singerId,
        [FromForm] string? defaultLanguageCode,
        [FromForm] string? noteParamsJson) {
        if (midi == null || midi.Length == 0)
            return BadRequest(new { error = "No MIDI file provided." });
        if (string.IsNullOrWhiteSpace(singerId))
            return BadRequest(new { error = "No singerId provided." });

        List<NoteParamsEdit> initialNoteParams = new();
        if (!string.IsNullOrWhiteSpace(noteParamsJson)) {
            try {
                initialNoteParams = JsonSerializer.Deserialize<List<NoteParamsEdit>>(noteParamsJson, new JsonSerializerOptions {
                    PropertyNameCaseInsensitive = true,
                }) ?? new List<NoteParamsEdit>();
            } catch (JsonException ex) {
                return BadRequest(new { error = $"Invalid noteParamsJson: {ex.Message}" });
            }
        }

        var midiPath = _synthesis.SaveUploadedMidi(midi.OpenReadStream(), midi.FileName);
        var jobId = _synthesis.EnqueueJob(midiPath, singerId, defaultLanguageCode, initialNoteParams);

        return Ok(new { jobId });
    }

    [HttpGet("jobs/{id}")]
    public IActionResult GetJob(string id) {
        var job = _synthesis.GetJob(id);
        if (job == null)
            return NotFound(new { error = "Job not found." });

        return Ok(new {
            jobId = job.JobId,
            status = job.Status,
            progress = job.Progress,
            error = job.Error,
            sampleRate = job.SampleRate,
            phrases = job.Phrases?.Select(p => new {
                index = p.Index,
                startMs = p.StartMs,
                durationMs = p.DurationMs,
                status = p.Status,
                error = p.Error,
            }),
        });
    }

    /// <summary>
    /// 设置优先渲染的短语（前端播放头位置对应的短语）
    /// </summary>
    [HttpPost("jobs/{id}/priority")]
    public IActionResult SetPriority(string id, [FromBody] PriorityRequest req) {
        var job = _synthesis.GetJob(id);
        if (job == null)
            return NotFound(new { error = "Job not found." });

        _synthesis.SetPriority(id, req.PhraseIndex);
        return Ok(new { ok = true });
    }

    public class PriorityRequest {
        public int PhraseIndex { get; set; }
    }

    /// <summary>
    /// 下载单个短语的 WAV 片段
    /// </summary>
    [HttpGet("jobs/{id}/phrases/{index:int}")]
    public IActionResult DownloadPhrase(string id, int index) {
        var job = _synthesis.GetJob(id);
        if (job?.Phrases == null || index < 0 || index >= job.Phrases.Count)
            return NotFound(new { error = "Phrase not found." });

        var phrase = job.Phrases[index];
        if (phrase.Status != "completed" || phrase.OutputPath == null)
            return BadRequest(new { error = "Phrase not ready." });
        if (!System.IO.File.Exists(phrase.OutputPath))
            return NotFound(new { error = "Phrase file not found." });

        Response.Headers["Cache-Control"] = "no-store, no-cache, max-age=0";
        Response.Headers["Pragma"] = "no-cache";
        Response.Headers["Expires"] = "0";
        Response.Headers["Content-Disposition"] = "inline";
        var stream = System.IO.File.OpenRead(phrase.OutputPath);
        return File(stream, "audio/wav");
    }

    /// <summary>
    /// 下载完整混合 WAV (全部短语拼接)
    /// </summary>
    [HttpGet("jobs/{id}/download")]
    public IActionResult Download(string id) {
        var job = _synthesis.GetJob(id);
        if (job == null)
            return NotFound(new { error = "Job not found." });
        if (job.Status != "completed" || job.OutputPath == null)
            return BadRequest(new { error = "Job not completed yet." });
        if (!System.IO.File.Exists(job.OutputPath))
            return NotFound(new { error = "Output file not found." });

        var stream = System.IO.File.OpenRead(job.OutputPath);
        return File(stream, "audio/wav", $"{id}.wav");
    }

    [HttpDelete("jobs/{id}")]
    public IActionResult DeleteJob(string id) {
        return _synthesis.DeleteJob(id)
            ? Ok(new { deleted = true })
            : NotFound(new { error = "Job not found." });
    }

    /// <summary>
    /// 客户端心跳。客户端（网页 / Tauri / 其它嵌入方式）每 15 秒左右调一次，
    /// 服务端超过 JobIdleTimeoutSeconds（默认 60s）没收到心跳就自动取消 job，
    /// 防止用户关闭页面后仍占用 GPU。
    /// 返回 404 表示服务端已经没这个 job，客户端应停止后续心跳。
    /// </summary>
    [HttpPost("jobs/{id}/heartbeat")]
    public IActionResult Heartbeat(string id) {
        return _synthesis.Heartbeat(id)
            ? Ok(new { ok = true })
            : NotFound(new { error = "Job not found or already finished." });
    }

    /// <summary>
    /// 获取音高曲线数据（基础音高 + PITD 偏差）
    /// </summary>
    [HttpGet("jobs/{id}/pitch")]
    public IActionResult GetPitch(string id) {
        var job = _synthesis.GetJob(id);
        if (job == null)
            return NotFound(new { error = "Job not found." });

        return Ok(BuildPitchResponse(job));
    }

    [HttpGet("jobs/{id}/phoneme-timings")]
    public IActionResult GetPhonemeTimings(string id) {
        var job = _synthesis.GetJob(id);
        if (job == null)
            return NotFound(new { error = "job_not_found" });

        try {
            return Ok(_synthesis.GetPhonemeTimings(job));
        } catch (PhonemeTimingReadException ex) {
            return StatusCode(ex.StatusCode, new {
                error = ex.Code,
                message = ex.Message,
            });
        }
    }

    /// <summary>
    /// 接收前端的音高偏移编辑，应用到 PITD 曲线并重渲染受影响的短语
    /// </summary>
    [HttpPost("jobs/{id}/pitch")]
    public IActionResult ApplyPitchDeviation(string id, [FromBody] PitchDeviationRequest req) {
        var job = _synthesis.GetJob(id);
        if (job == null)
            return NotFound(new { error = "Job not found." });

        // 坐标换算：前端原始 MIDI PPQ → OpenUtau 内部 480
        int ppq = job.MidiPPQ > 0 ? job.MidiPPQ : (short)480;
        var deviation = new Dictionary<int, int>();
        foreach (var point in req.Deviation ?? new List<PitchDeviationPoint>()) {
            int internalTick = point.Tick * 480 / ppq;
            deviation[internalTick] = point.Cent;
        }

        _synthesis.ApplyPitchDeviationAndRerender(job, deviation, out var affectedIndices);
        return Ok(BuildPitchResponse(job, affectedIndices));
    }

    [HttpPost("jobs/{id}/note-params")]
    public IActionResult ApplyNoteParams(string id, [FromBody] NoteParamsRequest req) {
        var job = _synthesis.GetJob(id);
        if (job == null)
            return NotFound(new { error = "Job not found." });
        if (req.Notes == null || req.Notes.Count == 0)
            return BadRequest(new { error = "No note params provided." });
        if (job.Project == null)
            return BadRequest(new { error = "Job has no render context (not yet prepared)." });

        int ppq = job.MidiPPQ > 0 ? job.MidiPPQ : (short)480;
        var updates = req.Notes.Select(note => new NoteParamsEdit {
            Position = note.Position * 480 / ppq,
            Duration = Math.Max(1, note.Duration * 480 / ppq),
            Tone = note.Tone,
            Tuning = note.Tuning,
            Pitch = note.Pitch,
            Vibrato = note.Vibrato,
            ClearPitchDeviation = note.ClearPitchDeviation,
        }).ToList();

        try {
            _synthesis.ApplyNoteParamsAndRerender(job, updates, out var affectedIndices);
            return Ok(BuildNoteParamsResponse(job, affectedIndices));
        } catch (Exception ex) {
            return StatusCode(500, new {
                error = $"note-params internal error: {ex.Message}",
                stackTrace = ex.StackTrace,
            });
        }
    }

    public class PitchDeviationRequest {
        public List<PitchDeviationPoint>? Deviation { get; set; }
    }

    public class NoteParamsRequest {
        public List<NoteParamsEdit>? Notes { get; set; }
    }

    public class PitchDeviationPoint {
        public int Tick { get; set; }
        public int Cent { get; set; }
    }

    public class PitchResponse {
        public List<PitchCurvePointResponse> PitchCurve { get; set; } = new();
        public PitchDeviationResponse PitchDeviation { get; set; } = new();
        public int MidiPpq { get; set; }
        public int PitchStepTick { get; set; }
        public List<int>? AffectedIndices { get; set; }
    }

    public class NoteParamsResponse : PitchResponse {
        public bool Ok { get; set; }
        public List<PhraseDetailResponse> Phrases { get; set; } = new();
    }

    public class PhraseDetailResponse {
        public int Index { get; set; }
        public double StartMs { get; set; }
        public double DurationMs { get; set; }
        public string Status { get; set; } = "pending";
        public List<NoteDetailResponse> Notes { get; set; } = new();
    }

    public class NoteDetailResponse {
        public int Position { get; set; }
        public int Duration { get; set; }
        public int Tone { get; set; }
        public string Lyric { get; set; } = "a";
        public int Tuning { get; set; }
        public NotePitchData? Pitch { get; set; }
        public NoteVibratoData? Vibrato { get; set; }
    }

    public class PitchCurvePointResponse {
        public int Tick { get; set; }
        public float Pitch { get; set; }
    }

    public class PitchDeviationResponse {
        public List<int> Xs { get; set; } = new();
        public List<int> Ys { get; set; } = new();
    }

    /// <summary>
    /// 增量编辑音符：不重新加载 MIDI，直接操作内存中的 UProject
    /// </summary>
    [HttpPost("jobs/{id}/edit-notes")]
    public IActionResult EditNotes(string id, [FromBody] EditNotesRequest req) {
        var job = _synthesis.GetJob(id);
        if (job == null)
            return NotFound(new { error = "Job not found." });
        if (req.Edits == null || req.Edits.Count == 0)
            return BadRequest(new { error = "No edits provided." });
        if (job.Project == null)
            return BadRequest(new { error = "Job has no render context (not yet prepared)." });

        try {
            _synthesis.ApplyNoteEdits(job, req.Edits, out var affectedIndices);

            // 返回更新后的 phrases 列表（短语划分可能变了）+ note-level 结构
            return Ok(BuildNoteParamsResponse(job, affectedIndices));
        } catch (EditNotesRejectedException ex) {
            return Conflict(new { error = ex.Message });
        } catch (Exception ex) {
            return StatusCode(500, new {
                error = $"edit-notes internal error: {ex.Message}",
                stackTrace = ex.StackTrace,
            });
        }
    }

    public class EditNotesRequest {
        public List<DiffSingerApi.Models.NoteEdit>? Edits { get; set; }
    }
}
