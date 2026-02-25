using System.IO.Compression;
using DiffSingerApi.Models;
using OpenUtau.Core;
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

        return SingerManager.Inst.Singers.Values
            .Where(s => s.SingerType == OpenUtau.Core.Ustx.USingerType.DiffSinger)
            .Select(s => new VoicebankInfo {
                Id = s.Id,
                Name = s.Name,
                SingerType = s.SingerType.ToString()
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
