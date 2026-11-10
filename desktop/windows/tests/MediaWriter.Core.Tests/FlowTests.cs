using System.ComponentModel;
using TunaOS.MediaWriter.Core.Helper;
using TunaOS.MediaWriter.Core.Protocol;
using Xunit;

namespace TunaOS.MediaWriter.Core.Tests;

/// <summary>Scripted in-process helper: one canned reply per subcommand, every request recorded.</summary>
internal sealed class FakeRunner : IHelperRunner
{
    public delegate Task<HelperResult> Reply(HelperRequest request, Action<HelperEvent> emit, CancellationToken ct);

    public Dictionary<string, Reply> Replies { get; } = new()
    {
        ["catalog"] = Emit(0, new CatalogEvent(Fixtures.Catalog())),
        ["drives"] = Emit(0, new DrivesEvent([FlowTests.Stick])),
        ["build"] = (req, emit, _) =>
        {
            emit(new ProgressEvent("download", 1, 2, "bytes", "Downloading"));
            emit(new ProgressEvent("iso", 1, 1, "bytes", "ISO"));
            var outPath = req.Args[req.Args.ToList().IndexOf("--out") + 1];
            File.WriteAllText(outPath, "iso");
            emit(new BuildDoneEvent(outPath, 3, "abc"));
            return Task.FromResult(new HelperResult(0));
        },
        ["write"] = Emit(0, new ProgressEvent("write", 1, 2, "bytes", ""), new ProgressEvent("verify", 2, 2, "bytes", ""), new WriteDoneEvent("disk2:SER", 3, true)),
    };

    public List<HelperRequest> Requests { get; } = [];

    public List<FlowStep> StepsSeenDuringRun { get; } = [];

    public Func<FlowStep>? ObserveStep { get; set; }

    public static Reply Emit(int exitCode, params HelperEvent[] events) => (_, emit, _) =>
    {
        foreach (var ev in events)
        {
            emit(ev);
        }

        return Task.FromResult(new HelperResult(exitCode));
    };

    public Task<HelperResult> RunAsync(HelperRequest request, Action<HelperEvent> onEvent, Action<string> onLog, CancellationToken ct)
    {
        Requests.Add(request);
        if (ObserveStep is not null)
        {
            StepsSeenDuringRun.Add(ObserveStep());
        }

        onLog($"stderr of {request.Args[0]}");
        return Replies[request.Args[0]](request, onEvent, ct);
    }

    public IEnumerable<string> Subcommands => Requests.Select(r => r.Args[0]);
}

public sealed class FlowTests : IDisposable
{
    public static readonly Drive Stick = new()
    {
        Id = "disk2:SER", Path = @"\\.\PhysicalDrive2", Name = "SanDisk Ultra", SizeBytes = 15376318464, Bus = "usb", Removable = true,
    };

    private readonly string _cache = Path.Combine(Path.GetTempPath(), "mw-flow-" + Guid.NewGuid().ToString("N"));
    private readonly FakeRunner _runner = new();
    private readonly MediaWriterFlow _flow;

    public FlowTests()
    {
        _flow = new MediaWriterFlow(_runner, new FlowOptions { CacheDirectory = _cache, Platform = "linux/amd64" }, uiContext: null);
    }

    public void Dispose()
    {
        if (Directory.Exists(_cache))
        {
            Directory.Delete(_cache, recursive: true);
        }
    }

    private async Task AtDestinationAsync()
    {
        await _flow.LoadCatalogAsync();
        _flow.Continue();
        await _flow.RefreshDrivesAsync();
    }

    [Fact]
    public async Task LoadingTheCatalogPicksTheCatalogDefault()
    {
        var steps = new List<bool>();
        _flow.Changed += (_, _) => steps.Add(_flow.IsLoadingCatalog);
        await _flow.LoadCatalogAsync();

        Assert.Equal([true, false], steps);
        Assert.Equal(FlowStep.Choose, _flow.Step);
        Assert.Equal(1, _flow.StepNumber);
        Assert.Equal("gnome", _flow.DesktopId);
        Assert.Equal("yellowfin", _flow.BaseId);
        Assert.Equal("yellowfin:gnome:linux/amd64", _flow.SelectedTarget!.Id);
        Assert.True(_flow.CanContinue);
        Assert.Equal("GNOME (AlmaLinux Kitten 10 (flagship))", _flow.SelectionLabel);
    }

    [Fact]
    public async Task ChangingDesktopKeepsTheBaseOnlyWhenOffered()
    {
        await _flow.LoadCatalogAsync();
        _flow.SelectBase("bonito");
        _flow.SelectDesktop("kde");
        Assert.Equal("bonito", _flow.BaseId);
        _flow.SelectDesktop("xfce");
        Assert.Equal("skipjack", _flow.BaseId);
    }

