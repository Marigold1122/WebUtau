using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using OpenUtau.Api;
using OpenUtau.Core.G2p;

namespace OpenUtau.Core.DiffSinger {
    [Phonemizer("DiffSinger Japanese Phonemizer", "DIFFS JA", language: "JA")]
    public class DiffSingerJapanesePhonemizer : DiffSingerBasePhonemizer {
        private static readonly HashSet<string> LongVowelMarks = new() { "ー", "ｰ" };
        private static readonly Dictionary<string, string> KanaAliases = new() {
            ["ゕ"] = "か",
            ["ゖ"] = "け",
            ["ヵ"] = "カ",
            ["ヶ"] = "ケ",
            ["ヷ"] = "ヴァ",
            ["ヸ"] = "ヴィ",
            ["ヹ"] = "ヴェ",
            ["ヺ"] = "ヴォ",
            ["ゟ"] = "より",
            ["ヿ"] = "コト",
        };
        private static readonly HashSet<string> KanaRepeatMarks = new() { "ゝ", "ヽ" };
        private static readonly HashSet<string> VoicedKanaRepeatMarks = new() { "ゞ", "ヾ" };
        private static readonly Dictionary<string, string> DakutenKana = new() {
            ["う"] = "ゔ",
            ["か"] = "が",
            ["き"] = "ぎ",
            ["く"] = "ぐ",
            ["け"] = "げ",
            ["こ"] = "ご",
            ["さ"] = "ざ",
            ["し"] = "じ",
            ["す"] = "ず",
            ["せ"] = "ぜ",
            ["そ"] = "ぞ",
            ["た"] = "だ",
            ["ち"] = "ぢ",
            ["つ"] = "づ",
            ["て"] = "で",
            ["と"] = "ど",
            ["は"] = "ば",
            ["ひ"] = "び",
            ["ふ"] = "ぶ",
            ["へ"] = "べ",
            ["ほ"] = "ぼ",
            ["カ"] = "ガ",
            ["キ"] = "ギ",
            ["ク"] = "グ",
            ["ケ"] = "ゲ",
            ["コ"] = "ゴ",
            ["サ"] = "ザ",
            ["シ"] = "ジ",
            ["ス"] = "ズ",
            ["セ"] = "ゼ",
            ["ソ"] = "ゾ",
            ["タ"] = "ダ",
            ["チ"] = "ヂ",
            ["ツ"] = "ヅ",
            ["テ"] = "デ",
            ["ト"] = "ド",
            ["ハ"] = "バ",
            ["ヒ"] = "ビ",
            ["フ"] = "ブ",
            ["ヘ"] = "ベ",
            ["ホ"] = "ボ",
            ["ウ"] = "ヴ",
        };
        private static readonly Dictionary<string, bool> BasePhonemeTypes = new() {
            ["AP"] = true,
            ["SP"] = true,
            ["A"] = true,
            ["E"] = true,
            ["I"] = true,
            ["N"] = true,
            ["O"] = true,
            ["U"] = true,
            ["a"] = true,
            ["b"] = false,
            ["by"] = false,
            ["ch"] = false,
            ["cl"] = false,
            ["d"] = false,
            ["dy"] = false,
            ["e"] = true,
            ["f"] = false,
            ["g"] = false,
            ["gw"] = false,
            ["gy"] = false,
            ["h"] = false,
            ["hy"] = false,
            ["i"] = true,
            ["j"] = false,
            ["k"] = false,
            ["kw"] = false,
            ["ky"] = false,
            ["m"] = false,
            ["my"] = false,
            ["n"] = false,
            ["ng"] = false,
            ["ngy"] = false,
            ["ny"] = false,
            ["o"] = true,
            ["p"] = false,
            ["py"] = false,
            ["r"] = false,
            ["ry"] = false,
            ["s"] = false,
            ["sh"] = false,
            ["t"] = false,
            ["ts"] = false,
            ["ty"] = false,
            ["u"] = true,
            ["v"] = false,
            ["w"] = false,
            ["y"] = false,
            ["z"] = false,
        };

