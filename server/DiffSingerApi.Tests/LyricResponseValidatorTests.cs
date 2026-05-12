using System.Text.Json;
using DiffSingerApi.Services;
using Xunit;

namespace DiffSingerApi.Tests;

public sealed class LyricResponseValidatorTests {
    private static JsonElement MusicStructure(params int[] syllableCounts) {
        var phrases = syllableCounts.Select(c => new { syllableCount = c });
        var json = JsonSerializer.Serialize(new { phrases });
        using var doc = JsonDocument.Parse(json);
        return doc.RootElement.Clone();
    }

    [Fact]
    public void ValidateLyricResponseFull_全对时返回无失败_含解析后的_phrases() {
        var raw = "{\"phrases\":[{\"index\":1,\"lyric\":[\"夜\",\"凉\",\"风\"]}]}";
        var ms = MusicStructure(3);
        var r = LyricResponseValidator.ValidateLyricResponseFull(raw, ms);

        Assert.Null(r.FirstFailure);
        Assert.Empty(r.AllFailures);
        Assert.NotNull(r.Phrases);
        Assert.Single(r.Phrases!);
        Assert.Equal(new[] { "夜", "凉", "风" }, r.Phrases![0].Lyric);
    }

    [Fact]
    public void ValidateLyricResponseFull_多句错位时全部收齐到_AllFailures() {
        var raw = JsonSerializer.Serialize(new {
            phrases = new[] {
                new { index = 1, lyric = new[] { "夜", "凉", "风", "起" } },
                new { index = 2, lyric = new[] { "月", "影", "入", "窗" } },
                new { index = 3, lyric = new[] { "空", "城", "远" } },  // 应 4 给 3
                new { index = 4, lyric = new[] { "寒", "梅", "初", "开", "了" } },  // 应 4 给 5
                new { index = 5, lyric = new[] { "雪", "满", "长", "街" } },
            },
        });
        var ms = MusicStructure(4, 4, 4, 4, 4);
        var r = LyricResponseValidator.ValidateLyricResponseFull(raw, ms);

        Assert.NotNull(r.FirstFailure);
        Assert.Equal("syllable-mismatch", r.FirstFailure!.Reason);
        Assert.Equal(2, r.AllFailures.Count);
        Assert.Equal(new int?[] { 3, 4 }, r.AllFailures.Select(f => f.PhraseIndex).ToArray());
        Assert.Equal(3, r.AllFailures[0].Actual);
        Assert.Equal(5, r.AllFailures[1].Actual);
        Assert.NotNull(r.Phrases);
        Assert.Equal(5, r.Phrases!.Count);
    }

    [Fact]
    public void ValidateLyricResponseFull_invalid_json_时_Phrases_为_null() {
        var r = LyricResponseValidator.ValidateLyricResponseFull("not json", MusicStructure(3));
        Assert.Equal("invalid-json", r.FirstFailure?.Reason);
        Assert.Null(r.Phrases);
    }

    [Fact]
    public void ValidateLyricResponseFull_markdown_代码块包裹也能解析() {
        var raw = "```json\n{\"phrases\":[{\"index\":1,\"lyric\":[\"夏\",\"夜\",\"风\"]}]}\n```";
        var r = LyricResponseValidator.ValidateLyricResponseFull(raw, MusicStructure(3));
        Assert.Null(r.FirstFailure);
        Assert.NotNull(r.Phrases);
    }

    [Fact]
    public void ParsePhrasesShallow_局部响应能抽出_index_和_lyric() {
        var raw = "{\"phrases\":[{\"index\":3,\"lyric\":[\"孤\",\"城\",\"远\",\"岸\"]},{\"index\":7,\"lyric\":[\"雪\",\"满\",\"长\",\"街\"]}]}";
        var phrases = LyricResponseValidator.ParsePhrasesShallow(raw);
        Assert.NotNull(phrases);
        Assert.Equal(2, phrases!.Count);
        Assert.Equal(3, phrases[0].Index);
        Assert.Equal(new[] { "孤", "城", "远", "岸" }, phrases[0].Lyric);
        Assert.Equal(7, phrases[1].Index);
    }

    [Fact]
    public void ParsePhrasesShallow_非_JSON_返回_null() {
        Assert.Null(LyricResponseValidator.ParsePhrasesShallow("not json"));
        Assert.Null(LyricResponseValidator.ParsePhrasesShallow(""));
        Assert.Null(LyricResponseValidator.ParsePhrasesShallow(null));
    }

