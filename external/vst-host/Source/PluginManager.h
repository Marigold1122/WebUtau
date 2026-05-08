// 插件实例管理：load / unload / param / state / process_offline。
// 所有方法假定在 JUCE message thread 调用。
//
// 实例 handle = "vst-<incrementing>" 字符串；前端持有 handle，host 通过 map 找回 instance

#pragma once

#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_core/juce_core.h>
#include <memory>
#include <unordered_map>

namespace webutau::vst {

class EditorWindow;

struct PluginInstance {
    juce::String handle;
    std::unique_ptr<juce::AudioPluginInstance> processor;
    std::unique_ptr<EditorWindow> editor;
    juce::String pluginPath;
    juce::String pluginUid;
    int sampleRate = 44100;
    int blockSize = 256;
    int channels = 2;
};

class PluginManager final {
public:
    PluginManager();
    ~PluginManager();

    // 列出已知插件（v1：仅扫描标准 VST3 目录）
    juce::var listPlugins() const;

    // scan_dirs 命令；当前实现：返回内置默认目录的扫描结果
    juce::var scanDirs(const juce::var& payload);

    // 加载插件，返回包含 handle / 通道数 / 参数列表的 var
    juce::var loadPlugin(const juce::var& payload);

    // 卸载（关闭编辑器、停止处理、删除实例）
    juce::var unloadPlugin(const juce::var& payload);

    // 编辑器窗口
    juce::var showEditor(const juce::var& payload);
    juce::var hideEditor(const juce::var& payload);

    // 参数
    juce::var setParam(const juce::var& payload);
    juce::var getParam(const juce::var& payload) const;

    // 状态 chunk
    juce::var getState(const juce::var& payload);
    juce::var setState(const juce::var& payload);

    // 离线处理：接收 base64 PCM，返回 base64 PCM
    juce::var processOffline(const juce::var& payload);

private:
    PluginInstance* findInstance(const juce::String& handle) const;
    juce::String allocateHandle();

    juce::AudioPluginFormatManager formatManager_;
    juce::KnownPluginList knownPluginList_;
    std::unordered_map<juce::String, std::unique_ptr<PluginInstance>> instances_;
    int handleCounter_ = 0;
};

} // namespace webutau::vst