    [Fact]
    public async Task WritingBuildsThenWritesElevatedThenFinishes()
    {
        await AtDestinationAsync();
        Assert.Equal(FlowStep.Destination, _flow.Step);
        Assert.Equal(2, _flow.StepNumber);
        Assert.Equal([Stick], _flow.Drives);

        var labels = new List<string>();
        _flow.Changed += (_, _) => labels.Add(_flow.Progress.Label);
        _runner.ObserveStep = () => _flow.Step;
        await _flow.WriteToDriveAsync(Stick);

        Assert.Equal(FlowStep.Done, _flow.Step);
        Assert.Equal(4, _flow.StepNumber);
        Assert.Equal(OutputKind.UsbDrive, _flow.Output);
        Assert.Equal(Stick, _flow.TargetDrive);
        Assert.Equal([FlowStep.Progress, FlowStep.Progress], _runner.StepsSeenDuringRun);
        Assert.Contains(Strings.PhaseDownloading, labels);
        Assert.Contains(Strings.PhaseBuilding, labels);
        Assert.Contains(Strings.PhaseWriting, labels);
        Assert.Contains(Strings.PhaseVerifying, labels);

        var build = _runner.Requests.Single(r => r.Args[0] == "build");
        Assert.Equal(["build", "--target", "yellowfin:gnome:linux/amd64", "--out", _flow.CachedIsoPath], build.Args);
        Assert.True(build.Cancellable);
        Assert.False(build.Elevated);

        var write = _runner.Requests.Single(r => r.Args[0] == "write");
        Assert.Equal(["write", "--iso", _flow.CachedIsoPath, "--device", "disk2:SER"], write.Args);
        Assert.True(write.Elevated);
        Assert.True(write.Cancellable);

        Assert.False(File.Exists(_flow.CachedIsoPath)); // multi-GB scratch file removed
    }

    [Fact]
    public async Task DriveListingExcludesTheCacheDirectory()
    {
        await AtDestinationAsync();
        Assert.Equal(["drives", "--exclude", _cache], _runner.Requests.Single(r => r.Args[0] == "drives").Args);
    }

    [Fact]
    public async Task SaveIsoOnlyBuildsToTheChosenFileAndNeverWrites()
    {
        await AtDestinationAsync();
        Directory.CreateDirectory(_cache);
        var target = Path.Combine(_cache, "my tunaos.iso");
        await _flow.SaveIsoAsync(target);

        Assert.Equal(FlowStep.Done, _flow.Step);
        Assert.Equal(OutputKind.IsoFile, _flow.Output);
        Assert.Equal(target, _flow.SavedIsoPath);
        Assert.DoesNotContain("write", _runner.Subcommands);
        Assert.True(File.Exists(target));
    }

    [Fact]
    public async Task BuildRequestReplacesTheTarget()
    {
        await _flow.LoadCatalogAsync();
        var request = Path.Combine(_cache, "build-request.json");
        _flow.UseBuildRequest(request);
        Assert.Equal("build-request", _flow.SelectionLabel);
        _flow.Continue();
        await _flow.WriteToDriveAsync(Stick);

        var build = _runner.Requests.Single(r => r.Args[0] == "build");
        Assert.Equal(["build", "--request", request, "--out", _flow.CachedIsoPath], build.Args);
    }

    [Fact]
    public async Task BuildErrorShowsTheHelperMessageAndTryAgainReturnsToDestination()
    {
        _runner.Replies["build"] = FakeRunner.Emit(1, new ErrorEvent("storage", "25 GB needed, 3 GB available."));
        await AtDestinationAsync();
        await _flow.WriteToDriveAsync(Stick);

        Assert.Equal(FlowStep.Failed, _flow.Step);
        Assert.Equal(4, _flow.StepNumber);
        Assert.Equal("25 GB needed, 3 GB available.", _flow.ErrorMessage);
        Assert.Contains("error (storage): 25 GB needed", _flow.Details);
        Assert.Contains("stderr of build", _flow.Details);
        Assert.DoesNotContain("write", _runner.Subcommands);

        await _flow.TryAgainAsync();
        Assert.Equal(FlowStep.Destination, _flow.Step);
        Assert.Null(_flow.ErrorMessage);
    }

    [Fact]
    public async Task ErrorWithoutMessageFallsBackToPlainWordsForTheKind()
    {
        _runner.Replies["write"] = FakeRunner.Emit(1, new ErrorEvent("device-changed", ""));
        await AtDestinationAsync();
        await _flow.WriteToDriveAsync(Stick);
        Assert.Equal(Strings.ErrorDeviceChanged, _flow.ErrorMessage);
    }

    [Fact]
    public async Task ExitZeroWithoutDoneIsStillAFailure()
    {
        _runner.Replies["write"] = FakeRunner.Emit(0);
        await AtDestinationAsync();
        await _flow.WriteToDriveAsync(Stick);
        Assert.Equal(FlowStep.Failed, _flow.Step);
        Assert.Equal(Strings.ErrorGeneric, _flow.ErrorMessage);
    }

