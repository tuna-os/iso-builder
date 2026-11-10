using Microsoft.UI.Xaml;
using TunaOS.MediaWriter.App.Smoke;
using TunaOS.MediaWriter.Core;
using TunaOS.MediaWriter.Core.Helper;

namespace TunaOS.MediaWriter.App;

public partial class App : Application
{
    public App()
    {
        InitializeComponent();
        UnhandledException += OnUnhandledException;
    }

    internal static AppOptions Options { get; private set; } = null!;

    internal static MediaWriterFlow Flow { get; private set; } = null!;

    internal static MainWindow Shell { get; private set; } = null!;

    protected override void OnLaunched(LaunchActivatedEventArgs args)
    {
        Options = AppOptions.Parse(Environment.GetCommandLineArgs().Skip(1).ToList(), out var error);
        if (error is not null)
        {
            Console.Error.WriteLine(error);
            Environment.Exit(2);
        }

        var runner = new ProcessHelperRunner(Options.Helper, new ProcessHelperRunnerOptions { UseRunAs = Options.Elevate });
        Flow = new MediaWriterFlow(runner, new FlowOptions { CacheDirectory = Options.CacheDirectory }, SynchronizationContext.Current);

        Shell = new MainWindow();
        Shell.Activate();
        _ = Flow.LoadCatalogAsync();

        if (Options.SmokeDirectory is not null)
        {
            _ = new SmokeDriver(Shell, Flow, Options).RunAsync();
        }
    }

    private static void OnUnhandledException(object sender, Microsoft.UI.Xaml.UnhandledExceptionEventArgs e)
    {
        try
        {
            Directory.CreateDirectory(AppOptions.DataDirectory);
            File.AppendAllText(
                Path.Combine(AppOptions.DataDirectory, "crash.log"),
                $"{DateTimeOffset.Now:O} {e.Exception}{Environment.NewLine}");
            if (Options?.SmokeDirectory is { } dir)
            {
                File.AppendAllText(Path.Combine(dir, "smoke.log"), $"UNHANDLED: {e.Exception}{Environment.NewLine}");
                Environment.Exit(3);
            }
        }
        catch (IOException)
        {
        }
    }
}