    [Fact]
    public void MergePartialIntoAccumulated_按_index_替换对应位置_其他保留() {
        var accumulated = new List<LyricResponseValidator.ParsedPhraseData> {
            new(1, new List<string> { "夜", "凉", "风", "起" }),
            new(2, new List<string> { "月", "影", "入", "窗" }),
            new(3, new List<string> { "空", "城", "远" }),
            new(4, new List<string> { "寒", "梅", "初", "开" }),
        };
        var partial = new List<LyricResponseValidator.ParsedPhraseData> {
            new(3, new List<string> { "孤", "城", "远", "岸" }),
        };

        var merged = LyricResponseValidator.MergePartialIntoAccumulated(accumulated, partial);
        Assert.Equal(4, merged.Count);
        Assert.Equal(new[] { "夜", "凉", "风", "起" }, merged[0].Lyric);
        Assert.Equal(new[] { "月", "影", "入", "窗" }, merged[1].Lyric);
        Assert.Equal(new[] { "孤", "城", "远", "岸" }, merged[2].Lyric);
        Assert.Equal(new[] { "寒", "梅", "初", "开" }, merged[3].Lyric);
    }

    [Fact]
    public void SerializePhrasesToJson_输出可被_ValidateLyricResponseFull_再次解析() {
        // 端到端：合并后的 phrases → JSON → 再校验，确认整条路径不丢字
        var phrases = new List<LyricResponseValidator.ParsedPhraseData> {
            new(1, new List<string> { "夜", "凉", "风", "起" }),
            new(2, new List<string> { "月", "影", "入", "窗" }),
        };
        var json = LyricResponseValidator.SerializePhrasesToJson(phrases);
        var r = LyricResponseValidator.ValidateLyricResponseFull(json, MusicStructure(4, 4));
        Assert.Null(r.FirstFailure);
        Assert.Equal(8, r.Phrases!.Sum(p => p.Lyric.Count));
    }

    [Fact]
    public void BuildPartialRetryCorrectionPrompt_含已对句子上下文_和待修订句要求() {
        var parsed = new List<LyricResponseValidator.ParsedPhraseData> {
            new(1, new List<string> { "夜", "凉", "风", "起" }),
            new(2, new List<string> { "月", "影", "入", "窗" }),
            new(3, new List<string> { "空", "城", "远" }),  // bad
            new(4, new List<string> { "寒", "梅", "初", "开" }),
        };
        var failures = new List<LyricAIService.LyricParseFailure> {
            new("syllable-mismatch", PhraseIndex: 3, Expected: 4, Actual: 3),
        };
        var prompt = LyricResponseValidator.BuildPartialRetryCorrectionPrompt(parsed, failures);

        Assert.Contains("夜凉风起", prompt);
        Assert.Contains("月影入窗", prompt);
        Assert.Contains("寒梅初开", prompt);
        Assert.Contains("第 3 句", prompt);
        Assert.Contains("4 个字", prompt);
        Assert.Contains("空城远", prompt);  // 上次写错的内容也要给 LLM 看
        Assert.Contains("\"index\": 3", prompt);  // 输出格式提示
    }

    [Fact]
    public void End2End_局部修订路径_合并后再校验通过() {
        // 模拟 LyricAIService 中"上一轮校验出错位 → 准备局部 retry → 收到局部响应 → 合并 → 再校验"的链路
        var firstRoundRaw = JsonSerializer.Serialize(new {
            phrases = new[] {
                new { index = 1, lyric = new[] { "夜", "凉", "风", "起" } },
                new { index = 2, lyric = new[] { "月", "影", "入", "窗" } },
                new { index = 3, lyric = new[] { "空", "城", "远" } },  // 应 4 给 3
                new { index = 4, lyric = new[] { "寒", "梅", "初", "开" } },
            },
        });
        var ms = MusicStructure(4, 4, 4, 4);

        // 第 1 轮校验
        var v1 = LyricResponseValidator.ValidateLyricResponseFull(firstRoundRaw, ms);
        Assert.Single(v1.AllFailures);

        // LLM 局部修订响应
        var partialRaw = "{\"phrases\":[{\"index\":3,\"lyric\":[\"孤\",\"城\",\"远\",\"岸\"]}]}";
        var partial = LyricResponseValidator.ParsePhrasesShallow(partialRaw);
        Assert.NotNull(partial);

        // 合并 + 再校验
        var merged = LyricResponseValidator.MergePartialIntoAccumulated(v1.Phrases!, partial!);
        var mergedJson = LyricResponseValidator.SerializePhrasesToJson(merged);
        var v2 = LyricResponseValidator.ValidateLyricResponseFull(mergedJson, ms);

        Assert.Null(v2.FirstFailure);
        Assert.Equal(16, v2.Phrases!.Sum(p => p.Lyric.Count));
        Assert.Equal(new[] { "孤", "城", "远", "岸" }, v2.Phrases![2].Lyric);
    }
}
