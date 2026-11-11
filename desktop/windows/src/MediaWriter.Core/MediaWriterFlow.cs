using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using TunaOS.MediaWriter.Core.Helper;
using TunaOS.MediaWriter.Core.Protocol;

namespace TunaOS.MediaWriter.Core;

/// <summary>The four screens of the contract's GUI flow. <see cref="Failed"/> is step 4's error variant.</summary>
public enum FlowStep
{
    Choose,
    Destination,
    Progress,
    Done,
    Failed,
}

public enum OutputKind
{
    UsbDrive,
    IsoFile,
}

public sealed class FlowOptions
{
    /// <summary>Holds the ISO built for a USB write; also excluded from the drive list.</summary>
    public required string CacheDirectory { get; init; }

    public string Platform { get; init; } = CatalogView.HostPlatform(RuntimeInformation.OSArchitecture);

    /// <summary>Upper bound on the details log kept for "Show details".</summary>
    public int MaxDetailsChars { get; init; } = 256 * 1024;
}

/// <summary>
/// The Choose → Destination → Progress → Done state machine, independent of any UI
/// toolkit. Helper callbacks are marshalled through <c>uiContext</c>, so <see cref="Changed"/>
/// always fires on the UI thread; with a null context (unit tests) they run inline.
/// </summary>
public sealed class MediaWriterFlow
{
    private const int ErrorFileNotFound = 2;

    private readonly IHelperRunner _runner;
    private readonly FlowOptions _options;
    private readonly SynchronizationContext? _sync;
    private readonly StringBuilder _details = new();
    private readonly object _detailsLock = new();
    private CancellationTokenSource? _job;
    private bool _drivesBusy;
    private bool _catalogFailed;
    private string? _cachedIso;
    private string? _cachedFor;

    public MediaWriterFlow(IHelperRunner runner, FlowOptions options, SynchronizationContext? uiContext)
    {
        _runner = runner;
        _options = options;
        _sync = uiContext;
    }

    /// <summary>Raised after any state change, on the UI thread.</summary>
    public event EventHandler? Changed;

    public FlowStep Step { get; private set; } = FlowStep.Choose;

    /// <summary>1-based step number for the "Step N of 4" header.</summary>
    public int StepNumber => Step switch
    {
        FlowStep.Choose => 1,
        FlowStep.Destination => 2,
        FlowStep.Progress => 3,
        _ => 4,
    };

    public bool IsLoadingCatalog { get; private set; }

    public CatalogView? Catalog { get; private set; }

    public string? DesktopId { get; private set; }

    public string? BaseId { get; private set; }

    /// <summary>A build-request.json exported from iso.tunaos.org; overrides the desktop/base choice.</summary>
    public string? BuildRequestPath { get; private set; }

    public CatalogTarget? SelectedTarget => Catalog?.Resolve(DesktopId, BaseId);

    public bool CanContinue => BuildRequestPath is not null || SelectedTarget is not null;

    /// <summary>Human label for what is being made, e.g. "GNOME (AlmaLinux Kitten 10 (flagship))".</summary>
    public string SelectionLabel =>
        BuildRequestPath is not null ? Path.GetFileNameWithoutExtension(BuildRequestPath)
        : SelectedTarget is { } t && Catalog is not null ? Catalog.LabelFor(t)
        : "";

    public IReadOnlyList<Drive> Drives { get; private set; } = [];

    public OutputKind Output { get; private set; }

    public Drive? TargetDrive { get; private set; }

    /// <summary>Where "Save ISO file only" put the file.</summary>
    public string? SavedIsoPath { get; private set; }

    public ProgressDisplay Progress { get; private set; } = new(Strings.PhasePreparing, null);

    public string? ErrorMessage { get; private set; }

    public string Details
    {
        get
        {
            lock (_detailsLock)
            {
                return _details.ToString();
            }
        }
    }

    public string CachedIsoPath => Path.Combine(_options.CacheDirectory, "tunaos-media-writer.iso");

