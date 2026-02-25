using OpenUtau.Core.Render;
using OpenUtau.Core.Ustx;

namespace DiffSingerApi.Models;

public class SynthesisJob {
    public string JobId { get; set; } = string.Empty;
    public string MidiPath { get; set; } = string.Empty;
    public string SingerId { get; set; } = string.Empty;
    public string Status { get; set; } = "queued"; // queued | preparing | rendering | completed | failed
    public string? Progress { get; set; }
    public string? OutputPath { get; set; }
    public string? Error { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public List<PhraseJob>? Phrases { get; set; }
    public int SampleRate { get; set; } = 44100;
    /// <summary>
    /// 前端请求优先渲染的短语 index，-1 表示无优先级请求
    /// </summary>
    public int PriorityPhraseIndex { get; set; } = -1;
    /// <summary>
    /// 音高曲线数据（tick, MIDI浮点音高）
    /// </summary>
    public List<PitchPoint>? PitchCurve { get; set; }
    /// <summary>
    /// 原始 MIDI 文件的 PPQ（用于坐标系换算，OpenUtau 内部固定 480）
    /// </summary>
    public short MidiPPQ { get; set; } = 480;

    // === 保留渲染上下文，供前端音高编辑后重新渲染 ===
    [System.Text.Json.Serialization.JsonIgnore]
    public UProject? Project { get; set; }
    [System.Text.Json.Serialization.JsonIgnore]
    public List<UVoicePart>? VoiceParts { get; set; }
    [System.Text.Json.Serialization.JsonIgnore]
    public List<RenderPhrase>? AllPhrases { get; set; }
    [System.Text.Json.Serialization.JsonIgnore]
    public IRenderer? Renderer { get; set; }

    // === 渲染循环共享状态，供 edit-notes 将 affected phrases 退回渲染队列 ===
    /// <summary>
    /// 已渲染完成的 phrase index 集合。RenderPhrases 循环和 ApplyNoteEdits 共同操作。
    /// </summary>
    [System.Text.Json.Serialization.JsonIgnore]
    public HashSet<int> RenderedSet { get; set; } = new();
    /// <summary>
    /// 保护 RenderedSet / Phrases / AllPhrases 并发访问的锁
    /// </summary>
    [System.Text.Json.Serialization.JsonIgnore]
    public object RenderLock { get; } = new();
    /// <summary>
    /// 当前正在渲染的单个 phrase 的 CancellationTokenSource。
    /// edit-notes / pitch-edit 可以 Cancel 它来中断当前渲染，让循环立即跳到优先 phrase。
    /// </summary>
    [System.Text.Json.Serialization.JsonIgnore]
    public CancellationTokenSource? CurrentPhraseCts;
    /// <summary>
    /// 渲染循环暂停门。edit 时 Reset() 关门暂停循环，处理完 Set() 开门恢复。
    /// </summary>
    [System.Text.Json.Serialization.JsonIgnore]
    public ManualResetEventSlim RenderGate { get; } = new(true); // 默认开门
}

public class PhraseJob {
    public int Index { get; set; }
    public double StartMs { get; set; }
    public double DurationMs { get; set; }
    public string Status { get; set; } = "pending"; // pending | rendering | completed | failed
    public string? OutputPath { get; set; }
    public string? Error { get; set; }
}

public class VoicebankInfo {
    public string Id { get; set; } = string.Empty;
    public string Name { get; set; } = string.Empty;
    public string SingerType { get; set; } = string.Empty;
}

public class PitchPoint {
    public int Tick { get; set; }
    public float Pitch { get; set; }  // MIDI 浮点音高（如 60.5 = C4 偏高 50 cents）
}

/// <summary>
/// 前端发来的单条音符编辑指令
/// </summary>
public class NoteEdit {
    /// <summary>add / remove / move / resize / lyric</summary>
    public string Action { get; set; } = string.Empty;
    /// <summary>音符位置（前端 tick 坐标）</summary>
    public int Position { get; set; }
    /// <summary>音符时长（前端 tick 坐标）</summary>
    public int Duration { get; set; }
    /// <summary>MIDI 音高</summary>
    public int Tone { get; set; }
    /// <summary>歌词</summary>
    public string? Lyric { get; set; }
    // move 专用：新位置和新音高
    public int? NewPosition { get; set; }
    public int? NewTone { get; set; }
}
