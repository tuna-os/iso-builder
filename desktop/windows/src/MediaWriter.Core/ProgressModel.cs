namespace TunaOS.MediaWriter.Core;

/// <summary>What the single progress bar and its label show for a protocol phase.</summary>
public readonly record struct ProgressDisplay(string Label, double? Fraction);

/// <summary>
/// Maps protocol phases onto the four plain labels (Downloading / Building / Writing /
/// Verifying). The five engine phases behind "Building" share one bar, each taking an
/// equal slice, so the bar never jumps back under an unchanged label.
/// </summary>
public static class ProgressModel
{
    private static readonly string[] BuildPhases = ["unpack", "overlay", "erofs", "esp", "iso"];

    public static ProgressDisplay For(string phase, long current, long total)
    {
        double? within = total > 0 ? Math.Clamp((double)current / total, 0, 1) : null;
        switch (phase)
        {
            case "download":
                return new(Strings.PhaseDownloading, within);
            case "write":
                return new(Strings.PhaseWriting, within);
            case "verify":
                return new(Strings.PhaseVerifying, within);
        }

        var index = Array.IndexOf(BuildPhases, phase);
        if (index < 0)
        {
            return new(Strings.PhaseBuilding, null);
        }

        return new(Strings.PhaseBuilding, (index + (within ?? 0)) / BuildPhases.Length);
    }
}