    public async Task LoadCatalogAsync()
    {
        Step = FlowStep.Choose;
        IsLoadingCatalog = true;
        ErrorMessage = null;
        _catalogFailed = false;
        Raise();

        Catalog? catalog = null;
        var outcome = await RunHelperAsync(
            new HelperRequest(["catalog"]),
            ev =>
            {
                if (ev is CatalogEvent c)
                {
                    catalog = c.Catalog;
                }
            },
            CancellationToken.None);
        IsLoadingCatalog = false;

        if (catalog is null)
        {
            _catalogFailed = true;
            Fail(outcome.Exception is null && outcome.Error is null ? Strings.ErrorNoCatalog : MessageFor(outcome));
            return;
        }

        var view = new CatalogView(catalog, _options.Platform);
        if (view.Desktops.Count == 0)
        {
            _catalogFailed = true;
            Fail(Strings.ErrorNoTargets);
            return;
        }

        Catalog = view;
        DesktopId = view.DefaultDesktop;
        BaseId = DesktopId is null ? null : view.DefaultBaseFor(DesktopId);
        Raise();
    }

    public void SelectDesktop(string desktopId)
    {
        if (Catalog is null || Step != FlowStep.Choose)
        {
            return;
        }

        DesktopId = desktopId;
        if (!Catalog.BasesFor(desktopId).Any(b => b.Id == BaseId))
        {
            BaseId = Catalog.DefaultBaseFor(desktopId);
        }

        Raise();
    }

    public void SelectBase(string baseId)
    {
        if (Step != FlowStep.Choose)
        {
            return;
        }

        BaseId = baseId;
        Raise();
    }

    public void UseBuildRequest(string? path)
    {
        BuildRequestPath = path;
        Raise();
    }

    public void Continue()
    {
        if (Step != FlowStep.Choose || !CanContinue)
        {
            return;
        }

        Step = FlowStep.Destination;
        Raise();
    }

    public void Back()
    {
        if (Step != FlowStep.Destination)
        {
            return;
        }

        Step = FlowStep.Choose;
        Raise();
    }

    /// <summary>Re-lists drives. Call on hotplug or every couple of seconds while on step 2; overlapping calls are dropped.</summary>
    public async Task RefreshDrivesAsync()
    {
        if (Step != FlowStep.Destination || _drivesBusy)
        {
            return;
        }

        _drivesBusy = true;
        try
        {
            IReadOnlyList<Drive>? found = null;
            await RunHelperAsync(
                new HelperRequest(["drives", "--exclude", _options.CacheDirectory]),
                ev =>
                {
                    if (ev is DrivesEvent d)
                    {
                        found = d.Drives;
                    }
                },
                CancellationToken.None,
                quiet: true);

            if (found is not null && Step == FlowStep.Destination && !SameDrives(found, Drives))
            {
                Drives = found;
                Raise();
            }
        }
        finally
        {
            _drivesBusy = false;
        }
    }

    /// <summary>Builds the ISO (or reuses the one from a failed earlier write) and writes it to <paramref name="drive"/>. The caller has already confirmed the erase.</summary>
    public async Task WriteToDriveAsync(Drive drive)
    {
        if (Step != FlowStep.Destination)
        {
            return;
        }

        var ct = BeginJob(OutputKind.UsbDrive);
        TargetDrive = drive;
        Raise();

        var key = BuildKey();
        string? iso = _cachedFor == key && File.Exists(_cachedIso) ? _cachedIso : null;
        if (iso is null)
        {
            DeleteCachedIso();
            Directory.CreateDirectory(_options.CacheDirectory);
            iso = await BuildAsync(CachedIsoPath, ct);
            if (iso is null)
            {
                return;
            }

            _cachedIso = iso;
            _cachedFor = key;
        }

        SetProgress(new(Strings.PhaseWriting, null));
        WriteDoneEvent? done = null;
        var outcome = await RunHelperAsync(
            new HelperRequest(["write", "--iso", iso, "--device", drive.Id]) { Elevated = true, Cancellable = true },
            ev =>
            {
                switch (ev)
                {
                    case ProgressEvent p:
                        SetProgress(ProgressModel.For(p.Phase, p.Current, p.Total));
                        break;
                    case WriteDoneEvent w:
                        done = w;
                        break;
                }
            },
            ct);

        if (EndedBadly(outcome, ct, done is not null))
        {
            return;
        }

        DeleteCachedIso();
        Finish();
    }

