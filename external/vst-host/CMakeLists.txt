cmake_minimum_required(VERSION 3.22)

# JUCE 在 macOS 上要 ObjC/ObjCXX（GUI 模块）；其它平台只要 C/CXX。
# 不显式声明 C 时 CMake 4.x + AppleClang 会在 JUCE 子目录里报 CMAKE_C_COMPILE_OBJECT 缺失
if(APPLE)
    project(webutau_vst_host VERSION 0.1.0 LANGUAGES C CXX OBJC OBJCXX)
else()
    project(webutau_vst_host VERSION 0.1.0 LANGUAGES C CXX)
endif()

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# JUCE 集成。预期路径：external/vst-host/JUCE/（git submodule）
# 使用前先 `git submodule update --init --recursive`
set(WEBUTAU_VST_HOST_JUCE_DIR "${CMAKE_CURRENT_SOURCE_DIR}/JUCE" CACHE PATH "Path to JUCE")

if(NOT EXISTS "${WEBUTAU_VST_HOST_JUCE_DIR}/CMakeLists.txt")
    message(FATAL_ERROR
        "JUCE not found at ${WEBUTAU_VST_HOST_JUCE_DIR}.\n"
        "Run: git -C external/vst-host clone --depth=1 https://github.com/juce-framework/JUCE.git\n"
        "Or: cmake -DWEBUTAU_VST_HOST_JUCE_DIR=/path/to/JUCE")
endif()

add_subdirectory("${WEBUTAU_VST_HOST_JUCE_DIR}" JUCE EXCLUDE_FROM_ALL)

# JUCE 默认会把 plugin formats 编译进来；我们只需要 host 端
juce_add_console_app(webutau_vst_host
    PRODUCT_NAME "webutau_vst_host"
    COMPANY_NAME "Haruhi Fan Club"
    BUNDLE_ID "cn.haruyuki.melody-singer.vst-host"
)

target_compile_definitions(webutau_vst_host PRIVATE
    JUCE_PLUGINHOST_VST3=1
    JUCE_PLUGINHOST_AU=$<IF:$<PLATFORM_ID:Darwin>,1,0>
    JUCE_PLUGINHOST_VST=0
    JUCE_PLUGINHOST_LADSPA=0
    JUCE_USE_CURL=0
    JUCE_WEB_BROWSER=0
    JUCE_USE_FREETYPE=0
    JUCE_DISPLAY_SPLASH_SCREEN=0
)

target_sources(webutau_vst_host PRIVATE
    Source/Main.cpp
    Source/StdioProtocol.cpp
    Source/PluginManager.cpp
    Source/EditorWindow.cpp
)

target_include_directories(webutau_vst_host PRIVATE Source)

target_link_libraries(webutau_vst_host PRIVATE
    juce::juce_audio_basics
    juce::juce_audio_devices
    juce::juce_audio_formats
    juce::juce_audio_processors
    juce::juce_audio_utils
    juce::juce_core
    juce::juce_data_structures
    juce::juce_events
    juce::juce_graphics
    juce::juce_gui_basics
    juce::juce_gui_extra
    juce::juce_recommended_config_flags
    juce::juce_recommended_lto_flags
    juce::juce_recommended_warning_flags
)

# macOS 让 host 进程可以加载未签名的第三方插件
if(APPLE)
    set_target_properties(webutau_vst_host PROPERTIES
        XCODE_ATTRIBUTE_CODE_SIGN_IDENTITY "-"
        XCODE_ATTRIBUTE_OTHER_CODE_SIGN_FLAGS ""
    )
endif()
