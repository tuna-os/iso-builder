using TunaOS.MediaWriter.Core;
using TunaOS.MediaWriter.Core.Helper;

namespace TunaOS.MediaWriter.App;

/// <summary>
/// Command line. A normal launch has none. Links from iso.tunaos.org (desktop/PROTOCOL.md):
/// <list type="bullet">
/// <item><c>--target ID</c>: open on that catalog target (step 2, waiting for the user).</item>
/// <item><c>tunaos-media-writer://build?target=ID</c>: the same; the MSI's URL protocol passes the link as the argument.</item>
/// </list>
/// The rest exist for CI and development:
/// <list type="bullet">
/// <item><c>--fake-helper PATH</c>: run smoke/fake-helper.ps1 (or any script) instead of the bundled helper.</item>
/// <item><c>--no-elevate</c>: start the write step without the UAC verb (still through the events file).</item>
/// <item><c>--smoke DIR</c>: walk the flow by itself, save window screenshots and smoke.log to DIR, then exit.</item>
/// <item><c>--smoke-scenario write|error|save|link|launch</c>: which walk (default write). Every scenario
/// except <c>launch</c> requires <c>--fake-helper</c>, so a smoke run can never write to a real disk.</item>
/// </list>
/// </summary>
internal sealed record AppOptions
{
    public required HelperCommand Helper { get; init; }

    public bool IsFakeHelper { get; init; }

    public bool Elevate { get; init; } = true;

    public string? SmokeDirectory { get; init; }

    public string SmokeScenario { get; init; } = "write";

    public TimeSpan SmokeTimeout { get; init; } = TimeSpan.FromMinutes(3);

    /// <summary>The <c>--target</c> value, unchecked (the flow reports a bad one).</summary>
    public string? Target { get; init; }

    /// <summary>A <c>tunaos-media-writer:</c> argument, unchecked.</summary>
    public string? Link { get; init; }

    public string CacheDirectory { get; init; } = Path.Combine(DataDirectory, "cache");

    public static string DataDirectory { get; } = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), Strings.AppName);

    public static AppOptions Parse(IReadOnlyList<string> args, out string? error)
    {
        error = null;
        string? fake = null;
        string? smoke = null;
        var scenario = "write";
        var elevate = true;
        var timeout = TimeSpan.FromMinutes(3);
        string? target = null;
        string? link = null;
        for (var i = 0; i < args.Count; i++)
        {
            string? Value() => i + 1 < args.Count ? args[++i] : null;
            switch (args[i])
            {
                case "--fake-helper":
                    fake = Value();
                    break;
                case "--no-elevate":
                    elevate = false;
                    break;
                case "--smoke":
                    smoke = Value();
                    break;
                case "--smoke-scenario":
                    scenario = Value() ?? scenario;
                    break;
                case "--smoke-timeout":
                    if (int.TryParse(Value(), out var seconds))
                    {
                        timeout = TimeSpan.FromSeconds(seconds);
                    }

                    break;
                case "--target":
                    target = Value() ?? ""; // missing value: refused, visibly
                    break;
                default:
                    if (LaunchLink.IsLink(args[i]))
                    {
                        link = args[i];
                    }

                    break;
            }
        }

        if (smoke is not null && scenario != "launch" && fake is null)
        {
            error = $"--smoke-scenario {scenario} needs --fake-helper; only 'launch' may use the real helper.";
        }

        return new AppOptions
        {
            Helper = fake is not null
                ? HelperCommand.FakeScript(fake)
                : HelperCommand.Executable(Path.Combine(AppContext.BaseDirectory, HelperCommand.HelperExeName)),
            IsFakeHelper = fake is not null,
            Elevate = elevate,
            SmokeDirectory = smoke is null ? null : Path.GetFullPath(smoke),
            SmokeScenario = scenario,
            SmokeTimeout = timeout,
            Target = target,
            Link = link,
        };
    }
}
