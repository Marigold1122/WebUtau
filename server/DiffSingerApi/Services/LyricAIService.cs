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
// 重试只消耗平台 LLM 调用费，**不增加用户配额扣减**（一次 HTTP 请求恒等于一次配额）。
//
// 重试模式分两档：
//   - syllable-mismatch + 错位 ≤ PartialRetryThreshold (5) → **局部修订**模式：
//     让 LLM 只输出错位的几句，后端把它合并回上一轮的对句。token 成本 / 时间 / 失误率
//     都低很多，长歌词尤其有效（35 句错 1 句不用整篇重写）
//   - 其它（invalid-json / missing-phrases / 错位太多）→ **完整重投**模式：
//     传统做法，把上轮错答附在 conversation 后面让 LLM 完整重写
//
// MaxAttempts = 3 的取舍：
// - deepseek-chat（非思考，~5s/轮，单次 30% 失败）：3 次封顶 ~15s，从 30% 压到 ~3%
// - deepseek-reasoner（思考，~20s/轮，单次 5% 失败）：3 次封顶 ~60s，从 5% 压到 ~0.01%
// - 给用户 timeout 上限是 240s，3 次封顶完全在预算内
public sealed class LyricAIService {
    private const int MaxAttempts = 3;
    // 错位 ≤ 5 句走局部修订；超过这个数大概率是 LLM 整体跑偏（音乐结构没看懂或主题没把握），
    // 完整重投反而更可能在剩下次数内修好
    private const int PartialRetryThreshold = 5;

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
        // 上一轮解析出来的"完整 phrases"（含错句）。局部修订成功后用它做合并基底
        List<LyricResponseValidator.ParsedPhraseData>? accumulatedPhrases = null;
        // 标记当前轮 LLM 是否被指示走"只输出错位句"模式（影响这一轮响应的解析方式）
        bool currentRoundIsPartial = false;

        for (int attempt = 1; attempt <= MaxAttempts; attempt++) {
            var llmResult = await CallLLMOnceAsync(apiKey, fullUrl, model, conversation, ct);
            if (!llmResult.Ok) {
                // 上游错误（401 / 超时 / 网络）重试无意义，直接抛回
                return llmResult with { Attempts = attempt };
            }

            var content = llmResult.Content ?? "";
            // 第 2/3 轮如果上一轮指示了"局部修订"，把这一轮的局部响应合并回 accumulatedPhrases。
            // 校验和返回的 Content 都基于合并后的完整版
            string contentForValidation = content;
            if (currentRoundIsPartial && accumulatedPhrases != null) {
                var partialPhrases = LyricResponseValidator.ParsePhrasesShallow(content);
                if (partialPhrases != null && partialPhrases.Count > 0) {
                    accumulatedPhrases = LyricResponseValidator.MergePartialIntoAccumulated(accumulatedPhrases, partialPhrases);
                    contentForValidation = LyricResponseValidator.SerializePhrasesToJson(accumulatedPhrases);
                }
                // 局部响应解析不出 → 把 LLM 本轮的整体输出（很可能 LLM 又给了完整 JSON）拿去校验
            }

            var validation = LyricResponseValidator.ValidateLyricResponseFull(contentForValidation, request.MusicStructure);
            if (validation.FirstFailure == null) {
                if (attempt > 1) {
                    _logger.LogInformation(
                        "LyricAI succeeded on attempt {Attempt} (partial={Partial})",
                        attempt, currentRoundIsPartial);
                }
                // 返回校验过的完整 JSON（局部修订路径下是合并版；完整重投路径下是 LLM 本轮原文）
                return new GenerateResult(true, contentForValidation, null, null, Attempts: attempt);
            }

            lastFailure = validation.FirstFailure;
            lastContent = contentForValidation;
            // 把这一轮解析出来的 phrases 留作下一轮"局部修订"的合并基底
            if (validation.Phrases != null) {
                accumulatedPhrases = validation.Phrases;
            }

            _logger.LogInformation(
                "LyricAI attempt {Attempt}/{Max} failed validation: {Reason} (phrase={Phrase}, expected={Exp}, actual={Act}, totalErrors={Errors})",
                attempt, MaxAttempts, validation.FirstFailure.Reason,
                validation.FirstFailure.PhraseIndex, validation.FirstFailure.Expected, validation.FirstFailure.Actual,
                validation.AllFailures.Count);

            if (attempt < MaxAttempts) {
                // 判定下一轮策略：syllable-mismatch + 错位 ≤ 5 + 上一轮解析出 phrases → 局部修订
                bool nextIsPartial = validation.Phrases != null
                    && validation.AllFailures.Count > 0
                    && validation.AllFailures.Count <= PartialRetryThreshold
                    && validation.AllFailures.All(f => f.Reason == "syllable-mismatch");

                conversation.Add(new ChatMessage("assistant", content));
                if (nextIsPartial) {
                    conversation.Add(new ChatMessage("user",
                        LyricResponseValidator.BuildPartialRetryCorrectionPrompt(validation.Phrases!, validation.AllFailures)));
                    currentRoundIsPartial = true;
                } else {
                    conversation.Add(new ChatMessage("user",
                        LyricResponseValidator.BuildCorrectionPrompt(validation.FirstFailure)));
                    currentRoundIsPartial = false;
                    // 走完整重投：下一轮 LLM 输出的就是全文，重置 accumulatedPhrases 等下一轮重新填
                    accumulatedPhrases = null;
                }
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

    private static string Truncate(string s, int max) {
        if (string.IsNullOrEmpty(s)) return "";
        return s.Length <= max ? s : s.Substring(0, max) + "...";
    }
}
