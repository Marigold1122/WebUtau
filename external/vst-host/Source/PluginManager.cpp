#include "PluginManager.h"

#include "EditorWindow.h"

#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_core/juce_core.h>

namespace webutau::vst {

namespace {

juce::String requireString(const juce::var& payload, const char* key) {
    return payload.getProperty(key, juce::var()).toString();
}

int requireInt(const juce::var& payload, const char* key, int fallback) {
    auto v = payload.getProperty(key, juce::var());
    return v.isInt() || v.isInt64() || v.isDouble() ? static_cast<int>(v) : fallback;
}

juce::var paramListToVar(const juce::AudioPluginInstance& processor) {
    juce::Array<juce::var> arr;
    const auto& params = processor.getParameters();
    for (int i = 0; i < params.size(); ++i) {
        const auto* param = params[i];
        if (param == nullptr) continue;
        auto* obj = new juce::DynamicObject();
        obj->setProperty("index", i);
        obj->setProperty("name", param->getName(64));
        obj->setProperty("label", param->getLabel());
        obj->setProperty("value", static_cast<double>(param->getValue()));
        obj->setProperty("automatable", param->isAutomatable());
        arr.add(juce::var(obj));
    }
    return juce::var(arr);
}

juce::var loadResultVar(const PluginInstance& instance) {
    auto& processor = *instance.processor;
    auto* obj = new juce::DynamicObject();
    obj->setProperty("handle", instance.handle);
    obj->setProperty("displayName", processor.getName());
    obj->setProperty("pluginPath", instance.pluginPath);
    obj->setProperty("pluginUid", instance.pluginUid);
    obj->setProperty("hasEditor", processor.hasEditor());
    obj->setProperty("latencySamples", processor.getLatencySamples());

    auto* channels = new juce::DynamicObject();
    channels->setProperty("in", processor.getTotalNumInputChannels());
    channels->setProperty("out", processor.getTotalNumOutputChannels());
    obj->setProperty("channels", juce::var(channels));
    obj->setProperty("parameters", paramListToVar(processor));
    return juce::var(obj);
}

} // namespace

PluginManager::PluginManager() {
    formatManager_.addDefaultFormats();
}

PluginManager::~PluginManager() {
    // 关闭所有编辑器窗口，停止处理，再释放实例
    for (auto& kv : instances_) {
        if (kv.second->editor) kv.second->editor.reset();
        if (kv.second->processor) {
            kv.second->processor->releaseResources();
        }
    }
    instances_.clear();
}

PluginInstance* PluginManager::findInstance(const juce::String& handle) const {
    auto it = instances_.find(handle);
    return it == instances_.end() ? nullptr : it->second.get();
}

juce::String PluginManager::allocateHandle() {
    handleCounter_ += 1;
    return juce::String("vst-") + juce::String(handleCounter_);
}

juce::var PluginManager::listPlugins() const {
    juce::Array<juce::var> arr;
    for (int i = 0; i < knownPluginList_.getNumTypes(); ++i) {
        const auto& description = knownPluginList_.getTypes()[i];
        auto* obj = new juce::DynamicObject();
        obj->setProperty("name", description.name);
        obj->setProperty("manufacturer", description.manufacturerName);
        obj->setProperty("format", description.pluginFormatName);
        obj->setProperty("uid", description.createIdentifierString());
        obj->setProperty("path", description.fileOrIdentifier);
        obj->setProperty("isInstrument", description.isInstrument);
        arr.add(juce::var(obj));
    }
    return juce::var(arr);
}

juce::var PluginManager::scanDirs(const juce::var& payload) {
    auto* paths = payload.getProperty("paths", juce::var()).getArray();
    if (paths == nullptr) return listPlugins();
    const bool rescan = bool(payload.getProperty("rescan", juce::var(false)));
    if (rescan) knownPluginList_.clear();

    for (const auto& format : formatManager_.getFormats()) {
        if (format == nullptr) continue;
        for (const auto& pathVar : *paths) {
            juce::FileSearchPath search;
            search.add(juce::File(pathVar.toString()));
            juce::PluginDirectoryScanner scanner(knownPluginList_, *format, search,
                                                 /*recursive*/ true,
                                                 juce::File());
            juce::String name;
            while (scanner.scanNextFile(true, name)) {
                // 同步推进；v1 不做沙箱子进程，按用户要求快速跑通
            }
        }
    }
    return listPlugins();
}

juce::var PluginManager::loadPlugin(const juce::var& payload) {
    const auto pluginPath = requireString(payload, "pluginPath");
    const auto sampleRate = requireInt(payload, "sampleRate", 44100);
    const auto blockSize = requireInt(payload, "blockSize", 256);
    if (pluginPath.isEmpty()) {
        throw std::runtime_error("missing pluginPath");
    }

    juce::PluginDescription description;
    juce::String errorMessage;
    std::unique_ptr<juce::AudioPluginInstance> rawProcessor;

    // 优先：用 format 自身的 findAllTypesForFile 把 file 解析成完整 PluginDescription
    // （含 class UID 等 createPluginInstance 必须的字段）
    for (auto* format : formatManager_.getFormats()) {
        if (format == nullptr) continue;
        if (format->getName() != "VST3") continue;
        juce::OwnedArray<juce::PluginDescription> found;
        format->findAllTypesForFile(found, pluginPath);
        for (auto* desc : found) {
            if (desc == nullptr) continue;
            errorMessage.clear();
            rawProcessor = formatManager_.createPluginInstance(
                *desc, static_cast<double>(sampleRate), blockSize, errorMessage);
            if (rawProcessor != nullptr) {
                description = *desc;
                break;
            }
        }
        if (rawProcessor != nullptr) break;
    }

    // 退路 1：扫到 path 命中的元数据
    if (rawProcessor == nullptr) {
        for (const auto& known : knownPluginList_.getTypes()) {
            if (known.fileOrIdentifier == pluginPath) {
                errorMessage.clear();
                rawProcessor = formatManager_.createPluginInstance(
                    known, static_cast<double>(sampleRate), blockSize, errorMessage);
                if (rawProcessor != nullptr) {
                    description = known;
                    break;
                }
            }
        }
    }
    if (rawProcessor == nullptr) {
        throw std::runtime_error(("failed to load plugin: " + errorMessage).toStdString());
    }

    rawProcessor->prepareToPlay(static_cast<double>(sampleRate), blockSize);

    auto instance = std::make_unique<PluginInstance>();
    instance->handle = allocateHandle();
    instance->processor = std::move(rawProcessor);
    instance->pluginPath = pluginPath;
    instance->pluginUid = description.createIdentifierString();
    instance->sampleRate = sampleRate;
    instance->blockSize = blockSize;
    instance->channels = 2;

    auto resultVar = loadResultVar(*instance);
    instances_.emplace(instance->handle, std::move(instance));
    return resultVar;
}

juce::var PluginManager::unloadPlugin(const juce::var& payload) {
    const auto handle = requireString(payload, "handle");
    auto it = instances_.find(handle);
    if (it == instances_.end()) return juce::var();
    if (it->second->editor) it->second->editor.reset();
    if (it->second->processor) it->second->processor->releaseResources();
    instances_.erase(it);
    return juce::var();
}

juce::var PluginManager::showEditor(const juce::var& payload) {
    const auto handle = requireString(payload, "handle");
    auto* instance = findInstance(handle);
    if (instance == nullptr || instance->processor == nullptr) {
        throw std::runtime_error("instance not found");
    }
    if (!instance->editor) {
        instance->editor = std::make_unique<EditorWindow>(
            instance->processor->getName(),
            *instance->processor,
            [/*captured handle*/] {
                // 关闭事件：上层在 main.cpp 处理（通过单独的回调机制）
                // v1 简化：UI 关闭即隐藏窗口，不卸载；具体事件回报留给后续接 callback
            });
    } else {
        instance->editor->setVisible(true);
        instance->editor->toFront(true);
    }
    return juce::var();
}

juce::var PluginManager::hideEditor(const juce::var& payload) {
    const auto handle = requireString(payload, "handle");
    auto* instance = findInstance(handle);
    if (instance != nullptr && instance->editor) {
        instance->editor->setVisible(false);
    }
    return juce::var();
}

juce::var PluginManager::setParam(const juce::var& payload) {
    const auto handle = requireString(payload, "handle");
    const auto index = requireInt(payload, "index", -1);
    const double value = double(payload.getProperty("value", juce::var(0.0)));
    auto* instance = findInstance(handle);
    if (instance == nullptr || instance->processor == nullptr) {
        throw std::runtime_error("instance not found");
    }
    auto& params = instance->processor->getParameters();
    if (index < 0 || index >= params.size()) {
        throw std::runtime_error("param index out of range");
    }
    params[index]->setValueNotifyingHost(static_cast<float>(juce::jlimit(0.0, 1.0, value)));
    return juce::var();
}

juce::var PluginManager::getParam(const juce::var& payload) const {
    const auto handle = requireString(payload, "handle");
    const auto index = requireInt(payload, "index", -1);
    auto* instance = findInstance(handle);
    if (instance == nullptr || instance->processor == nullptr) {
        throw std::runtime_error("instance not found");
    }
    const auto& params = instance->processor->getParameters();
    if (index < 0 || index >= params.size()) {
        throw std::runtime_error("param index out of range");
    }
    return juce::var(static_cast<double>(params[index]->getValue()));
}

juce::var PluginManager::getState(const juce::var& payload) {
    const auto handle = requireString(payload, "handle");
    auto* instance = findInstance(handle);
    if (instance == nullptr || instance->processor == nullptr) {
        throw std::runtime_error("instance not found");
    }
    juce::MemoryBlock block;
    instance->processor->getStateInformation(block);
    return juce::var(juce::Base64::toBase64(block.getData(), block.getSize()));
}

juce::var PluginManager::setState(const juce::var& payload) {
    const auto handle = requireString(payload, "handle");
    const auto chunkB64 = requireString(payload, "chunkB64");
    auto* instance = findInstance(handle);
    if (instance == nullptr || instance->processor == nullptr) {
        throw std::runtime_error("instance not found");
    }
    juce::MemoryOutputStream out;
    if (!juce::Base64::convertFromBase64(out, chunkB64)) {
        throw std::runtime_error("base64 decode failed");
    }
    instance->processor->setStateInformation(out.getData(), static_cast<int>(out.getDataSize()));
    return juce::var();
}

juce::var PluginManager::processOffline(const juce::var& payload) {
    const auto handle = requireString(payload, "handle");
    const int sampleRate = requireInt(payload, "sampleRate", 44100);
    const int blockSize = requireInt(payload, "blockSize", 256);
    const int channels = juce::jlimit(1, 2, requireInt(payload, "channelCount", 2));
    const auto pcmB64 = requireString(payload, "pcmBase64");

    auto* instance = findInstance(handle);
    if (instance == nullptr || instance->processor == nullptr) {
        throw std::runtime_error("instance not found");
    }

    juce::MemoryOutputStream raw;
    if (!juce::Base64::convertFromBase64(raw, pcmB64)) {
        throw std::runtime_error("input pcmBase64 decode failed");
    }
    const auto* floats = static_cast<const float*>(raw.getData());
    const int totalFrames = static_cast<int>(raw.getDataSize() / sizeof(float) / static_cast<size_t>(channels));

    if (instance->sampleRate != sampleRate || instance->blockSize != blockSize) {
        instance->processor->releaseResources();
        instance->processor->prepareToPlay(static_cast<double>(sampleRate), blockSize);
        instance->sampleRate = sampleRate;
        instance->blockSize = blockSize;
    }

    juce::HeapBlock<float> outputData;
    outputData.calloc(static_cast<size_t>(totalFrames * channels));

    juce::AudioBuffer<float> buffer(channels, blockSize);
    juce::MidiBuffer midi;

    for (int frameStart = 0; frameStart < totalFrames; frameStart += blockSize) {
        const int framesThisBlock = juce::jmin(blockSize, totalFrames - frameStart);
        for (int ch = 0; ch < channels; ++ch) {
            auto* dest = buffer.getWritePointer(ch);
            for (int i = 0; i < framesThisBlock; ++i) {
                dest[i] = floats[(frameStart + i) * channels + ch];
            }
            for (int i = framesThisBlock; i < blockSize; ++i) {
                dest[i] = 0.0f;
            }
        }
        instance->processor->processBlock(buffer, midi);
        for (int ch = 0; ch < channels; ++ch) {
            const auto* src = buffer.getReadPointer(ch);
            for (int i = 0; i < framesThisBlock; ++i) {
                outputData[(frameStart + i) * channels + ch] = src[i];
            }
        }
    }

    return juce::var(juce::Base64::toBase64(outputData.getData(),
                                            sizeof(float) * static_cast<size_t>(totalFrames * channels)));
}

} // namespace webutau::vst
