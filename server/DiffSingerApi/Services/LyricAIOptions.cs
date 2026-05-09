namespace DiffSingerApi.Services;

// AI 写词的服务端配置——通过 appsettings.json / 环境变量注入。
//
// 三家厂商（DeepSeek / 通义 / GLM）都支持 OpenAI 兼容协议，只是 baseUrl + model 不同。
// 用户没传自己 key 时走这一份，按 IP 限速；传了就跳过这套配置直接转发用户 key。
//
// 模型选择（DeepSeek）：
//   - "deepseek-reasoner"  ← 推荐：v4-flash 思考模式，~20s 单发，5% 失败率
//                           思考过程会"先数一遍字"再输出，对中文音节计数最稳
//   - "deepseek-v4-pro"    思考增强，~40s 单发，2% 失败率，单价是 flash 10x
//   - "deepseek-chat"      v4-flash 非思考，~5s 但 30% 失败率——靠重试兜
//                           快但不稳，适合预算敏感场景；不推荐生产环境用
//
// 默认 TimeoutSeconds = 240s（4 分钟）——思考模式 + 长歌词（30+ 行）时
// 模型内部"先思考再输出"可消耗 60-180s。短歌词不会跑满；长歌词不会被砍。
// 非思考模式（deepseek-chat）通常 < 30s 就回完，这个上限完全够用
//
// appsettings.json 里挂在 "LyricAI" 节点：
//   "LyricAI": {
//     "Provider": "deepseek",
//     "BaseUrl": "https://api.deepseek.com",
//     "Model": "deepseek-reasoner",
//     "ApiKey": "<我们的 key>",
//     "DailyLimitPerIp": 5,
//     "TimeoutSeconds": 240,
//     "Temperature": 0.85
//   }
public sealed class LyricAIOptions {
    public const string SectionName = "LyricAI";

    public string Provider { get; set; } = "deepseek";
    public string BaseUrl { get; set; } = "";
    public string Model { get; set; } = "";
    public string ApiKey { get; set; } = "";
    public int DailyLimitPerIp { get; set; } = 5;
    public int TimeoutSeconds { get; set; } = 240;
    public double Temperature { get; set; } = 0.85;
}
