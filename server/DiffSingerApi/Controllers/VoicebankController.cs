using DiffSingerApi.Services;
using Microsoft.AspNetCore.Mvc;

namespace DiffSingerApi.Controllers;

[ApiController]
[Route("api/voicebanks")]
public class VoicebankController : ControllerBase {
    private readonly VoicebankService _voicebank;

    public VoicebankController(VoicebankService voicebank) {
        _voicebank = voicebank;
    }

    [HttpGet]
    public IActionResult GetAll() {
        return Ok(_voicebank.GetAll());
    }

    [HttpPost("upload")]
    [RequestSizeLimit(2_000_000_000)] // 2GB max for voicebank zip
    public async Task<IActionResult> Upload([FromForm] IFormFile file) {
        if (file == null || file.Length == 0)
            return BadRequest(new { error = "No file provided." });
        if (!file.FileName.EndsWith(".zip", StringComparison.OrdinalIgnoreCase))
            return BadRequest(new { error = "Only .zip files are accepted." });

        try {
            var name = await _voicebank.UploadAsync(file.OpenReadStream(), file.FileName);
            return Ok(new { name, message = "Voicebank uploaded successfully." });
        } catch (InvalidOperationException ex) {
            return BadRequest(new { error = ex.Message });
        }
    }
}
