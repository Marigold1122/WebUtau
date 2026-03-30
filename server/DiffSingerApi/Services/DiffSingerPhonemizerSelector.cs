using System;
using System.Collections.Generic;
using System.Linq;
using OpenUtau.Api;

namespace DiffSingerApi.Services;

internal static class DiffSingerPhonemizerSelector {
    internal const string DefaultLanguageCode = "ZH";
    private static readonly IReadOnlyDictionary<string, string[]> PreferredTypeNames =
        new Dictionary<string, string[]>(StringComparer.OrdinalIgnoreCase) {
            ["ZH"] = ["OpenUtau.Core.DiffSinger.DiffSingerChinesePhonemizer"],
            ["JA"] = ["OpenUtau.Core.DiffSinger.DiffSingerJapanesePhonemizer"],
        };

    internal static string NormalizeLanguageCode(string? languageCode) {
        var normalized = (languageCode ?? string.Empty).Trim().ToUpperInvariant();
        return string.IsNullOrEmpty(normalized) ? DefaultLanguageCode : normalized;
    }

    internal static PhonemizerFactory? Select(string? languageCode) {
        var normalized = NormalizeLanguageCode(languageCode);
        var factories = PhonemizerFactory.GetAll()
            .Where(factory => factory.type.FullName?.Contains("DiffSinger", StringComparison.Ordinal) == true)
            .ToArray();

        if (PreferredTypeNames.TryGetValue(normalized, out var preferredTypes)) {
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
}