    [Fact]
    public async Task AFailedWriteKeepsTheIsoSoRetryingSkipsTheBuild()
    {
        _runner.Replies["write"] = FakeRunner.Emit(1, new ErrorEvent("device-changed", "Unplugged."));
        await AtDestinationAsync();
        await _flow.WriteToDriveAsync(Stick);
        Assert.Equal(FlowStep.Failed, _flow.Step);
        Assert.True(File.Exists(_flow.CachedIsoPath));

        await _flow.TryAgainAsync();
        _runner.Replies["write"] = FakeRunner.Emit(0, new WriteDoneEvent("disk2:SER", 3, true));
        await _flow.WriteToDriveAsync(Stick);

        Assert.Equal(FlowStep.Done, _flow.Step);
        Assert.Single(_runner.Requests, r => r.Args[0] == "build");
        Assert.Equal(2, _runner.Requests.Count(r => r.Args[0] == "write"));
    }

    [Fact]
    public async Task DecliningElevationExplainsWhatToDo()
    {
        _runner.Replies["write"] = (_, _, _) => Task.FromResult(new HelperResult(HelperExitCodes.Cancelled, ElevationDeclined: true));
        await AtDestinationAsync();
        await _flow.WriteToDriveAsync(Stick);
        Assert.Equal(FlowStep.Failed, _flow.Step);
        Assert.Equal(Strings.ErrorElevationDeclined, _flow.ErrorMessage);
    }

    [Fact]
    public async Task CancellingDuringTheBuildReturnsToDestination()
    {
        var started = new TaskCompletionSource();
        _runner.Replies["build"] = async (_, emit, ct) =>
        {
            emit(new ProgressEvent("download", 1, 10, "bytes", ""));
            started.SetResult();
            try
            {
                await Task.Delay(Timeout.Infinite, ct);
            }
            catch (OperationCanceledException)
            {
            }

            emit(new ErrorEvent("cancelled", "Cancelled."));
            return new HelperResult(HelperExitCodes.Cancelled);
        };
        await AtDestinationAsync();
        var job = _flow.WriteToDriveAsync(Stick);
        await started.Task;
        Assert.Equal(FlowStep.Progress, _flow.Step);
        Assert.Equal(Strings.PhaseDownloading, _flow.Progress.Label);

        _flow.Cancel();
        await job;

        Assert.Equal(FlowStep.Destination, _flow.Step);
        Assert.Null(_flow.ErrorMessage);
        Assert.DoesNotContain("write", _runner.Subcommands);
    }

    [Fact]
    public async Task CatalogFailureRetriesTheCatalog()
    {
        _runner.Replies["catalog"] = FakeRunner.Emit(1, new ErrorEvent("network", "Offline."));
        await _flow.LoadCatalogAsync();
        Assert.Equal(FlowStep.Failed, _flow.Step);
        Assert.Equal("Offline.", _flow.ErrorMessage);

        _runner.Replies["catalog"] = FakeRunner.Emit(0, new CatalogEvent(Fixtures.Catalog()));
        await _flow.TryAgainAsync();
        Assert.Equal(FlowStep.Choose, _flow.Step);
        Assert.NotNull(_flow.Catalog);
    }

    [Fact]
    public async Task CatalogWithNothingForThisComputerIsAnError()
    {
        _runner.Replies["catalog"] = FakeRunner.Emit(0, new CatalogEvent(new Catalog()));
        await _flow.LoadCatalogAsync();
        Assert.Equal(FlowStep.Failed, _flow.Step);
        Assert.Equal(Strings.ErrorNoTargets, _flow.ErrorMessage);
    }

    [Fact]
    public async Task MissingHelperSaysReinstall()
    {
        _runner.Replies["catalog"] = (_, _, _) => throw new Win32Exception(2, "The system cannot find the file specified.");
        await _flow.LoadCatalogAsync();
        Assert.Equal(FlowStep.Failed, _flow.Step);
        Assert.Equal(Strings.ErrorHelperMissing, _flow.ErrorMessage);
    }

    [Fact]
    public async Task StartOverGoesBackToChooseWithTheSelectionKept()
    {
        await AtDestinationAsync();
        await _flow.WriteToDriveAsync(Stick);
        _flow.StartOver();
        Assert.Equal(FlowStep.Choose, _flow.Step);
        Assert.Equal("yellowfin:gnome:linux/amd64", _flow.SelectedTarget!.Id);
        Assert.Null(_flow.TargetDrive);
    }

    [Fact]
    public async Task ActionsOutOfOrderAreIgnored()
    {
        await _flow.WriteToDriveAsync(Stick); // still on Choose
        await _flow.SaveIsoAsync("x.iso");
        await _flow.RefreshDrivesAsync();
        _flow.Back();
        Assert.Empty(_runner.Requests);
        Assert.Equal(FlowStep.Choose, _flow.Step);
    }

    [Fact]
    public async Task UnchangedDriveListDoesNotRaiseChanged()
    {
        await AtDestinationAsync();
        var raised = 0;
        _flow.Changed += (_, _) => raised++;
        await _flow.RefreshDrivesAsync();
        Assert.Equal(0, raised);

        _runner.Replies["drives"] = FakeRunner.Emit(0, new DrivesEvent([]));
        await _flow.RefreshDrivesAsync();
        Assert.Equal(1, raised);
        Assert.Empty(_flow.Drives);
    }
}
