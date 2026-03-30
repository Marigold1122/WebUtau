using DiffSingerApi.Services;
using Serilog;

Directory.SetCurrentDirectory(AppContext.BaseDirectory);

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

app.UseCors();
app.MapControllers();

Log.Information("DiffSinger API starting on http://localhost:5000");
app.Run("http://0.0.0.0:5000");
