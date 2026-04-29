using System.Text.Json;
using DiffSingerApi.Services;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Options;

namespace DiffSingerApi.Controllers;

[ApiController]
[Route("api/ai")]
public class LyricAIController : ControllerBase {
    private readonly LyricAIService _service;
    private readonly LyricAIRateLimiter _limiter;
    private readonly LyricAIOptions _options;

    public LyricAIController(
        LyricAIService service,
        LyricAIRateLimiter limiter,
        IOptions<LyricAIOptions> options) {
        _service = service;
        _limiter = limiter;
        _options = options.Value;
    }

    public sealed class GenerateLyricRequest {
        public List<MessageDto> Messages { get; set; } = new();
        // 透传——服务端只读 phrases[].syllableCount 用来核对 LLM 响应是否合规
        public JsonElement? MusicStructure { get; set; }
        // 注意：本接口"故意"不接收用户自带 API key——
        // 用户填了自己 key 时，前端会绕过本后端、浏览器直连 LLM 厂商。
        // 这里彻底不暴露相关字段，从源头杜绝任何"无意泄露"路径
    }

    public sealed class MessageDto {
        public string Role { get; set; } = "";
        public string Content { get; set; } = "";
    }

    public sealed class QuotaDto {
        public int Used { get; set; }
        public int Remaining { get; set; }
        public int Limit { get; set; }
    }

    // parseFailure：服务端预校验 LLM 响应失败时的结构化原因——
    // 字段名跟前端 parseLyricResponse 输出对齐，前端 _formatAIError 直接复用 i18n key
    public sealed class ParseFailureDto {
        public string Reason { get; set; } = "";
        public int? PhraseIndex { get; set; }
        public int? Expected { get; set; }
        public int? Actual { get; set; }
    }

    public sealed class GenerateLyricResponse {
        public string? Content { get; set; }
        public QuotaDto? Quota { get; set; }
        public string? Message { get; set; }
        public ParseFailureDto? ParseFailure { get; set; }
    }

    [HttpPost("lyric")]
    public async Task<IActionResult> Lyric([FromBody] GenerateLyricRequest req, CancellationToken ct) {
        if (req == null || req.Messages == null || req.Messages.Count == 0) {
            return BadRequest(new GenerateLyricResponse { Message = "messages 不能为空" });
        }

        // 这一路只走平台 key + 按 IP 限速。用户自带 key 的请求由前端直连 LLM 厂商，
        // 根本不会到这里——所以不需要也不能区分"是否用户 key"
        var ip = ResolveClientIp();
        var (allowed, snap) = _limiter.TryConsume(ip, _options.DailyLimitPerIp);
        if (!allowed) {
            var quotaDto = ToDto(snap);
            return StatusCode(429, new GenerateLyricResponse {
                Quota = quotaDto,
                Message = $"今日额度已用完（{snap.Used}/{snap.Limit}），可填写自己的 API key 不限次数",
            });
        }

        var serviceReq = new LyricAIService.GenerateRequest(
            Messages: req.Messages.Select(m => new LyricAIService.ChatMessage(m.Role ?? "user", m.Content ?? "")).ToList());

        var result = await _service.GenerateAsync(serviceReq, ct);

        // 上游失败：没产出歌词 → 退还本次配额
        if (!result.Ok) {
            var refunded = _limiter.Refund(ip, _options.DailyLimitPerIp);
            int status = result.UpstreamStatus == 401 ? 401 : 500;
            return StatusCode(status, new GenerateLyricResponse {
                Quota = ToDto(refunded),
                Message = result.ErrorMessage,
            });
        }

        // 上游成功了，但响应可能跟音乐结构对不上（句数错 / 音节数错 / JSON 不合法）。
        // 这种情况用户也拿不到可用歌词，同样退还配额。校验逻辑要跟前端
        // parseLyricResponse 一致——不然两端结论分歧会出现"前端报错但配额已扣"的死角
        var parseFailure = ValidateLyricResponse(result.Content, req.MusicStructure);
        if (parseFailure != null) {
            var refunded = _limiter.Refund(ip, _options.DailyLimitPerIp);
            return StatusCode(422, new GenerateLyricResponse {
                Quota = ToDto(refunded),
                ParseFailure = parseFailure,
                Content = result.Content, // 保留原始内容方便排查；前端会忽略它走 ParseFailure 路径
                Message = "AI 返回的歌词与音乐结构不匹配，本次未消耗免费额度",
            });
        }

        return Ok(new GenerateLyricResponse {
            Content = result.Content,
            Quota = ToDto(snap),
        });
    }

