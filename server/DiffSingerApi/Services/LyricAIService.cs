using System.Globalization;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Options;

namespace DiffSingerApi.Services;

// 调用 OpenAI 兼容的 chat completions endpoint，仅用平台密钥。
// DeepSeek / 通义 qwen / 智谱 GLM / 月之暗面 Kimi / OpenAI 都用同一套 schema。
//
// 安全设计：本服务不接收任何用户 API key——用户自带 key 的请求由前端浏览器
// 直连 LLM 厂商，根本不到达本后端。从代码源头杜绝"用户 key 经过我们服务器"
//
// 重试策略：LLM 数中文字数本来就不可靠（BPE 分词与汉字不对齐）。
// 推荐配 deepseek-reasoner（思考模式）当主力——它会先在内部"数一遍"，单次成功率 ~95%；
// 万一仍出错，把上次错答连同具体错位丢回去让模型修正。
// 重试只消耗平台 LLM 调用费，不增加用户配额扣减。
//
// MaxAttempts = 3 的取舍：
// - deepseek-chat（非思考，~5s/轮，单次 30% 失败）：3 次封顶 ~15s，从 30% 压到 ~3%
// - deepseek-reasoner（思考，~20s/轮，单次 5% 失败）：3 次封顶 ~60s，从 5% 压到 ~0.01%
// - 给用户 timeout 上限是 240s，3 次封顶完全在预算内
public sealed class LyricAIService {
    private const int MaxAttempts = 3;

    private readonly LyricAIOptions _options;
    private readonly HttpClient _http;
    private readonly ILogger<LyricAIService> _logger;

    public LyricAIService(
        IOptions<LyricAIOptions> options,
        IHttpClientFactory httpFactory,
        ILogger<LyricAIService> logger) {
        _options = options.Value;
        _http = httpFactory.CreateClient("lyric-ai");
        _logger = logger;
    }

    public sealed record GenerateRequest(
        IReadOnlyList<ChatMessage> Messages,
        JsonElement? MusicStructure);

    public sealed record ChatMessage(string Role, string Content);

    public sealed record GenerateResult(
        bool Ok,
        string? Content,
        string? ErrorMessage,
        int? UpstreamStatus,
        LyricParseFailure? ParseFailure = null,
        int Attempts = 1);

    public sealed record LyricParseFailure(
        string Reason,
        int? PhraseIndex = null,
        int? Expected = null,
        int? Actual = null);

    public async Task<GenerateResult> GenerateAsync(GenerateRequest request, CancellationToken ct) {
        // 只走平台配置——用户 key 路径不在这里
        string apiKey = _options.ApiKey;
        string baseUrl = _options.BaseUrl;
        string model = _options.Model;

        if (string.IsNullOrWhiteSpace(apiKey)) {
            return new GenerateResult(false, null, "AI 未配置 API key（管理员请在 appsettings.Local.json 的 LyricAI 节点填入）", null);
        }
        if (string.IsNullOrWhiteSpace(baseUrl) || string.IsNullOrWhiteSpace(model)) {
            return new GenerateResult(false, null, "AI 未配置 BaseUrl 或 Model", null);
        }

        // baseUrl 可能给的是 ".../v1" 或 ".../v1/" 或带或不带 /chat/completions——统一拼一次
        var fullUrl = baseUrl.TrimEnd('/').EndsWith("/chat/completions")
            ? baseUrl
            : baseUrl.TrimEnd('/') + "/chat/completions";

        // 把"已发送的 messages"维护成可追加列表——重试时往里塞 assistant 的错回答和
        // 我们的纠错 user 消息，让模型对照修正
        var conversation = new List<ChatMessage>(request.Messages);
        LyricParseFailure? lastFailure = null;
        string? lastContent = null;

        for (int attempt = 1; attempt <= MaxAttempts; attempt++) {
            var llmResult = await CallLLMOnceAsync(apiKey, fullUrl, model, conversation, ct);
            if (!llmResult.Ok) {
                // 上游错误（401 / 超时 / 网络）重试无意义，直接抛回
                return llmResult with { Attempts = attempt };
            }

            var content = llmResult.Content ?? "";
            var failure = ValidateLyricResponse(content, request.MusicStructure);
            if (failure == null) {
                if (attempt > 1) {
                    _logger.LogInformation("LyricAI succeeded on attempt {Attempt}", attempt);
                }
                return llmResult with { Attempts = attempt };
            }

            lastFailure = failure;
            lastContent = content;
            _logger.LogInformation(
                "LyricAI attempt {Attempt}/{Max} failed validation: {Reason} (phrase={Phrase}, expected={Exp}, actual={Act})",
                attempt, MaxAttempts, failure.Reason, failure.PhraseIndex, failure.Expected, failure.Actual);

            if (attempt < MaxAttempts) {
                // 把上次的错答和具体错位喂回去——LLM 看到自己刚说错什么，下次就能修正
                conversation.Add(new ChatMessage("assistant", content));
                conversation.Add(new ChatMessage("user", BuildCorrectionPrompt(failure)));
            }
        }

        // 重试用尽——把最后一次的内容 + 最后一次的失败原因一起返回，
        // 让 Controller 决定是否退还配额、给用户结构化错误
        return new GenerateResult(
            Ok: false,
            Content: lastContent,
            ErrorMessage: $"AI 多次（{MaxAttempts}）尝试都未能严格匹配音节数，建议换个主题或换 Pro 模型重试",
            UpstreamStatus: null,
            ParseFailure: lastFailure,
            Attempts: MaxAttempts);
    }

