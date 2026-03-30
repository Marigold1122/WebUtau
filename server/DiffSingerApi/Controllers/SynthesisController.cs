using DiffSingerApi.Models;
using DiffSingerApi.Services;
using Microsoft.AspNetCore.Mvc;

namespace DiffSingerApi.Controllers;

[ApiController]
[Route("api")]
public class SynthesisController : ControllerBase {
    private readonly SynthesisService _synthesis;

    public SynthesisController(SynthesisService synthesis) {
        _synthesis = synthesis;
    }

    [HttpPost("synthesize")]
    [RequestSizeLimit(50_000_000)] // 50MB max for MIDI
    public IActionResult Synthesize([FromForm] IFormFile midi, [FromForm] string singerId, [FromForm] string? defaultLanguageCode) {
        if (midi == null || midi.Length == 0)
            return BadRequest(new { error = "No MIDI file provided." });
        if (string.IsNullOrWhiteSpace(singerId))
            return BadRequest(new { error = "No singerId provided." });

        var midiPath = _synthesis.SaveUploadedMidi(midi.OpenReadStream(), midi.FileName);
        var jobId = _synthesis.EnqueueJob(midiPath, singerId, defaultLanguageCode);

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
    /// 获取音高曲线数据（基础音高 + PITD 偏差）
    /// </summary>
    [HttpGet("jobs/{id}/pitch")]
    public IActionResult GetPitch(string id) {
        var job = _synthesis.GetJob(id);
        if (job == null)
            return NotFound(new { error = "Job not found." });

        var (devXs, devYs) = _synthesis.GetPitchDeviation(job);

        // 坐标换算：OpenUtau 内部 480 → 前端原始 MIDI PPQ
        int ppq = job.MidiPPQ;
        var convertedDevXs = devXs.Select(x => x * ppq / 480).ToList();

        if (job.PitchCurve == null || job.PitchCurve.Count == 0)
            return Ok(new {
                pitchCurve = Array.Empty<object>(),
                pitchDeviation = new { xs = convertedDevXs, ys = devYs },
            });

        return Ok(new {
            pitchCurve = job.PitchCurve.Select(p => new {
                tick = p.Tick * ppq / 480,
                pitch = p.Pitch,
            }),
            pitchDeviation = new { xs = convertedDevXs, ys = devYs },
        });
    }

    /// <summary>
    /// 接收前端的音高偏移编辑，应用到 PITD 曲线并重渲染受影响的短语
    /// </summary>
    [HttpPost("jobs/{id}/pitch")]
    public IActionResult ApplyPitchDeviation(string id, [FromBody] PitchDeviationRequest req) {
        var job = _synthesis.GetJob(id);
        if (job == null)
            return NotFound(new { error = "Job not found." });
        if (req.Deviation == null || req.Deviation.Count == 0)
            return BadRequest(new { error = "No deviation data." });

        // 坐标换算：前端原始 MIDI PPQ → OpenUtau 内部 480
        int ppq = job.MidiPPQ;
        var deviation = new Dictionary<int, int>();
        foreach (var point in req.Deviation) {
            int internalTick = point.Tick * 480 / ppq;
            deviation[internalTick] = point.Cent;
        }

        _synthesis.ApplyPitchDeviationAndRerender(job, deviation, out var affectedIndices);
        return Ok(new { ok = true, affectedIndices });
    }

    public class PitchDeviationRequest {
        public List<PitchDeviationPoint>? Deviation { get; set; }
    }

    public class PitchDeviationPoint {
        public int Tick { get; set; }
        public int Cent { get; set; }
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
            object result;
            lock (job.RenderLock) {
                result = new {
                    ok = true,
                    affectedIndices,
                    phrases = job.Phrases?.Select((p, i) => {
                        var rp = (job.AllPhrases != null && i < job.AllPhrases.Count)
                            ? job.AllPhrases[i] : null;
                        return new {
                            index = p.Index,
                            startMs = p.StartMs,
                            durationMs = p.DurationMs,
                            status = p.Status,
                            notes = rp?.notes?.Select(n => new {
                                position = n.position + rp.position,
                                duration = n.duration,
                                tone = n.tone,
                                lyric = n.lyric
                            })
                        };
                    }).ToList()
                };
            }
            return Ok(result);
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
