#include "EditorWindow.h"

namespace webutau::vst {

EditorWindow::EditorWindow(const juce::String& title,
                           juce::AudioPluginInstance& processor,
                           std::function<void()> onClosed)
    : juce::DocumentWindow(title,
                           juce::Desktop::getInstance().getDefaultLookAndFeel()
                               .findColour(juce::ResizableWindow::backgroundColourId),
                           juce::DocumentWindow::allButtons),
      onClosed_(std::move(onClosed)) {
    setUsingNativeTitleBar(true);
    setResizable(true, false);
    if (processor.hasEditor()) {
        editor_ = processor.createEditorIfNeeded();
    }
    if (editor_ != nullptr) {
        setContentNonOwned(editor_, true);
    } else {
        setSize(420, 240);
    }
    centreWithSize(getWidth(), getHeight());
    // 让插件编辑器始终浮在主应用之上——Reaper / Logic / Bitwig 标准行为。
    // 否则 host 是 console_app，没有 macOS activation policy，
    // 它的 NSWindow 会被前台 app 的窗口盖住
    setAlwaysOnTop(true);
    setVisible(true);
    toFront(true);
}

EditorWindow::~EditorWindow() {
    setContentNonOwned(nullptr, false);
    editor_ = nullptr;
}

void EditorWindow::closeButtonPressed() {
    setVisible(false);
    if (onClosed_) onClosed_();
}

} // namespace webutau::vst
