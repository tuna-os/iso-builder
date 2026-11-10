using System.Diagnostics;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Navigation;
using TunaOS.MediaWriter.Core;
using Windows.ApplicationModel.DataTransfer;

namespace TunaOS.MediaWriter.App.Pages;

/// <summary>Step 4: success (USB stick or ISO file), or the error in plain words with Try again / Show details.</summary>
public sealed partial class DonePage : Page
{
    public DonePage()
    {
        InitializeComponent();
        DoneTitleText.Text = Strings.DoneTitle;
        DocsLink.Content = Strings.InstallDocs;
        DocsLink.NavigateUri = new Uri(Strings.DocsUrl);
        ErrorBar.Title = Strings.FailedTitle;
        CopyButton.Content = Strings.CopyDetails;
        ShowInFolderButton.Content = Strings.ShowInFolder;
    }

    /// <summary>The page on screen, for the UI smoke.</summary>
    internal static DonePage? Current { get; private set; }

    private static bool Failed => App.Flow.Step == FlowStep.Failed;

    protected override void OnNavigatedTo(NavigationEventArgs e)
    {
        Current = this;
        App.Flow.Changed += OnFlowChanged;
        Update();
    }

    protected override void OnNavigatedFrom(NavigationEventArgs e)
    {
        App.Flow.Changed -= OnFlowChanged;
        if (Current == this)
        {
            Current = null;
        }
    }

    private void OnFlowChanged(object? sender, EventArgs e) => Update();

    private void Update()
    {
        var flow = App.Flow;
        SuccessPanel.Visibility = Failed ? Visibility.Collapsed : Visibility.Visible;
        FailurePanel.Visibility = Failed ? Visibility.Visible : Visibility.Collapsed;
        DetailsButton.Visibility = Failed ? Visibility.Visible : Visibility.Collapsed;
        ShowInFolderButton.Visibility = !Failed && flow.Output == OutputKind.IsoFile ? Visibility.Visible : Visibility.Collapsed;

        if (Failed)
        {
            ErrorBar.Message = flow.ErrorMessage ?? Strings.ErrorGeneric;
            DetailsBox.Text = flow.Details;
            DetailsButton.Content = DetailsPanel.Visibility == Visibility.Visible ? Strings.HideDetails : Strings.ShowDetails;
            PrimaryButton.Content = Strings.TryAgain;
            SecondaryButton.Content = Strings.Close;
        }
        else
        {
            DoneText.Text = flow.Output == OutputKind.UsbDrive
                ? Strings.DoneDrive
                : $"{Strings.DoneFile}\n{Strings.SavedTo(flow.SavedIsoPath ?? "")}";
            PrimaryButton.Content = Strings.Close;
            SecondaryButton.Content = Strings.StartOver;
        }
    }

    /// <summary>Opens the details log (also used by the UI smoke).</summary>
    internal void ShowDetails(bool show)
    {
        DetailsPanel.Visibility = show ? Visibility.Visible : Visibility.Collapsed;
        Update();
    }

    private void OnToggleDetails(object sender, RoutedEventArgs e) =>
        ShowDetails(DetailsPanel.Visibility != Visibility.Visible);

    private void OnCopyDetails(object sender, RoutedEventArgs e)
    {
        var package = new DataPackage();
        package.SetText(App.Flow.Details);
        Clipboard.SetContent(package);
    }

    private void OnShowInFolder(object sender, RoutedEventArgs e)
    {
        if (App.Flow.SavedIsoPath is { } path)
        {
            Process.Start(new ProcessStartInfo("explorer.exe") { ArgumentList = { "/select,", path } });
        }
    }

    private async void OnPrimary(object sender, RoutedEventArgs e)
    {
        if (Failed)
        {
            await App.Flow.TryAgainAsync();
        }
        else
        {
            App.Shell.Close();
        }
    }

    private void OnSecondary(object sender, RoutedEventArgs e)
    {
        if (Failed)
        {
            App.Shell.Close();
        }
        else
        {
            App.Flow.StartOver();
        }
    }
}
