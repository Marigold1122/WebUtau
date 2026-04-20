using System;
using System.Collections.Generic;
using System.Linq;
using OpenUtau.Api;
using OpenUtau.Core.Ustx;

namespace DiffSingerApi.Services;

internal static class DiffSingerPhonemizerSelector {
    internal const string DefaultLanguageCode = "ZH";

    // DiffSinger：类型名前缀命中的首选 phonemizer
    private static readonly IReadOnlyDictionary<string, string[]> DiffSingerPreferredTypeNames =
        new Dictionary<string, string[]>(StringComparer.OrdinalIgnoreCase) {
            ["ZH"] = ["OpenUtau.Core.DiffSinger.DiffSingerChinesePhonemizer"],
            ["JA"] = ["OpenUtau.Core.DiffSinger.DiffSingerJapanesePhonemizer"],
        };

    // Classic UTAU：按语言挑一个相对通用的默认 phonemizer tag
    // （声库自带 prefix.map / presamp.ini 时，OpenUtau 自己会覆盖这里的选择；
    //  这里只负责在声库没给出推荐时提供一个可工作的兜底）
    private static readonly IReadOnlyDictionary<string, string[]> ClassicPreferredTags =
        new Dictionary<string, string[]>(StringComparer.OrdinalIgnoreCase) {
            ["ZH"] = ["ZH CVVC", "ZH CVV+", "ZH CVV"],
            ["JA"] = ["JA VCV & CVVC", "JA CVVC", "JA VCV"],
            ["EN"] = ["EN ARPA+", "EN ARPA", "EN VCCV"],
            ["KO"] = ["KO CVVC", "KO CVC", "KO CV"],
        };

    internal static string NormalizeLanguageCode(string? languageCode) {
        var normalized = (languageCode ?? string.Empty).Trim().ToUpperInvariant();
        return string.IsNullOrEmpty(normalized) ? DefaultLanguageCode : normalized;
    }

    /// <summary>
    /// 按音源类型 + 语言挑一个合适的 phonemizer。
    /// DiffSinger 仅在 DiffSinger 的 phonemizer 集合中选；
    /// Classic UTAU 则排除掉所有引擎专属（DiffSinger/Enunu/Voicevox/Vogen）的 phonemizer，
    /// 在剩下的 Classic phonemizer 中按语言挑。
    /// </summary>
    internal static PhonemizerFactory? SelectForSinger(USingerType singerType, string? languageCode) {
        return singerType switch {
            USingerType.Classic => SelectClassic(languageCode),
            _ => Select(languageCode),
        };
    }

    internal static PhonemizerFactory? Select(string? languageCode) {
        var normalized = NormalizeLanguageCode(languageCode);
        var factories = PhonemizerFactory.GetAll()
            .Where(factory => factory.type.FullName?.Contains("DiffSinger", StringComparison.Ordinal) == true)
            .ToArray();

        if (DiffSingerPreferredTypeNames.TryGetValue(normalized, out var preferredTypes)) {
            foreach (var typeName in preferredTypes) {
                var preferredFactory = factories.FirstOrDefault(factory =>
                    string.Equals(factory.type.FullName, typeName, StringComparison.Ordinal));
                if (preferredFactory != null) {
                    return preferredFactory;
                }
            }
        }

        return factories.FirstOrDefault(factory => string.Equals(factory.tag, $"DIFFS {normalized}", StringComparison.OrdinalIgnoreCase))
            ?? factories.FirstOrDefault(factory => string.Equals(factory.language, normalized, StringComparison.OrdinalIgnoreCase))
            ?? factories.FirstOrDefault(factory => string.Equals(factory.language, DefaultLanguageCode, StringComparison.OrdinalIgnoreCase))
            ?? factories.FirstOrDefault(factory => factory.type.FullName == "OpenUtau.Core.DiffSinger.DiffSingerChinesePhonemizer")
            ?? factories.FirstOrDefault();
    }

    private static PhonemizerFactory? SelectClassic(string? languageCode) {
        var normalized = NormalizeLanguageCode(languageCode);

        // 排除所有引擎专属 phonemizer，剩下的视为 Classic UTAU 兼容
        bool IsClassicCompatible(PhonemizerFactory f) {
            var name = f.type.FullName ?? string.Empty;
            return !name.Contains("DiffSinger", StringComparison.Ordinal)
                && !name.Contains("Enunu", StringComparison.Ordinal)
                && !name.Contains("Voicevox", StringComparison.Ordinal)
                && !name.Contains("Vogen", StringComparison.Ordinal);
        }

        var factories = PhonemizerFactory.GetAll()
            .Where(IsClassicCompatible)
            .ToArray();

        if (ClassicPreferredTags.TryGetValue(normalized, out var tags)) {
            foreach (var tag in tags) {
                var preferred = factories.FirstOrDefault(f =>
                    string.Equals(f.tag, tag, StringComparison.OrdinalIgnoreCase));
                if (preferred != null) return preferred;
            }
        }

        return factories.FirstOrDefault(f => string.Equals(f.language, normalized, StringComparison.OrdinalIgnoreCase))
            ?? factories.FirstOrDefault(f => string.Equals(f.language, DefaultLanguageCode, StringComparison.OrdinalIgnoreCase))
            ?? factories.FirstOrDefault();
    }
}
