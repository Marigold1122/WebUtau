using System.IO.Compression;
using DiffSingerApi.Models;
using OpenUtau.Core;
using OpenUtau.Core.Ustx;
using Serilog;

namespace DiffSingerApi.Services;

public class VoicebankService {
    private readonly SynthesisService _synthesisService;

    public VoicebankService(SynthesisService synthesisService) {
        _synthesisService = synthesisService;
    }

    public List<VoicebankInfo> GetAll() {
        if (!_synthesisService.IsInitialized)
            return new List<VoicebankInfo>();

        // 当前运行时支持两类音源：
        //   - DiffSinger：有内嵌 ONNX 音高/表情预测
        //   - Classic UTAU：依赖手画 PIT，音素化与渲染复用 OpenUtau 的 Classic 渲染管线
        // 其它类型（Enunu / Voicevox / Vogen）需要外部服务进程，未在本项目集成，暂不暴露。
        return SingerManager.Inst.Singers.Values
            .Where(s => s.SingerType == USingerType.DiffSinger
                     || s.SingerType == USingerType.Classic)
            .Select(s => new VoicebankInfo {
                Id = s.Id,
                Name = s.Name,
                SingerType = s.SingerType.ToString(),
            })
            .ToList();
    }

    public async Task<string> UploadAsync(Stream zipStream, string fileName) {
        var tempZip = Path.Combine(Path.GetTempPath(), $"{Guid.NewGuid():N}.zip");
        try {
            using (var fs = File.Create(tempZip)) {
                await zipStream.CopyToAsync(fs);
            }

            // Extract to voicebanks directory
            var extractDir = Path.Combine(_synthesisService.VoicebanksDir,
                Path.GetFileNameWithoutExtension(fileName));

            if (Directory.Exists(extractDir))
                Directory.Delete(extractDir, true);

            ZipFile.ExtractToDirectory(tempZip, extractDir);

            // Check if the zip had a single root folder — flatten if so
            var entries = Directory.GetFileSystemEntries(extractDir);
            if (entries.Length == 1 && Directory.Exists(entries[0])) {
                var innerDir = entries[0];
                var finalDir = Path.Combine(_synthesisService.VoicebanksDir,
                    Path.GetFileName(innerDir));
                if (finalDir != extractDir) {
                    if (Directory.Exists(finalDir))
                        Directory.Delete(finalDir, true);
                    Directory.Move(innerDir, finalDir);
                    Directory.Delete(extractDir, true);
                    extractDir = finalDir;
                }
            }

            // Validate: must contain dsconfig.yaml or character.txt
            var hasConfig = File.Exists(Path.Combine(extractDir, "dsconfig.yaml"))
                || File.Exists(Path.Combine(extractDir, "character.txt"));
            if (!hasConfig) {
                Directory.Delete(extractDir, true);
                throw new InvalidOperationException(
                    "Invalid voicebank: missing dsconfig.yaml or character.txt");
            }

            // Reload singers on the worker thread
            _synthesisService.ReloadSingers();

            Log.Information("Voicebank uploaded: {Dir}", extractDir);
            return Path.GetFileName(extractDir);
        } finally {
            if (File.Exists(tempZip))
                File.Delete(tempZip);
        }
    }
}
