using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Navigation;
using TunaOS.MediaWriter.Core;
using TunaOS.MediaWriter.Core.Protocol;
using Windows.Storage.Pickers;

namespace TunaOS.MediaWriter.App.Pages;

/// <summary>Step 1: desktop cards, base dropdown, Continue; or a build-request.json from iso.tunaos.org.</summary>
public sealed partial class ChoosePage : Page
{
    private bool _updating;

    public ChoosePage()
    {
        InitializeComponent();
        TitleText.Text = Strings.ChooseTitle;
        SubtitleText.Text = Strings.ChooseSubtitle;
        LoadingText.Text = Strings.LoadingCatalog;
        BaseBox.Header = Strings.BaseLabel;
        ContinueButton.Content = Strings.Continue;
        OpenRequestButton.Content = Strings.OpenBuildRequest;
        ClearRequestButton.Content = Strings.ClearBuildRequest;
    }

    protected override void OnNavigatedTo(NavigationEventArgs e)
    {
        App.Flow.Changed += OnFlowChanged;
        Update();
    }

    protected override void OnNavigatedFrom(NavigationEventArgs e) => App.Flow.Changed -= OnFlowChanged;

    private void OnFlowChanged(object? sender, EventArgs e) => Update();

    private void Update()
    {
        var flow = App.Flow;
        var view = flow.Catalog;
        _updating = true;
        try
        {
            LoadingPanel.Visibility = flow.IsLoadingCatalog ? Visibility.Visible : Visibility.Collapsed;
            DesktopList.Visibility = view is null ? Visibility.Collapsed : Visibility.Visible;
            BaseBox.Visibility = view is null ? Visibility.Collapsed : Visibility.Visible;

            if (view is not null)
            {
                if (!ReferenceEquals(DesktopList.ItemsSource, view.Desktops))
                {
                    DesktopList.ItemsSource = view.Desktops;
                }

                DesktopList.SelectedItem = view.Desktops.FirstOrDefault(d => d.Id == flow.DesktopId);

                IReadOnlyList<CatalogBase> bases = flow.DesktopId is null ? [] : view.BasesFor(flow.DesktopId);
                if (BaseBox.ItemsSource is not IReadOnlyList<CatalogBase> shown || !shown.Select(b => b.Id).SequenceEqual(bases.Select(b => b.Id)))
                {
                    BaseBox.ItemsSource = bases;
                    shown = bases;
                }

                BaseBox.SelectedItem = shown.FirstOrDefault(b => b.Id == flow.BaseId);
            }

            var request = flow.BuildRequestPath;
            RequestInfo.IsOpen = request is not null;
            RequestInfo.Message = request is null ? "" : Strings.UsingBuildRequest(Path.GetFileName(request));
            DesktopList.IsEnabled = request is null;
            BaseBox.IsEnabled = request is null;
            ContinueButton.IsEnabled = flow.CanContinue && !flow.IsLoadingCatalog;
        }
        finally
        {
            _updating = false;
        }
    }

    private void OnDesktopSelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (!_updating && DesktopList.SelectedItem is CatalogDesktop desktop)
        {
            App.Flow.SelectDesktop(desktop.Id);
        }
    }

    private void OnBaseSelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (!_updating && BaseBox.SelectedItem is CatalogBase b)
        {
            App.Flow.SelectBase(b.Id);
        }
    }

    private void OnContinue(object sender, RoutedEventArgs e) => App.Flow.Continue();

    private void OnClearRequest(object sender, RoutedEventArgs e) => App.Flow.UseBuildRequest(null);

    private async void OnOpenRequest(object sender, RoutedEventArgs e)
    {
        var picker = new FileOpenPicker { SuggestedStartLocation = PickerLocationId.Downloads };
        picker.FileTypeFilter.Add(".json");
        WinRT.Interop.InitializeWithWindow.Initialize(picker, App.Shell.Hwnd);
        var file = await picker.PickSingleFileAsync();
        if (file is not null)
        {
            App.Flow.UseBuildRequest(file.Path);
        }
    }
}
