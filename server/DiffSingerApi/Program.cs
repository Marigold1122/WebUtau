using System.Runtime.InteropServices;
using DiffSingerApi.Services;
using OpenUtau.Core;
using OpenUtau.Core.Util;
using Serilog;

Directory.SetCurrentDirectory(AppContext.BaseDirectory);

// Ensure CUDA/cuDNN native libraries can be found.
// OnnxRuntime.Gpu requires cudnn64_9.dll at runtime. It may live in conda,
// CUDA Toolkit, or a standalone cuDNN install. Scan well-known environment
// variables to locate them and prepend to PATH for the OS dynamic linker.
if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows)) {
    bool CudnnExists(string dir) =>
        Directory.Exists(dir) && Directory.GetFiles(dir, "cudnn*.dll").Length > 0;

    var candidates = new List<string>();

    // 1. Explicit override — user can set MELODY_CUDNN_PATH to point anywhere
    var explicitPath = Environment.GetEnvironmentVariable("MELODY_CUDNN_PATH");
    if (!string.IsNullOrEmpty(explicitPath))
        candidates.Add(explicitPath);

    // 2. Active conda environment (set by conda activate)
    var condaPrefix = Environment.GetEnvironmentVariable("CONDA_PREFIX");
    if (!string.IsNullOrEmpty(condaPrefix))
        candidates.Add(Path.Combine(condaPrefix, "Library", "bin"));

    // 3. Conda base derived from CONDA_EXE (works even without activation)
    var condaExe = Environment.GetEnvironmentVariable("CONDA_EXE");
    if (!string.IsNullOrEmpty(condaExe)) {
        var condaRoot = Path.GetDirectoryName(Path.GetDirectoryName(condaExe));
        if (condaRoot != null)
            candidates.Add(Path.Combine(condaRoot, "Library", "bin"));
    }

    // 4. NVIDIA cuDNN standalone install
    var cudnnHome = Environment.GetEnvironmentVariable("CUDNN_PATH")
                 ?? Environment.GetEnvironmentVariable("CUDNN_HOME");
    if (!string.IsNullOrEmpty(cudnnHome)) {
        candidates.Add(Path.Combine(cudnnHome, "bin"));
        candidates.Add(cudnnHome);
    }

    // 5. CUDA Toolkit (cuDNN sometimes installed alongside)
    var cudaPath = Environment.GetEnvironmentVariable("CUDA_PATH");
    if (!string.IsNullOrEmpty(cudaPath))
        candidates.Add(Path.Combine(cudaPath, "bin"));

    // 6. Well-known fallback locations under user profile
    var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
    candidates.Add(Path.Combine(home, "miniconda3", "Library", "bin"));
    candidates.Add(Path.Combine(home, "anaconda3", "Library", "bin"));
    candidates.Add(Path.Combine(home, "miniforge3", "Library", "bin"));

    var extraDirs = candidates.Where(CudnnExists).Distinct().ToList();
    if (extraDirs.Count > 0) {
        var path = Environment.GetEnvironmentVariable("PATH") ?? "";
        Environment.SetEnvironmentVariable("PATH",
            string.Join(Path.PathSeparator.ToString(), extraDirs.Concat(new[] { path })));
    }
}

var builder = WebApplication.CreateBuilder(args);

// Serilog
Log.Logger = new LoggerConfiguration()
    .MinimumLevel.Information()
    .WriteTo.Console()
    .CreateLogger();
builder.Host.UseSerilog();

// ONNX Runtime — auto-select GPU acceleration when available.
// Override with environment variable MELODY_ONNX_RUNNER (e.g. "CPU", "CUDA").
{
    var runnerOptions = Onnx.getRunnerOptions();
    var envRunner = Environment.GetEnvironmentVariable("MELODY_ONNX_RUNNER");
    if (!string.IsNullOrEmpty(envRunner)) {
        if (runnerOptions.Contains(envRunner)) {
            Preferences.Default.OnnxRunner = envRunner;
            Log.Information("ONNX runner set to {Runner} (from MELODY_ONNX_RUNNER)", envRunner);
        } else {
            Log.Warning("MELODY_ONNX_RUNNER={EnvRunner} is not valid on this platform. Options: {Options}",
                envRunner, string.Join(", ", runnerOptions));
        }
    } else if (string.IsNullOrEmpty(Preferences.Default.OnnxRunner)) {
        // Auto-detect: prefer GPU provider if available
        var gpuProvider = runnerOptions.FirstOrDefault(r => r != "CPU");
        if (gpuProvider != null) {
            var gpus = Onnx.getGpuInfo();
            if (gpus.Count > 0 && !string.IsNullOrEmpty(gpus[0].description)) {
                Preferences.Default.OnnxRunner = gpuProvider;
                Log.Information("ONNX runner auto-selected: {Runner} (GPU: {Gpu})",
                    gpuProvider, gpus[0].description);
            }
        }
    }

    // Validate that the selected GPU provider actually works.
    // AppendExecutionProvider_CUDA throws immediately if CUDA/cuDNN native
    // libs are missing — catch it early and fall back to CPU.
    var selectedRunner = Preferences.Default.OnnxRunner;
    if (!string.IsNullOrEmpty(selectedRunner) && selectedRunner != "CPU") {
        try {
            using var opts = new Microsoft.ML.OnnxRuntime.SessionOptions();
            if (selectedRunner == "CUDA") {
                opts.AppendExecutionProvider_CUDA(0);
            }
            Log.Information("{Runner} execution provider validated successfully", selectedRunner);
        } catch (Exception ex) {
            Log.Warning("{Runner} execution provider failed: {Message}", selectedRunner, ex.Message);
            Log.Warning("Falling back to CPU. To fix, install cuDNN 9 and ensure cudnn64_9.dll is in PATH");
            Preferences.Default.OnnxRunner = "CPU";
        }
    }

    Log.Information("ONNX runner: {Runner}",
        string.IsNullOrEmpty(Preferences.Default.OnnxRunner) ? "CPU" : Preferences.Default.OnnxRunner);
}

// Services
builder.Services.AddSingleton<SynthesisService>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<SynthesisService>());
builder.Services.AddScoped<VoicebankService>();
builder.Services.AddControllers();

// CORS — allow frontend dev server
builder.Services.AddCors(options => {
    options.AddDefaultPolicy(policy => {
        policy.AllowAnyOrigin()
              .AllowAnyMethod()
              .AllowAnyHeader()
              .WithExposedHeaders("Content-Disposition");
    });
});

var app = builder.Build();

app.UseCors();
app.MapControllers();

Log.Information("DiffSinger API starting on http://localhost:38510");
app.Run("http://0.0.0.0:38510");
