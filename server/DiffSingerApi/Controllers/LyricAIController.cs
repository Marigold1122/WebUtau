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
        // 透传给 LyricAIService——服务里走"自校验 + 错位反馈重试"时要按 syllableCount
        // 比对 LLM 输出，并在重试时把具体错位写进纠错提示
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

    // parseFailure：服务端"自校验 + 重试"用尽后仍不合规时的结构化原因——
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
            Messages: req.Messages.Select(m => new LyricAIService.ChatMessage(m.Role ?? "user", m.Content ?? "")).ToList(),
            MusicStructure: req.MusicStructure);

        // 服务内部会做最多 3 次"自校验 + 错位反馈重试"——如果 LLM 第一轮数错字了，
        // 把具体错位喂回去让它修。这里返回时只剩两种：成功，或重试用尽仍不合规
        var result = await _service.GenerateAsync(serviceReq, ct);

        // 上游错误（401 / 超时 / 网络）——retries 之后没拿到合规歌词，退还配额
        if (!result.Ok && result.ParseFailure == null) {
            var refunded = _limiter.Refund(ip, _options.DailyLimitPerIp);
            int status = result.UpstreamStatus == 401 ? 401 : 500;
            return StatusCode(status, new GenerateLyricResponse {
                Quota = ToDto(refunded),
                Message = result.ErrorMessage,
            });
        }

        // 重试用尽仍不合规——退还配额，告诉前端结构化的失败原因（用最后一次的错位）
        if (!result.Ok && result.ParseFailure != null) {
            var refunded = _limiter.Refund(ip, _options.DailyLimitPerIp);
            return StatusCode(422, new GenerateLyricResponse {
                Quota = ToDto(refunded),
                ParseFailure = ToDto(result.ParseFailure),
                Content = result.Content, // 保留原始内容方便排查；前端会忽略它走 ParseFailure 路径
                Message = result.ErrorMessage ?? "AI 多次尝试都未能匹配音节数，建议换主题或换 Pro 模型重试",
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

    private static ParseFailureDto ToDto(LyricAIService.LyricParseFailure failure)
        => new ParseFailureDto {
            Reason = failure.Reason,
            PhraseIndex = failure.PhraseIndex,
            Expected = failure.Expected,
            Actual = failure.Actual,
        };

    private string ResolveClientIp() {
        // 反向代理（Nginx / Cloudflare）会把真实客户端 IP 放 X-Forwarded-For
        var fwd = Request.Headers["X-Forwarded-For"].FirstOrDefault();
        if (!string.IsNullOrWhiteSpace(fwd)) {
            // X-Forwarded-For 格式 "client, proxy1, proxy2"——取最左
            return fwd.Split(',')[0].Trim();
        }
        return HttpContext.Connection.RemoteIpAddress?.ToString() ?? "unknown";
    }
}
