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
public sealed class LyricAIService {
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

    public sealed record GenerateRequest(IReadOnlyList<ChatMessage> Messages);

    public sealed record ChatMessage(string Role, string Content);

    public sealed record GenerateResult(bool Ok, string? Content, string? ErrorMessage, int? UpstreamStatus);

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

        // 拼成 OpenAI Chat Completions 格式
        var payload = new {
            model = model,
            messages = request.Messages.Select(m => new { role = m.Role, content = m.Content }),
            response_format = new { type = "json_object" },
            temperature = _options.Temperature,
            stream = false,
        };
        var requestBody = JsonSerializer.Serialize(payload);

        // baseUrl 可能给的是 ".../v1" 或 ".../v1/" 或带或不带 /chat/completions——统一拼一次
        var fullUrl = baseUrl.TrimEnd('/').EndsWith("/chat/completions")
            ? baseUrl
            : baseUrl.TrimEnd('/') + "/chat/completions";

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
                    false,
                    null,
                    $"LLM 服务返回 {(int)response.StatusCode}: {Truncate(bodyText, 200)}",
                    (int)response.StatusCode);
            }

            // OpenAI 格式：choices[0].message.content
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
