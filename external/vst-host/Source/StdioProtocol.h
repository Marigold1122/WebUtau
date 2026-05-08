// Stdio 控制面：行 JSON 协议。
// 后台读线程把 stdin 的每一行 parse 成 var，post 到 JUCE message thread 上派发；
// 写直接走 std::cout（同步 fflush 保证 Tauri 主进程能逐行收）

#pragma once

#include <atomic>
#include <functional>
#include <juce_core/juce_core.h>
#include <juce_events/juce_events.h>
#include <memory>
#include <thread>

namespace webutau::vst {

class StdioProtocol final {
public:
    using RequestHandler = std::function<juce::var(const juce::String& cmd, const juce::var& payload)>;

    explicit StdioProtocol(RequestHandler handler);
    ~StdioProtocol();

    StdioProtocol(const StdioProtocol&) = delete;
    StdioProtocol& operator=(const StdioProtocol&) = delete;

    // 启动后台 stdin 读循环（创建 std::thread）；可重复调用安全
    void start();

    // 阻塞直到 stdin 关闭（便于 main 等待 host 退出）
    void joinReader();

    // 发送 ready 事件（首条输出），写完即 flush
    void emitReady(int wsPort);

    // 任意事件（非请求响应）
    void emitEvent(const juce::String& eventName, const juce::var& payload);

    // 请求响应：根据原 id 写 ok/error 行
    void emitOk(int64_t id, const juce::var& data);
    void emitError(int64_t id, const juce::String& message);

private:
    void readerLoop();
    void writeLine(const juce::var& payload);
    void dispatchOnMessageThread(const juce::String& line);

    RequestHandler handler_;
    std::thread reader_;
    std::atomic<bool> stop_{false};
    juce::CriticalSection writeMutex_;
};

} // namespace webutau::vst
