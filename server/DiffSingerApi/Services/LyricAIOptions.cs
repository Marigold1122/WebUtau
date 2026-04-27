namespace DiffSingerApi.Services;

// AI 写词的服务端配置——通过 appsettings.json / 环境变量注入。
//
// 三家厂商（DeepSeek / 通义 / GLM）都支持 OpenAI 兼容协议，只是 baseUrl + model 不同。
// 用户没传自己 key 时走这一份，按 IP 限速；传了就跳过这套配置直接转发用户 key。
//
// appsettings.json 里挂在 "LyricAI" 节点：
//   "LyricAI": {
//     "Provider": "deepseek",          // 仅作日志标签
//     "BaseUrl": "https://api.deepseek.com/v1",
//     "Model": "deepseek-chat",
//     "ApiKey": "<我们的 key>",
//     "DailyLimitPerIp": 5,
//     "TimeoutSeconds": 30,
//     "Temperature": 0.85
//   }
public sealed class LyricAIOptions {
    public const string SectionName = "LyricAI";

    public string Provider { get; set; } = "deepseek";
    public string BaseUrl { get; set; } = "";
    public string Model { get; set; } = "";
    public string ApiKey { get; set; } = "";
    public int DailyLimitPerIp { get; set; } = 5;
    public int TimeoutSeconds { get; set; } = 30;
    public double Temperature { get; set; } = 0.85;
}
