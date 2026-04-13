using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text;
using DiffSingerApi.Models;
using NAudio.Wave;
using OpenUtau.Api;
using OpenUtau.Core;
using OpenUtau.Core.Format;
using OpenUtau.Core.Render;
using OpenUtau.Core.SignalChain;
using OpenUtau.Core.Ustx;
using OpenUtau.Core.Util;
using Serilog;

namespace DiffSingerApi.Services;

public class SynthesisService : IHostedService {
    private readonly ConcurrentDictionary<string, SynthesisJob> _jobs = new();
    private readonly ConcurrentQueue<string> _queue = new();
    private readonly string _outputDir;
    private readonly string _uploadsDir;
    private readonly string _voicebanksDir;
    private Thread? _workerThread;
    private readonly CancellationTokenSource _cts = new();
    private readonly ManualResetEventSlim _signal = new(false);
    private bool _initialized;

    public SynthesisService(IConfiguration config) {
        var basePath = AppContext.BaseDirectory;
        var configuredVoicebanksPath = config.GetValue<string>("VoicebanksPath");
        var configuredOutputPath = config.GetValue<string>("OutputPath");
        var configuredUploadsPath = config.GetValue<string>("UploadsPath");
        _outputDir = ResolveRuntimePath(basePath, configuredOutputPath, "output");
        _uploadsDir = ResolveRuntimePath(basePath, configuredUploadsPath, "uploads");
        _voicebanksDir = ResolveRuntimePath(basePath, configuredVoicebanksPath, "voicebanks");
        Directory.CreateDirectory(_outputDir);
        Directory.CreateDirectory(_uploadsDir);
        Directory.CreateDirectory(_voicebanksDir);
    }

    public string VoicebanksDir => _voicebanksDir;
    public bool IsInitialized => _initialized;

    public Task StartAsync(CancellationToken cancellationToken) {
        _workerThread = new Thread(WorkerLoop) {
            Name = "SynthesisWorker",
            IsBackground = true
        };
        _workerThread.Start();
        return Task.CompletedTask;
    }

    public Task StopAsync(CancellationToken cancellationToken) {
        _cts.Cancel();
        _signal.Set();
        _workerThread?.Join(TimeSpan.FromSeconds(10));
        return Task.CompletedTask;
    }

    public string EnqueueJob(string midiPath, string singerId, string? defaultLanguageCode) {
        // 不再自动取消其它 job —— 多用户并发下每个 job 独立运行。
        // 前端若需要放弃旧任务，应显式调用 DELETE /api/jobs/{id}。

        var job = new SynthesisJob {
            JobId = Guid.NewGuid().ToString("N")[..12],
            MidiPath = midiPath,
            SingerId = singerId,
            DefaultLanguageCode = DiffSingerPhonemizerSelector.NormalizeLanguageCode(defaultLanguageCode),
            Status = "queued"
        };
        _jobs[job.JobId] = job;
        _queue.Enqueue(job.JobId);
        _signal.Set();
        return job.JobId;
    }

    public SynthesisJob? GetJob(string jobId) {
        _jobs.TryGetValue(jobId, out var job);
        return job;
    }

    public bool DeleteJob(string jobId) {
        if (!_jobs.TryRemove(jobId, out var job)) return false;
        // 取消进行中的准备/渲染。worker 线程检测到后会把状态置为 failed，
        // 之后文件清理才不会和写入竞争。
        try { job.JobCts.Cancel(); } catch { /* ignore */ }
        job.CurrentPhraseCts?.Cancel();
        CleanupJobOutputArtifacts(jobId, includeMergedOutput: true);
        TryDeleteFile(job.MidiPath, "uploaded midi cleanup", jobId);
        return true;
    }

    public string SaveUploadedMidi(Stream stream, string fileName) {
        var safeName = $"{Guid.NewGuid():N}_{Path.GetFileName(fileName)}";
        var path = Path.Combine(_uploadsDir, safeName);
        using var fs = File.Create(path);
        stream.CopyTo(fs);
        return path;
    }

    private void WorkerLoop() {
        try {
            InitializeOpenUtau();
            _initialized = true;
            Log.Information("SynthesisService worker initialized.");
        } catch (Exception ex) {
            Log.Error(ex, "Failed to initialize OpenUtau engine.");
            return;
        }

        while (!_cts.IsCancellationRequested) {
            _signal.Wait(_cts.Token);
            _signal.Reset();

            while (_queue.TryDequeue(out var jobId)) {
                if (_cts.IsCancellationRequested) break;
                if (!_jobs.TryGetValue(jobId, out var job)) continue;

                // 使用 job 自己的 CancellationTokenSource。只有 DeleteJob 会取消它。
                var jobCts = job.JobCts;

                try {
                    // 阶段 1: 准备（音素化 + 音高预测）—— 前端弹窗阻塞
                    job.Status = "preparing";
                    job.Progress = "Loading MIDI...";
                    var (allPhrases, renderer) = PrepareJob(job);

                    if (jobCts.IsCancellationRequested) {
                        job.Status = "failed";
                        job.Error = "Cancelled.";
                        continue;
                    }

                    // 阶段 2: 渲染短语 —— 前端可操作，支持优先级
                    job.Status = "rendering";
                    lock (job.RenderLock) { job.RenderedSet.Clear(); }
                    RenderPhrases(job, allPhrases, renderer, jobCts.Token);

                    if (jobCts.IsCancellationRequested) {
                        job.Status = "failed";
                        job.Error = "Cancelled.";
                        continue;
                    }

                    // 阶段 3: 合并完整 WAV（用于下载）
                    job.Progress = "Writing full WAV...";
                    try {
                        var fullOutputPath = Path.Combine(_outputDir, $"{job.JobId}.wav");
                        MergePhrasesToWav(job, fullOutputPath, 44100);
                        job.OutputPath = fullOutputPath;
                    } catch (Exception ex) {
                        Log.Warning("Job {JobId}: full WAV merge failed: {Error}", job.JobId, ex.Message);
                    }

                    job.Status = "completed";
                    job.Progress = null;
                } catch (OperationCanceledException) {
                    job.Status = "failed";
                    job.Error = "Cancelled.";
                    Log.Information("Job {JobId} cancelled.", jobId);
                } catch (Exception ex) {
                    Log.Error(ex, "Synthesis job {JobId} failed.", jobId);
                    job.Status = "failed";
                    job.Error = ex.Message;
                    job.Progress = null;
                }
            }

            CleanupOldJobs();
        }
    }

    private void InitializeOpenUtau() {
        Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);

        Preferences.Default.AdditionalSingerPath = _voicebanksDir;

        Directory.CreateDirectory(PathManager.Inst.CachePath);
        Directory.CreateDirectory(PathManager.Inst.SingersPath);

        DocManager.Inst.Initialize(Thread.CurrentThread, TaskScheduler.Default);
        DocManager.Inst.PostOnUIThread = action => {
            DocManager.Inst.mainThread = Thread.CurrentThread;
            action();
        };

