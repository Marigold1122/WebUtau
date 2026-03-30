namespace DiffSingerApi.Models;

public class EditNotesRejectedException : Exception {
    public EditNotesRejectedException(string message) : base(message) {
    }
}
