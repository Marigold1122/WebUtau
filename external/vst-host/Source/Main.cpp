// VST 宿主子进程入口。
//
// 行为：
//   1. 启动 JUCE message manager（main thread 即 message thread）
//   2. 创建 StdioProtocol，注册请求 dispatcher，输出 ready 事件（wsPort=0 表示 v1
//      尚未实现实时 WS 数据面，前端会优雅降级到 dry through）
//   3. 主线程 runDispatchLoopUntil 阻塞，等 stdin 关闭信号触发退出
//
// 退出路径：
//   - stdin EOF（父进程关闭管道）→ stdio 读线程 break → main 通过原子标志感知 → 退出 loop
//   - stderr 用于 host 自身日志，不参与协议

#include "PluginManager.h"
#include "StdioProtocol.h"

#include <atomic>
#include <iostream>
#include <juce_core/juce_core.h>
#include <juce_events/juce_events.h>
#include <juce_gui_basics/juce_gui_basics.h>

namespace {

std::atomic<bool> shutdownRequested{false};

class HostApplication final : public juce::JUCEApplicationBase {
public:
    HostApplication() = default;

    const juce::String getApplicationName() override { return "webutau_vst_host"; }
    const juce::String getApplicationVersion() override { return "0.1.0"; }
    bool moreThanOneInstanceAllowed() override { return true; }

    void initialise(const juce::String&) override {
        manager_ = std::make_unique<webutau::vst::PluginManager>();
        protocol_ = std::make_unique<webutau::vst::StdioProtocol>(
            [this](const juce::String& cmd, const juce::var& payload) -> juce::var {
                return dispatch(cmd, payload);
            });
        protocol_->start();
        // wsPort = 0 表示实时数据面在该版本不可用；前端 vst_get_ws_endpoint 会拒绝
        protocol_->emitReady(0);

        // 后台线程监听 stdin EOF：StdioProtocol 的 reader 退出时通过 shutdownRequested 通知 message loop
        watchdog_ = std::thread([this] {
            protocol_->joinReader();
            shutdownRequested.store(true);
            juce::MessageManager::callAsync([] { juce::JUCEApplicationBase::quit(); });
        });
    }

    void shutdown() override {
        if (watchdog_.joinable()) watchdog_.join();
        protocol_.reset();
        manager_.reset();
    }

    void anotherInstanceStarted(const juce::String&) override {}
    void systemRequestedQuit() override { quit(); }
    void suspended() override {}
    void resumed() override {}
    void unhandledException(const std::exception*, const juce::String&, int) override {}

private:
    juce::var dispatch(const juce::String& cmd, const juce::var& payload) {
        if (cmd == "list_plugins")    return manager_->listPlugins();
        if (cmd == "scan_dirs")       return manager_->scanDirs(payload);
        if (cmd == "load")            return manager_->loadPlugin(payload);
        if (cmd == "unload")          return manager_->unloadPlugin(payload);
        if (cmd == "show_editor")     return manager_->showEditor(payload);
        if (cmd == "hide_editor")     return manager_->hideEditor(payload);
        if (cmd == "set_param")       return manager_->setParam(payload);
        if (cmd == "get_param")       return manager_->getParam(payload);
        if (cmd == "get_state")       return manager_->getState(payload);
        if (cmd == "set_state")       return manager_->setState(payload);
        if (cmd == "process_offline") return manager_->processOffline(payload);
        throw std::runtime_error(("unknown command: " + cmd).toStdString());
    }

    std::unique_ptr<webutau::vst::PluginManager> manager_;
    std::unique_ptr<webutau::vst::StdioProtocol> protocol_;
    std::thread watchdog_;
};

} // namespace

START_JUCE_APPLICATION(HostApplication)