    /// <summary>"Save ISO file only": builds straight to <paramref name="path"/>.</summary>
    public async Task SaveIsoAsync(string path)
    {
        if (Step != FlowStep.Destination)
        {
            return;
        }

        var ct = BeginJob(OutputKind.IsoFile);
        Raise();
        var saved = await BuildAsync(path, ct);
        if (saved is null)
        {
            return;
        }

        SavedIsoPath = saved;
        Finish();
    }

    /// <summary>Asks the running helper to stop. The flow returns to step 2 once it has.</summary>
    public void Cancel() => _job?.Cancel();

    public async Task TryAgainAsync()
    {
        if (Step != FlowStep.Failed)
        {
            return;
        }

        ErrorMessage = null;
        if (_catalogFailed || Catalog is null)
        {
            await LoadCatalogAsync();
            return;
        }

        // The drive may have changed in the meantime: let the user pick again.
        Step = FlowStep.Destination;
        Raise();
    }

    public void StartOver()
    {
        if (Step is not (FlowStep.Done or FlowStep.Failed))
        {
            return;
        }

        if (Catalog is null)
        {
            _ = TryAgainAsync();
            return;
        }

        ErrorMessage = null;
        TargetDrive = null;
        SavedIsoPath = null;
        Step = FlowStep.Choose;
        Raise();
    }

    /// <summary>Window closing: stop the helper and drop the multi-GB cached ISO.</summary>
    public void Shutdown()
    {
        _job?.Cancel();
        DeleteCachedIso();
    }

    private async Task<string?> BuildAsync(string outPath, CancellationToken ct)
    {
        List<string> args = ["build"];
        if (BuildRequestPath is not null)
        {
            args.AddRange(["--request", BuildRequestPath]);
        }
        else
        {
            args.AddRange(["--target", SelectedTarget!.Id]);
        }

        args.AddRange(["--out", outPath]);

        BuildDoneEvent? done = null;
        var outcome = await RunHelperAsync(
            new HelperRequest(args) { Cancellable = true },
            ev =>
            {
                switch (ev)
                {
                    case ProgressEvent p:
                        SetProgress(ProgressModel.For(p.Phase, p.Current, p.Total));
                        break;
                    case BuildDoneEvent d:
                        done = d;
                        break;
                }
            },
            ct);

        if (EndedBadly(outcome, ct, done is not null))
        {
            return null;
        }

        return string.IsNullOrEmpty(done!.Path) ? outPath : done.Path;
    }

    private CancellationToken BeginJob(OutputKind output)
    {
        _job?.Dispose();
        _job = new CancellationTokenSource();
        Output = output;
        ErrorMessage = null;
        TargetDrive = null;
        SavedIsoPath = null;
        Progress = new(Strings.PhasePreparing, null);
        Step = FlowStep.Progress;
        return _job.Token;
    }

    /// <summary>Handles cancel / failure; returns true when the job must stop here.</summary>
    private bool EndedBadly(HelperOutcome outcome, CancellationToken ct, bool sawDone)
    {
        if (outcome.Result is { ElevationDeclined: true })
        {
            Fail(Strings.ErrorElevationDeclined);
            return true;
        }

        if (ct.IsCancellationRequested || outcome.Result?.ExitCode == HelperExitCodes.Cancelled)
        {
            AppendDetail("Cancelled.");
            Step = FlowStep.Destination;
            Raise();
            return true;
        }

        if (outcome.Exception is not null || outcome.Result?.ExitCode != HelperExitCodes.Success || !sawDone)
        {
            Fail(MessageFor(outcome));
            return true;
        }

        return false;
    }

