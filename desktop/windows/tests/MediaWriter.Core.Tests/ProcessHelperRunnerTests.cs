using System.Collections.Concurrent;
using System.Diagnostics;
using TunaOS.MediaWriter.Core.Helper;
using TunaOS.MediaWriter.Core.Protocol;
using Xunit;

namespace TunaOS.MediaWriter.Core.Tests;

/// <summary>Runs only where smoke/fake-helper.ps1 can run: Windows PowerShell, or pwsh elsewhere.</summary>
public sealed class FakeHelperFactAttribute : FactAttribute
{
    private static readonly Lazy<bool> Available = new(() =>
    {
        if (OperatingSystem.IsWindows())
        {
            return true;
        }

        try
        {
            using var p = Process.Start(new ProcessStartInfo("pwsh", "-NoProfile -Command exit") { RedirectStandardOutput = true });
            p!.WaitForExit();
            return p.ExitCode == 0;
        }
        catch (System.ComponentModel.Win32Exception)
        {
            return false;
        }
    });

    public FakeHelperFactAttribute()
    {
        if (!Available.Value)
        {
            Skip = "needs Windows PowerShell or pwsh to run fake-helper.ps1";
        }
    }
}

/// <summary>
/// End-to-end over a real child process: the stdout path, the --events file path the
/// elevated write uses (with runas switched off), and --cancel-file.
/// </summary>
public sealed class ProcessHelperRunnerTests : IDisposable
{
    private readonly string _dir = Directory.CreateTempSubdirectory("mw-runner-").FullName;

    static ProcessHelperRunnerTests() => Environment.SetEnvironmentVariable("FAKE_HELPER_DELAY_MS", "20");

    private static string Script => Path.Combine(AppContext.BaseDirectory, "fake-helper.ps1");

    public void Dispose() => Directory.Delete(_dir, recursive: true);

    private ProcessHelperRunner Runner() => new(
        HelperCommand.FakeScript(Script),
        new ProcessHelperRunnerOptions { UseRunAs = false, TempDirectory = _dir, PollInterval = TimeSpan.FromMilliseconds(50), CancelGrace = TimeSpan.FromSeconds(30) });

    private static async Task<(HelperResult Result, List<HelperEvent> Events, List<string> Log)> Run(
        ProcessHelperRunner runner, HelperRequest request, CancellationToken ct = default, Action<HelperEvent>? also = null)
    {
        var events = new ConcurrentQueue<HelperEvent>();
        var log = new ConcurrentQueue<string>();
        var result = await runner.RunAsync(request, ev => { events.Enqueue(ev); also?.Invoke(ev); }, log.Enqueue, ct);
        return (result, events.ToList(), log.ToList());
    }

    [FakeHelperFact]
    public async Task CatalogOverStdout()
    {
        var (result, events, _) = await Run(Runner(), new HelperRequest(["catalog"]));
        Assert.Equal(0, result.ExitCode);
        var catalog = Assert.Single(events.OfType<CatalogEvent>()).Catalog;
        Assert.Equal("yellowfin:gnome:linux/amd64", catalog.DefaultTarget);
        Assert.Equal(5, catalog.Desktops.Count);
        Assert.DoesNotContain(events, e => e is MalformedLine);
    }

    [FakeHelperFact]
    public async Task StderrAndErrorEventOnFailure()
    {
        Environment.SetEnvironmentVariable("FAKE_HELPER_FAIL", "catalog");
        try
        {
            var (result, events, log) = await Run(Runner(), new HelperRequest(["catalog"]));
            Assert.Equal(1, result.ExitCode);
            Assert.Equal("network", Assert.Single(events.OfType<ErrorEvent>()).Kind);
            Assert.Contains(log, l => l.Contains("fake-helper: network"));
        }
        finally
        {
            Environment.SetEnvironmentVariable("FAKE_HELPER_FAIL", null);
        }
    }

    [FakeHelperFact]
    public async Task ElevatedWriteIsReadFromTheEventsFile()
    {
        var iso = Path.Combine(_dir, "a b.iso");
        File.WriteAllText(iso, "iso");
        var (result, events, _) = await Run(
            Runner(),
            new HelperRequest(["write", "--iso", iso, "--device", @"disk2:SER"]) { Elevated = true, Cancellable = true });

        Assert.Equal(0, result.ExitCode);
        Assert.False(result.ElevationDeclined);
        Assert.Contains(events, e => e is ProgressEvent { Phase: "write" });
        Assert.Contains(events, e => e is ProgressEvent { Phase: "verify" });
        Assert.Equal(new WriteDoneEvent("disk2:SER", 2400000000, true), events.Last());
        Assert.Equal(["a b.iso"], Directory.GetFiles(_dir).Select(Path.GetFileName)); // events + cancel files cleaned up
    }

    [FakeHelperFact]
    public async Task CancelFileStopsABuild()
    {
        using var cts = new CancellationTokenSource();
        var (result, events, _) = await Run(
            Runner(),
            new HelperRequest(["build", "--target", "x", "--out", Path.Combine(_dir, "out.iso")]) { Cancellable = true },
            cts.Token,
            ev =>
            {
                if (ev is ProgressEvent)
                {
                    cts.Cancel();
                }
            });

        Assert.Equal(HelperExitCodes.Cancelled, result.ExitCode);
        Assert.Equal("cancelled", events.OfType<ErrorEvent>().Single().Kind);
        Assert.False(File.Exists(Path.Combine(_dir, "out.iso")));
    }

    [FakeHelperFact]
    public async Task WholeFlowAgainstTheFakeHelperProcess()
    {
        var cache = Path.Combine(_dir, "cache");
        var flow = new MediaWriterFlow(Runner(), new FlowOptions { CacheDirectory = cache, Platform = "linux/amd64" }, uiContext: null);
        await flow.LoadCatalogAsync();
        Assert.Equal("gnome", flow.DesktopId);
        flow.Continue();
        await flow.RefreshDrivesAsync();
        Assert.Equal(2, flow.Drives.Count);
        await flow.WriteToDriveAsync(flow.Drives[0]);
        Assert.True(flow.Step == FlowStep.Done, flow.ErrorMessage + "\n" + flow.Details);
        Assert.False(File.Exists(flow.CachedIsoPath));
    }

    [FakeHelperFact]
    public async Task MissingHelperThrowsWin32Exception()
    {
        var runner = new ProcessHelperRunner(HelperCommand.Executable(Path.Combine(_dir, "nope.exe")));
        await Assert.ThrowsAsync<System.ComponentModel.Win32Exception>(() => Run(runner, new HelperRequest(["version"])));
    }
}