        private readonly Dictionary<string, string> resolvedBasePhonemes = new(StringComparer.Ordinal);

        protected override string GetDictionaryName() => "dsdict-ja.yaml";

        public override string GetLangCode() => "ja";

        protected override IG2p LoadG2p(string rootPath, bool useLangId = false) {
            var g2ps = new List<IG2p>();
            var singerSymbols = new Dictionary<string, bool>(StringComparer.Ordinal);
            var singerGlides = new HashSet<string>(StringComparer.Ordinal);

            foreach (var dictionaryName in new[] { GetDictionaryName(), "dsdict.yaml" }) {
                var dictionaryPath = Path.Combine(rootPath, dictionaryName);
                if (!File.Exists(dictionaryPath)) {
                    continue;
                }

                try {
                    var dictData = Yaml.DefaultDeserializer.Deserialize<G2pDictionaryData>(File.ReadAllText(dictionaryPath));
                    var builder = G2pDictionary.NewBuilder();
                    builder.Load(dictData);
                    builder.AddSymbol("SP", true);
                    builder.AddSymbol("AP", true);
                    g2ps.Add(builder.Build());

                    if (dictData.symbols != null) {
                        foreach (var symbol in dictData.symbols) {
                            singerSymbols[symbol.symbol] = symbol.type == "vowel";
                            if (symbol.type == "semivowel" || symbol.type == "liquid") {
                                singerGlides.Add(symbol.symbol);
                            }
                        }
                    }
                    singerSymbols["SP"] = true;
                    singerSymbols["AP"] = true;
                    break;
                } catch {
                    continue;
                }
            }

            var inventory = LoadPhonemeInventory(rootPath);
            var remapperSymbols = new Dictionary<string, bool>(singerSymbols, StringComparer.Ordinal);
            var remapperGlides = new HashSet<string>(singerGlides, StringComparer.Ordinal);
            var replacements = BuildBaseReplacements(inventory, remapperSymbols, remapperGlides);
            g2ps.Add(new G2pRemapper(new JapaneseMonophoneG2p(), remapperSymbols, replacements, remapperGlides));

            return new G2pFallbacks(g2ps.ToArray());
        }

        protected override string[] Romanize(IEnumerable<string> lyrics) {
            var lyricsArray = lyrics.ToArray();
            var previousLyric = string.Empty;
            for (int i = 0; i < lyricsArray.Length; i++) {
                var lyric = lyricsArray[i];
                var alias = ResolveKanaAlias(lyric, previousLyric);
                if (alias != null) {
                    lyricsArray[i] = alias;
                } else if (LongVowelMarks.Contains(lyric)) {
                    lyricsArray[i] = ResolveLongVowelHint(previousLyric) ?? lyric;
                }
                previousLyric = lyricsArray[i];
            }
            return lyricsArray;
        }

        private Dictionary<string, string> BuildBaseReplacements(
            HashSet<string> inventory,
            Dictionary<string, bool> remapperSymbols,
            HashSet<string> remapperGlides) {
            var replacements = new Dictionary<string, string>(StringComparer.Ordinal);
            resolvedBasePhonemes.Clear();

            foreach (var entry in BasePhonemeTypes) {
                var basePhoneme = entry.Key;
                var isVowel = entry.Value;
                remapperSymbols[basePhoneme] = isVowel;

                var resolved = ResolveInventoryPhoneme(basePhoneme, inventory);
                resolvedBasePhonemes[basePhoneme] = resolved;
                remapperSymbols[resolved] = isVowel;

                if (IsGlide(basePhoneme)) {
                    remapperGlides.Add(basePhoneme);
                    remapperGlides.Add(resolved);
                }

                if (!string.Equals(resolved, basePhoneme, StringComparison.Ordinal)) {
                    replacements[basePhoneme] = resolved;
                }
            }

            return replacements;
        }

