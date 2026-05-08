#include "StdioProtocol.h"

#include <cstdio>
#include <iostream>

namespace webutau::vst {

namespace {

// 把 juce::var 序列化为单行 JSON（不带换行）。
// 用 juce::JSON::toString(value, allOnOneLine) — 新 API；老版的 var::writeAsJSON 在 JUCE 7+ 已被移除
juce::String toJsonLine(const juce::var& payload) {
    return juce::JSON::toString(payload, true);
}

} // namespace

StdioProtocol::StdioProtocol(RequestHandler handler)
    : handler_(std::move(handler)) {}

StdioProtocol::~StdioProtocol() {
    stop_.store(true);
    if (reader_.joinable()) {
        // stdin 关闭后线程会自然退出；这里不强制 detach
        reader_.join();
    }
}

void StdioProtocol::start() {
    if (reader_.joinable()) return;
    reader_ = std::thread([this] { readerLoop(); });
}

void StdioProtocol::joinReader() {
    if (reader_.joinable()) reader_.join();
}

void StdioProtocol::readerLoop() {
    std::string line;
    while (!stop_.load() && std::getline(std::cin, line)) {
        if (line.empty()) continue;
        juce::String hostLine(line);
        // 切到 message thread 派发——JUCE plugin host 的所有 API 都要求在 message thread
        juce::MessageManager::callAsync([this, hostLine] {
            dispatchOnMessageThread(hostLine);
        });
    }
}

void StdioProtocol::dispatchOnMessageThread(const juce::String& line) {
    juce::var parsed;
    auto result = juce::JSON::parse(line, parsed);
    if (result.failed() || !parsed.isObject()) {
        return;
    }
    const auto* obj = parsed.getDynamicObject();
    if (obj == nullptr) return;

    const auto cmd = parsed.getProperty("cmd", juce::var()).toString();
    const auto idVar = parsed.getProperty("id", juce::var());
    const int64_t id = idVar.isInt64() ? static_cast<int64_t>(idVar) : (int64_t) static_cast<int>(idVar);

    if (cmd.isEmpty()) {
        emitError(id, "missing cmd");
        return;
    }
    try {
        const auto data = handler_(cmd, parsed);
        emitOk(id, data);
    } catch (const std::exception& e) {
        emitError(id, juce::String(e.what()));
    } catch (...) {
        emitError(id, "host caught unknown exception");
    }
}

void StdioProtocol::writeLine(const juce::var& payload) {
    const juce::ScopedLock lock(writeMutex_);
    const auto line = toJsonLine(payload);
    std::cout << line.toRawUTF8() << '\n';
    std::cout.flush();
}

void StdioProtocol::emitReady(int wsPort) {
    auto* obj = new juce::DynamicObject();
    obj->setProperty("event", "ready");
    obj->setProperty("wsPort", wsPort);
    obj->setProperty("protocol", "webutau-vst-host/1");
    writeLine(juce::var(obj));
}

void StdioProtocol::emitEvent(const juce::String& eventName, const juce::var& payload) {
    auto* obj = new juce::DynamicObject();
    obj->setProperty("event", eventName);
    if (payload.isObject()) {
        if (auto* src = payload.getDynamicObject()) {
            for (const auto& kv : src->getProperties()) {
                obj->setProperty(kv.name, kv.value);
            }
        }
    }
    writeLine(juce::var(obj));
}

void StdioProtocol::emitOk(int64_t id, const juce::var& data) {
    auto* obj = new juce::DynamicObject();
    obj->setProperty("id", static_cast<int64_t>(id));
    obj->setProperty("ok", true);
    obj->setProperty("data", data);
    writeLine(juce::var(obj));
}

void StdioProtocol::emitError(int64_t id, const juce::String& message) {
    auto* obj = new juce::DynamicObject();
    obj->setProperty("id", static_cast<int64_t>(id));
    obj->setProperty("ok", false);
    obj->setProperty("error", message);
    writeLine(juce::var(obj));
}

} // namespace webutau::vst
