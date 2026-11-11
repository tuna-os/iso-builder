using System.Runtime.InteropServices;
using Microsoft.UI.Composition.SystemBackdrops;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Media.Animation;
using TunaOS.MediaWriter.App.Pages;
using TunaOS.MediaWriter.Core;
using Windows.Graphics;

namespace TunaOS.MediaWriter.App;

/// <summary>One window; a Frame shows the page for the flow's current step.</summary>
public sealed partial class MainWindow : Window
{
    public MainWindow()
    {
        InitializeComponent();
        Title = Strings.AppName;
        Hwnd = WinRT.Interop.WindowNative.GetWindowHandle(this);

        if (MicaController.IsSupported())
        {
            SystemBackdrop = new MicaBackdrop();
        }
        else
        {
            // Windows 10 / Server: no Mica, use the opaque Fluent base colour.
            Root.Background = (Brush)Application.Current.Resources["SolidBackgroundFillColorBaseBrush"];
        }

        var scale = GetDpiForWindow(Hwnd) / 96.0;
        AppWindow.Resize(new SizeInt32((int)(860 * scale), (int)(660 * scale)));
        var icon = Path.Combine(AppContext.BaseDirectory, "Assets", "app.ico");
        if (File.Exists(icon))
        {
            AppWindow.SetIcon(icon);
        }

        App.Flow.Changed += (_, _) => ShowCurrentStep();
        Closed += (_, _) => App.Flow.Shutdown();
        ShowCurrentStep();
    }

    internal IntPtr Hwnd { get; }

    private void ShowCurrentStep()
    {
        var flow = App.Flow;
        StepText.Text = Strings.StepOf(flow.StepNumber);
        var page = flow.Step switch
        {
            FlowStep.Choose => typeof(ChoosePage),
            FlowStep.Destination => typeof(DestinationPage),
            FlowStep.Progress => typeof(ProgressPage),
            _ => typeof(DonePage),
        };

        if (ContentFrame.CurrentSourcePageType != page)
        {
            ContentFrame.Navigate(page, null, new DrillInNavigationTransitionInfo());
            ContentFrame.BackStack.Clear();
        }
    }

    [DllImport("user32.dll")]
    private static extern uint GetDpiForWindow(IntPtr hwnd);
}
