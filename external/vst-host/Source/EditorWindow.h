// 插件编辑器宿主窗口。每个加载的插件实例配一个独立的顶层 DocumentWindow——
// 用户给的方向就是"独立窗口、不嵌入 webview"。窗口关闭按钮触发回调，
// 上层把它转成 stdio "editor_closed" 事件，但不卸载实例

#pragma once

#include <functional>
#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_gui_basics/juce_gui_basics.h>

namespace webutau::vst {

class EditorWindow final : public juce::DocumentWindow {
public:
    EditorWindow(const juce::String& title,
                 juce::AudioPluginInstance& processor,
                 std::function<void()> onClosed);
    ~EditorWindow() override;

    void closeButtonPressed() override;

private:
    juce::AudioProcessorEditor* editor_ = nullptr;
    std::function<void()> onClosed_;
};

} // namespace webutau::vst
