using Microsoft.UI.Dispatching;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Navigation;
using TunaOS.MediaWriter.Core;
using TunaOS.MediaWriter.Core.Protocol;
using Windows.Storage.Pickers;

namespace TunaOS.MediaWriter.App.Pages;

/// <summary>A drive row: name plus size (and drive letters, so people recognise their stick).</summary>
public sealed class DriveItem(Drive drive)
{
    public Drive Drive { get; } = drive;

    public string Name => Drive.Name.Length > 0 ? Drive.Name : Drive.Path;

    public string Detail
    {
        get
        {
            var parts = new List<string> { Format.Size(Drive.SizeBytes) };
            if (Drive.Mounted.Count > 0)
            {
                parts.Add(string.Join(", ", Drive.Mounted.Select(m => m.TrimEnd('\\'))));
            }

            return string.Join(" · ", parts);
        }
    }
}

/// <summary>Step 2: pick a USB stick (list refreshed every 2 s) or save the ISO file only.</summary>
public sealed partial class DestinationPage : Page
{
    private static readonly TimeSpan RefreshInterval = TimeSpan.FromSeconds(2);

    private DispatcherQueueTimer? _timer;
    private IReadOnlyList<Drive>? _shown;
    private bool _updating;

    public DestinationPage()
    {
        InitializeComponent();
        TitleText.Text = Strings.DestinationTitle;
        SubtitleText.Text = Strings.DestinationSubtitle;
        EmptyText.Text = Strings.NoDrives;
        BackButton.Content = Strings.Back;
        SaveButton.Content = Strings.SaveIsoOnly;
        WriteButton.Content = Strings.WriteToDrive;
    }

    /// <summary>The page on screen, for the UI smoke.</summary>
    internal static DestinationPage? Current { get; private set; }

    protected override void OnNavigatedTo(NavigationEventArgs e)
    {
        Current = this;
        App.Flow.Changed += OnFlowChanged;
        Update();

        // Polling covers plug, unplug and re-partition alike; the helper call is cheap and
        // RefreshDrivesAsync drops overlapping calls.
        _timer = DispatcherQueue.CreateTimer();
        _timer.Interval = RefreshInterval;
        _timer.Tick += (_, _) => _ = App.Flow.RefreshDrivesAsync();
        _timer.Start();
        _ = App.Flow.RefreshDrivesAsync();
    }

    protected override void OnNavigatedFrom(NavigationEventArgs e)
    {
        _timer?.Stop();
        App.Flow.Changed -= OnFlowChanged;
        if (Current == this)
        {
            Current = null;
        }
    }

    private void OnFlowChanged(object? sender, EventArgs e) => Update();

    private void Update()
    {
        var drives = App.Flow.Drives;
        if (!ReferenceEquals(drives, _shown))
        {
            _updating = true;
            try
            {
                var selectedId = (DriveList.SelectedItem as DriveItem)?.Drive.Id;
                var items = drives.Select(d => new DriveItem(d)).ToList();
                DriveList.ItemsSource = items;
                DriveList.SelectedItem = items.FirstOrDefault(i => i.Drive.Id == selectedId);
                _shown = drives;
            }
            finally
            {
                _updating = false;
            }
        }

        EmptyPanel.Visibility = drives.Count == 0 ? Visibility.Visible : Visibility.Collapsed;
        WriteButton.IsEnabled = DriveList.SelectedItem is DriveItem;
    }

    private void OnDriveSelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (!_updating)
        {
            WriteButton.IsEnabled = DriveList.SelectedItem is DriveItem;
        }
    }

    private void OnBack(object sender, RoutedEventArgs e) => App.Flow.Back();

    private async void OnWrite(object sender, RoutedEventArgs e)
    {
        if (DriveList.SelectedItem is DriveItem item)
        {
            await ConfirmAndWriteAsync(item.Drive, smokeOnOpened: null);
        }
    }

    /// <summary>
    /// Shows the erase confirmation and, if confirmed, starts the job. The UI smoke passes
    /// <paramref name="smokeOnOpened"/> to screenshot the open dialog and then confirm it.
    /// </summary>
    internal async Task ConfirmAndWriteAsync(Drive drive, Func<Task>? smokeOnOpened)
    {
        DriveList.SelectedItem = (DriveList.ItemsSource as IEnumerable<DriveItem>)?.FirstOrDefault(i => i.Drive.Id == drive.Id);
        var dialog = new ContentDialog
        {
            XamlRoot = XamlRoot,
            Style = (Style)Application.Current.Resources["DefaultContentDialogStyle"],
            Title = Strings.EraseTitle(new DriveItem(drive).Name, drive.SizeBytes),
            Content = Strings.EraseBody,
            PrimaryButtonText = Strings.EraseConfirm,
            PrimaryButtonStyle = (Style)Application.Current.Resources["DestructiveButtonStyle"],
            CloseButtonText = Strings.Cancel,
            DefaultButton = ContentDialogButton.Close,
        };

        var smokeConfirmed = false;
        if (smokeOnOpened is not null)
        {
            dialog.Opened += async (_, _) =>
            {
                await smokeOnOpened();
                smokeConfirmed = true;
                dialog.Hide();
            };
        }

        var result = await dialog.ShowAsync();
        if (result == ContentDialogResult.Primary || smokeConfirmed)
        {
            await App.Flow.WriteToDriveAsync(drive);
        }
    }

    private async void OnSaveIso(object sender, RoutedEventArgs e)
    {
        var picker = new FileSavePicker
        {
            SuggestedStartLocation = PickerLocationId.Downloads,
            SuggestedFileName = SafeFileName(Strings.SuggestedIsoName(App.Flow.SelectionLabel)),
            DefaultFileExtension = ".iso",
        };
        picker.FileTypeChoices.Add(Strings.IsoFileTypeName, [".iso"]);
        WinRT.Interop.InitializeWithWindow.Initialize(picker, App.Shell.Hwnd);
        var file = await picker.PickSaveFileAsync();
        if (file is not null)
        {
            await App.Flow.SaveIsoAsync(file.Path);
        }
    }

    private static string SafeFileName(string name)
    {
        var invalid = Path.GetInvalidFileNameChars();
        return new string(name.Select(c => invalid.Contains(c) ? ' ' : c).ToArray()).Trim();
    }
}