        private HashSet<string> LoadPhonemeInventory(string rootPath) {
            try {
                var configPath = Path.Combine(rootPath, "dsconfig.yaml");
                if (!File.Exists(configPath)) {
                    return new HashSet<string>(StringComparer.Ordinal);
                }

                var config = Yaml.DefaultDeserializer.Deserialize<DsConfig>(File.ReadAllText(configPath));
                if (string.IsNullOrWhiteSpace(config?.phonemes)) {
                    return new HashSet<string>(StringComparer.Ordinal);
                }

                var phonemesPath = Path.GetFullPath(Path.Combine(rootPath, config.phonemes));
                if (!File.Exists(phonemesPath)) {
                    return new HashSet<string>(StringComparer.Ordinal);
                }

                var phonemeMap = JsonSerializer.Deserialize<Dictionary<string, int>>(File.ReadAllText(phonemesPath));
                return phonemeMap == null
                    ? new HashSet<string>(StringComparer.Ordinal)
                    : phonemeMap.Keys.ToHashSet(StringComparer.Ordinal);
            } catch {
                return new HashSet<string>(StringComparer.Ordinal);
            }
        }

        private string ResolveInventoryPhoneme(string basePhoneme, HashSet<string> inventory) {
            var withLang = $"{GetLangCode()}/{basePhoneme}";
            if (inventory.Contains(withLang)) {
                return withLang;
            }

            if (inventory.Contains(basePhoneme)) {
                return basePhoneme;
            }

            return basePhoneme;
        }

        private string ResolveBasePhoneme(string basePhoneme) {
            return resolvedBasePhonemes.TryGetValue(basePhoneme, out var resolved)
                ? resolved
                : basePhoneme;
        }

        private static bool IsGlide(string phoneme) {
            return phoneme is "w" or "y";
        }

        private static string? ResolveKanaAlias(string lyric, string previousLyric) {
            if (KanaAliases.TryGetValue(lyric, out var alias)) {
                return alias;
            }

            if (KanaRepeatMarks.Contains(lyric)) {
                return RepeatPreviousKana(previousLyric, false);
            }
            if (VoicedKanaRepeatMarks.Contains(lyric)) {
                return RepeatPreviousKana(previousLyric, true);
            }
            return null;
        }

        private static string? RepeatPreviousKana(string previousLyric, bool voiced) {
            if (string.IsNullOrWhiteSpace(previousLyric)) {
                return null;
            }

            var previousKana = previousLyric[^1].ToString();
            if (!Kana.Kana.IsKana(previousKana)) {
                return null;
            }
            if (voiced && DakutenKana.TryGetValue(previousKana, out var voicedKana)) {
                return voicedKana;
            }
            return previousKana;
        }

        private string? ResolveLongVowelHint(string previousLyric) {
            if (string.IsNullOrWhiteSpace(previousLyric)) {
                return null;
            }

            foreach (var token in previousLyric.Split(' ', StringSplitOptions.RemoveEmptyEntries).Reverse()) {
                var baseToken = token.Contains('/')
                    ? token[(token.LastIndexOf('/') + 1)..]
                    : token;
                if (baseToken is "a" or "i" or "u" or "e" or "o" or "N") {
                    return ResolveBasePhoneme(baseToken);
                }
            }

            if (Kana.Kana.IsKana(previousLyric)) {
                var kanaResult = Kana.Kana.KanaToRomaji(new List<string> { previousLyric }, Kana.Error.Default, false).ToStrList();
                if (kanaResult != null && kanaResult.Count > 0) {
                    var resolved = ResolveLongVowelHint(kanaResult[0]);
                    if (resolved != null) {
                        return resolved;
                    }
                }
            }

            var normalized = previousLyric.ToLowerInvariant();
            if (normalized.EndsWith("n")) return ResolveBasePhoneme("N");
            if (normalized.EndsWith("a")) return ResolveBasePhoneme("a");
            if (normalized.EndsWith("i")) return ResolveBasePhoneme("i");
            if (normalized.EndsWith("u")) return ResolveBasePhoneme("u");
            if (normalized.EndsWith("e")) return ResolveBasePhoneme("e");
            if (normalized.EndsWith("o")) return ResolveBasePhoneme("o");
            return null;
        }
    }
}
