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
        public object? MusicStructure { get; set; } // 透传日志用，服务端不用解析
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

    public sealed class GenerateLyricResponse {
        public string? Content { get; set; }
        public QuotaDto? Quota { get; set; }
        public string? Message { get; set; }
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
        var quotaDto = new QuotaDto { Used = snap.Used, Remaining = snap.Remaining, Limit = snap.Limit };
        if (!allowed) {
            return StatusCode(429, new GenerateLyricResponse {
                Quota = quotaDto,
                Message = $"今日额度已用完（{snap.Used}/{snap.Limit}），可填写自己的 API key 不限次数",
            });
        }

        var serviceReq = new LyricAIService.GenerateRequest(
            Messages: req.Messages.Select(m => new LyricAIService.ChatMessage(m.Role ?? "user", m.Content ?? "")).ToList());

        var result = await _service.GenerateAsync(serviceReq, ct);
        if (!result.Ok) {
            int status = result.UpstreamStatus == 401 ? 401 : 500;
            return StatusCode(status, new GenerateLyricResponse {
                Quota = quotaDto,
                Message = result.ErrorMessage,
            });
        }

        return Ok(new GenerateLyricResponse {
            Content = result.Content,
            Quota = quotaDto,
        });
    }

    [HttpGet("lyric/quota")]
    public IActionResult Quota() {
        var ip = ResolveClientIp();
        var snap = _limiter.Peek(ip, _options.DailyLimitPerIp);
        return Ok(new QuotaDto { Used = snap.Used, Remaining = snap.Remaining, Limit = snap.Limit });
    }

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
