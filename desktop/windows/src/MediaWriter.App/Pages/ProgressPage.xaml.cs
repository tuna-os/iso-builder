using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Navigation;
using TunaOS.MediaWriter.Core;

namespace TunaOS.MediaWriter.App.Pages;

/// <summary>Step 3: one bar, a plain phase label (Downloading / Building / Writing / Verifying), Cancel.</summary>
public sealed partial class ProgressPage : Page
{
    public ProgressPage()
    {
        InitializeComponent();
        CancelButton.Content = Strings.Cancel;
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
        var toDrive = flow.Output == OutputKind.UsbDrive;
        TitleText.Text = toDrive ? Strings.ProgressTitleDrive : Strings.ProgressTitleFile;
        WhatText.Text = toDrive && flow.TargetDrive is { } d
            ? $"{flow.SelectionLabel} → {d.Name} ({Format.Size(d.SizeBytes)})"
            : flow.SelectionLabel;

        var progress = flow.Progress;
        PhaseText.Text = progress.Label;
        if (progress.Fraction is { } fraction)
        {
            Bar.IsIndeterminate = false;
            Bar.Value = fraction * 100;
            PercentText.Text = Strings.Percent(fraction);
        }
        else
        {
            Bar.IsIndeterminate = true;
            PercentText.Text = "";
        }

        var writing = progress.Label is Strings.PhaseWriting or Strings.PhaseVerifying;
        HintText.Text = writing ? Strings.ProgressHintWrite : Strings.ProgressHint;
    }

    private void OnCancel(object sender, RoutedEventArgs e)
    {
        CancelButton.IsEnabled = false;
        App.Flow.Cancel();
    }
}
