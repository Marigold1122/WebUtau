using System.Collections.Concurrent;

namespace DiffSingerApi.Services;

// 按客户端 IP 限速：每个 IP 每天最多 N 次（默认 5）。
// 内存版——重启服务计数清零，对单节点部署够用。
// 真要持久 / 分布式以后换 Redis。
//
// 跨日重置：以 UTC+8 (Asia/Shanghai) 算"自然日"——避免凌晨 0 点跨年时不同 IP
// 偏差导致部分用户多/少一次额度；对国内用户最直观
public sealed class LyricAIRateLimiter {
    // 每个 IP 一份记录：{ 日期标签, 该日已用次数 }
    private record Counter(string DayKey, int Used);
    private readonly ConcurrentDictionary<string, Counter> _counters = new();

    private static readonly TimeZoneInfo BeijingTz = ResolveBeijingTimeZone();

    private static TimeZoneInfo ResolveBeijingTimeZone() {
        // Linux / macOS 用 IANA 名；Windows 用旧 Windows 名。两端都试一下兜底用 UTC+8
        try { return TimeZoneInfo.FindSystemTimeZoneById("Asia/Shanghai"); } catch { }
        try { return TimeZoneInfo.FindSystemTimeZoneById("China Standard Time"); } catch { }
        return TimeZoneInfo.CreateCustomTimeZone("UTC+8", TimeSpan.FromHours(8), "UTC+8", "UTC+8");
    }

    private static string TodayKey() {
        var local = TimeZoneInfo.ConvertTime(DateTimeOffset.UtcNow, BeijingTz);
        return local.ToString("yyyy-MM-dd");
    }

    public sealed record QuotaSnapshot(int Used, int Remaining, int Limit);

    // 试图扣减一次配额。返回 (allowed, snapshot)。
    // - allowed=false 时 snapshot 反映扣减失败时的状态（即"已经用满"）
    // - allowed=true 时 snapshot 反映已扣减后的剩余值
    public (bool allowed, QuotaSnapshot snapshot) TryConsume(string ip, int dailyLimit) {
        if (dailyLimit <= 0) {
            // 配置成 0 / 负数视为禁用——配置者自己承担后果
            return (false, new QuotaSnapshot(0, 0, dailyLimit));
        }
        var key = ip ?? "unknown";
        var today = TodayKey();
        bool allowed = false;
        int finalUsed = 0;
        _counters.AddOrUpdate(
            key,
            // 这个 IP 还没被记过 → 新建一条 used=1，allowed
            _ => {
                allowed = true;
                finalUsed = 1;
                return new Counter(today, 1);
            },
            // 已有记录 → 看是否同一天 + 是否到上限
            (_, existing) => {
                if (existing.DayKey != today) {
                    // 跨日重置
                    allowed = true;
                    finalUsed = 1;
                    return new Counter(today, 1);
                }
                if (existing.Used >= dailyLimit) {
                    // 已满
                    allowed = false;
                    finalUsed = existing.Used;
                    return existing; // 不动
                }
                // 还有额度
                allowed = true;
                finalUsed = existing.Used + 1;
                return new Counter(today, finalUsed);
            });
        var remaining = Math.Max(0, dailyLimit - finalUsed);
        return (allowed, new QuotaSnapshot(finalUsed, remaining, dailyLimit));
    }

    public QuotaSnapshot Peek(string ip, int dailyLimit) {
        var key = ip ?? "unknown";
        var today = TodayKey();
        if (!_counters.TryGetValue(key, out var existing) || existing.DayKey != today) {
            return new QuotaSnapshot(0, dailyLimit, dailyLimit);
        }
        var used = Math.Max(0, existing.Used);
        return new QuotaSnapshot(used, Math.Max(0, dailyLimit - used), dailyLimit);
    }

    // 退还一次配额——用于 AI 请求最终没产出可用歌词的情况（上游失败 / 响应不合规）。
    // 只对当天计数生效；跨日记录会被忽略（新一天本来就重置了）。
    // 用 AddOrUpdate 保持与 TryConsume 同样的原子性，防并发抖动
    public QuotaSnapshot Refund(string ip, int dailyLimit) {
        var key = ip ?? "unknown";
        var today = TodayKey();
        int finalUsed = 0;
        _counters.AddOrUpdate(
            key,
            // 没记录 → 不需要退（视作已经是 0）
            _ => new Counter(today, 0),
            (_, existing) => {
                if (existing.DayKey != today) {
                    // 跨日：旧计数已无意义，给当天补一条 0
                    finalUsed = 0;
                    return new Counter(today, 0);
                }
                finalUsed = Math.Max(0, existing.Used - 1);
                return new Counter(today, finalUsed);
            });
        var remaining = Math.Max(0, dailyLimit - finalUsed);
        return new QuotaSnapshot(finalUsed, remaining, dailyLimit);
    }
}