    // 单次 LLM 调用——不做校验，纯 HTTP + 解析 OpenAI 兼容响应
    private async Task<GenerateResult> CallLLMOnceAsync(
        string apiKey, string fullUrl, string model,
        IReadOnlyList<ChatMessage> messages, CancellationToken ct) {
        var payload = new {
            model = model,
            messages = messages.Select(m => new { role = m.Role, content = m.Content }),
            response_format = new { type = "json_object" },
            temperature = _options.Temperature,
            stream = false,
        };
        var requestBody = JsonSerializer.Serialize(payload);

        using var msg = new HttpRequestMessage(HttpMethod.Post, fullUrl);
        msg.Headers.Authorization = new AuthenticationHeaderValue("Bearer", apiKey);
        msg.Content = new StringContent(requestBody, Encoding.UTF8, "application/json");

        try {
            using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            cts.CancelAfter(TimeSpan.FromSeconds(Math.Max(5, _options.TimeoutSeconds)));
            using var response = await _http.SendAsync(msg, cts.Token);
            var bodyText = await response.Content.ReadAsStringAsync(cts.Token);

            if (!response.IsSuccessStatusCode) {
                _logger.LogWarning("LyricAI upstream {Status}: {Body}", (int)response.StatusCode, bodyText);
                return new GenerateResult(
                    false, null,
                    $"LLM 服务返回 {(int)response.StatusCode}: {Truncate(bodyText, 200)}",
                    (int)response.StatusCode);
            }

            using var doc = JsonDocument.Parse(bodyText);
            if (!doc.RootElement.TryGetProperty("choices", out var choicesEl) || choicesEl.GetArrayLength() == 0) {
                return new GenerateResult(false, null, "LLM 返回为空（无 choices）", null);
            }
            var first = choicesEl[0];
            if (!first.TryGetProperty("message", out var msgEl) ||
                !msgEl.TryGetProperty("content", out var contentEl)) {
                return new GenerateResult(false, null, "LLM 返回缺少 message.content", null);
            }
            var content = contentEl.GetString() ?? "";
            return new GenerateResult(true, content, null, null);
        } catch (TaskCanceledException) {
            return new GenerateResult(false, null, $"LLM 请求超时（{_options.TimeoutSeconds}s）", null);
        } catch (HttpRequestException ex) {
            _logger.LogWarning(ex, "LyricAI HTTP error");
            return new GenerateResult(false, null, $"LLM 网络错误: {ex.Message}", null);
        } catch (Exception ex) {
            _logger.LogError(ex, "LyricAI unexpected error");
            return new GenerateResult(false, null, $"LLM 内部错误: {ex.Message}", null);
        }
    }

    // 根据校验失败的具体类型，造一段"对症下药"的纠错提示给 LLM
    private static string BuildCorrectionPrompt(LyricParseFailure failure) {
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

    // 服务端预校验：解析 LLM 返回的 JSON，核对 phrases 数量与每句音节数是否与
    // musicStructure 匹配。返回 null 表示通过；返回非 null 表示该退还配额或重试。
    // 容忍 LLM 偶尔包 markdown 代码块，以及 lyric 写成字符串而非数组的情况
    private static LyricParseFailure? ValidateLyricResponse(string? rawText, JsonElement? musicStructure) {
        if (string.IsNullOrWhiteSpace(rawText)) {
            return new LyricParseFailure("empty-response");
        }
        var body = rawText.Trim();
        if (body.StartsWith("```")) {
            int firstNewline = body.IndexOf('\n');
            if (firstNewline > 0) body = body.Substring(firstNewline + 1);
            if (body.EndsWith("```")) body = body.Substring(0, body.Length - 3);
            body = body.Trim();
        }

        JsonDocument? doc;
        try { doc = JsonDocument.Parse(body); }
        catch { return new LyricParseFailure("invalid-json"); }
        using (doc) {
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object ||
                !root.TryGetProperty("phrases", out var phrasesEl) ||
                phrasesEl.ValueKind != JsonValueKind.Array) {
                return new LyricParseFailure("missing-phrases");
            }

            var expectedSyllables = ExtractExpectedSyllables(musicStructure);
            int phraseCount = phrasesEl.GetArrayLength();
            if (expectedSyllables != null && phraseCount != expectedSyllables.Count) {
                return new LyricParseFailure(
                    "phrase-count-mismatch",
                    Expected: expectedSyllables.Count,
                    Actual: phraseCount);
            }

            for (int i = 0; i < phraseCount; i++) {
                var p = phrasesEl[i];
                int actual;
                if (p.ValueKind == JsonValueKind.Object && p.TryGetProperty("lyric", out var lyricEl)) {
                    if (lyricEl.ValueKind == JsonValueKind.Array) {
                        actual = lyricEl.GetArrayLength();
                    } else if (lyricEl.ValueKind == JsonValueKind.String) {
                        var s = lyricEl.GetString() ?? "";
                        actual = CountChars(s.Trim());
                    } else {
                        return new LyricParseFailure("phrase-shape", PhraseIndex: i + 1);
                    }
                } else {
                    return new LyricParseFailure("phrase-shape", PhraseIndex: i + 1);
                }
                if (expectedSyllables != null) {
                    int want = expectedSyllables[i];
                    if (actual != want) {
                        return new LyricParseFailure(
                            "syllable-mismatch",
                            PhraseIndex: i + 1,
                            Expected: want,
                            Actual: actual);
                    }
                }
            }
        }
        return null;
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

    private static int CountChars(string s) {
        if (string.IsNullOrEmpty(s)) return 0;
        return new StringInfo(s).LengthInTextElements;
    }

    private static string Truncate(string s, int max) {
        if (string.IsNullOrEmpty(s)) return "";
        return s.Length <= max ? s : s.Substring(0, max) + "...";
    }
}