    private static string MessageFor(HelperOutcome outcome)
    {
        if (outcome.Exception is Win32Exception { NativeErrorCode: ErrorFileNotFound } or FileNotFoundException)
        {
            return Strings.ErrorHelperMissing;
        }

        if (outcome.Error is { } e)
        {
            return e.Message.Length > 0 ? e.Message : Strings.ForErrorKind(e.Kind);
        }

        return Strings.ErrorGeneric;
    }

    private void Fail(string message)
    {
        ErrorMessage = message;
        Step = FlowStep.Failed;
        Raise();
    }

    private void Finish()
    {
        Step = FlowStep.Done;
        Raise();
    }

    private void SetProgress(ProgressDisplay progress)
    {
        if (Step != FlowStep.Progress)
        {
            return;
        }

        Progress = progress;
        Raise();
    }

    private string BuildKey() => BuildRequestPath is not null ? "request:" + BuildRequestPath : "target:" + SelectedTarget?.Id;

    private void DeleteCachedIso()
    {
        var path = _cachedIso ?? CachedIsoPath;
        _cachedIso = null;
        _cachedFor = null;
        try
        {
            File.Delete(path);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
        }
    }

    private async Task<HelperOutcome> RunHelperAsync(
        HelperRequest request, Action<HelperEvent> onEvent, CancellationToken ct, bool quiet = false)
    {
        ErrorEvent? error = null;
        var logged = !quiet;
        if (!quiet)
        {
            AppendDetail("> " + string.Join(' ', request.Args));
        }

        void OnEvent(HelperEvent ev)
        {
            switch (ev)
            {
                case ErrorEvent e:
                    error = e;
                    AppendDetail($"error ({e.Kind}): {e.Message}");
                    break;
                case LogEvent l:
                    if (!quiet)
                    {
                        AppendDetail($"{l.Level}: {l.Message}");
                    }

                    break;
                case MalformedLine m:
                    AppendDetail($"unreadable helper output: {m.Raw}");
                    break;
            }

            onEvent(ev);
        }

        try
        {
            var result = await _runner.RunAsync(
                request,
                ev => Post(() => OnEvent(ev)),
                line =>
                {
                    if (!quiet)
                    {
                        AppendDetail(line);
                    }
                },
                ct);

            if (result.ExitCode != HelperExitCodes.Success && !logged)
            {
                AppendDetail($"> {string.Join(' ', request.Args)} exited with {result.ExitCode}");
            }

            return new HelperOutcome(result, error, null);
        }
        catch (Exception ex) when (ex is Win32Exception or IOException or InvalidOperationException or UnauthorizedAccessException)
        {
            AppendDetail($"could not run the helper: {ex.Message}");
            return new HelperOutcome(null, error, ex);
        }
    }

    private void AppendDetail(string line)
    {
        lock (_detailsLock)
        {
            _details.AppendLine(line);
            if (_details.Length > _options.MaxDetailsChars)
            {
                _details.Remove(0, _details.Length - _options.MaxDetailsChars);
            }
        }
    }

    private void Post(Action action)
    {
        if (_sync is null)
        {
            action();
        }
        else
        {
            _sync.Post(_ => action(), null);
        }
    }

    private void Raise() => Changed?.Invoke(this, EventArgs.Empty);

    private static bool SameDrives(IReadOnlyList<Drive> a, IReadOnlyList<Drive> b) =>
        a.Count == b.Count && a.Zip(b).All(p => p.First.Id == p.Second.Id && p.First.SizeBytes == p.Second.SizeBytes && p.First.Name == p.Second.Name);

    private sealed record HelperOutcome(HelperResult? Result, ErrorEvent? Error, Exception? Exception);
}
