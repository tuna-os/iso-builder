using TunaOS.MediaWriter.App.Pages;
using TunaOS.MediaWriter.Core;

namespace TunaOS.MediaWriter.App.Smoke;

/// <summary>
/// <c>--smoke DIR</c>: walks the real UI through a scenario, saving a screenshot per
/// screen and a log to DIR, then exits 0 (pass) or 1 (fail). Everything runs on the UI
/// thread through the same page methods the buttons call.
/// </summary>
internal sealed class SmokeDriver(MainWindow window, MediaWriterFlow flow, AppOptions options)
{
    private static readonly TimeSpan Settle = TimeSpan.FromMilliseconds(900);

    private readonly string _dir = options.SmokeDirectory!;
    private DateTime _deadline;

    public async Task RunAsync()
    {
        Directory.CreateDirectory(_dir);
        _deadline = DateTime.UtcNow + options.SmokeTimeout;
        var exitCode = 1;
        try
        {
            Log($"scenario={options.SmokeScenario} fakeHelper={options.IsFakeHelper} elevate={options.Elevate} helper={options.Helper.FileName}");
            await (options.SmokeScenario switch
            {
                "write" => WriteAsync(),
                "error" => ErrorAsync(),
                "save" => SaveAsync(),
                "launch" => LaunchAsync(),
                _ => throw new ArgumentException($"unknown scenario {options.SmokeScenario}"),
            });
            exitCode = 0;
            Log("PASS");
        }
        catch (Exception ex)
        {
            Log($"FAIL: {ex.Message}\nstep={flow.Step} error={flow.ErrorMessage}\n--- details ---\n{flow.Details}");
            try
            {
                await CaptureAsync("zz-failure");
            }
            catch (Exception captureError)
            {
                Log($"failure screenshot failed: {captureError.Message}");
            }
        }

        Environment.Exit(exitCode);
    }

    /// <summary>Choose → Destination → erase dialog → Progress → Done, writing (fake) to the first stick.</summary>
    private async Task WriteAsync()
    {
        await CatalogLoadedAsync();
        await CaptureAsync("1-choose");

        flow.SelectDesktop("kde");
        await WaitForAsync(() => flow.DesktopId == "kde", "kde selected");
        flow.Continue();
        await WaitForAsync(() => flow.Step == FlowStep.Destination && flow.Drives.Count > 0 && DestinationPage.Current is not null, "drives listed");
        await CaptureAsync("2-destination");

        var page = DestinationPage.Current!;
        var job = page.ConfirmAndWriteAsync(flow.Drives[0], () => CaptureAsync("2b-erase-confirm"));

        await WaitForAsync(() => flow.Step == FlowStep.Progress && flow.Progress.Label == Strings.PhaseBuilding && flow.Progress.Fraction > 0.1, "building");
        await CaptureAsync("3-progress-building", settle: TimeSpan.FromMilliseconds(250));
        await WaitForAsync(() => flow.Step != FlowStep.Progress || flow.Progress.Label == Strings.PhaseWriting && flow.Progress.Fraction > 0.2, "writing");
        if (flow.Step == FlowStep.Progress)
        {
            await CaptureAsync("3-progress-writing", settle: TimeSpan.FromMilliseconds(250));
        }

        await job;
        Expect(flow.Step == FlowStep.Done, "write finished on the Done step");
        Expect(flow.Output == OutputKind.UsbDrive, "output was the USB stick");
        await CaptureAsync("4-done");
    }

    /// <summary>A failing build (FAKE_HELPER_FAIL=build): error screen, details, Try again.</summary>
    private async Task ErrorAsync()
    {
        await CatalogLoadedAsync();
        flow.Continue();
        await WaitForAsync(() => flow.Step == FlowStep.Destination && flow.Drives.Count > 0 && DestinationPage.Current is not null, "drives listed");
        await DestinationPage.Current!.ConfirmAndWriteAsync(flow.Drives[0], () => Task.CompletedTask);

        await WaitForAsync(() => flow.Step == FlowStep.Failed && DonePage.Current is not null, "error screen");
        Expect(!string.IsNullOrEmpty(flow.ErrorMessage), "an error message is shown");
        await CaptureAsync("4-error");
        DonePage.Current!.ShowDetails(true);
        await CaptureAsync("4-error-details");

        await flow.TryAgainAsync();
        await WaitForAsync(() => flow.Step == FlowStep.Destination, "back on destination after Try again");
    }

    /// <summary>"Save ISO file only", with the save picker replaced by a fixed path.</summary>
    private async Task SaveAsync()
    {
        await CatalogLoadedAsync();
        flow.Continue();
        await WaitForAsync(() => flow.Step == FlowStep.Destination, "destination");
        var iso = Path.Combine(_dir, "saved.iso");
        await flow.SaveIsoAsync(iso);
        Expect(flow.Step == FlowStep.Done && flow.Output == OutputKind.IsoFile, "save finished on the Done step");
        Expect(File.Exists(iso), "the ISO file exists");
        await CaptureAsync("4-done-file");
    }

    /// <summary>Real helper (installed MSI): catalog loads, drive list appears. Never writes.</summary>
    private async Task LaunchAsync()
    {
        await CatalogLoadedAsync();
        await CaptureAsync("launch-1-choose");
        flow.Continue();
        await WaitForAsync(() => flow.Step == FlowStep.Destination, "destination");
        await Task.Delay(TimeSpan.FromSeconds(5)); // let at least one real `drives` poll land
        Log($"drives: {flow.Drives.Count}");
        await CaptureAsync("launch-2-destination");
    }

    private async Task CatalogLoadedAsync()
    {
        await WaitForAsync(() => flow.Step == FlowStep.Failed || (flow.Catalog is not null && !flow.IsLoadingCatalog), "catalog");
        if (flow.Step == FlowStep.Failed)
        {
            throw new InvalidOperationException($"catalog failed: {flow.ErrorMessage}");
        }

        Log($"catalog: {flow.Catalog!.Desktops.Count} desktops on {flow.Catalog.Platform}; default {flow.SelectedTarget?.Id}");
    }

    private async Task CaptureAsync(string name, TimeSpan? settle = null)
    {
        await Task.Delay(settle ?? Settle);
        var path = Path.Combine(_dir, name + ".png");
        var method = await WindowCapture.SaveAsync(window.Hwnd, path);
        Log($"screenshot {name}.png via {method} (step {flow.StepNumber}: {flow.Step})");
    }

    private async Task WaitForAsync(Func<bool> condition, string what)
    {
        while (!condition())
        {
            if (DateTime.UtcNow > _deadline)
            {
                throw new TimeoutException($"timed out waiting for {what}");
            }

            await Task.Delay(50);
        }

        Log($"ok: {what}");
    }

    private void Expect(bool condition, string what)
    {
        if (!condition)
        {
            throw new InvalidOperationException($"expected: {what}");
        }

        Log($"ok: {what}");
    }

    private void Log(string line) =>
        File.AppendAllText(Path.Combine(_dir, "smoke.log"), $"{DateTime.UtcNow:HH:mm:ss.fff} {line}{Environment.NewLine}");
}