        SingerManager.Inst.Initialize();
        Log.Information("Found {Count} singer(s).", SingerManager.Inst.Singers.Count);
        foreach (var kv in SingerManager.Inst.Singers) {
            Log.Information("  {Key} ({Type})", kv.Key, kv.Value.SingerType);
        }
    }

    public void ReloadSingers() {
        Preferences.Default.AdditionalSingerPath = _voicebanksDir;
        SingerManager.Inst.Initialize();
    }

    /// <summary>
    /// 导出当前 PITD UCurve 数据为前端可用的稀疏控制点格式。
    /// xs 是全局 tick，ys 是 cent 偏移值。
    /// </summary>
    public (List<int> xs, List<int> ys) GetPitchDeviation(SynthesisJob job) {
        var allXs = new List<int>();
        var allYs = new List<int>();
        if (job.VoiceParts == null) return (allXs, allYs);

        foreach (var part in job.VoiceParts) {
            var pitchCurve = part.curves.FirstOrDefault(c => c.abbr == Ustx.PITD);
            if (pitchCurve == null || pitchCurve.IsEmpty) continue;
            for (int i = 0; i < pitchCurve.xs.Count; i++) {
                // UCurve 中 xs 是 part-local tick，转为全局 tick
                allXs.Add(pitchCurve.xs[i] + part.position);
                allYs.Add(pitchCurve.ys[i]);
            }
        }

        // 按 tick 排序
        if (allXs.Count > 1) {
            var zipped = allXs.Zip(allYs, (x, y) => (x, y)).OrderBy(p => p.x).ToList();
            allXs = zipped.Select(p => p.x).ToList();
            allYs = zipped.Select(p => p.y).ToList();
        }

        return (allXs, allYs);
    }

    /// <summary>
    /// 设置优先渲染的短语 index（从播放头位置开始）
    /// </summary>
    public void SetPriority(string jobId, int phraseIndex) {
        if (_jobs.TryGetValue(jobId, out var job)) {
            job.PriorityPhraseIndex = phraseIndex;
        }
    }

    /// <summary>
    /// 阶段 1: 准备 —— 加载 MIDI、音素化、音高预测、提取短语列表
    /// 此阶段完成后前端弹窗关闭，用户可以自由操作
    /// </summary>
    private (List<RenderPhrase> allPhrases, IRenderer renderer) PrepareJob(SynthesisJob job) {
        // Find singer
        var singer = SingerManager.Inst.Singers.Values
            .FirstOrDefault(s => s.Id == job.SingerId)
            ?? SingerManager.Inst.Singers.Values
                .FirstOrDefault(s => s.Id.Contains(job.SingerId));
        if (singer == null)
            throw new InvalidOperationException($"Singer not found: {job.SingerId}");

        // Load MIDI
        job.Progress = "Loading MIDI...";
        var project = MidiWriter.LoadProject(job.MidiPath);

        // 读取原始 MIDI PPQ（OpenUtau 内部统一用 480，需要记录原始值用于坐标换算）
        try {
            var midiFile = Melanchall.DryWetMidi.Core.MidiFile.Read(job.MidiPath, MidiWriter.BaseReadingSettings());
            if (midiFile.TimeDivision is Melanchall.DryWetMidi.Core.TicksPerQuarterNoteTimeDivision tpqn) {
                job.MidiPPQ = tpqn.TicksPerQuarterNote;
            }
        } catch { /* 读取失败则保持默认 480 */ }
        Log.Information("Job {JobId}: MIDI PPQ = {PPQ}, OpenUtau resolution = 480", job.JobId, job.MidiPPQ);

        // Find phonemizer
        var phonemizerFactory = DiffSingerPhonemizerSelector.Select(job.DefaultLanguageCode);
        Log.Information("Job {JobId}: selected phonemizer {Phonemizer} for language {Language}",
            job.JobId,
            phonemizerFactory?.type.FullName ?? "N/A",
            job.DefaultLanguageCode);

        // Assign singer + phonemizer + renderer
        foreach (var track in project.tracks) {
            track.Singer = singer;
            if (phonemizerFactory != null)
                track.Phonemizer = phonemizerFactory.Create();
            track.RendererSettings.renderer = "DIFFSINGER";
        }

        DocManager.Inst.ExecuteCmd(new LoadProjectNotification(project));

        // Phonemization
        job.Progress = "Phonemizing...";
        project.ValidateFull();

        var voiceParts = project.parts.OfType<UVoicePart>().ToList();
        WaitForPhonemization(voiceParts, 120, 1000, "prepare");

        project.Validate(new ValidateOptions { SkipPhonemizer = true });

        var totalPhrases = voiceParts.Sum(p => p.renderPhrases.Count);
        if (totalPhrases == 0) {
            Thread.Sleep(3000);
            project.Validate(new ValidateOptions { SkipPhonemizer = true });
            totalPhrases = voiceParts.Sum(p => p.renderPhrases.Count);
        }
        if (totalPhrases == 0)
            throw new InvalidOperationException("No render phrases generated.");

        // Auto-pitch
        var renderer = project.tracks[0].RendererSettings.Renderer;
        if (renderer != null && renderer.SupportsRenderPitch) {
            job.Progress = "Predicting pitch...";
            ApplyAutoPitch(job, project, voiceParts, renderer);
        }

        // 提取短语列表
        var allPhrases = CollectAllPhrases(voiceParts);

        job.Phrases = allPhrases.Select((p, i) => new PhraseJob {
            Index = i,
            StartMs = p.positionMs - p.leadingMs,
            DurationMs = p.durationMs + p.leadingMs,
        }).ToList();

        // 提取音高曲线数据（从 phrase.pitches，每 5 tick 一个点）
        ExtractPitchCurve(job, voiceParts);

        // 保留渲染上下文供后续音高编辑使用
        job.Project = project;
        job.VoiceParts = voiceParts;
        job.AllPhrases = allPhrases;
        job.Renderer = renderer;

        Log.Information("Job {JobId}: preparation done, {Count} phrases extracted.", job.JobId, allPhrases.Count);

        return (allPhrases, renderer!);
    }

    private static void EnterInteractivePreparationPhase(SynthesisJob job, string progress) {
        job.Status = "preparing";
        job.Progress = progress;
    }

    private static void RestoreInteractivePhaseState(SynthesisJob job, string previousStatus, string? previousProgress) {
        job.Status = previousStatus;
        job.Progress = previousProgress;
    }

    private static void TransitionToBackgroundRenderPhase(SynthesisJob job, int affectedCount, int totalPhrases) {
        job.Status = "rendering";
        job.Progress = affectedCount > 0
            ? $"Rendering affected phrases (0/{affectedCount})..."
            : (totalPhrases > 0 ? $"Rendering phrase 0/{totalPhrases}..." : "Rendering...");
    }

    private static bool PauseRenderLoopAndAwaitQuietPhrase(SynthesisJob job, string waitProgress, int timeoutMs = 15000) {
        job.RenderGate.Reset();
        var currentPhraseCts = job.CurrentPhraseCts;
        if (currentPhraseCts == null) {
            return true;
        }

        job.Progress = waitProgress;
        var stopwatch = Stopwatch.StartNew();
        currentPhraseCts.Cancel();
        bool quiet = job.CurrentPhraseQuietGate.Wait(TimeSpan.FromMilliseconds(timeoutMs));
        stopwatch.Stop();

        if (quiet) {
            Log.Information("Job {JobId}: active phrase render yielded in {ElapsedMs}ms.", job.JobId, stopwatch.ElapsedMilliseconds);
        } else {
            Log.Warning("Job {JobId}: active phrase render did not yield within {TimeoutMs}ms; continuing with edit preparation.", job.JobId, timeoutMs);
        }
        return quiet;
    }

    private string GetPhraseOutputPath(string jobId, int phraseIndex) {
        return Path.Combine(_outputDir, $"{jobId}_p{phraseIndex}.wav");
    }

    private static HashSet<string> CollectReferencedPhraseOutputPaths(SynthesisJob job) {
        var keepPaths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        if (job.Phrases == null) {
            return keepPaths;
        }
        foreach (var phrase in job.Phrases) {
            if (string.IsNullOrWhiteSpace(phrase.OutputPath)) {
                continue;
            }
            keepPaths.Add(Path.GetFullPath(phrase.OutputPath));
        }
        return keepPaths;
    }

    private void CleanupJobOutputArtifacts(string jobId, IEnumerable<string>? keepPaths = null, bool includeMergedOutput = false) {
        if (!Directory.Exists(_outputDir)) {
            return;
        }

        var keepSet = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        if (keepPaths != null) {
            foreach (var keepPath in keepPaths) {
                if (string.IsNullOrWhiteSpace(keepPath)) {
                    continue;
                }
                keepSet.Add(Path.GetFullPath(keepPath));
            }
        }

        foreach (var phrasePath in Directory.EnumerateFiles(_outputDir, $"{jobId}_p*.wav")) {
            var fullPath = Path.GetFullPath(phrasePath);
            if (keepSet.Contains(fullPath)) {
                continue;
            }
            TryDeleteFile(fullPath, "phrase output cleanup", jobId);
        }

        if (includeMergedOutput) {
            var mergedPath = Path.GetFullPath(Path.Combine(_outputDir, $"{jobId}.wav"));
            if (!keepSet.Contains(mergedPath)) {
                TryDeleteFile(mergedPath, "merged output cleanup", jobId);
            }
        }
    }

    private static void TryDeleteFile(string? path, string reason, string jobId) {
        if (string.IsNullOrWhiteSpace(path) || !File.Exists(path)) {
            return;
        }
        try {
            File.Delete(path);
        } catch (Exception ex) {
            Log.Warning(ex, "Job {JobId}: failed during {Reason} for {Path}", jobId, reason, path);
        }
    }

    /// <summary>
    /// 阶段 2: 逐短语渲染，支持优先级调度
    /// 渲染顺序：优先渲染 PriorityPhraseIndex 开始的连续短语，然后回头补未渲染的
    /// edit-notes 会通过清除 RenderedSet 中的 index 来让本循环重新渲染受影响的短语
    /// </summary>
    private void RenderPhrases(SynthesisJob job, List<RenderPhrase> allPhrases, IRenderer renderer, CancellationToken jobToken = default) {
        while (true) {
            if (_cts.IsCancellationRequested || jobToken.IsCancellationRequested) break;

            // edit 进来时会关门暂停，处理完再开门
            job.RenderGate.Wait();

            int nextIndex;
            int total;
            List<RenderPhrase> currentPhrases;
            lock (job.RenderLock) {
                currentPhrases = job.AllPhrases ?? allPhrases;
                total = currentPhrases.Count;
                if (job.RenderedSet.Count >= total) break;
                nextIndex = PickNextPhrase(job, total, job.RenderedSet);
            }
            if (nextIndex < 0) break;

            lock (job.RenderLock) {
                job.RenderedSet.Add(nextIndex);
                if (nextIndex < job.Phrases!.Count)
                    job.Phrases[nextIndex].Status = "rendering";
                job.Progress = $"Rendering phrase {job.RenderedSet.Count}/{total}...";
            }

            // 为这个 phrase 创建独立的 CTS，edit 可以 Cancel 它来中断
            var phraseCts = new CancellationTokenSource();
            job.CurrentPhraseQuietGate.Reset();
            job.CurrentPhraseCts = phraseCts;

            try {
                var phrase = currentPhrases[nextIndex];
                var progress = new Progress(total);
                RenderResult result;
                try {
                    var task = renderer.Render(phrase, progress, 0, phraseCts, true);
                    result = task.GetAwaiter().GetResult();
                } finally {
                    job.CurrentPhraseQuietGate.Set();
                    if (job.CurrentPhraseCts == phraseCts) {
                        job.CurrentPhraseCts = null;
                    }
                }

                if (phraseCts.IsCancellationRequested) {
                    throw new OperationCanceledException("Phrase render cancelled by edit.", phraseCts.Token);
                }
                if (result?.samples == null) {
                    throw new InvalidOperationException("Renderer returned no samples.");
                }

                var phrasePath = Path.Combine(_outputDir, $"{job.JobId}_p{nextIndex}.wav");
                WriteSamplesToWav(phrasePath, result.samples, 44100);

                lock (job.RenderLock) {
                    if (!job.RenderedSet.Contains(nextIndex)) {
                        Log.Information("Job {JobId}: phrase {Index} was invalidated during render, discarding.", job.JobId, nextIndex);
                        continue;
                    }
                    if (nextIndex < job.Phrases!.Count) {
                        job.Phrases[nextIndex].OutputPath = phrasePath;
                        job.Phrases[nextIndex].Status = "completed";
                    }
                }

                Log.Information("Job {JobId}: phrase {Index}/{Total} completed.",
                    job.JobId, nextIndex, total);
            } catch (Exception ex) when (phraseCts.IsCancellationRequested) {
                // 被 edit 中断——把这个 phrase 从 RenderedSet 移除，让下一轮循环重新选择
                lock (job.RenderLock) {
                    job.RenderedSet.Remove(nextIndex);
                    if (nextIndex < job.Phrases!.Count)
                        job.Phrases[nextIndex].Status = "pending";
                }
                Log.Information("Job {JobId}: phrase {Index} interrupted by edit, will re-pick with priority.", job.JobId, nextIndex);
                // 不 break，继续循环——下一轮 PickNextPhrase 会按新优先级选择
            } catch (Exception ex) {
                Log.Warning("Job {JobId}: phrase {Index} failed: {Error}",
                    job.JobId, nextIndex, ex.Message);
                lock (job.RenderLock) {
                    if (nextIndex < job.Phrases!.Count) {
                        job.Phrases[nextIndex].Status = "failed";
                        job.Phrases[nextIndex].Error = ex.Message;
                    }
                }
            } finally {
                job.CurrentPhraseQuietGate.Set();
                if (job.CurrentPhraseCts == phraseCts) {
                    job.CurrentPhraseCts = null;
                }
            }
        }
    }

    /// <summary>
    /// 选择下一个要渲染的短语 index
    /// 逻辑：如果有优先级请求，从该 index 开始往后找第一个未渲染的；
    ///       否则从头开始找第一个未渲染的
    /// </summary>
    private static int PickNextPhrase(SynthesisJob job, int total, HashSet<int> rendered) {
        int priority = job.PriorityPhraseIndex;

        // 如果有优先级请求，从 priority 开始往后找
        if (priority >= 0 && priority < total) {
            for (int i = priority; i < total; i++) {
                if (!rendered.Contains(i)) return i;
            }
        }

        // 从头开始找第一个未渲染的
        for (int i = 0; i < total; i++) {
            if (!rendered.Contains(i)) return i;
        }

        return -1; // 全部已渲染
    }

    /// <summary>
    /// 将 float[] 采样数据写为 16-bit mono WAV 文件
    /// </summary>
    private static void WriteSamplesToWav(string path, float[] samples, int sampleRate) {
        var format = new WaveFormat(sampleRate, 16, 1); // 16-bit mono
        using var writer = new WaveFileWriter(path, format);
        // 将 float 转为 16-bit PCM
        foreach (var sample in samples) {
            var clamped = Math.Clamp(sample, -1f, 1f);
            writer.WriteSample(clamped);
        }
    }

    /// <summary>
    /// 将所有已完成的短语按时间位置混合为完整 WAV
    /// </summary>
    private void MergePhrasesToWav(SynthesisJob job, string outputPath, int sampleRate) {
        if (job.Phrases == null || job.Phrases.Count == 0) return;

        // 计算总长度
        double maxEndMs = 0;
        foreach (var p in job.Phrases) {
            var end = p.StartMs + p.DurationMs;
            if (end > maxEndMs) maxEndMs = end;
        }
        // 额外加 1 秒余量
        int totalSamples = (int)((maxEndMs / 1000.0 + 1.0) * sampleRate);
        var mixBuffer = new float[totalSamples];

        // 逐短语读取并混合
        foreach (var phraseJob in job.Phrases) {
            if (phraseJob.Status != "completed" || phraseJob.OutputPath == null) continue;
            if (!File.Exists(phraseJob.OutputPath)) continue;

            using var reader = new WaveFileReader(phraseJob.OutputPath);
            var provider = reader.ToSampleProvider();
            int offsetSample = (int)(phraseJob.StartMs / 1000.0 * sampleRate);
            var buffer = new float[1024];
            int pos = Math.Max(0, offsetSample);
            int read;
            while ((read = provider.Read(buffer, 0, buffer.Length)) > 0) {
                for (int i = 0; i < read && pos + i < totalSamples; i++) {
                    mixBuffer[pos + i] += buffer[i];
                }
                pos += read;
            }
        }

        WriteSamplesToWav(outputPath, mixBuffer, sampleRate);
    }

    /// <summary>
    /// 从各 phrase 的 pitchesBeforeDeviation 数组中提取音高曲线（不含 PITD），
    /// 转为前端可用的 {tick, pitch} 格式。
    /// 使用 pitchesBeforeDeviation 而非 pitches，是因为前端需要纯净的基础音高
    /// 来正确计算画笔偏差（PITD），避免二次画笔时出现双重计算。
    /// </summary>
    private static void ExtractPitchCurve(SynthesisJob job, List<UVoicePart> voiceParts) {
        var points = new List<Models.PitchPoint>();
        foreach (var part in voiceParts) {
            foreach (var phrase in part.renderPhrases) {
                // 优先使用 pitchesBeforeDeviation（不含 PITD），回退到 pitches
                var src = phrase.pitchesBeforeDeviation ?? phrase.pitches;
                if (src == null || src.Length == 0) continue;
                int startTick = phrase.position - phrase.leading;
                for (int i = 0; i < src.Length; i++) {
                    float pitchCents = src[i];
                    if (pitchCents <= 0) continue;
                    int tick = startTick + i * 5;
                    float midiPitch = pitchCents / 100f;
                    points.Add(new Models.PitchPoint { Tick = tick, Pitch = midiPitch });
                }
            }
        }
        points.Sort((a, b) => a.Tick.CompareTo(b.Tick));
        job.PitchCurve = points;
        Log.Information("Job {JobId}: extracted {Count} pitch points (before deviation).", job.JobId, points.Count);
    }

    private void ApplyAutoPitch(SynthesisJob job, UProject project, List<UVoicePart> voiceParts, IRenderer renderer) {
        var allPhrases = voiceParts.SelectMany(p => p.renderPhrases).ToList();
        float minPitD = -1200;
        if (project.expressions.TryGetValue(Ustx.PITD, out var pitdDescriptor))
            minPitD = pitdDescriptor.min;

        for (int ph_i = 0; ph_i < allPhrases.Count; ph_i++) {
            job.Progress = $"Predicting pitch ({ph_i + 1}/{allPhrases.Count})...";
            var phrase = allPhrases[ph_i];
            try {
                var pitchResult = renderer.LoadRenderedPitch(phrase);
                if (pitchResult == null) continue;

                var part = voiceParts.First(p => p.renderPhrases.Contains(phrase));
                var pitchCurve = part.curves.FirstOrDefault(c => c.abbr == Ustx.PITD);
                if (pitchCurve == null && pitdDescriptor != null) {
                    pitchCurve = new UCurve(pitdDescriptor);
                    part.curves.Add(pitchCurve);
                }
                if (pitchCurve == null) continue;

                int? lastX = null, lastY = null;
                for (int i = 0; i < pitchResult.tones.Length; i++) {
                    if (pitchResult.tones[i] < 0) continue;
                    int x = phrase.position - part.position + (int)pitchResult.ticks[i];
                    if (pitchResult.ticks[i] < 0) {
                        if (i + 1 < pitchResult.ticks.Length && pitchResult.ticks[i + 1] > 0) { }
                        else continue;
                    }
                    if (x >= phrase.position + phrase.duration)
                        i = pitchResult.tones.Length - 1;
                    int pitchIndex = Math.Clamp(
                        (x - (phrase.position - part.position - phrase.leading)) / 5,
                        0, phrase.pitches.Length - 1);
                    float basePitch = phrase.pitchesBeforeDeviation[pitchIndex];
                    int y = (int)(pitchResult.tones[i] * 100 - basePitch);
                    lastX ??= x;
                    lastY ??= y;
                    if (y > minPitD)
                        pitchCurve.Set(x, y, lastX.Value, lastY.Value);
                    lastX = x;
                    lastY = y;
                }
            } catch (Exception ex) {
                Log.Warning("Phrase {Index} pitch prediction failed: {Error}", ph_i + 1, ex.Message);
            }
        }

        foreach (var part in voiceParts) {
            var pitchCurve = part.curves.FirstOrDefault(c => c.abbr == Ustx.PITD);
            pitchCurve?.Simplify();
        }

        project.Validate(new ValidateOptions { SkipPhonemizer = true });
    }

    private static List<KeyValuePair<int, int>> ToSortedPitchPoints(IEnumerable<KeyValuePair<int, int>> points) {
        return points
            .Where(kv => kv.Key >= 0)
            .GroupBy(kv => kv.Key)
            .Select(group => new KeyValuePair<int, int>(group.Key, group.Last().Value))
            .OrderBy(kv => kv.Key)
            .ToList();
    }

    private static bool PitchPointsEqual(IReadOnlyList<KeyValuePair<int, int>> left, IReadOnlyList<KeyValuePair<int, int>> right) {
        if (left.Count != right.Count) {
            return false;
        }
        for (int i = 0; i < left.Count; i++) {
            if (!left[i].Equals(right[i])) {
                return false;
            }
        }
        return true;
    }

    private static void AddTickCandidate(List<int> candidates, IReadOnlyList<KeyValuePair<int, int>> points, int index) {
        if (index >= 0 && index < points.Count) {
            candidates.Add(points[index].Key);
        }
    }

    private static (int StartTick, int EndTick)? ComputeChangedPitchRange(
        IReadOnlyList<KeyValuePair<int, int>> oldPoints,
        IReadOnlyList<KeyValuePair<int, int>> newPoints) {
        if (PitchPointsEqual(oldPoints, newPoints)) {
            return null;
        }

        int prefix = 0;
        int common = Math.Min(oldPoints.Count, newPoints.Count);
        while (prefix < common && oldPoints[prefix].Equals(newPoints[prefix])) {
            prefix++;
        }

        int oldSuffix = oldPoints.Count - 1;
        int newSuffix = newPoints.Count - 1;
        while (oldSuffix >= prefix && newSuffix >= prefix && oldPoints[oldSuffix].Equals(newPoints[newSuffix])) {
            oldSuffix--;
            newSuffix--;
        }

        var candidates = new List<int>();
        AddTickCandidate(candidates, oldPoints, prefix - 1);
        AddTickCandidate(candidates, oldPoints, prefix);
        AddTickCandidate(candidates, oldPoints, oldSuffix);
        AddTickCandidate(candidates, oldPoints, oldSuffix + 1);
        AddTickCandidate(candidates, newPoints, prefix - 1);
        AddTickCandidate(candidates, newPoints, prefix);
        AddTickCandidate(candidates, newPoints, newSuffix);
        AddTickCandidate(candidates, newPoints, newSuffix + 1);

        if (candidates.Count == 0) {
            return null;
        }

        return (candidates.Min(), candidates.Max());
    }

    private static void ReplacePitchDeviationCurve(
        UVoicePart part,
        UCurve pitchCurve,
        UExpressionDescriptor descriptor,
        IReadOnlyList<KeyValuePair<int, int>> points) {
        var localPoints = new SortedDictionary<int, int>();
        int minCent = (int)Math.Round(descriptor.min);
        int maxCent = (int)Math.Round(descriptor.max);

        foreach (var point in points) {
            if (point.Key < part.position || point.Key > part.End) {
                continue;
            }

            int localTick = (int)Math.Round((point.Key - part.position) / (double)UCurve.interval) * UCurve.interval;
            localTick = Math.Max(0, localTick);
            localPoints[localTick] = Math.Clamp(point.Value, minCent, maxCent);
        }

        pitchCurve.descriptor = descriptor;
        pitchCurve.abbr = descriptor.abbr;
        pitchCurve.xs = localPoints.Keys.ToList();
        pitchCurve.ys = localPoints.Values.ToList();
    }

    /// <summary>
    /// 接收前端的 PITD 偏移数据，写入 UCurve，重新 Validate 并重渲染受影响的短语
    /// </summary>
    public void ApplyPitchDeviationAndRerender(SynthesisJob job, Dictionary<int, int> deviation, out List<int> affectedOut) {
        affectedOut = new List<int>();
        if (job.Project == null || job.VoiceParts == null || job.AllPhrases == null || job.Renderer == null) {
            Log.Warning("Job {JobId}: no render context for pitch re-render.", job.JobId);
            return;
        }

        string previousStatus = job.Status;
        string? previousProgress = job.Progress;
        bool phaseStateResolved = false;
        EnterInteractivePreparationPhase(job, "Waiting for current render to yield...");
        PauseRenderLoopAndAwaitQuietPhrase(job, "Waiting for current render to yield...");

        try {
            var project = job.Project;
            var voiceParts = job.VoiceParts;
            var currentDeviation = GetPitchDeviation(job);
            var oldPoints = ToSortedPitchPoints(currentDeviation.xs.Zip(currentDeviation.ys, (x, y) => new KeyValuePair<int, int>(x, y)));
            var newPoints = ToSortedPitchPoints(deviation);
            var changedRange = ComputeChangedPitchRange(oldPoints, newPoints);

            if (changedRange == null) {
                Log.Information("Job {JobId}: pitch edit is a no-op, skipped.", job.JobId);
                return;
            }

            if (!project.expressions.TryGetValue(Ustx.PITD, out var pitdDescriptor)) {
                Log.Warning("Job {JobId}: PITD descriptor missing, cannot apply pitch edit.", job.JobId);
                return;
            }

            foreach (var part in voiceParts) {
                var pitchCurve = part.curves.FirstOrDefault(c => c.abbr == Ustx.PITD);
                if (pitchCurve == null) {
                    pitchCurve = new UCurve(pitdDescriptor);
                    part.curves.Add(pitchCurve);
                }
                ReplacePitchDeviationCurve(part, pitchCurve, pitdDescriptor, newPoints);
            }

            // 重新 Validate 让 pitches 数组更新
            job.Progress = "Refreshing pitch curves...";
            project.Validate(new ValidateOptions { SkipPhonemizer = true });

            // 重新获取 allPhrases（Validate 后可能重建）
            var allPhrases = voiceParts
                .SelectMany(p => p.renderPhrases)
                .OrderBy(p => p.positionMs)
                .ToList();
            job.AllPhrases = allPhrases;

            // 更新 pitch curve 数据
            ExtractPitchCurve(job, voiceParts);

            var affectedIndices = new List<int>();
            for (int i = 0; i < allPhrases.Count; i++) {
                var phrase = allPhrases[i];
                int phraseStart = phrase.position - phrase.leading;
                int phraseEnd = phrase.position + phrase.duration;
                if (phraseEnd >= changedRange.Value.StartTick && phraseStart <= changedRange.Value.EndTick) {
                    affectedIndices.Add(i);
                }
            }

            if (affectedIndices.Count == 0) {
                RestoreInteractivePhaseState(job, previousStatus, previousProgress);
                phaseStateResolved = true;
                return;
            }
            affectedOut = affectedIndices;

            // 通过操作 RenderedSet 让 RenderPhrases 循环重新渲染受影响的 phrase
            lock (job.RenderLock) {
                foreach (int idx in affectedIndices) {
                    job.RenderedSet.Remove(idx);
                    if (idx < job.Phrases!.Count) {
                        job.Phrases[idx].Status = "pending";
                    }
                }
                job.PriorityPhraseIndex = affectedIndices.Min();
            }

            bool shouldStartDetachedRender = previousStatus == "completed" || previousStatus == "ready";
            TransitionToBackgroundRenderPhase(job, affectedIndices.Count, allPhrases.Count);
            phaseStateResolved = true;

            // 如果初次渲染已结束，启动新的渲染循环
            if (shouldStartDetachedRender) {
                var currentPhrases = allPhrases;
                var currentRenderer = job.Renderer;
                Task.Run(() => {
                    try {
                        RenderPhrases(job, currentPhrases, currentRenderer!);
                        lock (job.RenderLock) {
                            if (job.RenderedSet.Count >= (job.AllPhrases?.Count ?? 0)) {
                                try {
                                    var fullOutputPath = Path.Combine(_outputDir, $"{job.JobId}.wav");
                                    MergePhrasesToWav(job, fullOutputPath, 44100);
                                    job.OutputPath = fullOutputPath;
                                } catch (Exception ex) {
                                    Log.Warning("Job {JobId}: full WAV merge after pitch edit failed: {Error}", job.JobId, ex.Message);
                                }
                                job.Status = "completed";
                                job.Progress = null;
                            }
                        }
                    } catch (Exception ex) {
                        Log.Error(ex, "Job {JobId}: re-render after pitch edit failed.", job.JobId);
                    }
                });
            }

        } finally {
            if (!phaseStateResolved) {
                RestoreInteractivePhaseState(job, previousStatus, previousProgress);
            }
            job.RenderGate.Set();
        }
    }

    /// <summary>
    /// 增量编辑音符：直接操作内存中的 UProject，重新音素化，
    /// 只对受影响的短语重新音高预测+渲染。PITD 曲线保留不动。
    /// </summary>
    public void ApplyNoteEdits(SynthesisJob job, List<NoteEdit> edits, out List<int> affectedOut) {
        affectedOut = new List<int>();
        try {
            ApplyNoteEditsInner(job, edits, out affectedOut);
        } catch (Exception ex) {
            Log.Error(ex, "[edit-notes] FULL EXCEPTION in ApplyNoteEdits");
            throw;  // 让 Controller 的 catch 也能拿到
        }
    }

    private void ApplyNoteEditsInner(SynthesisJob job, List<NoteEdit> edits, out List<int> affectedOut) {
        affectedOut = new List<int>();
        if (job.Project == null || job.VoiceParts == null || job.Renderer == null) {
            Log.Warning("Job {JobId}: no render context for note edit.", job.JobId);
            return;
        }

        string previousStatus = job.Status;
        string? previousProgress = job.Progress;
        bool phaseStateResolved = false;
        EnterInteractivePreparationPhase(job, "Waiting for current render to yield...");
        PauseRenderLoopAndAwaitQuietPhrase(job, "Waiting for current render to yield...");
        Log.Information("[edit-notes] paused render loop and interrupted current phrase.");

        try {  // finally 里开门，确保异常时也恢复

        var project = job.Project;
        var voiceParts = job.VoiceParts;
        var lyricOnlyEdit = IsLyricOnlyEdit(edits);
        var originalPhraseCount = job.AllPhrases?.Count ?? 0;
        var originalLyricsByNote = new Dictionary<UNote, string>();


        // 对每个 part 应用编辑
        foreach (var part in voiceParts) {
            Log.Information("[edit-notes] part.position={PartPos}, notes count={Count}", part.position, part.notes.Count);
            // 列出 part 中所有音符用于调试匹配
            foreach (var n in part.notes.Take(30)) {
                Log.Information("[edit-notes]   existing note: pos={Pos} dur={Dur} tone={Tone} lyric={Lyric}",
                    n.position, n.duration, n.tone, n.lyric);
            }

            foreach (var edit in edits) {
                // 前端已将 tick 从 state.ppq 转为 480 PPQ，这里直接使用
                int pos480 = edit.Position;
                int dur480 = edit.Duration;
                int relativePos = pos480 - part.position;

                Log.Information("[edit-notes] action={Action} pos480={Pos480} relativePos={RelPos} dur480={Dur480} tone={Tone}",
                    edit.Action, pos480, relativePos, dur480, edit.Tone);

                switch (edit.Action) {
                    case "add": {
                        var note = UNote.Create();
                        note.position = relativePos;
                        note.duration = dur480;
                        note.tone = edit.Tone;
                        note.lyric = edit.Lyric ?? "a";
                        lock (part) { part.notes.Add(note); }
                        Log.Information("[edit-notes] ADD: created note at relPos={Pos} dur={Dur} tone={Tone}", relativePos, dur480, edit.Tone);
                        break;
                    }
                    case "remove": {
                        lock (part) {
                            var match = part.notes.FirstOrDefault(n =>
                                n.position == relativePos
                                && n.tone == edit.Tone);
                            Log.Information("[edit-notes] REMOVE: match={Found} (looking for relPos={Pos} tone={Tone})",
                                match != null ? "YES" : "NO", relativePos, edit.Tone);
                            if (match != null) part.notes.Remove(match);
                        }
                        break;
                    }
                    case "move": {
                        int newPos480 = edit.NewPosition ?? edit.Position;
                        int newTone = edit.NewTone ?? edit.Tone;
                        lock (part) {
                            var match = part.notes.FirstOrDefault(n =>
                                n.position == relativePos
                                && n.tone == edit.Tone);
                            Log.Information("[edit-notes] MOVE: match={Found} (looking for relPos={Pos} tone={Tone}) -> newRelPos={NewPos} newTone={NewTone}",
                                match != null ? "YES" : "NO", relativePos, edit.Tone,
                                newPos480 - part.position, newTone);
                            if (match != null) {
                                part.notes.Remove(match);
                                match.position = newPos480 - part.position;
                                match.tone = newTone;
                                part.notes.Add(match);
                            }
                        }
                        break;
                    }
                    case "resize": {
                        lock (part) {
                            var match = part.notes.FirstOrDefault(n =>
                                n.position == pos480 - part.position
                                && n.tone == edit.Tone);
                            if (match != null) {
                                match.duration = dur480;
                            }
                        }
                        break;
                    }
                    case "lyric": {
                        lock (part) {
                            var match = part.notes.FirstOrDefault(n =>
                                n.position == pos480 - part.position
                                && n.tone == edit.Tone);
                            if (match != null) {
                                if (lyricOnlyEdit && !originalLyricsByNote.ContainsKey(match)) {
                                    originalLyricsByNote[match] = match.lyric;
                                }
                                match.lyric = edit.Lyric ?? "a";
                            }
                        }
                        break;
                    }
                }
            }
        }

        // 重新音素化 + 重建 renderPhrases
        Log.Information("Job {JobId}: ValidateFull after note edits...", job.JobId);
        job.Progress = "Phonemizing...";
        project.ValidateFull();

        // 等待音素化完成
        WaitForPhonemization(voiceParts, 60, 500, "edit-notes");
        project.Validate(new ValidateOptions { SkipPhonemizer = true });

        // 重建 allPhrases 和 Phrases 列表
        var allPhrases = CollectAllPhrases(voiceParts);

        Log.Information("[edit-notes] after ValidateFull: old phrases={Old}, new phrases={New}",
            originalPhraseCount, allPhrases.Count);
        // 列出新的 notes 状态
        foreach (var part in voiceParts) {
            Log.Information("[edit-notes] part notes after edit:");
            foreach (var n in part.notes.Take(30)) {
                Log.Information("[edit-notes]   note: pos={Pos} dur={Dur} tone={Tone} lyric={Lyric}",
                    n.position, n.duration, n.tone, n.lyric);
            }
        }

        if (lyricOnlyEdit) {
            EnsureLyricEditPreservesStructure(job, edits, voiceParts, allPhrases, originalPhraseCount, originalLyricsByNote);
        }

        job.AllPhrases = allPhrases;
        lock (job.RenderLock) {
            job.Phrases = allPhrases.Select((p, i) => new PhraseJob {
                Index = i,
                StartMs = p.positionMs - p.leadingMs,
                DurationMs = p.durationMs + p.leadingMs,
                Status = "pending",
            }).ToList();
        }

        // 所有 phrase 都需要重新预测和渲染，不复用旧结果以保证随机性
        var editAffectedIndices = new HashSet<int>(Enumerable.Range(0, allPhrases.Count));
        var renderAffectedIndices = new HashSet<int>(editAffectedIndices);
        lock (job.RenderLock) {
            job.RenderedSet.Clear();

            for (int i = 0; i < allPhrases.Count; i++) {
                var phraseJob = job.Phrases[i];
                phraseJob.OutputPath = null;
                phraseJob.Error = null;
                phraseJob.Status = "pending";
            }

            job.PriorityPhraseIndex = renderAffectedIndices.Count > 0
                ? renderAffectedIndices.Min()
                : -1;
        }
        CleanupJobOutputArtifacts(job.JobId, CollectReferencedPhraseOutputPaths(job));

        var affectedIndices = renderAffectedIndices.OrderBy(index => index).ToList();
        var pitchPredictionIndices = editAffectedIndices.OrderBy(index => index).ToList();

        Log.Information("[edit-notes] {RenderCount} phrases queued for audio rerender: [{RenderIndices}]; {PitchCount} phrases need fresh pitch prediction: [{PitchIndices}]",
            affectedIndices.Count,
            string.Join(", ", affectedIndices),
            pitchPredictionIndices.Count,
            string.Join(", ", pitchPredictionIndices));

        // 对受影响的 phrase 重新音高预测
        var renderer = job.Renderer;
        if (renderer.SupportsRenderPitch && pitchPredictionIndices.Count > 0) {
            float minPitD = -1200;
            if (project.expressions.TryGetValue(Ustx.PITD, out var pitdDescriptor))
                minPitD = pitdDescriptor.min;

            for (int affectedIndex = 0; affectedIndex < pitchPredictionIndices.Count; affectedIndex++) {
                int idx = pitchPredictionIndices[affectedIndex];
                try {
                    if (idx >= allPhrases.Count) continue;
                    var phrase = allPhrases[idx];
                    job.Progress = $"Predicting pitch ({affectedIndex + 1}/{pitchPredictionIndices.Count})...";

                    // 跳过 pitches 数组为空的短语（新分割出的短语可能尚未填充）
                    if (phrase.pitches == null || phrase.pitches.Length == 0 ||
                        phrase.pitchesBeforeDeviation == null || phrase.pitchesBeforeDeviation.Length == 0) {
                        Log.Information("Job {JobId}: phrase {Idx} has empty pitches array, skipping pitch prediction.", job.JobId, idx);
                        continue;
                    }

                    var pitchResult = renderer.LoadRenderedPitch(phrase);
                    if (pitchResult == null) continue;

                    var thePart = voiceParts.FirstOrDefault(p => p.renderPhrases.Contains(phrase));
                    if (thePart == null) {
                        Log.Warning("Job {JobId}: phrase {Idx} not found in any voice part, skipping.", job.JobId, idx);
                        continue;
                    }

                    var pitchCurve = thePart.curves.FirstOrDefault(c => c.abbr == Ustx.PITD);
                    if (pitchCurve == null && pitdDescriptor != null) {
                        pitchCurve = new UCurve(pitdDescriptor);
                        thePart.curves.Add(pitchCurve);
                    }
                    if (pitchCurve == null) continue;

                    // 清除这个 phrase 范围内的旧自动音高（但保留用户手画的 PITD）
                    // 注意：这里不清除，而是用新预测覆盖
                    int? lastX = null, lastY = null;
                    for (int i = 0; i < pitchResult.tones.Length; i++) {
                        if (pitchResult.tones[i] < 0) continue;
                        int x = phrase.position - thePart.position + (int)pitchResult.ticks[i];
                        if (pitchResult.ticks[i] < 0) {
                            if (i + 1 < pitchResult.ticks.Length && pitchResult.ticks[i + 1] > 0) { }
                            else continue;
                        }
                        if (x >= phrase.position + phrase.duration) break;
                        int pitchIndex = Math.Clamp(
                            (x - (phrase.position - thePart.position - phrase.leading)) / 5,
                            0, phrase.pitches.Length - 1);
                        if (pitchIndex < 0 || pitchIndex >= phrase.pitchesBeforeDeviation.Length) continue;
                        float basePitch = phrase.pitchesBeforeDeviation[pitchIndex];
                        int y = (int)(pitchResult.tones[i] * 100 - basePitch);
                        lastX ??= x;
                        lastY ??= y;
                        if (y > minPitD)
                            pitchCurve.Set(x, y, lastX.Value, lastY.Value);
                        lastX = x;
                        lastY = y;
                    }
                } catch (Exception ex) {
                    Log.Warning("Job {JobId}: pitch prediction for phrase {Idx} failed: {Error}",
                        job.JobId, idx, ex.Message);
                }
            }

            foreach (var part in voiceParts) {
                var pc = part.curves.FirstOrDefault(c => c.abbr == Ustx.PITD);
                pc?.Simplify();
            }
            project.Validate(new ValidateOptions { SkipPhonemizer = true });

            // 刷新 allPhrases（Validate 后可能重建 RenderPhrase 对象）
            allPhrases = CollectAllPhrases(voiceParts);
            job.AllPhrases = allPhrases;
        }

        // 更新 pitch curve
        ExtractPitchCurve(job, voiceParts);
        // 只返回真正因编辑而受影响的 indices 给前端（不包含孤儿 phrase）
        affectedOut = pitchPredictionIndices;
        bool shouldStartDetachedRender = previousStatus == "completed" || previousStatus == "ready";
        TransitionToBackgroundRenderPhase(job, affectedIndices.Count, allPhrases.Count);
        phaseStateResolved = true;

        // 不再自己 Task.Run 渲染——通过上面的 RenderedSet.Remove，
        // 正在运行的 RenderPhrases 循环会自动拾起这些 phrase 并按优先级渲染。
        // 如果初次渲染已完成（job.Status == "completed"），需要将 job 状态
        // 改回 "rendering" 让 RenderPhrases 重新进入循环。
        if (shouldStartDetachedRender) {
            // 初次渲染已结束，RenderPhrases 循环已退出。
            // 需要启动一个新的渲染循环来处理受影响的 phrase。
            var currentPhrases = allPhrases;
            var currentRenderer = job.Renderer;
            Task.Run(() => {
                try {
                    RenderPhrases(job, currentPhrases, currentRenderer!);
                    // 渲染完毕后检查是否所有 phrase 都完成了
                    lock (job.RenderLock) {
                        if (job.RenderedSet.Count >= (job.AllPhrases?.Count ?? 0)) {
                            // 重新合并完整 WAV
                            try {
                                var fullOutputPath = Path.Combine(_outputDir, $"{job.JobId}.wav");
                                MergePhrasesToWav(job, fullOutputPath, 44100);
                                job.OutputPath = fullOutputPath;
                            } catch (Exception ex) {
                                Log.Warning("Job {JobId}: full WAV merge after edit failed: {Error}", job.JobId, ex.Message);
                            }
                            job.Status = "completed";
                            job.Progress = null;
                        }
                    }
                } catch (Exception ex) {
                    Log.Error(ex, "Job {JobId}: re-render after edit failed.", job.JobId);
                }
            });
        }

        Log.Information("Job {JobId}: note edit applied, {Affected}/{Total} phrases will be re-rendered by RenderPhrases loop.",
            job.JobId, affectedIndices.Count, allPhrases.Count);

        } finally {
            if (!phaseStateResolved) {
                RestoreInteractivePhaseState(job, previousStatus, previousProgress);
            }
            // === 开门：恢复渲染循环 ===
            job.RenderGate.Set();
            Log.Information("[edit-notes] render loop resumed.");
        }
    }

    private static List<RenderPhrase> CollectAllPhrases(List<UVoicePart> voiceParts) {
        return voiceParts
            .SelectMany(part => part.renderPhrases)
            .OrderBy(phrase => phrase.positionMs)
            .ToList();
    }

    private static int CountRenderedNotes(IEnumerable<RenderPhrase>? phrases) {
        return phrases?.Sum(phrase => phrase.notes.Length) ?? 0;
    }

    private static bool IsLyricOnlyEdit(List<NoteEdit> edits) {
        return edits.Count > 0 && edits.All(edit => edit.Action == "lyric");
    }

    private static HashSet<string> BuildEditNoteKeys(IEnumerable<NoteEdit> edits) {
        return edits
            .Select(edit => $"{edit.Position}:{edit.Duration}:{edit.Tone}")
            .ToHashSet(StringComparer.Ordinal);
    }

    private static HashSet<string> BuildPhraseNoteKeys(IEnumerable<RenderPhrase> phrases) {
        return phrases
            .SelectMany(phrase => phrase.notes.Select(note => $"{phrase.position + note.position}:{note.duration}:{note.tone}"))
            .ToHashSet(StringComparer.Ordinal);
    }

    private static void RestoreLyrics(Dictionary<UNote, string> originalLyricsByNote) {
        foreach (var entry in originalLyricsByNote) {
            entry.Key.lyric = entry.Value;
        }
    }

    private static void WaitForPhonemization(List<UVoicePart> voiceParts, int maxWaits, int delayMs, string context) {
        for (int wait = 0; wait < maxWaits; wait++) {
            if (voiceParts.All(part => part.PhonemesUpToDate)) {
                return;
            }
            Thread.Sleep(delayMs);
        }
        throw new TimeoutException($"Phonemization timed out during {context}.");
    }

    private void EnsureLyricEditPreservesStructure(
        SynthesisJob job,
        List<NoteEdit> edits,
        List<UVoicePart> voiceParts,
        List<RenderPhrase> allPhrases,
        int originalPhraseCount,
        Dictionary<UNote, string> originalLyricsByNote) {
        if (job.Project == null || job.AllPhrases == null) {
            return;
        }

        var editedNoteKeys = BuildEditNoteKeys(edits);
        var phraseNoteKeys = BuildPhraseNoteKeys(allPhrases);
        var missingEditedNotes = editedNoteKeys
            .Where(key => !phraseNoteKeys.Contains(key))
            .ToList();

        var structureChanged = allPhrases.Count != originalPhraseCount
            || missingEditedNotes.Count > 0;
        if (!structureChanged) {
            return;
        }

        Log.Warning(
            "[edit-notes] lyric-only edit rejected for job {JobId}: phrases {OldPhraseCount}->{NewPhraseCount}, missing edited notes=[{Missing}]",
            job.JobId,
            originalPhraseCount,
            allPhrases.Count,
            string.Join(", ", missingEditedNotes));

        RestoreLyrics(originalLyricsByNote);
        job.Project.ValidateFull();
        WaitForPhonemization(voiceParts, 60, 500, "lyric-edit rollback");
        job.Project.Validate(new ValidateOptions { SkipPhonemizer = true });
        job.AllPhrases = CollectAllPhrases(voiceParts);

        throw new EditNotesRejectedException(
            $"Lyric edit was rejected because it changed phrase structure unexpectedly (phrases {originalPhraseCount}->{allPhrases.Count}).");
    }

    private void CleanupOldJobs() {
        var cutoff = DateTime.UtcNow.AddHours(-1);
        var expired = _jobs.Where(kv => kv.Value.CreatedAt < cutoff
            && kv.Value.Status is "completed" or "failed").ToList();
        foreach (var kv in expired) {
            DeleteJob(kv.Key);
        }
    }

    private static string ResolveRuntimePath(string basePath, string? configuredPath, string defaultRelativePath) {
        if (string.IsNullOrWhiteSpace(configuredPath)) {
            return Path.Combine(basePath, defaultRelativePath);
        }
        if (Path.IsPathRooted(configuredPath)) {
            return configuredPath;
        }
        return Path.GetFullPath(Path.Combine(basePath, configuredPath));
    }
}
