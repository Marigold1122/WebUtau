using DiffSingerApi.Services;
using Microsoft.Extensions.FileProviders;
using Serilog;
using System.Net;
using System.Net.Sockets;

var builder = WebApplication.CreateBuilder(args);

// Serilog
Log.Logger = new LoggerConfiguration()
    .MinimumLevel.Information()
    .WriteTo.Console()
    .CreateLogger();
builder.Host.UseSerilog();

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

// 静态文件托管：前端 client/ 目录
var clientPath = Path.GetFullPath(Path.Combine(app.Environment.ContentRootPath, "..", "..", "client"));
if (Directory.Exists(clientPath))
{
    var fileProvider = new PhysicalFileProvider(clientPath);
    app.UseDefaultFiles(new DefaultFilesOptions { FileProvider = fileProvider });
    app.UseStaticFiles(new StaticFileOptions
    {
        FileProvider = fileProvider,
        ServeUnknownFileTypes = false
    });
    Log.Information("Serving frontend from {ClientPath}", clientPath);
}
else
{
    Log.Warning("Client directory not found: {ClientPath}", clientPath);
}

app.UseCors();
app.MapControllers();

// 输出局域网地址
var lanIp = Dns.GetHostEntry(Dns.GetHostName())
    .AddressList
    .FirstOrDefault(a => a.AddressFamily == AddressFamily.InterNetwork)?
    .ToString() ?? "unknown";

Log.Information("========================================");
Log.Information("  Melody Singer 已启动");
Log.Information("  本机访问: http://localhost:5000");
Log.Information("  局域网访问: http://{LanIp}:5000", lanIp);
Log.Information("========================================");

app.Run("http://0.0.0.0:5000");