    [HttpGet("lyric/quota")]
    public IActionResult Quota() {
        var ip = ResolveClientIp();
        var snap = _limiter.Peek(ip, _options.DailyLimitPerIp);
        return Ok(ToDto(snap));
    }

    private static QuotaDto ToDto(LyricAIRateLimiter.QuotaSnapshot snap)
        => new QuotaDto { Used = snap.Used, Remaining = snap.Remaining, Limit = snap.Limit };

    private string ResolveClientIp() {
        // 反向代理（Nginx / Cloudflare）会把真实客户端 IP 放 X-Forwarded-For
        var fwd = Request.Headers["X-Forwarded-For"].FirstOrDefault();
        if (!string.IsNullOrWhiteSpace(fwd)) {
            // X-Forwarded-For 格式 "client, proxy1, proxy2"——取最左
            return fwd.Split(',')[0].Trim();
        }
        return HttpContext.Connection.RemoteIpAddress?.ToString() ?? "unknown";
    }

    // 服务端预校验：解析 LLM 返回的 JSON，核对 phrases 数量与每句音节数是否与
    // musicStructure 匹配。返回 null 表示通过；返回非 null 表示该退还配额。
    // 容忍 LLM 偶尔包 markdown 代码块，以及 lyric 写成字符串而非数组的情况
    private static ParseFailureDto? ValidateLyricResponse(string? rawText, JsonElement? musicStructure) {
        if (string.IsNullOrWhiteSpace(rawText)) {
            return new ParseFailureDto { Reason = "empty-response" };
        }
        var body = rawText.Trim();
        if (body.StartsWith("```")) {
            // 去掉 ``` / ```json 包裹
            int firstNewline = body.IndexOf('\n');
            if (firstNewline > 0) body = body.Substring(firstNewline + 1);
            if (body.EndsWith("```")) body = body.Substring(0, body.Length - 3);
            body = body.Trim();
        }

        JsonDocument? doc;
        try { doc = JsonDocument.Parse(body); }
        catch { return new ParseFailureDto { Reason = "invalid-json" }; }
        using (doc) {
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object ||
                !root.TryGetProperty("phrases", out var phrasesEl) ||
                phrasesEl.ValueKind != JsonValueKind.Array) {
                return new ParseFailureDto { Reason = "missing-phrases" };
            }

            // 抽 musicStructure.phrases[i].syllableCount——服务端只关心句数和每句字数
            var expectedSyllables = ExtractExpectedSyllables(musicStructure);
            int phraseCount = phrasesEl.GetArrayLength();
            if (expectedSyllables != null && phraseCount != expectedSyllables.Count) {
                return new ParseFailureDto {
                    Reason = "phrase-count-mismatch",
                    Expected = expectedSyllables.Count,
                    Actual = phraseCount,
                };
            }

            for (int i = 0; i < phraseCount; i++) {
                var p = phrasesEl[i];
                int actual;
                if (p.ValueKind == JsonValueKind.Object && p.TryGetProperty("lyric", out var lyricEl)) {
                    if (lyricEl.ValueKind == JsonValueKind.Array) {
                        actual = lyricEl.GetArrayLength();
                    } else if (lyricEl.ValueKind == JsonValueKind.String) {
                        // 跟前端一致：字符串当成"逐字拆开"，数 Unicode 字素数
                        var s = lyricEl.GetString() ?? "";
                        actual = CountChars(s.Trim());
                    } else {
                        return new ParseFailureDto { Reason = "phrase-shape", PhraseIndex = i + 1 };
                    }
                } else {
                    return new ParseFailureDto { Reason = "phrase-shape", PhraseIndex = i + 1 };
                }
                if (expectedSyllables != null) {
                    int want = expectedSyllables[i];
                    if (actual != want) {
                        return new ParseFailureDto {
                            Reason = "syllable-mismatch",
                            PhraseIndex = i + 1,
                            Expected = want,
                            Actual = actual,
                        };
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
                // 形状不对 → 没法核对，返回 null 让外层只检查 JSON / phrases 结构
                return null;
            }
            list.Add(n);
        }
        return list;
    }

    private static int CountChars(string s) {
        if (string.IsNullOrEmpty(s)) return 0;
        // 用 StringInfo 数书写形单位，与前端 [...str] 的 code point 拆分行为基本一致
        return new System.Globalization.StringInfo(s).LengthInTextElements;
    }
}
