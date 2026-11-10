using System.Globalization;

namespace TunaOS.MediaWriter.Core;

/// <summary>
/// Every user-facing string, in one place for later localization. Plain words only:
/// no "OCI", "bootc", "EROFS" on the main path (contract, GUI flow).
/// </summary>
public static class Strings
{
    public const string AppName = "TunaOS Media Writer";
    public const string DocsUrl = "https://tunaos.org/docs";

    public static string StepOf(int step) => $"Step {step} of 4";

    // Step 1 — Choose
    public const string ChooseTitle = "Choose your desktop";
    public const string ChooseSubtitle = "Pick the look and feel you like. You can change apps and settings later.";
    public const string BaseLabel = "System base";
    public const string Continue = "Continue";
    public const string OpenBuildRequest = "Open build request…";
    public const string LoadingCatalog = "Loading the list of systems…";
    public static string UsingBuildRequest(string fileName) => $"Using the settings from {fileName}.";
    public const string ClearBuildRequest = "Use the list instead";

    // Step 2 — Destination
    public const string DestinationTitle = "Choose your USB stick";
    public const string DestinationSubtitle = "Plug in a USB stick. Everything on it will be erased.";
    public const string NoDrives = "No USB sticks found. Plug one in and it will show up here.";
    public const string Back = "Back";
    public const string SaveIsoOnly = "Save ISO file only…";
    public const string WriteToDrive = "Write to USB stick";
    public static string EraseTitle(string name, long sizeBytes) => $"Erase {name} ({Format.Size(sizeBytes)})?";
    public const string EraseBody = "Everything on it will be deleted.";
    public const string EraseConfirm = "Erase and write";
    public const string Cancel = "Cancel";
    public const string IsoFileTypeName = "Disk image";
    public static string SuggestedIsoName(string label) => $"TunaOS {label}";

    // Step 3 — Progress
    public const string ProgressTitleDrive = "Making your USB stick";
    public const string ProgressTitleFile = "Creating your ISO file";
    public const string PhasePreparing = "Getting ready";
    public const string PhaseDownloading = "Downloading";
    public const string PhaseBuilding = "Building";
    public const string PhaseWriting = "Writing";
    public const string PhaseVerifying = "Verifying";
    public const string ProgressHint = "This can take a while. You can keep using your computer.";
    public const string ProgressHintWrite = "Don't unplug the USB stick.";
    public static string Percent(double fraction) =>
        string.Format(CultureInfo.CurrentCulture, "{0:0}%", Math.Clamp(fraction, 0, 1) * 100);

    // Step 4 — Done
    public const string DoneTitle = "All done";
    public const string DoneDrive = "Your USB stick is ready. Restart your computer and boot from it.";
    public const string DoneFile = "Your ISO file is saved.";
    public static string SavedTo(string path) => $"Saved as {path}";
    public const string InstallDocs = "How to install TunaOS";
    public const string ShowInFolder = "Show in folder";
    public const string StartOver = "Make another";
    public const string Close = "Close";
    public const string FailedTitle = "Something went wrong";
    public const string TryAgain = "Try again";
    public const string ShowDetails = "Show details";
    public const string HideDetails = "Hide details";
    public const string CopyDetails = "Copy details";

    // Errors (used when the helper gave no message of its own)
    public const string ErrorGeneric = "Something unexpected happened.";
    public const string ErrorNetwork = "Could not download TunaOS. Check your internet connection.";
    public const string ErrorStorage = "There is not enough free space on this computer.";
    public const string ErrorPermission = "Windows did not allow access to the USB stick.";
    public const string ErrorDeviceChanged = "The USB stick was unplugged or changed. Plug it back in and try again.";
    public const string ErrorVerifyMismatch = "The USB stick did not read back correctly. Try a different stick.";
    public const string ErrorElevationDeclined =
        "Writing needs your permission. Click Try again and choose Yes when Windows asks.";
    public const string ErrorHelperMissing =
        "A part of TunaOS Media Writer is missing. Please reinstall it.";
    public const string ErrorNoCatalog = "Could not load the list of systems.";
    public const string ErrorNoTargets = "No systems are available for this computer right now.";

    public static string ForErrorKind(string kind) => kind switch
    {
        Protocol.ErrorKinds.Network => ErrorNetwork,
        Protocol.ErrorKinds.Storage => ErrorStorage,
        Protocol.ErrorKinds.Permission => ErrorPermission,
        Protocol.ErrorKinds.DeviceChanged => ErrorDeviceChanged,
        Protocol.ErrorKinds.VerifyMismatch => ErrorVerifyMismatch,
        _ => ErrorGeneric,
    };
}

public static class Format
{
    /// <summary>
    /// Decimal units, matching the capacity printed on the stick ("16 GB"), which is
    /// what a non-technical user compares against.
    /// </summary>
    public static string Size(long bytes)
    {
        string[] units = ["bytes", "KB", "MB", "GB", "TB"];
        double value = bytes;
        var unit = 0;
        while (value >= 1000 && unit < units.Length - 1)
        {
            value /= 1000;
            unit++;
        }

        return unit == 0
            ? string.Format(CultureInfo.CurrentCulture, "{0} {1}", bytes, units[0])
            : string.Format(CultureInfo.CurrentCulture, "{0:0.0} {1}", value, units[unit]);
    }
}
