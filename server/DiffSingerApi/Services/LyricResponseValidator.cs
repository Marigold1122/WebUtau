using System.Globalization;
using System.Text;
using System.Text.Json;

namespace DiffSingerApi.Services;

// LyricAIService 用到的所有"无副作用"逻辑：解析 LLM 响应、校验、合并、构造重试提示词。
// 抽到单独类便于单测（不需要 HttpClient 也不需要 LLM）。
internal static class LyricResponseValidator {
    // 解析 + 校验后的结构化结果。
    //   FirstFailure: 第一个错位（兼容老消费方）
    //   AllFailures: 所有错位（用于"局部修订"决策）
    //   Phrases: 解析出来的全部 phrases（若 invalid-json / missing-phrases 则为 null）
    internal sealed record ValidationResult(
        LyricAIService.LyricParseFailure? FirstFailure,
        List<LyricAIService.LyricParseFailure> AllFailures,
        List<ParsedPhraseData>? Phrases);

    internal sealed record ParsedPhraseData(int Index, List<string> Lyric);

    // 容忍 LLM 偶尔包 markdown 代码块，以及 lyric 写成字符串而非数组的情况
    internal static ValidationResult ValidateLyricResponseFull(string? rawText, JsonElement? musicStructure) {
        if (string.IsNullOrWhiteSpace(rawText)) {
            return new ValidationResult(new LyricAIService.LyricParseFailure("empty-response"), new List<LyricAIService.LyricParseFailure>(), null);
        }
        var body = StripMarkdownFence(rawText);

        JsonDocument? doc;
        try { doc = JsonDocument.Parse(body); }
        catch {
            return new ValidationResult(new LyricAIService.LyricParseFailure("invalid-json"), new List<LyricAIService.LyricParseFailure>(), null);
        }
        using (doc) {
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object ||
                !root.TryGetProperty("phrases", out var phrasesEl) ||
                phrasesEl.ValueKind != JsonValueKind.Array) {
                return new ValidationResult(new LyricAIService.LyricParseFailure("missing-phrases"), new List<LyricAIService.LyricParseFailure>(), null);
            }

            var expectedSyllables = ExtractExpectedSyllables(musicStructure);
            int phraseCount = phrasesEl.GetArrayLength();
            if (expectedSyllables != null && phraseCount != expectedSyllables.Count) {
                return new ValidationResult(
                    new LyricAIService.LyricParseFailure("phrase-count-mismatch", Expected: expectedSyllables.Count, Actual: phraseCount),
                    new List<LyricAIService.LyricParseFailure>(),
                    null);
            }

            var parsed = new List<ParsedPhraseData>(phraseCount);
            var failures = new List<LyricAIService.LyricParseFailure>();
            for (int i = 0; i < phraseCount; i++) {
                var p = phrasesEl[i];
                List<string>? lyricChars;
                if (p.ValueKind == JsonValueKind.Object && p.TryGetProperty("lyric", out var lyricEl)) {
                    if (lyricEl.ValueKind == JsonValueKind.Array) {
                        lyricChars = new List<string>(lyricEl.GetArrayLength());
                        foreach (var el in lyricEl.EnumerateArray()) {
                            lyricChars.Add(el.GetString()?.Trim() ?? "");
                        }
                    } else if (lyricEl.ValueKind == JsonValueKind.String) {
                        lyricChars = SplitChars(lyricEl.GetString()?.Trim() ?? "");
                    } else {
                        return new ValidationResult(
                            new LyricAIService.LyricParseFailure("phrase-shape", PhraseIndex: i + 1),
                            failures,
                            null);
                    }
                } else {
                    return new ValidationResult(
                        new LyricAIService.LyricParseFailure("phrase-shape", PhraseIndex: i + 1),
                        failures,
                        null);
                }
                parsed.Add(new ParsedPhraseData(i + 1, lyricChars));
                if (expectedSyllables != null) {
                    int want = expectedSyllables[i];
                    int actual = lyricChars.Count;
                    if (actual != want) {
                        failures.Add(new LyricAIService.LyricParseFailure(
                            "syllable-mismatch",
                            PhraseIndex: i + 1,
                            Expected: want,
                            Actual: actual));
                    }
                }
            }
            return new ValidationResult(failures.FirstOrDefault(), failures, parsed);
        }
    }

    // 浅解析：从 LLM 局部响应里抽出 { index, lyric } 列表，不做字数校验
    internal static List<ParsedPhraseData>? ParsePhrasesShallow(string? rawText) {
        if (string.IsNullOrWhiteSpace(rawText)) return null;
        var body = StripMarkdownFence(rawText);
        try {
            using var doc = JsonDocument.Parse(body);
            if (doc.RootElement.ValueKind != JsonValueKind.Object) return null;
            if (!doc.RootElement.TryGetProperty("phrases", out var phrasesEl)) return null;
            if (phrasesEl.ValueKind != JsonValueKind.Array) return null;

            var list = new List<ParsedPhraseData>(phrasesEl.GetArrayLength());
            foreach (var p in phrasesEl.EnumerateArray()) {
                if (p.ValueKind != JsonValueKind.Object) continue;
                if (!p.TryGetProperty("index", out var idxEl) || !idxEl.TryGetInt32(out var idx)) continue;
                if (!p.TryGetProperty("lyric", out var lyricEl)) continue;
                List<string> chars;
                if (lyricEl.ValueKind == JsonValueKind.Array) {
                    chars = new List<string>(lyricEl.GetArrayLength());
                    foreach (var el in lyricEl.EnumerateArray()) {
                        chars.Add(el.GetString()?.Trim() ?? "");
                    }
                } else if (lyricEl.ValueKind == JsonValueKind.String) {
                    chars = SplitChars(lyricEl.GetString()?.Trim() ?? "");
                } else continue;
                list.Add(new ParsedPhraseData(idx, chars));
            }
            return list.Count > 0 ? list : null;
        } catch {
            return null;
        }
    }

    // 局部响应按 index 合并回 accumulated。Index 都是 1-based
    internal static List<ParsedPhraseData> MergePartialIntoAccumulated(
        List<ParsedPhraseData> accumulated,
        List<ParsedPhraseData> partial) {
        var byIndex = partial.GroupBy(p => p.Index).ToDictionary(g => g.Key, g => g.Last());
        var merged = new List<ParsedPhraseData>(accumulated.Count);
        foreach (var p in accumulated) {
            merged.Add(byIndex.TryGetValue(p.Index, out var updated) ? updated : p);
        }
        return merged;
    }

    // 合并后的 phrases 序列化回 JSON 字符串作为接口返回
    internal static string SerializePhrasesToJson(List<ParsedPhraseData> phrases) {
        var payload = new {
            phrases = phrases.Select(p => new {
                index = p.Index,
                lyric = p.Lyric,
            }),
        };
        return JsonSerializer.Serialize(payload, new JsonSerializerOptions {
            Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        });
    }

    // 完整重投路径的纠错提示（让 LLM 重新输出完整 JSON）
    internal static string BuildCorrectionPrompt(LyricAIService.LyricParseFailure failure) {
        switch (failure.Reason) {
            case "syllable-mismatch":
                return $"你上一轮的输出中，第 {failure.PhraseIndex} 句给了 {failure.Actual} 个字，"
                     + $"但音乐结构要求该句必须是 {failure.Expected} 个字。"
                     + $"请重新输出**完整的** JSON：第 {failure.PhraseIndex} 句改成正好 {failure.Expected} 个字，"
                     + "其它句的字数也要严格对齐音乐结构里的 syllableCount。"
                     + "提醒：每个汉字算 1 个字，标点不算；不要包含 markdown 代码块标记。";
            case "phrase-count-mismatch":
                return $"你上一轮输出了 {failure.Actual} 句歌词，但音乐结构有 {failure.Expected} 句。"
                     + $"请重新输出完整 JSON，必须**恰好 {failure.Expected} 个 phrase**，"
                     + "并且每个 phrase 的字数都严格等于该句对应的 syllableCount。";
            case "invalid-json":
                return "你上一轮的输出不是合法 JSON，无法解析。请严格按系统提示中的 JSON 结构重新输出："
                     + "{\"phrases\":[...]}，不要使用 markdown 代码块、不要加任何说明文字。";
            case "missing-phrases":
                return "你上一轮输出的 JSON 缺少 phrases 数组。请重新输出，根节点必须是 "
                     + "{\"phrases\":[{...}, ...]} 这种结构。";
            case "phrase-shape":
                return $"你上一轮输出的第 {failure.PhraseIndex} 句格式不对——lyric 字段缺失或不是字符数组。"
                     + "请重新输出完整 JSON：每个 phrase 必须有 \"lyric\": [\"字\", \"字\", ...] 这种字符数组。";
            case "empty-response":
                return "你上一轮没有返回任何内容。请按要求输出完整 JSON。";
            default:
                return "你上一轮的输出不符合要求，请严格按系统提示中的格式重新输出 JSON，"
                     + "保证 phrases 数量与每句字数都准确匹配音乐结构。";
        }
    }

    // 局部修订的纠错提示（让 LLM 只输出错位句的修订版，后端合并）
    internal static string BuildPartialRetryCorrectionPrompt(
        List<ParsedPhraseData> parsedPhrases,
        List<LyricAIService.LyricParseFailure> failures) {
        var badIdxSet = new HashSet<int>(failures.Select(f => f.PhraseIndex ?? -1));
        var goodLines = parsedPhrases
            .Where(p => !badIdxSet.Contains(p.Index))
            .Select(p => $"第 {p.Index} 句（{p.Lyric.Count} 字）：{string.Concat(p.Lyric)}")
            .ToList();
        var badRequests = failures.Select(f => {
            var original = parsedPhrases.FirstOrDefault(p => p.Index == f.PhraseIndex);
            var originalText = original != null ? string.Concat(original.Lyric) : "(空)";
            var slots = string.Concat(Enumerable.Repeat("□ ", f.Expected ?? 0)).TrimEnd();
            return $"- 第 {f.PhraseIndex} 句：必须正好 {f.Expected} 个字 {slots}（你上次写了 \"{originalText}\" 是 {f.Actual} 字）";
        }).ToList();

        var sb = new StringBuilder();
        sb.AppendLine("你上一轮写的歌词整体不错，**只有几句字数对不上**。请只重写这几句，**保持跟其它句子的语境 / 风格 / 押韵连贯**。");
        sb.AppendLine();
        sb.AppendLine("【你上一轮已写对的句子（保持，不要重写）】");
        sb.AppendLine(goodLines.Count > 0 ? string.Join("\n", goodLines) : "（无）");
        sb.AppendLine();
        sb.AppendLine("【需要重写的句子（字数严格按下面要求）】");
        sb.AppendLine(string.Join("\n", badRequests));
        sb.AppendLine();
        sb.AppendLine("## 输出格式");
        var jsonShape = string.Join(", ", failures.Select(f => $"{{ \"index\": {f.PhraseIndex}, \"lyric\": [...] }}"));
        sb.AppendLine($"严格输出 JSON，**只包含需要重写的句子**：{{ \"phrases\": [{jsonShape}] }}");
        sb.AppendLine("每个 phrase.lyric 必须是字符数组、长度严格等于该句要求字数。不要 markdown 代码块标记，纯 JSON。");
        return sb.ToString();
    }

    // ── 内部辅助 ──────────────────────────────────

    private static string StripMarkdownFence(string raw) {
        var body = raw.Trim();
        if (body.StartsWith("```")) {
            int firstNewline = body.IndexOf('\n');
            if (firstNewline > 0) body = body.Substring(firstNewline + 1);
            if (body.EndsWith("```")) body = body.Substring(0, body.Length - 3);
            body = body.Trim();
        }
        return body;
    }

    private static List<int>? ExtractExpectedSyllables(JsonElement? musicStructure) {
        if (musicStructure == null) return null;
        var ms = musicStructure.Value;
        if (ms.ValueKind != JsonValueKind.Object) return null;
        if (!ms.TryGetProperty("phrases", out var phrasesEl) ||
            phrasesEl.ValueKind != JsonValueKind.Array) return null;
        var list = new List<int>(phrasesEl.GetArrayLength());
        foreach (var p in phrasesEl.EnumerateArray()) {
            if (p.ValueKind != JsonValueKind.Object ||
                !p.TryGetProperty("syllableCount", out var sc) ||
                !sc.TryGetInt32(out var n)) {
                return null;
            }
            list.Add(n);
        }
        return list;
    }

    private static List<string> SplitChars(string s) {
        var result = new List<string>();
        if (string.IsNullOrEmpty(s)) return result;
        var enumerator = StringInfo.GetTextElementEnumerator(s);
        while (enumerator.MoveNext()) {
            result.Add((string)enumerator.Current);
        }
        return result;
    }
}
